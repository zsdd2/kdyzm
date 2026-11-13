import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createCollector, pddParcels, timestamp } from '../src/collectors.mjs';
import { pddShippingEvents } from '../src/collector-enrichment.mjs';
import { detectPickupCompletion } from '../src/pickup-completion.mjs';
import { Store } from '../src/store.mjs';
import { shipmentDetails } from '../src/client-snapshot.mjs';

await import(new URL(existsSync(new URL('../app-source/pickcode/core/load-core.mjs', import.meta.url))
  ? '../app-source/pickcode/core/load-core.mjs' : '../app-source/pickcode/core/load-core.mjs', import.meta.url));

const NOW = Date.parse('2026-11-09T12:00:00+08:00');
const ORDER = 'SYNTHETIC-PDD-ACCURACY', WAYBILL = 'SYNTHETIC-PDD-A';
const reply = data => new Response(JSON.stringify(data));
const out = { timestamp: NOW / 1000 - 60, info: '包裹已投递，凭码在代收点领取',
  status: 'OUT_CABINET', status_tag: '已取件', sub_status: 'OUT_CABINET_501', trace_status_tip: '已签收' };
const inside = { ...out, status: 'IN_CABINET', status_tag: '待取件', sub_status: 'IN_CABINET_401', trace_status_tip: '待取件' };
const eventsOf = traces => pddShippingEvents({ traces }, timestamp, undefined, NOW).events;
const conflictEvents = () => [eventsOf([out])[0], eventsOf([inside])[0]];

function fixture(t, platform = 'pdd') {
  const store = new Store({ key: Buffer.alloc(32, 8), now: () => NOW });
  t.after(() => store.close());
  store.saveAccount({ platform, label: '合成准确度账号', cookie: 'SYNTHETIC' }, 'pdd-accuracy', true);
  const sync = logisticsEvents => store.importResult('pdd-accuracy', {
    orders: [{ platformOrderId: ORDER, title: '合成商品', orderDate: NOW - 86400000 }],
    shipments: [{ platformOrderId: ORDER, waybillNo: WAYBILL, carrier: '申通快递', status: 'arrived',
      arrivalAt: NOW - 3600000, arrivalAtSource: 'locker_arrival', arrivalAtPrecision: 'second',
      logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsEvents }],
  });
  return { store, sync, snapshot: () => store.snapshot(['pdd-accuracy']) };
}

test('PDD single-parcel cabinet rejects an explicit different waybill without losing legacy unlabelled cabinet support', () => {
  const order = { order_sn: ORDER, tracking_number: WAYBILL };
  const cabinet = { code: '123456', address: '合成取件点', arrival_time: NOW / 1000 - 60 };
  for (const identity of [{}, { tracking_number: WAYBILL }]) {
    const compatible = pddParcels(order, { ...cabinet, ...identity })[0];
    assert.equal(compatible.pickupCode, cabinet.code);
    assert.equal(compatible.station, cabinet.address);
  }
  const conflict = pddParcels(order, { ...cabinet, tracking_number: 'SYNTHETIC-PDD-B' })[0];
  assert.equal(conflict.pickupCode, '', 'a single listed parcel does not override an explicit cabinet identity');
  assert.equal(conflict.station, '');
  assert.equal(conflict.arrivalAt, 0);
  assert.equal(conflict.status, 'transit');
});

for (const reverse of [false, true]) test(`PDD conflicting same-time provider states remain pending regardless of trace order (reverse=${reverse})`, () => {
  const traces = reverse ? [inside, out] : [out, inside];
  const events = eventsOf(traces);
  assert.deepEqual(events.map(event => event.providerStatus).sort(), ['IN_CABINET', 'OUT_CABINET']);
  assert.equal(detectPickupCompletion({ logisticsEvents: events }, { now: NOW }), null);
  const repeated = eventsOf([...traces, ...traces]);
  assert.equal(repeated.length, 2, 'identical repeats still collapse without dropping a conflicting state');
});

test('PDD conflicting provider evidence survives Store import and cannot become an automatic pickup', t => {
  const f = fixture(t);
  f.sync(conflictEvents());
  const parcel = f.snapshot().shipments[0];
  assert.equal(parcel.picked, false);
  assert.deepEqual(parcel.logisticsEvents.map(event => event.providerStatus).sort(), ['IN_CABINET', 'OUT_CABINET']);
  f.sync([...conflictEvents()].reverse());
  assert.equal(f.snapshot().shipments[0].picked, false);
  assert.equal(f.snapshot().shipments[0].logisticsEvents.length, 2);
});

