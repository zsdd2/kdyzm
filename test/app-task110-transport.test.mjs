import test from 'node:test';
import assert from 'node:assert/strict';

let serial = 0;

const response = (data, status = 200, etag = '"fixture"') => new Response(
  JSON.stringify(data),
  { status, headers: { 'Content-Type': 'application/json', ETag: etag } },
);

const account = { id: 'account-a', platform: 'jd', label: '合成账号', status: 'ok', enabled: true, lastFullSuccessAt: Date.now() };
const remoteOrderId = '1'.repeat(32);
const remoteShipmentId = '2'.repeat(32);
const platformView = {
  version: 1,
  status: 'arrived',
  deliveryMode: 'station',
  requiresReceiptConfirmation: false,
  station: { id: 'station-a', name: '示例站', subLocation: '5号柜', displayName: '示例站5号柜', conflict: false },
  courierPhones: [],
  quality: Object.fromEntries(['arrivalTime', 'shippedTime', 'station', 'courier']
    .map(key => [key, { state: 'unknown', reasonCode: 'UPSTREAM_MISSING' }])),
  evidenceKey: 'evidence-1',
};
const fullSnapshot = (extra = {}) => ({
  schemaVersion: 1,
  serverRevision: 1,
  serverVersion: '3.1.52-task110',
  capabilities: ['compact_snapshot_v1', 'shipment_details_v1'],
  accounts: [account],
  orders: [{ id: remoteOrderId, accountId: account.id, platform: 'jd', title: '合成包裹', orderDate: Date.now() - 86400000 }],
  shipments: [{
    id: remoteShipmentId,
    orderId: remoteOrderId,
    accountId: account.id,
    waybillNo: 'JD1234567890123',
    carrier: '京东',
    status: 'arrived',
    updatedAt: Date.now(),
    platformView,
    logisticsEvents: [],
    logisticsState: 'ok',
    detailsAvailable: true,
  }],
  hiddenIds: [],
  deletedIds: [],
  syncJobs: [],
  dataVersion: 'a'.repeat(64),
  ...extra,
});

