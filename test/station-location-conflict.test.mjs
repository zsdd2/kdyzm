import test from 'node:test';
import assert from 'node:assert/strict';
import { stationAutomationDecision, stationLocationConflict } from '../src/station-automation.mjs';
import { validateRecognitionSuggestion } from '../src/recognition-ai.mjs';
import { projectShipmentView } from '../src/shipment-view.mjs';
import { Store } from '../src/store.mjs';
import { NOW, ARRIVAL, arrivalEvent, completedEvent } from './fixtures/recognition-reliability.mjs';

const conflicts = [['A1号柜', 'B1号柜'], ['1号楼', '2栋'], ['1号快递柜', '2柜'], ['A区1号柜', 'B区1号柜']];
for (const [one, two] of conflicts) test(`location identity rejects ${one} versus ${two} before AI review`, () => {
  const source = `合成花园${one}`, target = `合成花园${two}`;
  assert.equal(stationLocationConflict(source, target), true);
  const input = { target: 'station_match', clientConflictReasons: ['code_station_conflict'],
    candidates: [{ id: 'candidate-1', stationEvidenceId: 'candidate-1-station' }],
    evidence: [{ sourceId: 'source-station', text: source }, { sourceId: 'candidate-1-station', text: target }] };
  const suggestion = { version: 1, target: 'station_match', action: 'review_match', reasonCode: 'STATION_NAME_VARIANT',
    candidateId: 'candidate-1', evidence: input.evidence.map(item => ({ sourceId: item.sourceId, quote: item.text })), requiresReview: true };
  assert.throws(() => validateRecognitionSuggestion(suggestion, input), error => {
    assert.equal(error.code, 'AI_INVALID_RESULT'); assert.equal(error.validationFailure.category, 'HARD_CONFLICT'); return true;
  });
});

test('location labels normalize equivalent forms without asserting a station alias', () => {
  for (const pair of [['A1号柜', 'Ａ１自提柜'], ['1号楼', '一栋'], ['1幢', '1号楼'], ['1号快递柜', '1柜'], ['东大门', '东门']]) {
    assert.equal(stationLocationConflict(...pair), false, pair.join('/'));
  }
});

for (const platform of ['taobao', 'pdd', 'jd']) test(`${platform} Store and view retain full cabinet labels and reject conflicting arrival identities`, t => {
  const rules = globalThis.PickCodeLogistics.defaults();
  const store = new Store({ key: Buffer.alloc(32, 3), now: () => NOW, getLogisticsRules: () => rules });
  t.after(() => store.close());
  store.saveAccount({ platform, label: 'synthetic', cookie: 'SYNTHETIC' }, 'fixture', true);
  for (const [index, [one, two]] of conflicts.entries()) {
    const source = `合成花园${one}菜鸟驿站`, target = `合成花园${two}菜鸟驿站`;
    const events = [completedEvent(platform, target), arrivalEvent(platform, source)];
    const view = projectShipmentView({ id: 'parcel', station: target, arrivalAt: 0, logisticsEvents: events }, { platform, rules, now: NOW });
    assert.equal(view.arrivalAt, 0); assert.equal(view.quality.arrivalTime.reasonCode, 'STATION_CONFLICT');
    assert.equal(view.arrivalEvidence.candidates[0].usableForCurrent, false);
    const sync = logisticsEvents => store.importResult('fixture', { orders: [{ platformOrderId: String(index), orderDate: ARRIVAL - 86400000 }],
      shipments: [{ platformOrderId: String(index), waybillNo: `SYNTHETIC-${index}`, status: 'arrived', logisticsState: 'ok',
        logisticsCheckedAt: NOW, arrivalAt: 0, arrivalAtSource: 'unknown', logisticsEvents }] });
    sync([arrivalEvent(platform, source)]);
    const single = store.snapshot(['fixture']).shipments.find(item => item.waybillNo === `SYNTHETIC-${index}`);
    assert.equal(single.arrivalAt, ARRIVAL); assert.equal(single.platformView.quality.arrivalTime.state, 'known');
    if (index === 0) assert.equal(single.platformView.station.subLocation, 'A1号柜');
    sync(events);
    const full = store.snapshot(['fixture']).shipments.find(item => item.waybillNo === `SYNTHETIC-${index}`);
    assert.equal(full.arrivalAt, 0); assert.equal(full.platformView.quality.arrivalTime.reasonCode, 'STATION_CONFLICT');
  }
});

test('confirmed-feedback automation cannot collapse distinct cabinet prefixes or building numbers', () => {
  for (const [one, two] of conflicts) {
    const source = `合成花园${one}菜鸟驿站`, target = `合成花园${two}菜鸟驿站`;
    const station = { id: 'station', name: target, enabled: true, aliases: [] };
    const candidate = { stationName: source, fragment: source,
      suggestion: { kind: 'locker', targetStationId: station.id, alias: source, subLocation: '', evidence: [source] },
      feedback: { active: true, verified: true, targetStationId: station.id, sourceStationName: source, otherStationName: target, subLocation: '' } };
    assert.match(stationAutomationDecision(candidate, [station]).reason, /位置编号冲突/u);
  }
});
