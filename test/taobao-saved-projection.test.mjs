import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, stableId } from '../src/store.mjs';
import { clientSnapshot, shipmentDetails } from '../src/client-snapshot.mjs';

const now = Date.parse('2026-11-13T12:00:00+08:00');
const arrival = Date.parse('2026-11-13T11:28:00+08:00');
const event = (timeText, description, providerStatus = 'doing', time = 0) => ({
  provider: 'taobao', providerStatus, time, timeText, timePrecision: time ? 'minute' : 'unknown', description, location: ''
});
function fixture(t, orderPatch = {}, shipmentPatch = {}) {
  const store = new Store({ key: Buffer.alloc(32, 1), now: () => now, getLogisticsRules: () => [] });
  t.after(() => store.close());
  store.saveAccount({ platform: 'taobao', label: '合成', cookie: 'SYNTHETIC' }, 'account', true);
  store.importResult('account', { orders: [{ platformOrderId: 'order', title: '合成分包订单',
    orderDate: Date.parse('2026-11-06T12:20:09+08:00'), orderDateOrigin: 'detail', orderDatePrecision: 'second',
    ...orderPatch }], shipments: [] });
  const orderId = stableId('account', 'taobao', 'order', 'order'), id = stableId('package-a');
  const shipping = event('2026-11-10 10:35', '已发货：包裹正在等待揽收', 'waitdo', Date.parse('2026-11-10T10:35:00+08:00'));
  const saved = { id, orderId, accountId: 'account', waybillNo: 'SYNTHETIC-A', carrier: '中通', status: 'arrived',
    station: '合成花园兔喜快递柜3号柜', stationSource: 'platform_event', pickupCode: '3号柜123456',
    arrivalAt: 0, arrivalAtSource: 'unknown', shippedAt: shipping.time, shippedAtSource: 'platform_event', shippedAtPrecision: 'minute',
    logisticsState: 'ok', logisticsCheckedAt: now, logisticsDetailCheckedAt: now, updatedAt: now,
    logisticsEvents: [shipping, { ...shipping, providerStatus: 'doing' },
      event('11-13 11:28', '待取件：您的快件已存入【合成花园兔喜快递柜3号柜】，请及时取件')],
    ...shipmentPatch };
  store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(id, 'account', JSON.stringify(saved));
  return { store, saved, device: { accountIds: ['account'], legacyAccountIds: ['account'], familyIds: [] } };
}

test('saved split-parcel projection repairs dates, deduplicates UI states and agrees with compact details without database writes', t => {
  const { store, saved, device } = fixture(t);
  const sibling = { ...saved, id: stableId('package-b'), waybillNo: 'SYNTHETIC-B', status: 'signed',
    pickupCode: '5号柜654321', station: '合成花园兔喜快递柜5号柜', logisticsEvents: [
      event('2026-11-09 11:28', '已送达合成花园兔喜快递柜5号柜', 'done', Date.parse('2026-11-09T11:28:00+08:00'))] };
  store.db.prepare('INSERT INTO shipments VALUES(?,?,?)').run(sibling.id, 'account', JSON.stringify(sibling));
  const snapshot = store.snapshot(device);
  const result = snapshot.shipments.find(row => row.id === saved.id);
  assert.equal(result.arrivalAt, arrival);
  assert.equal(result.arrivalAtPrecision, 'minute');
  assert.equal(result.pickupCode, '123456');
  assert.equal(result.platformView.station.subLocation, '3号柜');
  assert.equal(result.logisticsEvents.length, 2);
  assert.equal(result.logisticsEvents[0].time, arrival);
  const details = shipmentDetails(store, device, saved.id);
  assert.deepEqual(details.logisticsEvents, result.logisticsEvents);
  assert.equal(details.evidenceKey, result.platformView.evidenceKey);
  const compact = clientSnapshot(snapshot);
  assert.equal(compact.shipments.find(row => row.id === saved.id).arrivalAt, arrival);
  assert.deepEqual(store.shipment(saved.id), saved);
  assert.deepEqual(store.shipment(sibling.id), sibling);
});

test('read repair accepts list dates but still requires a saved clock and nonconflicting year evidence', t => {
  const list = fixture(t, { orderDateOrigin: 'list' });
  assert.equal(list.store.snapshot(list.device).shipments[0].arrivalAt, arrival);
  assert.deepEqual(list.store.shipment(list.saved.id), list.saved);
  for (const [orderPatch, shipmentPatch] of [
    [{ orderDate: Date.parse('2024-01-01T00:00:00+08:00') }, {}],
    [{}, { logisticsCheckedAt: now - 86400000, logisticsDetailCheckedAt: now - 86400000 }],
    [{}, { logisticsCheckedAt: 0, logisticsDetailCheckedAt: 0 }],
  ]) {
    const { store, saved, device } = fixture(t, orderPatch, shipmentPatch);
    const value = store.snapshot(device).shipments[0];
    assert.equal(value.arrivalAt, 0);
    assert.equal(shipmentDetails(store, device, saved.id).logisticsEvents.find(row => row.timeText === '11-13 11:28').time, 0);
  }
});

test('Taobao bare transport prose shares stage time and duplicates without requiring a UI title', t => {
  const text = '【合成转运中心】快件已发往 合成城区公司，可关注官方公众号获取实时物流信息';
  const { store, device } = fixture(t, {}, { logisticsEvents: [
    event('11-12 23:04', text),
    { ...event('11-12 23:04', `运输中：${text}`), providerStatusTag: '运输中' },
    event('11-12 21:52', '【合成城区】快件已到达 合成转运中心'),
    event('11-12 01:50', '【合成中心】预计11月12日到达下一站')
  ] });
  const result = store.snapshot(device).shipments[0];
  assert.equal(result.logisticsEvents.length, 3);
  assert.equal(result.logisticsEvents[0].time, Date.parse('2026-11-12T23:04:00+08:00'));
  assert.equal(result.logisticsEvents[1].time, Date.parse('2026-11-12T21:52:00+08:00'));
  assert.equal(result.logisticsEvents[2].time, 0);
  assert.equal(result.arrivalAt, 0);
});

test('saved projection keeps conflicting future full timestamps as a veto on guessing the year', t => {
  const { store, saved, device } = fixture(t, { orderDate: Date.parse('2026-11-09T10:00:00+08:00') }, { logisticsEvents: [
    event('11-12 10:00', '运输中：快件已到达合成转运中心'),
    event('2027-11-12 10:00', '包裹已发货', 'done', Date.parse('2027-11-12T10:00:00+08:00'))
  ] });
  for (const result of [store.snapshot(device).shipments[0], shipmentDetails(store, device, saved.id)]) {
    assert.equal(result.logisticsEvents.find(row => row.timeText === '11-12 10:00').time, 0);
  }
  assert.deepEqual(store.shipment(saved.id), saved);
});

test('saved projection never corroborates partial times from contradictory full timestamp text', t => {
  const { store, device } = fixture(t, {}, { logisticsEvents: [
    event('11-12 10:00', '运输中：快件已到达合成转运中心'),
    event('2025-11-12 10:00', '包裹已发货', 'done', Date.parse('2026-11-12T10:00:00+08:00'))
  ] });
  const result = store.snapshot(device).shipments[0];
  assert.equal(result.logisticsEvents.find(row => row.timeText === '11-12 10:00').time, 0);
});
