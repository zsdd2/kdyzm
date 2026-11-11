import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { createCollector, jdParcels, taobaoParcels } from '../src/collectors.mjs';
import { normalizeLogisticsEvents } from '../src/collector-enrichment.mjs';
import { hash } from '../src/security.mjs';

const NOW = Date.parse('2026-11-11T12:00:00+08:00');
const ARRIVAL = NOW - 3600000;
const event = (description, time = ARRIVAL) => ({ time, timePrecision: 'second', description });
const doorstep = '您的快件已放在家门口，请及时查收';
const jd = events => jdParcels({ multiPackageTrackInfoList: [{ carriageInfo: { carriageId: 'SYNTHETIC-JD', carrier: '京东物流' },
  trackGroupInfo: { orderTrackShowList: events.map(item => ({ CreationTime: item.time, Content: item.description })) } }] }, 'o', NOW)[0];

function fixture(t, platform = 'jd', carrier = '京东物流', rules = []) {
  const store = new Store({ key: Buffer.alloc(32, 7), now: () => NOW, getLogisticsRules: () => rules });
  t.after(() => store.close());
  store.saveAccount({ platform, label: 'fixture', cookie: 'SYNTHETIC' }, 'a', true);
  const read = () => store.snapshot(['a']).shipments[0];
  const input = { platformOrderId: 'o', waybillNo: 'SYNTHETIC', carrier, status: 'signed', logisticsState: 'ok',
    logisticsCheckedAt: NOW, logisticsEvents: [event(doorstep)], arrivalAt: 0, arrivalAtSource: 'unknown' };
  return { store, read, input,
    sync(extra = {}) { store.importResult('a', { orders: [{ platformOrderId: 'o', orderDate: NOW - 86400000 }], shipments: [{ ...input, ...extra }] }); return read(); },
  };
}

test('JD and SF doorstep delivery supplies arrival evidence without confirming collection', t => {
  for (const [platform, carrier] of [['jd', ''], ['taobao', '顺丰速运'], ['pdd', 'SF EXPRESS']]) {
    const f = fixture(t, platform, carrier), shipment = f.sync();
    assert.equal(shipment.arrivalAt, ARRIVAL, `${platform}/${carrier}`);
    assert.equal(shipment.arrivalAtSource, 'platform_event');
    assert.equal(shipment.arrivalAtPrecision, 'second');
    assert.equal(shipment.station, '');
    assert.equal(shipment.picked, false);
    assert.equal(shipment.pickupCompletion.autoPicked, false);
    assert.equal(shipment.pickupConfirmedAt || 0, 0);
    const device = f.store.device(f.store.redeem(f.store.createPairing(['a']).code, 'fixture').token);
    f.store.applyOperations(device, [{ id: `pick-${platform}`, shipmentId: shipment.id, action: 'pick', occurredAt: NOW - 1000 }]);
    assert.equal(f.read().arrivalAt, ARRIVAL);
    assert.equal(f.read().pickupConfirmedAt, NOW - 1000);
    assert.equal(f.read().picked, true);
  }
});

test('platform collectors expose the actual doorstep time and preserve pickup point arrivals', () => {
  assert.equal(jd([event(doorstep)]).arrivalAt, ARRIVAL);
  const sf = taobaoParcels({ mailNo: 'SYNTHETIC-SF', logisticCompany: { name: '顺丰速运' }, multiStage: [
    { title: '物流更新', time: ARRIVAL, labelDesc: { text: doorstep } },
  ] }, 'o', '', undefined, NOW)[0];
  assert.equal(sf.arrivalAt, ARRIVAL);
  const station = jd([event('您的快件已送达幸福菜鸟驿站，请及时取件')]);
  assert.equal(station.status, 'arrived'); assert.equal(station.arrivalAt, ARRIVAL);
  assert.equal(station.station, '幸福菜鸟驿站');
});

test('sanitized real JD and SF wording retains delivery semantics and provider time through collection', async () => {
  const jdText = '已签收：您的订单已送达至家门口，如有疑问请联系配送员确认。';
  const sfText = '经收件人同意，快件已放在家门口，如有疑问请联系快递员。';
  assert.equal(jd([event(jdText)]).arrivalAt, ARRIVAL);
  const result = await createCollector({ now: () => NOW, fetchImpl: async () => new Response(JSON.stringify({ shipping: {
    tracking_number: 'SYNTHETIC-SF', traces: [{ timestamp: ARRIVAL, info: sfText, status: 'SIGN', status_tag: '已签收' }],
  } })) })({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder: { platformOrderId: 'o', orderStatus: '待收货',
    orderDate: NOW - 86400000, orderDateSource: 'platform', shipments: [{ waybillNo: 'SYNTHETIC-SF', carrier: '顺丰速运', status: 'transit' }] } });
  assert.equal(result.shipments[0].arrivalAt, ARRIVAL);
  assert.equal(result.shipments[0].arrivalAtPrecision, 'second');
  assert.equal(result.shipments[0].logisticsEvents[0].providerStatus, 'SIGN');
});

