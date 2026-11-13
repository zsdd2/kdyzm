import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { RecognitionWorkflow, recognitionMethod, recognitionProblems } from '../src/recognition-workflow.mjs';
import { RecognitionAi } from '../src/recognition-ai.mjs';
import { createRecognitionApi } from '../src/recognition-api.mjs';
import '../app-source/pickcode/core/load-core.mjs';

const NOW = Date.parse('2026-11-10T03:00:00+08:00'), MINUTE = 60000, DAY = 86400000;
function fixture(t, options = {}) {
  let clock = NOW, sequence = 0, workflow;
  const now = () => clock, store = new Store({ filename: ':memory:', key: Buffer.alloc(32, 3), now });
  const requests = [], analyses = [];
  const requestOrder = (accountId, orderId) => {
    const job = { id: `job-${requests.length + 1}`, accountId, orderId, state: 'completed', startedAt: now(), finishedAt: now() };
    requests.push(job);
    return options.request ? options.request(job) : { job, done: Promise.resolve(job) };
  };
  const make = () => new RecognitionWorkflow({ store, now, requestOrder, automaticEvents: false, authorizeReport: options.authorizeReport, refreshAnalysis: options.refreshAnalysis,
    analyze: async task => { analyses.push(task); return options.analyze ? options.analyze(task) : { status: 'queued', candidateIds: ['safe-candidate'] }; } });
  workflow = make();
  const add = (patch = {}, platform = 'taobao') => {
    const key = String(++sequence), accountId = `a-${key}`;
    store.saveAccount({ platform, label: '合成账号', cookie: 'SYNTHETIC' }, accountId, true);
    store.importResult(accountId, { orders: [{ platformOrderId: key, title: '合成', orderDate: now() - 1000 }],
      shipments: [{ platformOrderId: key, waybillNo: `waybill-${key}`, status: 'transit', logisticsState: 'ok', logisticsEvents: [] }] });
    const shipment = store.snapshot([accountId]).shipments[0];
    const result = { ...store.shipment(shipment.id), logisticsState: 'error', ...patch };
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(result), result.id);
    return result;
  };
  const patch = (shipment, values) => {
    const next = { ...store.shipment(shipment.id), ...values };
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(next), shipment.id); return next;
  };
  const run = async () => { workflow.runDue(); await workflow.running; };
  const restart = async () => { await workflow.close(); workflow = make(); };
  t.after(async () => { await workflow.close(); store.close(); });
  return { store, requests, analyses, add, patch, run, restart, now, advance: amount => { clock += amount; }, get workflow() { return workflow; } };
}

const report = (shipmentIds, revision = 1, state = 'unresolved') => ({ id: 'client-report', revision, kind: 'unmatched_pickup', state,
  sourceId: 'local-source', observedAt: NOW, source: { station: '合成站点', carrier: '', waybillNo: '', pickupCode: '合成', occurredAt: null, fragment: '合成站点待取' },
  candidateShipmentIds: shipmentIds, reasonCodes: ['station_mismatch'] });

test('legacy report privacy migration retains progress, terminal decisions, attempts and AI review identities across retransmission', async t => {
  for (const status of ['pending', 'ai_running', 'review', 'resolved', 'ignored']) await t.test(status, async t => {
    const f = fixture(t), shipment = f.add({ logisticsState: 'ok' }), input = report([shipment.id]);
    const task = f.workflow.submit(input, { deviceId: 'd-one' });
    const source = { ...task.source, pickupCode: '7-6-7042', waybillNo: 'JD99999999999' };
    const legacyTask = { ...task, source, sourceFingerprint: f.workflow.reportFingerprint(source, [f.store.shipment(shipment.id)]),
      status, retryCount: 3, aiAttempts: 1, evidenceVersion: 4, candidateIds: ['review-candidate'], lastJobId: 'job-before', nextRetryAt: 0,
      reasonCode: status === 'resolved' ? 'CLIENT_MATCH_CONFIRMED' : status === 'ignored' ? 'SOURCE_INACTIVE' : 'AI_REQUIRES_EVIDENCE' };
    delete legacyTask.reportState;
    const legacy = f.workflow.save(legacyTask);
    f.store.db.prepare('INSERT INTO recognition_attempts VALUES(?,?)').run(task.id, 'job-before');
    const ai = new RecognitionAi({ store: f.store, now: f.now });
    const review = { id: 'old-review', taskId: task.id, sourceFingerprint: legacy.sourceFingerprint, status: 'review', reasonCode: 'AI_REQUIRES_EVIDENCE', candidateIds: ['review-candidate'] };
    f.store.db.prepare('INSERT INTO recognition_ai_reviews VALUES(?,?,?)').run(review.id, task.id, JSON.stringify(review));
    const priorReview = ai.refresh(legacy);
    await f.restart();
    const migrated = f.workflow.task(task.id);
    assert.deepEqual(migrated, { ...legacy, source: { ...source, pickupCode: '', waybillNo: '' }, privacyFingerprint: migrated.privacyFingerprint });
    assert.ok(migrated.privacyFingerprint); assert.notEqual(migrated.privacyFingerprint, legacy.sourceFingerprint);
    assert.deepEqual(ai.refresh(migrated), priorReview);
    const raw = { ...input, source, state: status === 'resolved' ? 'resolved' : 'unresolved' };
    for (const incoming of [raw, { ...raw, revision: 2 }, { ...raw, revision: 3, source: { ...source, pickupCode: '', waybillNo: '' } }]) {
      const next = f.workflow.submit(incoming, { deviceId: 'd-one' });
      for (const key of ['sourceFingerprint', 'privacyFingerprint', 'status', 'retryCount', 'aiAttempts', 'evidenceVersion', 'candidateIds', 'lastJobId', 'nextRetryAt', 'createdAt']) {
        assert.deepEqual(next[key], migrated[key], key);
      }
      assert.equal(next.source.pickupCode, ''); assert.equal(next.source.waybillNo, '');
      assert.deepEqual(ai.refresh(next), priorReview);
    }
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM recognition_attempts WHERE task_id=?').get(task.id).count, 1);
    assert.equal(f.store.db.prepare('SELECT data FROM recognition_ai_reviews WHERE id=?').get(review.id).data, JSON.stringify(review));
    const once = f.workflow.task(task.id); await f.restart(); assert.deepEqual(f.workflow.task(task.id), once);
    assert.equal(f.analyses.length, 0); assert.equal(f.requests.length, 0);
    const changed = f.workflow.submit({ ...input, revision: 4, source: { ...source, station: '新的业务站点' } }, { deviceId: 'd-one' });
    assert.equal(changed.status, 'pending'); assert.equal(changed.retryCount, 0); assert.equal(changed.aiAttempts, 0);
    assert.equal(changed.evidenceVersion, 5); assert.equal(changed.privacyFingerprint, undefined);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM recognition_attempts WHERE task_id=?').get(task.id).count, 0);
  });
});

