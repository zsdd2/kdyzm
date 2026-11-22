import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, stableId } from '../src/store.mjs';
import { clientSnapshot, shipmentDetails } from '../src/client-snapshot.mjs';
import { createDiagnosticApi } from '../src/diagnostic-api.mjs';

const NOW = 1795400000000;
const original = '00000000000123';
const event = (offset, providerStatus, description, providerStatusTag) => ({
  time: NOW + offset, timePrecision: 'second', description, provider: 'pdd',
  ...(providerStatus ? { providerStatus } : {}), ...(providerStatusTag ? { providerStatusTag } : {}),
});
const common = [event(-600000, 'CREATE', '订单提交成功'), event(-500000, 'CHECK', '商家完成检验')];
const tracking = [
  event(-240000, 'IN_CABINET', '包裹已存放至【合成驿站】，请及时领取', '待取件'),
  event(-400000, 'GOT', '合成快递网点已揽收包裹', '已揽件'),
  ...common,
];
const input = (platformOrderId, patch = {}) => ({
  platformOrderId, waybillNo: original, carrier: '中通快递', status: 'arrived',
  pickupCode: '3-2068', station: '合成驿站', stationSource: 'locker', arrivalAt: NOW - 240000, arrivalAtSource: 'locker_arrival',
  logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsEvents: tracking, ...patch,
});
function fixture(t, filename = ':memory:') {
  const store = new Store({ filename, key: Buffer.alloc(32, 7), now: () => NOW });
  t.after(() => { try { store.close(); } catch {} });
  store.saveAccount({ platform: 'pdd', label: '合成账号', cookie: 'FIXTURE' }, 'a', true);
  const device = store.device(store.redeem(store.createPairing(['a']).code, '合成设备').token);
  const sync = (...shipments) => store.importResult('a', {
    orders: [...new Set(shipments.map(s => s.platformOrderId))].map(platformOrderId => ({ platformOrderId, title: '合成订单', orderDate: NOW - 600000 })), shipments,
  });
  return { store, device, sync };
}

test('PDD shared tracking reconciles existing rows on upgrade, with each order retained and one physical confirmation', t => {
  const directory = mkdtempSync(join(tmpdir(), 'store-pdd-shared-'));
  const filename = join(directory, 'store.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { store, device, sync } = fixture(t, filename);
  sync(input('one'));
  const main = store.snapshot(device).shipments[0];
  const confirmedAt = NOW - 1000;
  store.applyOperations(device, [{ id: 'first-pick', action: 'pick', shipmentId: main.id, pickupCycleId: main.pickupCycle.id, occurredAt: confirmedAt }]);
  sync(input('two', { logisticsState: 'unavailable' }), input('three', { logisticsState: 'unavailable' }));
  const duplicates = store.snapshot(device).shipments.filter(s => s.id !== main.id);
  assert.equal(duplicates.length, 2);
  for (const old of duplicates) {
    const saved = store.shipment(old.id);
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify({ ...saved, logisticsState: 'ok' }), old.id);
  }
  store.close();

  const reopened = new Store({ filename, key: Buffer.alloc(32, 7), now: () => NOW });
  const snap = clientSnapshot(reopened.snapshot(device));
  assert.equal(snap.orders.length, 3);
  assert.deepEqual(snap.shipments.map(s => [s.id, s.picked, s.pickupConfirmedAt, s.logisticsEventCount]), [[main.id, true, confirmedAt, 4]]);
  assert.equal(snap.shipmentAliases.length, 2);
  assert.deepEqual([...snap.deletedIds].sort(), duplicates.map(s => s.id).sort());
  for (const old of duplicates) {
    const alias = snap.shipmentAliases.find(a => a.oldShipmentId === old.id);
    assert.deepEqual([alias.targetShipmentId, alias.reason, alias.sourceCycleId, alias.targetCycleId], [main.id, 'pdd_shared_waybill', old.pickupCycle.id, main.pickupCycle.id]);
    assert.deepEqual(snap.orders.find(o => o.id === old.orderId).sharedShipmentIds, [main.id]);
    assert.equal(shipmentDetails(reopened, device, old.id).shipmentId, main.id);
    assert.equal(reopened.shipment(old.id).orderId, old.orderId);
    const api = createDiagnosticApi({ store: reopened, workflow: { tasks: () => [] } });
    assert.deepEqual(api.order(old.orderId).order.sharedShipmentIds, [main.id]);
    assert.equal(api.order(old.orderId).shipments.length, 0);
  }
  reopened.importResult('a', { orders: [], shipments: [input('two', { logisticsCheckedAt: NOW + 100 })] });
  assert.equal(reopened.snapshot(device).shipments.length, 1);
  assert.equal(reopened.account('a').warnings.length, 0);
  assert.equal(reopened.shipment(main.id).pickupConfirmedAt, confirmedAt);
  const batch = [
    { id: 'copy-pick', action: 'pick', shipmentId: duplicates[0].id, pickupCycleId: duplicates[0].pickupCycle.id, occurredAt: confirmedAt + 1 },
    { id: 'copy-restore', action: 'restore', shipmentId: duplicates[0].id, pickupCycleId: duplicates[0].pickupCycle.id, occurredAt: confirmedAt + 2 },
    { id: 'copy-hide', action: 'hide', shipmentId: duplicates[1].id, occurredAt: confirmedAt + 3 },
    { id: 'canonical-pick', action: 'pick', shipmentId: main.id, pickupCycleId: main.pickupCycle.id, pickedAt: confirmedAt, occurredAt: confirmedAt + 4 },
  ];
  assert.deepEqual(reopened.applyOperations(device, batch).appliedIds, batch.map(operation => operation.id));
  assert.deepEqual(reopened.applyOperations(device, batch).appliedIds, batch.map(operation => operation.id));
  assert.equal(reopened.shipment(main.id).pickupConfirmedAt, confirmedAt);
  assert.equal(reopened.shipment(main.id).hidden, false);
  assert.deepEqual(batch.slice(0, 3).map(operation => {
    const receipt = reopened.operation(device, operation.id);
    return [receipt.status, receipt.reason, receipt.canonicalShipmentId];
  }), Array.from({ length: 3 }, () => ['superseded', 'shared_waybill', main.id]));
  assert.equal(reopened.operation(device, 'canonical-pick').status, 'applied');
  reopened.close();
});

