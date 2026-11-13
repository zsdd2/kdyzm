import test from 'node:test';
import assert from 'node:assert/strict';
import '../app-source/pickcode/core/load-core.mjs';
import { Store } from '../src/store.mjs';
import { readKey } from '../src/security.mjs';
import { createCollector } from '../src/collectors.mjs';
import { shipmentDetails } from '../src/client-snapshot.mjs';
import { parcelJourney } from '../app-source/pickcode/services/parcel-journey.js';
import { packageProgressMatches, shipmentProgress, summarizePackages } from '../app-source/pickcode/core/package-presentation.js';

const KEY = readKey('ab'.repeat(32));
const now = Date.now() - 1000;

function client() {
  let state = '';
  const run = (action = 'snapshot', payload = {}) => {
    const response = JSON.parse(globalThis.PickCodeCore.dispatch(state, JSON.stringify({ action, payload })));
    state = JSON.stringify(response.state);
    return response.result;
  };
  return run;
}

function pairFamily(store, familyId, name = 'App fixture') {
  return store.redeem(store.createPairing({ familyIds: [familyId] }).code, name);
}

function importSnapshot(run, snapshot) {
  return run('syncImport', { syncedAt: now, snapshot });
}

function importShipmentDetail(run, store, device, shipment) {
  const target = run('shipmentDetailTarget', { id: shipment.id });
  const detail = shipmentDetails(store, store.device(device.token), target.remoteId);
  return run('importShipmentDetails', { ...detail, id: target.id, bindingKey: target.bindingKey });
}

function jdResult() {
  return {
    orders: [
      { platformOrderId: 'jd-pending', title: '京东待发货', orderDate: now, tradeStatus: 'WAIT_SELLER_SEND_GOODS' },
      { platformOrderId: 'jd-transit', title: '京东运输中', orderDate: now, tradeStatus: 'WAIT_RECEIVE' },
      { platformOrderId: 'jd-pickup', title: '京东待取件', orderDate: now, tradeStatus: 'FINISHED' },
    ],
    shipments: [
      { platformOrderId: 'jd-transit', waybillNo: 'JDTRANSIT001', carrier: '京东物流', status: 'transit' },
      { platformOrderId: 'jd-pickup', waybillNo: 'JDPICKUP001', carrier: '京东物流', status: 'arrived', pickupCode: '6-8-2041', station: '京东驿站', arrivalAt: now },
    ],
  };
}

