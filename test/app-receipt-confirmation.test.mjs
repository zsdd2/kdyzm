import test from 'node:test';
import assert from 'node:assert/strict';
import '../app-source/pickcode/core/load-core.mjs';
import { parcelJourney } from '../app-source/pickcode/services/parcel-journey.js';
import { Store } from '../src/store.mjs';

const now = Date.now();
const account = { id: 'receipt-account', platform: 'jd', label: '模拟京东' };
const order = { id: 'receipt-order', accountId: account.id, platform: 'jd', platformOrderId: 'synthetic-order', title: '送货上门模拟商品', orderDate: now, orderStatus: '正在出库', tradeStatus: '15' };
const shipment = { id: 'receipt-shipment', orderId: order.id, accountId: account.id, waybillNo: 'SYNTHETIC-RECEIPT', status: 'signed', pickupCode: '', logisticsEvents: [{ time: now, description: '已送达，包裹已放在家门口' }] };
function client() {
  let state = '';
  return (action = 'snapshot', payload = {}) => {
    const response = JSON.parse(globalThis.PickCodeCore.dispatch(state, JSON.stringify({ action, payload })));
    state = JSON.stringify(response.state);
    return response.result;
  };
}
function sync(run, shipments = [shipment], revision = 1, orders = [order]) {
  run('syncMeta', { bound: true, baseUrl: 'https://receipt.example', deviceId: 'receipt-device', accounts: [account] });
  return run('syncImport', { snapshot: { schemaVersion: 1, serverRevision: revision, accounts: [account], orders, shipments, hiddenIds: [], deletedIds: [] }, syncedAt: now });
}

test('无取件码的送达包裹独立等待人工确认，不生成取件码卡片', () => {
  const run = client();
  const result = sync(run);
  assert.equal(result.packages[0].shipments[0].needsReceiptConfirmation, true);
  assert.equal(result.packages[0].shipments[0].isHomeDelivery, true);
  assert.equal(result.packages[0].shipments[0].canPick, true);
  assert.equal(result.packages[0].shipments[0].picked, false);
  assert.equal(result.packages[0].status, 'signed');
  assert.deepEqual(result.codes, []);
  assert.deepEqual(result.operations, []);
});

test('京东和顺丰门口送达复用到达时间，人工确认才记录签收，旧缓存无需等待重采', () => {
  const originalNow = Date.now, deliveredAt = now - 3600000, confirmedAt = now;
  Date.now = () => confirmedAt;
  try {
    for (const variant of [{ platform: 'jd', carrier: '京东快递' }, { platform: 'taobao', carrier: '顺丰速运' }]) {
      const run = client();
      const source = { ...shipment, carrier: variant.carrier, arrivalAt: 0, arrivalAtSource: 'unknown',
        logisticsEvents: [{ time: deliveredAt, timePrecision: 'second', description: '包裹已放在家门口' }] };
      let result = sync(run, [source], 1, [{ ...order, orderDate: now - 86400000, platform: variant.platform }]);
      let current = result.packages[0], parcel = current.shipments[0];
      assert.equal(parcel.arrivalAt, deliveredAt);
      assert.equal(parcel.arrivalAtSource, 'platform_event');
      assert.equal(parcel.arrivalAtPrecision, 'second');
      assert.equal(parcel.picked, false); assert.equal(parcel.pickedAt, 0);
      assert.deepEqual(result.codes, []);
      assert.equal(parcelJourney(parcel, current).points[3].text, '待确认');
      result = run('pickShipments', { orderId: current.id, shipmentIds: [parcel.id], picked: true });
      current = result.packages[0]; parcel = current.shipments[0];
      assert.equal(parcel.pickedAt, confirmedAt);
      assert.equal(parcel.pickedAtSource, 'user_confirmed');
      assert.equal(parcelJourney(parcel, current).points[3].label, '签收');
      assert.equal(parcelJourney(parcel, current).points[3].at, confirmedAt);
      result = sync(run, [source], 2, [{ ...order, orderDate: now - 86400000, platform: variant.platform }]);
      assert.equal(result.packages[0].shipments[0].pickedAt, confirmedAt);
      result = run('pickShipments', { orderId: current.id, shipmentIds: [parcel.id], picked: false });
      assert.equal(result.packages[0].shipments[0].pickedAt, 0);
      assert.equal(result.packages[0].shipments[0].arrivalAt, deliveredAt);
      assert.equal(result.packages[0].shipments[0].needsReceiptConfirmation, true);
    }
  } finally { Date.now = originalNow; }
});

