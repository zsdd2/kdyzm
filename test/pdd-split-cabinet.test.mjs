import test from 'node:test';
import assert from 'node:assert/strict';
import * as split from '../src/pdd-split.mjs';
import { createCollector } from '../src/collectors.mjs';

const ORDER = 'SYNTHETIC-CABINET-ORDER';
const jump = params => `https://mobile.yangkeduo.com/goods_express.html?${new URLSearchParams(params)}`;
const source = { order_sn: ORDER, tracking_number: 'SYNTHETIC-A', package_info_jump_url: jump({
  order_sn: ORDER, tracking_number: 'SYNTHETIC-A', shipping_id: '4',
}) };
const item = (waybillNo, external) => ({ tracking_number: waybillNo, shipping_id: '4', shipping_name: '合成快递',
  jump_url: jump({ order_sn: ORDER, tracking_number: waybillNo, shipping_id: '4', entry_source: '2',
    ...(external === undefined ? {} : { external }) }),
});
const response = value => ({ text: JSON.stringify(value) });
const options = (data, calls = []) => ({ expectedOrderId: ORDER, pddCheck: value => value,
  platformRequest: async url => { calls.push(new URL(url)); return response(data); },
});

function collectorFixture(mode, checkpoints = [], { mainWaybill = false } = {}) {
  const now = Date.parse('2026-11-10T10:00:00+08:00'), requests = [];
  const externalWaybill = mainWaybill ? 'SYNTHETIC-A' : 'SYNTHETIC-B';
  const otherWaybill = mainWaybill ? 'SYNTHETIC-B' : 'SYNTHETIC-A';
  const cabinet = { code: '7-8-9012', address: '合成分包驿站', arrival_time: now / 1000 - 120 };
  const mainTrack = { timestamp: now / 1000 - 180, info: mainWaybill ? '包裹已到达合成分包驿站，等待领取' : '运输中' };
  const collect = createCollector({ now: () => now, fetchImpl: async url => {
    const u = new URL(url); requests.push(u);
    const reply = value => new Response(JSON.stringify(value));
    if (u.pathname.includes('/cabinet/')) {
      if (!u.searchParams.has('external')) return reply({ result: mainWaybill ? { ...cabinet, code: '1-2-9876' } : {} });
      assert.equal(u.searchParams.get('tracking_number'), externalWaybill);
      if (mode === 'failed') return new Response('Synthetic failure', { status: 503 });
      return reply({ result: { ...cabinet, tracking_number: mode === 'mismatch' ? otherWaybill : externalWaybill } });
    }
    if (u.pathname.endsWith('/shipping')) return reply({ shipping: { ...source, traces: [mainTrack] } });
    if (u.pathname.endsWith('/split/pack')) return reply({ result: { list: [item(externalWaybill, '1')] } });
    assert.ok(u.pathname.endsWith('/shipping/track'));
    return reply({ shipping: { tracking_number: 'SYNTHETIC-B', traces: [{ timestamp: now / 1000 - 120, info: '包裹已到达合成分包驿站，等待领取' }] } });
  } });
  return { requests, run: durableLogistics => collect({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', {
    targetOrder: { platformOrderId: ORDER, shipments: [{ waybillNo: 'SYNTHETIC-A', status: 'transit' },
      ...(mainWaybill ? [{ waybillNo: 'SYNTHETIC-B', status: 'transit', waybillVerification: 'unverified' }] : [])] },
    durableLogistics, onProgress: delta => checkpoints.push(structuredClone(delta)),
  }) };
}

test('collector reads a discovered external parcel cabinet without sharing codes with its sibling', async () => {
  for (const mode of ['ok', 'mismatch', 'failed']) {
    const f = collectorFixture(mode), result = await f.run(false);
    const main = result.shipments.find(p => p.waybillNo === 'SYNTHETIC-A');
    const other = result.shipments.find(p => p.waybillNo === 'SYNTHETIC-B');
    assert.equal(main.pickupCode, '');
    assert.equal(other.pickupCode || '', mode === 'ok' ? '7-8-9012' : '');
    assert.equal(other.logisticsState, 'ok'); assert.equal(other.status, 'arrived');
    assert.equal(f.requests.filter(u => u.searchParams.get('external') === '1').length, 1);
    if (mode !== 'ok') assert.ok(result.warnings.length);
  }
});

test('a durable split cabinet retry checkpoints the already verified split track', async () => {
  const checkpoints = [], f = collectorFixture('failed', checkpoints);
  await assert.rejects(f.run(true), { code: 'UPSTREAM_ERROR' });
  assert.ok(checkpoints.flatMap(delta => delta.shipments || []).some(p => p.waybillNo === 'SYNTHETIC-B' && p.logisticsState === 'ok'));
});

test('the main waybill reads its documented external cabinet without assigning an order-level code to an unverified sibling', async () => {
  for (const mode of ['ok', 'mismatch']) {
    const fixture = collectorFixture(mode, [], { mainWaybill: true });
    const result = await fixture.run(false);
    const main = result.shipments.find(parcel => parcel.waybillNo === 'SYNTHETIC-A');
    const sibling = result.shipments.find(parcel => parcel.waybillNo === 'SYNTHETIC-B');
    assert.equal(main.pickupCode || '', mode === 'ok' ? '7-8-9012' : '');
    assert.equal(sibling.pickupCode || '', '');
    assert.equal(main.logisticsState, 'ok');
    assert.equal(main.logisticsEvents.length, 1);
    assert.deepEqual(fixture.requests.filter(url => url.searchParams.get('external') === '1').map(url => url.searchParams.get('tracking_number')), ['SYNTHETIC-A']);
    assert.equal(fixture.requests.some(url => url.pathname.endsWith('/shipping/track')), false);
  }
});

