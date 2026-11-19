import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, extractSsrFields, pddParcels, platformRequest, taobaoParcels, timestamp } from '../src/collectors.mjs';

const response = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
const ssr = fields => `<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields } } } })};</script>`;

function taobaoFetch(orders, fieldsById = {}, calls = []) {
  return async (url, options) => {
    const target = new URL(url); calls.push({ target, options });
    if (target.hostname === 'pages-g.m.taobao.com') {
      return new Response(ssr(fieldsById[target.searchParams.get('bizOrderId')] || {}));
    }
    if (!target.searchParams.has('sign')) return response({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
    if (options.method === 'POST') return response({ ret: ['SUCCESS::调用成功'], data: { data: {} } });
    const page = JSON.parse(target.searchParams.get('data')).page;
    return response({ ret: ['SUCCESS::调用成功'], data: { result: JSON.stringify({ mainOrders: page === '1' ? orders : [] }) } });
  };
}

test('Taobao coverage separates a complete active-order window from bounded or repeated pages', async () => {
  const waiting = [{ id: 'coverage-order', createTime: Date.now(), extra: { tradeStatus: 'WAIT_SELLER_SEND_GOODS' },
    subOrders: [{ itemInfo: { title: 'Synthetic pending item' } }] }];
  const complete = await createCollector({ maxPages: 3, fetchImpl: taobaoFetch(waiting) })({ platform: 'taobao' }, '_m_h5_tk=TEST_1793350000');
  assert.deepEqual(complete.collectionCoverage, { version: 1, scope: 'active_orders', status: 'complete', reason: 'end',
    pagesRead: 2, pageLimit: 3, seenOrders: 1, activeOrders: 1, trackedOutsideWindow: 0 });
  const bounded = await createCollector({ maxPages: 1, fetchImpl: taobaoFetch(waiting) })({ platform: 'taobao' }, '_m_h5_tk=TEST_1793350000');
  assert.equal(bounded.collectionCoverage.status, 'partial'); assert.equal(bounded.collectionCoverage.reason, 'page_limit');
  const fetchPage = taobaoFetch(waiting);
  const repeated = await createCollector({ maxPages: 3, fetchImpl: (url, options) => {
    const target = new URL(url), raw = target.searchParams.get('data');
    if (raw && JSON.parse(raw).page) target.searchParams.set('data', JSON.stringify({ ...JSON.parse(raw), page: '1' }));
    return fetchPage(target.href, options);
  } })({ platform: 'taobao' }, '_m_h5_tk=TEST_1793350000');
  assert.equal(repeated.collectionCoverage.reason, 'repeated_page'); assert.equal(repeated.collectionCoverage.pagesRead, 2);
  assert.equal(bounded.orders.length, complete.orders.length);
});

test('Taobao structured SSR retains every split waybill and never fans one parent code out to all parcels', () => {
  const fields = { multiPackages: { packages: [{ mailNo: 'A', cpCode: 'ZTO' }, { mailNo: 'B', cpCode: 'SF' }] } };
  assert.deepEqual(extractSsrFields(ssr(fields)), fields);
  const parcels = taobaoParcels(fields, 'order-1', 'PARENT-CODE');
  assert.equal(parcels.length, 2); assert.ok(parcels.every(p => p.pickupCode === '' && !('picked' in p)));
  assert.deepEqual(parcels.map(p => p.carrier), ['中通快递', '顺丰速运']);
  const signed = taobaoParcels({ mailNo: 'A', logisticCompany: { name: '中通快递' }, multiStage: [{ title: '已签收', labelDesc: { text: '本人签收' } }] }, 'order-1')[0];
  assert.equal(signed.status, 'signed'); assert.ok(!('picked' in signed));
  const arrived = taobaoParcels({ mailNo: 'A', multiStage: [{ title: '待取件', time: '2026-10-30 10:00:00', cardDesc: { title: '驿站', custom: { expressCode: { code: '8-2-1234' } } } }] }, 'o')[0];
  assert.equal(arrived.status, 'arrived'); assert.equal(arrived.pickupCode, '8-2-1234'); assert.equal(arrived.arrivalAt, Date.parse('2026-10-30T10:00:00+08:00'));
});

test('PDD collectors use real H5 paths with injected network, paginate and keep no-code and split shipments', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url); calls.push({ target, options });
    if (target.pathname.includes('order_list_v4')) {
      if (target.searchParams.get('page') === '1') return response({ orders: [{ order_sn: 'o1', tracking_number: 'TRACK1', order_time: 1793350000, order_goods: [{ goods_name: '无取件码包裹' }], offset: 'next' }] });
      return response({ orders: [{ order_sn: 'o2', shipping_list: [{ tracking_number: 'SPLIT1' }, { tracking_number: 'SPLIT2' }], order_goods: [], order_amount: 1234 }], has_more: false });
    }
    return response({ success: true, result: { code: '', status: 0 } });
  };
  const collect = createCollector({ fetchImpl });
  const result = await collect({ platform: 'pdd' }, 'PDDAccessToken=FAKE;pdd_user_id=123');
  assert.equal(result.orders.length, 2); assert.equal(result.shipments.length, 3); assert.equal(result.orders[1].amount, 12.34);
  assert.ok(result.shipments.every(s => !s.pickupCode && !('picked' in s)));
  assert.equal(calls.find(c => c.target.searchParams.get('page') === '2').target.searchParams.get('offset'), 'next');
  for (const call of calls) {
    assert.equal(call.options.redirect, 'error'); assert.match(call.options.headers.Cookie, /PDDAccessToken=FAKE/);
    if (call.target.pathname.includes('/cabinet/')) assert.equal(call.target.search, '');
  }
  assert.deepEqual([...new Set(calls.filter(c => c.target.pathname.includes('order_list_v4')).map(c => c.target.searchParams.get('type')))], ['unshipping', 'unreceived']);
});

