import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';

const NOW = Date.parse('2026-10-31T12:00:00+08:00');
const REAL_DATE = NOW - 4 * 86400000;
const event = (time, description) => ({ time, timeText: '', description, location: '测试城市' });
function fixture(t) {
  const store = new Store({ key: Buffer.alloc(32, 1), now: () => NOW });
  t.after(() => store.close());
  const account = store.saveAccount({ platform: 'taobao', label: '测试', cookie: 'SYNTHETIC' }, 'a', true);
  const order = { platformOrderId: 'o', title: '测试订单', orderDate: NOW - 86400000 };
  const shipment = { platformOrderId: 'o', waybillNo: 'TRACK-A', carrier: '圆通', status: 'transit' };
  const sync = (orders = [order], shipments = [shipment], extra = {}) => {
    store.importResult(account.id, { orders, shipments, ...extra });
    return store.snapshot([account.id]);
  };
  return { store, account, order, shipment, sync };
}

test('verified detail date corrects an earlier list date, stale/list responses cannot undo it', t => {
  const { sync, order } = fixture(t);
  sync();
  let result = sync([{ ...order, orderDate: REAL_DATE, orderDateOrigin: 'detail', dateCheckedAt: NOW }]);
  assert.equal(result.orders[0].orderDate, REAL_DATE);
  assert.equal(result.orders[0].orderDateOrigin, 'detail');
  result = sync([{ ...order, orderDateOrigin: 'list' }]);
  assert.equal(result.orders[0].orderDate, REAL_DATE);
  result = sync([{ ...order, orderDateOrigin: 'detail', dateCheckedAt: NOW - 1000 }]);
  assert.equal(result.orders[0].orderDate, REAL_DATE);
  assert.equal(result.orders[0].dateCheckedAt, NOW);
});

test('failed date enrichment stores its attempt without fabricating an order date', t => {
  const { sync, order } = fixture(t);
  const result = sync([{ ...order, orderDate: 0, dateCheckedAt: NOW }]);
  assert.equal(result.orders[0].orderDate, 0);
  assert.equal(result.orders[0].orderDateSource, 'unknown');
  assert.equal(result.orders[0].dateCheckedAt, NOW);
});

test('logistics is isolated by waybill, newest first, deduplicated and retained on an empty or failed query', t => {
  const { store, sync, shipment } = fixture(t);
  const older = event(NOW - 2000, '已揽收'), newer = event(NOW - 1000, '运输中');
  let result = sync(undefined, [{ ...shipment, logisticsEvents: [older, newer, newer], logisticsState: 'ok', logisticsCheckedAt: NOW - 500, logisticsUpdatedAt: NOW - 500 }, { ...shipment, waybillNo: 'TRACK-B' }]);
  const a = result.shipments.find(s => s.waybillNo === 'TRACK-A');
  assert.deepEqual(a.logisticsEvents, [newer, older]);
  assert.deepEqual(result.shipments.find(s => s.waybillNo === 'TRACK-B').logisticsEvents, []);
  store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify({ ...a, picked: true, hidden: true }), a.id);
  result = sync([], [], { logisticsFailures: [{ platformOrderId: 'o', waybillNo: 'TRACK-A', state: 'error', logisticsCheckedAt: NOW }] });
  const failed = result.shipments.find(s => s.id === a.id);
  assert.equal(failed.logisticsState, 'error');
  assert.equal(failed.logisticsCheckedAt, NOW);
  assert.equal(failed.logisticsUpdatedAt, NOW - 500);
  assert.deepEqual(failed.logisticsEvents, [newer, older]);
  assert.equal(failed.picked, true); assert.equal(failed.hidden, true);
  result = sync(undefined, [{ ...shipment, logisticsEvents: [], logisticsState: 'empty', logisticsCheckedAt: NOW }]);
  assert.deepEqual(result.shipments.find(s => s.id === a.id).logisticsEvents, [newer, older]);
  result = sync();
  assert.deepEqual(result.shipments.find(s => s.id === a.id).logisticsEvents, [newer, older]);
});

test('unrecognized logistics failures cannot create orders or mutate another account', t => {
  const { store, account, sync, order, shipment } = fixture(t);
  sync();
  const other = store.saveAccount({ platform: 'taobao', label: '另外账号', cookie: 'SYNTHETIC' }, 'b', true);
  store.importResult(other.id, { orders: [order], shipments: [{ ...shipment, logisticsState: 'ok', logisticsEvents: [event(NOW - 1000, '运输中')], logisticsUpdatedAt: NOW }] });
  sync([], [], { logisticsFailures: [{ platformOrderId: 'unknown', state: 'error' }, { platformOrderId: 'o', state: 'error', logisticsCheckedAt: NOW }] });
  assert.equal(store.snapshot([account.id]).orders.length, 1);
  assert.equal(store.snapshot([other.id]).shipments[0].logisticsState, 'ok');
});

