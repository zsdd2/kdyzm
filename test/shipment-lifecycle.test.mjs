import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { clientSnapshot } from '../src/client-snapshot.mjs';
import { normalizeLogisticsEvents, orderTimePrecision, pddShippingEvents, taobaoDetailDateEvidence, taobaoStageEvents, taobaoTransitEvents } from '../src/collector-enrichment.mjs';
import { jdParcels } from '../src/collectors.mjs';
import { shippingEvent, shippingEvidence } from '../src/shipment-lifecycle.mjs';

const NOW = Date.parse('2026-11-09T12:00:00+08:00');
const KEY = Buffer.alloc(32, 4);
const timestamp = value => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value);
const event = (offset, description, timePrecision = 'second') => ({ time: NOW + offset, description, timePrecision });
function fixture(t, rules, platform = 'taobao') {
  const directory = mkdtempSync(join(tmpdir(), 'shipment-lifecycle-'));
  const filename = join(directory, 'cache.sqlite');
  let clock = NOW;
  let store = new Store({ filename, key: KEY, now: () => clock, ...(rules ? { getLogisticsRules: () => rules } : {}) });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveAccount({ platform, label: 'fixture', cookie: 'FIXTURE' }, 'a', true);
  const read = () => store.snapshot(['a']).shipments.find(s => s.waybillNo === 'TEST');
  return {
    get store() { return store; }, read,
    setTime(value) { clock = value; },
    reopen() { store.close(); store = new Store({ filename, key: KEY, now: () => clock, ...(rules ? { getLogisticsRules: () => rules } : {}) }); return read(); },
    sync(events, extra = {}) {
      store.importResult('a', { orders: [{ platformOrderId: 'o', orderDate: NOW - 86400000 }],
        shipments: [{ platformOrderId: 'o', waybillNo: 'TEST', status: 'transit', logisticsState: 'ok', logisticsCheckedAt: clock, logisticsEvents: events, ...extra }] });
      return read();
    },
    op(action, at, extra = {}) {
      const device = store.device(store.redeem(store.createPairing(['a']).code, 'fixture').token);
      store.applyOperations(device, [{ id: action + at, shipmentId: read().id, action, occurredAt: at, ...extra }]);
      return read();
    },
  };
}

test('dispatch requires a completed dispatch or carrier acceptance event, never a status or prediction', () => {
  for (const description of ['商家已发货', '您的快件已揽收', '揽收成功', '包裹已经成功发货', '您的快件已由测试营业部揽收']) assert.equal(shippingEvent(description), true, description);
  for (const description of ['运输中', '已生成运单', '订单已经打印完成', '仓库正在出库', '快件已从上海分拨中心发出',
    '预计明天发货', '等待揽收', '尚未发货', '未揽收，系统显示已发货', '已发货是否属实？', '已发货但发货失败',
    '退货包裹已揽收', '已发货，现已撤销']) assert.equal(shippingEvent(description), false, description);
  const evidence = shippingEvidence([event(-9000, '已发货', 'minute'), event(-8000, '已揽收'), event(1000, '已发货')], {}, NOW);
  assert.deepEqual(evidence, { shippedAt: NOW - 9000, shippedAtSource: 'platform_event', shippedAtPrecision: 'minute' });
  assert.equal(shippingEvidence([{ time: 0, description: '已揽收' }], {}, NOW).shippedAt, 0);
  assert.equal(shippingEvidence([event(1, '已揽收')], {}, NOW).shippedAt, 0);
  assert.equal(shippingEvidence([event(-9000, '已揽收', 'unknown')], {}, NOW).shippedAtPrecision, 'unknown');
});

test('explicit Taobao dispatch remains evidence while carrier collection is pending', () => {
  const sample = { description: '已发货：包裹正在等待揽收', time: 1794285789000, timeText: '11-10 12:43' };
  const now = 1794292000000;
  assert.deepEqual(shippingEvidence([sample], {}, now), {
    shippedAt: sample.time, shippedAtSource: 'platform_event', shippedAtPrecision: 'unknown',
  });
  for (const description of ['商家已发货，等待快递员揽收', '发货成功，待揽收']) {
    assert.equal(shippingEvidence([{ ...sample, description }], {}, now).shippedAt, sample.time, description);
  }
  for (const description of ['包裹正在等待揽收', '未发货：包裹正在等待揽收', '等待发货，等待揽收',
    '预计明天揽收', '预计已发货，等待揽收', '尚未发货，系统显示已发货', '未揽收，系统显示已发货',
    '等待揽收后确认已发货', '已发货，等待卖家重新发货', '已发货但发货失败，等待揽收',
    '已发货是否属实？等待揽收', '已发货：包裹等待揽收，现已撤销', '退货包裹已发货，等待揽收']) {
    assert.equal(shippingEvidence([{ ...sample, description }], {}, now).shippedAt, 0, description);
  }
});