test('PDD disappearance and bounded pagination have no synthesized pick/delete events', async () => {
  const collect = createCollector({ maxPages: 1, fetchImpl: async url => String(url).includes('order_list_v4') ? response({ orders: [{ order_sn: 'o1', tracking_number: 'A' }] }) : response({ result: { code: '123456', address: '站点' } }) });
  const result = await collect({ platform: 'pdd' }, 'pdd_user_id=1');
  assert.equal(result.shipments[0].status, 'arrived'); assert.ok(result.warnings.some(w => w.includes('分页上限')));
  assert.ok(!('deletedIds' in result)); assert.ok(!('picked' in result.shipments[0]));
  const signed = pddParcels({ order_sn: 'old', tracking_number: 'A', order_status_text: '交易完成' }, { code: 'OLD' })[0];
  assert.equal(signed.status, 'signed'); assert.equal(signed.arrivalAt, 0);
});

test('Taobao MTOP signing and SSR collection preserve order plus all waybills without a live account', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url); calls.push({ target, options });
    if (target.hostname === 'pages-g.m.taobao.com') return new Response(ssr({ multiPackages: { packages: [{ mailNo: 'A', cpCode: 'ZTO' }, { mailNo: 'B', cpCode: 'SF' }] } }));
    if (!target.searchParams.has('sign')) return response({ ret: ['FAIL_SYS_TOKEN_EMPTY'] });
    assert.match(target.searchParams.get('sign'), /^[a-f0-9]{32}$/);
    if (options.method === 'POST') return response({ ret: ['SUCCESS::调用成功'], data: { data: { comServiceTips_o1: { fields: { singleLineRiceText: [{ richStr: '取件码 123456' }] } } } } });
    const page = JSON.parse(target.searchParams.get('data')).page;
    return response({ ret: ['SUCCESS::调用成功'], data: { result: JSON.stringify({ mainOrders: page === '1' ? [{ id: 'o1', subOrders: [{ itemInfo: { title: '拆单商品' } }], statusInfo: { text: '待收货' } }] : [] }) } });
  };
  const result = await createCollector({ fetchImpl })({ platform: 'taobao' }, '_m_h5_tk=TEST_1793350000');
  assert.equal(result.orders.length, 1); assert.equal(result.shipments.length, 2); assert.ok(result.shipments.every(s => !s.pickupCode));
  assert.ok(calls.some(c => c.target.pathname.endsWith('/h5-detail')));
  assert.ok(calls.some(c => c.options.method === 'POST' && c.options.body.startsWith('data=')));
});