test('家人组授权后新增无订单JD账号仍进入旧同步核心online.accounts', t => {
  const store = new Store({ key: KEY });
  t.after(() => store.close());
  const family = store.saveFamily({ name: 'JD家人' }, 'family-jd');
  const taobao = store.saveAccount({ platform: 'taobao', label: '旧淘宝', familyId: family.id, cookie: 'fixture' }, 'account-taobao', true);
  const device = pairFamily(store, family.id);
  const run = client();
  run('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: device.deviceId, accounts: device.accounts, familyIds: device.familyIds });
  importSnapshot(run, store.snapshot(store.device(device.token)));

  const jd = store.saveAccount({ platform: 'jd', label: '新增京东', familyId: family.id, cookie: 'fixture' }, 'account-jd', true);
  const snapshot = store.snapshot(store.device(device.token));
  assert.deepEqual(snapshot.orders, []);
  assert.deepEqual(snapshot.accounts.map(account => account.id), [taobao.id, jd.id].sort());
  const result = importSnapshot(run, snapshot);
  assert.equal(result.online.accounts.find(account => account.id === jd.id).platform, 'jd');
  assert.equal(result.online.accounts.find(account => account.id === jd.id).label, '新增京东');
});

test('导入JD待发货、在途和待取件记录后App packages与codes均可见', t => {
  const store = new Store({ key: KEY });
  t.after(() => store.close());
  const family = store.saveFamily({ name: 'JD记录家人' }, 'family-jd-records');
  const jd = store.saveAccount({ platform: 'jd', label: '记录京东', familyId: family.id, cookie: 'fixture' }, 'account-jd-records', true);
  const device = pairFamily(store, family.id);
  store.importResult(jd.id, jdResult());

  const run = client();
  run('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: device.deviceId, accounts: device.accounts, familyIds: device.familyIds });
  const result = importSnapshot(run, store.snapshot(store.device(device.token)));
  assert.deepEqual(result.packages.map(packageItem => packageItem.title).sort(), ['京东待发货', '京东待取件', '京东运输中']);
  assert.equal(result.packages.find(packageItem => packageItem.title === '京东待发货').tradeStatus, 'WAIT_SELLER_SEND_GOODS');
  assert.equal(result.packages.find(packageItem => packageItem.title === '京东运输中').status, 'transit');
  assert.equal(result.packages.find(packageItem => packageItem.title === '京东待取件').status, 'pending');
  assert.equal(result.codes.length, 1);
  assert.equal(result.codes[0].code, '6-8-2041');
  assert.equal(result.codes[0].members[0].platform, 'jd');
});

test('旧版淘宝/PDD账号授权不自动扩权到JD，切换家人scope后可见', t => {
  const store = new Store({ key: KEY });
  t.after(() => store.close());
  const family = store.saveFamily({ name: '旧授权家人' }, 'family-legacy');
  const taobao = store.saveAccount({ platform: 'taobao', label: '旧淘宝', familyId: family.id, cookie: 'fixture' }, 'account-legacy-taobao', true);
  const pdd = store.saveAccount({ platform: 'pdd', label: '旧拼多多', familyId: family.id, cookie: 'fixture' }, 'account-legacy-pdd', true);
  const jd = store.saveAccount({ platform: 'jd', label: '同家人京东', familyId: family.id, cookie: 'fixture' }, 'account-legacy-jd', true);
  const device = store.redeem(store.createPairing({ accountIds: [taobao.id, pdd.id] }).code, '旧版App');
  const oldSnapshot = store.snapshot(store.device(device.token));
  assert.deepEqual(oldSnapshot.accounts.map(account => account.id), [pdd.id, taobao.id]);
  assert.equal(oldSnapshot.accounts.some(account => account.id === jd.id), false);

  const run = client();
  run('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: device.deviceId, accounts: oldSnapshot.accounts });
  let result = importSnapshot(run, oldSnapshot);
  assert.equal(result.online.accounts.some(account => account.id === jd.id), false);

  store.updateDevice(device.deviceId, { familyIds: [family.id], accountIds: [] });
  const familySnapshot = store.snapshot(store.device(device.token));
  assert.equal(familySnapshot.accounts.some(account => account.id === jd.id), true);
  result = importSnapshot(run, familySnapshot);
  assert.equal(result.online.accounts.find(account => account.id === jd.id).platform, 'jd');
});

test('京东出库时普通同步补入单号和打印轨迹，仍待发货且发货节点未完成', async t => {
  const store = new Store({ key: KEY });
  t.after(() => store.close());
  const family = store.saveFamily({ name: '仓库阶段家人' });
  const jd = store.saveAccount({ platform: 'jd', label: '仓库京东', familyId: family.id, cookie: 'fixture' }, 'account-warehouse', true);
  const device = pairFamily(store, family.id);
  const run = client();
  run('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: device.deviceId, accounts: store.snapshot(store.device(device.token)).accounts });
  let printed = false, detailCalls = 0;
  const collect = createCollector({ now: () => now, fetchImpl: async url => {
    const detail = new URL(url).searchParams.get('functionId') === 'pcdetail_traceMultiPackage';
    if (!detail) return new Response(JSON.stringify({ success: true, data: { totalNum: 1, orderList: [{
      orderId: 'synthetic-warehouse', orderType: 0, dateSubmit: '2026-11-01 10:00:00',
      statusInfo: { orderState: 15, orderStateName: '正在出库' }, wareList: [{ name: '模拟商品', wareType: 0 }],
    }] } }));
    detailCalls++;
    return new Response(JSON.stringify({ multiPackageTrackInfoList: printed ? [{
      carriageInfo: { carriageId: 'SYNTHETIC-JD-PRINT', carrier: '京东快递' },
      trackGroupInfo: { orderTrackShowList: [{ CreationTime: '2026-11-01 10:30:00', StatusName: '仓库处理中', Content: '您的订单已经打印完成' }] },
    }] : [] }));
  } });
  store.importResult(jd.id, await collect(jd, 'thor=FAKE'));
  let result = importSnapshot(run, store.snapshot(store.device(device.token)));
  assert.equal(result.packages[0].shipments.length, 0);
  printed = true;
  const previous = store.snapshot([jd.id]);
  store.importResult(jd.id, await collect(jd, 'thor=FAKE', {
    knownOrders: previous.orders.map(order => ({ ...order, shipments: previous.shipments.filter(s => s.orderId === order.id) })),
    trackedOrderIds: [],
  }));
  result = importSnapshot(run, store.snapshot(store.device(device.token)));
  const item = result.packages[0];
  assert.equal(detailCalls, 2, '没有运单的出库订单在下一轮普通同步仍会查询详情');
  assert.equal(item.orderStatus, '正在出库');
  assert.equal(item.status, 'unknown');
  assert.equal(item.shipments[0]?.waybillNo, 'SYNTHETIC-JD-PRINT');
  assert.equal(item.shipments[0].status, 'unknown');
  assert.equal(item.shipments[0].shippedAt, 0);
  assert.equal(packageProgressMatches(item, 'waiting'), true);
  assert.equal(packageProgressMatches(item, 'transit'), false);
  const journey = parcelJourney(item.shipments[0], item);
  assert.equal(journey.currentIndex, 0);
  assert.equal(journey.points[1].state, 'pending');
  assert.equal(journey.points[1].at, null);
  assert.equal(item.shipments[0].logisticsState, 'ok');
  const loaded = importShipmentDetail(run, store, device, item.shipments[0]);
  assert.match(loaded.packages[0].shipments[0].logisticsEvents[0].description, /仓库处理中.*订单已经打印完成/);
});

test('京东订单已发货但当前包裹明确待揽收时仍进入未收到，不借用同单其他包裹证据', t => {
  const store = new Store({ key: KEY });
  t.after(() => store.close());
  const family = store.saveFamily({ name: '待揽收家人' });
  const jd = store.saveAccount({ platform: 'jd', label: '待揽收京东', familyId: family.id, cookie: 'fixture' }, 'account-awaiting-collection', true);
  const device = pairFamily(store, family.id);
  const run = client();
  run('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: device.deviceId, accounts: store.snapshot(store.device(device.token)).accounts });
  store.importResult(jd.id, {
    orders: [{ platformOrderId: 'synthetic-collection', title: '等待揽收商品', orderDate: now,
      orderStatus: '已发货', tradeStatus: 'WAIT_RECEIVE' }],
    shipments: [
      { platformOrderId: 'synthetic-collection', waybillNo: 'SYNTHETIC-WAIT', status: 'transit',
        logisticsCheckedAt: now, logisticsEvents: [{ time: now - 1000, description: '已发货：包裹正在等待揽收' }] },
      { platformOrderId: 'synthetic-collection', waybillNo: 'SYNTHETIC-UNKNOWN', status: 'unknown', logisticsEvents: [] },
    ],
  });
  const result = importSnapshot(run, store.snapshot(store.device(device.token)));
  const item = result.packages[0];
  const waiting = item.shipments.find(ship => ship.waybillNo === 'SYNTHETIC-WAIT');
  const unknown = item.shipments.find(ship => ship.waybillNo === 'SYNTHETIC-UNKNOWN');
  importShipmentDetail(run, store, device, waiting);
  const loaded = run(), loadedItem = loaded.packages[0];
  const loadedWaiting = loadedItem.shipments.find(ship => ship.waybillNo === 'SYNTHETIC-WAIT');
  assert.equal(waiting.status, 'unknown');
  assert.equal(waiting.shippedAt, 0);
  assert.equal(shipmentProgress(loadedWaiting, loadedItem), 'waiting');
  assert.equal(shipmentProgress(unknown, item), 'other');
  assert.equal(packageProgressMatches(item, 'all'), true);
  assert.equal(packageProgressMatches(item, 'waiting'), true);
  assert.equal(packageProgressMatches(item, 'transit'), false);
  assert.equal(summarizePackages([item]).total, 1);
  assert.equal(summarizePackages([item]).waiting, 1);
  assert.equal(parcelJourney(waiting, item).points[1].state, 'pending');
});
