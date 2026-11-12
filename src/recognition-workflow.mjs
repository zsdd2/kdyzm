import { setImmediate as yieldTurn } from 'node:timers/promises';
import { hash, fail, onlyKeys } from './security.mjs';
import { logisticsEventTimeIssue, pickupArrivalEvent } from './collector-enrichment.mjs';
import { logisticsActionIn, logisticsPublicText, specificLogisticsStation } from './logistics-ai-template.mjs';
import { orderRetention } from './order-retention.mjs';

const MINUTE = 60000, DAY = 86400000, OFFSET = 8 * 3600000;
const TERMINAL = new Set(['resolved', 'ignored']);
const ACTIVE_LIMIT = 2000, HISTORY_LIMIT = 500, SCAN_LIMIT = 10000;
const parse = row => row && JSON.parse(row.data);
const dayKey = now => new Date(now + OFFSET - 3 * 3600000).toISOString().slice(0, 10);
const dailyAt = day => Date.parse(`${day}T03:00:00+08:00`);
const validTime = (time, now) => Number.isSafeInteger(time) && time > 0 && time <= now;
const idText = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

function missedArrival(event, now) {
  if (!validTime(event.time, now) || logisticsEventTimeIssue(event, now) === 'timeConflict' || typeof event.description !== 'string') return false;
  for (const part of event.description.split(/[，,。；;！？!?\n\r]/u)) {
    const action = logisticsActionIn.exec(part);
    if (!action) continue;
    const station = part.slice(action.index + action[0].length).split(/请|等待|待取件|取件码|取货码|电话/u)[0].trim();
    const fragment = part.slice(action.index, action.index + action[0].length + station.length);
    if (!specificLogisticsStation(station) || !logisticsPublicText(fragment, 200)) continue;
    try {
      const preview = globalThis.PickCodeLogistics.test({ id: 'recognition-probe', name: '本地证据', enabled: true, kind: 'arrival', starts: [action[0]],
        end: '', keywords: [station], sample: fragment, expectedStation: station, origin: 'manual' }, event.description);
      if (preview.arrival && preview.station === station) return true;
    } catch { /* Only a locally validated arrival fragment can open this problem. */ }
  }
  return false;
}

export function recognitionMethod(platform, target) {
  const source = ['taobao', 'pdd', 'jd'].includes(platform) ? platform : 'other';
  return { platform: source, contentKind: target === 'station_match' ? 'pickup_match' : 'logistics', target,
    methodId: `${source}.${target === 'arrival_time' ? 'arrival_evidence' : target === 'event_time' ? 'event_timestamp' : target === 'station_match' ? 'station_identity' : 'order_detail'}`,
    methodVersion: 1 };
}

export function recognitionProblems(shipment, now, rules) {
  const events = Array.isArray(shipment.logisticsEvents) ? shipment.logisticsEvents : [];
  const problems = [];
  if (['error', 'empty', 'unavailable'].includes(shipment.logisticsState)) problems.push({ target: 'logistics_detail', reasonCode: 'DETAIL_UNAVAILABLE' });
  const timeIssues = events.map(event => logisticsEventTimeIssue(event, now));
  if (timeIssues.some(Boolean)) problems.push({ target: 'event_time', reasonCode: timeIssues.includes('timeConflict') ? 'TIME_CONFLICT' : 'TIME_UNKNOWN' });
  const arrived = shipment.status === 'arrived' || events.some(event => pickupArrivalEvent(event.description, '', rules) || missedArrival(event, now));
  if (arrived && (!validTime(shipment.arrivalAt, now) || !['platform_event', 'locker_arrival'].includes(shipment.arrivalAtSource)
    || !['second', 'minute'].includes(shipment.arrivalAtPrecision))) problems.push({ target: 'arrival_time', reasonCode: 'ARRIVAL_UNCONFIRMED' });
  return problems;
}