test('PDD counterevidence survives the 100-event limit and retracts cached completion', t => {
  const f = fixture(t);
  f.sync(eventsOf([out])); assert.equal(f.snapshot().shipments[0].picked, true);
  const neutral = Array.from({ length: 99 }, (_, i) => ({ timestamp: NOW - i - 1, info: '合成信息更新' + i }));
  const events = eventsOf([...neutral, out, inside]);
  assert.ok(events.length <= 100);
  assert.deepEqual(events.filter(e => e.description === out.info).map(e => e.providerStatus).sort(), ['IN_CABINET', 'OUT_CABINET']);
  assert.equal(detectPickupCompletion({ logisticsEvents: events }, { now: NOW }), null);
  f.sync([...eventsOf(neutral), ...conflictEvents()]);
  assert.equal(f.snapshot().shipments[0].picked, false);
  assert.ok(f.snapshot().shipments[0].logisticsEvents.some(e => e.providerStatus === 'IN_CABINET'));
});

test('PDD conflicting display time cannot grant completion even when the numeric timestamp is in the past', t => {
  const f = fixture(t);
  const events = eventsOf([{ ...out, display_time: '2026-11-10 11:59:00' }]);
  assert.equal(events[0].time, NOW - 60000);
  assert.equal(detectPickupCompletion({ logisticsEvents: events }, { now: NOW }), null);
  f.sync(events); assert.equal(f.snapshot().shipments[0].picked, false);
  const cached = fixture(t); cached.sync(eventsOf([out]));
  assert.equal(cached.snapshot().shipments[0].picked, true);
  cached.sync(events); assert.equal(cached.snapshot().shipments[0].picked, false);
  for (const traces of [[out, { ...out, display_time: '2026-11-10 11:59:00' }], [{ ...out, display_time: '2026-11-10 11:59:00' }, out]]) {
    const duplicates = eventsOf(traces);
    assert.equal(duplicates.length, 2);
    assert.equal(detectPickupCompletion({ logisticsEvents: duplicates }, { now: NOW }), null);
  }
});

test('future collected templates cannot displace a real IN_CABINET counterevent during truncation', t => {
  const f = fixture(t), prior = { ...out, timestamp: NOW / 1000 - 120 };
  f.sync(eventsOf([prior])); assert.equal(f.snapshot().shipments[0].picked, true);
  const notes = Array.from({ length: 99 }, (_, i) => ({ timestamp: NOW - i - 1, info: '合成信息更新' + i }));
  const events = eventsOf([{ ...out, timestamp: NOW / 1000 + 60 }, ...notes, { ...inside, info: '物流状态更新' }]);
  assert.ok(events.some(e => e.providerStatus === 'IN_CABINET'));
  f.sync(events); assert.equal(f.snapshot().shipments[0].picked, false);
});

for (const reverse of [false, true]) test(`PDD refresh preserves a cached same-time contradictory state (reverse=${reverse})`, t => {
  const f = fixture(t), [collected, waiting] = conflictEvents();
  f.sync([reverse ? collected : waiting]);
  f.sync([reverse ? waiting : collected]);
  const parcel = f.snapshot().shipments[0];
  assert.equal(parcel.picked, false, 'a new fetch does not prove which of two contradictory same-time states is correct');
  assert.deepEqual(parcel.logisticsEvents.map(event => event.providerStatus).sort(), ['IN_CABINET', 'OUT_CABINET']);
});

