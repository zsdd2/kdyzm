import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRecognitionSamples } from './recognition-sample-evaluation.mjs';
import { arrivalSamples } from './fixtures/recognition-reliability.mjs';

test('offline grouped evaluation excludes unresolved real identities from measured accuracy', () => {
  const report = evaluateRecognitionSamples();
  assert.equal(report.samples, 57); assert.equal(report.passed, 57);
  assert.equal(report.unverified, 6); assert.equal(report.verified, 51);
  assert.equal(report.accuracy, 1); assert.equal(report.productionAccuracy, null);
  assert.equal(report.groups.length, 9);
  for (const group of report.groups) {
    assert.ok(group.categories.positive && group.categories.negative && group.categories.boundary);
    assert.equal(group.samples, group.verified + group.unverified);
  }
});

test('wrong verified outputs reduce accuracy, while unknown ground truth remains unscored', () => {
  const known = arrivalSamples[0], unknown = arrivalSamples.find(sample => sample.truth === 'unverified');
  const report = evaluateRecognitionSamples([{ ...known, expected: { arrivalAt: -1 } }, unknown]);
  assert.equal(report.samples, 2); assert.equal(report.passed, 1); assert.equal(report.verified, 1);
  assert.equal(report.accuracy, 0); assert.equal(report.unverifiedRatio, 0.5);
  assert.equal(evaluateRecognitionSamples([unknown]).accuracy, null);
});
