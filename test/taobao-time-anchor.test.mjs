import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector } from '../src/collectors.mjs';
import { logisticsEventTimeIssue } from '../src/collector-enrichment.mjs';
import { detectPickupCompletion, validatePickupCompletionRule } from '../src/pickup-completion.mjs';

const NOW = Date.parse('2026-11-10T15:00:00+08:00');
const cookie = '_m_h5_tk=SYNTHETIC_1794240000';
const response = data => new Response(JSON.stringify(data));
const ssr = fields => new Response(`<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields } } } })};</script>`);
const stages = () => [
  { title: '已发货', subtitle: '11-10 10:35', labelDesc: { text: '包裹正在等待揽收' } },
  { title: '仓库处理中', subtitle: '11-08 10:16', labelDesc: { text: '打印完成' } },
  { title: '已下单', subtitle: '11-06 12:20', labelDesc: { text: '商品已经下单' } },
];
const knownOrder = () => ({ platformOrderId: 'SYNTHETIC-ORDER', orderStatus: '待收货',
  orderDate: Date.parse('2026-11-06T12:20:38+08:00'), orderDateOrigin: 'detail', orderDatePrecision: 'second',
  shipments: [{ waybillNo: 'SYNTHETIC-ORIGINAL', status: 'signed', picked: true }, { waybillNo: 'SYNTHETIC-REPLACEMENT', status: 'transit' }] });

