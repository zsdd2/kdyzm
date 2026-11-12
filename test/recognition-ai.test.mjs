import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { StationStore } from '../src/stations.mjs';
import { LogisticsRuleStore } from '../src/logistics-rule-store.mjs';
import { LogisticsAiJobs } from '../src/logistics-ai.mjs';
import { LogisticsDailyLearning } from '../src/logistics-daily-learning.mjs';
import { StationAiJobs, STATION_SYSTEM } from '../src/station-ai.mjs';
import { validateStationSuggestion } from '../src/station-text.mjs';
import { AiAssistance } from '../src/ai-assistance.mjs';
import { RecognitionWorkflow } from '../src/recognition-workflow.mjs';
import { RecognitionAi, validateRecognitionSuggestion } from '../src/recognition-ai.mjs';

const NOW = Date.parse('2026-11-10T10:00:00+08:00'), STATION = '合成幸福菜鸟驿站', FRAGMENT = `已交付给${STATION}`;
const reply = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const ruleSuggestion = () => ({ kind: 'arrival', starts: ['已交付给'], ends: [], keywords: [STATION], expectedStation: STATION, evidence: [FRAGMENT] });
const timeSuggestion = input => ({ version: 1, target: input.target, action: 'review_time_format', reasonCode: 'TIME_FORMAT_UNSUPPORTED',
  candidateId: '', evidence: [{ sourceId: input.evidence[0].sourceId, quote: input.evidence[0].text }], requiresReview: true });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } assert.fail('request did not start'); }

function fixture(t, { request, config = {} } = {}) {
  const now = () => NOW, key = Buffer.alloc(32, 9);
  let rules;
  const store = new Store({ key, now, getLogisticsRules: () => rules?.read().rules });
  rules = new LogisticsRuleStore(store.db, now, { onRulesChanged: value => store.refreshLogisticsRules(value) });
  const stations = new StationStore({ db: store.db, key, now });
  stations.saveAiConfig({ enabled: true, logisticsEnabled: true, autoApply: false, channelName: '合成渠道', model: 'synthetic',
    baseUrl: 'https://example.com/v1', apiKey: randomBytes(24).toString('hex'), ...config });
  stations.saveStation('known', { name: STATION });
  const calls = [];
  const assistance = new AiAssistance({ stations, now, request: async outbound => {
    const body = JSON.parse(outbound.body), input = JSON.parse(body.messages[1].content); calls.push(input);
    return request ? request(input) : reply(input.expectedStation ? ruleSuggestion() : timeSuggestion(input));
  } });
  const workflow = new RecognitionWorkflow({ store, now, automaticEvents: false });
  const jobs = new LogisticsAiJobs({ stations, rules, store, assistance, now, automaticEvents: false,
    allowAutomatic: (shipment, target) => workflow.allowAutomatic(shipment, target) });
  const daily = new LogisticsDailyLearning({ store, stations, logisticsAi: jobs, now, automaticEvents: false });
  const adapter = new RecognitionAi({ store, stations, logisticsAi: jobs, assistance, workflow, now });
  const account = store.saveAccount({ platform: 'pdd', label: 'PRIVATE_NAME', cookie: 'PRIVATE_COOKIE' }, undefined, true);
  let sequence = 0;
  const ingest = (extras = {}) => {
    const id = `source-${++sequence}`;
    store.importResult(account.id, { orders: [{ platformOrderId: id, orderStatus: '待收货', orderDate: NOW - 86400000 }],
      shipments: [{ platformOrderId: id, waybillNo: id, status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW,
        logisticsEvents: [{ time: 0, timeText: '11月9日 10:30', timePrecision: 'unknown', description: '运输中' }], ...extras }] });
    return store.snapshot([account.id]).shipments.find(shipment => shipment.waybillNo === id);
  };
  const task = (shipment, target = 'event_time', extras = {}) => workflow.save({ id: `recognition-${shipment.id}-${target}`,
    shipmentId: shipment.id, accountId: account.id, orderId: shipment.orderId, platform: 'pdd', target,
    methodId: `pdd.${target}`, methodVersion: 1, contentKind: target === 'station_match' ? 'pickup_match' : 'logistics',
    problemCode: target === 'station_match' ? 'UNMATCHED_PICKUP' : 'TIME_UNKNOWN', sourceFingerprint: workflow.fingerprint(shipment),
    retryCount: 3, initialFailures: 1, aiAttempts: 0, status: 'ai_pending', createdAt: NOW, nextRetryAt: NOW, ...extras });
  t.after(async () => { await adapter.close(); await daily.close(); await jobs.close(); await workflow.close(); assistance.close(); store.close(); });
  return { store, rules, stations, assistance, workflow, jobs, daily, adapter, account, calls, ingest, task, now };
}