test('doorstep evidence is restricted to explicit completed JD/SF delivery with a trustworthy time', () => {
  const engine = globalThis.PickCodeLogistics;
  for (const description of ['预计送达家门口', '已放门口但投递失败', '联系不上收件人，预计放在门口',
    '未能送达门口', '已送达门口，随后退回发件人', '已送达菜鸟驿站门口', '已放到丰巢快递柜门口',
    '已放在家门口，由邻居代收', '已签收', '本人已签收', '已送达幸福服装店']) {
    assert.equal(engine.doorstepEvidence([event(description)], { platform: 'jd' }, NOW).arrivalAt, 0, description);
  }
  for (const time of [0, -1, NOW + 1000]) assert.equal(engine.doorstepEvidence([event(doorstep, time)], { carrier: '顺丰' }, NOW).arrivalAt, 0);
  assert.equal(engine.doorstepEvidence([event(doorstep)], { platform: 'pdd', carrier: '中通' }, NOW).arrivalAt, 0);
  assert.equal(engine.pickupEvidence([event(doorstep)]).arrivalAt, 0, 'station learning keeps its station-only evidence contract');
  assert.equal(engine.doorstepEvidence([{ ...event(doorstep), timeText: '2026-11-10 10:00:00' }], { platform: 'jd' }, NOW).arrivalAt, 0);
  for (const description of ['已退回发件人', '已改派重新投递', '已存入幸福菜鸟驿站']) {
    assert.equal(engine.doorstepEvidence([event(description, NOW - 1000), event(doorstep)], { platform: 'jd' }, NOW).arrivalAt, 0, description);
  }
  assert.equal(engine.doorstepEvidence([event('已退回发件人', 0), event(doorstep)], { platform: 'jd' }, NOW).arrivalAt, 0);
});

test('old saved doorstep caches project an arrival and identical real Store reimports persist it', t => {
  const f = fixture(t), shipment = f.sync();
  const row = f.store.shipment(shipment.id);
  row.arrivalAt = 0; row.arrivalAtSource = 'unknown'; row.arrivalAtPrecision = 'unknown';
  const oldParserKey = hash(JSON.stringify(['shipment-lifecycle-v4', [], f.store.pickupCompletion.rules(), f.store.pickupCompletion.config()]));
  const { logisticsCheckedAt, ...oldEvidence } = f.input;
  row.logisticsEvidenceHash = hash(JSON.stringify([oldParserKey, oldEvidence]));
  f.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(row), row.id);
  assert.equal(f.read().arrivalAt, ARRIVAL, 'configured Store snapshots repair the visible legacy cache');
  assert.equal(f.store.shipment(row.id).arrivalAt, 0, 'snapshot stays read-only');
  f.sync();
  assert.equal(f.store.shipment(row.id).arrivalAt, ARRIVAL, 'same payload cannot bypass missing doorstep evidence');
  f.store.refreshLogisticsRules([]);
  assert.equal(f.read().arrivalAt, ARRIVAL, 'station rule refresh cannot erase doorstep evidence');
});

test('a contradictory timestamp for the same doorstep fact vetoes import and legacy projection regardless of order', t => {
  const good = event(doorstep), conflict = { ...good, timeText: '2026-11-09 10:00:00' };
  for (const events of [[good, conflict], [conflict, good]]) {
    assert.equal(globalThis.PickCodeLogistics.doorstepEvidence(events, { platform: 'jd' }, NOW).arrivalAt, 0);
    const f = fixture(t), shipment = f.sync({ logisticsEvents: events });
    assert.equal(shipment.arrivalAt, 0);
    assert.equal(f.store.shipment(shipment.id).arrivalAt, 0, 'conflicting import cannot persist an arrival');
    const row = f.store.shipment(shipment.id);
    row.logisticsEvents = events;
    f.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(row), row.id);
    assert.equal(f.read().arrivalAt, 0, 'legacy snapshot cannot bypass the contradictory copy');
  }
  const unrelatedConflict = { ...event('已到达转运中心', ARRIVAL - 1000), timeText: '2026-11-09 10:00:00' };
  assert.equal(globalThis.PickCodeLogistics.doorstepEvidence([good, unrelatedConflict], { platform: 'jd' }, NOW).arrivalAt, ARRIVAL);
  assert.equal(fixture(t).sync({ logisticsEvents: [good, unrelatedConflict] }).arrivalAt, ARRIVAL);
});

test('undated actual station or cabinet arrivals prevent reviving an older doorstep delivery', t => {
  for (const description of ['已存入幸福菜鸟驿站', '已放入丰巢快递柜']) {
    const events = [event(doorstep), event(description, 0)];
    for (const time of [0, -1, NaN]) assert.equal(globalThis.PickCodeLogistics.doorstepEvidence([event(doorstep), event(description, time)], { platform: 'jd' }, NOW).arrivalAt, 0, description);
    const f = fixture(t, 'jd', '京东物流', globalThis.PickCodeLogistics.defaults());
    const station = description.includes('驿站') ? '幸福菜鸟驿站' : '丰巢快递柜';
    const shipment = f.sync({ logisticsEvents: events, station, stationSource: 'platform_event' });
    assert.equal(shipment.arrivalAt, 0, description);
    assert.equal(shipment.station, station, 'unresolved station time must not erase the known pickup station');
    assert.equal(f.store.shipment(shipment.id).arrivalAt, 0, description);
    assert.equal(f.read().arrivalAt, 0, description);
  }
  for (const description of ['预计存入幸福菜鸟驿站', '未能存入丰巢快递柜，入柜失败']) {
    assert.equal(globalThis.PickCodeLogistics.doorstepEvidence([event(doorstep), event(description, 0)], { platform: 'jd' }, NOW).arrivalAt, ARRIVAL, description);
  }
});

test('doorstep milestones survive timeline truncation and later returns clear the current arrival', t => {
  const f = fixture(t);
  const normalized = normalizeLogisticsEvents([...Array.from({ length: 120 }, (_, i) => event(`物流更新${i}`, NOW - i * 1000)), event(doorstep)], Number, [], NOW);
  assert.equal(normalized.events.length, 100);
  assert.ok(normalized.events.some(item => item.description === doorstep));
  assert.equal(f.sync({ logisticsEvents: normalized.events, logisticsTruncated: true }).arrivalAt, ARRIVAL);
  assert.equal(f.sync({ status: 'transit', logisticsEvents: [event('已退回发件人', NOW - 500)] }).arrivalAt, 0);
});
