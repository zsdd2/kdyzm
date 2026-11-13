import test from 'node:test';
import assert from 'node:assert/strict';
import { createCollector, jdParcels } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';
import { hash } from '../src/security.mjs';

const NOW = Date.parse('2026-11-11T12:00:00+08:00');
const step = (description, offset = -1000, status = '') => ({ CreationTime: NOW + offset, StatusName: status, Content: description });
const tracking = (steps, carrier = '京东物流') => ({ multiPackageTrackInfoList: [{
  carriageInfo: { carriageId: 'SYNTHETIC-JD', carrier }, trackGroupInfo: { orderTrackShowList: steps },
}] });
const parcel = steps => jdParcels(tracking(steps), 'o', NOW)[0];
function fixture(t, platform = 'jd') {
  let clock = NOW;
  const store = new Store({ key: Buffer.alloc(32, 7), now: () => clock });
  t.after(() => store.close());
  store.saveAccount({ platform, label: 'synthetic', cookie: 'FIXTURE' }, 'a', true);
  const read = () => store.snapshot(['a']).shipments[0];
  const sync = input => store.importResult('a', { orders: [{ platformOrderId: 'o', orderDate: NOW - 86400000, orderStatus: '待收货' }],
    shipments: [{ ...input, logisticsCheckedAt: ++clock }] });
  return { store, read, sync };
}

test('JD collector and store keep warehouse preparation pending even with a waybill and shipped list status', async t => {
  const f = fixture(t);
  const descriptions = ['您的订单已经进入北京仓库，准备出库', '您的订单已经打印完成', '商品已打包完成，等待出库',
    '已发货：包裹正在等待揽收', '商家已发货', '包裹等待快递员揽收'];
  for (const description of descriptions) {
    const collect = createCollector({ now: () => NOW, fetchImpl: async url => new Response(JSON.stringify(
      new URL(url).searchParams.get('functionId') === 'pcdetail_traceMultiPackage' ? tracking([step(description)])
        : { success: true, data: { orderList: [{ orderId: 'o', orderType: 0, statusInfo: { orderState: 15, orderStateName: '已发货' },
          wareList: [{ name: 'fixture', wareType: 0 }] }], totalNum: 1 } })) });
    const result = await collect({ platform: 'jd' }, 'thor=FIXTURE');
    assert.equal(result.shipments[0].status, 'unknown', description);
    f.sync(result.shipments[0]);
    assert.equal(f.read().status, 'unknown', description);
    assert.equal(f.read().shippedAt, 0, description);
    assert.equal(f.read().shippedAtSource, 'unknown');
  }
});

test('JD dispatch time starts at actual acceptance for JD and third-party carriers', t => {
  for (const [carrier, description] of [['京东物流', '您的快件已揽收'], ['顺丰速运', '您的快件已由顺丰速运揽收'],
    ['中通快递', '揽收成功'], ['京东物流', '快递员已揽收，正在运输中']]) {
    const f = fixture(t);
    const input = jdParcels(tracking([step('已发货：包裹正在等待揽收', -9000), step(description, -5000)], carrier), 'o', NOW)[0];
    f.sync(input);
    assert.equal(f.read().status, 'transit', description);
    assert.equal(f.read().shippedAt, NOW - 5000, description);
    assert.equal(f.read().shippedAtSource, 'platform_event');
  }
});

test('JD later transport nodes establish transit without inventing an acceptance timestamp', t => {
  for (const description of ['运输中', '运输中，预计明日到达', '您的快件已从上海分拨中心发出', '您的快件已到达北京分拣中心', '快递员正在派送']) {
    const f = fixture(t);
    f.sync(parcel([step(description, -5000)]));
    assert.equal(f.read().status, 'transit', description);
    assert.equal(f.read().shippedAt, 0, description);
    f.sync(parcel([step('您的订单已经进入北京仓库，准备出库')]));
    assert.equal(f.read().status, 'transit', 'a partial update cannot erase retained transport evidence');
  }
});