export class RecognitionWorkflow {
  constructor({ store, requestOrder, analyze, refreshAnalysis, evaluateReport, authorizeReport = () => true, now = Date.now, automaticEvents = true }) {
    Object.assign(this, { store, db: store.db, requestOrder, analyze, refreshAnalysis, evaluateReport, authorizeReport, now, automaticEvents });
    this.closed = false; this.running = null; this.dailyRunning = null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS recognition_tasks(id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recognition_tasks_shipment ON recognition_tasks(json_extract(data,'$.shipmentId'));
      CREATE INDEX IF NOT EXISTS recognition_tasks_status ON recognition_tasks(json_extract(data,'$.status'));
      CREATE TABLE IF NOT EXISTS recognition_attempts(task_id TEXT NOT NULL,job_id TEXT NOT NULL,PRIMARY KEY(task_id,job_id));
      CREATE TABLE IF NOT EXISTS recognition_daily_runs(day TEXT PRIMARY KEY,data TEXT NOT NULL);`);
    this.scrubReportSources();
    this.schedule();
  }
  tasks() { return this.db.prepare('SELECT data FROM recognition_tasks ORDER BY rowid').all().map(parse); }
  task(id) { return parse(this.db.prepare('SELECT data FROM recognition_tasks WHERE id=?').get(id)); }
  save(task) {
    task = { ...task, updatedAt: this.now() };
    this.db.prepare('INSERT INTO recognition_tasks VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(task.id, JSON.stringify(task));
    this.gateIndex = null;
    return task;
  }
  scope(shipmentId) {
    const shipment = this.store.shipment(shipmentId), order = shipment && this.store.order(shipment.orderId), account = shipment && this.store.account(shipment.accountId);
    if (!shipment || this.store.shipmentAlias(shipment.id).id !== shipment.id || !order || !account || order.accountId !== shipment.accountId || shipment.picked || shipment.pickupCompletion?.autoPicked
      || shipment.hidden || shipment.deleted || shipment.archived || ['returned', 'returning'].includes(shipment.status)
      || order.hidden || order.deleted || orderRetention(order, this.now()).archived) return { closed: true, reasonCode: 'SOURCE_INACTIVE' };
    if (!account.enabled || account.status === 'expired') return { shipment, order, account, blocked: true, reasonCode: account.enabled ? 'ACCOUNT_EXPIRED' : 'ACCOUNT_DISABLED' };
    return { shipment, order, account };
  }
  fingerprint(shipment, target) {
    const events = (shipment.logisticsEvents || []).filter(event => target !== 'event_time' || logisticsEventTimeIssue(event, this.now()))
      .map(event => [event.time, event.timeText, event.timePrecision, event.description, event.location,
      event.provider, event.providerStatus, event.providerStatusTag, event.providerSubStatus, event.providerStatusText]);
    if (target === 'event_time') return hash(JSON.stringify([[...new Set(events.map(event => JSON.stringify(event)))].sort(), shipment.pickupCycle?.id]));
    return hash(JSON.stringify([events, shipment.status, shipment.logisticsState, shipment.arrivalAt, shipment.arrivalAtSource, shipment.arrivalAtPrecision, shipment.station, shipment.pickupCycle?.id]));
  }
  reportFingerprint(source, shipments) {
    const evidence = shipments.map(shipment => [shipment.id, this.fingerprint(shipment), shipment.carrier, shipment.pickupCode, shipment.waybillNo])
      .sort(([one], [two]) => one.localeCompare(two));
    return hash(JSON.stringify([source, evidence]));
  }
  scrubReportSources() {
    for (const task of this.tasks()) {
      if (!task.source || !task.source.waybillNo && !task.source.pickupCode) continue;
      const shipments = (task.candidateShipmentIds || []).map(id => this.store.shipment(id));
      const unchanged = shipments.length && shipments.every(Boolean) && this.reportFingerprint(task.source, shipments) === task.sourceFingerprint;
      task.source.waybillNo = ''; task.source.pickupCode = '';
      // The original hash is also the identity used by historical AI reviews and in-flight work.
      if (unchanged) task.privacyFingerprint = this.reportFingerprint(task.source, shipments);
      this.db.prepare('UPDATE recognition_tasks SET data=? WHERE id=?').run(JSON.stringify(task), task.id);
    }
  }
  taskScope(task) {
    if (task.contentKind === 'pickup_match') {
      let authorized = false;
      try { authorized = this.authorizeReport(task) === true; } catch { /* An unavailable grant cannot authorize new work. */ }
      if (!authorized) return { closed: true, reasonCode: 'AUTHORIZATION_CHANGED' };
    }
    const scopes = (task.candidateShipmentIds || [task.shipmentId]).map(id => this.scope(id));
    const current = scopes.filter(scope => !scope.closed);
    if (!current.length) return { closed: true, reasonCode: 'SOURCE_INACTIVE' };
    const active = current.filter(scope => !scope.blocked);
    return active.length ? { ...active[0], sources: active, partlyBlocked: active.length !== current.length } : current[0];
  }
  reevaluate(task) {
    if (TERMINAL.has(task.status)) return task;
    const scope = this.taskScope(task);
    if (scope.closed) return this.save({ ...task, status: 'ignored', reasonCode: scope.reasonCode, nextRetryAt: 0 });
    if (scope.blocked || scope.partlyBlocked) return this.save({ ...task, status: 'blocked', resumeStatus: task.status === 'blocked' ? task.resumeStatus : task.status,
      reasonCode: scope.partlyBlocked ? 'ACCOUNT_UNAVAILABLE' : scope.reasonCode, nextRetryAt: this.now() + 5 * MINUTE });
    const result = task.contentKind === 'pickup_match' ? this.evaluateReport?.(task) : {
      resolved: !recognitionProblems(scope.shipment, this.now(), this.store.getLogisticsRules?.()).some(problem => problem.target === task.target),
    };
    if (result?.closed || result?.resolved) return this.save({ ...task, status: result.closed ? 'ignored' : 'resolved', reasonCode: result.closed ? 'SOURCE_INACTIVE' : 'DETERMINISTIC_MATCH', nextRetryAt: 0 });
    if (task.status === 'blocked') return this.save({ ...task, status: task.resumeStatus || (task.retryCount >= 3 ? 'ai_pending' : 'pending'), nextRetryAt: this.now(), reasonCode: task.problemCode });
    if (task.status === 'ai_running') {
      const analysis = this.refreshAnalysis?.(task);
      if (analysis?.status === 'review') return this.save({ ...task, status: 'review', nextRetryAt: 0,
        reasonCode: /^[A-Z_]{1,80}$/.test(analysis.reasonCode || '') ? analysis.reasonCode : 'AI_REQUIRES_EVIDENCE',
        candidateIds: Array.isArray(analysis.candidateIds) ? analysis.candidateIds.filter(idText).slice(0, 20) : task.candidateIds });
    }
    return task;
  }
  upsert(scope, problem, extras = {}) {
    const { shipment, account } = scope;
    const id = `recognition-${hash(JSON.stringify([shipment.id, problem.target, extras.deviceId || '', extras.sourceId || ''])).slice(0, 32)}`;
    const previous = this.task(id);
    const timeEvidenceFingerprint = problem.target === 'event_time' ? this.fingerprint(shipment, 'event_time') : '';
    // Keep the existing AI review identity when only unrelated, valid logistics changed.
    const fingerprint = extras.sourceFingerprint || (timeEvidenceFingerprint && previous?.timeEvidenceFingerprint === timeEvidenceFingerprint
      ? previous.sourceFingerprint : this.fingerprint(shipment));
    const evidence = timeEvidenceFingerprint ? { timeEvidenceFingerprint } : {};
    if (previous) {
      if (TERMINAL.has(previous.status) && previous.sourceFingerprint === fingerprint) return previous;
      const restart = previous.sourceFingerprint !== fingerprint && ['review', 'ai_pending', 'ai_running'].includes(previous.status);
      if (!TERMINAL.has(previous.status) && !restart) return this.reevaluate(this.save({ ...previous, ...evidence, sourceFingerprint: fingerprint, problemCode: problem.reasonCode }));
    }
    if (!previous && this.db.prepare("SELECT COUNT(*) AS count FROM recognition_tasks WHERE json_extract(data,'$.status') NOT IN ('resolved','ignored')").get().count >= ACTIVE_LIMIT) return null;
    return this.store.transaction(() => {
      this.db.prepare('DELETE FROM recognition_attempts WHERE task_id=?').run(id);
      return this.save({ id, ...recognitionMethod(account.platform, problem.target), accountId: account.id, orderId: shipment.orderId, shipmentId: shipment.id,
        sourceFingerprint: fingerprint, ...evidence, evidenceVersion: (previous?.evidenceVersion || 0) + 1, initialFailures: 1, retryCount: 0, aiAttempts: 0, status: scope.blocked ? 'blocked' : 'pending',
        reasonCode: scope.blocked ? scope.reasonCode : problem.reasonCode, problemCode: problem.reasonCode, nextRetryAt: this.now() + 5 * MINUTE,
        createdAt: this.now(), lastJobId: '', lastJobIds: [], pendingJobs: [], candidateIds: [], ...extras });
    });
  }
  observe({ shipments = [] } = {}) {
    if (this.closed) return { observed: 0 };
    let observed = 0;
    for (const input of shipments) {
      const scope = this.scope(input.id);
      for (const task of this.db.prepare("SELECT data FROM recognition_tasks WHERE json_extract(data,'$.shipmentId')=? AND json_extract(data,'$.status') NOT IN ('resolved','ignored')").all(input.id).map(parse)) this.reevaluate(task);
      if (scope.closed) continue;
      for (const problem of recognitionProblems(scope.shipment, this.now(), this.store.getLogisticsRules?.())) if (this.upsert(scope, problem)) observed++;
    }
    this.schedule(); return { observed };
  }
  submit(report, { deviceId } = {}) {
    onlyKeys(report, ['id', 'revision', 'kind', 'state', 'sourceId', 'observedAt', 'source', 'candidateShipmentIds', 'reasonCodes']);
    if (!idText(deviceId) || !idText(report.id) || !idText(report.sourceId) || !Number.isSafeInteger(report.revision) || report.revision < 1
      || report.kind !== 'unmatched_pickup' || !['resolved', 'unresolved', 'withdrawn'].includes(report.state)
      || !validTime(report.observedAt, this.now() + 5 * MINUTE) || !Array.isArray(report.reasonCodes) || report.reasonCodes.length > 20
      || report.reasonCodes.some(code => typeof code !== 'string' || !/^[a-z_]{1,80}$/.test(code))) fail(400, 'INVALID_RECOGNITION_REPORT', '识别问题格式无效');
    const id = `recognition-${hash(JSON.stringify([deviceId, report.id])).slice(0, 32)}`, previous = this.task(id);
    if (previous && previous.sourceId !== report.sourceId) fail(409, 'RECOGNITION_REPORT_CONFLICT', '问题来源与已保存记录不一致');
    if (previous && report.revision <= previous.reportRevision) return previous;
    if (report.state === 'resolved' || report.state === 'withdrawn') {
      if (!previous && report.state === 'resolved') fail(409, 'RECOGNITION_REPORT_UNKNOWN', '未找到该设备的问题记录');
      const base = previous || { id, ...recognitionMethod('other', 'station_match'), deviceId, clientId: report.id, sourceId: report.sourceId,
        accountId: '', accountIds: [], orderId: '', shipmentId: '', candidateShipmentIds: [], sourceFingerprint: '', evidenceVersion: 0,
        initialFailures: 0, retryCount: 0, aiAttempts: 0, createdAt: this.now(), lastJobId: '', lastJobIds: [], pendingJobs: [], candidateIds: [],
        problemCode: 'UNMATCHED_PICKUP' };
      return this.save({ ...base, reportRevision: report.revision, reportState: report.state, observedAt: report.observedAt, reasonCodes: [...report.reasonCodes],
        status: report.state === 'withdrawn' ? 'ignored' : 'resolved', nextRetryAt: 0,
        reasonCode: report.state === 'withdrawn' ? 'SOURCE_WITHDRAWN' : 'CLIENT_MATCH_CONFIRMED' });
    }
    const ids = report.candidateShipmentIds;
    if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => !idText(id)) || new Set(ids).size !== ids.length)
      fail(400, 'INVALID_RECOGNITION_REPORT', '候选包裹格式无效');
    const scopes = ids.map(id => this.scope(id));
    if (scopes.some(scope => scope.closed)) fail(409, 'RECOGNITION_SOURCE_INACTIVE', '包裹已不在当前未收范围');
    onlyKeys(report.source, ['station', 'carrier', 'waybillNo', 'pickupCode', 'occurredAt', 'fragment']);
    const source = {};
    for (const [key, limit] of [['station', 120], ['carrier', 40], ['waybillNo', 32], ['pickupCode', 12], ['fragment', 120]]) {
      const value = report.source[key] ?? '';
      if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'INVALID_RECOGNITION_REPORT', '问题原文格式无效');
      source[key] = value;
    }
    if (report.source.occurredAt != null && report.source.occurredAt !== 0 && !validTime(report.source.occurredAt, this.now() + 5 * MINUTE)) fail(400, 'INVALID_RECOGNITION_REPORT', '来源时间无效');
    source.occurredAt = report.source.occurredAt || null;
    source.waybillNo = ''; source.pickupCode = '';
    const scope = scopes.find(scope => !scope.blocked) || scopes[0], fingerprint = this.reportFingerprint(source, scopes.map(({ shipment }) => shipment));
    const changed = !!previous && (previous.privacyFingerprint || previous.sourceFingerprint) !== fingerprint;
    const fresh = !previous || changed;
    const previousState = previous?.reportState || (previous?.reasonCode === 'CLIENT_MATCH_CONFIRMED' ? 'resolved'
      : previous?.reasonCode === 'SOURCE_WITHDRAWN' ? 'withdrawn' : 'unresolved');
    const restored = !!previous && TERMINAL.has(previous.status) && previousState !== 'unresolved';
    const platforms = [...new Set(scopes.map(scope => scope.account.platform))];
    if (!previous && this.tasks().filter(task => !TERMINAL.has(task.status)).length >= ACTIVE_LIMIT) fail(429, 'RECOGNITION_QUEUE_FULL', '识别问题队列已满');
    const task = this.store.transaction(() => {
      if (changed) this.db.prepare('DELETE FROM recognition_attempts WHERE task_id=?').run(id);
      return this.save({ ...previous, ...(fresh ? { initialFailures: 1, retryCount: 0, aiAttempts: 0, evidenceVersion: (previous?.evidenceVersion || 0) + 1,
        lastJobId: '', lastJobIds: [], pendingJobs: [], candidateIds: [], resumeStatus: '' } : {}),
        id, createdAt: previous?.createdAt || this.now(), ...recognitionMethod(platforms.length === 1 ? platforms[0] : 'other', 'station_match'),
        status: fresh ? scope.blocked ? 'blocked' : 'pending' : restored ? scope.blocked ? 'blocked' : previous.retryCount >= 3 ? 'review' : 'pending' : previous.status,
        nextRetryAt: !fresh && !restored ? previous.nextRetryAt : this.now() + 5 * MINUTE,
        accountId: scope.account.id, accountIds: [...new Set(scopes.map(scope => scope.account.id))], orderId: scope.order.id, shipmentId: scope.shipment.id,
        deviceId, clientId: report.id, reportRevision: report.revision, reportState: report.state, sourceId: report.sourceId,
        sourceFingerprint: !fresh ? previous.sourceFingerprint : fingerprint, privacyFingerprint: !fresh ? previous.privacyFingerprint : undefined, source, candidateShipmentIds: [...ids],
        observedAt: report.observedAt, reasonCodes: [...report.reasonCodes], reasonCode: changed ? 'SOURCE_CHANGED' : restored ? 'UNMATCHED_PICKUP' : previous?.reasonCode || 'UNMATCHED_PICKUP', problemCode: 'UNMATCHED_PICKUP' });
    });
    this.schedule(); return task;
  }
  persistedJob(id) {
    if (!id || !this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_job_summaries'").get()) return null;
    return parse(this.db.prepare("SELECT data FROM sync_job_summaries WHERE json_extract(data,'$.id')=?").get(id));
  }
  async retry(task, requests) {
    const scope = this.taskScope(task), pending = [], fingerprint = task.sourceFingerprint, evidenceVersion = task.evidenceVersion;
    if (scope.closed || scope.blocked || scope.partlyBlocked) { this.reevaluate(task); return; }
    for (const current of new Map(scope.sources.map(scope => [`${scope.account.id}:${scope.order.id}`, scope])).values()) {
      const saved = (task.pendingJobs || []).find(job => job.accountId === current.account.id && job.orderId === current.order.id);
      let job = this.persistedJob(saved?.id);
      if (job && !['queued', 'running'].includes(job.state)) { pending.push({ job, done: Promise.resolve(job) }); continue; }
      const key = `${current.account.id}:${current.order.id}`;
      if (!requests.has(key)) requests.set(key, this.requestOrder?.(current.account.id, current.order.id));
      const record = requests.get(key);
      if (!record?.job?.id || !record.done) {
        this.save({ ...task, status: 'pending', nextRetryAt: this.now() + 5 * MINUTE, reasonCode: 'COLLECTION_UNAVAILABLE' }); return;
      }
      pending.push(record);
    }
    this.save({ ...task, status: 'retrying', pendingJobs: pending.map(({ job }) => ({ id: job.id, accountId: job.accountId, orderId: job.orderId })),
      nextRetryAt: Math.max(0, ...pending.map(({ job }) => job.retryAt || 0)) });
    const jobs = await Promise.all(pending.map(record => record.done));
    if (this.closed) return;
    task = this.task(task.id);
    const currentScope = this.taskScope(task);
    if (TERMINAL.has(task.status) || currentScope.closed || currentScope.blocked || currentScope.partlyBlocked) { this.reevaluate(task); return; }
    if (task.evidenceVersion !== evidenceVersion || task.contentKind === 'pickup_match' && task.sourceFingerprint !== fingerprint) return;
    if (jobs.some(job => !['completed', 'error'].includes(job?.state))) {
      this.save({ ...task, status: 'pending', nextRetryAt: Math.max(this.now() + 5 * MINUTE, ...jobs.map(job => job?.retryAt || 0)), reasonCode: 'COLLECTION_DEFERRED' }); return;
    }
    if (jobs.some((job, index) => job.accountId !== pending[index].job.accountId || job.orderId !== pending[index].job.orderId
      || !(job.startedAt || this.persistedJob(job.parentJobId)?.startedAt))) {
      this.save({ ...task, status: 'pending', pendingJobs: [], nextRetryAt: this.now() + 5 * MINUTE, reasonCode: 'COLLECTION_NOT_RUN' }); return;
    }
    const jobIds = [...new Set(jobs.map(job => job.parentJobId || job.id))].sort();
    const attemptId = jobIds.length === 1 ? jobIds[0] : hash(JSON.stringify(jobIds));
    this.db.prepare('INSERT OR IGNORE INTO recognition_attempts VALUES(?,?)').run(task.id, attemptId);
    const retryCount = Math.min(3, this.db.prepare('SELECT COUNT(*) AS count FROM recognition_attempts WHERE task_id=?').get(task.id).count);
    this.reevaluate(this.save({ ...task, retryCount, lastJobId: jobs[0].id, lastJobIds: jobIds, pendingJobs: [], status: retryCount >= 3 ? 'ai_pending' : 'pending',
      nextRetryAt: retryCount >= 3 ? this.now() : this.now() + (retryCount + 1) * 5 * MINUTE, reasonCode: retryCount >= 3 ? 'LOCAL_RETRIES_EXHAUSTED' : task.problemCode }));
  }
  async escalate(task) {
    task = this.reevaluate(this.task(task.id) || task);
    if (TERMINAL.has(task.status) || task.status === 'blocked') return;
    if (!this.analyze) { this.save({ ...task, status: 'review', nextRetryAt: 0, reasonCode: 'AI_UNAVAILABLE' }); return; }
    const fingerprint = task.sourceFingerprint, evidenceVersion = task.evidenceVersion;
    const result = await this.analyze(structuredClone(task));
    if (this.closed) return;
    task = this.reevaluate(this.task(task.id));
    if (TERMINAL.has(task.status) || task.status === 'blocked') return;
    if (task.sourceFingerprint !== fingerprint || task.evidenceVersion !== evidenceVersion) return;
    const disabled = result?.status === 'disabled';
    this.save({ ...task, status: disabled ? 'ai_pending' : result?.status === 'queued' ? 'ai_running' : 'review',
      nextRetryAt: disabled ? this.now() + 5 * MINUTE : 0, aiAttempts: task.aiAttempts + (disabled ? 0 : 1),
      reasonCode: /^[A-Z_]{1,80}$/.test(result?.reasonCode || '') ? result.reasonCode : disabled ? 'AI_DISABLED' : 'AI_REQUIRES_EVIDENCE',
      candidateIds: Array.isArray(result?.candidateIds) ? result.candidateIds.filter(idText).slice(0, 20) : [] });
  }
  runDue() {
    if (this.closed) return { accepted: false, code: 'SERVICE_STOPPING' };
    if (this.running) return { accepted: false, code: 'RECOGNITION_RUNNING', running: true };
    this.running = (async () => {
      await this.daily();
      const requests = new Map();
      const pending = this.tasks().filter(task => !TERMINAL.has(task.status)).map(task => task.id);
      const work = async () => {
        while (!this.closed && pending.length) {
          const task = this.reevaluate(this.task(pending.shift()));
          if (task.nextRetryAt > this.now() || !['pending', 'retrying', 'ai_pending'].includes(task.status)) continue;
          try { if (task.status === 'ai_pending') await this.escalate(task); else await this.retry(task, requests); }
          catch {
            const current = !this.closed && this.task(task.id);
            if (current && !TERMINAL.has(current.status) && current.evidenceVersion === task.evidenceVersion && current.sourceFingerprint === task.sourceFingerprint)
              this.save({ ...current, nextRetryAt: this.now() + 5 * MINUTE, reasonCode: 'WORK_RETRY_REQUIRED' });
          }
        }
      };
      await Promise.all([work(), work(), work()]);
    })().finally(() => { this.running = null; this.schedule(); });
    this.running.catch(() => {});
    return { accepted: true, code: 'RECOGNITION_ACCEPTED', running: true };
  }
  dailyRun() { return parse(this.db.prepare('SELECT data FROM recognition_daily_runs ORDER BY day DESC LIMIT 1').get()); }
  nextDailyAt() {
    const day = dayKey(this.now()), run = this.dailyRun();
    return run?.day === day && run.status === 'complete' ? dailyAt(day) + DAY : Math.max(dailyAt(day), run?.retryAt || 0);
  }
  async daily() {
    if (this.closed) return null;
    if (this.dailyRunning) return this.dailyRunning;
    const day = dayKey(this.now());
    const previous = this.dailyRun();
    if (previous?.day === day && previous.status === 'complete') return previous;
    if (previous?.retryAt > this.now()) return previous;
    let run = previous?.status === 'scanning' ? previous : { day, status: 'scanning', cursor: previous?.truncated ? previous.cursor : 0, scanned: 0,
      upper: this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM shipments').get().value, startedAt: this.now() };
    run.retryAt = 0; run.errorCode = '';
    const saveRun = () => this.db.prepare('INSERT INTO recognition_daily_runs VALUES(?,?) ON CONFLICT(day) DO UPDATE SET data=excluded.data').run(run.day, JSON.stringify(run));
    this.dailyRunning = (async () => {
      saveRun();
      while (!this.closed && run.scanned < SCAN_LIMIT) {
        const rows = this.db.prepare('SELECT rowid AS seq,data FROM shipments WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 100').all(run.cursor, run.upper);
        if (!rows.length) break;
        this.observe({ shipments: rows.map(parse) });
        run.scanned += rows.length; run.cursor = rows.at(-1).seq; saveRun(); await yieldTurn();
      }
      if (this.closed) return run;
      for (const task of this.tasks()) if (!TERMINAL.has(task.status)) this.reevaluate(task);
      run = { ...run, status: 'complete', finishedAt: this.now(), truncated: run.cursor < run.upper, groups: this.groups(this.tasks()) }; saveRun();
      this.prune(); return run;
    })().catch(() => { run.retryAt = this.now() + MINUTE; run.errorCode = 'SCAN_RETRY_REQUIRED'; saveRun(); return run; })
      .finally(() => { this.dailyRunning = null; });
    return this.dailyRunning;
  }
  prune() {
    const old = this.db.prepare("SELECT id FROM recognition_tasks WHERE json_extract(data,'$.status') IN ('resolved','ignored') ORDER BY json_extract(data,'$.updatedAt') DESC,rowid DESC LIMIT -1 OFFSET ?").all(HISTORY_LIMIT);
    for (const { id } of old) { this.db.prepare('DELETE FROM recognition_attempts WHERE task_id=?').run(id); this.db.prepare('DELETE FROM recognition_tasks WHERE id=?').run(id); }
    this.db.prepare('DELETE FROM recognition_daily_runs WHERE day NOT IN (SELECT day FROM recognition_daily_runs ORDER BY day DESC LIMIT 90)').run();
    this.gateIndex = null;
  }
  groups(tasks) {
    const grouped = new Map();
    for (const task of tasks) {
      const { platform, contentKind, target, methodId, methodVersion } = task, key = JSON.stringify([platform, contentKind, target, methodId, methodVersion]);
      const group = grouped.get(key) || { platform, contentKind, target, methodId, methodVersion, total: 0, retryCount: 0, aiAttempts: 0, states: {} };
      group.total++; group.retryCount += task.retryCount; group.aiAttempts += task.aiAttempts; group.states[task.status] = (group.states[task.status] || 0) + 1; grouped.set(key, group);
    }
    return [...grouped.values()];
  }
  summary({ accountIds, deviceId } = {}) {
    const tasks = this.tasks().filter(task => (!accountIds || (task.accountIds || [task.accountId]).every(id => accountIds.includes(id))) && (!deviceId || !task.deviceId || task.deviceId === deviceId));
    return { policy: { initialFailures: 1, maxRetries: 3, retryMinutes: [5, 10, 15], timezone: 'Asia/Shanghai', dailyHour: 3 },
      running: !!this.running, nextDailyAt: this.nextDailyAt(), groups: this.groups(tasks), tasks: tasks.slice(-100),
      ...(!accountIds && !deviceId ? { daily: this.dailyRun() } : {}) };
  }
  allowAutomatic(shipment, target) {
    if (!this.gateIndex) {
      this.gateIndex = new Map();
      for (const task of this.tasks()) if (task.retryCount >= 3 && ['ai_pending', 'ai_running', 'review'].includes(task.status)) {
        for (const id of task.candidateShipmentIds || [task.shipmentId]) this.gateIndex.set(id, [...(this.gateIndex.get(id) || []), task]);
      }
    }
    const tasks = this.gateIndex.get(shipment.id);
    if (!tasks?.some(task => {
      if (target && task.target !== target) return false;
      const scope = this.taskScope(task); return !scope.closed && !scope.blocked && !scope.partlyBlocked;
    })) return false;
    const scope = this.scope(shipment.id); return !scope.closed && !scope.blocked;
  }
  latestForShipment(shipmentId, target) {
    return this.tasks().filter(task => (task.candidateShipmentIds || [task.shipmentId]).includes(shipmentId) && (!target || task.target === target))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt)[0] || null;
  }
  schedule() {
    clearTimeout(this.scheduled); this.scheduled = null;
    if (this.closed || !this.automaticEvents || this.running || this.dailyRunning) return;
    const due = this.tasks().filter(task => ['pending', 'retrying', 'ai_pending', 'blocked'].includes(task.status)).map(task => task.nextRetryAt || this.now());
    this.scheduled = setTimeout(() => { this.scheduled = null; this.runDue(); }, Math.max(0, Math.min(this.nextDailyAt(), ...due) - this.now())).unref();
  }
  async close() { this.closed = true; clearTimeout(this.scheduled); await this.dailyRunning; }
}
