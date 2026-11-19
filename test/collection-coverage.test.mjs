import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
const coverage = { version: 1, scope: 'active_orders', status: 'partial', reason: 'page_limit', pagesRead: 4, pageLimit: 4, seenOrders: 80, activeOrders: 10, trackedOutsideWindow: 3 };
test('successful full-account collection stores bounded coverage fields; progress and targeted refresh preserve it', t => {
  const now = Date.parse('2026-11-20T10:00:00+08:00');
  const store = new Store({ key: Buffer.alloc(32, 3), now: () => now }); t.after(() => store.close());
  store.saveAccount({ platform: 'taobao', label: 'synthetic', cookie: 'SYNTHETIC' }, 'fixture', true);
  const result = { orders: [], shipments: [], collectionCoverage: { ...coverage, rawOrders: 'PRIVATE_PAYLOAD' } };
  store.importResult('fixture', result);
  assert.deepEqual(store.account('fixture').collectionCoverage, { ...coverage, checkedAt: now });
  for (const [value, options] of [[{ ...coverage, status: 'complete', reason: 'end' }, { partial: true }],
    [{ ...coverage, status: 'targeted', reason: 'targeted' }, {}], [{ ...coverage, activeOrders: 'PRIVATE_PAYLOAD' }, {}]]) {
    store.importResult('fixture', { ...result, collectionCoverage: value }, options);
    assert.deepEqual(store.account('fixture').collectionCoverage, { ...coverage, checkedAt: now });
  }
  store.importResult('fixture', { ...result, collectionCoverage: { ...coverage, status: 'complete', reason: 'end' } });
  assert.equal(store.snapshot(['fixture']).accounts[0].collectionCoverage.status, 'complete');
  assert.doesNotMatch(JSON.stringify(store.account('fixture')), /PRIVATE_PAYLOAD|rawOrders/u);
});