test('JD uncertain, negated, pending and future collection never establish dispatch', t => {
  for (const description of ['尚未揽收，系统显示已发货', '等待揽收', '已揽收是否属实？', '已揽收但揽收失败',
    '预计明天揽收', '未揽收，正在等待运输', '准备发货', '揽收已取消']) {
    const f = fixture(t);
    f.sync(parcel([step(description)]));
    assert.equal(f.read().status, 'unknown', description);
    assert.equal(f.read().shippedAt, 0, description);
  }
  const f = fixture(t);
  f.sync(parcel([step('您的订单已经打印完成', -2000), step('已揽收', 1000)]));
  assert.equal(f.read().status, 'unknown');
  assert.equal(f.read().shippedAt, 0);
});

test('JD return boundaries invalidate previous collection and cannot count return collection as dispatch', t => {
  const f = fixture(t);
  f.sync(parcel([step('已揽收', -9000)]));
  f.sync(parcel([step('退货包裹已揽收', -5000)]));
  assert.equal(f.read().shippedAt, 0);
  f.sync(parcel([step('您的快件已揽收', -1000)]));
  assert.equal(f.read().shippedAt, NOW - 1000);
});

test('JD identical collection repairs old dispatch caches once and snapshots remain read-only', t => {
  const f = fixture(t), input = parcel([step('已发货：包裹正在等待揽收')]);
  f.sync(input);
  const saved = f.store.shipment(f.read().id);
  const parserKey = hash(JSON.stringify(['shipment-lifecycle-v3', undefined, f.store.pickupCompletion.rules(), f.store.pickupCompletion.config()]));
  const { logisticsCheckedAt, logisticsDetailCheckedAt, logisticsUpdatedAt, updatedAt, ...evidence } = input;
  Object.assign(saved, { status: 'transit', shippedAt: NOW - 1000, shippedAtSource: 'platform_event', shippedAtPrecision: 'second',
    logisticsEvidenceHash: hash(JSON.stringify([parserKey, evidence])) });
  f.store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(saved), saved.id);
  assert.equal(f.read().status, 'unknown');
  assert.equal(f.read().shippedAt, 0);
  assert.deepEqual(f.store.shipment(saved.id), saved);
  const project = t.mock.method(f.store.pickupCompletion, 'project');
  assert.equal(f.sync(input).evidenceChanged, true);
  assert.equal(f.read().status, 'unknown');
  assert.equal(f.read().shippedAt, 0);
  assert.ok(f.read().logisticsCheckedAt > saved.logisticsCheckedAt);
  assert.ok(f.read().updatedAt >= saved.updatedAt);
  assert.equal(f.sync(input).evidenceChanged, false);
  assert.equal(project.mock.callCount(), 1);
});

test('JD warehouse repair preserves manual decisions and arrival or signed evidence', t => {
  for (const [description, status] of [['包裹已到达幸福菜鸟驿站', 'arrived'], ['本人已签收', 'signed']]) {
    const f = fixture(t);
    f.sync(parcel([step(description, -5000)]));
    const device = f.store.device(f.store.redeem(f.store.createPairing(['a']).code, 'fixture').token);
    f.store.applyOperations(device, [{ id: 'pick', shipmentId: f.read().id, action: 'pick', occurredAt: NOW }]);
    const previous = f.store.shipment(f.read().id);
    f.sync(parcel([step('您的订单已经打印完成')]));
    assert.equal(f.read().status, status);
    assert.equal(f.read().picked, true);
    assert.equal(f.read().pickupManualOperation, previous.pickupManualOperation);
  }
});

test('JD retains actual collection beyond bounded history and never falls back to the earlier merchant dispatch', t => {
  const f = fixture(t);
  const steps = [step('商家已发货', -180000), step('已揽收', -150000),
    ...Array.from({ length: 120 }, (_, i) => step('物流信息更新' + i, -i * 1000))];
  f.sync(parcel(steps));
  assert.equal(f.read().logisticsEvents.length, 100);
  assert.equal(f.read().shippedAt, NOW - 150000);
  assert.equal(f.read().status, 'transit');
});

test('JD retained transport survives more than 100 later updates even when collection was never returned', t => {
  const f = fixture(t);
  f.sync(parcel([step('商家已发货', -180000), step('快件已到达北京分拣中心', -150000)]));
  f.sync(parcel(Array.from({ length: 120 }, (_, i) => step('物流信息更新' + i, -i * 1000))));
  assert.equal(f.read().status, 'transit');
  assert.equal(f.read().shippedAt, 0);
  assert.ok(f.read().logisticsEvents.some(event => event.description.includes('分拣中心')));
});

