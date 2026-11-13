import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, taobaoParcels } from '../src/collectors.mjs';
import { normalizeLogisticsEvents } from '../src/collector-enrichment.mjs';
import { timestamp } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';
import { detectPickupCompletion } from '../src/pickup-completion.mjs';

const NOW = Date.parse('2026-10-31T10:00:00+08:00');
const response = data => new Response(JSON.stringify(data));
const ssr = fields => new Response(`<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields } } } })};</script>`);
const cookie = '_m_h5_tk=TEST_1793350000';
function taobaoFetch(fields, transit, calls = []) {
  return async (url, options) => {
    const target = new URL(url); calls.push(target);
    if (target.hostname === 'buyertrade.taobao.com') return new Response(JSON.stringify(transit).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
    if (target.hostname === 'pages-g.m.taobao.com') return ssr(fields);
    if (!target.searchParams.has('sign')) return response({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
    if (options.method === 'POST') return response({ ret: ['SUCCESS'], data: { data: {} } });
    const page = JSON.parse(target.searchParams.get('data')).page;
    return response({ ret: ['SUCCESS'], data: { result: { mainOrders: page === '1' ? [{ id: 'o1', statusInfo: { text: '待收货' } }] : [] } } });
  };
}

test('Taobao retains every returned stage, preserves partial time labels and omits the recipient footer', () => {
  const parcel = taobaoParcels({ mailNo: 'A', multiStage: [
    { title: '已签收', subtitle: '2026-10-31 09:00:00', labelDesc: { richContent: [{ text: '本人' }, { text: '已签收' }] } },
    { title: '运输中', subtitle: '10-30 12:45', labelDesc: { text: '到达转运中心' } },
    { title: '送至某收件地址', labelDesc: { text: '收件人 123****7890' } },
  ] }, 'o1')[0];
  assert.equal(parcel.logisticsState, 'ok');
  assert.equal(parcel.logisticsEvents.length, 2);
  assert.equal(parcel.logisticsEvents[0].time, Date.parse('2026-10-31T09:00:00+08:00'));
  assert.equal(parcel.logisticsEvents[0].description, '已签收：本人已签收');
  assert.equal(parcel.logisticsEvents[1].time, 0);
  assert.equal(parcel.logisticsEvents[1].timeText, '10-30 12:45');
});

test('Taobao fallback track attaches only to its expressId within a split order', async () => {
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoFetch(
    { multiPackages: { packages: [{ mailNo: 'A' }, { mailNo: 'B' }] } },
    { expressId: 'B', expressName: 'Carrier', address: [{ place: '已签收', time: '2026-10-31 09:00:00' }, { place: '运输中', time: '2026-10-30 09:00:00' }] },
  ) })({ platform: 'taobao' }, cookie);
  assert.deepEqual(result.shipments.map(parcel => parcel.logisticsEvents.length), [0, 2]);
  assert.equal(result.shipments[0].logisticsState, 'unavailable');
  assert.equal(result.shipments[1].logisticsState, 'ok');
  assert.equal(result.shipments[1].status, 'signed');
  assert.equal(result.shipments[1].logisticsUpdatedAt, NOW);
});

test('Taobao fallback never attaches an unmatched waybill and reports failed refreshes', async () => {
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoFetch(
    { multiPackages: { packages: [{ mailNo: 'A' }, { mailNo: 'B' }] } },
    { expressId: 'OTHER', address: [{ place: '已签收', time: '2026-10-31 09:00:00' }] },
  ) })({ platform: 'taobao' }, cookie);
  assert.ok(result.shipments.every(parcel => !parcel.logisticsEvents.length && parcel.logisticsState === 'unavailable'));
  const failed = await createCollector({ now: () => NOW, fetchImpl: taobaoFetch({ mailNo: 'A' }, {}) })({ platform: 'taobao' }, cookie);
  assert.equal(failed.shipments[0].logisticsState, 'error');
  assert.equal(failed.shipments[0].logisticsUpdatedAt, undefined);
});

