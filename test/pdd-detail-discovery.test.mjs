import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as turn } from 'node:timers/promises';
import { createCollector } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';
import { createSyncJobs } from '../src/sync-jobs.mjs';

const NOW = Date.parse('2026-11-11T12:00:00+08:00');
const account = { platform: 'pdd' }, cookie = 'pdd_user_id=SYNTHETIC';
const reply = data => Response.json(data);
const trace = { info: '新包裹已揽收', timestamp: NOW / 1000 - 60 };
const known = { platformOrderId: 'order', orderStatus: '待收货', shipments: [{ waybillNo: 'OLD', carrier: '中通快递', status: 'transit',
  logisticsState: 'ok', logisticsEvents: [{ time: NOW - 120000, description: '旧包裹运输中' }] }] };

function fixture({ shipping = { order_sn: 'order', tracking_number: 'NEW', shipping_name: '中通快递', traces: [trace] },
  listed = [{ order_sn: 'order', order_status_text: '待收货', tracking_number: 'OLD' }], split = [], cabinet = {} } = {}) {
  const calls = [];
  const collector = createCollector({ now: () => NOW, maxPages: 1, fetchImpl: async url => {
    const target = new URL(url); calls.push(target);
    if (target.pathname.includes('order_list_v4')) return reply({ orders: target.searchParams.get('type') === 'unreceived' ? listed : [], has_more: false });
    if (target.pathname.includes('/cabinet/')) return reply({ result: cabinet });
    if (target.pathname.endsWith('/order/order/shipping')) return reply({ shipping });
    if (target.pathname.endsWith('/split/pack')) return reply({ result: { list: split } });
    if (target.pathname.endsWith('/shipping/track')) return reply({ shipping: { order_sn: 'order',
      tracking_number: target.searchParams.get('tracking_number'), traces: [{ ...trace, info: '独立分包运输中' }] } });
    assert.fail(`Unexpected synthetic endpoint: ${target.pathname}`);
  } });
  return { calls, collect: options => collector(account, cookie, options) };
}

test('PDD full refresh retrieves the arrived parcel cabinet code when the active order is missing from both lists', async () => {
  const arrival = { ...trace, info: '包裹已存放至合成驿站，等待领取', status: 'IN_CABINET' };
  const f = fixture({ listed: [], shipping: { order_sn: 'order', tracking_number: 'OLD', traces: [arrival] },
    cabinet: { tracking_number: 'OLD', code: '1-2-3456', arrival_time: arrival.timestamp } });
  const result = await f.collect({ knownOrders: [known] });
  const parcel = result.shipments[0];
  assert.equal(parcel?.status, 'arrived');
  assert.equal(parcel.logisticsState, 'ok');
  assert.equal(parcel.pickupCode, '1-2-3456');
  assert.equal(f.calls.filter(url => url.pathname.includes('/cabinet/')).length, 1);
});

