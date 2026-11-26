import { randomUUID } from 'node:crypto';
import { fail, hash, onlyKeys } from './security.mjs';
import { nonPickupPlace, redactStationFragment, stationKey, stationText } from './station-text.mjs';
import { stationLocationConflict } from './station-automation.mjs';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
const parse = row => row && JSON.parse(row.data);
const fragment = (value, name, max = 120) => redactStationFragment(stationText(value ?? '', name, max, false));
const reasons = new Set(['', 'station_correction', 'manual_match', 'station_mismatch', 'missing_station', 'ambiguous_match', 'user_confirmed', 'other']);
const requestDigest = input => hash(JSON.stringify(['kind', 'shipmentId', 'stationName', 'otherStationName', 'targetStationId', 'subLocation', 'reason'].map(key => input[key] ?? '')));
const reason = (code, message) => ({ reasonCode: code, message });
const rejectionCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : 'INVALID_FEEDBACK';
const rejectionMessage = code => code === 'FEEDBACK_CONFLICT' ? '同版本反馈内容冲突，已拒收'
  : code === 'SCOPE_FORBIDDEN' ? '反馈不在设备授权范围内，已拒收' : '反馈未通过校验，已拒收';
const analysisEventIds = new WeakMap();
const analysisEventId = candidate => {
  let id = analysisEventIds.get(candidate);
  if (!id) { id = randomUUID(); analysisEventIds.set(candidate, id); }
  return id;
};
const safeCandidate = (stations, id) => {
  if (!id) return null;
  try { return stations.candidate(id); } catch (error) { if (error.status === 404) return null; throw error; }
};