test('Taobao active known waybill can refresh through transit_step when SSR no longer returns it', async () => {
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoFetch({}, { expressId: 'A', address: [{ place: '已签收', time: '2026-10-31 09:00:00' }] }) })(
    { platform: 'taobao' }, cookie, { knownOrders: [{ platformOrderId: 'o1', orderDateOrigin: 'detail', shipments: [{ waybillNo: 'A', status: 'arrived' }] }] });
  assert.equal(result.shipments[0].waybillNo, 'A');
  assert.equal(result.shipments[0].logisticsState, 'ok');
  assert.equal(result.shipments[0].status, 'signed');
});

test('PDD verified shipping path retains full track for the matching package only', async () => {
  const calls = [];
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
    const target = new URL(url); calls.push(target);
    if (target.pathname.includes('order_list_v4')) return response({ orders: [{ order_sn: 'o1', order_time: 1793350000, shipping_list: [{ tracking_number: 'A' }, { tracking_number: 'B' }] }], has_more: false });
    if (target.pathname.includes('/cabinet/')) return response({ result: {} });
    assert.equal(target.pathname, '/proxy/api/order/o1/shipping');
    assert.equal(target.searchParams.get('query_type'), '2');
    assert.equal(target.searchParams.get('entry_source'), '2');
    return response({ shipping: { tracking_number: 'B', traces: [
      { info: '您的快件已签收', time: '2026-10-31 09:00:00', timestamp: 1793408400 },
      { info: '正在派送', display_time: '10-30 08:00', time: '2026-10-30 08:00:00' },
    ] } });
  } })({ platform: 'pdd' }, 'pdd_user_id=1');
  assert.equal(result.orders[0].orderDateOrigin, 'list');
  assert.equal(result.shipments[0].logisticsEvents, undefined);
  assert.equal(result.shipments[1].logisticsEvents.length, 2);
  assert.equal(result.shipments[1].status, 'signed');
  assert.deepEqual(result.logisticsFailures, [{ platformOrderId: 'o1', waybillNo: 'A', state: 'unavailable', logisticsCheckedAt: NOW }]);
  assert.equal(calls.filter(target => target.pathname.endsWith('/shipping')).length, 1);
});

test('PDD tracks signed-unpicked known orders missing from unreceived without using picked parcels', async () => {
  const calls = [];
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
    const target = new URL(url); calls.push(target.pathname);
    if (target.pathname.includes('order_list_v4')) return response({ orders: [] });
    return response({ shipping: { order_sn: 'old', tracking_number: 'ACTIVE', traces: [{ info: '已签收', time: '2026-10-31 09:00:00' }] } });
  } })({ platform: 'pdd' }, 'pdd_user_id=1', { knownOrders: [
    { platformOrderId: 'old', shipments: [{ waybillNo: 'ACTIVE', status: 'arrived' }, { waybillNo: 'PICKED', status: 'arrived', picked: true }] },
    { platformOrderId: 'done', shipments: [{ waybillNo: 'DONE', status: 'signed' }] },
  ] });
  assert.deepEqual(result.orders, []);
  assert.equal(result.shipments.length, 1);
  assert.equal(result.shipments[0].waybillNo, 'ACTIVE');
  assert.equal(result.shipments[0].status, 'signed');
  assert.deepEqual(result.logisticsFailures, [{ platformOrderId: 'done', waybillNo: 'DONE', state: 'error', logisticsCheckedAt: NOW }]);
  assert.ok(calls.some(path => path.includes('/done/')));
});

test('PDD failed shipping reports refresh failure; expired login still aborts collection', async () => {
  const fetchImpl = async url => String(url).includes('order_list_v4') ? response({ orders: [{ order_sn: 'o1', tracking_number: 'A' }], has_more: false })
    : String(url).includes('/cabinet/') ? response({ result: {} }) : new Response('unavailable', { status: 503 });
  const result = await createCollector({ now: () => NOW, fetchImpl })({ platform: 'pdd' }, 'pdd_user_id=1');
  assert.equal(result.shipments[0].waybillNo, 'A');
  assert.deepEqual(result.logisticsFailures, [{ platformOrderId: 'o1', waybillNo: 'A', state: 'error', logisticsCheckedAt: NOW }]);
  await assert.rejects(createCollector({ fetchImpl: async url => String(url).includes('/shipping?') ? response({ error_code: 40001 }) : fetchImpl(url) })({ platform: 'pdd' }, 'pdd_user_id=1'), { code: 'ACCOUNT_EXPIRED' });
});