test('a durable main cabinet retry checkpoints the already verified main track', async () => {
  const checkpoints = [], fixture = collectorFixture('failed', checkpoints, { mainWaybill: true });
  await assert.rejects(fixture.run(true), { code: 'UPSTREAM_ERROR' });
  const main = checkpoints.flatMap(delta => delta.shipments || []).find(parcel => parcel.waybillNo === 'SYNTHETIC-A' && parcel.logisticsState === 'ok');
  assert.ok(main);
  assert.equal(main.logisticsEvents.length, 1);
  assert.equal(main.pickupCode || '', '');
});
async function externalParcel() {
  const result = await split.discoverPddSplit(source, options({ result: { list: [item('SYNTHETIC-A', '1')] } }));
  assert.equal(result.failures.length, 0);
  return result.parcels[0];
}

test('split discovery preserves external only when the official jump URL explicitly supplies one', async () => {
  const result = await split.discoverPddSplit(source, options({ result: { list: [
    item('SYNTHETIC-A', '1'), { ...item('SYNTHETIC-B'), external: '1' },
  ] } }));
  assert.equal(result.parcels[0].external, '1');
  assert.equal(result.parcels[1].external, undefined);
  assert.equal(result.parcels[0].query.external, undefined);
});

test('verified external split cabinet uses only the fixed official endpoint and known selectors', async () => {
  const parcel = await externalParcel(), calls = [];
  const cabinet = { tracking_number: 'SYNTHETIC-A', code: '654321', address: '合成取件点', arrival_time: 1794200000 };
  const result = await split.fetchPddSplitCabinet({ ...parcel, query: { ...parcel.query,
    refer_scene: '5', after_sales_id: 'SYNTHETIC-AFTER-SALE', anti_content: 'DO-NOT-FORWARD', unknown: 'DO-NOT-FORWARD',
  } }, options({ result: cabinet }, calls));
  assert.deepEqual(result, { cabinet });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, 'https://mobile.yangkeduo.com');
  assert.equal(calls[0].pathname, `/proxy/api/api/express/cabinet/${ORDER}`);
  assert.deepEqual(Object.fromEntries(calls[0].searchParams), {
    entry_source: '2', shipping_id: '4', tracking_number: 'SYNTHETIC-A', external: '1',
  });
});

test('split cabinet never requests without an explicit external flag and matching required selectors', async () => {
  const parcel = await externalParcel();
  for (const candidate of [
    { ...parcel, external: undefined }, { ...parcel, external: '0' }, { ...parcel, external: true },
    { ...parcel, query: { ...parcel.query, shipping_id: '' } },
    { ...parcel, query: { ...parcel.query, shipping_id: {} } },
    { ...parcel, query: { ...parcel.query, tracking_number: 'SYNTHETIC-B' } },
    { ...parcel, query: { ...parcel.query, order_sn: 'SYNTHETIC-OTHER' } },
    { ...parcel, waybillNo: '待发货' },
  ]) {
    const result = await split.fetchPddSplitCabinet(candidate, {
      ...options({}), platformRequest: () => assert.fail('invalid cabinet selector must not make a request'),
    });
    assert.equal(result.cabinet, undefined);
    assert.equal(result.failure.state, 'unavailable');
  }
});

test('split cabinet rejects contradictory supported identity fields at both response levels', async () => {
  const parcel = await externalParcel(), valid = { tracking_number: parcel.waybillNo, code: '654321' };
  for (const data of [
    { order_sn: 'SYNTHETIC-OTHER', result: valid },
    { orderSn: 'SYNTHETIC-OTHER', result: valid },
    { trackingNumber: 'SYNTHETIC-B', result: valid },
    { result: { ...valid, order_sn: 'SYNTHETIC-OTHER' } },
    { result: { ...valid, order_sn: ORDER, orderSn: 'SYNTHETIC-OTHER' } },
    { result: { ...valid, trackingNumber: 'SYNTHETIC-B' } },
    { result: { ...valid, tracking_number: 'SYNTHETIC-B' } },
  ]) {
    const result = await split.fetchPddSplitCabinet(parcel, options(data));
    assert.equal(result.cabinet, undefined);
    assert.equal(result.failure.waybillNo, parcel.waybillNo);
  }
  for (const cabinet of [{}, { code: '654321' }, { ...valid, tracking_number: ' ＳＹＮＴＨＥＴＩＣ-Ａ ' },
    { trackingNumber: parcel.waybillNo, orderSn: ORDER, code: '654321' }]) {
    assert.deepEqual(await split.fetchPddSplitCabinet(parcel, options({ result: cabinet })), { cabinet });
  }
});

test('split cabinet invalid formats are unavailable and transport or account errors reach the queue', async () => {
  const parcel = await externalParcel();
  for (const data of [null, [], {}, { result: null }, { result: [] }, { result: 'invalid' }]) {
    assert.equal((await split.fetchPddSplitCabinet(parcel, options(data))).failure.state, 'unavailable');
  }
  const malformed = await split.fetchPddSplitCabinet(parcel, { ...options({}), platformRequest: async () => ({ text: 'not-json' }) });
  assert.equal(malformed.failure.state, 'unavailable');
  for (const code of ['ACCOUNT_EXPIRED', 'UPSTREAM_BLOCKED', 'UPSTREAM_RATE_LIMITED', 'UPSTREAM_ERROR', 'TimeoutError', 'AbortError']) {
    const error = Object.assign(new Error('synthetic upstream failure'), { code });
    await assert.rejects(split.fetchPddSplitCabinet(parcel, { ...options({}), platformRequest: async () => { throw error; } }), e => e === error);
  }
});