test('upstream expired response is explicit, requests cannot follow redirects or access arbitrary hosts', async () => {
  const collect = createCollector({ fetchImpl: async () => response({ error_code: 40001 }) });
  await assert.rejects(() => collect({ platform: 'pdd' }, 'pdd_user_id=1'), { code: 'ACCOUNT_EXPIRED' });
  await assert.rejects(() => platformRequest('https://evil.example/cookie', 'secret'), { code: 'INVALID_UPSTREAM' });
  await assert.rejects(() => platformRequest('https://mobile.yangkeduo.com/test', 'secret', { fetchImpl: async () => new Response('x', { headers: { 'Content-Length': '99999999' } }) }), { code: 'UPSTREAM_ERROR' });
  assert.equal(timestamp('2026-10-30 10:00:00'), Date.parse('2026-10-30T10:00:00+08:00'));
});

test('Taobao skips completed or unrelated new orders without requesting logistics', async () => {
  const calls = [];
  const orders = [
    { id: 'done', extra: { tradeStatus: 'TRADE_FINISHED' }, statusInfo: { text: '交易成功' }, subOrders: [{ itemInfo: { title: '闪购商品' } }] },
    { id: 'unpaid', extra: { tradeStatus: 'WAIT_BUYER_PAY' }, statusInfo: { text: '待付款' } },
    { id: 'unknown', extra: { tradeStatus: 'SOMETHING_NEW' }, statusInfo: { text: '其他' } },
    { id: 'conflicting', extra: { tradeStatus: 'WAIT_BUYER_CONFIRM_GOODS' }, statusInfo: { text: '退款成功' } },
  ];
  const result = await createCollector({ fetchImpl: taobaoFetch(orders, {}, calls) })({ platform: 'taobao' }, '_m_h5_tk=TEST_1793350000');
  assert.deepEqual(result.orders, []);
  assert.deepEqual(result.orderUpdates, []);
  assert.ok(result.warnings.includes('订单筛选：本轮保留0笔，跳过4笔已结束或非待收货订单'));
  assert.equal(calls.filter(c => c.target.hostname === 'pages-g.m.taobao.com').length, 0);
});

test('Taobao retains waiting shipment and no-code in-transit orders without inventing logistics', async () => {
  const calls = [];
  const orders = [
    { id: 'ship-later', extra: { tradeStatus: 'WAIT_SELLER_SEND_GOODS' }, statusInfo: { text: '待发货' } },
    { id: 'moving', extra: { tradeStatus: 'WAIT_BUYER_CONFIRM_GOODS' }, statusInfo: { text: '待收货' } },
    { id: 'fallback-moving', statusInfo: { text: '派件中' } },
    { id: 'pending-signature', extra: { tradeStatus: 'WAIT_BUYER_CONFIRM_GOODS' }, statusInfo: { text: '待签收' } },
  ];
  const result = await createCollector({ fetchImpl: taobaoFetch(orders, { moving: { mailNo: 'NO-CODE' }, 'fallback-moving': { mailNo: 'FALLBACK-NO-CODE' }, 'pending-signature': { mailNo: 'PENDING-SIGNATURE' } }, calls) })({ platform: 'taobao' }, '_m_h5_tk=TEST_1793350000');
  assert.deepEqual(result.orders.map(order => order.platformOrderId), ['ship-later', 'moving', 'fallback-moving', 'pending-signature']);
  assert.equal(result.shipments.length, 3);
  assert.equal(result.shipments[0].waybillNo, 'NO-CODE');
  assert.equal(result.shipments[0].status, 'unknown');
  assert.equal(calls.filter(c => c.target.hostname === 'pages-g.m.taobao.com').length, 3);
});