test('PDD logistics covers all listed and absent active orders with oldest attempts first', async () => {
  const checked = [];
  const list = Array.from({ length: 25 }, (_, index) => ({ order_sn: `o${index}`, tracking_number: `A${index}` }));
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
    const target = new URL(url);
    if (target.pathname.includes('order_list_v4')) return response({ orders: list, has_more: false });
    if (target.pathname.includes('/cabinet/')) return response({ result: {} });
    checked.push(target.pathname);
    return response({ shipping: { traces: [] } });
  } })({ platform: 'pdd' }, 'pdd_user_id=1', { knownOrders: [
    ...list.map(order => ({ platformOrderId: order.order_sn, shipments: [{ waybillNo: order.tracking_number, status: 'transit', logisticsCheckedAt: NOW }] })),
    { platformOrderId: 'missing', shipments: [{ waybillNo: 'MISSING', status: 'transit', logisticsCheckedAt: 1 }] },
  ] });
  assert.equal(checked.length, 26);
  assert.equal(checked[0], '/proxy/api/order/missing/shipping');
  assert.equal(result.orders.length, 25);
});

test('logistics payloads are bounded without truncating order or shipment collection', () => {
  const stages = Array.from({ length: 120 }, (_, index) => ({ title: `节点${index}`, labelDesc: { text: 'x'.repeat(900) }, subtitle: 't'.repeat(150) }));
  const parcel = taobaoParcels({ mailNo: 'A', multiStage: stages }, 'o')[0];
  assert.equal(parcel.logisticsEvents.length, 100);
  assert.equal(parcel.logisticsTruncated, true);
  assert.ok(parcel.logisticsEvents.every(event => event.description.length <= 600 && event.timeText.length <= 100 && event.time === 0));
});

test('events deduplicate and sort credible times before trimming while unknown times keep their order', () => {
  const events = [
    { time: '未知一', description: '无时间一' },
    ...Array.from({ length: 120 }, (_, i) => ({ time: 1793000000 + i, description: `节点${i}` })),
    { time: 1793000119, description: '节点119' }, { time: '未知二', description: '无时间二' },
  ];
  const normalized = normalizeLogisticsEvents(events, timestamp);
  assert.equal(normalized.events.length, 100);
  assert.equal(normalized.events[0].description, '节点119');
  assert.equal(normalized.events[99].description, '节点20');
  assert.equal(normalized.truncated, true);
  const unknown = normalizeLogisticsEvents([events[0], events.at(-1), events[1]], timestamp);
  assert.deepEqual(unknown.events.map(event => event.description), ['节点0', '无时间一', '无时间二']);
  const bounded = normalizeLogisticsEvents(Array.from({ length: 2001 }, (_, i) => ({ time: 1793000000 + i, description: `节点${i}` })), timestamp);
  assert.equal(bounded.events[0].description, '节点1999');
  assert.equal(bounded.truncated, true);
});

test('Taobao UI stage status changes do not duplicate an otherwise identical event', () => {
  const event = { time: '2026-10-30 09:00:00', timeText: '2026-10-30 09:00:00', description: '包裹运输中', location: '', provider: 'taobao', providerStatusTag: '运输中', providerStatusText: '包裹运输中' };
  const normalized = normalizeLogisticsEvents([
    { ...event, providerStatus: 'waitdo' },
    { ...event, providerStatus: 'doing' },
    { ...event, providerStatus: 'done' },
  ], timestamp);
  assert.equal(normalized.events.length, 1);
  assert.equal(normalized.events[0].providerStatus, 'waitdo');
  const pdd = normalizeLogisticsEvents([
    { ...event, provider: 'pdd', providerStatus: 'WAIT' },
    { ...event, provider: 'pdd', providerStatus: 'DONE' },
  ], timestamp);
  assert.equal(pdd.events.length, 2);
  const unknownTaobao = normalizeLogisticsEvents([
    { ...event, providerStatus: 'waitdo' },
    { ...event, providerStatus: 'paused' },
  ], timestamp);
  assert.equal(unknownTaobao.events.length, 2);
});