test('pending collection dispatch cannot revive a previous return or redirect cycle', () => {
  const dispatched = event(-9000, '已发货：包裹正在等待揽收');
  const old = { shippedAt: dispatched.time, shippedAtSource: 'platform_event' };
  for (const description of ['包裹已退回发件人', '包裹已改派重新投递']) {
    const reset = event(-8000, description);
    assert.equal(shippingEvidence([dispatched, reset], old, NOW).shippedAt, 0, description);
    assert.equal(shippingEvidence([dispatched, { ...reset, time: 0 }], old, NOW).shippedAt, 0, description);
    assert.equal(shippingEvidence([dispatched], old, NOW, { evidenceKey: description, startedAt: reset.time }).shippedAt, 0, description);
    const nextDispatch = event(-7000, dispatched.description);
    assert.equal(shippingEvidence([dispatched, reset, nextDispatch], old, NOW).shippedAt, nextDispatch.time, description);
  }
});

test('all platform adapters retain dispatch and arrival evidence beyond 100 ordinary updates', () => {
  const raw = Array.from({ length: 120 }, (_, i) => event(-i * 1000, '物流更新' + i));
  raw.push(event(-150000, '已到达幸福菜鸟驿站'), event(-180000, '已发货：包裹正在等待揽收'));
  const outputs = [
    normalizeLogisticsEvents(raw, timestamp, undefined, NOW),
    taobaoStageEvents(raw.map(e => ({ title: e.description, time: e.time })), timestamp, () => '', undefined, NOW),
    taobaoTransitEvents({ address: raw.map(e => ({ time: e.time, place: e.description })) }, timestamp, undefined, NOW),
    pddShippingEvents({ traces: raw.map(e => ({ timestamp: e.time, info: e.description })) }, timestamp, undefined, NOW),
  ];
  const jd = jdParcels({ multiPackageTrackInfoList: [{ carriageInfo: { carriageId: 'JD-FIXTURE' }, trackGroupInfo: {
    orderTrackShowList: raw.map(e => ({ CreationTime: e.time, Content: e.description })) } }] }, 'o', NOW)[0];
  outputs.push({ events: jd.logisticsEvents, truncated: jd.logisticsTruncated });
  for (const { events, truncated } of outputs) {
    assert.equal(events.length, 100); assert.equal(truncated, true);
    assert.ok(events.some(e => e.time === NOW - 180000 && /已发货/.test(e.description)));
    assert.ok(events.some(e => e.time === NOW - 150000 && /已到达/.test(e.description)));
    assert.equal(events[0].time, NOW);
  }
});

test('future anomalies cannot displace a real redelivery boundary or revive a prior dispatch', () => {
  const raw = [event(1000, '退回后重新派送中'), ...Array.from({ length: 120 }, (_, i) => event(-i * 1000, '物流更新' + i)),
    event(-150000, '退回后重新派送中'), event(-180000, '已发货')];
  const { events } = normalizeLogisticsEvents(raw, timestamp, undefined, NOW);
  assert.ok(events.some(e => e.time === NOW - 150000));
  assert.equal(shippingEvidence(events, { shippedAt: NOW - 180000, shippedAtSource: 'platform_event' }, NOW).shippedAt, 0);
});

test('dispatch and arrival persist through bounded history, missing refreshes, snapshots and reopening', t => {
  const f = fixture(t);
  let shipment = f.sync([event(-180000, '已发货：包裹正在等待揽收', 'minute'), event(-150000, '已到达幸福菜鸟驿站', 'minute')]);
  assert.equal(shipment.shippedAt, NOW - 180000); assert.equal(shipment.arrivalAt, NOW - 150000);
  f.setTime(NOW + 1);
  shipment = f.sync(Array.from({ length: 140 }, (_, i) => event(-i * 1000, '物流更新' + i)), { arrivalAt: 0, logisticsTruncated: true });
  assert.equal(shipment.logisticsEvents.length, 100);
  assert.equal(shipment.shippedAt, NOW - 180000); assert.equal(shipment.arrivalAt, NOW - 150000);
  f.setTime(NOW + 2); f.sync([], { logisticsState: 'empty' });
  shipment = f.reopen();
  assert.equal(shipment.shippedAtSource, 'platform_event'); assert.equal(shipment.shippedAtPrecision, 'minute');
  assert.equal(shipment.arrivalAtPrecision, 'minute');
  assert.equal(f.store.shipment(shipment.id).shippedAt, NOW - 180000);
});