test('门口时间存在冲突副本或无日期站柜后续事实时不补造到达时间', () => {
  const deliveredAt = now - 3600000, delivered = { time: deliveredAt, timePrecision: 'second', description: '包裹已放在家门口' };
  for (const extra of [{ ...delivered, timeText: '2020-01-01 10:00:00' }, { time: 0, description: '已存入幸福菜鸟驿站' }]) {
    const result = sync(client(), [{ ...shipment, carrier: '京东物流', arrivalAt: 0, arrivalAtSource: 'unknown', logisticsEvents: [delivered, extra] }]);
    assert.equal(result.packages[0].shipments[0].arrivalAt, 0);
    assert.equal(parcelJourney(result.packages[0].shipments[0], result.packages[0]).points[2].at, null);
    assert.equal(result.packages[0].shipments[0].picked, false);
  }
});

test('Store无日期站柜事实进入Core后保留平台站点与原始码，不回到旧门口待确认', t => {
  const store = new Store({ key: Buffer.alloc(32, 9), now: () => now, getLogisticsRules: () => globalThis.PickCodeLogistics.defaults() });
  t.after(() => store.close());
  store.saveAccount({ platform: 'jd', label: 'fixture', cookie: 'SYNTHETIC' }, account.id, true);
  for (const description of ['已存入幸福菜鸟驿站', '已放入丰巢快递柜']) {
    store.importResult(account.id, { orders: [{ platformOrderId: order.platformOrderId, orderDate: now }], shipments: [{
      platformOrderId: order.platformOrderId, waybillNo: 'SYNTHETIC-RECEIPT', carrier: '京东物流', status: 'arrived',
      station: '幸福菜鸟驿站', stationSource: 'platform_event', pickupCode: '7-3-1234', arrivalAt: 0, arrivalAtSource: 'unknown',
      logisticsState: 'ok', logisticsCheckedAt: now, logisticsEvents: [
        { time: now - 3600000, timePrecision: 'second', description: '包裹已放在家门口' }, { time: 0, description },
      ],
    }] });
    const snapshot = store.snapshot([account.id]);
    assert.equal(snapshot.shipments[0].station, '幸福菜鸟驿站');
    assert.equal(snapshot.shipments[0].pickupCode, '7-3-1234');
    const response = JSON.parse(globalThis.PickCodeCore.dispatch('', JSON.stringify({ action: 'syncImport', payload: { snapshot } })));
    const verify = result => {
      const parcel = result.packages[0].shipments[0];
      assert.equal(parcel.arrivalAt, 0); assert.equal(parcel.status, 'arrived');
      assert.equal(parcel.station, '幸福菜鸟驿站'); assert.equal(parcel.pickupCode, '7-3-1234');
      assert.equal(parcel.isHomeDelivery, false); assert.equal(parcel.needsReceiptConfirmation, false);
    };
    verify(response.result);
    const cached = response.state.shipments[0];
    cached.station = ''; cached.stationSource = 'unknown'; cached.localLogisticsVersion = 4;
    verify(JSON.parse(globalThis.PickCodeCore.dispatch(JSON.stringify(response.state), JSON.stringify({ action: 'snapshot', payload: {} }))).result);
  }
});

