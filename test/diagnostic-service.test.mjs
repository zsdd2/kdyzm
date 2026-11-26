import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../src/service.mjs';

const ADMIN = 'diagnostic-local-test-admin-only-0123456789';
const NOW = Date.parse('2026-11-10T15:00:00+08:00');
async function setup(t, persistent = false) {
  const dir = persistent ? mkdtempSync(join(tmpdir(), 'diagnostic-http-')) : null;
  let now = NOW, service;
  const start = async () => {
    service = createService({ filename: dir ? join(dir, 'test.sqlite') : ':memory:', encryptionKey: 'ab'.repeat(32), adminToken: ADMIN,
      scheduler: false, now: () => now, log() {} });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  };
  await start();
  t.after(async () => { await service.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const request = async (path, { token, admin, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${service.server.address().port}${path}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(admin ? { 'x-admin-token': admin === true ? ADMIN : admin } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  const create = async () => {
    const result = await request('/v1/admin/diagnostic-tokens', { admin: true, method: 'POST', body: { name: '离线联调' } });
    assert.equal(result.status, 201); return result.data;
  };
  return { get service() { return service; }, request, create, advance: ms => { now += ms; }, restart: async () => { await service.close(); await start(); } };
}

test('machine credential works after admin session expires and service restarts; revocation is immediate', async t => {
  const f = await setup(t, true);
  const login = await f.request('/v1/admin/login', { method: 'POST', body: { password: ADMIN } });
  const created = await f.request('/v1/admin/diagnostic-tokens', { admin: login.data.token, method: 'POST', body: { name: '每日复盘' } });
  assert.equal(created.status, 201);
  const { token, credential } = created.data;
  f.advance(9 * 3600000);
  assert.equal((await f.request('/v1/admin/status', { admin: login.data.token })).status, 401);
  let result = await f.request('/v1/diagnostics/status', { token });
  assert.equal(result.status, 200); assert.equal(result.data.expiresAt, null);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  await f.restart();
  assert.equal((await f.request('/v1/diagnostics/status', { token })).status, 200);
  const list = await f.request('/v1/admin/diagnostic-tokens', { admin: true });
  assert.equal(list.data.credentials[0].id, credential.id);
  assert.equal(JSON.stringify(list.data).includes(token), false);
  assert.equal((await f.request(`/v1/admin/diagnostic-tokens/${credential.id}`, { admin: true, method: 'DELETE' })).status, 200);
  assert.equal((await f.request('/v1/diagnostics/status', { token })).status, 401);
  await f.restart();
  assert.equal((await f.request('/v1/diagnostics/status', { token })).status, 401);
});

test('diagnostic auth is independent and read-only; token cannot administer, bind, collect or mutate', async t => {
  const f = await setup(t), { token } = await f.create();
  for (const options of [{}, { token: ADMIN }, { admin: true }, { token: 'pcdiag_bad' }])
    assert.equal((await f.request('/v1/diagnostics/status', options)).status, 401);
  assert.equal((await f.request(`/v1/diagnostics/status?token=${token}`)).status, 401);
  const before = f.service.store.db.prepare('SELECT total_changes() AS n').get().n;
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
    assert.equal((await f.request('/v1/diagnostics/orders', { token, method, body: { title: '不允许写入' } })).status, 405);
  for (const path of ['/v1/admin/status', '/v1/admin/diagnostic-tokens', '/v1/snapshot', '/v1/diagnostics/settings']) {
    const response = await f.request(path, { token });
    assert.equal(response.status, path.startsWith('/v1/diagnostics/') ? 404 : 401);
  }
  for (const path of ['/v1/admin/accounts', '/v1/pairing-codes', '/v1/operations', '/v1/sync'])
    assert.equal((await f.request(path, { token, method: 'POST', body: {} })).status, 401);
  assert.equal((await f.request('/v1/diagnostics/status', { token, headers: { Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal(f.service.store.db.prepare('SELECT total_changes() AS n').get().n, before);
});

test('diagnostic order lookup returns complete saved timing evidence scoped to that order without configuration secrets', async t => {
  const f = await setup(t), { token } = await f.create(), store = f.service.store;
  const a = store.saveAccount({ platform: 'taobao', label: '测试账号A', cookie: '_m_h5_tk=test_cookie_A', enabled: true });
  const b = store.saveAccount({ platform: 'taobao', label: '测试账号B', cookie: '_m_h5_tk=test_cookie_B', enabled: true });
  const events = Array.from({ length: 14 }, (_, i) => ({ time: NOW - (i + 1) * 60000, timePrecision: 'minute', description: `运输节点${i}` }));
  const data = { orders: [{ platformOrderId: 'same-platform-id', title: '双层测试支架', orderDate: NOW - 86400000, orderDatePrecision: 'second', orderDateOrigin: 'detail' }],
    shipments: [{ platformOrderId: 'same-platform-id', waybillNo: 'LOCALTRACK', carrier: '圆通', status: 'transit', logisticsState: 'ok', logisticsEvents: events }], warnings: [] };
  store.importResult(a.id, data); store.importResult(b.id, { ...data, orders: [{ ...data.orders[0], title: '其他账号的包裹' }] });
  store.updateAccount(a.id, { status: 'error', lastSuccessAt: NOW - 60000, error: '合成采集错误' });
  const accountStatus = (await f.request('/v1/diagnostics/accounts', { token })).data.accounts.find(account => account.id === a.id);
  assert.equal(accountStatus.lastSuccessAt, NOW - 60000); assert.equal(accountStatus.error, '合成采集错误');
  const parcels = store.snapshot([a.id, b.id]).shipments;
  const device = store.redeem(store.createPairing({ accountIds: [a.id, b.id] }).code, '合成设备');
  const issue = f.service.recognition.submit({ id: 'multi-order', revision: 1, kind: 'unmatched_pickup', state: 'unresolved', sourceId: 'local-source', observedAt: NOW,
    source: { station: '合成站点', carrier: '', waybillNo: '', pickupCode: '', occurredAt: null, fragment: '合成站点' },
    candidateShipmentIds: parcels.map(parcel => parcel.id), reasonCodes: ['station_mismatch'] }, { deviceId: device.deviceId });
  for (const parcel of parcels) {
    const detail = await f.request(`/v1/diagnostics/orders/${parcel.orderId}`, { token });
    assert.ok(detail.data.tasks.some(task => task.id === issue.id), '每个候选订单均应能查询到关联任务');
  }
  const result = await f.request(`/v1/diagnostics/orders?query=${encodeURIComponent('双层')}&platform=taobao&accountId=${a.id}`, { token });
  assert.equal(result.status, 200); assert.equal(result.data.orders.length, 1);
  const id = result.data.orders[0].id;
  // Future internal fields must not leak just because the persistence representation gains them.
  store.db.prepare("UPDATE orders SET data=json_set(data,'$.cookie','secret-canary') WHERE id=?").run(id);
  store.db.prepare("UPDATE shipments SET data=json_set(data,'$.apiKey','secret-canary') WHERE account_id=?").run(a.id);
  const before = store.db.prepare('SELECT total_changes() AS n').get().n;
  const detail = await f.request(`/v1/diagnostics/orders/${id}`, { token });
  assert.equal(detail.status, 200); assert.equal(detail.data.order.accountId, a.id);
  assert.equal(detail.data.shipments.length, 1); assert.equal(detail.data.shipments[0].accountId, a.id);
  assert.equal(detail.data.shipments[0].logisticsEvents.length, 14);
  assert.equal(detail.data.shipments[0].logisticsEvents[0].timePrecision, 'minute');
  assert.equal(detail.data.order.orderDatePrecision, 'second');
  for (const path of ['/v1/diagnostics/accounts', '/v1/diagnostics/recognition-tasks', '/v1/diagnostics/recognition-review']) {
    const response = await f.request(path, { token }); assert.equal(response.status, 200);
    assert.doesNotMatch(JSON.stringify(response.data), /test_cookie|secret-canary|token_hash|encryptionKey/);
  }
  assert.doesNotMatch(JSON.stringify(detail.data), /secret-canary|其他账号/);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal((await f.request('/v1/diagnostics/orders/00000000000000000000000000000000', { token })).status, 404);
  for (const query of ['limit=0', 'limit=101', 'after=-1', 'platform=unknown', 'query=' + 'x'.repeat(121), 'token=abc', 'limit=1&limit=2'])
    assert.equal((await f.request(`/v1/diagnostics/orders?${query}`, { token })).status, 400, query);
  const first = await f.request('/v1/diagnostics/orders?limit=1', { token });
  const next = await f.request(`/v1/diagnostics/orders?limit=1&after=${first.data.nextCursor}`, { token });
  assert.notEqual(first.data.orders[0].id, next.data.orders[0].id);
});

test('diagnostic authentication attempts have an IP limit independent of supplied token', async t => {
  const f = await setup(t);
  for (let i = 0; i < 120; i++) assert.equal((await f.request('/v1/diagnostics/status', { token: `invalid-${i}` })).status, 401);
  assert.equal((await f.request('/v1/diagnostics/status', { token: 'invalid' })).status, 429);
});

test('station-feedback diagnostic pages expose only safe fields and never persist legacy attempts on reads', async t => {
  const f = await setup(t), { token } = await f.create(), { store, stations, matchingFeedback } = f.service;
  const account = store.saveAccount({ platform: 'pdd', label: 'PRIVATE_ACCOUNT', cookie: 'PRIVATE_COOKIE' }, 'a', true);
  store.importResult(account.id, {
    orders: [{ platformOrderId: 'PRIVATE_ORDER_ID', title: 'PRIVATE_ORDER_TITLE' }],
    shipments: [{ platformOrderId: 'PRIVATE_ORDER_ID', waybillNo: 'PRIVATE_WAYBILL', carrier: '申通',
      status: 'arrived', station: 'PRIVATE_SHIPMENT_STATION', arrivalAt: NOW - 1000 }],
  });
  const shipment = store.snapshot([account.id]).shipments[0];
  const paired = store.redeem(store.createPairing({ accountIds: [account.id] }).code, 'PRIVATE_DEVICE');
  const owner = store.device(paired.token);
  stations.saveStation('PRIVATE_TARGET', { name: '甲乙社区菜鸟驿站' });
  const feedback = { id: 'PRIVATE_FEEDBACK', revision: 1, action: 'upsert', kind: 'station_correction',
    shipmentId: shipment.id, stationName: '兔喜快递超市', otherStationName: '隐私社区第3号柜', targetStationId: 'PRIVATE_TARGET',
    subLocation: '3号柜', reason: 'station_correction' };
  const candidateId = matchingFeedback.submit(owner, { items: [feedback] }).items[0].candidateId;
  assert.ok(candidateId);
  stations.recordAnalysis(candidateId, { startedAt: NOW, finishedAt: NOW + 1, error: { code: 'AI_INVALID_RESULT',
    message: 'PRIVATE_AI_MESSAGE', validationFailure: { category: 'EVIDENCE_NOT_IN_INPUT', fields: ['PRIVATE_FIELD'] } },
    result: { evidence: ['PRIVATE_ANALYSIS_SNIPPET'] } });
  stations.updateCandidate(candidateId, { status: 'failed' });
  matchingFeedback.submitRuleReceipt(owner, { stationRulesVersion: stations.revision, serverLogisticsRulesVersion: 0 },
    { stationRulesVersion: stations.revision, serverLogisticsRulesVersion: 0 });
  f.advance(1000);
  matchingFeedback.submit(owner, { items: [{ id: 'PRIVATE_WITHDRAWN', revision: 1, action: 'withdraw' }] });
  const path = '/v1/diagnostics/station-feedback';
  for (const options of [{}, { admin: true }, { token: paired.token }]) {
    assert.equal((await f.request(path, options)).status, 401);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal((await f.request(path, { token, method, body: {} })).status, 405);
  }
  for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'before=-1', 'before=1e1', 'from=20&to=10', 'from=',
    'from=9007199254740993', 'station=PRIVATE_NAME', 'device=PRIVATE_NAME', 'token=PRIVATE_UNKNOWN']) {
    assert.equal((await f.request(path + '?' + query, { token })).status, 400, query);
  }
  const changes = () => store.db.prepare('SELECT total_changes() AS total').get().total;
  const before = changes();
  const first = await f.request(path + '?limit=1', { token });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.data.items.length, 1);
  assert.equal(first.data.items[0].status, 'withdrawn');
  assert.ok(first.data.nextCursor);
  const next = await f.request(path + '?before=' + encodeURIComponent(first.data.nextCursor), { token });
  assert.equal(next.status, 200);
  assert.equal(next.data.nextCursor, null);
  const [item] = next.data.items;
  assert.equal(item.kind, 'station_correction');
  assert.equal(item.status, 'failed');
  assert.equal(item.reasonCode, 'ANALYSIS_FAILED');
  assert.equal(item.analysisAttemptCount, 1);
  assert.equal(item.failureCategory, 'EVIDENCE_NOT_IN_INPUT');
  assert.equal(item.deviceRuleReceipt.stationRulesVersion, stations.revision);
  assert.equal(item.deviceRuleReceipt.effectStatus, 'unverified');
  assert.deepEqual(item.sourceStation, { present: true, generic: true, nonPickup: false, hasLocker: false });
  assert.deepEqual(item.targetStation, { present: true, generic: false, nonPickup: false, hasLocker: true, selected: true });
  assert.match(item.feedbackRef, /^[a-f0-9]{24}$/u);
  assert.match(item.candidateRef, /^[a-f0-9]{24}$/u);
  const filtered = (await f.request(path + '?from=' + NOW + '&to=' + NOW, { token })).data;
  assert.deepEqual(filtered.items, [item]);
  const payload = JSON.stringify(next.data);
  for (const privateValue of ['PRIVATE_', '兔喜快递超市', '隐私社区', '3号柜', shipment.id, candidateId, owner.id, token]) {
    assert.equal(payload.includes(privateValue), false);
  }
  assert.equal(changes(), before);

  store.db.prepare('DELETE FROM matching_feedback_attempts WHERE candidate_id=?').run(candidateId);
  const legacyBefore = changes();
  const legacy = (await f.request(path, { token })).data.items.find(row => row.feedbackRef === item.feedbackRef);
  assert.equal(legacy.analysisAttemptCount, 0);
  assert.equal(legacy.failureCategory, 'EVIDENCE_NOT_IN_INPUT');
  assert.equal(changes(), legacyBefore);
});
