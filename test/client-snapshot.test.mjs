import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/store.mjs';
import { clientSnapshot, shipmentDetails } from '../src/client-snapshot.mjs';
import { createService } from '../src/service.mjs';

const NOW = Date.parse('2026-11-13T12:00:00+08:00');
const event = (time, description = '运输中') => ({ time, timePrecision: 'second', description });

function snapshotFixture() {
  return {
    schemaVersion: 1,
    serverVersion: '3.1.53',
    serverRevision: 7,
    familyIds: [],
    legacyAccountIds: ['account-a'],
    accounts: [{ id: 'account-a', familyId: '', label: 'fixture' }],
    orders: [{ id: 'order-a', accountId: 'account-a', updatedAt: NOW, dateCheckedAt: NOW }],
    shipments: [{ id: 'shipment-a', accountId: 'account-a', orderId: 'order-a', status: 'transit',
      logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsDetailCheckedAt: NOW, logisticsUpdatedAt: NOW,
      updatedAt: NOW, logisticsEvents: [event(NOW - 1000)] }],
    shipmentIdentifiers: [{ shipmentId: 'shipment-a', waybillNo: 'SYNTHETIC' }],
    shipmentAliases: [],
    hiddenIds: [],
    deletedIds: [],
    events: [{ id: 'arrival-a', shipmentId: 'shipment-a', arrivedAt: 0 }],
    serverLogisticsRules: [{ id: 'private-rule', keywords: ['fixture'] }],
  };
}

test('compact snapshots retain entities on first read and omit them on an unchanged metadata read', () => {
  const first = clientSnapshot(snapshotFixture());
  assert.equal(first.metadataOnly, false);
  assert.equal(first.projectionVersion, 2);
  assert.equal(first.serverLogisticsRules.length, 0);
  assert.equal(first.shipments[0].logisticsEvents.length, 0);
  assert.equal(first.shipments[0].logisticsEventCount, 1);
  assert.equal(first.shipments[0].detailsAvailable, true);

  const second = clientSnapshot({ ...snapshotFixture(), serverRevision: 8 }, first.dataVersion);
  assert.equal(second.metadataOnly, true);
  for (const key of ['orders', 'shipments', 'shipmentIdentifiers', 'shipmentAliases', 'hiddenIds', 'deletedIds', 'events']) {
    assert.equal(Object.hasOwn(second, key), false, key);
  }
  assert.equal(second.serverRevision, 8);
});

test('compact dataVersion ignores collection timestamps but changes for evidence and permission changes', () => {
  const first = clientSnapshot(snapshotFixture());
  const recollected = snapshotFixture();
  recollected.serverRevision = 99;
  recollected.orders[0].updatedAt += 1000;
  recollected.orders[0].dateCheckedAt += 1000;
  Object.assign(recollected.shipments[0], {
    logisticsCheckedAt: NOW + 1000, logisticsDetailCheckedAt: NOW + 1000,
    logisticsUpdatedAt: NOW + 1000, updatedAt: NOW + 1000
  });
  const timestampsOnly = clientSnapshot(recollected, first.dataVersion);
  assert.equal(timestampsOnly.metadataOnly, true);
  assert.equal(timestampsOnly.dataVersion, first.dataVersion);

  const evidenceChanged = snapshotFixture();
  evidenceChanged.shipments[0].status = 'arrived';
  const changed = clientSnapshot(evidenceChanged, first.dataVersion);
  assert.equal(changed.metadataOnly, false);
  assert.notEqual(changed.dataVersion, first.dataVersion);
  assert.ok(changed.shipments);

  const permissionChanged = snapshotFixture();
  permissionChanged.legacyAccountIds = ['account-b'];
  const permission = clientSnapshot(permissionChanged, first.dataVersion);
  assert.equal(permission.metadataOnly, false);
  assert.notEqual(permission.dataVersion, first.dataVersion);
});

test('compact snapshots reject malformed cursors before reading entities', () => {
  assert.throws(() => clientSnapshot(snapshotFixture(), 'bad-cursor'), error => error.code === 'INVALID_CURSOR' && error.status === 400);
});

