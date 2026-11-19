import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { projectShipmentView } from '../src/shipment-view.mjs';
import { validateRecognitionSuggestion } from '../src/recognition-ai.mjs';
import { NOW, arrivalSamples, aiSamples } from './fixtures/recognition-reliability.mjs';

export function evaluateRecognitionSamples(samples = [...arrivalSamples, ...aiSamples]) {
  const groups = new Map(), results = [];
  for (const sample of samples) {
    const key = [sample.platform, sample.contentKind, sample.target, sample.methodId, sample.methodVersion].join('|');
    let group = groups.get(key);
    if (!group) groups.set(key, group = { platform: sample.platform, contentKind: sample.contentKind, target: sample.target,
      methodId: sample.methodId, methodVersion: sample.methodVersion, samples: 0, verified: 0, unverified: 0, passed: 0, verifiedPassed: 0,
      categories: { positive: 0, negative: 0, boundary: 0 } });
    let actual;
    if (sample.target === 'arrival_time') {
      const view = projectShipmentView({ id: sample.id, status: 'signed', ...globalThis.PickCodeLogistics.pickupEvidence(sample.events.filter(event => event.time <= NOW)), logisticsEvents: sample.events },
        { platform: sample.platform, catalog: sample.catalog || [], now: NOW });
      actual = { arrivalAt: view.arrivalAt, state: view.quality.arrivalTime.state, reasonCode: view.quality.arrivalTime.reasonCode,
        candidates: view.arrivalEvidence.candidates.length, usable: view.arrivalEvidence.candidates[0]?.usableForCurrent };
    } else {
      try { validateRecognitionSuggestion(sample.suggestion, sample.input); actual = { valid: true }; }
      catch (error) { actual = { valid: false, category: error.validationFailure?.category || 'UNCLASSIFIED' }; }
    }
    const passed = Object.entries(sample.expected).every(([key, value]) => actual[key] === value), verified = sample.truth === 'verified_synthetic';
    group.samples++; group.passed += Number(passed); group.categories[sample.category]++;
    group[verified ? 'verified' : 'unverified']++; group.verifiedPassed += Number(verified && passed);
    results.push({ id: sample.id, group: key, category: sample.category, truth: sample.truth, passed,
      ...(passed ? {} : { expected: sample.expected, actual }) });
  }
  const summarize = value => ({ ...value, unverifiedRatio: value.samples ? value.unverified / value.samples : 0,
    accuracy: value.verified ? value.verifiedPassed / value.verified : null });
  const totals = [...groups.values()].reduce((sum, group) => {
    for (const key of Object.keys(sum)) sum[key] += group[key]; return sum;
  }, { samples: 0, verified: 0, unverified: 0, passed: 0, verifiedPassed: 0 });
  return { version: 1, evaluation: 'offline-synthetic-contract', productionAccuracy: null, ...summarize(totals),
    groups: [...groups.values()].map(summarize), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = evaluateRecognitionSamples();
  writeFileSync(new URL('./fixtures/recognition-reliability-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ samples: report.samples, verified: report.verified, unverified: report.unverified,
    passed: report.passed, accuracy: report.accuracy, productionAccuracy: report.productionAccuracy }));
  if (report.passed !== report.samples) process.exitCode = 1;
}
