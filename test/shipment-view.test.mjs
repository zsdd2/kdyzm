import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { projectShipmentView, ShipmentViewCache } from '../src/shipment-view.mjs';
import { courierPhones } from '../src/logistics-contacts.js';
import { Store } from '../src/store.mjs';

const now = Date.parse('2026-11-13T12:00:00+08:00'), at = now - 60000;
const stationName = '合成花园4卡菜鸟驿站', aliasName = `${stationName}5号柜`;
const catalog = [{ id: 's1', name: stationName, enabled: true, aliases: [{ name: aliasName, subLocation: '4卡5号柜' }] }];
const shipment = (fields = {}) => ({ id: 'shipment', status: 'arrived', station: aliasName,
  arrivalAt: at, arrivalAtSource: 'platform_event', shippedAt: 0, shippedAtSource: 'unknown',
  logisticsEvents: [{ time: at, description: `已送达${aliasName}` }], ...fields });
const view = value => projectShipmentView(value, { platform: 'pdd', catalog, now });

test('server station rules preserve card identity and separate cabinet location', () => {
  const result = view(shipment());
  assert.deepEqual(result.station, { id: 's1', name: stationName, subLocation: '5号柜', rawName: aliasName, displayName: stationName, conflict: false });
  assert.equal(result.deliveryMode, 'locker');
  assert.equal(result.quality.arrivalTime.state, 'known');
  assert.equal(result.quality.shippedTime.state, 'unknown');
  assert.equal(result.requiresReceiptConfirmation, false);
});

test('ambiguous aliases and contradictory cabinets never acquire a canonical station', () => {
  const ambiguous = projectShipmentView(shipment(), { catalog: [...catalog, { id: 's2', name: aliasName, enabled: true }], now });
  assert.equal(ambiguous.station.id, '');
  assert.equal(ambiguous.quality.station.state, 'ambiguous');
  const conflict = view(shipment({ logisticsEvents: [{ time: at, description: `已送达${aliasName}，柜号6号柜` }] }));
  assert.equal(conflict.station.conflict, true);
  assert.equal(conflict.station.id, '');
});

test('station evidence is usable while arrival time remains unknown', () => {
  const result = view(shipment({ station: '', arrivalAt: 0, arrivalAtSource: 'unknown',
    logisticsEvents: [{ time: 0, description: `已送达${aliasName}` }] }));
  assert.equal(result.station.id, 's1');
  assert.equal(result.quality.arrivalTime.state, 'unknown');
  assert.equal(result.quality.arrivalTime.reasonCode, 'EVENT_TIME_UNKNOWN');
  assert.equal(view(shipment({ station: '未证实站点', stationSource: 'unknown', logisticsEvents: [] })).quality.station.state, 'unknown');
});

test('only confirmed JD/SF doorstep evidence selects doorstep; platform signed is not user received', () => {
  for (const [platform, carrier, expected] of [['jd', '', 'doorstep'], ['taobao', '顺丰', 'doorstep'], ['pdd', '圆通', 'unknown']]) {
    const value = shipment({ station: '', status: 'signed', carrier, logisticsEvents: [{ time: at, description: '您的包裹已送达家门口' }] });
    const result = projectShipmentView(value, { platform, now });
    assert.equal(result.deliveryMode, expected);
    assert.equal(result.requiresReceiptConfirmation, true);
    assert.equal(projectShipmentView({ ...value, picked: true }, { platform, now }).requiresReceiptConfirmation, false);
  }
  const redirected = shipment({ station: '', status: 'signed', logisticsEvents: [
    { time: at, description: '您的包裹已送达家门口' }, { time: 0, description: '包裹已改派，重新派送' }] });
  assert.equal(projectShipmentView(redirected, { platform: 'jd', now }).deliveryMode, 'unknown');
  const previouslyStored = shipment({ station: '', status: 'signed', logisticsEvents: [
    { time: at, description: '您的包裹已送达家门口' }, { time: at - 1000, description: `已送达${aliasName}` }] });
  assert.equal(projectShipmentView(previouslyStored, { platform: 'jd', now }).station.displayName, '');
});