test('Taobao deduplication preserves conflicting and corroborating pickup completion states in either order', () => {
  const event = { time: NOW - 60000, timeText: '2026-10-31 09:59:00', timePrecision: 'second', description: '已签收：包裹已从代收点取出',
    provider: 'taobao', providerStatusTag: '已签收', providerStatusText: '包裹已从代收点取出' };
  for (const statuses of [['doing', 'waitdo'], ['waitdo', 'doing'], ['done', 'doing'], ['doing', 'done']]) {
    const events = statuses.map(providerStatus => ({ ...event, providerStatus }));
    const expected = detectPickupCompletion({ logisticsEvents: events }, { now: NOW });
    const normalized = normalizeLogisticsEvents(events, timestamp, [], NOW).events;
    assert.equal(normalized.length, 2, statuses.join(','));
    assert.deepEqual(detectPickupCompletion({ logisticsEvents: normalized }, { now: NOW }), expected, statuses.join(','));
  }
});

test('Taobao nonempty SSR still supplements full ascending PC track and preserves SSR when fallback fails', async () => {
  const fields = { mailNo: 'A', multiStage: [{ title: '运输中', subtitle: '2026-10-29 09:00:00', labelDesc: { text: '已揽收' } }] };
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoFetch(fields, { expressId: 'A', address: [
    { place: '正在派送', time: '2026-10-30 09:00:00' }, { place: '已签收', time: '2026-10-31 09:00:00' },
  ] }) })({ platform: 'taobao' }, cookie);
  assert.equal(result.shipments[0].logisticsEvents.length, 3);
  assert.equal(result.shipments[0].logisticsEvents[0].description, '已签收');
  assert.equal(result.shipments[0].status, 'signed');
  const failed = await createCollector({ now: () => NOW, fetchImpl: taobaoFetch(fields, {}) })({ platform: 'taobao' }, cookie);
  assert.equal(failed.shipments[0].logisticsState, 'ok');
  assert.equal(failed.shipments[0].logisticsEvents.length, 1);
  assert.equal(failed.shipments[0].status, 'transit');
});

test('an undated current SSR pickup notice is not downgraded by an older dated PC event', async () => {
  const fields = { mailNo: 'A', multiStage: [{ title: '待取件', subtitle: '10-31 09:00', labelDesc: { text: '请及时取件' },
    cardDesc: { title: '合成驿站', custom: { expressCode: { code: '7-1-1234' } } } }] };
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoFetch(fields, { expressId: 'A', address: [{ place: '正在派送', time: '2026-10-30 09:00:00' }] }) })(
    { platform: 'taobao' }, cookie);
  assert.equal(result.shipments[0].status, 'arrived');
  assert.equal(result.shipments[0].pickupCode, '7-1-1234');
  assert.equal(result.shipments[0].arrivalAt, 0);
  assert.equal(result.shipments[0].logisticsEvents.length, 2);
});

test('PDD uses the latest trusted event even when traces arrive in ascending order', async () => {
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => String(url).includes('order_list_v4')
    ? response({ orders: [{ order_sn: 'o1', tracking_number: 'A' }], has_more: false })
    : String(url).includes('/cabinet/') ? response({ result: {} })
    : response({ shipping: { tracking_number: 'A', traces: [{ info: '正在派送', time: '2026-10-30 09:00:00' }, { info: '已签收', time: '2026-10-31 09:00:00' }] } })
  })({ platform: 'pdd' }, 'pdd_user_id=1');
  assert.equal(result.shipments[0].status, 'signed');
  assert.equal(result.shipments[0].logisticsEvents[0].description, '已签收');
});

function taobaoDateFetch(orders, details, calls = []) {
  return async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'pages-g.m.taobao.com') return ssr({});
    if (!target.searchParams.has('sign')) return response({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
    if (target.pathname.includes('query.detailv2')) {
      const data = JSON.parse(new URLSearchParams(options.body).get('data'));
      calls.push({ data, target, options });
      return response(details[data.bizOrderId] || { ret: ['SUCCESS'], data: { data: {} } });
    }
    if (options.method === 'POST') return response({ ret: ['SUCCESS'], data: { data: {} } });
    const page = JSON.parse(target.searchParams.get('data')).page;
    return response({ ret: ['SUCCESS'], data: { result: { mainOrders: page === '1' ? orders : [] } } });
  };
}
const detail = labels => ({ ret: ['SUCCESS'], data: { data: { orderInfo: { fields: { labels } } } } });

