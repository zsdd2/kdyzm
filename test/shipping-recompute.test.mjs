import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { hash } from '../src/security.mjs';

const NOW = 1794292000000;
const DISPATCH = { description: '已发货：包裹正在等待揽收', time: 1794285789000, timeText: '11-10 12:43' };

function fixture(t) {
  let now = NOW;
  const store = new Store({ key: Buffer.alloc(32, 6), now: () => now });
  t.after(() => store.close());
  store.saveAccount({ platform: 'taobao', label: 'fixture', cookie: 'FIXTURE' }, 'a', true);
  const input = { platformOrderId: 'o', waybillNo: 'TEST', status: 'transit', logisticsState: 'ok',
    logisticsCheckedAt: now, logisticsEvents: [DISPATCH] };
  const read = () => store.snapshot(['a']).shipments[0];
  const sync = () => store.importResult('a', { orders: [{ platformOrderId: 'o', orderDate: NOW - 86400000 }],
    shipments: [{ ...input, logisticsCheckedAt: ++now }] });
  sync();
  return { store, input, read, sync, legacy() {
    const saved = store.shipment(read().id);
    // Recreate the pre-fix cache, including its parser version and persisted unknown dispatch.
    const parserKey = hash(JSON.stringify(['shipment-lifecycle-v2', undefined, store.pickupCompletion.rules(), store.pickupCompletion.config()]));
    const { logisticsCheckedAt, ...evidence } = input;
    Object.assign(saved, { shippedAt: 0, shippedAtSource: 'unknown', shippedAtPrecision: 'unknown',
      logisticsEvidenceHash: hash(JSON.stringify([parserKey, evidence])) });
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(saved), saved.id);
    return saved;
  } };
}

test('identical collection repairs a legacy unknown dispatch once while snapshots remain read-only', t => {
  const { store, read, sync, legacy } = fixture(t);
  const old = legacy();
  assert.equal(read().shippedAt, DISPATCH.time, 'read projection repairs evidence without backfilling the saved row');
  assert.deepEqual(store.shipment(old.id), old, 'snapshot must not backfill legacy data');
  const project = t.mock.method(store.pickupCompletion, 'project');
  assert.equal(sync().evidenceChanged, true);
  assert.equal(read().shippedAt, DISPATCH.time);
  assert.equal(read().shippedAtSource, 'platform_event');
  assert.notEqual(store.shipment(old.id).logisticsEvidenceHash, old.logisticsEvidenceHash);
  assert.equal(project.mock.callCount(), 1);
  const checkedAt = read().logisticsCheckedAt;
  assert.equal(sync().evidenceChanged, false);
  assert.equal(read().shippedAt, DISPATCH.time);
  assert.ok(read().logisticsCheckedAt > checkedAt);
  assert.equal(project.mock.callCount(), 1, 'third identical collection keeps the parser fast path');
});

for (const action of ['pick', 'restore']) test(`dispatch cache repair preserves a manual ${action} decision`, t => {
  const { store, read, sync, legacy } = fixture(t);
  const device = store.device(store.redeem(store.createPairing(['a']).code, 'fixture').token);
  store.applyOperations(device, [{ id: action, shipmentId: read().id, action, occurredAt: NOW,
    ...(action === 'pick' ? { pickedAt: NOW - 1000 } : {}) }]);
  const old = legacy();
  sync();
  const actual = store.shipment(old.id);
  assert.equal(actual.shippedAt, DISPATCH.time);
  for (const field of ['picked', 'pickupManualAt', 'pickupManualOperation', 'pickupManualAction', 'pickupConfirmedAt', 'pickupCycle', 'pickupCycleHistory']) {
    assert.deepEqual(actual[field], old[field], field);
  }
  assert.equal(actual.pickupCompletion.manualOverride, old.pickupCompletion.manualOverride);
});

test('dispatch cache repair respects an existing redelivery cycle and preserves its history', t => {
  const { store, input, read, sync, legacy } = fixture(t);
  input.logisticsEvents = [{ description: '包裹已退回后重新派送中', time: NOW + 2 }, DISPATCH];
  sync();
  const old = legacy();
  assert.equal(old.pickupCycleHistory.length, 1);
  assert.equal(sync().evidenceChanged, true);
  const actual = store.shipment(old.id);
  assert.equal(actual.shippedAt, 0);
  assert.deepEqual(actual.pickupCycle, old.pickupCycle);
  assert.deepEqual(actual.pickupCycleHistory, old.pickupCycleHistory);
  assert.equal(read().shippedAt, undefined);
  assert.equal(sync().evidenceChanged, false);
});