test('privacy cleanup does not alias an obsolete fingerprint after actual shipment evidence changes', async t => {
  const f = fixture(t), shipment = f.add({ logisticsState: 'ok' }), input = report([shipment.id]);
  const task = f.workflow.submit(input, { deviceId: 'd-one' }), source = { ...task.source, pickupCode: '7-6-7042' };
  f.workflow.save({ ...task, source, sourceFingerprint: f.workflow.reportFingerprint(source, [f.store.shipment(shipment.id)]), retryCount: 3, aiAttempts: 1, status: 'resolved' });
  f.patch(shipment, { station: '新的物流证据' }); await f.restart();
  assert.equal(f.workflow.task(task.id).source.pickupCode, ''); assert.equal(f.workflow.task(task.id).privacyFingerprint, undefined);
  const changed = f.workflow.submit({ ...input, revision: 2 }, { deviceId: 'd-one' });
  assert.equal(changed.status, 'pending'); assert.equal(changed.retryCount, 0); assert.equal(changed.aiAttempts, 0);
});

test('backend normalizes old client code fields only after validating their schema', t => {
  const f = fixture(t), shipment = f.add({ logisticsState: 'ok' }), input = report([shipment.id]);
  const task = f.workflow.submit({ ...input, source: { ...input.source, pickupCode: '7-6-7042', waybillNo: 'JD99999999999' } }, { deviceId: 'd-one' });
  assert.equal(task.source.pickupCode, ''); assert.equal(task.source.waybillNo, '');
  assert.doesNotMatch(f.store.db.prepare('SELECT data FROM recognition_tasks WHERE id=?').get(task.id).data, /7042|JD99999999999/);
  for (const field of ['pickupCode', 'waybillNo']) assert.throws(() => f.workflow.submit({ ...input, revision: 2,
    source: { ...input.source, [field]: 42 } }, { deviceId: 'd-one' }), /格式无效/);
});

test('a new hard client conflict invalidates an existing AI review and restarts the retry-to-AI path', async t => {
  const f = fixture(t), shipment = f.add({ logisticsState: 'ok' });
  const initial = f.workflow.submit({ ...report([shipment.id]), reasonCodes: ['code_station_conflict'] }, { deviceId: 'd-one' });
  const reviewed = f.workflow.save({
    ...initial,
    status: 'review',
    reasonCode: 'AI_REVIEW_REQUIRED',
    retryCount: 3,
    aiAttempts: 1,
    candidateIds: ['candidate-1'],
    nextRetryAt: f.now(),
  });
  const changed = f.workflow.submit({
    ...report([shipment.id], 2),
    reasonCodes: ['code_station_conflict', 'code_mismatch'],
  }, { deviceId: 'd-one' });
  assert.equal(changed.status, 'pending');
  assert.equal(changed.retryCount, 0);
  assert.equal(changed.aiAttempts, 0);
  assert.equal(changed.evidenceVersion, reviewed.evidenceVersion + 1);
  assert.notEqual(changed.sourceFingerprint, reviewed.sourceFingerprint);
  for (const minutes of [5, 10, 15]) {
    f.advance(minutes * MINUTE);
    await f.run();
  }
  await f.run();
  assert.equal(f.analyses.length, 1);
  assert.equal(f.workflow.task(changed.id).status, 'ai_running');
});