test('large histories are bounded and snapshots expose truncation without altering the stored history', t => {
  const { store, sync, shipment, account } = fixture(t);
  const result = sync(undefined, [{ ...shipment, logisticsEvents: Array.from({ length: 140 }, (_, i) => event(NOW - i * 1000, '节点' + i)), logisticsState: 'ok' }]);
  assert.equal(result.shipments[0].logisticsEvents.length, 100);
  assert.equal(result.shipments[0].logisticsTruncated, true);
  const before = JSON.stringify(store.snapshot([account.id]));
  assert.equal(JSON.stringify(store.snapshot([account.id])), before);
});

test('history budget includes the complete snapshot and stays under the Android response limit', t => {
  const { store, account, order, shipment } = fixture(t);
  const imageUrl = 'https://img.alicdn.com/' + 'a'.repeat(600) + '.jpg';
  store.importResult(account.id, { orders: [{ ...order, title: '中文'.repeat(50), imageUrl }], shipments: [{ ...shipment,
    logisticsEvents: Array.from({ length: 20 }, (_, n) => event(NOW - n * 1000, '物流'.repeat(80) + n)), logisticsState: 'ok' }] });
  // Seed the remaining large fixture directly: this regression targets serialization,
  // while the import/merge path is covered above, without a quadratic fixture setup.
  const seed = store.snapshot([account.id]);
  store.transaction(() => {
    const addOrder = store.db.prepare('INSERT INTO orders VALUES(?,?,?)');
    const addShipment = store.db.prepare('INSERT INTO shipments VALUES(?,?,?)');
    for (let i = 1; i < 1500; i++) {
      const id = 'large-order-' + String(i).padStart(32, '0'), sid = 'large-ship-' + String(i).padStart(32, '0');
      const detail = i === 1 ? { dateCheckedAt: NOW, dateError: '保留日期说明', tradeStatus: '待收货', orderStatus: '已发货', refundStatus: '未退款',
        archiveRestoredAnchor: '2026-10-30', archiveRestoredAt: NOW } : {};
      addOrder.run(id, account.id, JSON.stringify({ ...seed.orders[0], ...detail, id, platformOrderId: 'large-' + i }));
      addShipment.run(sid, account.id, JSON.stringify({ ...seed.shipments[0], id: sid, orderId: id, waybillNo: 'TRACK-' + i }));
    }
  });
  const additional = { matchingFeedback: { items: Array.from({ length: 500 }, (_, i) => ({ id: `feedback-${i}`, revision: 1, status: 'review', error: '缺少可学习原文'.repeat(5), updatedAt: NOW })) } };
  const result = store.snapshot([account.id], undefined, Buffer.byteLength(JSON.stringify(additional), 'utf8'));
  const responseBytes = Buffer.byteLength(JSON.stringify({ ...result, ...additional }), 'utf8');
  assert.ok(responseBytes <= 3800000, `snapshot response is ${responseBytes} bytes, limit 3800000`);
   assert.equal(result.orders.length, 1500);
  assert.ok(result.orders.some(o => !o.imageUrl));
  assert.equal(store.order(seed.orders[0].id).imageUrl, imageUrl);
  assert.ok(result.orders.every(o => o.retention.version === 1 && o.retention.anchorDate === '2026-10-30' && o.retention.archived === false));
  assert.ok(result.orders.every(o => !Object.hasOwn(o, 'archiveAnchorDate') && !Object.hasOwn(o, 'archiveRestoredAt')));
  const detail = result.orders.find(o => o.platformOrderId === 'large-1');
  assert.deepEqual([detail.dateCheckedAt, detail.dateError, detail.tradeStatus, detail.orderStatus, detail.refundStatus], [NOW, '保留日期说明', '待收货', '已发货', '未退款']);
  assert.equal(detail.retention.restoredAt, NOW);
  assert.ok(result.orders.filter(o => o !== detail).every(o => o.retention.restoredAt === 0));
  assert.ok(result.shipments.some(s => s.logisticsTruncated));
  const raw = store.db.prepare('SELECT data FROM shipments WHERE id=?').get(result.shipments.at(-1).id);
  assert.equal(JSON.parse(raw.data).logisticsEvents.length, 20);
});

test('base entities that exceed the response budget fail explicitly with 413', t => {
  const { store, account, sync } = fixture(t);
  sync();
  const seed = store.snapshot([account.id]).orders[0];
  store.transaction(() => {
    const addOrder = store.db.prepare('INSERT INTO orders VALUES(?,?,?)');
    for (let i = 1; i <= 5000; i++) {
      const id = 'oversize-order-' + String(i).padStart(32, '0');
      addOrder.run(id, account.id, JSON.stringify({
        ...seed,
        id,
        platformOrderId: 'oversize-' + i,
        title: '基础实体'.repeat(120),
        imageUrl: '',
      }));
    }
  });
  assert.throws(() => store.snapshot([account.id]), error => error?.status === 413 && error?.code === 'SNAPSHOT_TOO_LARGE');
});