test('JD a structured pickup code remains arrival evidence when the platform omits its timeline', t => {
  const f = fixture(t);
  f.sync(parcel([step('运输中')]));
  const data = tracking([]);
  data.multiPackageTrackInfoList[0].trackGroupInfo.checkCode = '8-2-1234';
  const input = jdParcels(data, 'o', NOW)[0];
  assert.equal(input.status, 'arrived');
  f.sync(input);
  assert.equal(f.read().status, 'arrived');
  assert.equal(f.read().pickupCode, '8-2-1234');
});

test('JD current structured pickup codes outrank earlier collection and transport after an informational update', t => {
  for (const description of ['您的快件已揽收', '您的快件已到达北京分拣中心']) {
    const f = fixture(t);
    const data = tracking([step(description, -5000), step('物流信息更新')]);
    data.multiPackageTrackInfoList[0].trackGroupInfo.checkCode = '8-2-1234';
    const input = jdParcels(data, 'o', NOW)[0];
    assert.equal(input.status, 'arrived', description);
    assert.equal(input.arrivalAt, 0, 'a pickup code does not invent an arrival timestamp');
    f.sync(input);
    assert.equal(f.read().status, 'arrived');
    assert.equal(f.read().pickupCode, '8-2-1234');
    f.store.refreshLogisticsRules([]);
    assert.equal(f.read().status, 'arrived', 'rule projection keeps the current pickup-code evidence');
  }
});

test('JD current signature, return and transport still override a supplied pickup code and previously saved arrival', t => {
  for (const [description, collectorStatus, snapshotStatus] of [['本人已签收', 'signed', 'signed'], ['快件已退回，等待退件', 'transit', 'returned'], ['运输中', 'transit', 'transit']]) {
    const f = fixture(t);
    const data = tracking([step('您的快件已揽收', -9000), step('物流信息更新', -5000)]);
    data.multiPackageTrackInfoList[0].trackGroupInfo.checkCode = '8-2-1234';
    f.sync(jdParcels(data, 'o', NOW)[0]);
    assert.equal(f.read().status, 'arrived');
    data.multiPackageTrackInfoList[0].trackGroupInfo.orderTrackShowList.push(step(description));
    const input = jdParcels(data, 'o', NOW)[0];
    assert.equal(input.status, collectorStatus, description);
    f.sync(input);
    assert.equal(f.read().status, snapshotStatus, description);
  }
});

test('JD newly observed transport after a saved pickup still wins when followed by an informational update', t => {
  const f = fixture(t), arrival = tracking([step('物流信息更新', -5000)]);
  arrival.multiPackageTrackInfoList[0].trackGroupInfo.checkCode = '8-2-1234';
  f.sync(jdParcels(arrival, 'o', NOW)[0]);
  assert.equal(f.read().status, 'arrived');
  const input = parcel([step('运输中', -2000), step('物流信息更新')]);
  assert.equal(input.status, 'transit');
  f.sync(input);
  assert.equal(f.read().status, 'transit', 'saved status is not current pickup-code evidence');
});

test('JD rule re-projection cannot promote pending collection to transit', t => {
  const f = fixture(t);
  f.sync(parcel([step('已发货：包裹正在等待揽收')]));
  f.store.refreshLogisticsRules([]);
  assert.equal(f.read().status, 'unknown');
  assert.equal(f.store.shipment(f.read().id).status, 'unknown');
});

for (const platform of ['taobao', 'pdd']) test(`${platform} merchant dispatch keeps its existing pre-collection meaning`, t => {
  const f = fixture(t, platform);
  f.sync({ platformOrderId: 'o', waybillNo: 'SYNTHETIC', status: 'transit', logisticsState: 'ok',
    logisticsEvents: [{ time: NOW - 1000, description: '已发货：包裹正在等待揽收', timePrecision: 'second' }] });
  assert.equal(f.read().status, 'transit');
  assert.equal(f.read().shippedAt, NOW - 1000);
});