test('recognition AI waits for three local retries and persists a review without changing source facts', async t => {
  const f = fixture(t), shipment = f.ingest(), task = f.task(shipment, 'event_time', { retryCount: 2 });
  const before = structuredClone(f.store.shipment(shipment.id));
  assert.equal((await f.adapter.analyze(task)).reasonCode, 'LOCAL_RETRIES_REQUIRED');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.adapter.reviews(), []);
  f.workflow.save({ ...task, retryCount: 3 });
  const result = await f.adapter.analyze(task);
  assert.equal(result.status, 'review'); assert.equal(result.reasonCode, 'AI_REVIEW_REQUIRED');
  const saved = f.adapter.review(result.reviewId);
  assert.equal(saved.taskId, task.id); assert.equal(saved.suggestion.requiresReview, true);
  assert.equal(saved.suggestion.action, 'review_time_format'); assert.equal(f.calls.length, 1);
  assert.equal(f.stations.aiConfig().usageToday, 1);
  assert.deepEqual(f.store.shipment(shipment.id), before);
  const reopened = new RecognitionAi({ store: f.store, stations: f.stations, logisticsAi: f.jobs, assistance: f.assistance, workflow: f.workflow, now: f.now });
  assert.deepEqual(await reopened.analyze(task), result); assert.equal(f.calls.length, 1); await reopened.close();
});

test('AI disabled leaves the problem pending while local daily diagnosis still runs', async t => {
  const f = fixture(t, { config: { enabled: false } }), shipment = f.ingest(), task = f.task(shipment);
  assert.equal((await f.adapter.analyze(task)).status, 'disabled'); assert.equal(f.calls.length, 0);
  const run = await f.workflow.daily(); assert.equal(run.status, 'complete'); assert.ok(run.scanned >= 1);
  assert.ok(f.workflow.latestForShipment(shipment.id, 'event_time'));
  f.stations.saveAiConfig({ enabled: true });
  assert.equal((await f.adapter.analyze(task)).status, 'review');
  assert.equal(f.stations.aiConfig().autoApply, false); assert.equal(f.calls.length, 1);
});

test('fixed review JSON rejects invented times, target changes, executable fields and unprovided quotes', () => {
  const input = { target: 'event_time', evidence: [{ sourceId: 'e1', text: '11月9日 10:30' }], candidates: [] };
  const good = timeSuggestion(input);
  assert.deepEqual(validateRecognitionSuggestion(good, input), good);
  for (const bad of [null, [], { ...good, timestamp: NOW }, { ...good, code: 'return 1' }, { ...good, requiresReview: false },
    { ...good, target: 'arrival_time' }, { ...good, action: 'apply' }, { ...good, reasonCode: 'STATION_NAME_VARIANT' },
    { ...good, candidateId: 'foreign' }, { ...good, evidence: [] },
    { ...good, evidence: [{ sourceId: 'missing', quote: '11月9日' }] },
    { ...good, evidence: [{ sourceId: 'e1', quote: '2026年11月9日' }] },
    { ...good, evidence: [{ sourceId: 'e1', quote: '11月9日', script: 'x' }] }]) {
    assert.throws(() => validateRecognitionSuggestion(bad, input), { code: 'AI_INVALID_RESULT' });
  }
});

test('review calls share the existing daily budget and keep provider transport idle after exhaustion', async t => {
  const f = fixture(t), task = f.task(f.ingest());
  while (f.stations.reserveAiCall()) { /* Exhaust the configured local fixture budget. */ }
  const result = await f.adapter.analyze(task);
  assert.equal(result.status, 'disabled'); assert.equal(result.reasonCode, 'AI_DAILY_LIMIT');
  assert.equal(f.calls.length, 0); assert.deepEqual(f.adapter.reviews(), []);
});

