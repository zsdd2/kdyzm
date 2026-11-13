import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

let serial = 0;
const at = Date.now() - 3600000;
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
const receipt = items => ({ accepted: items.map(({ id, revision }) => ({ id, revision })),
  issues: items.map(({ id, revision, state }) => ({ id, revision, status: state === 'withdrawn' ? 'ignored' : state === 'resolved' ? 'resolved' : 'pending', retryCount: 0, reasonCode: '', nextRetryAt: 0 })) });
async function harness(run) {
  const storage = new Map(), calls = [], previousFetch = globalThis.fetch;
  globalThis.uni = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), $emit() {} };
  globalThis.window = { addEventListener() {} };
  const fixture = { capabilities: ['recognition_workflow_v1'], revision: 0, binding: 0, trusted: false, upload: async items => response(receipt(items)) };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/v1/devices')) return response({ token: randomBytes(24).toString('hex'), deviceId: 'device-' + (++fixture.binding), accounts: [] });
    if (url.endsWith('/v1/devices/current')) return response({ revoked: true });
    if (new URL(url).pathname === '/v1/snapshot') return response({ schemaVersion: 1, serverRevision: ++fixture.revision,
      accounts: [{ id: 'a', platform: 'jd' }], orders: [{ id: 'o', accountId: 'a', platform: 'jd', title: '合成订单', orderDate: at }],
      shipments: [{ id: 's', orderId: 'o', accountId: 'a', waybillNo: 'JD12345678901', status: 'arrived', station: '示例花园店',
        arrivalAt: fixture.trusted ? at : 0, arrivalAtSource: fixture.trusted ? 'platform_event' : 'unknown', arrivalAtPrecision: fixture.trusted ? 'second' : 'unknown', updatedAt: at }],
      hiddenIds: [], deletedIds: [], capabilities: fixture.capabilities });
    if (url.endsWith('/v1/recognition-issues')) return fixture.upload(JSON.parse(options.body).items, options);
    assert.fail('Unexpected request: ' + url);
  };
  try {
    const api = await import('../app-source/pickcode/services/assistant.js?recognition-test=' + (++serial));
    await api.bindOnline('http://127.0.0.1:8782', 'fixture'); await api.syncOnline();
    await run(api, fixture, calls, storage);
  } finally { await flush(); globalThis.fetch = previousFetch; delete globalThis.uni; delete globalThis.window; }
}
const ingest = api => api.mutate('ingest', { messages: [{ id: 'sms', date: at + 15000,
  body: '【菜鸟驿站】张先生您的包裹已到达示例花园店，取件码7-6-7042。联系电话13800138000' }] });
const uploads = calls => calls.filter(call => call.url.endsWith('/v1/recognition-issues'));

test('能力默认启用异步报告，字段白名单和同版本上传回执，不请求平台采集', async () => {
  await harness(async (api, fixture, calls, storage) => {
    let finish;
    fixture.upload = items => new Promise(resolve => { finish = () => resolve(response({ ...receipt(items),
      accepted: [...receipt(items).accepted, ...receipt(items).accepted, { id: 'other', revision: 1 }],
      issues: [...receipt(items).issues, { id: 'other', revision: 1, status: 'resolved' }] })); });
    const result = await ingest(api);
    assert.ok(finish); assert.equal(result.codes[0].sources[0].linkedShipmentIds.length, 0);
    const call = uploads(calls)[0], sent = JSON.parse(call.options.body);
    assert.equal(call.options.priority, 'low'); assert.equal(sent.schemaVersion, 1);
    assert.deepEqual(sent.items[0].candidateShipmentIds, ['s']);
    assert.equal(sent.items[0].source.fragment, '');
    assert.ok(!call.options.body.includes('13800138000')); assert.ok(!call.options.body.includes('张先生'));
    assert.equal(sent.items[0].source.pickupCode, '');
    assert.equal(sent.items[0].source.waybillNo, '');
    assert.ok(!call.options.body.includes('7042'));
    finish(); await flush();
    assert.equal((await api.getSnapshot()).online.recognitionIssues[0].status, 'pending');
    await api.syncOnline(); await flush();
    assert.equal(uploads(calls).length, 1);
    assert.ok(!JSON.stringify([...storage.values()]).includes('fixture-token-'));
    assert.equal(calls.filter(call => call.url.endsWith('/v1/accounts/sync')).length, 0);
  });
});