test('custom arrival rules retain their event and explicit rule removal can still retract it', t => {
  const rules = [{ id: 'custom', enabled: true, kind: 'arrival', origin: 'manual', starts: ['交付给'], end: '', keywords: [] }];
  const f = fixture(t, rules);
  const events = normalizeLogisticsEvents([...Array.from({ length: 120 }, (_, i) => event(-i * 1000, '物流更新' + i)),
    event(-150000, '交付给幸福菜鸟驿站')], timestamp, rules, NOW).events;
  const shipment = f.sync(events, { logisticsTruncated: true });
  assert.equal(shipment.arrivalAt, NOW - 150000);
  rules.splice(0);
  f.store.refreshLogisticsRules(rules);
  assert.equal(f.read().arrivalAt, 0);
});

test('new delivery cycles archive prior milestones and do not reuse dispatch or manual pickup times', t => {
  const f = fixture(t);
  const old = f.sync([event(-9000, '已发货'), event(-8000, '已到达幸福菜鸟驿站')]);
  f.op('pick', NOW - 7000);
  f.setTime(NOW + 1000);
  let shipment = f.sync([event(500, '快件退回后重新派送中')]);
  assert.notEqual(shipment.pickupCycle.id, old.pickupCycle.id);
  assert.equal(shipment.shippedAt ?? 0, 0); assert.equal(shipment.arrivalAt, 0);
  assert.equal(shipment.pickupConfirmedAt ?? 0, 0); assert.equal(shipment.pickupManualAction || '', '');
  assert.equal(shipment.pickupCycleHistory.at(-1).shippedAt, NOW - 9000);
  assert.equal(shipment.pickupCycleHistory.at(-1).arrivalAt, NOW - 8000);
  assert.equal(shipment.pickupCycleHistory.at(-1).pickupConfirmedAt, NOW - 7000);
  f.setTime(NOW + 2000);
  shipment = f.sync([event(1500, '已揽收')]);
  assert.equal(shipment.shippedAt, NOW + 1500);
  assert.equal(f.op('pick', NOW + 2000, { pickedAt: NOW - 7000 }).pickupConfirmedAt, 0);
});

test('PDD redelivery clears the previous pickup code and publishes a late current code', t => {
  const f = fixture(t, undefined, 'pdd');
  const initial = f.sync([event(-8000, '已到达合成东门菜鸟驿站')], { status: 'arrived', pickupCode: '2-3456' });
  const first = clientSnapshot(f.store.snapshot(['a']));
  assert.equal(first.shipments[0].pickupCode, '2-3456');

  f.setTime(NOW + 3000);
  const newTrack = [event(2000, '已到达合成西门菜鸟驿站'), event(1000, '包裹已改投，重新派送中')];
  const next = f.sync(newTrack, { status: 'arrived', pickupCode: '' });
  assert.equal(next.arrivalAt, NOW + 2000);
  assert.notEqual(next.pickupCycle.id, initial.pickupCycle.id);
  assert.equal(f.store.shipment(next.id).pickupCode, '');
  const redelivered = clientSnapshot(f.store.snapshot(['a']), first.dataVersion);
  assert.equal(redelivered.metadataOnly, false);
  assert.equal(redelivered.shipments[0].pickupCode, '');

  f.setTime(NOW + 4000);
  const withCode = f.sync(newTrack, { status: 'arrived', pickupCode: '3-4567' });
  assert.equal(withCode.pickupCycle.id, next.pickupCycle.id);
  const refreshed = clientSnapshot(f.store.snapshot(['a']), redelivered.dataVersion);
  assert.equal(refreshed.metadataOnly, false);
  assert.equal(refreshed.shipments[0].pickupCode, '3-4567');

  f.setTime(NOW + 5000);
  assert.equal(f.sync(newTrack, { status: 'arrived', pickupCode: '' }).pickupCode, '3-4567');

  f.setTime(NOW + 7000);
  const withFreshCode = f.sync([event(6000, '已到达合成南门菜鸟驿站'), event(5500, '包裹已改投，重新派送中')],
    { status: 'arrived', pickupCode: '4-5678' });
  assert.notEqual(withFreshCode.pickupCycle.id, next.pickupCycle.id);
  assert.equal(withFreshCode.pickupCode, '4-5678');
});