test('matching suggestions use station evidence only and remain review without creating a match', async t => {
  const station = '示例花园4卡5号柜兔喜快递柜，4卡 5号柜';
  const f = fixture(t, { request: input => reply({ version: 1, target: input.target, action: 'review_match', reasonCode: 'STATION_NAME_VARIANT',
    candidateId: 'candidate-1', evidence: input.evidence.map(item => ({ sourceId: item.sourceId, quote: item.text })), requiresReview: true }) });
  const shipment = f.ingest({ station, stationSource: 'locker' });
  const task = f.task(shipment, 'station_match', { candidateShipmentIds: [shipment.id], source: { station, pickupCode: '7-6-7042',
    waybillNo: 'PRIVATE_WAYBILL', fragment: 'PRIVATE_RECIPIENT 13812345678', occurredAt: NOW - 1000 } });
  const before = structuredClone(f.store.shipment(shipment.id));
  const result = await f.adapter.analyze(task), review = f.adapter.review(result.reviewId);
  assert.equal(review.candidateShipmentId, shipment.id); assert.equal(review.suggestion.action, 'review_match');
  assert.doesNotMatch(JSON.stringify(f.calls), /PRIVATE|13812345678|7042/u);
  assert.equal(JSON.stringify(f.calls).includes(shipment.id), false);
  assert.deepEqual(f.store.shipment(shipment.id), before);
  const input = f.calls[0];
  const conflict = structuredClone(input); conflict.evidence[1].text = '示例花园4卡2号柜兔喜快递柜';
  const bad = { ...review.suggestion, evidence: conflict.evidence.map(item => ({ sourceId: item.sourceId, quote: item.text })) };
  assert.throws(() => validateRecognitionSuggestion(bad, conflict), { code: 'AI_INVALID_RESULT' });
});

test('actual station text formats require exact continuous quotes without normalizing cabinet numbers', () => {
  const samples = [
    ['示例花园4卡5号柜兔喜快递柜，4卡 5号柜', '示例花园4卡5号柜兔喜快递柜', '4卡 5号柜', 'locker'],
    ['示例城区示例花园4卡店员员示例路代收点(示例城区示例花园4卡店)', '示例城区示例花园4卡店员员示例路代收点', '4卡', 'pickup_station'],
  ];
  for (const [fragment, alias, subLocation, kind] of samples) {
    const candidate = { fragment, stationName: alias };
    const value = { kind, targetStationId: '', suggestedName: alias, alias, subLocation, evidence: [alias] };
    const result = validateStationSuggestion(candidate, value, []);
    assert.equal(result.alias, alias);
    assert.equal(result.subLocation, kind === 'locker' ? '5号柜' : '');
    assert.throws(() => validateStationSuggestion(candidate, { ...value, subLocation: '4卡2号柜' }, []), { code: 'AI_INVALID_RESULT' });
  }
  assert.match(STATION_SYSTEM, /不去掉片段内部空格/);
});

test('invalid provider output is persisted safely and changed evidence invalidates an in-flight review', async t => {
  let release;
  const f = fixture(t, { request: () => new Promise(resolve => { release = resolve; }) });
  const shipment = f.ingest(), task = f.task(shipment);
  const pending = f.adapter.analyze(task);
  await until(() => release);
  f.workflow.save({ ...f.workflow.task(task.id), sourceFingerprint: 'changed' });
  release(reply(timeSuggestion(f.calls[0])));
  const result = await pending;
  assert.equal(result.reasonCode, 'SOURCE_CHANGED'); assert.equal(f.adapter.review(result.reviewId).suggestion, null);
  release = null;
  const second = f.ingest(), secondTask = f.task(second), secondPending = f.adapter.analyze(secondTask);
  await until(() => release);
  release({ choices: [{ message: { content: 'PRIVATE_PROVIDER_ERROR', tool_calls: [{}] } }] });
  const invalid = await secondPending;
  assert.equal(invalid.reasonCode, 'AI_INVALID_RESULT'); assert.doesNotMatch(JSON.stringify(f.adapter.reviews()), /PRIVATE_PROVIDER_ERROR/);
});

