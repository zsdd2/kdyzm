import test from 'node:test';
import assert from 'node:assert/strict';

const NOW = 1800000000000;
const STALE = 30 * 60000;
let serial = 0;
const account = (id, completedAt, extra = {}) => ({ id, platform: 'jd', label: id, status: 'ok', enabled: true,
  lastSuccessAt: NOW, lastFullSuccessAt: completedAt, ...extra });

async function harness(run) {
  const storage = new Map(), calls = [];
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  const state = { now: NOW, unchanged: false, started: [], snapshot: {
    schemaVersion: 1, serverRevision: 1, capabilities: ['syncJobs', 'orderRefresh', 'conditionalSync'],
    accounts: [], orders: [], shipments: [], hiddenIds: [], deletedIds: [], syncJobs: []
  } };
  Date.now = () => state.now;
  globalThis.uni = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value), $emit() {} };
  globalThis.window = { addEventListener() {} };
  const response = data => new Response(JSON.stringify(data), { status: 200, headers: { ETag: '"fixture-' + state.snapshot.serverRevision + '"' } });
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url), path = parsed.pathname;
    calls.push({ path, search: parsed.search, method: options.method || 'GET', headers: options.headers, body: options.body ? JSON.parse(options.body) : undefined });
    if (path === '/v1/devices') return response({ token: 'fixture', deviceId: 'device-a', accounts: state.snapshot.accounts });
    if (path === '/v1/snapshot') return state.unchanged ? new Response(null, { status: 304 }) : response(state.snapshot);
    if (path === '/v1/accounts/sync' || /^\/v1\/orders\/.+\/refresh$/.test(path)) {
      if (state.started.length) { state.snapshot.syncJobs = structuredClone(state.started); state.snapshot.serverRevision++; }
      return response({ accepted: true, jobs: state.started });
    }
    throw new Error('Unexpected request: ' + path);
  };
  try {
    const api = await import('../app-source/pickcode/services/assistant.js?conditional-sync=' + (++serial));
    await api.bindOnline('http://127.0.0.1:8781', 'fixture-code');
    await run(api, state, calls, storage);
  } finally {
    Date.now = originalNow; globalThis.fetch = originalFetch;
    delete globalThis.uni; delete globalThis.window;
  }
}

test('先拉最新缓存，按账号整轮采集时间判断，跳过停用、失效及已有任务的账号', async () => {
  await harness(async (api, state, calls) => {
    state.snapshot.accounts = [account('fresh', NOW - 1000), account('boundary', NOW - STALE),
      account('disabled', 0, { enabled: false }), account('expired', 0, { status: 'expired' }), account('pending', 0)];
    state.snapshot.syncJobs = [{ id: 'existing', accountId: 'pending', state: 'running' }];
    let result = await api.syncOnline(false);
    assert.equal(calls.filter(call => call.method === 'POST' && call.path.endsWith('/sync')).length, 0);
    assert.equal(result.online.accounts.find(row => row.id === 'disabled').enabled, false);
    assert.ok(result.online.capabilities.includes('conditionalSync'));
    state.snapshot.accounts.push(account('stale', NOW - STALE - 1));
    state.snapshot.serverRevision++;
    state.started = [{ id: 'new-job', accountId: 'stale', state: 'queued' }];
    result = await api.syncOnline(false);
    assert.equal(result.online.lastSuccessAt, NOW, '设备缓存同步时间不能替代账号采集时间');
    const requests = calls.filter(call => call.path === '/v1/accounts/sync');
    assert.equal(requests.length, 1); assert.deepEqual(requests[0].body, { onlyIfStale: true });
    await api.syncOnline(false);
    assert.equal(calls.filter(call => call.path === '/v1/accounts/sync').length, 1, '已有任务时继续读缓存，不重复发起');
    assert.ok(calls.filter(call => call.path === '/v1/snapshot').slice(1).every(call => call.headers['If-None-Match']));
  });
});