test('two-parcel core reports reopen after partial unlink without resetting the backend retry budget', async t => {
  const f = fixture(t); f.advance(Date.now() - f.now() + 1000);
  const one = f.add({ logisticsState: 'ok', status: 'arrived', station: '合成花园店', arrivalAt: 0 }),
    two = f.add({ logisticsState: 'ok', status: 'arrived', station: '合成花园店', arrivalAt: 0 });
  let saved = '';
  const core = (action, payload = {}) => {
    const value = JSON.parse(globalThis.PickCodeCore.dispatch(saved, JSON.stringify({ action, payload })));
    saved = JSON.stringify(value.state); return value.result;
  };
  const submit = input => {
    const task = f.workflow.submit(input, { deviceId: 'd-one' });
    core('recognitionIssueAck', { accepted: [{ id: input.id, revision: input.revision }],
      issues: [{ id: input.id, revision: input.revision, status: task.status, retryCount: task.retryCount, reasonCode: task.reasonCode, nextRetryAt: task.nextRetryAt }] });
    return task;
  };
  const snapshot = f.store.snapshot([one.accountId, two.accountId]);
  core('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: 'd-one', accounts: snapshot.accounts });
  core('syncImport', { snapshot: { schemaVersion: 1, serverRevision: 1, ...snapshot, capabilities: ['recognition_workflow_v1'] } });
  const local = core('ingest', { messages: [{ id: 'two-parcels', date: f.now() - MINUTE,
    body: '【菜鸟驿站】您有2个包裹已到达合成花园店，取件码3-2-9001' }] });
  const source = local.codes.flatMap(code => code.sources).find(source => source.packageCount === 2);
  const shipmentIds = local.packages.flatMap(order => order.shipments.map(shipment => shipment.id));
  const first = core('recognitionIssueBatch').items[0];
  assert.equal(first.state, 'unresolved'); assert.equal(first.revision, 1);
  assert.deepEqual(first.candidateShipmentIds, [one.id, two.id].sort());
  const initial = submit(first);
  f.advance(5 * MINUTE); await f.run();
  const retried = f.workflow.task(initial.id);
  assert.equal(retried.retryCount, 1);
  core('linkSource', { sourceId: source.sourceId, shipmentIds, allowConflict: true });
  const matched = core('recognitionIssueBatch').items[0];
  assert.equal(matched.state, 'resolved'); assert.equal(matched.revision, 2);
  assert.deepEqual(matched.candidateShipmentIds, first.candidateShipmentIds); assert.deepEqual(matched.source, first.source);
  assert.equal(submit(matched).status, 'resolved');
  await f.restart();
  core('unlinkSource', { sourceId: source.sourceId, shipmentId: shipmentIds[0] });
  const partial = core('recognitionIssueBatch').items[0];
  assert.equal(partial.state, 'unresolved'); assert.equal(partial.revision, 3);
  assert.deepEqual(partial.candidateShipmentIds, first.candidateShipmentIds); assert.deepEqual(partial.source, first.source);
  const resumed = submit(partial);
  assert.equal(resumed.status, 'pending'); assert.equal(resumed.reportState, 'unresolved');
  for (const key of ['retryCount', 'aiAttempts', 'evidenceVersion', 'sourceFingerprint', 'candidateIds']) assert.deepEqual(resumed[key], retried[key], key);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM recognition_attempts WHERE task_id=?').get(initial.id).count, 1);
  assert.equal(core('snapshot').online.recognitionIssues[0].status, 'pending');
  f.advance(5 * MINUTE); await f.run();
  assert.equal(f.workflow.task(initial.id).retryCount, 2, 'the same task resumes its next real collection round');
});

test('only a previous client resolved or withdrawn state reopens equal evidence, including legacy rows', async t => {
  for (const legacy of [false, true]) for (const retryCount of [1, 3]) await t.test(`${legacy ? 'legacy' : 'current'} retry ${retryCount}`, t => {
    const f = fixture(t), shipment = f.add({ logisticsState: 'ok' }), input = report([shipment.id]);
    const initial = f.workflow.submit(input, { deviceId: 'd-one' });
    const resolved = f.workflow.submit({ ...input, revision: 2, state: 'resolved' }, { deviceId: 'd-one' });
    const saved = { ...resolved, retryCount, aiAttempts: 1, candidateIds: ['prior-review'] };
    if (legacy) delete saved.reportState;
    f.workflow.save(saved);
    const resumed = f.workflow.submit({ ...input, revision: 3 }, { deviceId: 'd-one' });
    assert.equal(resumed.status, retryCount === 3 ? 'review' : 'pending');
    assert.equal(resumed.retryCount, retryCount); assert.equal(resumed.aiAttempts, 1); assert.deepEqual(resumed.candidateIds, ['prior-review']);
    assert.equal(resumed.evidenceVersion, initial.evidenceVersion); assert.equal(resumed.sourceFingerprint, initial.sourceFingerprint);
    assert.equal(resumed.reportState, 'unresolved');
    const deterministic = f.workflow.save({ ...resumed, status: 'resolved', reasonCode: 'DETERMINISTIC_MATCH' });
    const repeated = f.workflow.submit({ ...input, revision: 4 }, { deviceId: 'd-one' });
    assert.equal(repeated.status, 'resolved'); assert.equal(repeated.nextRetryAt, deterministic.nextRetryAt);
    assert.equal(repeated.retryCount, retryCount); assert.equal(repeated.aiAttempts, 1);
  });
});

test('methods distinguish platform and target; missing evidence never becomes a guessed timestamp', () => {
  assert.notEqual(recognitionMethod('jd', 'event_time').methodId, recognitionMethod('taobao', 'event_time').methodId);
  assert.deepEqual(recognitionProblems({ status: 'arrived', logisticsState: 'error', logisticsEvents: [{ time: 0, timeText: '今天', description: '已到驿站' }] }, NOW).map(p => p.target),
    ['logistics_detail', 'event_time', 'arrival_time']);
  const known = { status: 'arrived', logisticsState: 'ok', arrivalAt: NOW - 1, arrivalAtSource: 'platform_event', arrivalAtPrecision: 'second', logisticsEvents: [] };
  assert.deepEqual(recognitionProblems(known, NOW), []);
});

test('daily local scan discovers issues with AI disabled; summaries and repeated observations do not spend retries', async t => {
  const f = fixture(t, { analyze: () => ({ status: 'disabled' }) }), shipment = f.add({}, 'pdd');
  await f.workflow.daily();
  const task = f.workflow.tasks()[0];
  assert.equal(task.platform, 'pdd'); assert.equal(task.initialFailures, 1); assert.equal(task.retryCount, 0);
  for (let i = 0; i < 5; i++) { f.workflow.summary(); f.workflow.observe({ shipments: [shipment] }); await f.run(); }
  assert.equal(f.workflow.tasks().length, 1); assert.equal(f.requests.length, 0); assert.equal(f.analyses.length, 0);
  const before = JSON.stringify(f.workflow.tasks()); f.workflow.summary(); assert.equal(JSON.stringify(f.workflow.tasks()), before);
  assert.equal(f.workflow.dailyRun().status, 'complete'); assert.equal(f.workflow.summary().groups[0].methodVersion, 1);
});

test('review excludes historical shipment aliases while preserving the canonical shipment scope', async t => {
  for (const picked of [false, true]) await t.test(`canonical picked=${picked}`, async t => {
    const f = fixture(t), shipment = f.add({}, 'pdd'), legacy = { ...shipment, id: 'legacy-pdd-shipment' };
    f.store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(legacy.id, legacy.accountId, JSON.stringify(legacy));
    f.store.saveShipmentAlias(legacy.id, shipment.id, { reason: 'confirmed', evidence: 'same platform package' });
    f.patch(shipment, { picked });
    const api = createRecognitionApi({ store: f.store, workflow: f.workflow, now: f.now,
      recognitionAi: { reviews: () => [] }, stations: { aiConfig: () => ({ enabled: false }), revision: 1 },
      logisticsRules: { read: () => ({ revision: 1 }) }, logisticsDaily: { summary: () => ({}) } });
    assert.deepEqual(api.review().samples.map(sample => sample.shipmentId), picked ? [] : [shipment.id]);
    await f.workflow.daily();
    assert.deepEqual(f.workflow.tasks().map(task => task.shipmentId), picked ? [] : [shipment.id]);
    assert.equal(f.store.shipment(legacy.id).picked, false, 'the historical source remains unchanged');
  });
});

test('historical shipment aliases stop retries and AI work without changing canonical task progress', async t => {
  for (const status of ['pending', 'ai_pending', 'review']) for (const picked of [false, true]) await t.test(`${status}, canonical picked=${picked}`, async t => {
    const f = fixture(t, { analyze: () => ({ status: 'disabled', reasonCode: 'AI_LOGISTICS_DISABLED' }) });
    const shipment = f.add({}, 'pdd'), legacy = { ...shipment, id: 'legacy-pdd-shipment' };
    f.store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(legacy.id, legacy.accountId, JSON.stringify(legacy));
    f.workflow.observe({ shipments: [legacy, shipment] });
    const original = f.workflow.tasks().find(task => task.shipmentId === legacy.id);
    const task = f.workflow.save({ ...original, status, retryCount: status === 'pending' ? 0 : 3,
      aiAttempts: status === 'review' ? 1 : 0, reasonCode: status === 'ai_pending' ? 'AI_LOGISTICS_DISABLED' : original.reasonCode });
    f.store.saveShipmentAlias(legacy.id, shipment.id, { reason: 'confirmed', evidence: 'same platform package' });
    f.patch(shipment, { picked });
    f.advance(5 * MINUTE); await f.run();
    const current = f.workflow.task(task.id), canonical = f.workflow.tasks().find(task => task.shipmentId === shipment.id);
    assert.equal(current.status, 'ignored'); assert.equal(current.reasonCode, 'SOURCE_INACTIVE'); assert.equal(current.nextRetryAt, 0);
    assert.equal(current.retryCount, task.retryCount); assert.equal(current.aiAttempts, task.aiAttempts);
    assert.equal(f.workflow.allowAutomatic(legacy), false); assert.equal(f.analyses.length, 0);
    assert.equal(canonical.status, picked ? 'ignored' : 'pending'); assert.equal(canonical.retryCount, picked ? 0 : 1);
    assert.equal(f.requests.length, picked ? 0 : 1);
    assert.equal(f.workflow.tasks().length, 2, 'daily observation does not reopen or duplicate the alias task');
    assert.equal(f.store.shipment(legacy.id).picked, false, 'closing recognition does not rewrite historical shipment data');
  });
});

test('initial failure plus three completed collection retries use five, ten and fifteen minute gaps and survive restart', async t => {
  const f = fixture(t); f.workflow.observe({ shipments: [f.add()] });
  f.advance(5 * MINUTE - 1); await f.run(); assert.equal(f.requests.length, 0);
  f.advance(1); await f.run(); assert.equal(f.workflow.tasks()[0].retryCount, 1);
  assert.equal(f.workflow.tasks()[0].nextRetryAt, f.now() + 10 * MINUTE);
  await f.restart(); await f.run(); assert.equal(f.requests.length, 1);
  f.advance(10 * MINUTE); await f.run(); assert.equal(f.workflow.tasks()[0].retryCount, 2);
  f.advance(15 * MINUTE); await f.run(); assert.equal(f.workflow.tasks()[0].retryCount, 3);
  assert.equal(f.analyses.length, 0); await f.run(); assert.equal(f.analyses.length, 1);
  assert.equal(f.workflow.tasks()[0].status, 'ai_running');
  await f.run(); assert.equal(f.analyses.length, 1); assert.equal(f.requests.length, 3);
});

test('completed job identities are counted once and multiple problems on one order share the same retry', async t => {
  let first;
  const f = fixture(t, { request: job => { first ||= job; return { job: first, done: Promise.resolve(first) }; } });
  f.workflow.observe({ shipments: [f.add({ status: 'arrived', arrivalAt: 0 })] });
  f.advance(5 * MINUTE); await f.run();
  assert.equal(f.requests.length, 1); assert.ok(f.workflow.tasks().every(task => task.retryCount === 1));
  f.advance(10 * MINUTE); await f.run();
  assert.ok(f.workflow.tasks().every(task => task.retryCount === 1)); assert.equal(f.analyses.length, 0);
});

test('cooldown, expired and disabled accounts do not consume attempts; received parcels leave the workflow', async t => {
  const f = fixture(t, { request: job => ({ job: { ...job, state: 'cooldown', startedAt: 0, retryAt: f.now() + 15 * MINUTE },
    done: Promise.resolve({ ...job, state: 'cooldown', startedAt: 0, retryAt: f.now() + 15 * MINUTE }) }) });
  const shipment = f.add(); f.workflow.observe({ shipments: [shipment] }); f.advance(5 * MINUTE); await f.run();
  assert.equal(f.workflow.tasks()[0].retryCount, 0); assert.equal(f.workflow.tasks()[0].nextRetryAt, f.now() + 15 * MINUTE);
  f.store.updateAccount(shipment.accountId, { status: 'expired' }); f.advance(15 * MINUTE); await f.run();
  assert.equal(f.workflow.tasks()[0].status, 'blocked'); assert.equal(f.requests.length, 1);
  f.store.updateAccount(shipment.accountId, { status: 'ok', enabled: false }); await f.run(); assert.equal(f.requests.length, 1);
  f.store.updateAccount(shipment.accountId, { enabled: true }); f.patch(shipment, { picked: true }); await f.run();
  assert.equal(f.workflow.tasks()[0].status, 'ignored'); assert.equal(f.analyses.length, 0);
});

test('only deterministic source reevaluation resolves a backend issue, never an AI success label', async t => {
  const f = fixture(t, { analyze: () => ({ status: 'resolved', reasonCode: 'MODEL_SAYS_DONE' }) }), shipment = f.add();
  f.workflow.observe({ shipments: [shipment] });
  for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); } await f.run();
  assert.equal(f.workflow.tasks()[0].status, 'review'); assert.equal(f.workflow.allowAutomatic(shipment), true);
  f.patch(shipment, { logisticsState: 'ok' }); f.workflow.observe({ shipments: [shipment] });
  assert.equal(f.workflow.tasks()[0].status, 'resolved');
});