test('Taobao date supplement uses signed detailv2 and accepts creation labels only', async () => {
  const calls = [];
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoDateFetch([
    { id: 'created', statusInfo: { text: '待发货' } },
    { id: 'payment-only', statusInfo: { text: '待发货' } },
    { id: 'partial', statusInfo: { text: '待发货' } },
  ], {
    created: detail([{ name: '付款时间', value: '2026-10-30 09:00:00' }, { name: '创建时间', value: '2026-10-29 09:00:00' }]),
    'payment-only': detail([{ name: '付款时间', value: '2026-10-30 09:00:00' }, { name: '发货时间', value: '2026-10-31 09:00:00' }]),
    partial: detail([{ name: '下单时间', value: '10-30 09:00' }]),
  }, calls) })({ platform: 'taobao' }, cookie);
  assert.equal(result.orders[0].orderDate, Date.parse('2026-10-29T09:00:00+08:00'));
  assert.equal(result.orders[0].orderDateOrigin, 'detail');
  assert.equal(result.orders[1].orderDate, 0);
  assert.equal(result.orders[2].orderDate, 0);
  assert.ok(result.orders.every(order => order.dateCheckedAt === NOW));
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].target.pathname, '/h5/mtop.taobao.order.query.detailv2/1.0/');
  assert.equal(calls[0].data.bizOrderId, 'created');
  assert.equal(calls[0].data.appName, 'tborder');
  assert.match(calls[0].target.searchParams.get('sign'), /^[a-f0-9]{32}$/);
});

test('Taobao date supplement corrects known list dates, throttles requests and caps the batch', async () => {
  const calls = [];
  const records = Array.from({ length: 15 }, (_, i) => ({ id: `o${i}`, statusInfo: { text: '待发货' }, createTime: '2026-10-30 10:00:00' }));
  const knownOrders = records.map(order => ({ platformOrderId: order.id, orderStatus: '待发货', orderDateOrigin: 'list', dateCheckedAt: 0, shipments: [] }));
  knownOrders[0].dateCheckedAt = NOW - 1000;
  knownOrders[1].orderDateOrigin = 'detail';
  knownOrders[1].orderDatePrecision = 'second';
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoDateFetch(records, { o2: detail([{ name: '创建时间：', value: '2026-10-28 10:00:00' }]) }, calls) })(
    { platform: 'taobao' }, cookie, { knownOrders });
  assert.equal(calls.length, 10);
  assert.equal(result.orders.length, 15);
  assert.equal(result.orders[0].dateCheckedAt, undefined);
  assert.equal(result.orders[1].dateCheckedAt, undefined);
  assert.equal(result.orders[2].orderDateOrigin, 'detail');
  assert.equal(result.orders[2].orderDate, Date.parse('2026-10-28T10:00:00+08:00'));
  assert.equal(result.orders.at(-1).dateCheckedAt, undefined);
});

test('Taobao repairs legacy detail precision within the existing cooldown and budget without replacing protected dates', async t => {
  const store = new Store({ key: Buffer.alloc(32, 1), now: () => NOW });
  t.after(() => store.close());
  store.saveAccount({ platform: 'taobao', label: 'fixture', cookie: 'SYNTHETIC' }, 'a', true);
  const originalDate = Date.parse('2026-10-28T09:00:00+08:00');
  const orders = Array.from({ length: 16 }, (_, i) => ({ platformOrderId: `o${i}`, orderStatus: '待发货', orderDate: originalDate, orderDateOrigin: 'detail',
    dateCheckedAt: i === 0 ? NOW - 1000 : NOW - 2 * 86400000, ...([1, 2, 3].includes(i) ? { orderDatePrecision: ['minute', 'second', 'day'][i - 1] } : {}) }));
  store.importResult('a', { orders, shipments: [] });
  const knownOrders = store.snapshot(['a']).orders;
  assert.equal(knownOrders.find(order => order.platformOrderId === 'o4').orderDatePrecision, undefined);
  knownOrders.find(order => order.platformOrderId === 'o5').orderDatePrecision = 'unknown';
  const records = orders.map(order => ({ id: order.platformOrderId, statusInfo: { text: '待发货' }, createTime: '2026-10-30 10:00:00' }));
  const details = Object.fromEntries(orders.map(order => [order.platformOrderId, detail([{ name: '下单时间', value: '2026-10-28 09:00' }])]));
  const calls = [];
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoDateFetch(records, details, calls) })({ platform: 'taobao' }, cookie, { knownOrders });
  assert.deepEqual(calls.map(call => call.data.bizOrderId), Array.from({ length: 10 }, (_, i) => `o${i + 4}`));
  store.importResult('a', result);
  const repaired = store.snapshot(['a']).orders;
  assert.ok(repaired.every(order => order.orderDate === originalDate && order.orderDateOrigin === 'detail'));
  for (let i = 4; i < 14; i++) assert.equal(repaired.find(order => order.platformOrderId === `o${i}`).orderDatePrecision, 'minute');
  for (const id of ['o0', 'o14', 'o15']) assert.equal(repaired.find(order => order.platformOrderId === id).orderDatePrecision, undefined);
});