test('Taobao refreshes a tracked finished order and reports its metadata without importing it', async () => {
  const calls = [];
  const order = { id: 'tracked', extra: { tradeStatus: 'WAIT_BUYER_CONFIRM_GOODS' }, statusInfo: { text: '退款成功' }, refundStatus: 'REFUND_SUCCESS', createTime: '2026-10-30 10:00:00' };
  const result = await createCollector({ fetchImpl: taobaoFetch([order], { tracked: { mailNo: 'TRACKED-1', multiStage: [{ title: '已签收', labelDesc: { text: '本人签收' } }] } }, calls) })(
    { platform: 'taobao' }, '_m_h5_tk=TEST_1793350000', { knownOrders: [{ platformOrderId: 'tracked', shipments: [{ waybillNo: 'TRACKED-1' }] }] });
  assert.deepEqual(result.orders, []);
  assert.equal(result.orderUpdates[0].tradeStatus, 'WAIT_BUYER_CONFIRM_GOODS');
  assert.equal(result.orderUpdates[0].refundStatus, 'REFUND_SUCCESS');
  assert.equal(result.orderUpdates[0].orderDate, Date.parse('2026-10-30T10:00:00+08:00'));
  assert.equal(result.shipments[0].status, 'signed');
  assert.equal(calls.filter(c => c.target.hostname === 'pages-g.m.taobao.com').length, 1);
});

test('Taobao parcel status lets current signature override historical arrival but preserves evidence', () => {
  const signed = taobaoParcels({ mailNo: 'A', multiStage: [
    { title: '已签收', labelDesc: { text: '本人签收' }, time: '2026-10-31 10:00:00' },
    { title: '待取件', labelDesc: { text: '已存放至驿站' }, time: '2026-10-30 10:00:00', cardDesc: { custom: { expressCode: { code: 'OLD-CODE' } } } },
  ] }, 'o')[0];
  assert.equal(signed.status, 'signed');
  assert.equal(signed.pickupCode, 'OLD-CODE');
  assert.equal(signed.arrivalAt, Date.parse('2026-10-30T10:00:00+08:00'));
  const station = taobaoParcels({ mailNo: 'B', multiStage: [{ title: '签收', labelDesc: { text: '驿站代收签收请取件' } }] }, 'o')[0];
  assert.equal(station.status, 'arrived');
  const transit = taobaoParcels({ mailNo: 'C', multiStage: [
    { title: '派件中', labelDesc: { text: '正在派件' } },
    { title: '待取件', labelDesc: { text: '已存放至驿站' }, cardDesc: { custom: { expressCode: { code: 'OLD-CODE' } } } },
  ] }, 'o')[0];
  assert.equal(transit.status, 'transit');
  const pendingSignature = taobaoParcels({ mailNo: 'D', multiStage: [{ title: '待签收', labelDesc: { text: '等待本人签收' } }] }, 'o')[0];
  assert.equal(pendingSignature.status, 'unknown');
  const structuredPickup = taobaoParcels({ mailNo: 'E', multiStage: [{ title: '签收', labelDesc: { text: '已签收' }, cardDesc: { title: '驿站', custom: { expressCode: { code: 'CURRENT-CODE' } } } }] }, 'o')[0];
  assert.equal(structuredPickup.status, 'arrived');
  assert.equal(taobaoParcels({ mailNo: 'F', multiStage: [{ title: '派送中', labelDesc: { text: '您的快件正在派送，请当面签收' } }] }, 'o')[0].status, 'transit');
  assert.equal(taobaoParcels({ mailNo: 'G', multiStage: [{ title: '派件中', labelDesc: { text: '等待本人签收' } }] }, 'o')[0].status, 'transit');
  assert.equal(taobaoParcels({ mailNo: 'H', multiStage: [{ title: '签收失败', labelDesc: { text: '签收失败' } }] }, 'o')[0].status, 'unknown');
  assert.equal(taobaoParcels({ mailNo: 'I', multiStage: [{ title: '客户拒绝签收', labelDesc: { text: '客户拒绝签收，退回中' } }] }, 'o')[0].status, 'unknown');
});