test('client reports are device scoped and revision idempotent; resolution cannot clear another device or a server issue', async t => {
  const f = fixture(t), shipment = f.add(); f.workflow.observe({ shipments: [shipment] });
  const client = f.workflow.submit(report([shipment.id]), { deviceId: 'd-one' });
  assert.equal(client.clientId, 'client-report'); assert.equal(client.source.occurredAt, null);
  const other = f.workflow.submit(report([shipment.id]), { deviceId: 'd-two' }); assert.notEqual(client.id, other.id);
  f.workflow.submit(report([shipment.id], 2, 'resolved'), { deviceId: 'd-one' });
  f.workflow.submit(report([shipment.id], 1), { deviceId: 'd-one' });
  assert.equal(f.workflow.task(client.id).status, 'resolved'); assert.equal(f.workflow.task(other.id).status, 'pending');
  assert.equal(f.workflow.tasks().find(task => !task.clientId).status, 'pending');
  assert.throws(() => f.workflow.submit(report([shipment.id], 2, 'resolved'), { deviceId: 'd-unknown' }), /未找到/);
  f.patch(shipment, { logisticsState: 'ok' }); f.workflow.observe({ shipments: [shipment] });
  assert.equal(f.workflow.task(other.id).status, 'pending', 'successful server data does not prove client matching');
  assert.ok(f.workflow.summary({ accountIds: [shipment.accountId], deviceId: 'd-one' }).tasks.every(task => !task.deviceId || task.deviceId === 'd-one'));
});

