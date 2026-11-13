import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';

const NOW = Date.parse('2026-11-09T03:00:00+08:00');
const STATION = '合成专项幸福菜鸟驿站', FRAGMENT = `已暂存于${STATION}`;
const ADMIN = 'TASK083_SYNTHETIC_ADMIN_TOKEN_0123456789';
const reply = input => ({ choices: [{ message: { content: JSON.stringify({ kind: 'arrival', starts: ['已暂存于'], ends: [],
  keywords: [input.expectedStation], expectedStation: input.expectedStation, evidence: [input.fragment] }) } }] });

async function fixture(t, { request } = {}) {
  let sequence = 0, closing, now = NOW, collections = 0, prepared = false;
  const calls = [], orders = new Map(), shipments = [];
  const service = createService({ encryptionKey: Buffer.alloc(32, 8).toString('hex'), adminToken: ADMIN,
    fixture: true, scheduler: false, now: () => now,
    collector: async () => { collections++; return { orders: [...orders.values()], shipments, warnings: [] }; }, aiRequest: async outbound => {
      const input = JSON.parse(JSON.parse(outbound.body).messages[1].content);
      calls.push(input);
      return request ? request(input, outbound) : reply(input);
    } });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const close = () => closing ||= service.close();
  t.after(close);
  const { store, stations, logisticsAi, logisticsDaily: daily, logisticsRules: rules } = service;
  const initialRules = rules.read();
  rules.save({ revision: initialRules.revision, rules: initialRules.rules.map(rule => rule.id === 'builtin-arrival-storage' ? { ...rule, enabled: false } : rule) });
  const account = store.saveAccount({ platform: 'pdd', label: 'PRIVATE_ACCOUNT', cookie: 'PRIVATE_COOKIE' }, undefined, true);
  const device = store.redeem(store.createPairing({ accountIds: [account.id] }).code, '合成专项设备');
  stations.saveStation('task083-station', { name: STATION });
  stations.saveAiConfig({ enabled: true, logisticsEnabled: true, autoApply: true, channelName: '合成专项渠道',
    model: 'synthetic-task083', baseUrl: 'https://example.com/v1', apiKey: 'test-only' });
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const http = async (path, { method = 'GET', body, snapshot = false, etag } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(snapshot ? { Authorization: `Bearer ${device.token}` } : { 'x-admin-token': ADMIN }),
      ...(etag ? { 'If-None-Match': etag } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const raw = await response.text();
    return { status: response.status, etag: response.headers.get('etag'), data: raw ? JSON.parse(raw) : null };
  };
  const ingest = ({ description = FRAGMENT, time = NOW - 60000, shipment = {}, order = {} } = {}) => {
    const id = `SYNTHETIC-${++sequence}`, platformOrderId = Object.keys(order).length ? id : 'SYNTHETIC-ORDER';
    const orderData = { platformOrderId, title: 'PRIVATE_PRODUCT', orderDate: NOW - 86400000, ...order };
    const shipmentData = { platformOrderId, waybillNo: id, status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW,
      logisticsEvents: [{ time, description, timePrecision: 'minute' }], ...shipment };
    orders.set(platformOrderId, orderData); shipments.push(shipmentData);
    store.importResult(account.id, { orders: [orderData], shipments: [shipmentData] });
    return store.snapshot([account.id]).shipments.find(item => item.waybillNo === id)
      || store.db.prepare('SELECT data FROM shipments').all().map(row => JSON.parse(row.data)).find(item => item.waybillNo === id);
  };
  const prepare = async () => {
    if (prepared) return;
    service.recognition.observe(store.snapshot([account.id]));
    for (const minutes of [5, 10, 15]) {
      now += minutes * 60000; service.recognition.runDue(); await service.recognition.running;
      assert.equal(calls.length, 0, 'the three collection rounds must finish before AI is dispatched');
    }
    assert.equal(collections, 3);
    assert.ok(service.recognition.tasks().some(task => task.target === 'arrival_time' && task.retryCount === 3 && task.status === 'ai_pending'));
    prepared = true;
  };
  const run = async () => { await prepare(); const result = daily.runDue(); if (daily.running) await daily.running; return result; };
  return { service, store, stations, logisticsAi, daily, rules, account, device, calls, http, ingest, run, prepare, close };
}

test('daily learning publishes exact event time and a new snapshot ETag, then HTTP rollback removes only learned evidence', async t => {
  const f = await fixture(t);
  const first = f.ingest({ description: `收件人张三，${FRAGMENT}，电话13800138000，取件码7-6-7042` });
  const second = f.ingest();
  const before = await f.http('/v1/snapshot', { snapshot: true });
  assert.equal(before.status, 200); assert.ok(before.data.shipments.every(item => item.arrivalAt === 0));
  assert.equal((await f.run()).code, 'DAILY_ACCEPTED');
  const overview = await f.http('/v1/admin/logistics-ai');
  const [candidate] = overview.data.candidates;
  assert.equal(candidate.status, 'applied');
  assert.equal(overview.data.dailyLearning.lastRun.backfilledCount, 2);
  assert.equal(overview.data.dailyLearning.lastRun.states.applied, 1);
  assert.deepEqual(f.calls, [{ fragment: FRAGMENT, expectedStation: STATION }]);
  assert.equal(f.stations.aiConfig().usageToday, 1);
  assert.doesNotMatch(JSON.stringify(overview.data), /张三|13800138000|7042|PRIVATE_/u);
  const after = await f.http('/v1/snapshot', { snapshot: true, etag: before.etag });
  assert.equal(after.status, 200); assert.notEqual(after.etag, before.etag);
  assert.ok(after.data.serverRevision > before.data.serverRevision);
  for (const id of [first.id, second.id]) {
    const item = after.data.shipments.find(value => value.id === id);
    assert.equal(item.arrivalAt, NOW - 60000); assert.equal(item.arrivalAtPrecision, 'minute');
    assert.equal(item.arrivalAtSource, 'platform_event'); assert.equal(item.station, STATION);
  }
  assert.equal((await f.http('/v1/snapshot', { snapshot: true, etag: after.etag })).status, 304);
  for (const negative of [`预计${FRAGMENT}`, `退回后${FRAGMENT}`, `催取提醒：${FRAGMENT}`, `尚未${FRAGMENT}`]) {
    assert.equal(f.rules.test({ rule: candidate.rule, sample: negative }).arrival, false);
  }
  const rollback = await f.http(`/v1/admin/ai-optimization/history/logistics_rule/${candidate.id}/rollback`, { method: 'POST', body: {} });
  assert.equal(rollback.status, 200); assert.equal(rollback.data.change.status, 'rolled_back');
  const restored = await f.http('/v1/snapshot', { snapshot: true, etag: after.etag });
  assert.equal(restored.status, 200); assert.ok(restored.data.serverRevision > after.data.serverRevision);
  assert.ok(restored.data.shipments.every(item => item.arrivalAt === 0 && item.status !== 'arrived'));
  assert.equal(f.daily.summary().lastRun.backfilledCount, 0);
  assert.equal(f.daily.summary().lastRun.states.rolled_back, 1);
  assert.equal((await f.run()).code, 'DAILY_ALREADY_RUN'); assert.equal(f.calls.length, 1);
});

test('daily scope rejects future, returned and inactive samples without dispatching them alongside valid groups', async t => {
  const f = await fixture(t);
  f.ingest(); f.ingest();
  const rejected = [
    f.ingest({ description: `退回后${FRAGMENT}` }),
    f.ingest({ description: `预计${FRAGMENT}` }),
    f.ingest({ time: NOW + 60 * 60000 }),
    f.ingest({ description: `已托管至${STATION}` }),
    f.ingest({ description: `已托管至${STATION}` }),
    f.ingest({ description: `已托管至${STATION}`, order: { orderDate: NOW - 46 * 86400000 } }),
    f.ingest({ shipment: { logisticsEvents: [{ time: NOW - 60000, timeText: '2026-11-08 09:00:00', timePrecision: 'minute', description: FRAGMENT }] } }),
  ];
  f.store.applyOperations(f.store.device(f.device.token), [
    { id: 'scope-pick', shipmentId: rejected[3].id, action: 'pick', occurredAt: NOW },
    { id: 'scope-hide', shipmentId: rejected[4].id, action: 'hide', occurredAt: NOW },
  ]);
  assert.equal(f.store.shipment(rejected[3].id).picked, true);
  assert.equal(f.store.shipment(rejected[4].id).hidden, true);
  await f.run();
  assert.deepEqual(f.calls, [{ fragment: FRAGMENT, expectedStation: STATION }]);
  assert.equal(f.logisticsAi.candidates().length, 1);
  assert.deepEqual(rejected.map(sample => f.store.shipment(sample.id).arrivalAt), rejected.map(() => 0),
    'returned, expected, future, picked, hidden, archived and conflicting evidence must stay unfilled');
  const summary = f.daily.summary().lastRun;
  assert.equal(summary.issues.timeConflict, 2);
  assert.equal(summary.backfilledCount, 2);
});

test('service shutdown cancels an in-flight daily request before a late response can save a rule', async t => {
  let resolveRequest, requestStarted, signal, projections = 0;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const f = await fixture(t, { request: (input, outbound) => new Promise(resolve => {
    signal = outbound.signal; resolveRequest = () => resolve(reply(input)); requestStarted();
  }) });
  f.ingest(); f.ingest();
  const project = f.rules.onRulesChanged;
  f.rules.onRulesChanged = rules => { projections++; return project(rules); };
  await f.prepare();
  f.daily.runDue(); await started;
  const closing = f.close(), cancelledBeforeReply = signal.aborted;
  resolveRequest(); await closing;
  assert.equal(cancelledBeforeReply, true);
  assert.equal(projections, 0);
});

test('an account disabled while the daily provider request is in flight cannot supply a late accepted rule', async t => {
  let resolveRequest, requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  const f = await fixture(t, { request: input => new Promise(resolve => { resolveRequest = () => resolve(reply(input)); requestStarted(); }) });
  const first = f.ingest(); f.ingest();
  const rulesBefore = f.rules.read();
  await f.prepare();
  f.daily.runDue(); await started;
  f.store.saveAccount({ enabled: false }, f.account.id, true);
  resolveRequest(); await f.daily.running;
  const [candidate] = f.logisticsAi.candidates();
  assert.equal(candidate.status, 'review'); assert.equal(candidate.reason, 'LOCAL_RETRIES_REQUIRED');
  assert.equal(candidate.rule, null); assert.deepEqual(f.rules.read(), rulesBefore);
  assert.equal(f.store.shipment(first.id).arrivalAt, 0);
  assert.equal(f.daily.summary().lastRun.backfilledCount, 0);
  assert.equal(f.stations.aiConfig().usageToday, 1);
});

test('rollback history failure restores the rule, shipment projections and snapshot version atomically', async t => {
  const f = await fixture(t); f.ingest(); f.ingest(); await f.run();
  const [candidate] = f.logisticsAi.candidates();
  assert.equal(candidate.status, 'applied');
  const rulesBefore = f.rules.read(), snapshotBefore = f.store.snapshot([f.account.id]), historyBefore = f.logisticsAi.history();
  f.store.db.exec(`CREATE TEMP TRIGGER task083_reject_rollback BEFORE UPDATE ON logistics_ai_candidates
    WHEN json_extract(NEW.data,'$.status')='rolled_back' BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END;`);
  assert.throws(() => f.logisticsAi.rollback(candidate.id), /synthetic history failure/u);
  assert.deepEqual(f.rules.read(), rulesBefore);
  assert.deepEqual(f.store.snapshot([f.account.id]), snapshotBefore);
  assert.deepEqual(f.logisticsAi.history(), historyBefore);
  assert.equal(f.daily.summary().lastRun.backfilledCount, 2);
  f.store.db.exec('DROP TRIGGER task083_reject_rollback');
  assert.equal(f.logisticsAi.rollback(candidate.id).status, 'rolled_back');
  assert.equal(f.daily.summary().lastRun.backfilledCount, 0);
});

test('AI-disabled service restart backfills persisted legacy arrival once without collection or provider calls', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-task083-restart-'));
  const arrival = Date.parse('2026-11-09T02:47:41+08:00');
  let service, aiCalls = 0, collectionCalls = 0;
  const options = { filename: join(directory, 'service.sqlite'), encryptionKey: Buffer.alloc(32, 8).toString('hex'), adminToken: ADMIN,
    fixture: true, scheduler: false, now: () => NOW,
    collector: async () => { collectionCalls++; return { orders: [], shipments: [] }; },
    aiRequest: async () => { aiCalls++; throw new Error('unexpected synthetic AI request'); } };
  const close = async () => { const current = service; service = null; if (current) await current.close(); };
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  service = createService(options);
  service.stations.saveAiConfig({ enabled: false, logisticsEnabled: false });
  service.stations.saveStation('legacy-station', { name: STATION });
  const account = service.store.saveAccount({ platform: 'pdd', label: '合成重启账号', cookie: 'SYNTHETIC' }, undefined, true);
  service.store.importResult(account.id, { orders: [{ platformOrderId: 'legacy-order', title: '合成旧包裹', orderDate: NOW - 86400000 }],
    shipments: [{ platformOrderId: 'legacy-order', waybillNo: 'SYNTHETIC-LEGACY', status: 'transit', logisticsState: 'ok' }] });
  const initial = service.store.snapshot([account.id]).shipments[0];
  const legacy = { ...service.store.shipment(initial.id), station: STATION, stationSource: 'platform_event', arrivalAt: 0,
    arrivalAtSource: 'unknown', arrivalAtPrecision: 'unknown', logisticsCheckedAt: NOW - 1000,
    logisticsEvents: [{ time: arrival, timePrecision: 'second', description: `【驿站】您的包裹已存放至【${STATION}】` }] };
  service.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  const before = service.store.snapshot([account.id]);
  assert.equal(service.store.shipment(initial.id).arrivalAt, 0, 'legacy persistence remains undated before restart');
  assert.equal(before.shipments[0].arrivalAt, arrival, 'snapshot projection exposes deterministic legacy arrival');
  await close();

  service = createService(options);
  assert.equal(service.stations.aiConfig().enabled, false);
  const after = service.store.snapshot([account.id]), restored = after.shipments[0];
  assert.equal(restored.arrivalAt, arrival); assert.equal(restored.arrivalAtSource, 'platform_event');
  assert.equal(restored.arrivalAtPrecision, 'second'); assert.equal(restored.station, STATION);
  assert.equal(restored.status, 'arrived'); assert.ok(after.serverRevision > before.serverRevision);
  assert.equal(aiCalls, 0); assert.equal(collectionCalls, 0);
  await close();

  service = createService(options);
  assert.equal(service.stations.aiConfig().enabled, false);
  assert.deepEqual(service.store.snapshot([account.id]), after);
  assert.equal(aiCalls, 0); assert.equal(collectionCalls, 0);
});