async function preview(run, fixture = {}) {
  const storage = new Map();
  const calls = [];
  const original = { fetch: globalThis.fetch, uni: globalThis.uni, window: globalThis.window };
  const state = {
    snapshot: fullSnapshot(),
    revision: 1,
    metadataOnly: false,
    details: null,
    ...fixture,
  };
  globalThis.uni = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    $emit() {},
  };
  globalThis.window = { addEventListener() {} };
  globalThis.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    const method = options.method || 'GET';
    calls.push({ method, path: parsed.pathname, search: parsed.search, options });
    if (parsed.pathname === '/v1/devices') return response({ token: 'fixture', deviceId: 'device-a', accounts: [account] });
    if (parsed.pathname === '/v1/snapshot') {
      if (typeof state.snapshotResponse === 'function') return state.snapshotResponse(parsed, options, state);
      return response(state.snapshot, 200, '"fixture-' + state.revision + '"');
    }
    if (parsed.pathname === '/v1/accounts/sync') {
      state.platformSyncs = (state.platformSyncs || 0) + 1;
      return response({ accepted: true, jobs: [] });
    }
    if (parsed.pathname === '/v1/devices/current') return response({ revoked: true });
    if (parsed.pathname.startsWith('/v1/shipments/') && parsed.pathname.endsWith('/logistics')) {
      state.detailRequests = (state.detailRequests || 0) + 1;
      if (typeof state.details === 'function') return state.details(parsed, options, state);
      return response(state.details || {
        shipmentId: remoteShipmentId,
        orderId: remoteOrderId,
        evidenceKey: 'evidence-1',
        logisticsState: 'ok',
        logisticsTruncated: false,
        logisticsEvents: [{ time: Date.now(), description: '已到达示例站' }],
      });
    }
    throw new Error(`Unexpected fixture URL: ${method} ${parsed.pathname}${parsed.search}`);
  };
  try {
    const api = await import(`../app-source/pickcode/services/assistant.js?task110-transport=${++serial}`);
    await api.bindOnline('http://127.0.0.1:8798', 'fixture-code');
    await run(api, state, calls, storage);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

test('H5扫描短信只执行本地扫描，不触发平台采集请求', async () => {
  await preview(async (api, state, calls) => {
    const result = await api.scanAndMatch();
    assert.match(result.smsError, /Android/);
    assert.equal(state.platformSyncs || 0, 0);
    assert.deepEqual(calls.map(call => call.path), ['/v1/devices']);
  });
});

test('compact metadata-only响应保留本地订单和运单实体，只更新元数据', async () => {
  await preview(async (api, state, calls) => {
    const first = await api.syncOnline(false);
    const localOrderId = first.packages[0].id;
    const localShipmentId = first.packages[0].shipments[0].id;
    const dataVersion = first.online.dataVersion;
    assert.ok(dataVersion);
    state.revision = 2;
    state.snapshotResponse = parsed => {
      assert.equal(parsed.searchParams.get('view'), 'compact');
      assert.equal(parsed.searchParams.get('dataVersion'), dataVersion);
      return response({
        ...state.snapshot,
        serverRevision: 2,
        dataVersion,
        metadataOnly: true,
        accounts: [{ ...account, label: '后台改名' }],
        orders: undefined,
        shipments: undefined,
        hiddenIds: undefined,
        deletedIds: undefined,
        events: undefined,
      }, 200, '"fixture-meta"');
    };
    const next = await api.syncOnline(false);
    assert.equal(next.online.accounts[0].label, '后台改名');
    assert.equal(next.packages[0].id, localOrderId);
    assert.equal(next.packages[0].shipments[0].id, localShipmentId);
    assert.equal(next.packages[0].shipments[0].waybillNo, 'JD1234567890123');
    assert.equal(calls.filter(call => call.path === '/v1/accounts/sync').length, 0);
  });
});

test('UTF-8超限响应拒绝导入并保留实体与同步游标', async () => {
  await preview(async (api, state) => {
    const first = await api.syncOnline(false);
    state.snapshotResponse = () => response({ ...state.snapshot, serverRevision: 99, padding: '汉'.repeat(1400000) }, 200, '"oversize"');
    const next = await api.syncOnline(false);
    assert.match(next.online.error, /响应过大/);
    assert.equal(next.online.dataVersion, first.online.dataVersion);
    assert.equal(next.online.serverRevision, first.online.serverRevision);
    assert.deepEqual(next.packages, first.packages);
  });
});

test('物流详情按需请求单独接口并导入局部轨迹，重复请求共享同一加载', async () => {
  await preview(async (api, state, calls) => {
    const initial = await api.syncOnline(false);
    const shipment = initial.packages[0].shipments[0];
    assert.equal(shipment.detailState, 'not_loaded');
    state.details = {
      shipmentId: remoteShipmentId,
      orderId: remoteOrderId,
      evidenceKey: 'evidence-1',
      logisticsState: 'ok',
      logisticsTruncated: false,
      logisticsEvents: [{ time: Date.now(), description: '已到达示例站' }],
    };
    const [first, second] = await Promise.all([
      api.loadShipmentDetails(shipment.id),
      api.loadShipmentDetails(shipment.id),
    ]);
    assert.equal(state.detailRequests, 1);
    assert.equal(first.packages[0].shipments[0].detailState, 'loaded');
    assert.equal(second.packages[0].shipments[0].detailState, 'loaded');
    assert.equal(second.packages[0].shipments[0].logisticsEvents.length, 1);
    assert.equal(calls.filter(call => call.path.endsWith('/logistics')).length, 1);
    assert.equal(calls.filter(call => call.path === '/v1/snapshot').length, 1);
  });
});