test('PDD streams reconcile repeat imports and keep a truly different waybill on a related order', t => {
  const { store, device, sync } = fixture(t);
  sync(input('first'));
  store.importResult('a', { orders: [{ platformOrderId: 'second' }], shipments: [], }, { partial: true });
  store.importResult('a', { orders: [], shipments: [input('second'), input('second', { waybillNo: '98765432345678' })] }, { partial: true, reconcile: false });
  const snap = clientSnapshot(store.snapshot(device));
  assert.equal(snap.orders.length, 2);
  assert.equal(snap.shipments.length, 2);
  assert.equal(snap.shipmentAliases.length, 1);
  assert.equal(snap.shipments.filter(s => s.waybillNo === original).length, 1);
});

test('a newer verified PDD package key creates its own shipment without reusing the retired row', t => {
  const { store, device, sync } = fixture(t);
  sync(input('one'), input('two'));
  const before = store.snapshot(device), [alias] = before.shipmentAliases;
  const originalSource = store.shipment(alias.oldShipmentId);
  const sourceOrder = store.order(originalSource.orderId);
  const candidate = input(sourceOrder.platformOrderId, { platformPackageKey: 'verified-split' });
  sync(candidate, { ...candidate, logisticsCheckedAt: NOW + 60, logisticsState: 'unavailable' });
  assert.equal(store.snapshot(device).shipments.length, 1, 'a key alone or an unsuccessful refresh cannot override the saved alias');

  const confirmed = { ...candidate, logisticsCheckedAt: NOW + 60, logisticsEvents: [event(-200000, 'GOT', '新分包由承运方独立揽件')] };
  sync(confirmed);
  const after = store.snapshot(device);
  assert.equal(after.shipments.length, 2);
  const separate = after.shipments.find(s => s.orderId === sourceOrder.id);
  assert.ok(separate && separate.id !== alias.oldShipmentId);
  assert.deepEqual(after.shipmentAliases, before.shipmentAliases);
  assert.deepEqual(after.orders.find(o => o.id === sourceOrder.id).sharedShipmentIds, [alias.targetShipmentId]);
  assert.deepEqual(store.shipment(alias.oldShipmentId), originalSource);
  sync(confirmed);
  assert.equal(store.snapshot(device).shipments.length, 2);
  assert.equal(store.snapshot(device).shipments.find(s => s.orderId === sourceOrder.id).id, separate.id);
});

for (const [why, conflict] of [
  ['different pickup codes', { pickupCode: '3-7788' }],
  ['different waybills', { waybillNo: '88888888888888' }],
  ['different carriers', { carrier: '圆通快递' }],
  ['different transport history', { logisticsEvents: [event(-435000, 'GOT', '另一件包裹已揽收'), ...tracking] }],
  ['unverified carrier history', { logisticsEvents: common }],
  ['independent platform package key', { platformPackageKey: 'separate-box' }],
]) test(`PDD shared tracking leaves ${why} separate`, t => {
  const { store, device, sync } = fixture(t);
  sync(input('one'), input('two', conflict));
  assert.equal(store.snapshot(device).shipments.length, 2);
  assert.equal(store.snapshot(device).shipmentAliases.length, 0);
});