test('undated returns invalidate elapsed-time evidence and stale payloads cannot replace dispatch', t => {
  const f = fixture(t);
  f.sync([event(-9000, '已发货')]);
  const stale = f.sync([event(-19000, '已发货')], { logisticsCheckedAt: NOW - 1000 });
  assert.equal(stale.shippedAt, NOW - 9000);
  f.setTime(NOW + 1);
  const unknown = f.sync([{ time: 0, description: '快件退回后重新派送中' }]);
  assert.equal(unknown.shippedAt ?? 0, 0); assert.equal(unknown.shippedAtSource || 'unknown', 'unknown');
});

test('split parcels never inherit another parcel dispatch and auto completion retains its event precision', t => {
  const f = fixture(t);
  f.sync([event(-9000, '已发货'), event(-8000, '已到达幸福菜鸟驿站'), event(-7000, '用户已取件', 'minute')]);
  f.store.importResult('a', { orders: [{ platformOrderId: 'o' }], shipments: [{ platformOrderId: 'o', waybillNo: 'OTHER', status: 'transit', logisticsCheckedAt: NOW }] });
  assert.equal(f.store.snapshot(['a']).shipments.find(s => s.waybillNo === 'OTHER').shippedAt, undefined);
  f.setTime(NOW + 1);
  const shipment = f.sync(Array.from({ length: 140 }, (_, i) => event(-i * 10, '信息更新' + i)));
  assert.equal(shipment.pickupCompletion.completedAt, NOW - 7000);
  assert.equal(shipment.pickupCompletion.evidence.timePrecision, 'minute');
  assert.ok(!shipment.logisticsEvents.some(e => e.description === '用户已取件'));
});

test('manual confirmation distinguishes action time, actual known confirmation and explicit historical unknown', t => {
  const f = fixture(t);
  f.sync([event(-9000, '运输中')]);
  assert.ok(f.store.snapshot(['a']).capabilities.includes('pickup_confirmed_at_v1'));
  let shipment = f.op('pick', NOW - 3000, { pickedAt: NOW - 8000 });
  assert.equal(shipment.pickupManualAt, NOW - 3000); assert.equal(shipment.pickupConfirmedAt, NOW - 8000);
  assert.equal(shipment.pickupManualAction, 'pick'); assert.ok(shipment.pickupManualOperation);
  shipment = f.op('hide', NOW - 2000);
  assert.equal(shipment.pickupConfirmedAt, NOW - 8000);
  shipment = f.op('restore', NOW - 1000);
  assert.equal(shipment.pickupConfirmedAt, 0); assert.equal(shipment.pickupManualAction, 'restore');
  shipment = f.op('pick', NOW, { pickedAt: 0 });
  assert.equal(shipment.picked, true); assert.equal(shipment.pickupConfirmedAt, 0);
  assert.equal(f.reopen().pickupConfirmedAt, 0);
  assert.throws(() => f.op('restore', NOW, { pickedAt: 0 }), error => error.code === 'INVALID_OPERATION');
  assert.throws(() => f.op('pick', NOW, { pickedAt: NOW + 1 }), error => error.code === 'INVALID_OPERATION');
});

test('order precision comes from raw platform values and does not fabricate precision for legacy dates', t => {
  assert.equal(orderTimePrecision('2026-11-09'), 'day');
  assert.equal(orderTimePrecision('2026-11-09 09:15'), 'minute');
  assert.equal(orderTimePrecision('2026-11-09 09:15:00'), 'second');
  assert.equal(orderTimePrecision('2026-1-2'), 'day');
  assert.equal(orderTimePrecision('2026-1-2 3:04'), 'minute');
  assert.equal(orderTimePrecision('2026/1/2 3:04:05'), 'second');
  assert.equal(orderTimePrecision('2026年1月2日 3:04:05'), 'second');
  assert.equal(orderTimePrecision(NOW), 'second');
  for (const value of ['今天09:15', '1-2 3:04', '2026-1-2 3:4', '2026-1-2 3:04 已下单']) assert.equal(orderTimePrecision(value), 'unknown');
  assert.equal(taobaoDetailDateEvidence({ data: { order: { fields: { labels: [{ name: '下单时间', value: '2026-11-09 09:15' }] } } } }, timestamp).orderDatePrecision, 'minute');
  const f = fixture(t);
  f.sync([]);
  assert.equal(f.store.snapshot(['a']).orders[0].orderDatePrecision, undefined);
  f.store.importResult('a', { orders: [{ platformOrderId: 'o', orderDate: NOW - 86400000, orderDatePrecision: 'minute' }], shipments: [] });
  assert.equal(f.store.snapshot(['a']).orders[0].orderDatePrecision, 'minute');
});