test('several report candidates require one complete retry round and never cause automatic linking', async t => {
  const f = fixture(t), one = f.add({ logisticsState: 'ok' }), two = f.add({ logisticsState: 'ok' }, 'jd');
  const task = f.workflow.submit(report([one.id, two.id]), { deviceId: 'd-one' });
  f.advance(5 * MINUTE); await f.run();
  assert.equal(f.requests.length, 2); assert.equal(f.workflow.task(task.id).retryCount, 1);
  assert.equal(f.workflow.task(task.id).status, 'pending'); assert.equal(f.analyses.length, 0);
  assert.equal(f.workflow.summary({ accountIds: [one.accountId] }).tasks.length, 0, 'all candidate accounts must be authorized');
});

test('an exhausted report waits for every candidate account and resumes its AI gate without spending an attempt while blocked', async t => {
  const f = fixture(t), one = f.add({ logisticsState: 'ok' }), two = f.add({ logisticsState: 'ok' });
  const task = f.workflow.submit(report([one.id, two.id]), { deviceId: 'd-one' });
  for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); }
  assert.equal(f.workflow.task(task.id).status, 'ai_pending'); assert.equal(f.requests.length, 6);
  f.store.updateAccount(two.accountId, { enabled: false }); await f.run();
  let current = f.workflow.task(task.id);
  assert.equal(current.status, 'blocked'); assert.equal(current.resumeStatus, 'ai_pending'); assert.equal(current.reasonCode, 'ACCOUNT_UNAVAILABLE');
  assert.equal(current.retryCount, 3); assert.equal(current.aiAttempts, 0); assert.equal(f.analyses.length, 0);
  await f.run(); assert.equal(f.workflow.task(task.id).resumeStatus, 'ai_pending');
  f.store.updateAccount(two.accountId, { enabled: true }); await f.run();
  current = f.workflow.task(task.id);
  assert.equal(current.status, 'ai_running'); assert.equal(current.retryCount, 3); assert.equal(current.aiAttempts, 1);
  assert.equal(f.analyses.length, 1); assert.equal(f.requests.length, 6);
});

test('a candidate account becoming unavailable during collection blocks the whole round before it is counted', async t => {
  const finishes = [];
  const f = fixture(t, { request: job => ({ job, done: new Promise(resolve => { finishes.push(() => resolve(job)); }) }) });
  const one = f.add({ logisticsState: 'ok' }), two = f.add({ logisticsState: 'ok' });
  const task = f.workflow.submit(report([one.id, two.id]), { deviceId: 'd-one' });
  f.advance(5 * MINUTE); f.workflow.runDue(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(finishes.length, 2); f.store.updateAccount(two.accountId, { enabled: false });
  finishes.forEach(finish => finish()); await f.workflow.running;
  const current = f.workflow.task(task.id);
  assert.equal(current.status, 'blocked'); assert.equal(current.resumeStatus, 'retrying'); assert.equal(current.reasonCode, 'ACCOUNT_UNAVAILABLE');
  assert.equal(current.retryCount, 0); assert.equal(f.analyses.length, 0);
});

test('restart reuses a persisted completed job and does not perform another collection', async t => {
  const f = fixture(t), shipment = f.add(); f.workflow.observe({ shipments: [shipment] });
  const task = f.workflow.tasks()[0], job = { id: 'persisted-job', accountId: shipment.accountId, orderId: shipment.orderId, state: 'completed', startedAt: NOW, finishedAt: NOW };
  f.store.db.exec('CREATE TABLE sync_job_summaries(data TEXT NOT NULL)');
  f.store.db.prepare('INSERT INTO sync_job_summaries VALUES(?)').run(JSON.stringify(job));
  f.workflow.save({ ...task, status: 'retrying', nextRetryAt: 0, pendingJobs: [job] });
  await f.restart(); await f.run();
  assert.equal(f.requests.length, 0); assert.equal(f.workflow.tasks()[0].retryCount, 1);
});

test('local daily scan excludes historical parcels and keeps only bounded closed history', async t => {
  const f = fixture(t), shipment = f.add(); f.workflow.observe({ shipments: [shipment] });
  f.advance(32 * DAY); await f.workflow.daily();
  assert.equal(f.workflow.tasks()[0].status, 'ignored'); assert.equal(f.requests.length, 0);
  for (let i = 0; i < 510; i++) f.workflow.save({ ...f.workflow.tasks()[0], id: `closed-${i}` });
  f.workflow.prune(); assert.equal(f.workflow.tasks().length, 500);
});

test('a completed retry with updated but still invalid evidence counts once; a revoked account and shutdown reject late work', async t => {
  let finish;
  const f = fixture(t, { request: job => ({ job, done: new Promise(resolve => { finish = () => resolve(job); }) }) });
  const shipment = f.add(); f.workflow.observe({ shipments: [shipment] }); f.advance(5 * MINUTE);
  f.workflow.runDue(); await new Promise(resolve => setImmediate(resolve));
  f.patch(shipment, { logisticsState: 'empty' }); f.workflow.observe({ shipments: [shipment] }); finish(); await f.workflow.running;
  assert.equal(f.workflow.tasks()[0].retryCount, 1);
  f.advance(10 * MINUTE); f.workflow.runDue(); await new Promise(resolve => setImmediate(resolve));
  f.store.updateAccount(shipment.accountId, { enabled: false }); finish(); await f.workflow.running;
  assert.equal(f.workflow.tasks()[0].retryCount, 1); assert.equal(f.workflow.tasks()[0].status, 'blocked');
  f.store.updateAccount(shipment.accountId, { enabled: true }); f.workflow.runDue(); await new Promise(resolve => setImmediate(resolve));
  const running = f.workflow.running; await f.workflow.close(); const before = JSON.stringify(f.workflow.tasks()); finish(); await running;
  assert.equal(JSON.stringify(f.workflow.tasks()), before); assert.equal(f.analyses.length, 0);
});

test('a report changed during collection does not spend a retry on its replacement evidence', async t => {
  let finish;
  const f = fixture(t, { request: job => ({ job, done: new Promise(resolve => { finish = () => resolve(job); }) }) });
  const shipment = f.add({ logisticsState: 'ok' }), first = report([shipment.id]);
  const task = f.workflow.submit(first, { deviceId: 'd-one' }); f.advance(5 * MINUTE); f.workflow.runDue(); await new Promise(resolve => setImmediate(resolve));
  f.workflow.submit({ ...first, revision: 2, source: { ...first.source, station: '更正站点' } }, { deviceId: 'd-one' }); finish(); await f.workflow.running;
  assert.equal(f.workflow.task(task.id).retryCount, 0); assert.equal(f.workflow.task(task.id).reasonCode, 'SOURCE_CHANGED');
});

test('a daily scan resumes its saved cursor after shutdown and catches up across the three oclock boundary', async t => {
  const f = fixture(t), seed = f.add({ logisticsState: 'ok' });
  f.store.transaction(() => {
    for (let i = 0; i < 210; i++) f.store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(`scan-${i}`, seed.accountId, JSON.stringify({ ...seed, id: `scan-${i}` }));
  });
  const scan = f.workflow.daily(); await f.workflow.close(); await scan;
  const partial = f.workflow.dailyRun(); assert.equal(partial.status, 'scanning'); assert.equal(partial.scanned, 100);
  await f.restart(); f.advance(DAY); await f.workflow.daily();
  assert.equal(f.workflow.dailyRun().status, 'complete'); assert.equal(f.workflow.dailyRun().scanned, 211);
  assert.equal(f.workflow.dailyRun().day, '2026-11-10');
  await f.workflow.daily(); assert.equal(f.workflow.dailyRun().day, '2026-11-11');
  assert.equal(f.requests.length, 0); assert.equal(f.analyses.length, 0);
});

test('daily local failures back off and retry saved progress without a hot timer loop', async t => {
  const f = fixture(t); f.add();
  const observe = f.workflow.observe.bind(f.workflow); let calls = 0;
  f.workflow.observe = input => { if (++calls === 1) throw new Error('synthetic local failure'); return observe(input); };
  await f.workflow.daily(); assert.equal(f.workflow.dailyRun().errorCode, 'SCAN_RETRY_REQUIRED');
  assert.equal(f.workflow.nextDailyAt(), f.now() + MINUTE);
  await f.workflow.daily(); assert.equal(calls, 1);
  f.advance(MINUTE); await f.workflow.daily(); assert.equal(calls, 2); assert.equal(f.workflow.dailyRun().status, 'complete');
});

test('revoked device authorization stops a report before collection without using a retry', async t => {
  let authorized = true;
  const f = fixture(t, { authorizeReport: task => task.deviceId === 'd-one' && authorized });
  const shipment = f.add({ logisticsState: 'ok' }), task = f.workflow.submit(report([shipment.id]), { deviceId: 'd-one' });
  authorized = false; f.advance(5 * MINUTE); await f.run();
  assert.equal(f.requests.length, 0); assert.equal(f.analyses.length, 0); assert.equal(f.workflow.task(task.id).retryCount, 0);
  assert.equal(f.workflow.task(task.id).status, 'ignored'); assert.equal(f.workflow.task(task.id).reasonCode, 'AUTHORIZATION_CHANGED');
});

test('changed family ownership blocks exhausted reports and cached AI gates although the account id stays unchanged', async t => {
  let permittedFamily = 'family-a';
  const f = fixture(t, { authorizeReport: task => task.candidateShipmentIds.every(id => f.store.shipment(id).familyId === permittedFamily) });
  const shipment = f.add({ logisticsState: 'ok', familyId: 'family-a' }), task = f.workflow.submit(report([shipment.id]), { deviceId: 'd-one' });
  for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); }
  assert.equal(f.workflow.allowAutomatic(shipment, 'station_match'), true);
  f.patch(shipment, { familyId: 'family-b' });
  assert.equal(f.workflow.allowAutomatic(shipment, 'station_match'), false);
  await f.run(); assert.equal(f.analyses.length, 0); assert.equal(f.workflow.task(task.id).status, 'ignored');
  assert.equal(f.workflow.task(task.id).reasonCode, 'AUTHORIZATION_CHANGED');
});