test('App core retains conflicting provider evidence from a valid server snapshot', t => {
  const f = fixture(t), device = { accountIds: ['pdd-accuracy'], legacyAccountIds: ['pdd-accuracy'], familyIds: [] };
  f.sync(conflictEvents());
  const snapshot = f.store.snapshot(['pdd-accuracy'], undefined, 0, false);
  let state = '';
  const dispatch = (action, payload = {}) => {
    const result = JSON.parse(globalThis.PickCodeCore.dispatch(state, JSON.stringify({ action, payload })));
    state = JSON.stringify(result.state); return result.result;
  };
  dispatch('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: 'fixture', accounts: snapshot.accounts });
  const view = dispatch('syncImport', { snapshot, syncedAt: NOW });
  const parcel = view.packages.flatMap(order => order.shipments).find(item => item.waybillNo === WAYBILL);
  const target = dispatch('shipmentDetailTarget', { id: parcel.id });
  const detail = shipmentDetails(f.store, device, target.remoteId);
  dispatch('importShipmentDetails', { ...detail, id: target.id, bindingKey: target.bindingKey });
  const detailed = dispatch('snapshot').packages.flatMap(order => order.shipments).find(item => item.waybillNo === WAYBILL);
  assert.equal(detailed.picked, false);
  assert.deepEqual(detailed.logisticsEvents.map(event => event.providerStatus).sort(), ['IN_CABINET', 'OUT_CABINET']);
  assert.equal(view.operations.length, 0);
  f.sync([...Array.from({ length: 99 }, (_, i) => ({ time: NOW - i - 1, description: '合成信息更新' + i })), ...conflictEvents()]);
  const updated = f.store.snapshot(['pdd-accuracy'], undefined, 0, false);
  const refreshed = dispatch('syncImport', { snapshot: updated, syncedAt: NOW }).packages.flatMap(order => order.shipments).find(item => item.waybillNo === WAYBILL);
  const refreshedTarget = dispatch('shipmentDetailTarget', { id: refreshed.id });
  const refreshedDetail = shipmentDetails(f.store, device, refreshedTarget.remoteId);
  const bounded = dispatch('importShipmentDetails', { ...refreshedDetail, id: refreshedTarget.id, bindingKey: refreshedTarget.bindingKey }).packages.flatMap(order => order.shipments).find(item => item.waybillNo === WAYBILL).logisticsEvents;
  assert.ok(bounded.length <= 100);
  assert.deepEqual(bounded.filter(e => e.description === out.info).map(e => e.providerStatus).sort(), ['IN_CABINET', 'OUT_CABINET']);
});

function splitFailureCollector(status) {
  return createCollector({ now: () => NOW, fetchImpl: async url => {
    const target = new URL(url);
    if (target.pathname.endsWith('/shipping')) return reply({ shipping: {
      order_sn: ORDER, tracking_number: WAYBILL,
      package_info_jump_url: `https://mobile.yangkeduo.com/goods_express.html?${new URLSearchParams({ order_sn: ORDER, tracking_number: WAYBILL, shipping_id: '4' })}`,
      traces: [{ timestamp: NOW / 1000 - 60, info: '本人已签收' }],
    } });
    if (target.pathname.endsWith('/split/pack')) return new Response('Synthetic split discovery failure', { status });
    assert.fail(`Unexpected synthetic request: ${target.pathname}`);
  } });
}
const targetOrder = { platformOrderId: ORDER, orderStatus: '待收货', shipments: [{ waybillNo: WAYBILL, status: 'transit' }] };

test('PDD optional split discovery failure retains the successfully verified main track', async () => {
  const result = await splitFailureCollector(503)({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder });
  const parcel = result.shipments.find(item => item.waybillNo === WAYBILL);
  assert.equal(parcel.logisticsState, 'ok');
  assert.equal(parcel.logisticsEvents[0].description, '本人已签收');
  assert.ok(result.warnings.length, 'split discovery remains visibly incomplete');
});

test('PDD durable split retry retains a main-track checkpoint while propagating the retryable error', async () => {
  const checkpoints = [];
  await assert.rejects(splitFailureCollector(503)({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', {
    targetOrder, durableLogistics: true, onProgress: delta => { checkpoints.push(structuredClone(delta)); },
  }), { code: 'UPSTREAM_ERROR' });
  assert.ok(checkpoints.flatMap(delta => delta.shipments || []).some(parcel => parcel.waybillNo === WAYBILL
    && parcel.logisticsState === 'ok' && parcel.logisticsEvents[0].description === '本人已签收'));
});

test('PDD split authentication and rate-limit failures still stop collection', async () => {
  for (const [status, code] of [[401, 'ACCOUNT_EXPIRED'], [403, 'UPSTREAM_BLOCKED'], [429, 'UPSTREAM_RATE_LIMITED']]) {
    await assert.rejects(splitFailureCollector(status)({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder }), { code });
  }
});

test('PDD main tracking validates all already-supported order and waybill aliases before attaching events', async () => {
  for (const identity of [
    { order_sn: ORDER, orderSn: 'SYNTHETIC-OTHER-ORDER', tracking_number: WAYBILL },
    { orderSn: 'SYNTHETIC-OTHER-ORDER', tracking_number: WAYBILL },
    { order_sn: ORDER, tracking_number: WAYBILL, trackingNumber: 'SYNTHETIC-PDD-B' },
  ]) {
    const collect = createCollector({ now: () => NOW, fetchImpl: async url => {
      assert.ok(new URL(url).pathname.endsWith('/shipping'));
      return reply({ shipping: { ...identity, traces: [{ timestamp: NOW / 1000 - 60, info: '本人已签收' }] } });
    } });
    const result = await collect({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder });
    assert.ok(result.shipments.every(parcel => !parcel.logisticsEvents?.length), JSON.stringify(identity));
    assert.ok(result.logisticsFailures.some(failure => failure.platformOrderId === ORDER && failure.waybillNo === WAYBILL));
  }
});

test('PDD targeted refresh obtains the current cabinet code instead of waiting for a full-account refresh', async () => {
  for (const cabinetWaybill of [WAYBILL, 'SYNTHETIC-PDD-B']) {
    const calls = [];
    const collect = createCollector({ now: () => NOW, fetchImpl: async url => {
      const path = new URL(url).pathname; calls.push(path);
      if (path.includes('/cabinet/')) return reply({ result: { tracking_number: cabinetWaybill, code: '9-8-7654', address: '合成当前驿站', arrival_time: NOW / 1000 - 120 } });
      assert.ok(path.endsWith('/shipping'));
      return reply({ shipping: { order_sn: ORDER, tracking_number: WAYBILL, traces: [
        { timestamp: NOW / 1000 - 120, info: '包裹已到达合成当前驿站，等待领取' },
      ] } });
    } });
    const result = await collect({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder });
    assert.equal(calls.filter(path => path.includes('/cabinet/')).length, 1);
    assert.equal(result.shipments[0].pickupCode, cabinetWaybill === WAYBILL ? '9-8-7654' : '');
  }
});

test('PDD malformed rows and future signatures do not replace a verified current arrival', async () => {
  const collect = createCollector({ now: () => NOW, fetchImpl: async url => new URL(url).pathname.includes('/cabinet/')
    ? reply({ result: {} }) : reply({ shipping: { tracking_number: WAYBILL, traces: [
      null, { timestamp: NOW / 1000 + 86400, info: '已签收' },
      { timestamp: NOW / 1000 - 120, info: '包裹已到达合成当前驿站，等待领取' },
    ] } }) });
  const result = await collect({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder });
  assert.equal(result.shipments[0].status, 'arrived');
  assert.equal(result.shipments[0].logisticsEvents.length, 2);
  assert.equal(result.shipments[0].arrivalAt, NOW - 120000);
});

const taobaoCollected = { time: NOW - 60000, timeText: '11-09 11:59', location: '',
  description: '已签收：包裹已从代收点取出', provider: 'taobao', providerStatus: 'doing',
  providerStatusTag: '已签收', providerStatusText: '包裹已从代收点取出' };

test('Taobao historical done alone never grants collection, while the identical prior doing fact remains valid', () => {
  const done = { ...taobaoCollected, providerStatus: 'done' };
  assert.equal(detectPickupCompletion({ logisticsEvents: [done] }, { now: NOW }), null);
  for (const events of [[taobaoCollected, done], [done, taobaoCollected]]) {
    assert.equal(detectPickupCompletion({ logisticsEvents: events }, { now: NOW })?.ruleId, 'builtin-taobao-pickup-point-exit-v1');
  }
});

test('Taobao changed time, prose, location or contradictory metadata is not a harmless doing-to-done transition', () => {
  const done = { ...taobaoCollected, providerStatus: 'done' };
  for (const change of [
    { time: taobaoCollected.time + 1000 },
    { description: '历史节点：包裹已从代收点取出' },
    { description: '已签收：包裹已从代收点取出，实际未取件' },
    { location: '另一个取件点' },
    { providerStatusText: '包裹仍在代收点' },
    { providerSubStatus: 'CONTRADICTORY_SYNTHETIC' },
  ]) {
    assert.equal(detectPickupCompletion({ logisticsEvents: [taobaoCollected, { ...done, ...change }] }, { now: NOW }), null, JSON.stringify(change));
  }
});

test('Taobao same-fact doing-to-done refresh keeps saved completion and the manual pending override', t => {
  const f = fixture(t, 'taobao');
  f.sync([taobaoCollected]);
  assert.equal(f.snapshot().shipments[0].picked, true);
  f.sync([{ ...taobaoCollected, providerStatus: 'done' }]);
  const saved = f.snapshot().shipments[0];
  assert.equal(saved.picked, true);
  assert.equal(saved.pickupCompletion.completedAt, taobaoCollected.time);
  const overridden = f.store.pickupCompletion.project({ ...saved,
    pickupCompletion: { ...saved.pickupCompletion, manualOverride: 'pending' } });
  assert.equal(overridden.picked, false);
  assert.equal(overridden.pickupCompletion.manualOverride, 'pending');
});