// Device-owned receipts outlive parcel completion. Candidates may share identical
// evidence, but withdrawing one receipt must never remove another device's sample.
export class MatchingFeedbackStore {
  constructor({ store, stations, now = Date.now }) {
    this.store = store; this.stations = stations; this.db = store.db; this.now = now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS matching_feedback (
      device_id TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      PRIMARY KEY(device_id,id));
      CREATE TABLE IF NOT EXISTS matching_feedback_admin_index (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, record_type TEXT NOT NULL, device_id TEXT NOT NULL, record_id TEXT NOT NULL,
        UNIQUE(record_type,device_id,record_id));
      CREATE TABLE IF NOT EXISTS matching_feedback_rejections (
        sequence INTEGER PRIMARY KEY, device_id TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
        reason_code TEXT NOT NULL, created_at INTEGER NOT NULL, rejection_key TEXT NOT NULL,
        UNIQUE(device_id,rejection_key));
      CREATE TABLE IF NOT EXISTS station_rule_receipts (
        device_id TEXT NOT NULL, station_rules_version INTEGER NOT NULL, server_logistics_rules_version INTEGER NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(device_id,station_rules_version,server_logistics_rules_version));`);
    this.db.exec(`INSERT OR IGNORE INTO matching_feedback_admin_index(record_type,device_id,record_id)
      SELECT 'feedback',device_id,id FROM matching_feedback ORDER BY rowid;`);
    const attemptColumns = this.db.prepare('PRAGMA table_info(matching_feedback_attempts)').all();
    if (!attemptColumns.length) {
      this.db.exec(`CREATE TABLE matching_feedback_attempts (
        candidate_id TEXT NOT NULL, attempt_id TEXT NOT NULL, candidate_updated_at INTEGER NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL,
        PRIMARY KEY(candidate_id,attempt_id));`);
    } else if (!attemptColumns.some(column => column.name === 'attempt_id')) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(`CREATE TABLE matching_feedback_attempts_migrating (
          candidate_id TEXT NOT NULL, attempt_id TEXT NOT NULL, candidate_updated_at INTEGER NOT NULL, fingerprint TEXT NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY(candidate_id,attempt_id));
          INSERT INTO matching_feedback_attempts_migrating(candidate_id,attempt_id,candidate_updated_at,fingerprint,data)
            SELECT candidate_id, 'legacy-' || rowid, candidate_updated_at, fingerprint, data FROM matching_feedback_attempts ORDER BY rowid;
          DROP TABLE matching_feedback_attempts;
          ALTER TABLE matching_feedback_attempts_migrating RENAME TO matching_feedback_attempts;`);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    this.db.exec('CREATE INDEX IF NOT EXISTS matching_feedback_attempts_fingerprint ON matching_feedback_attempts(candidate_id,fingerprint);');
    this.unsubscribeAnalysis = stations.onAnalysis(candidate => {
      const analysis = candidate?.analysis;
      if (analysis?.finishedAt || analysis?.error) this.captureAttempt(candidate, true);
    });
  }
  read(deviceId, id) { return parse(this.db.prepare('SELECT data FROM matching_feedback WHERE device_id=? AND id=?').get(deviceId, id)); }
  rows() { return this.db.prepare('SELECT data FROM matching_feedback').all().map(parse); }
  save(deviceId, value) {
    this.db.prepare('INSERT INTO matching_feedback VALUES(?,?,?) ON CONFLICT(device_id,id) DO UPDATE SET data=excluded.data').run(deviceId, value.id, JSON.stringify(value));
    this.db.prepare('INSERT OR IGNORE INTO matching_feedback_admin_index(record_type,device_id,record_id) VALUES(?,?,?)').run('feedback', deviceId, value.id);
  }
  recordRejection(device, input, error) {
    const id = validId(input?.id) ? input.id : '', revision = Number.isSafeInteger(input?.revision) && input.revision >= 0 ? input.revision : 0;
    const code = rejectionCode(error), rejectionKey = `${id}:${revision}:${code}`, createdAt = this.now();
    this.stations.transaction(() => {
      const existing = this.db.prepare('SELECT sequence FROM matching_feedback_rejections WHERE device_id=? AND rejection_key=?').get(device.id, rejectionKey);
      if (existing) return;
      this.db.prepare('INSERT OR IGNORE INTO matching_feedback_admin_index(record_type,device_id,record_id) VALUES(?,?,?)').run('rejected', device.id, rejectionKey);
      const sequence = this.db.prepare('SELECT sequence FROM matching_feedback_admin_index WHERE record_type=? AND device_id=? AND record_id=?')
        .get('rejected', device.id, rejectionKey).sequence;
      this.db.prepare('INSERT INTO matching_feedback_rejections(sequence,device_id,id,revision,reason_code,created_at,rejection_key) VALUES(?,?,?,?,?,?,?)')
        .run(sequence, device.id, id, revision, code, createdAt, rejectionKey);
    });
  }
  captureAttempt(candidate, fromAnalysisEvent = false) {
    const analysis = candidate?.analysis;
    if (!candidate?.id || !analysis || !analysis.finishedAt && !analysis.error) return;
    const candidateUpdatedAt = Number.isSafeInteger(candidate.updatedAt) && candidate.updatedAt >= 0 ? candidate.updatedAt : 0;
    const snapshot = { candidateId: candidate.id, candidateUpdatedAt, status: candidate.status,
      startedAt: analysis.startedAt || 0, finishedAt: analysis.finishedAt || 0, error: analysis.error || null, result: analysis.result || null,
      capturedAt: this.now(), effectStatus: 'unverified' };
    const fingerprint = hash(JSON.stringify([snapshot.startedAt, snapshot.finishedAt, snapshot.error, snapshot.result]));
    if (!fromAnalysisEvent && this.db.prepare('SELECT 1 FROM matching_feedback_attempts WHERE candidate_id=? AND fingerprint=? LIMIT 1').get(candidate.id, fingerprint)) return;
    const attemptId = fromAnalysisEvent ? analysisEventId(candidate) : randomUUID();
    this.db.prepare('INSERT OR IGNORE INTO matching_feedback_attempts(candidate_id,attempt_id,candidate_updated_at,fingerprint,data) VALUES(?,?,?,?,?)')
      .run(candidate.id, attemptId, candidateUpdatedAt, fingerprint, JSON.stringify(snapshot));
  }
  attempts(candidateId) {
    return this.db.prepare('SELECT data FROM matching_feedback_attempts WHERE candidate_id=? ORDER BY rowid ASC').all(candidateId).map(parse);
  }
  latestRuleReceipt(deviceId) {
    const row = this.db.prepare('SELECT data FROM station_rule_receipts WHERE device_id=? ORDER BY rowid DESC LIMIT 1').get(deviceId);
    return row ? parse(row) : null;
  }
  submitRuleReceipt(device, input, { stationRulesVersion, serverLogisticsRulesVersion }) {
    onlyKeys(input, ['stationRulesVersion', 'serverLogisticsRulesVersion']);
    const stationVersion = input.stationRulesVersion, logisticsVersion = input.serverLogisticsRulesVersion;
    if (!Number.isSafeInteger(stationVersion) || stationVersion < 0 || !Number.isSafeInteger(logisticsVersion) || logisticsVersion < 0) fail(400, 'INVALID_RULE_RECEIPT', '规则版本必须是非负整数');
    if (stationVersion > stationRulesVersion || logisticsVersion > serverLogisticsRulesVersion) fail(409, 'RULE_RECEIPT_AHEAD', '设备规则版本不能超过服务端当前版本');
    const existing = this.db.prepare('SELECT data FROM station_rule_receipts WHERE device_id=? AND station_rules_version=? AND server_logistics_rules_version=?')
      .get(device.id, stationVersion, logisticsVersion);
    const value = existing ? parse(existing) : { deviceId: device.id, stationRulesVersion: stationVersion, serverLogisticsRulesVersion: logisticsVersion,
      receivedAt: this.now(), effectStatus: 'unverified' };
    if (!existing) {
      this.db.prepare('INSERT INTO station_rule_receipts VALUES(?,?,?,?)').run(device.id, stationVersion, logisticsVersion, JSON.stringify(value));
      this.db.prepare('DELETE FROM station_rule_receipts WHERE device_id=? AND rowid NOT IN (SELECT rowid FROM station_rule_receipts WHERE device_id=? ORDER BY rowid DESC LIMIT 100)')
        .run(device.id, device.id);
    }
    return { accepted: true, receipt: value };
  }
  state(value, config = this.stations.aiConfig(), { readOnly = false } = {}) {
    const configured = Boolean(config.channelEnabled && config.hasApiKey && config.channelName && config.baseUrl && config.model);
    const candidate = safeCandidate(this.stations, value.candidateId);
    if (!readOnly) this.captureAttempt(candidate);
    const station = candidate?.stationId ? this.stations.station(candidate.stationId) : null;
    const aliasKey = stationKey(candidate?.approvedAlias?.name || candidate?.suggestion?.alias || candidate?.stationName);
    const rulePresent = station?.enabled && aliasKey && [station.name, ...station.aliases.map(alias => alias.name)].some(name => stationKey(name) === aliasKey);
    const status = value.action === 'withdraw' ? 'withdrawn' : candidate?.application?.rolledBackAt ? 'review'
      : candidate?.status === 'approved' && rulePresent ? 'applied' : candidate?.status === 'pending' ? 'pending' : candidate?.status === 'failed' ? 'failed' : 'review';
    const error = value.action === 'withdraw' ? candidate?.feedback?.active === false && candidate?.application && !candidate.application.rolledBackAt ? candidate.automationReason : ''
      : candidate?.status === 'approved' && !rulePresent ? '关联站点或别名已停用、变更或回滚，请核对' : candidate?.automationReason || candidate?.error || value.error || '';
    let detail = value.action === 'withdraw'
      ? (candidate ? reason(error ? 'WITHDRAWN_REVIEW' : 'WITHDRAWN', error || '人工反馈已撤回') : reason('WITHDRAWN_NO_CANDIDATE', '撤回回执已保存；本次反馈没有关联候选'))
      : status === 'applied' ? reason('RULE_APPLIED', '人工反馈已形成并保留站点规则')
        : /已有确认规则|未修改规则/u.test(error) ? reason('NO_NEW_RULE', error)
          : /缺少可学习的原站名/u.test(error) ? reason('MISSING_SOURCE_STATION', error)
            : /并非末端取件站点/u.test(error) ? reason('NON_PICKUP_PLACE', error)
              : /物流站名与授权运单不一致/u.test(error) ? reason('SHIPMENT_STATION_MISMATCH', error)
                : /尚无唯一已知站点/u.test(error) ? reason('NO_UNIQUE_KNOWN_STATION', error)
                  : /缺少唯一目标站点/u.test(error) ? reason('NO_UNIQUE_TARGET', error)
                      : /今日AI调用已达上限/u.test(error) ? reason('AI_DAILY_LIMIT', error)
                        : /重试等待期/u.test(error) ? reason('AI_RETRY_COOLDOWN', error)
                          : /配置AI|渠道已暂停|配置不完整/u.test(error) ? reason('AI_NOT_CONFIGURED', error)
                            : status === 'failed' ? reason('ANALYSIS_FAILED', error || '分析失败，可稍后重试')
                      : status === 'pending' && !configured ? reason('AI_NOT_CONFIGURED', '后台尚未配置可用的 AI 渠道，反馈已保存')
                        : status === 'pending' && !config.enabled ? reason('AI_DISABLED', '后台自动优化未开启，反馈已保存')
                          : status === 'pending' && config.usageToday >= config.dailyLimit ? reason('AI_DAILY_LIMIT', '已达到后台今日 AI 调用额度，等待下一周期')
                            : status === 'pending' && candidate?.retryAt > this.now() ? reason('AI_RETRY_COOLDOWN', '分析失败后等待重试')
                              : status === 'pending' ? reason('PENDING_ANALYSIS', '已接收，等待后台分析')
                                : reason('REVIEW_REQUIRED', error || '证据不足或存在冲突，需要核对');
    return { id: value.id, revision: value.revision, status, candidateId: value.candidateId || '',
      error, ...detail, candidateStatus: candidate?.status || '', ruleVersion: candidate?.application?.revision || station?.revision || 0,
      updatedAt: Math.max(value.updatedAt, candidate?.updatedAt || 0) };
  }
  summary(device, limit = 500) {
    const config = this.stations.aiConfig();
    return { items: this.db.prepare('SELECT data FROM matching_feedback WHERE device_id=? ORDER BY rowid DESC').all(device.id).map(parse).map(value => this.state(value, config)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit),
      configured: Boolean(config.channelEnabled && config.hasApiKey && config.channelName && config.baseUrl && config.model), enabled: config.enabled, autoApply: config.autoApply };
  }
  adminQuery({ limit = 50, before = 0, status = '', kind = '', reasonCode = '', device = '', station = '', from = 0, to = 0, readOnly = false } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'INVALID_FEEDBACK_QUERY', '每页反馈数须为1到100');
    if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(to) || to < 0) fail(400, 'INVALID_FEEDBACK_QUERY', '反馈游标或时间范围无效');
    const config = this.stations.aiConfig(), devices = new Map(this.store.devices().map(value => [value.id, value]));
    const opaqueDevice = id => hash(`matching-feedback:${id}`).slice(0, 12);
    const deviceMatch = value => !device || value.id === device || opaqueDevice(value.id) === device || (value.name || '').toLocaleLowerCase().includes(device.toLocaleLowerCase());
    const textMatch = (value, candidate, stationRule) => !station || [value.stationName, value.otherStationName, value.targetStationId, value.subLocation, candidate?.stationName, candidate?.fragment,
      candidate?.approvedAlias?.name, candidate?.suggestion?.alias, candidate?.application?.stationName, candidate?.application?.alias?.name, stationRule?.name].filter(Boolean)
      .some(part => String(part).toLocaleLowerCase().includes(station.toLocaleLowerCase()));
    const window = Math.min(200, Math.max(limit, 50));
    const rows = this.db.prepare(`SELECT admin_index.sequence, admin_index.record_type, admin_index.device_id, admin_index.record_id,
        feedback.data, rejection.id AS rejected_id, rejection.revision AS rejected_revision,
        rejection.reason_code AS rejected_reason_code, rejection.created_at AS rejected_created_at
      FROM matching_feedback_admin_index AS admin_index
      LEFT JOIN matching_feedback AS feedback ON admin_index.record_type='feedback' AND feedback.device_id=admin_index.device_id AND feedback.id=admin_index.record_id
      LEFT JOIN matching_feedback_rejections AS rejection ON admin_index.record_type='rejected' AND rejection.sequence=admin_index.sequence
      WHERE admin_index.sequence < ? ORDER BY admin_index.sequence DESC LIMIT ?`).all(before || Number.MAX_SAFE_INTEGER, window);
    const items = [];
    let lastProcessed = 0, stoppedByLimit = false;
    for (const row of rows) {
      lastProcessed = row.sequence;
      const meta = devices.get(row.device_id) || { name: '已移除设备' };
      if (row.record_type === 'rejected') {
        if (status && status !== 'rejected' || kind || reasonCode && reasonCode !== row.rejected_reason_code || !deviceMatch({ id: row.device_id, name: meta.name }) || station
          || from && row.rejected_created_at < from || to && row.rejected_created_at > to) continue;
        const code = row.rejected_reason_code;
        items.push({ id: row.rejected_id, revision: row.rejected_revision, status: 'rejected', candidateId: '', error: code,
          reasonCode: code, message: rejectionMessage(code), updatedAt: row.rejected_created_at,
          device: { id: opaqueDevice(row.device_id), name: meta.name || '未命名设备' },
          deviceRuleReceipt: { received: false, stationRulesVersion: 0, serverLogisticsRulesVersion: 0, receivedAt: 0, effectStatus: 'unverified' },
          receipt: { id: row.rejected_id, revision: row.rejected_revision, action: 'rejected', kind: '', reason: '', shipmentId: '', stationName: '',
            otherStationName: '', targetStationId: '', subLocation: '', createdAt: row.rejected_created_at, updatedAt: row.rejected_created_at },
          candidate: null, analysis: null, analysisAttempts: [], rule: null });
        if (items.length >= limit) { stoppedByLimit = true; break; }
        continue;
      }
      if (!row.data) continue;
      const value = parse(row), candidate = safeCandidate(this.stations, value.candidateId), stationRule = candidate?.stationId ? this.stations.station(candidate.stationId) : null, state = this.state(value, config, { readOnly });
      if (status && state.status !== status || kind && value.kind !== kind || reasonCode && state.reasonCode !== reasonCode || !deviceMatch({ id: row.device_id, name: meta.name }) || !textMatch(value, candidate, stationRule)) continue;
      if (from && state.updatedAt < from || to && state.updatedAt > to) continue;
      const analysis = candidate?.analysis && { startedAt: candidate.analysis.startedAt || 0, finishedAt: candidate.analysis.finishedAt || 0,
        error: candidate.analysis.error || null, result: candidate.analysis.result || null };
      const application = candidate?.application || (candidate?.approvedAlias && stationRule ? { stationId: candidate.stationId, stationName: stationRule.name,
        alias: candidate.approvedAlias, revision: stationRule.revision, appliedAt: 0, rolledBackAt: 0 } : null);
      const ruleReceipt = this.latestRuleReceipt(row.device_id);
      items.push({ ...state, device: { id: opaqueDevice(row.device_id), name: meta.name || '未命名设备' },
        ...(readOnly ? { targetStationName: value.targetStationId ? this.stations.station(value.targetStationId)?.name || '' : '' } : {}),
        deviceRuleReceipt: ruleReceipt ? { received: true, stationRulesVersion: ruleReceipt.stationRulesVersion, serverLogisticsRulesVersion: ruleReceipt.serverLogisticsRulesVersion,
          receivedAt: ruleReceipt.receivedAt, effectStatus: 'unverified' } : { received: false, stationRulesVersion: 0, serverLogisticsRulesVersion: 0, receivedAt: 0, effectStatus: 'unverified' },
        receipt: { id: value.id, revision: value.revision, action: value.action, kind: value.kind || '', reason: value.reason || '', shipmentId: value.shipmentId || '',
          stationName: value.stationName || '', otherStationName: value.otherStationName || '', targetStationId: value.targetStationId || '', subLocation: value.subLocation || '',
          createdAt: value.createdAt || 0, updatedAt: value.updatedAt || 0 },
        candidate: candidate && { id: candidate.id, status: candidate.status, stationName: candidate.stationName, fragment: candidate.fragment, region: candidate.region,
          occurrences: candidate.occurrences, error: candidate.error || '', automationReason: candidate.automationReason || '', suggestion: candidate.suggestion || null,
          evidence: candidate.evidence || [], createdAt: candidate.createdAt || 0, updatedAt: candidate.updatedAt || 0 },
        analysis, analysisAttempts: candidate ? this.attempts(candidate.id) : [], rule: application && { stationId: application.stationId, stationName: application.stationName || stationRule?.name || '', alias: application.alias || null,
          revision: application.revision || stationRule?.revision || 0, appliedAt: application.appliedAt || 0, rolledBackAt: application.rolledBackAt || 0,
          status: application.rolledBackAt ? 'rolled_back' : 'active' } });
      if (items.length >= limit) { stoppedByLimit = true; break; }
    }
    return { items, nextCursor: lastProcessed && (stoppedByLimit || rows.length === window) ? String(lastProcessed) : '' };
  }
  normalize(input, device) {
    onlyKeys(input, ['id', 'revision', 'action', 'kind', 'shipmentId', 'stationName', 'otherStationName', 'targetStationId', 'subLocation', 'reason']);
    if (!validId(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !['upsert', 'withdraw'].includes(input.action)) fail(400, 'INVALID_FEEDBACK', '反馈标识、版本或动作无效');
    if (input.action === 'withdraw') return { id: input.id, revision: input.revision, action: input.action };
    if (!['station_correction', 'manual_match'].includes(input.kind)) fail(400, 'INVALID_FEEDBACK', '反馈类型无效');
    const shipmentId = input.shipmentId ?? '', targetStationId = input.targetStationId ?? '', reason = input.reason ?? '';
    if (shipmentId && !validId(shipmentId) || targetStationId && !validId(targetStationId) || !reasons.has(reason)) fail(400, 'INVALID_FEEDBACK', '反馈字段无效');
    if (input.kind === 'manual_match' && !shipmentId || input.kind === 'station_correction' && !targetStationId) fail(400, 'INVALID_FEEDBACK', '缺少运单或目标站点');
    let shipment;
    if (shipmentId) {
      shipment = this.store.operationShipment(device, shipmentId);
      if (!this.store.canRead(device, shipment)) fail(403, 'SCOPE_FORBIDDEN', '运单不在授权范围内');
    }
    const target = targetStationId ? this.stations.station(targetStationId) : null;
    if (targetStationId && !target?.enabled) fail(400, 'INVALID_STATION', '目标站点不存在或已停用');
    const stationName = fragment(input.stationName, '原站名'), suppliedOther = fragment(input.otherStationName, '物流站名'), subLocation = fragment(input.subLocation, '柜号', 60);
    const storedOther = shipment ? fragment(shipment.station, '物流站名') : suppliedOther;
    const projected = shipment ? this.store.shipmentView(shipment).station : null;
    let projectedOther = '';
    if (projected?.rawName && !projected.conflict && !stationLocationConflict(storedOther, projected.rawName)) {
      try { projectedOther = fragment(projected.rawName, '物流站名'); }
      catch (error) { if (error.code !== 'INVALID_STATION') throw error; }
    }
    // Verify against server-owned evidence, including the projection sent to the device.
    const otherStationName = projectedOther || storedOther;
    const suppliedKey = stationKey(suppliedOther);
    const matchesOther = [otherStationName, storedOther].some(value => value === suppliedOther || suppliedKey && suppliedKey === stationKey(value));
    const catalog = this.stations.stationRules().stations;
    const logistics = globalThis.PickCodeLogistics;
    const owner = projected?.conflict ? null : logistics.catalogStation(otherStationName, catalog);
    const resolvedTarget = targetStationId || owner?.id || '';
    const source = logistics.catalogStation(stationName, catalog);
    const selectedTarget = this.stations.station(resolvedTarget);
    const locationConflict = stationLocationConflict(stationName, subLocation, otherStationName, selectedTarget?.name);
    const sourceKnown = source.id && source.id === resolvedTarget;
    const exactSource = selectedTarget && [selectedTarget.name, ...selectedTarget.aliases.map(alias => alias.name)]
      .some(name => stationKey(name) === stationKey(stationName));
    const error = !stationKey(stationName) ? '缺少可学习的原站名，仅保留人工确认记录'
      : [stationName, otherStationName, subLocation].some(nonPickupPlace) ? '片段并非末端取件站点，需核对'
      : input.kind === 'manual_match' && suppliedOther && !matchesOther ? '提交的物流站名与授权运单不一致，需核对'
      : input.kind === 'manual_match' && (!owner?.id || owner.id !== resolvedTarget) ? '授权运单尚无唯一已知站点，不能据此自动学习'
      : sourceKnown && !locationConflict && (input.kind === 'manual_match' || !exactSource) ? '站点已由现有规则识别，未修改规则'
      : !resolvedTarget ? '缺少唯一目标站点，仅保留人工确认记录' : '';
    return { id: input.id, revision: input.revision, action: input.action, kind: input.kind, shipmentId,
      stationName, otherStationName, targetStationId: resolvedTarget, subLocation, reason, error };
  }
  candidateFor(value) {
    const evidenceKey = hash(JSON.stringify([value.kind, value.stationName, value.otherStationName, value.targetStationId, value.subLocation, value.error]));
    const existing = this.stations.candidates().find(candidate => candidate.feedback?.key === evidenceKey && candidate.feedback.active && !candidate.application?.rolledBackAt);
    if (existing) return existing;
    if (this.stations.candidates().length >= 2000) fail(429, 'STATION_QUEUE_FULL', '站点队列已满');
    const id = randomUUID(), candidate = { id, stationName: value.stationName,
      fragment: [value.stationName, value.subLocation && !value.stationName.includes(value.subLocation) ? value.subLocation : ''].filter(Boolean).join('，'),
      source: 'manual', region: '', status: value.error ? 'unknown' : 'pending', eventPending: !value.error,
      suggestion: null, evidence: [], occurrences: 0, attempts: 0, cancelledAttempts: 0, retryAt: 0, error: '', automationReason: value.error,
      feedback: { key: evidenceKey, active: true, kind: value.kind, sourceStationName: value.stationName, otherStationName: value.otherStationName,
        targetStationId: value.targetStationId, subLocation: value.subLocation, reason: value.reason, verified: !value.error },
      analysis: null, createdAt: this.now(), updatedAt: this.now() };
    this.db.prepare('INSERT INTO station_candidates VALUES(?,?,?)').run(id, `feedback-${id}`, JSON.stringify(candidate));
    return candidate;
  }
  refreshOwnership(id) {
    if (!id) return;
    const candidate = this.stations.candidate(id), count = this.rows().filter(value => value.action === 'upsert' && value.candidateId === id).length;
    if (count) { this.stations.updateCandidate(id, { occurrences: count }); return; }
    this.stations.updateCandidate(id, { status: 'withdrawn', eventPending: false, feedback: { ...candidate.feedback, active: false }, occurrences: 0, automationReason: '人工样本已撤回' });
    let error = '';
    const aliasKey = stationKey(candidate.approvedAlias?.name || candidate.suggestion?.alias || candidate.stationName);
    // A second candidate may have reused an alias created by an earlier one.
    // Its final withdrawal must still find the original reversible application.
    const applications = this.stations.candidates().filter(origin => origin.application && !origin.application.rolledBackAt
      && (origin.id === id || origin.application.stationId === candidate.stationId && stationKey(origin.application.alias.name) === aliasKey));
    for (const origin of applications) {
      const { stationId, alias } = origin.application;
      const supported = this.stations.candidates().some(other => other.status === 'approved' && other.stationId === stationId
        && stationKey(other.approvedAlias?.name || other.suggestion?.alias || other.stationName) === stationKey(alias.name) && (!other.feedback || other.feedback.active));
      if (!supported) {
        try {
          this.stations.rollbackAutomaticAlias(origin.id);
          if (origin.feedback?.active === false) this.stations.updateCandidate(origin.id, { status: 'withdrawn', automationReason: '人工样本已撤回，自动别名已回滚' });
        }
        catch (failure) { if (failure.code !== 'AI_CHANGE_CONFLICT') throw failure; error = '反馈已撤回；别名已被人工修改，请管理员核对'; }
      }
    }
    this.stations.updateCandidate(id, { status: 'withdrawn', automationReason: error || '人工样本已撤回' });
  }
  submit(device, body) {
    onlyKeys(body, ['items']);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20) fail(400, 'INVALID_FEEDBACK', '每批反馈须为1到20条');
    const accepted = [], rejected = [];
    for (const input of body.items) {
      try {
        this.stations.transaction(() => {
          onlyKeys(input, ['id', 'revision', 'action', 'kind', 'shipmentId', 'stationName', 'otherStationName', 'targetStationId', 'subLocation', 'reason']);
          if (!validId(input.id) || !Number.isSafeInteger(input.revision) || input.revision < 1 || !['upsert', 'withdraw'].includes(input.action)) fail(400, 'INVALID_FEEDBACK', '反馈标识、版本或动作无效');
          const old = this.read(device.id, input.id), digest = requestDigest(input);
          if (old && (old.revision > input.revision || old.revision === input.revision && old.action === 'withdraw')) return;
          if (old?.revision === input.revision && input.action === 'upsert') {
            if (old.digest !== digest) fail(409, 'FEEDBACK_CONFLICT', '同版本反馈内容不一致');
            return;
          }
          const value = this.normalize(input, device);
          if (!old && this.db.prepare('SELECT COUNT(*) AS count FROM matching_feedback WHERE device_id=?').get(device.id).count >= 500) fail(429, 'FEEDBACK_LIMIT', '人工反馈已达到容量上限');
          const candidate = value.action === 'upsert' ? this.candidateFor(value) : null;
          this.save(device.id, { ...value, digest, candidateId: candidate?.id || old?.candidateId || '', createdAt: old?.createdAt || this.now(), updatedAt: this.now() });
          if (old?.candidateId && old.candidateId !== candidate?.id) this.refreshOwnership(old.candidateId);
          if (candidate) this.refreshOwnership(candidate.id);
        });
        accepted.push({ id: input.id, revision: input.revision });
      } catch (error) {
        if (!error.status) throw error;
        this.recordRejection(device, input, error);
        rejected.push({ id: validId(input?.id) ? input.id : '', revision: Number.isSafeInteger(input?.revision) ? input.revision : 0,
          status: 'rejected', candidateId: '', error: rejectionCode(error), updatedAt: this.now() });
      }
    }
    if (accepted.length) for (const listener of this.stations.aiQueueListeners) { try { listener(); } catch { /* Durable receipt is independent of workers. */ } }
    const summary = this.summary(device);
    return { accepted, ...summary, items: [...summary.items.filter(item => !rejected.some(value => value.id === item.id)), ...rejected] };
  }
}