test('report limits reject oversized fields, malformed reasons and invalid observed times while keeping accepted metadata', t => {
  const f = fixture(t), shipment = f.add({ logisticsState: 'ok' }), base = report([shipment.id]);
  for (const [field, length] of [['station', 120], ['fragment', 120], ['carrier', 40], ['waybillNo', 32], ['pickupCode', 12]]) {
    assert.throws(() => f.workflow.submit({ ...base, source: { ...base.source, [field]: 'x'.repeat(length + 1) } }, { deviceId: 'd-one' }), /格式无效/);
  }
  for (const patch of [{ id: 'x'.repeat(129) }, { sourceId: 'x'.repeat(129) }, { observedAt: 0 }, { observedAt: NOW + 5 * MINUTE + 1 },
    { observedAt: 1.1 }, { reasonCodes: Array(21).fill('reason') }, { reasonCodes: ['<script>'] }, { reasonCodes: [{}] }]) {
    assert.throws(() => f.workflow.submit({ ...base, ...patch }, { deviceId: 'd-one' }), /格式无效/);
  }
  const task = f.workflow.submit(base, { deviceId: 'd-one' });
  assert.equal(task.observedAt, NOW); assert.deepEqual(task.reasonCodes, ['station_mismatch']);
});

test('reports accept twenty scoped candidates and normalize legacy zero source time to null', t => {
  const f = fixture(t), ids = Array.from({ length: 20 }, () => f.add({ logisticsState: 'ok' }).id), input = report(ids);
  input.source.occurredAt = 0;
  const task = f.workflow.submit(input, { deviceId: 'd-one' });
  assert.equal(task.candidateShipmentIds.length, 20); assert.equal(task.source.occurredAt, null);
  assert.throws(() => f.workflow.submit({ ...input, id: 'overflow', candidateShipmentIds: [...ids, 'another'] }, { deviceId: 'd-one' }), /候选包裹格式无效/);
});