async function collect({ order = knownOrder(), stageList = stages(), now = NOW, transit = { expressId: 'SYNTHETIC-ORIGINAL', address: [
  { time: '2025-11-10 10:35:47', place: '运输中' },
] } } = {}) {
  return createCollector({ now: () => now, fetchImpl: async url => {
    const u = new URL(url);
    if (u.hostname === 'pages-g.m.taobao.com') return ssr({ mailNo: 'SYNTHETIC-REPLACEMENT', multiStage: stageList,
      multiPackages: { packages: [{ mailNo: 'SYNTHETIC-ORIGINAL', cpCode: 'ZTO' }, { mailNo: 'SYNTHETIC-REPLACEMENT', cpCode: 'ZTO' }] } });
    if (u.hostname === 'buyertrade.taobao.com') return new Response(JSON.stringify(transit).replace(/[^\x00-\x7f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`));
    assert.equal(u.hostname, 'h5api.m.taobao.com');
    return response({ ret: ['SUCCESS'], data: { data: { orderInfo: { fields: { labels: [] } } } } });
  } })({ platform: 'taobao' }, cookie, { targetOrder: order });
}

test('Taobao replacement SSR minute labels use this order detail interval, never the original waybill track', async () => {
  const result = await collect();
  assert.equal(result.shipments.length, 1);
  const events = result.shipments[0].logisticsEvents;
  assert.deepEqual(events.map(event => event.time), [
    Date.parse('2026-11-10T10:35:00+08:00'), Date.parse('2026-11-08T10:16:00+08:00'), Date.parse('2026-11-06T12:20:00+08:00'),
  ]);
  assert.ok(events.every(event => event.timePrecision === 'minute'));
  assert.deepEqual(events.map(event => event.timeText), ['11-10 10:35', '11-08 10:16', '11-06 12:20']);
});

const shippingStage = subtitle => ({ title: '已发货', subtitle, labelDesc: { text: '包裹正在等待揽收' } });
const summary = result => result.shipments[0].logisticsEvents.find(event => event.provider === 'taobao');

test('Taobao order year resolves late December rollover and leap days in that year', async () => {
  for (const [date, now, label, expected] of [
    ['2025-12-30T12:00:00+08:00', '2026-01-02T10:00:00+08:00', '12-31 23:59', '2025-12-31T23:59:00+08:00'],
    ['2024-02-28T12:00:00+08:00', '2024-03-01T10:00:00+08:00', '02-29 12:00', '2024-02-29T12:00:00+08:00'],
    ['2024-11-06T00:00:00+08:00', '2026-11-10T15:00:00+08:00', '11-10 10:35', '2024-11-10T10:35:00+08:00'],
  ]) {
    const event = summary(await collect({ order: { ...knownOrder(), orderDate: Date.parse(date) }, now: Date.parse(now), stageList: [shippingStage(label)] }));
    assert.equal(event.time, Date.parse(expected), label);
    assert.equal(event.timePrecision, 'minute');
  }
});

test('Taobao order year rejects invalid, future and before-order labels without searching other years', async () => {
  for (const [date, now, label] of [
    ['2026-02-28T00:00:00+08:00', '2026-03-02T00:00:00+08:00', '02-29 12:00'],
    ['2024-02-28T00:00:00+08:00', '2024-03-02T00:00:00+08:00', '02-30 12:00'],
    ['2026-11-06T00:00:00+08:00', '2026-11-10T15:00:00+08:00', '11-10 15:01'],
    ['2026-11-06T12:20:38+08:00', '2026-11-10T15:00:00+08:00', '11-06 12:19'],
    ['2023-03-01T12:00:00+08:00', '2026-03-01T10:00:00+08:00', '02-29 12:00'],
    ['2026-11-06T00:00:00+08:00', '2026-11-10T15:00:00+08:00', '11-06 24:00'],
    ['2026-11-06T00:00:00+08:00', '2026-11-10T15:00:00+08:00', '13-06 12:00'],
  ]) {
    const event = summary(await collect({ order: { ...knownOrder(), orderDate: Date.parse(date) }, now: Date.parse(now), stageList: [shippingStage(label)] }));
    assert.equal(event.time, 0, `${date} / ${label}`);
    assert.equal(event.timePrecision, 'unknown');
  }
});

test('Taobao second and minute anchors allow their starting minute and day anchors start at Shanghai midnight', async () => {
  for (const precision of ['second', 'minute']) {
    const event = summary(await collect({ order: { ...knownOrder(), orderDatePrecision: precision }, stageList: [shippingStage('11-06 12:20')] }));
    assert.equal(event.time, Date.parse('2026-11-06T12:20:00+08:00'), precision);
  }
  const order = { ...knownOrder(), orderDate: Date.parse('2026-11-06T00:00:00Z'), orderDatePrecision: 'day' };
  assert.equal(summary(await collect({ order, stageList: [shippingStage('11-06 00:00')] })).time, Date.parse('2026-11-06T00:00:00+08:00'));
  assert.equal(summary(await collect({ order, stageList: [shippingStage('11-05 23:59')] })).time, 0);
});

test('Taobao falls back to list or observation year while leaving future anchors, estimates and completion conflicts undated', async () => {
  for (const patch of [{ orderDateOrigin: 'list' }, { orderDateOrigin: undefined }, { orderDatePrecision: 'unknown' }, { orderDate: 0 }]) {
    assert.equal(summary(await collect({ order: { ...knownOrder(), ...patch }, stageList: [shippingStage('11-10 10:35')] })).time,
      Date.parse('2026-11-10T10:35:00+08:00'));
  }
  assert.equal(summary(await collect({ order: { ...knownOrder(), orderDate: NOW + 60000 }, stageList: [shippingStage('11-10 10:35')] })).time, 0);
  const stageList = [
    ['预计发货', '预计发货'], ['已发货', 'estimated shipping'], ['已发货', 'expected shipping'],
    ['已签收', '包裹已取出'], ['已领取', '本人已领取'],
    ['已退回', '包裹已退回'], ['改派中', '包裹已改派'],
    ['已发货', '发货已撤销'], ['已发货', '已发货后已签收'],
  ].map(([title, body]) => ({ title, subtitle: '11-10 10:35', labelDesc: { text: body } }));
  assert.ok((await collect({ stageList })).shipments[0].logisticsEvents.every(event => event.time === 0));
});

test('Taobao actual pickup and movement stages share the order year', async () => {
  const stageList = [
    { title: '派送中', subtitle: '11-13 11:30', labelDesc: { text: '正在派送' } },
    { title: '待取件', subtitle: '11-13 11:28', labelDesc: { text: '已到站等待取件' } },
    { title: '运输中', subtitle: '11-12 10:00', labelDesc: { text: '包裹运输中' } },
  ];
  const events = (await collect({ stageList, now: Date.parse('2026-11-13T12:00:00+08:00') })).shipments[0].logisticsEvents;
  assert.deepEqual(events.map(event => event.time), [
    Date.parse('2026-11-13T11:30:00+08:00'),
    Date.parse('2026-11-13T11:28:00+08:00'),
    Date.parse('2026-11-12T10:00:00+08:00'),
  ]);
  assert.ok(events.every(event => event.timePrecision === 'minute'));
});

test('Taobao repeated collection without order dates retains the saved parcel year while accepting new times', async () => {
  const observed = Date.parse('2025-11-10T12:00:00+08:00');
  const now = Date.parse('2026-11-13T12:00:00+08:00');
  const order = { ...knownOrder(), orderDate: 0, shipments: [
    knownOrder().shipments[0],
    { waybillNo: 'SYNTHETIC-REPLACEMENT', status: 'transit', logisticsCheckedAt: observed, logisticsDetailCheckedAt: observed }
  ] };
  const stageList = [shippingStage('11-10 10:35'), shippingStage('11-12 10:00')];
  const first = await collect({ order, now, stageList, transit: { expressId: 'SYNTHETIC-REPLACEMENT', address: [] } });
  const expected = ['2025-11-12T10:00:00+08:00', '2025-11-10T10:35:00+08:00'].map(Date.parse);
  assert.deepEqual(first.shipments[0].logisticsEvents.map(event => event.time), expected);
  const second = await collect({ order: { ...order, shipments: [order.shipments[0], ...first.shipments] }, now: now + 86400000,
    stageList, transit: { expressId: 'SYNTHETIC-REPLACEMENT', address: [] } });
  assert.deepEqual(second.shipments[0].logisticsEvents.map(event => event.time), expected);
});

test('Taobao repeated collection retains conflicting saved full-year evidence without borrowing sibling dates', async () => {
  const savedEvent = year => ({ provider: 'taobao', timeText: `${year}-11-01 12:00`,
    time: Date.parse(`${year}-11-01T12:00:00+08:00`), timePrecision: 'minute', description: '包裹运输中' });
  const order = { ...knownOrder(), orderDate: 0, shipments: [
    knownOrder().shipments[0],
    { waybillNo: 'SYNTHETIC-REPLACEMENT', status: 'transit', logisticsCheckedAt: NOW - 60000,
      logisticsEvents: [savedEvent(2024), savedEvent(2025)] }
  ] };
  const options = { order, stageList: [shippingStage('11-10 10:35')], transit: { expressId: 'SYNTHETIC-REPLACEMENT', address: [] } };
  assert.equal(summary(await collect(options)).time, 0);
  order.shipments[0] = { ...order.shipments[0], logisticsEvents: [savedEvent(2024)] };
  order.shipments[1].logisticsEvents = [savedEvent(2025)];
  assert.equal(summary(await collect(options)).time, Date.parse('2025-11-10T10:35:00+08:00'));
});

for (const phrase of ['用户已提货', '用户已自提', '用户已提取', '用户收取成功']) {
  test(`Taobao shipping year inference cannot turn ${phrase} into collection completion`, async () => {
    const rules = [validatePickupCompletionRule({ id: 'synthetic-collection', kind: 'user_collected', keywords: [phrase] })];
    const stageList = [{ title: '已发货', subtitle: '11-10 10:35', labelDesc: { text: phrase } }];
    const before = (await collect({ order: { ...knownOrder(), orderDateOrigin: 'list' }, stageList })).shipments[0];
    assert.equal(detectPickupCompletion(before, { rules, now: NOW }), null);
    const confirmed = (await collect({ stageList: [{ ...stageList[0], subtitle: '2026-11-10 10:35' }] })).shipments[0];
    assert.equal(detectPickupCompletion(confirmed, { rules, now: NOW })?.kind, 'user_collected');
    const after = (await collect({ stageList })).shipments[0];
    assert.equal(detectPickupCompletion(after, { rules, now: NOW }), null);
    assert.equal(after.logisticsEvents[0].time, 0);
    assert.equal(after.logisticsEvents[0].timePrecision, 'unknown');
    assert.deepEqual((await collectList({ stageList })).detailCalls, []);
  });
}

for (const [phrase, kind] of [['用户已取 件', 'user_collected'], ['用户已领 取', 'user_collected'], ['本人已签 收', 'recipient_signed']]) {
  test(`Taobao year inference preserves unknown time for built-in completion ${phrase}`, async () => {
    const stage = { title: '已发货', subtitle: '11-10 10:35', labelDesc: { text: phrase } };
    const after = (await collect({ stageList: [stage] })).shipments[0];
    assert.equal(detectPickupCompletion(after, { now: NOW }), null);
    assert.equal(after.logisticsEvents[0].time, 0);
    const confirmed = (await collect({ stageList: [{ ...stage, subtitle: '2026-11-10 10:35' }] })).shipments[0];
    assert.equal(detectPickupCompletion(confirmed, { now: NOW })?.kind, kind);
  });
}

test('Taobao year inference normalizes spaced and full-width estimate wording before exclusion', async () => {
  for (const phrase of ['预 计明天送达', '预\n估明天送达', 'ｅｓｔｉｍａｔｅｄ delivery']) {
    const stageList = [{ title: '已发货', subtitle: '11-10 10:35', labelDesc: { text: phrase } }];
    assert.equal(summary(await collect({ stageList })).time, 0, phrase);
    assert.deepEqual((await collectList({ stageList })).detailCalls, [], phrase);
  }
});

test('Taobao prefers same-waybill full PC time and does not hide its ambiguity or time conflict with an anchor', async () => {
  const transit = times => ({ expressId: 'SYNTHETIC-REPLACEMENT', address: times.map(time => ({ time, place: '已发货' })) });
  const preferred = summary(await collect({ stageList: [shippingStage('11-10 10:35')], transit: transit(['2026-11-10 10:35:47']) }));
  assert.equal(preferred.time, Date.parse('2026-11-10T10:35:47+08:00'));
  for (const times of [['2025-11-10 10:35:47'], ['2027-11-10 10:35:47'], ['2026-11-10 10:35:12', '2026-11-10 10:35:47']]) {
    const result = await collect({ stageList: [shippingStage('11-10 10:35')], transit: transit(times) });
    assert.equal(summary(result).time, 0, times.join(', '));
    if (times[0].startsWith('2027')) assert.ok(result.shipments[0].logisticsEvents.some(event => logisticsEventTimeIssue(event, NOW) === 'timeConflict'));
  }
  const mixed = await collect({ stageList: [shippingStage('11-10 10:35')], transit: transit(['2026-11-09 10:35:47']) });
  assert.deepEqual(mixed.shipments[0].logisticsEvents.map(event => event.time), [Date.parse('2026-11-10T10:35:00+08:00'), Date.parse('2026-11-09T10:35:47+08:00')]);
});

async function collectList({ count = 1, stageList = stages(), knownOrders = [], detailStatus = 200, detailValue = '2026-11-06 12:20:38', extraOrders = [] } = {}) {
  const detailCalls = [], calls = [], checkpoints = [];
  const list = Array.from({ length: count }, (_, i) => ({ id: `SYNTHETIC-ORDER-${i}`, statusInfo: { text: '待收货' }, createTime: '2026-11-06 12:20:38' }));
  const result = await createCollector({ now: () => NOW, fetchImpl: async (url, options) => {
    const u = new URL(url); calls.push(u);
    if (u.hostname === 'pages-g.m.taobao.com') return ssr({ mailNo: `SYNTHETIC-WAYBILL-${u.searchParams.get('bizOrderId')}`, multiStage: stageList });
    if (u.hostname === 'buyertrade.taobao.com') return response({ expressId: 'SYNTHETIC-OTHER', address: [] });
    assert.equal(u.hostname, 'h5api.m.taobao.com');
    if (!u.searchParams.has('sign')) return response({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
    if (u.pathname.includes('detailv2')) {
      const data = JSON.parse(new URLSearchParams(options.body).get('data')); detailCalls.push(data.bizOrderId);
      if (detailStatus !== 200) return new Response('Synthetic detail failure', { status: detailStatus });
      return response({ ret: ['SUCCESS'], data: { data: { orderInfo: { fields: { labels: detailValue ? [{ name: '下单时间', value: detailValue }] : [] } } } } });
    }
    if (options.method === 'POST') return response({ ret: ['SUCCESS'], data: { data: {} } });
    const data = JSON.parse(u.searchParams.get('data'));
    return response({ ret: ['SUCCESS'], data: { result: { mainOrders: data.page === '1' ? [...list, ...extraOrders] : [] } } });
  } })({ platform: 'taobao' }, cookie, { knownOrders, onProgress: value => checkpoints.push(value) });
  return { result, detailCalls, calls, checkpoints };
}

test('Taobao new active list orders supplement detail only when the current parcel needs a shipping year anchor', async () => {
  const { result, detailCalls, checkpoints } = await collectList({ extraOrders: [
    { id: 'SYNTHETIC-PENDING', statusInfo: { text: '待发货' }, createTime: '2026-11-06 12:20:38' },
    { id: 'SYNTHETIC-CLOSED', statusInfo: { text: '交易成功' }, createTime: '2026-11-06 12:20:38' },
  ] });
  assert.deepEqual(detailCalls, ['SYNTHETIC-ORDER-0']);
  assert.equal(result.orders.find(order => order.platformOrderId === 'SYNTHETIC-ORDER-0').orderDateOrigin, 'detail');
  assert.ok(result.shipments[0].logisticsEvents.every(event => event.time > 0));
  assert.ok(checkpoints.some(value => value.orderUpdates?.some(order => order.platformOrderId === 'SYNTHETIC-ORDER-0' && order.orderDateOrigin === 'detail')));
  for (const stageList of [[shippingStage('2026-11-10 10:35')], [{ title: '已签收', subtitle: '11-10 10:35', labelDesc: { text: '包裹已取出' } }]]) {
    assert.deepEqual((await collectList({ stageList })).detailCalls, []);
  }
});

test('Taobao year-anchor detail supplements obey the shared budget, cooldown and attempted set', async () => {
  const capped = await collectList({ count: 12 });
  assert.equal(capped.detailCalls.length, 10);
  assert.equal(new Set(capped.detailCalls).size, 10);
  assert.equal(capped.result.shipments.filter(parcel => parcel.logisticsEvents.some(event => event.time > 0)).length, 12);
  const known = { ...knownOrder(), platformOrderId: 'SYNTHETIC-ORDER-0', orderDateOrigin: 'list', dateCheckedAt: NOW - 1000 };
  assert.deepEqual((await collectList({ knownOrders: [known] })).detailCalls, []);
  const failed = await collectList({ knownOrders: [{ ...known, dateCheckedAt: 0 }], detailValue: '' });
  assert.deepEqual(failed.detailCalls, ['SYNTHETIC-ORDER-0']);
  assert.ok(failed.result.shipments.every(parcel => parcel.logisticsEvents.every(event => event.time > 0 && event.timePrecision === 'minute')));
});

test('Taobao detail failure uses list year and preserves original labels; risk errors still stop collection', async () => {
  const failed = await collectList({ detailStatus: 503 });
  assert.equal(failed.result.orders[0].orderDateOrigin, 'list');
  assert.equal(failed.result.orders[0].orderDate, Date.parse('2026-11-06T12:20:38+08:00'));
  assert.equal(failed.result.orders[0].dateState, 'error');
  assert.deepEqual(failed.result.shipments[0].logisticsEvents.map(event => event.time),
    ['2026-11-10T10:35:00+08:00', '2026-11-08T10:16:00+08:00', '2026-11-06T12:20:00+08:00'].map(Date.parse));
  assert.deepEqual(failed.result.shipments[0].logisticsEvents.map(event => event.timeText), ['11-10 10:35', '11-08 10:16', '11-06 12:20']);
  for (const [detailStatus, code] of [[401, 'ACCOUNT_EXPIRED'], [403, 'UPSTREAM_BLOCKED'], [429, 'UPSTREAM_RATE_LIMITED']]) {
    await assert.rejects(collectList({ detailStatus }), { code });
  }
});