test('Taobao explicit single-digit dates retain minute or second precision through collection and Store', async t => {
  const store = new Store({ key: Buffer.alloc(32, 1), now: () => NOW });
  t.after(() => store.close());
  store.saveAccount({ platform: 'taobao', label: 'fixture', cookie: 'SYNTHETIC' }, 'a', true);
  const cases = [
    ['list-minute', '2026-1-2 3:04', 'minute', '2026-01-02T03:04:00+08:00'],
    ['list-second', '2026/1/2 3:04:05', 'second', '2026-01-02T03:04:05+08:00'],
    ['detail-minute', '2026-1-2T3:04', 'minute', '2026-01-02T03:04:00+08:00'],
    ['detail-second', '2026年1月2日 3:04:05', 'second', '2026-01-02T03:04:05+08:00'],
  ];
  const records = cases.map(([id, raw]) => ({ id, statusInfo: { text: '待发货' }, ...(id.startsWith('list') ? { createTime: raw } : {}) }));
  const details = Object.fromEntries(cases.map(([id, raw]) => [id, detail([{ name: '下单时间', value: raw }])]));
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoDateFetch(records, details) })({ platform: 'taobao' }, cookie);
  store.importResult('a', result);
  for (const [id, , precision, iso] of cases) {
    const order = store.snapshot(['a']).orders.find(order => order.platformOrderId === id);
    assert.equal(order.orderDate, Date.parse(iso), id);
    assert.equal(order.orderDatePrecision, precision, id);
  }
});

test('Taobao empty legacy detail supplements preserve unknown precision and cool down even outside the list', async t => {
  const store = new Store({ key: Buffer.alloc(32, 1), now: () => NOW });
  t.after(() => store.close());
  store.saveAccount({ platform: 'taobao', label: 'fixture', cookie: 'SYNTHETIC' }, 'a', true);
  const originalDate = NOW - 3 * 86400000;
  store.importResult('a', { orders: [{ platformOrderId: 'old', orderStatus: '待发货', orderDate: originalDate, orderDateOrigin: 'detail', dateCheckedAt: NOW - 2 * 86400000 }], shipments: [] });
  const calls = [];
  const collect = createCollector({ now: () => NOW, fetchImpl: taobaoDateFetch([], {}, calls) });
  store.importResult('a', await collect({ platform: 'taobao' }, cookie, { knownOrders: store.snapshot(['a']).orders }));
  assert.equal(calls.length, 1);
  const saved = store.snapshot(['a']).orders[0];
  assert.equal(saved.orderDate, originalDate);
  assert.equal(saved.orderDatePrecision, undefined);
  assert.equal(saved.dateState, 'empty');
  assert.equal(saved.dateCheckedAt, NOW);
  await collect({ platform: 'taobao' }, cookie, { knownOrders: [saved] });
  assert.equal(calls.length, 1);
});

test('Taobao date supplement updates active pending orders outside the list without importing them', async () => {
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoDateFetch([], { known: detail([{ name: '下单时间', value: '2026-10-25 08:00:00' }]) }) })(
    { platform: 'taobao' }, cookie, { knownOrders: [{ platformOrderId: 'known', orderStatus: '待发货', shipments: [] }] });
  assert.deepEqual(result.orders, []);
  assert.deepEqual(result.orderUpdates, [{ platformOrderId: 'known', dateCheckedAt: NOW, dateState: 'ok', dateError: '', orderDate: Date.parse('2026-10-25T08:00:00+08:00'), orderDatePrecision: 'second', orderDateOrigin: 'detail' }]);
  assert.ok(!result.warnings.some(warning => warning.includes('订单筛选')));
});