test('changed client evidence starts three fresh retries while revision and candidate ordering alone retain review progress', async t => {
  const f = fixture(t, { analyze: () => ({ status: 'review', candidateIds: ['old-suggestion'] }) });
  const one = f.add({ logisticsState: 'ok' }), two = f.add({ logisticsState: 'ok' }), first = report([one.id, two.id]);
  const task = f.workflow.submit(first, { deviceId: 'd-one' });
  for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); } await f.run();
  const before = f.workflow.task(task.id); assert.equal(before.status, 'review'); assert.equal(before.aiAttempts, 1);
  f.workflow.submit({ ...first, revision: 2, observedAt: f.now(), candidateShipmentIds: [...first.candidateShipmentIds].reverse() }, { deviceId: 'd-one' });
  let current = f.workflow.task(task.id); assert.equal(current.retryCount, 3); assert.equal(current.aiAttempts, 1); assert.equal(current.status, 'review');
  f.workflow.submit({ ...first, revision: 3, source: { ...first.source, station: '新证据站点' } }, { deviceId: 'd-one' });
  current = f.workflow.task(task.id);
  assert.equal(current.status, 'pending'); assert.equal(current.retryCount, 0); assert.equal(current.aiAttempts, 0);
  assert.equal(current.nextRetryAt, f.now() + 5 * MINUTE); assert.equal(current.lastJobId, '');
  assert.deepEqual([current.lastJobIds, current.pendingJobs, current.candidateIds], [[], [], []]);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM recognition_attempts WHERE task_id=?').get(task.id).count, 0);
  await f.restart(); await f.run(); assert.equal(f.analyses.length, 1);
  f.advance(5 * MINUTE); await f.run(); assert.equal(f.workflow.task(task.id).retryCount, 1); assert.equal(f.analyses.length, 1);
});

test('candidate changes reset an exhausted report and late AI cannot move fresh evidence past its retry gate', async t => {
  let finish;
  const f = fixture(t, { analyze: () => new Promise(resolve => { finish = () => resolve({ status: 'review', candidateIds: ['stale-suggestion'] }); }) });
  const one = f.add({ logisticsState: 'ok' }), two = f.add({ logisticsState: 'ok' }), first = report([one.id]);
  const task = f.workflow.submit(first, { deviceId: 'd-one' });
  for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); }
  f.workflow.runDue(); await new Promise(resolve => setImmediate(resolve));
  f.workflow.submit({ ...first, revision: 2, candidateShipmentIds: [two.id] }, { deviceId: 'd-one' });
  const fresh = f.workflow.task(task.id); f.advance(6 * MINUTE); finish(); await f.workflow.running;
  const current = f.workflow.task(task.id); assert.equal(current.status, 'pending'); assert.equal(current.retryCount, 0); assert.equal(current.aiAttempts, 0);
  assert.equal(current.nextRetryAt, fresh.nextRetryAt); assert.deepEqual(current.candidateIds, []);
  await f.run(); assert.equal(f.workflow.task(task.id).retryCount, 1); assert.equal(f.analyses.length, 1);
});

test('updated business evidence for the same candidate restarts a report while collection timestamps alone retain its progress', async t => {
  const f = fixture(t, { analyze: () => ({ status: 'review' }) }), shipment = f.add({ logisticsState: 'ok', station: '' });
  const first = report([shipment.id]), task = f.workflow.submit(first, { deviceId: 'd-one' });
  for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); } await f.run();
  f.patch(shipment, { logisticsCheckedAt: f.now(), checkedAt: f.now() });
  f.workflow.submit({ ...first, revision: 2, observedAt: f.now() }, { deviceId: 'd-one' });
  let current = f.workflow.task(task.id);
  assert.equal(current.status, 'review'); assert.equal(current.retryCount, 3); assert.equal(current.aiAttempts, 1);
  f.patch(shipment, { station: '补全后的合成站点' });
  f.workflow.submit({ ...first, revision: 3, observedAt: f.now() }, { deviceId: 'd-one' });
  current = f.workflow.task(task.id);
  assert.equal(current.status, 'pending'); assert.equal(current.retryCount, 0); assert.equal(current.aiAttempts, 0);
  assert.equal(current.reasonCode, 'SOURCE_CHANGED'); assert.equal(current.evidenceVersion, 2); assert.equal(current.nextRetryAt, f.now() + 5 * MINUTE);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM recognition_attempts WHERE task_id=?').get(task.id).count, 0);
  await f.run(); assert.equal(f.analyses.length, 1);
});

test('changing client evidence away and back cannot reuse a completed request from its earlier generation', async t => {
  let finish;
  const f = fixture(t, { request: job => ({ job, done: new Promise(resolve => { finish = () => resolve(job); }) }) });
  const shipment = f.add({ logisticsState: 'ok' }), first = report([shipment.id]), task = f.workflow.submit(first, { deviceId: 'd-one' });
  f.advance(5 * MINUTE); f.workflow.runDue(); await new Promise(resolve => setImmediate(resolve));
  f.workflow.submit({ ...first, revision: 2, source: { ...first.source, station: '中途新站点' } }, { deviceId: 'd-one' });
  f.workflow.submit({ ...first, revision: 3 }, { deviceId: 'd-one' });
  finish(); await f.workflow.running;
  assert.equal(f.workflow.task(task.id).retryCount, 0); assert.equal(f.workflow.task(task.id).evidenceVersion, 3);
});

test('reviewed backend problems restart only for meaningful evidence and ignore collection check timestamps', async t => {
  const f = fixture(t, { analyze: () => ({ status: 'review' }) });
  const event = { time: 0, timeText: '今天', timePrecision: 'unknown', description: '运输中' };
  const shipment = f.add({ logisticsState: 'ok', logisticsEvents: [event] }); f.workflow.observe({ shipments: [shipment] });
  for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); } await f.run();
  const task = f.workflow.tasks()[0]; assert.equal(task.status, 'review');
  f.patch(shipment, { logisticsCheckedAt: f.now(), logisticsEvents: [{ ...event, checkedAt: f.now() }] }); f.workflow.observe({ shipments: [shipment] });
  assert.equal(f.workflow.task(task.id).status, 'review'); assert.equal(f.workflow.task(task.id).retryCount, 3);
  f.patch(shipment, { logisticsEvents: [{ ...event, description: '新的运输节点' }] }); f.workflow.observe({ shipments: [shipment] });
  assert.equal(f.workflow.task(task.id).status, 'pending'); assert.equal(f.workflow.task(task.id).retryCount, 0); assert.equal(f.workflow.task(task.id).aiAttempts, 0);
});