for (const targeted of [false, true]) {
  test(`PDD ${targeted ? 'targeted' : 'full'} refresh retrieves the cabinet code for an arrived waybill first seen in shipping`, async t => {
    const arrival = { ...trace, info: '包裹已存放至合成驿站，等待领取', status: 'IN_CABINET' };
    const order = { platformOrderId: 'order', orderStatus: '待收货', orderDate: NOW - 86400000, shipments: [] };
    const f = fixture({ listed: [{ order_sn: 'order', order_status_text: '待收货' }],
      shipping: { order_sn: 'order', tracking_number: 'NEW', shipping_name: '中通快递', traces: [arrival] },
      cabinet: { tracking_number: 'NEW', code: '2-3-4567', arrival_time: arrival.timestamp } });
    const store = new Store({ key: Buffer.alloc(32, 4), now: () => NOW });
    t.after(() => store.close());
    const savedAccount = store.saveAccount({ ...account, label: '合成', cookie }, 'fixture', true);
    store.importResult(savedAccount.id, { orders: [order], shipments: [] });

    const result = await f.collect(targeted ? { targetOrder: order } : { knownOrders: [order] });
    store.importResult(savedAccount.id, result);
    const parcel = store.snapshot([savedAccount.id], undefined, 0, false).shipments[0];

    assert.equal(parcel?.waybillNo, 'NEW');
    assert.equal(parcel.status, 'arrived');
    assert.equal(parcel.pickupCode, '2-3-4567');
    const requested = f.calls.filter(url => url.pathname.endsWith('/shipping') || url.pathname.includes('/cabinet/'));
    assert.deepEqual(requested.map(url => url.pathname.endsWith('/shipping') ? 'shipping' : 'cabinet'), ['shipping', 'cabinet']);
  });

  test(`PDD ${targeted ? 'targeted' : 'full'} refresh admits an independently verified new waybill and deduplicates split discovery`, async () => {
    const jump = waybill => `https://mobile.yangkeduo.com/goods_express.html?order_sn=order&tracking_number=${waybill}&shipping_id=4`;
    const f = fixture({ shipping: { order_sn: 'order', tracking_number: 'NEW', traces: [trace], package_info_jump_url: jump('NEW') },
      split: ['NEW', 'NEW', 'SECOND', 'SECOND'].map(tracking_number => ({ tracking_number, shipping_id: 4, jump_url: jump(tracking_number) })) });
    const result = await f.collect(targeted ? { targetOrder: known } : { knownOrders: [known] });
    assert.deepEqual(result.shipments.map(parcel => parcel.waybillNo), ['OLD', 'NEW', 'SECOND']);
    assert.equal(result.shipments.find(parcel => parcel.waybillNo === 'NEW').logisticsEvents[0].description, trace.info);
    assert.equal(result.shipments.find(parcel => parcel.waybillNo === 'OLD').logisticsEvents, undefined);
    assert.deepEqual(result.logisticsFailures.map(item => [item.waybillNo, item.state]), [['OLD', 'unavailable']]);
    assert.deepEqual(f.calls.filter(url => url.pathname.endsWith('/shipping/track')).map(url => url.searchParams.get('tracking_number')), ['SECOND']);
  });

  test(`PDD ${targeted ? 'targeted' : 'full'} refresh cannot manufacture a new waybill from mismatched, empty or invalid detail`, async () => {
    for (const shipping of [
      { order_sn: 'other', tracking_number: 'NEW', traces: [trace] },
      { order_sn: 'order', orderSn: 'other', tracking_number: 'NEW', traces: [trace] },
      { order_sn: 'order', tracking_number: 'NEW', trackingNumber: 'OTHER', traces: [trace] },
      { order_sn: 'order', tracking_number: 'NEW', traces: [] },
      { order_sn: 'order', tracking_number: 'NEW', traces: [null, {}, { info: ' ' }] },
      { order_sn: 'order', tracking_number: 'NEW', traces: [{ ...trace, timestamp: NOW / 1000 + 86400 }] },
      { order_sn: 'order', tracking_number: 'WAITING_FOR_CARRIER', traces: [trace] },
    ]) {
      for (const previous of [known, { ...known, shipments: [] }]) {
        const f = fixture({ shipping, listed: [{ order_sn: 'order', order_status_text: '待收货',
          ...(previous.shipments.length ? { tracking_number: 'OLD' } : {}) }] });
        const result = await f.collect(targeted ? { targetOrder: previous } : { knownOrders: [previous] });
        assert.deepEqual(result.shipments.map(parcel => parcel.waybillNo), previous.shipments.map(parcel => parcel.waybillNo), JSON.stringify(shipping));
        assert.ok(result.shipments.every(parcel => !parcel.logisticsEvents?.length));
        assert.ok(result.logisticsFailures.some(item => !previous.shipments.length || item.waybillNo === 'OLD'));
      }
    }
  });
}

test('PDD no-waybill list candidates preserve the received range kind and leave waiting-for-shipment queries unchanged', async () => {
  const calls = [];
  const collect = createCollector({ now: () => NOW, maxPages: 1, fetchImpl: async url => {
    const target = new URL(url); calls.push(target);
    if (target.pathname.includes('order_list_v4')) return reply({ orders: target.searchParams.get('type') === 'unshipping'
      ? [{ order_sn: 'pending', order_status_text: '待发货' }, { order_sn: 'transition', order_status_text: '待发货' }]
      : [{ order_sn: 'transition' }, { order_sn: 'received', tracking_number: 'WAITING_FOR_CARRIER' }], has_more: false });
    assert.ok(target.pathname.endsWith('/shipping'), 'no cabinet is queried before a waybill exists');
    const id = target.pathname.split('/').at(-2);
    return reply({ shipping: { order_sn: id, tracking_number: `NEW-${id}`, traces: [trace] } });
  } });
  const result = await collect(account, cookie, { knownOrders: [{ platformOrderId: 'transition', orderStatus: '待发货', shipments: [] }] });
  assert.deepEqual(result.shipments.map(parcel => parcel.waybillNo), ['NEW-transition', 'NEW-received']);
  assert.deepEqual(calls.filter(url => url.pathname.endsWith('/shipping')).map(url => url.pathname.split('/').at(-2)), ['transition', 'received']);
  assert.equal(result.orders.find(order => order.platformOrderId === 'pending').orderStatus, '待发货');
});