test('Taobao detail risk failures preserve list data while explicit session expiry still aborts', async () => {
  const orders = [{ id: 'o1', statusInfo: { text: '待发货' } }];
  const result = await createCollector({ now: () => NOW, fetchImpl: taobaoDateFetch(orders, { o1: { ret: ['FAIL_SYS_USER_VALIDATE::验证'] } }) })({ platform: 'taobao' }, cookie);
  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].orderDate, 0);
  assert.equal(result.orders[0].dateCheckedAt, NOW);
  assert.ok(result.warnings.some(warning => warning.includes('日期补查')));
  await assert.rejects(createCollector({ fetchImpl: taobaoDateFetch(orders, { o1: { ret: ['FAIL_SYS_SESSION_EXPIRED::登录过期'] } }) })({ platform: 'taobao' }, cookie), { code: 'ACCOUNT_EXPIRED' });
});

test('Taobao ignores picked and hidden metadata, and refreshes signed-unpicked logistics', async () => {
  const records = ['picked', 'hidden', 'signed', 'active', 'explicit'].map(id => ({ id, statusInfo: { text: '交易成功' } }));
  const calls = [];
  const base = taobaoDateFetch(records, {});
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'pages-g.m.taobao.com') calls.push(target.searchParams.get('bizOrderId'));
    return base(url, options);
  };
  const result = await createCollector({ now: () => NOW, fetchImpl })({ platform: 'taobao' }, cookie, {
    trackedOrderIds: ['explicit'],
    knownOrders: [
      { platformOrderId: 'picked', orderDateOrigin: 'detail', shipments: [{ waybillNo: 'P', status: 'arrived', picked: true }] },
      { platformOrderId: 'hidden', orderDateOrigin: 'detail', shipments: [{ waybillNo: 'H', status: 'transit', hidden: true }] },
      { platformOrderId: 'signed', orderDateOrigin: 'detail', shipments: [{ waybillNo: 'S', status: 'signed' }] },
      { platformOrderId: 'active', orderDateOrigin: 'detail', shipments: [{ waybillNo: 'A', status: 'transit' }] },
    ],
  });
  assert.deepEqual(calls, ['signed', 'active']);
  assert.equal(result.orderUpdates.length, 2);
  assert.deepEqual(result.orders, []);
});

test('Taobao full-track covers every order and prioritizes detail timestamps independently of SSR', async () => {
  const records = Array.from({ length: 21 }, (_, i) => ({ id: `o${i}`, statusInfo: { text: '待收货' } }));
  let attempted = [];
  const base = taobaoDateFetch(records, {});
  const fetchImpl = async (url, options) => {
    const target = new URL(url);
    if (target.hostname === 'pages-g.m.taobao.com') return ssr({ mailNo: target.searchParams.get('bizOrderId'), multiStage: [{ title: '运输中', labelDesc: { text: '运输中' } }] });
    if (target.hostname === 'buyertrade.taobao.com') {
      attempted.push(target.searchParams.get('bizOrderId'));
      return response({ expressId: target.searchParams.get('bizOrderId'), address: [] });
    }
    return base(url, options);
  };
  const collect = createCollector({ now: () => NOW, fetchImpl });
  const knownOrders = records.map(order => ({ platformOrderId: order.id, orderDateOrigin: 'detail', shipments: [{ waybillNo: order.id, status: 'transit' }] }));
  const first = await collect({ platform: 'taobao' }, cookie, { knownOrders });
  assert.equal(attempted.length, 21);
  assert.ok(attempted.includes('o20'));
  assert.equal(first.shipments.at(-1).logisticsCheckedAt, NOW);
  assert.equal(first.shipments.at(-1).logisticsDetailCheckedAt, NOW);
  for (const order of knownOrders) order.shipments = first.shipments.filter(parcel => parcel.platformOrderId === order.platformOrderId);
  knownOrders.at(-1).shipments[0].logisticsDetailCheckedAt = 1;
  attempted = [];
  const second = await collect({ platform: 'taobao' }, cookie, { knownOrders });
  assert.equal(attempted.length, 21);
  assert.equal(attempted[0], 'o20');
  assert.equal(second.shipments.at(-1).logisticsDetailCheckedAt, NOW);
});

