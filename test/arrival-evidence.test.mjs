import test from 'node:test';
import assert from 'node:assert/strict';
import { RecognitionWorkflow } from '../src/recognition-workflow.mjs';
import { Store } from '../src/store.mjs';
import { projectShipmentView, ShipmentViewCache } from '../src/shipment-view.mjs';
import { NOW, ARRIVAL, STATION, WRAPPED, catalog, arrivalEvent, completedEvent, arrivalSamples } from './fixtures/recognition-reliability.mjs';

const rules = globalThis.PickCodeLogistics.defaults();
function assertExpected(view, expected) {
  assert.equal(view.arrivalAt, expected.arrivalAt);
  assert.equal(view.quality.arrivalTime.state, expected.state);
  if (expected.reasonCode) assert.equal(view.quality.arrivalTime.reasonCode, expected.reasonCode);
  assert.equal(view.arrivalEvidence.candidates.length, expected.candidates);
  if (expected.candidates) {
    assert.equal(view.arrivalEvidence.candidates[0].usableForCurrent, expected.usable);
    assert.match(view.arrivalEvidence.candidates[0].eventRef, /^[a-f0-9]{64}$/u);
  }
}
for (const sample of arrivalSamples) test(`arrival trajectory and Store: ${sample.id}`, t => {
  const value = { id: 'synthetic', status: 'signed', ...globalThis.PickCodeLogistics.pickupEvidence(sample.events, rules), logisticsEvents: sample.events };
  const options = { platform: sample.platform, catalog: sample.catalog || [], rules, now: NOW };
  assertExpected(projectShipmentView(value, options), sample.expected);
  const store = new Store({ key: Buffer.alloc(32, 3), now: () => NOW, getLogisticsRules: () => rules,
    getStationRules: () => ({ stations: options.catalog }) });
  t.after(() => store.close());
  store.saveAccount({ platform: sample.platform, label: 'synthetic', cookie: 'SYNTHETIC' }, 'fixture', true);
  const sync = events => store.importResult('fixture', { orders: [{ platformOrderId: 'synthetic', orderDate: NOW - 7 * 86400000 }],
    shipments: [{ platformOrderId: 'synthetic', waybillNo: 'SYNTHETIC', status: 'signed', logisticsState: 'ok', logisticsCheckedAt: NOW,
      arrivalAt: 0, arrivalAtSource: 'unknown', logisticsEvents: events }] });
  if (!sample.id.endsWith('unknown-event-time') && !sample.id.endsWith('future-event-time')) sync([sample.events.at(-1)]);
  sync(sample.events);
  const result = store.snapshot(['fixture']).shipments[0];
  assertExpected(result.platformView, sample.expected);
  assert.equal(result.arrivalAt, sample.expected.arrivalAt);
  assert.deepEqual(store.shipmentView(store.shipment(result.id)).arrivalEvidence, result.platformView.arrivalEvidence);
});

test('confirmed completion preserves a historical candidate without promoting an unconfirmed alias', () => {
  const value = { id: 'completed', picked: true, pickupCompletion: { autoPicked: true }, status: 'signed', station: WRAPPED,
    arrivalAt: 0, logisticsEvents: [completedEvent('pdd'), arrivalEvent('pdd')] };
  const unknown = projectShipmentView(value, { platform: 'pdd', rules, now: NOW });
  assertExpected(unknown, { arrivalAt: 0, state: 'ambiguous', candidates: 1, usable: false });
  assert.equal(unknown.arrivalEvidence.candidates[0].time, ARRIVAL);
  assert.equal(unknown.requiresReceiptConfirmation, false);
  const confirmed = projectShipmentView(value, { platform: 'pdd', rules, now: NOW, catalog });
  assert.equal(confirmed.arrivalAt, 0);
  assert.equal(confirmed.arrivalEvidence.candidates[0].time, ARRIVAL);
  assert.equal(confirmed.arrivalEvidence.candidates[0].usableForCurrent, true);
});