test('H5实际发送边界清空旧队列中的取件码运单号，并继续拒绝无效字段', async () => {
  await harness(async (api, fixture, calls) => {
    const dispatch = globalThis.PickCodeCore.dispatch;
    let invalid = false;
    globalThis.PickCodeCore.dispatch = (saved, request) => {
      const value = JSON.parse(dispatch(saved, request));
      if (JSON.parse(request).action === 'recognitionIssueBatch') value.result.items.forEach(item => {
        item.source.pickupCode = invalid ? 'not a code' : '7-6-7042'; item.source.waybillNo = 'JD99999999999';
      });
      return JSON.stringify(value);
    };
    try {
      fixture.upload = async () => response({}, 503);
      await ingest(api); await flush();
      const sent = JSON.parse(uploads(calls)[0].options.body).items[0];
      assert.equal(sent.source.pickupCode, ''); assert.equal(sent.source.waybillNo, '');
      assert.doesNotMatch(uploads(calls)[0].options.body, /7042|JD99999999999/);
      invalid = true; await api.syncOnline(); await flush();
      assert.equal(uploads(calls).length, 1, 'malformed legacy values still fail validation before normalization');
    } finally { globalThis.PickCodeCore.dispatch = dispatch; }
  });
});

test('上传失败保留相同revision且不累计业务retry，正常同步重试', async () => {
  await harness(async (api, fixture, calls) => {
    fixture.upload = async () => response({ error: { message: 'PRIVATE_REMOTE_SECRET' } }, 503);
    await ingest(api); await flush();
    assert.equal((await api.getSnapshot()).online.recognitionIssues[0].retryCount, 0);
    fixture.upload = async items => response(receipt(items)); await api.syncOnline(); await flush();
    assert.deepEqual(JSON.parse(uploads(calls)[0].options.body), JSON.parse(uploads(calls)[1].options.body));
    assert.ok(!JSON.stringify(await api.getSnapshot()).includes('PRIVATE_REMOTE_SECRET'));
  });
});

test('正在上传时本机完成匹配，串行续发resolved新版本', async () => {
  await harness(async (api, fixture, calls) => {
    let finish;
    fixture.upload = items => new Promise(resolve => { finish = () => resolve(response(receipt(items))); });
    await ingest(api);
    fixture.trusted = true; await api.syncOnline();
    assert.equal(uploads(calls).length, 1);
    fixture.upload = async items => response(receipt(items)); finish(); await flush();
    assert.equal(uploads(calls).length, 2);
    const first = JSON.parse(uploads(calls)[0].options.body).items[0], last = JSON.parse(uploads(calls)[1].options.body).items[0];
    assert.equal(last.id, first.id); assert.equal(last.revision, first.revision + 1); assert.equal(last.state, 'resolved');
    assert.equal((await api.getSnapshot()).online.recognitionIssues[0].status, 'resolved');
  });
});

test('旧后台零上传，慢回执遇改绑不能污染新设备记录', async () => {
  await harness(async (api, fixture, calls) => {
    fixture.capabilities = []; await api.syncOnline(); await ingest(api); await flush();
    assert.equal(uploads(calls).length, 0);
    let finish;
    fixture.capabilities = ['recognition_workflow_v1'];
    fixture.upload = items => new Promise(resolve => { finish = () => resolve(response(receipt(items))); });
    await api.syncOnline(); const old = JSON.parse(uploads(calls)[0].options.body).items[0];
    await api.unbindOnline();
    fixture.capabilities = []; await api.bindOnline('http://127.0.0.1:8782', 'fixture'); await api.syncOnline();
    finish(); await flush();
    assert.equal((await api.getSnapshot()).online.recognitionIssues.some(item => item.id === old.id), false);
    assert.equal(uploads(calls).length, 1);
  });
});

test('忽略在途来源会串行撤回并清空业务证据，旧ACK不能复活', async () => {
  await harness(async (api, fixture, calls) => {
    let finish;
    fixture.upload = items => new Promise(resolve => { finish = () => resolve(response(receipt(items))); });
    const snapshot = await ingest(api);
    await api.mutate('ignore', { sourceId: snapshot.codes[0].sources[0].sourceId });
    assert.equal(uploads(calls).length, 1);
    fixture.upload = async items => response(receipt(items)); finish(); await flush();
    assert.equal(uploads(calls).length, 2);
    const before = JSON.parse(uploads(calls)[0].options.body).items[0], after = JSON.parse(uploads(calls)[1].options.body).items[0];
    assert.equal(after.id, before.id); assert.equal(after.revision, before.revision + 1);
    assert.equal(after.state, 'withdrawn'); assert.deepEqual(after.candidateShipmentIds, []);
    assert.deepEqual(after.source, { occurredAt: null, station: '', carrier: '', waybillNo: '', pickupCode: '', fragment: '' });
    assert.equal((await api.getSnapshot()).online.recognitionIssues[0].status, 'ignored');
    await api.syncOnline(); await flush(); assert.equal(uploads(calls).length, 2);
  });
});