test('后台已更新时采用首次GET的新时间，304时仍跨过严格30分钟边界且空条件结果正常', async () => {
  await harness(async (api, state, calls) => {
    state.snapshot.accounts = [account('account-a', NOW - STALE)];
    const first = await api.syncOnline(false);
    assert.equal(first.online.accounts[0].lastFullSuccessAt, NOW - STALE);
    assert.equal(calls.filter(call => call.path === '/v1/accounts/sync').length, 0);
    state.now++; state.unchanged = true;
    const result = await api.syncOnline(false);
    assert.equal(result.online.error, '');
    assert.equal(result.online.accounts[0].lastFullSuccessAt, NOW - STALE);
    assert.equal(calls.filter(call => call.path === '/v1/accounts/sync').length, 1);
    assert.equal(calls.filter(call => call.path === '/v1/snapshot').length, 2, '空条件结果不追加全量读取');
    state.unchanged = false; state.snapshot.serverRevision++;
    state.snapshot.accounts[0].lastFullSuccessAt = state.now;
    await api.syncOnline(false);
    assert.equal(calls.filter(call => call.path === '/v1/accounts/sync').length, 1, '先GET后判断，不能用之前的旧缓存发起');
    assert.ok(calls.filter(call => call.path === '/v1/snapshot')[0].search.startsWith('?view=compact'));
  });
});

test('缺失、非法及未来整轮采集时间均视为过期，不能借用单单成功时间', async () => {
  await harness(async (api, state, calls) => {
    for (const value of [undefined, null, 0, -1, '1800000000000', 'invalid', NOW + 1, NOW - 0.5]) {
      state.snapshot.accounts = [account('account-a', value)];
      state.snapshot.serverRevision++;
      const result = await api.syncOnline(false);
      assert.equal(result.online.error, '');
    }
    assert.equal(calls.filter(call => call.path === '/v1/accounts/sync').length, 8);
  });
});

test('旧投影升级时相同后台revision也重新导入新能力和采集时间，之后恢复ETag', async () => {
  await harness(async (api, state, calls, storage) => {
    state.snapshot.accounts = [account('account-a', NOW)];
    await api.syncOnline(false);
    const saved = JSON.parse(storage.get('pickcode.private.state.v1'));
    saved.online.importVersion = 324;
    saved.online.capabilities = ['syncJobs'];
    delete saved.online.accounts[0].lastFullSuccessAt;
    delete saved.online.accounts[0].enabled;
    storage.set('pickcode.private.state.v1', JSON.stringify(saved));
    const upgraded = await api.syncOnline(false);
    assert.equal(calls.filter(call => call.path === '/v1/snapshot')[1].headers['If-None-Match'], undefined);
    assert.ok(upgraded.online.capabilities.includes('conditionalSync'));
    assert.equal(upgraded.online.accounts[0].lastFullSuccessAt, NOW);
    assert.equal(upgraded.online.importVersion, 328);
    state.unchanged = true;
    await api.syncOnline(false);
    assert.ok(calls.filter(call => call.path === '/v1/snapshot')[2].headers['If-None-Match']);
    assert.equal(calls.filter(call => call.path === '/v1/accounts/sync').length, 0);
  });
});

test('旧后台自动只读缓存，新旧后台的手动刷新均不受30分钟限制', async () => {
  await harness(async (api, state, calls) => {
    state.snapshot.capabilities = ['syncJobs'];
    state.snapshot.accounts = [account('account-a', 0)];
    await api.syncOnline(false);
    assert.equal(calls.filter(call => call.path === '/v1/accounts/sync').length, 0);
    await api.syncOnline(true);
    state.snapshot.capabilities.push('conditionalSync');
    state.snapshot.accounts[0].lastFullSuccessAt = NOW;
    state.snapshot.serverRevision++;
    await api.syncOnline(true);
    assert.deepEqual(calls.filter(call => call.path === '/v1/accounts/sync').map(call => call.body), [{}, {}]);
  });
});

test('单订单任务阻止同账号自动补采集，定向刷新不改整账号采集时间', async () => {
  await harness(async (api, state, calls) => {
    const orderId = 'a'.repeat(32), completedAt = NOW - STALE - 1;
    state.snapshot.accounts = [account('account-a', completedAt)];
    state.snapshot.orders = [{ id: orderId, accountId: 'account-a', platform: 'jd', title: 'fixture', orderDate: NOW - 86400000 }];
    state.snapshot.syncJobs = [{ id: 'order-job', accountId: 'account-a', orderId, state: 'running' }];
    let result = await api.syncOnline(false);
    assert.equal(calls.filter(call => call.path === '/v1/accounts/sync').length, 0);
    state.started = [{ id: 'order-job', accountId: 'account-a', orderId, state: 'completed' }];
    result = (await api.refreshOrder(result.packages[0].id)).snapshot;
    assert.equal(result.online.accounts[0].lastFullSuccessAt, completedAt);
    assert.deepEqual(calls.find(call => call.path === '/v1/orders/' + orderId + '/refresh').body, {});
  });
});