test('无日期实际改派阻止旧门口分类，但真门口时间未知和预计站柜不改变待确认', () => {
  const delivered = { time: now - 3600000, description: '包裹已放在家门口' };
  const redirected = sync(client(), [{ ...shipment, status: 'transit', logisticsEvents: [delivered, { time: 0, description: '已改派重新投递' }] }]).packages[0].shipments[0];
  assert.equal(redirected.status, 'transit'); assert.equal(redirected.isHomeDelivery, false);
  assert.equal(redirected.needsReceiptConfirmation, false);
  for (const later of [[{ time: 0, description: '已改投，重新派送中' }],
    [{ time: 0, description: '已存入幸福菜鸟驿站' }, { time: 0, description: '已改投，重新派送中' }]]) {
    const parcel = sync(client(), [{ ...shipment, status: 'arrived', station: '幸福菜鸟驿站', stationSource: 'platform_event',
      arrivalAt: 0, arrivalAtSource: 'unknown', pickupCode: '7-3-1234', logisticsEvents: [delivered, ...later] }]).packages[0].shipments[0];
    assert.equal(parcel.station, ''); assert.equal(parcel.pickupCode, '');
    assert.equal(parcel.arrivalAt, 0); assert.equal(parcel.needsReceiptConfirmation, false);
  }
  for (const events of [[{ ...delivered, time: 0 }], [delivered, { time: 0, description: '预计存入幸福菜鸟驿站' }],
    [delivered, { time: 0, description: '未能存入丰巢快递柜，入柜失败' }]]) {
    const parcel = sync(client(), [{ ...shipment, pickupCode: 'OLD-1234', station: '历史驿站', logisticsEvents: events }]).packages[0].shipments[0];
    assert.equal(parcel.isHomeDelivery, true); assert.equal(parcel.needsReceiptConfirmation, true);
    assert.equal(parcel.pickupCode, '');
  }
});

test('多运单逐件确认、全部收齐才结束，重复同步不撤销人工收货，支持撤销', () => {
  const run = client();
  const ships = [shipment, { ...shipment, id: 'second-shipment', waybillNo: 'SYNTHETIC-SECOND' }];
  let result = sync(run, ships);
  const localOrderId = result.packages[0].id;
  const ids = result.packages[0].shipments.map(s => s.id);
  result = run('pickShipments', { orderId: localOrderId, shipmentIds: [ids[0]], picked: true });
  assert.equal(result.packages[0].status, 'signed');
  assert.deepEqual(result.packages[0].shipments.map(s => s.needsReceiptConfirmation), [false, true]);
  assert.equal(result.operations[0].shipmentId, shipment.id);
  result = sync(run, ships, 2);
  assert.equal(result.packages[0].shipments[0].picked, true);
  result = run('pickShipments', { orderId: localOrderId, shipmentIds: [ids[1]], picked: true });
  assert.equal(result.packages[0].status, 'picked');
  assert.ok(result.packages[0].shipments.every(s => !s.needsReceiptConfirmation));
  assert.ok(result.packages[0].shipments.every(s => s.isHomeDelivery));
  result = run('pickShipments', { orderId: localOrderId, shipmentIds: [ids[0]], picked: false });
  assert.equal(result.packages[0].shipments[0].needsReceiptConfirmation, true);
  assert.equal(result.operations.at(-1).action, 'restore');
});

test('驿站代收、取件码、到站、在途和隐藏包裹不进入送到家待确认', () => {
  const run = client();
  const variants = [
    { ...shipment, id: 'station', logisticsEvents: [{ time: now, description: '驿站已代收签收，请到站取件' }] },
    { ...shipment, id: 'coded', pickupCode: '7-8-9012', arrivalAt: now, logisticsEvents: [{ time: now, description: '已签收' }] },
    { ...shipment, id: 'arrived', status: 'arrived', logisticsEvents: [{time:now,description:'包裹已到达菜鸟驿站'}] },
    { ...shipment, id: 'transit', status: 'transit', logisticsEvents: [{time:now,description:'包裹正在运输中'}] },
    { ...shipment, id: 'hidden', hidden: true },
    { ...shipment, id: 'picked', picked: true },
  ].map((s, index) => ({ ...s, waybillNo: 'SYNTHETIC-' + index }));
  const result = sync(run, variants);
  assert.ok(result.packages[0].shipments.every(s => s.needsReceiptConfirmation === false));
  assert.equal(result.packages[0].shipments[0].isHomeDelivery, false);
});