for (const targeted of [false, true]) {
  for (const protectedState of ['picked', 'hidden', 'archived']) {
    test(`PDD ${targeted ? 'targeted' : 'full'} import keeps the ${protectedState} old parcel and gives the new parcel independent state`, async t => {
      const store = new Store({ key: Buffer.alloc(32, 4), now: () => NOW }); t.after(() => store.close());
      const savedAccount = store.saveAccount({ platform: 'pdd', label: '合成', cookie }, 'fixture', true);
      store.importResult(savedAccount.id, { orders: [{ platformOrderId: 'order', orderStatus: '待收货', orderDate: NOW - 86400000 }],
        shipments: ['OLD', 'ACTIVE'].map(waybillNo => ({ platformOrderId: 'order', waybillNo, carrier: '中通快递', status: 'transit',
          logisticsCheckedAt: NOW - 1000, logisticsState: 'ok', logisticsEvents: [{ time: NOW - 120000, description: '旧包裹运输中' }] })) });
      const old = store.snapshot([savedAccount.id]).shipments.find(parcel => parcel.waybillNo === 'OLD');
      if (protectedState === 'archived') store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify({ ...store.shipment(old.id), archived: true }), old.id);
      else store.applyOperations(store.device(store.redeem(store.createPairing([savedAccount.id]).code, '合成设备').token), [{ id: 'manual-old', shipmentId: old.id,
        action: protectedState === 'picked' ? 'pick' : 'hide', occurredAt: NOW }]);
      const before = structuredClone(store.shipment(old.id));
      const snapshot = store.snapshot([savedAccount.id]);
      const previous = { ...snapshot.orders[0], shipments: snapshot.shipments };
      const f = fixture();
      const result = await f.collect(targeted ? { targetOrder: previous } : { knownOrders: [previous] });
      store.importResult(savedAccount.id, result);
      assert.deepEqual(store.shipment(old.id), before);
      const newParcel = store.snapshot([savedAccount.id]).shipments.find(parcel => parcel.waybillNo === 'NEW');
      assert.ok(newParcel); assert.notEqual(newParcel.id, old.id);
      assert.equal(newParcel.picked, false); assert.equal(newParcel.hidden, false);
      assert.equal(newParcel.pickupCompletion.manualOverride, ''); assert.equal(newParcel.manualAt, 0);
      assert.equal(newParcel.logisticsEvents[0].description, trace.info);
    });
  }
}

test('PDD newly listed no-waybill work survives retry, SQLite restart, disappearing lists and account cooldown', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-pdd-discovery-'));
  const filename = join(directory, 'fixture.db'), key = Buffer.alloc(32, 7);
  let clock = NOW, listed = true, fail = true;
  const calls = [];
  const collector = createCollector({ now: () => clock, fetchImpl: async url => {
    const target = new URL(url);
    if (target.pathname.includes('order_list_v4')) return reply({ orders: target.searchParams.get('type') === 'unshipping'
      ? [{ order_sn: 'pending' }] : listed ? ['first', 'retry'].map(order_sn => ({ order_sn, order_status_text: '待收货', order_time: NOW / 1000 })) : [], has_more: false });
    if (target.pathname.includes('/cabinet/')) return reply({ result: {} });
    assert.ok(target.pathname.endsWith('/shipping'));
    const id = target.pathname.split('/').at(-2); calls.push(id);
    if (fail && id === 'retry') return new Response('synthetic temporary failure', { status: 503 });
    return reply({ shipping: { order_sn: id, tracking_number: `NEW-${id}`, traces: [trace] } });
  } });
  let store = new Store({ filename, key, now: () => clock });
  const savedAccount = store.saveAccount({ platform: 'pdd', label: '合成', cookie }, 'fixture', true);
  let jobs = createSyncJobs({ store, collector, now: () => clock });
  t.after(async () => { await jobs.close(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const first = jobs.request(savedAccount.id);
  for (let turns = 0; turns < 50 && !first.job.continuation; turns++) await turn();
  assert.equal(first.job.state, 'queued'); assert.equal(first.job.retryAt, NOW + 15000);
  assert.deepEqual(store.snapshot([savedAccount.id]).shipments.map(parcel => parcel.waybillNo), ['NEW-first']);
  const checkpoints = store.db.prepare('SELECT * FROM sync_logistics_tasks ORDER BY task_key').all();
  assert.deepEqual(checkpoints.map(row => [row.task_key, row.state]), [['pdd-logistics:first', 'completed'], ['pdd-logistics:retry', 'queued']]);
  assert.equal(JSON.parse(checkpoints[1].input).kind, 'in_transit');
  assert.equal(jobs.request(savedAccount.id), first);
  clock += 14999; t.mock.timers.tick(14999); await turn();
  assert.deepEqual([...calls].sort(), ['first', 'retry']);
  await jobs.close(); store.close(); listed = false; fail = false;
  clock++; store = new Store({ filename, key, now: () => clock });
  jobs = createSyncJobs({ store, collector, now: () => clock });
  const resumed = jobs.request(savedAccount.id);
  assert.equal(resumed.job.id, first.job.id);
  await resumed.done;
  assert.equal(resumed.job.state, 'completed');
  assert.deepEqual(calls.filter(id => id === 'retry'), ['retry', 'retry']);
  assert.equal(calls.filter(id => id === 'first').length, 1);
  assert.deepEqual(store.snapshot([savedAccount.id]).shipments.map(parcel => parcel.waybillNo).sort(), ['NEW-first', 'NEW-retry']);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sync_logistics_tasks').get().n, 0);
  const next = jobs.request(savedAccount.id), before = calls.length;
  assert.equal(next.job.state, 'queued');
  clock = next.job.retryAt - 1; t.mock.timers.tick(clock - (NOW + 15000)); await turn();
  assert.equal(calls.length, before);
  clock++; t.mock.timers.tick(1); await next.done;
  assert.equal(next.job.state, 'completed');
  assert.ok(!calls.includes('pending'));
});