function detailFixture(t, events) {
  const store = new Store({ key: randomBytes(32), now: () => NOW });
  t.after(() => store.close());
  const account = store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'SYNTHETIC' }, 'account-a', true);
  store.importResult(account.id, {
    orders: [{ platformOrderId: 'order-a', orderDate: NOW - 86400000 }],
    shipments: [{ platformOrderId: 'order-a', platformPackageKey: 'package-a', waybillNo: 'SYNTHETIC-A',
      status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsEvents: events }]
  });
  const device = { accountIds: [account.id], legacyAccountIds: [account.id], familyIds: [] };
  const shipment = store.snapshot([account.id]).shipments[0];
  return { store, account, device, shipment };
}

test('shipment details resolve aliases, enforce scope, and use the same evidence key as the snapshot', t => {
  const f = detailFixture(t, [event(NOW - 1000, '已到达合成驿站')]);
  const detail = shipmentDetails(f.store, f.device, f.shipment.id);
  assert.equal(detail.shipmentId, f.shipment.id);
  assert.equal(detail.evidenceKey, f.shipment.platformView.evidenceKey);
  assert.equal(detail.logisticsEvents.length, 1);
  assert.equal(detail.logisticsEvents[0].description, '已到达合成驿站');
  assert.equal(detail.logisticsEvents[0].time, NOW - 1000);

  const old = f.store.importResult(f.account.id, {
    orders: [{ platformOrderId: 'order-a' }],
    shipments: [{ platformOrderId: 'order-a', platformPackageKey: 'package-old', waybillNo: 'SYNTHETIC-OLD',
      status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsEvents: [event(NOW - 2000)] }]
  });
  assert.equal(old.evidenceChanged, true);
  const oldId = f.store.snapshot([f.account.id]).shipments.find(s => s.waybillNo === 'SYNTHETIC-OLD').id;
  f.store.saveShipmentAlias(oldId, f.shipment.id, { reason: 'same parcel', evidence: 'SYNTHETIC' });
  const aliased = shipmentDetails(f.store, f.device, oldId);
  assert.equal(aliased.shipmentId, f.shipment.id);
  assert.equal(aliased.evidenceKey, detail.evidenceKey);

  const outsider = { accountIds: ['other-account'], legacyAccountIds: ['other-account'], familyIds: [] };
  assert.throws(() => shipmentDetails(f.store, outsider, f.shipment.id), error => error.code === 'SCOPE_FORBIDDEN' && error.status === 403);
});

test('shipment details enforce the 1.8 MB history budget and report truncation', t => {
  const events = Array.from({ length: 20000 }, (_, index) => event(NOW - index * 1000, `${index}-${'轨迹'.repeat(80)}`));
  const f = detailFixture(t, events);
  const detail = shipmentDetails(f.store, f.device, f.shipment.id);
  assert.ok(Buffer.byteLength(JSON.stringify(detail), 'utf8') <= 1800000);
  assert.equal(detail.logisticsTruncated, true);
  assert.ok(detail.logisticsEvents.length < events.length);
});

test('compact snapshot route asks Store for metadata without loading logistics history', async t => {
  const service = createService({ encryptionKey: randomBytes(32).toString('hex'),
    adminToken: randomBytes(24).toString('hex'), scheduler: false, fixture: true, now: () => NOW });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  t.after(() => service.close());
  const account = service.store.saveAccount({ platform: 'pdd', label: 'fixture', cookie: 'SYNTHETIC' }, undefined, true);
  service.store.importResult(account.id, {
    orders: [{ platformOrderId: 'order-a' }],
    shipments: [{ platformOrderId: 'order-a', waybillNo: 'SYNTHETIC', status: 'transit',
      logisticsState: 'ok', logisticsCheckedAt: NOW, logisticsEvents: [event(NOW - 1000)] }]
  });
  const pairing = service.store.createPairing({ accountIds: [account.id] });
  const device = service.store.redeem(pairing.code, 'fixture-device');
  let args;
  const original = service.store.snapshot.bind(service.store);
  service.store.snapshot = (...values) => { args = values; return original(...values); };
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}/v1/snapshot?view=compact`, {
    headers: { Authorization: `Bearer ${device.token}` }
  });
  assert.equal(response.status, 200);
  assert.equal(args[3], false);
  const compact = await response.json();
  assert.equal(compact.shipments[0].logisticsEvents.length, 0);
  assert.equal(compact.shipments[0].logisticsEventCount, 1);
  assert.equal(compact.shipments[0].detailsAvailable, true);
});