test('legacy logistics and daily paths cannot enqueue or run before the recognition gate opens', async t => {
  const f = fixture(t), ships = [f.ingest({ logisticsEvents: [{ time: NOW - 1000, description: FRAGMENT, timePrecision: 'second' }] }),
    f.ingest({ logisticsEvents: [{ time: NOW - 1000, description: FRAGMENT, timePrecision: 'second' }] })];
  assert.equal(f.jobs.intake({ shipments: ships }).accepted, 0);
  f.daily.runDue(); await f.daily.running;
  assert.equal(f.calls.length, 0); assert.deepEqual(f.jobs.candidates(), []);
  const task = f.task(ships[0], 'arrival_time');
  assert.equal(f.jobs.intake({ shipments: ships }).accepted, 1);
  f.workflow.save({ ...task, retryCount: 2 });
  assert.deepEqual(f.jobs.work(), []); assert.equal(f.jobs.runDue().code, 'AI_NO_PENDING');
  f.workflow.save({ ...task, retryCount: 3 });
  const result = await f.adapter.analyze(task); if (f.jobs.running) await f.jobs.running;
  assert.equal(result.status, 'queued'); assert.equal(result.candidateIds.length, 1);
  assert.deepEqual(f.adapter.review(result.reviewId).candidateIds, result.candidateIds);
  assert.ok(f.jobs.candidate(result.candidateIds[0]).recognitionTaskIds.includes(task.id));
  assert.equal(f.calls.length, 1); assert.equal(f.jobs.candidates()[0].status, 'review');
  const refreshed = f.adapter.refresh(task);
  assert.equal(refreshed.status, 'review'); assert.equal(refreshed.reasonCode, 'LOGISTICS_RULE_REVIEW');
  assert.equal(f.adapter.review(refreshed.reviewId).candidateResults[0].suggestion.kind, 'arrival');
  assert.equal(f.calls.length, 1);
});

test('settled rule application is reported for reevaluation and never claimed as problem resolution', async t => {
  const f = fixture(t), shipment = f.ingest({ logisticsEvents: [{ time: NOW - 1000, description: FRAGMENT, timePrecision: 'second' }] });
  const task = f.task(shipment, 'arrival_time'), result = await f.adapter.analyze(task);
  if (f.jobs.running) await f.jobs.running;
  f.jobs.update(result.candidateIds[0], { status: 'applied', appliedAt: NOW });
  const refreshed = f.adapter.refresh(task);
  assert.equal(refreshed.status, 'review'); assert.equal(refreshed.reasonCode, 'LOGISTICS_RULE_APPLIED');
  assert.equal(f.store.shipment(shipment.id).arrivalAt, 0);
  assert.equal(f.workflow.task(task.id).status, 'ai_pending', 'workflow alone owns its task transitions');
  assert.equal(f.calls.length, 1);
});

test('a closed gate during a logistics response prevents automatic rule publication', async t => {
  let release;
  const f = fixture(t, { config: { autoApply: true }, request: () => new Promise(resolve => { release = resolve; }) });
  const shipment = f.ingest({ logisticsEvents: [{ time: NOW - 1000, description: FRAGMENT, timePrecision: 'second' }] }), task = f.task(shipment, 'arrival_time');
  f.jobs.intake({ shipments: [shipment] }); const before = f.rules.read(); f.jobs.runDue();
  await until(() => release);
  f.workflow.save({ ...task, retryCount: 2 }); release(reply(ruleSuggestion())); await f.jobs.running;
  assert.deepEqual(f.rules.read(), before); assert.equal(f.jobs.candidates()[0].reason, 'LOCAL_RETRIES_REQUIRED');
  assert.equal(f.jobs.candidates()[0].attempts, 1);
});

test('station automatic queue honors the callback while explicit manual analysis remains available', async t => {
  const f = fixture(t), calls = [];
  f.stations.enqueue([{ id: 'platform-station', source: 'platform', stationName: STATION, fragment: STATION }], { source: 'platform' });
  const jobs = new StationAiJobs({ stations: f.stations, now: f.now, automaticEvents: false, allowAutomatic: () => false,
    request: async body => { calls.push(body); return reply({ kind: 'unknown', targetStationId: '', suggestedName: '', alias: '', subLocation: '', evidence: [] }); } });
  assert.equal(jobs.runDue().code, 'AI_NO_PENDING'); assert.equal(calls.length, 0);
  assert.equal(jobs.request().accepted, true); await jobs.running; assert.equal(calls.length, 1);
  await jobs.close();
});