test('PDD shared tracking leaves conflicting saved stations separate', t => {
  const { store, device, sync } = fixture(t);
  sync(input('one'), input('two', { logisticsState: 'unavailable' }));
  const second = store.shipment(stableId('a', 'pdd', stableId('a', 'pdd', 'order', 'two'), 'ZTO', original));
  store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify({ ...second, logisticsState: 'ok', station: '其他驿站' }), second.id);
  assert.deepEqual(store.reconcilePddSharedWaybills('a'), []);
  assert.equal(store.snapshot(device).shipments.length, 2);
});

test('PDD shared tracking does not reconcile two competing manual decisions', t => {
  const { store, device, sync } = fixture(t);
  sync(input('one', { logisticsState: 'unavailable' }), input('two', { logisticsState: 'unavailable' }));
  for (const [index, shipment] of store.snapshot(device).shipments.entries()) {
    store.applyOperations(device, [{ id: 'decision-' + index, action: index ? 'pick' : 'restore',
      shipmentId: shipment.id, pickupCycleId: shipment.pickupCycle.id, occurredAt: NOW - 1000 }]);
  }
  sync(input('one'), input('two'));
  assert.equal(store.snapshot(device).shipments.length, 2);
});

test('PDD order-only sibling is exposed as unverified until its own carrier evidence succeeds', t => {
  const { store, device, sync } = fixture(t);
  const parcel = patch => input('single-order', { status: 'transit', pickupCode: '', station: '', stationSource: 'unknown', arrivalAt: 0, arrivalAtSource: 'unknown', ...patch });
  const handoff = event(-450000, '', '商家已发货，使用合成快递', '已发货');
  const valid = parcel({ logisticsEvents: [tracking[1], handoff, ...common] });
  const unverified = parcel({ waybillNo: '00000000000758', carrier: '申通快递', logisticsState: 'unavailable',
    logisticsEvents: [{ ...handoff, description: '商家已发货，使用另一承运商' }, ...common] });
  sync(valid, unverified);
  let rows = clientSnapshot(store.snapshot(device)).shipments;
  const sibling = rows.find(row => row.waybillNo === unverified.waybillNo);
  assert.equal(rows.length, 2);
  assert.equal(sibling.waybillVerification, 'unverified');
  assert.equal(store.shipment(sibling.id).logisticsEvents.length, 3);
  const api = createDiagnosticApi({ store, workflow: { tasks: () => [] } });
  assert.equal(api.order(sibling.orderId).shipments.find(s => s.id === sibling.id).waybillVerification, 'unverified');
  sync({ ...unverified, logisticsState: 'ok', logisticsEvents: [event(-300000, 'GOT', '第二件由另一网点正常揽收')] });
  rows = clientSnapshot(store.snapshot(device)).shipments;
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.id === sibling.id).waybillVerification, undefined);
});

test('PDD unverified sibling marker preserves manual choices and unique order milestone evidence', t => {
  const { store, device, sync } = fixture(t);
  const parcel = patch => input('single-order', { status: 'transit', pickupCode: '', station: '', stationSource: 'unknown', arrivalAt: 0, arrivalAtSource: 'unknown', ...patch });
  const sibling = parcel({ waybillNo: '00000000000758', carrier: '申通快递', logisticsState: 'unavailable', logisticsEvents: common });
  sync(
    parcel({ logisticsEvents: [tracking[1], ...common] }),
    sibling,
    parcel({ waybillNo: '00000000000867', carrier: '圆通快递', logisticsState: 'unavailable',
      logisticsEvents: [common[0], event(-499000, 'CHECK', '第二个包裹完成独立检验')] }),
  );
  let snap = store.snapshot(device);
  const marked = snap.shipments.find(s => s.waybillNo === sibling.waybillNo);
  assert.deepEqual(snap.shipments.filter(s => s.waybillVerification).map(s => s.id), [marked.id]);
  const pick = { id: 'pick-fallback', action: 'pick', shipmentId: marked.id, pickupCycleId: marked.pickupCycle.id, occurredAt: NOW - 1000 };
  const actual = snap.shipments.find(s => s.waybillNo === original);
  const realPick = { id: 'pick-confirmed-waybill', action: 'pick', shipmentId: actual.id, pickupCycleId: actual.pickupCycle.id, occurredAt: NOW - 1000 };
  assert.deepEqual(store.applyOperations(device, [pick, realPick]).appliedIds, [pick.id, realPick.id]);
  assert.equal(store.operation(device, pick.id).status, 'superseded');
  assert.equal(store.operation(device, pick.id).reason, 'waybill_unverified');
  assert.equal(store.shipment(marked.id).picked, false);
  assert.equal(store.shipment(actual.id).picked, true);
  sync({ ...sibling, logisticsState: 'ok' });
  store.applyOperations(device, [{ ...pick, id: 'pick-now-verified' }]);
  sync(sibling);
  snap = store.snapshot(device);
  assert.equal(snap.shipments.some(s => s.waybillVerification), false);
});