test('confirmed aliases cannot erase card, building or cabinet conflicts', () => {
  for (const [one, two] of [['4卡', '5卡'], ['1栋', '2栋'], ['1号柜', '2号柜'], ['东门', '西门']]) {
    const source = `合成花园${one}菜鸟驿站`, target = `合成花园${two}菜鸟驿站`;
    const value = { id: 'parcel', station: target, logisticsEvents: [completedEvent('pdd', target), arrivalEvent('pdd', source)] };
    const conflictingCatalog = [{ id: 'incorrect-alias', name: source, enabled: true, aliases: [{ name: target }] }];
    assertExpected(projectShipmentView(value, { platform: 'pdd', catalog: conflictingCatalog, rules, now: NOW }),
      { arrivalAt: 0, state: 'ambiguous', candidates: 1, usable: false });
  }
});

test('cycle identity invalidates old candidates even when the reset event is absent; sibling events are not borrowed', () => {
  const value = { id: 'parcel', station: STATION, arrivalAt: ARRIVAL, arrivalAtSource: 'platform_event', logisticsEvents: [arrivalEvent('pdd')],
    pickupCycle: { id: 'new-cycle', evidenceKey: 'redirect', startedAt: ARRIVAL + 1000 } };
  assert.equal(projectShipmentView(value, { platform: 'pdd', rules, now: NOW }).arrivalEvidence.candidates.length, 0);
  const cache = new ShipmentViewCache();
  const first = cache.project({ ...value, pickupCycle: { id: 'old-cycle', evidenceKey: 'initial' } }, { platform: 'pdd', rules, now: NOW });
  const next = cache.project(value, { platform: 'pdd', rules, now: NOW });
  assert.notEqual(first.evidenceKey, next.evidenceKey);
  assert.equal(next.arrivalAt, 0);
  assert.equal(projectShipmentView({ id: 'sibling', logisticsEvents: [] }, { platform: 'pdd', rules, now: NOW }).arrivalEvidence.candidates.length, 0);
});

test('new same-station arrival after a reset dates only the new cycle', () => {
  const newer = ARRIVAL + 2000;
  const value = { id: 'parcel', station: STATION, logisticsEvents: [arrivalEvent('pdd', STATION, { time: newer }),
    { time: ARRIVAL + 1000, description: '包裹已改派' }, arrivalEvent('pdd')] };
  assert.equal(projectShipmentView({ ...value, ...globalThis.PickCodeLogistics.pickupEvidence(value.logisticsEvents, rules) }, { platform: 'pdd', rules, now: NOW }).arrivalAt, newer);
});

test('arrival workflow reuses a conflict task and resolves confirmed alias evidence without retry or AI', async t => {
  let stations = [];
  const store = new Store({ key: Buffer.alloc(32, 3), now: () => NOW, getLogisticsRules: () => rules, getStationRules: () => ({ stations }) });
  const workflow = new RecognitionWorkflow({ store, now: () => NOW, automaticEvents: false });
  t.after(async () => { await workflow.close(); store.close(); });
  store.saveAccount({ platform: 'pdd', label: 'synthetic', cookie: 'SYNTHETIC' }, 'fixture', true);
  store.importResult('fixture', { orders: [{ platformOrderId: 'synthetic', orderDate: ARRIVAL - 86400000 }], shipments: [{
    platformOrderId: 'synthetic', waybillNo: 'SYNTHETIC', status: 'arrived', logisticsState: 'ok', logisticsCheckedAt: NOW,
    logisticsEvents: [{ time: ARRIVAL + 1000, timePrecision: 'second', description: `包裹仍在【${WRAPPED}】等待取件` }, arrivalEvent('pdd')] }] });
  const shipment = store.snapshot(['fixture']).shipments[0];
  workflow.observe({ shipments: [shipment] });
  const task = workflow.tasks().find(task => task.target === 'arrival_time');
  assert.equal(task.reasonCode, 'STATION_CONFLICT'); assert.equal(task.methodVersion, 2);
  workflow.observe({ shipments: [shipment] });
  assert.equal(workflow.tasks().length, 1); assert.equal(workflow.task(task.id).retryCount, 0);
  stations = catalog;
  workflow.observe({ shipments: [shipment] });
  const resolved = workflow.task(task.id);
  assert.equal(resolved.status, 'resolved'); assert.equal(resolved.retryCount, 0); assert.equal(resolved.aiAttempts, 0);
  assert.equal(resolved.evidenceVersion, task.evidenceVersion);
});