test('legacy JSON gains confirmation provenance only from an exact accepted pick operation', t => {
  const f = fixture(t);
  f.sync([event(-9000, '已发货')]);
  let shipment = f.op('pick', NOW - 1000);
  assert.equal(shipment.pickupConfirmedAt, NOW - 1000, 'old clients default to the operation time');
  const legacy = f.store.shipment(shipment.id);
  delete legacy.pickupManualAction; delete legacy.pickupConfirmedAt; delete legacy.shippedAt;
  delete legacy.shippedAtSource; delete legacy.shippedAtPrecision;
  f.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  shipment = f.reopen();
  assert.equal(shipment.shippedAt, NOW - 9000);
  assert.equal(shipment.pickupManualAction, 'pick'); assert.equal(shipment.pickupConfirmedAt, NOW - 1000);
  const unproven = f.store.shipment(shipment.id);
  delete unproven.pickupManualAction; delete unproven.pickupConfirmedAt; delete unproven.pickupManualOperation;
  f.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(unproven), unproven.id);
  shipment = f.reopen();
  assert.equal(shipment.picked, true); assert.equal(shipment.pickupManualAction, ''); assert.equal(shipment.pickupConfirmedAt, 0);
});

test('repeated snapshots use persisted dispatch and unknown results without reparsing the timeline', t => {
  const known = fixture(t, []), unknown = fixture(t, []);
  const events = Array.from({ length: 99 }, (_, i) => event(-i * 1000, '物流更新' + i));
  known.sync([...events, event(-150000, '已发货', 'minute')]);
  unknown.sync(events);
  const knownRow = known.store.shipment(known.read().id), unknownRow = unknown.store.shipment(unknown.read().id);
  assert.equal(unknownRow.shippedAt, 0); assert.equal(unknownRow.shippedAtSource, 'unknown');
  const rules = globalThis.PickCodeLogistics, originalReset = rules.pickupCycleReset;
  let parsedEvents = 0;
  t.mock.method(rules, 'pickupCycleReset', description => { parsedEvents++; return originalReset(description); });
  for (let i = 0; i < 5; i++) {
    assert.equal(known.read().shippedAt, NOW - 150000);
    assert.equal(known.read().shippedAtPrecision, 'minute');
    assert.equal(unknown.read().shippedAt, undefined);
  }
  assert.equal(parsedEvents, 0, 'persisted known and unknown evidence must not scan events on snapshot reads');
  delete knownRow.shippedAt; delete knownRow.shippedAtSource; delete knownRow.shippedAtPrecision;
  known.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(knownRow), knownRow.id);
  assert.equal(known.read().shippedAt, NOW - 150000);
  assert.ok(parsedEvents >= 100, 'legacy rows still derive evidence from their retained timeline');
  assert.equal(Object.hasOwn(known.store.shipment(knownRow.id), 'shippedAt'), false, 'snapshot does not backfill storage');
});

test('cached dispatch still rejects invalid, future, untrusted and earlier-cycle timestamps', t => {
  const f = fixture(t, []);
  const shipment = f.sync([event(-9000, '已发货')]);
  const stored = f.store.shipment(shipment.id);
  for (const fields of [{ shippedAt: -1 }, { shippedAt: NOW + 1 }, { shippedAt: String(NOW - 9000) },
    { shippedAt: null }, { shippedAtSource: 'sync_clock' },
    { pickupCycle: { id: 'next', evidenceKey: 'redelivery', startedAt: NOW - 1000, status: 'active' } }]) {
    f.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify({ ...stored, ...fields }), stored.id);
    assert.equal(f.read().shippedAt, undefined, JSON.stringify(fields));
  }
  f.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify({ ...stored, shippedAtPrecision: 'invalid' }), stored.id);
  assert.equal(f.read().shippedAt, NOW - 9000);
  assert.equal(f.read().shippedAtPrecision, 'unknown');
});