test('time conflicts remain ambiguous and JD warehouse preparation cannot become shipped', () => {
  const result = view(shipment({ arrivalAt: 0, logisticsEvents: [{ time: at, timeText: '2026-11-12 11:00:00', description: `已送达${aliasName}` }] }));
  assert.equal(result.quality.arrivalTime.state, 'ambiguous');
  const store = new Store({ key: Buffer.alloc(32, 1), now: () => now });
  try {
    const result = store.shipmentView(shipment({ shippedAt: at, shippedAtSource: 'platform_event',
      logisticsEvents: [{ time: at, description: '您的订单已准备出库' }] }), { platform: 'jd' });
    assert.equal(result.quality.shippedTime.state, 'unknown');
  } finally { store.close(); }
});

test('cache reuses unchanged evidence, ignores collection metadata, invalidates rules and protects returned values', () => {
  const cache = new ShipmentViewCache(), value = shipment(), options = { platform: 'pdd', catalog, now };
  const first = cache.project(value, options), entry = cache.entries.get(value.id);
  const same = cache.project({ ...value, logisticsCheckedAt: now, updatedAt: now }, { ...options, now: now + 1 });
  assert.equal(first.evidenceKey, same.evidenceKey);
  assert.equal(cache.entries.get(value.id), entry);
  first.station.id = 'tampered';
  assert.equal(cache.project(value, options).station.id, 's1');
  const changed = cache.project(value, { ...options, catalog: [] });
  assert.notEqual(changed.evidenceKey, first.evidenceKey);
  assert.equal(changed.station.id, '');
});

test('normalized contacts remain authoritative when a compact response has no events', () => {
  const raw = shipment({ logisticsEvents: [{ time: at, description: '派送员13800000001正在派送' }] });
  const normalized = view(raw);
  assert.deepEqual(courierPhones({ logisticsEvents: [], platformView: normalized }), [{ phone: '13800000001', text: '13800000001' }]);
  assert.deepEqual(courierPhones({ ...raw, platformView: { version: 1, courierPhones: [] } }), []);
});

test('snapshot truncation cannot remove contacts and detail uses the same evidence version', t => {
  const store = new Store({ key: Buffer.alloc(32, 1), now: () => now, getStationRules: () => ({ revision: 1, stations: catalog }) });
  t.after(() => store.close());
  store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'SYNTHETIC' }, 'account', true);
  const events = [...Array.from({ length: 30 }, (_, i) => ({ time: at - i * 1000, description: `轨迹${i}：${'运输途中'.repeat(80)}` })),
    { time: at - 40000, description: '派送员13800000001正在派送' }];
  store.importResult('account', { orders: [{ platformOrderId: 'order', orderDate: now }], shipments: [{
    platformOrderId: 'order', waybillNo: 'SYNTHETIC', carrier: '中通', status: 'arrived', station: aliasName,
    stationSource: 'platform_event', arrivalAt: at, arrivalAtSource: 'platform_event', logisticsState: 'ok', logisticsEvents: events
  }] });
  const snapshot = store.snapshot(['account']), full = snapshot.shipments[0];
  const withoutEvents = { ...snapshot, shipments: snapshot.shipments.map(value => ({ ...value, logisticsEvents: [] })) };
  const additionalBytes = 3800000 - Buffer.byteLength(JSON.stringify(withoutEvents), 'utf8') - 1;
  const compact = store.snapshot(['account'], undefined, additionalBytes).shipments[0];
  assert.ok(compact.logisticsEvents.length < events.length);
  assert.equal(compact.logisticsEvents.some(event => event.description.includes('13800000001')), false);
  assert.deepEqual(compact.platformView.courierPhones, [{ phone: '13800000001', text: '13800000001' }]);
  assert.equal(compact.platformView.evidenceKey, full.platformView.evidenceKey);
  assert.equal(store.shipmentView(store.shipment(full.id)).evidenceKey, full.platformView.evidenceKey);
});

const corpus = JSON.parse(readFileSync(new URL('../fixtures/logistics-contacts-history.json', import.meta.url)));
for (const fixture of corpus.fixtures) {
  test(`server full saved history contacts ${fixture.platform} ${fixture.id}`, () => {
    assert.deepEqual(projectShipmentView(fixture, { platform: fixture.platform, now }).courierPhones.map(phone => phone.phone), fixture.expected);
  });
}
