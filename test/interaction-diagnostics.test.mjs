import test from 'node:test';
import assert from 'node:assert/strict';
import { createInteractionDiagnostics } from '../src/interaction-diagnostics.mjs';
import { createService } from '../src/service.mjs';

const KEY = 'ab'.repeat(32);
const ADMIN = 'interaction-diagnostics-admin-token-0123456789';

test('interaction ring validates events, bounds retention, and paginates by sequence', () => {
  let current = 1000;
  const ring = createInteractionDiagnostics({ now: () => current++, capacity: 2 });
  assert.throws(() => ring.recordClient('device-a', [{ kind: 'snapshot', path: '/private' }]), /字段/);
  assert.throws(() => ring.recordClient('device-a', [{ kind: 'snapshot', status: -1 }]), /无效/);
  assert.throws(() => ring.recordClient('device-a', [{ kind: 'snapshot', durationMs: 999999 }]), /无效/);
  assert.throws(() => ring.recordClient('device-a', [{ kind: 'snapshot', phase: 'private-sms' }]), /无效/);
  assert.throws(() => ring.recordClient('device-a', [{ kind: 'sync_job', trigger: 'private-url' }]), /无效/);
  assert.throws(() => ring.recordClient('device-a', [{ kind: 'snapshot', ageMs: 604800001 }]), /无效/);
  assert.throws(() => ring.recordClient('device-a', Array.from({ length: 51 }, () => ({ kind: 'snapshot' }))), /批次/);
  ring.recordClient('device-a', [{ kind: 'snapshot', result: 'metadata_only', status: 200 }]);
  ring.recordClient('device-b', [{ kind: 'operations', result: 'accepted', ackCount: 1 }]);
  ring.recordClient('device-a', [{ kind: 'accounts', result: 'success', phase: 'import', ageMs: 125 }]);
  const first = ring.read({ limit: 1 });
  assert.equal(first.events.length, 1);
  assert.equal(first.window.retained, 2);
  assert.equal(first.window.dropped, 1);
  assert.equal(first.resetRequired, false);
  assert.ok(first.windowId);
  assert.equal(first.events[0].kind, 'operations');
  assert.equal(first.nextCursor, first.events[0].seq);
  const next = ring.read({ limit: 10, after: first.nextCursor });
  assert.equal(next.events.length, 1);
  assert.equal(next.events[0].kind, 'accounts');
  assert.equal(next.events[0].phase, 'import');
  assert.equal(next.events[0].ageMs, 125);
  assert.equal(next.events[0].deviceKey.length, 12);
  assert.equal(JSON.stringify(next), JSON.stringify(ring.read({ limit: 10, cursor: first.nextCursor })));
  assert.equal(ring.read({ after: 500 }).resetRequired, true);
  assert.equal(ring.read({ windowId: 'restarted' }).resetRequired, true);
  assert.doesNotThrow(() => ring.recordServer({ kind: 'snapshot', result: 'not-a-result' }, 'device-a'));
});

async function setup(t) {
  const service = createService({ encryptionKey: KEY, adminToken: ADMIN, scheduler: false, now: () => Date.now(), log() {} });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  t.after(() => service.close());
  const request = async (path, { method = 'GET', token, admin, body, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(admin ? { 'x-admin-token': ADMIN } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const raw = await response.text();
    return { status: response.status, headers: response.headers, data: raw ? JSON.parse(raw) : null };
  };
  const account = service.store.saveAccount({ platform: 'taobao', label: '诊断账号', cookie: 'private-cookie', enabled: true });
  service.store.importResult(account.id, {
    orders: [{ platformOrderId: 'interaction-order', title: '诊断实体订单', orderDate: Date.now() - 60000 }],
    shipments: [{ platformOrderId: 'interaction-order', waybillNo: 'INTERACTION-WAYBILL', carrier: '测试快递', status: 'transit' }],
    warnings: []
  });
  const pairing = service.store.createPairing({ accountIds: [account.id] });
  const device = service.store.redeem(pairing.code, '诊断设备');
  const tokenResult = await request('/v1/admin/diagnostic-tokens', { method: 'POST', admin: true, body: { name: 'interaction-test' } });
  return { service, request, device, diagnosticToken: tokenResult.data.token };
}

test('device upload is isolated from read-only diagnostics and server completions are metadata-only', async t => {
  const f = await setup(t);
  const valid = await f.request('/v1/device/diagnostics', {
    method: 'POST',
    token: f.device.token,
    body: { events: [{ kind: 'snapshot', result: 'metadata_only', status: 200, durationMs: 12, mode: 'compact', count: 1 }] }
  });
  assert.equal(valid.status, 202);
  assert.deepEqual(valid.data, { accepted: 1 });
  assert.equal((await f.request('/v1/device/diagnostics', { method: 'POST', token: f.diagnosticToken, body: { events: [{ kind: 'snapshot' }] } })).status, 401);
  assert.equal((await f.request('/v1/device/diagnostics', { method: 'POST', token: f.device.token, body: { events: [{ kind: 'snapshot', secret: 'sms' }] } })).status, 400);
  assert.equal((await f.request('/v1/device/diagnostics', { method: 'POST', token: f.device.token, body: { events: [{ kind: 'snapshot', status: 600 }] } })).status, 400);
  for (let i = 0; i < 3; i++) assert.equal((await f.request('/v1/device/diagnostics', { method: 'POST', token: f.device.token, body: { events: [{ kind: 'accounts' }] } })).status, 202);
  assert.equal((await f.request('/v1/device/diagnostics', { method: 'POST', token: f.device.token, body: { events: [{ kind: 'accounts' }] } })).status, 429);

  const compact = await f.request('/v1/snapshot?view=compact', { token: f.device.token });
  assert.equal(compact.status, 200);
  assert.equal(compact.data.metadataOnly, false);
  assert.ok(compact.data.orders.length > 0);
  const metadata = await f.request(`/v1/snapshot?view=compact&dataVersion=${compact.data.dataVersion}`, { token: f.device.token });
  assert.equal(metadata.status, 200);
  assert.equal(metadata.data.metadataOnly, true);
  assert.equal('orders' in metadata.data, false);
  assert.equal((await f.request('/v1/snapshot?view=compact&dataVersion=' + compact.data.dataVersion, { token: f.device.token, headers: { 'If-None-Match': metadata.headers.get('etag') } })).status, 304);
  const failed = await f.request('/v1/snapshot?accountId=outside', { token: f.device.token });
  assert.equal(failed.status, 403);
  const read = await f.request('/v1/diagnostics/interactions?limit=100', { token: f.diagnosticToken });
  assert.equal(read.status, 200);
  assert.ok(read.data.events.some(event => event.kind === 'snapshot' && event.result === 'metadata_only' && event.mode === 'compact'));
  assert.ok(read.data.events.some(event => event.kind === 'snapshot' && event.result === 'success' && event.metadataOnly === false));
  assert.ok(read.data.events.filter(event => event.source === 'server').every(event => event.phase === 'request'));
  assert.ok(read.data.events.some(event => event.kind === 'snapshot' && event.result === 'not_modified' && event.status === 304));
  assert.ok(read.data.events.some(event => event.kind === 'snapshot' && event.result === 'error' && event.status === 403));
  for (const event of read.data.events) {
    assert.equal('path' in event, false);
    assert.equal('query' in event, false);
    assert.equal('deviceId' in event, false);
    assert.equal('body' in event, false);
  }
  assert.equal((await f.request('/v1/diagnostics/interactions?limit=1&limit=2', { token: f.diagnosticToken })).status, 400);
});