for (const platform of ['taobao', 'pdd']) {
  for (const listed of [false, true]) {
    test(`${platform} mixed-status split orders retain parcel identities across complete ${listed ? 'listed' : 'absent'} batches`, async () => {
      const knownOrders = Array.from({ length: 21 }, (_, i) => ({ platformOrderId: `o${i}`, orderDateOrigin: 'detail', shipments: [
        { waybillNo: `A${i}`, status: 'transit', logisticsCheckedAt: 0, logisticsDetailCheckedAt: 0 },
        ...(i === 20 ? [] : [
          { waybillNo: `B${i}`, status: 'transit', logisticsCheckedAt: 0, logisticsDetailCheckedAt: 0 },
          { waybillNo: `S${i}`, status: 'signed', logisticsCheckedAt: 0, logisticsDetailCheckedAt: 0 },
          { waybillNo: `P${i}`, status: 'arrived', picked: true, logisticsCheckedAt: 0, logisticsDetailCheckedAt: 0 },
          { waybillNo: `H${i}`, status: 'transit', hidden: true, logisticsCheckedAt: 0, logisticsDetailCheckedAt: 0 },
          { waybillNo: '', status: 'transit', logisticsCheckedAt: 0, logisticsDetailCheckedAt: 0 },
        ]),
      ] }));
      let attempted = [];
      const taobaoBase = taobaoDateFetch(listed ? knownOrders.map(order => ({ id: order.platformOrderId, statusInfo: { text: '待收货' } })) : [], {});
      const fetchImpl = async (url, options) => {
        const target = new URL(url);
        if (platform === 'taobao') {
          const id = target.searchParams.get('bizOrderId');
          if (target.hostname === 'pages-g.m.taobao.com') return ssr({ mailNo: `A${id.slice(1)}`, multiStage: [{ title: '运输中', labelDesc: { text: '运输中' } }] });
          if (target.hostname === 'buyertrade.taobao.com') {
            attempted.push(id);
            return response({ expressId: `A${id.slice(1)}`, address: [] });
          }
          return taobaoBase(url, options);
        }
        if (target.pathname.includes('order_list_v4')) return response({ orders: listed ? knownOrders.map(order => ({
          order_sn: order.platformOrderId, tracking_number: order.shipments[0].waybillNo,
        })) : [], has_more: false });
        if (target.pathname.includes('/cabinet/')) return response({ result: {} });
        const id = target.pathname.match(/\/order\/([^/]+)\/shipping$/)[1];
        attempted.push(id);
        return response({ shipping: { tracking_number: `A${id.slice(1)}`, traces: [] } });
      };
      const collect = createCollector({ now: () => NOW, fetchImpl });
      const accountCookie = platform === 'taobao' ? cookie : 'pdd_user_id=1';
      const first = await collect({ platform }, accountCookie, { knownOrders });
      assert.equal(attempted.length, 21);
      assert.ok(attempted.includes('o20'));
      for (const order of knownOrders) {
        for (const parcel of order.shipments) {
          const update = first.shipments.find(item => item.platformOrderId === order.platformOrderId && item.waybillNo === parcel.waybillNo);
          if (update) Object.assign(parcel, update);
          const failure = first.logisticsFailures.find(item => item.platformOrderId === order.platformOrderId && (!item.waybillNo || item.waybillNo === parcel.waybillNo));
          if (failure) parcel.logisticsCheckedAt = failure.logisticsCheckedAt;
        }
      }
      if (platform === 'taobao') {
        const omitted = first.shipments.find(parcel => parcel.platformOrderId === 'o0' && parcel.waybillNo === 'B0');
        assert.equal(omitted.logisticsState, 'unavailable');
        assert.deepEqual(omitted.logisticsEvents, []);
        assert.equal(omitted.logisticsDetailCheckedAt, NOW);
      }
      attempted = [];
      await collect({ platform }, accountCookie, { knownOrders });
      assert.equal(attempted.length, 21);
      assert.equal(new Set(attempted).size, 21);
    });
  }
}