test('驿站门口和既有驿站泛签收不当作到家，当前到家可越过历史原始码', () => {
  for (const variant of [
    { ...shipment, logisticsEvents: [{ time: now, description: '您的快件已送到菜鸟驿站门口' }] },
    { ...shipment, station: '菜鸟驿站', logisticsEvents: [{ time: now, description: '已签收' }] },
  ]) {
    const item = sync(client(), [variant]).packages[0].shipments[0];
    assert.equal(item.isHomeDelivery, false);
    assert.equal(item.needsReceiptConfirmation, false);
  }
  for (const description of ['已送达，包裹已放到家门口', '包裹已经放在家门口', '您的快件已投递到门口', '您的快件已成功送达家门口', '已派送到家门口']) {
    const result = sync(client(), [{ ...shipment, arrivalAt: now, station: '历史驿站', pickupCode: '7-8-9012', logisticsEvents: [{ time: now, description }] }]);
    assert.deepEqual(result.codes, []);
    assert.equal(result.packages[0].shipments[0].needsReceiptConfirmation, true, description);
    assert.equal(result.packages[0].shipments[0].pickupCode, '', '原始历史码保存在内部，不冒充当前送到家的取件码');
  }
});

test('撤销账号授权后待确认信息可保留，但不能确认或向后台写入', () => {
  const run = client();
  const result = sync(run);
  const item = result.packages[0];
  run('syncMeta', { bound: false, baseUrl: '', deviceId: '', accounts: [] });
  assert.equal(run().packages[0].shipments[0].canPick, false);
  assert.throws(() => run('pickShipments', { orderId: item.id, shipmentIds: [item.shipments[0].id] }), /绑定|账号|运单/);
  assert.deepEqual(run().operations, []);
});

test('京东单号不代表已发货，实际运输到站和送达优先，其他平台不变', () => {
  for (const [platform, status, waybillNo, expected] of [
    ['jd', 'unknown', 'SYNTHETIC-JD', 'unknown'], ['jd', 'unknown', '', 'unknown'],
    ['jd', 'transit', 'SYNTHETIC-JD', 'transit'],
    ['jd', 'arrived', 'SYNTHETIC-JD', 'arrived'], ['jd', 'signed', 'SYNTHETIC-JD', 'signed'],
    ['taobao', 'unknown', 'SYNTHETIC-TB', 'unknown'], ['pdd', 'unknown', 'SYNTHETIC-PDD', 'unknown'],
  ]) {
    const run = client();
    const result = sync(run, [{ ...shipment, status, waybillNo, logisticsEvents: [] }], 1, [{ ...order, platform }]);
    assert.equal(result.packages[0].shipments[0].status, expected, platform + ':' + status);
    if (expected === 'transit') assert.equal(result.packages[0].status, 'transit');
  }
});

test('京东修正快照清除历史错误运输状态与发货时间，并保留真实到站', () => {
  const run = client();
  const warehouse = { ...shipment, status: 'transit', updatedAt: now, logisticsCheckedAt: now,
    shippedAt: now - 60000, shippedAtSource: 'platform_event', shippedAtPrecision: 'minute',
    logisticsEvents: [{ time: now - 60000, description: '您的订单已进入仓库，准备出库' }] };
  sync(run, [warehouse]);
  let result = sync(run, [{ ...warehouse, status: 'unknown', shippedAt: 0, shippedAtSource: 'unknown', shippedAtPrecision: 'unknown' }], 2);
  assert.equal(result.packages[0].status, 'unknown');
  assert.equal(result.packages[0].shipments[0].status, 'unknown');
  assert.equal(result.packages[0].shipments[0].shippedAt, 0);
  assert.equal(result.packages[0].shipments[0].shippedAtSource, 'unknown');
  assert.equal(run().packages[0].shipments[0].status, 'unknown');
  result = sync(run, [{ ...warehouse, status: 'unknown', arrivalAt: now, arrivalAtSource: 'platform_event', arrivalAtPrecision: 'minute', station: '测试驿站',
    logisticsEvents: [{ time: now, description: '包裹已到达测试驿站，请及时取件' }] }], 3);
  assert.equal(result.packages[0].shipments[0].status, 'arrived');
});