test('queued AI outcomes refresh into review without counting another analysis or falsely resolving the original problem', async t => {
  let outcome = { status: 'queued' }, refreshes = 0;
  const f = fixture(t, { refreshAnalysis: () => { refreshes++; return outcome; } });
  const shipment = f.add(); f.workflow.observe({ shipments: [shipment] });
  for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); } await f.run();
  const task = f.workflow.tasks()[0]; assert.equal(task.status, 'ai_running');
  await f.run(); assert.equal(f.workflow.task(task.id).status, 'ai_running');
  outcome = { status: 'review', reasonCode: 'LOGISTICS_RULE_REVIEW', candidateIds: ['review-candidate'] }; await f.run();
  assert.ok(refreshes >= 2); assert.equal(f.workflow.task(task.id).status, 'review'); assert.equal(f.workflow.task(task.id).aiAttempts, 1);
  assert.deepEqual(f.workflow.task(task.id).candidateIds, ['review-candidate']);
  f.patch(shipment, { logisticsState: 'ok' }); f.workflow.observe({ shipments: [shipment] }); assert.equal(f.workflow.task(task.id).status, 'resolved');
});

test('safe uncovered arrival actions enter retry workflow without setting arrival state or inventing a time', async t => {
  const f = fixture(t), description = '已交付给合成幸福菜鸟驿站';
  const shipment = f.add({ status: 'transit', logisticsState: 'ok', arrivalAt: 0, logisticsEvents: [{ time: NOW - 1000, timePrecision: 'second', description }] });
  f.workflow.observe({ shipments: [shipment] }); await f.workflow.daily();
  assert.equal(f.workflow.tasks().length, 1); assert.equal(f.workflow.tasks()[0].target, 'arrival_time');
  assert.equal(f.workflow.tasks()[0].retryCount, 0); assert.equal(f.workflow.allowAutomatic(shipment), false);
  assert.equal(f.store.shipment(shipment.id).status, 'transit'); assert.equal(f.store.shipment(shipment.id).arrivalAt, 0);
  assert.equal(f.requests.length, 0); assert.equal(f.analyses.length, 0);
});

test('future, unrealized and transit hubs do not create arrival tasks through the uncovered-action probe', () => {
  for (const description of ['预计已交付给合成幸福菜鸟驿站', '未能已交付给合成幸福菜鸟驿站', '已交付给杭州转运中心', '已交付给杭州分拣中心，下一站合成幸福菜鸟驿站']) {
    const problems = recognitionProblems({ status: 'transit', logisticsState: 'ok', arrivalAt: 0,
      logisticsEvents: [{ time: NOW - 1000, timePrecision: 'second', description }] }, NOW);
    assert.equal(problems.some(problem => problem.target === 'arrival_time'), false, description);
  }
});

test('withdrawals are device scoped and stay ignored after a late collection response', async t => {
  let finish;
  const f = fixture(t, { request: job => ({ job, done: new Promise(resolve => { finish = () => resolve(job); }) }) });
  const shipment = f.add({ logisticsState: 'ok' }), first = report([shipment.id]), task = f.workflow.submit(first, { deviceId: 'd-one' });
  const withdrawn = { id: first.id, sourceId: first.sourceId, kind: first.kind, revision: 2, state: 'withdrawn', observedAt: NOW, reasonCodes: [] };
  const other = f.workflow.submit(withdrawn, { deviceId: 'd-two' });
  assert.notEqual(other.id, task.id); assert.equal(other.status, 'ignored'); assert.equal(f.workflow.task(task.id).status, 'pending');
  f.advance(5 * MINUTE); f.workflow.runDue(); await new Promise(resolve => setImmediate(resolve));
  f.patch(shipment, { picked: true });
  f.workflow.submit(withdrawn, { deviceId: 'd-one' });
  f.workflow.submit(withdrawn, { deviceId: 'd-one' });
  f.workflow.submit(first, { deviceId: 'd-one' });
  finish(); await f.workflow.running;
  const current = f.workflow.task(task.id);
  assert.equal(current.status, 'ignored'); assert.equal(current.reasonCode, 'SOURCE_WITHDRAWN');
  assert.equal(current.retryCount, 0); assert.equal(current.nextRetryAt, 0); assert.equal(f.analyses.length, 0);
});

test('a withdrawal received before the original report leaves a tombstone until newer valid evidence arrives', async t => {
  const f = fixture(t), shipment = f.add({ logisticsState: 'ok' }), first = report([shipment.id]);
  const withdrawn = { id: first.id, sourceId: first.sourceId, kind: first.kind, revision: 2, state: 'withdrawn', observedAt: NOW, reasonCodes: [] };
  const tombstone = f.workflow.submit(withdrawn, { deviceId: 'd-one' });
  assert.equal(tombstone.status, 'ignored'); assert.equal(tombstone.reasonCode, 'SOURCE_WITHDRAWN'); assert.equal(tombstone.nextRetryAt, 0);
  assert.equal(tombstone.platform, 'other'); assert.equal(tombstone.target, 'station_match'); assert.equal(tombstone.contentKind, 'pickup_match');
  assert.deepEqual(tombstone.candidateShipmentIds, []);
  const group = f.workflow.summary({ accountIds: [shipment.accountId], deviceId: 'd-one' }).groups[0];
  assert.equal(group.retryCount, 0); assert.equal(group.aiAttempts, 0); assert.equal(group.states.ignored, 1);
  f.workflow.submit(first, { deviceId: 'd-one' }); await f.run();
  assert.equal(f.workflow.task(tombstone.id).status, 'ignored'); assert.equal(f.requests.length, 0); assert.equal(f.analyses.length, 0);
  const newer = f.workflow.submit({ ...first, revision: 3 }, { deviceId: 'd-one' });
  assert.equal(newer.id, tombstone.id); assert.equal(newer.status, 'pending'); assert.equal(newer.retryCount, 0);
  assert.equal(newer.nextRetryAt, f.now() + 5 * MINUTE); assert.deepEqual(newer.candidateShipmentIds, [shipment.id]);
});

test('withdrawing an in-flight AI report cannot become resolved or return to review on a late reply', async t => {
  let finish;
  const f = fixture(t, { analyze: () => new Promise(resolve => { finish = () => resolve({ status: 'review', candidateIds: ['late'] }); }) });
  const shipment = f.add({ logisticsState: 'ok' }), first = report([shipment.id]), task = f.workflow.submit(first, { deviceId: 'd-one' });
  for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); }
  f.workflow.runDue(); await new Promise(resolve => setImmediate(resolve));
  f.workflow.submit({ ...first, revision: 2, state: 'withdrawn' }, { deviceId: 'd-one' }); finish(); await f.workflow.running;
  assert.equal(f.workflow.task(task.id).status, 'ignored'); assert.equal(f.workflow.task(task.id).reasonCode, 'SOURCE_WITHDRAWN');
  assert.equal(f.workflow.task(task.id).nextRetryAt, 0); assert.deepEqual(f.workflow.task(task.id).candidateIds, []);
});
