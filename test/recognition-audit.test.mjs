import test from 'node:test';
import assert from 'node:assert/strict';
import { runRecognitionAudit, safeInteraction } from '../scripts/recognition-audit.mjs';
import { Store } from '../src/store.mjs';
import { createDiagnosticApi } from '../src/diagnostic-api.mjs';
import { NOW, ARRIVAL, STATION, WRAPPED, catalog, arrivalEvent } from './fixtures/recognition-reliability.mjs';

const orderId = 'a'.repeat(32), shipmentId = 'b'.repeat(32);
function fixture({ evidenceKey = 'e1', status = 'review', version = '3.2.2', fail = '', reset = false } = {}) {
  const paths = [];
  const get = async path => {
    paths.push(path); if (path.includes(fail) && fail) throw Object.assign(new Error('private raw data'), { code: 'HTTP_401' });
    if (path.endsWith('/status')) return { serverVersion: version, scope: 'diagnostics:read' };
    if (path.endsWith('/accounts')) return { accounts: [{ id: 'private-id', platform: 'taobao', status: 'ok', cookie: 'private-cookie' }] };
    if (path.endsWith('/recognition-tasks')) return { tasks: [{ id: 't1', orderId, status, platform: 'taobao', target: 'arrival_time', retryCount: 3 }] };
    if (path.includes('/recognition-review?')) return { nextCursor: null, rules: { logisticsVersion: 2 }, ai: { enabled: true, autoApply: false, dailyLimit: 20 },
      samples: status === 'ignored' ? [] : [{ orderId, shipmentId, evidenceKey }] };
    if (path.includes('/orders?')) return { orders: [{ id: orderId }], nextCursor: null };
    if (path.endsWith('/orders/' + orderId)) return { order: { id: orderId, platform: 'taobao', title: 'private title' }, shipments: [{ id: shipmentId, station: 'private station', pickupCode: 'private code', logisticsEvents: [{ time: 0, description: 'private body' }] }] };
    if (path.includes('/interactions?')) {
      const params = new URL(path, 'http://local').searchParams;
      if (reset && params.has('windowId')) return { resetRequired: true };
      const after = Number(params.get('after'));
      return { resetRequired: false, windowId: reset ? 'new-window' : 'window', nextCursor: null,
        window: { firstSeq: 1, lastSeq: 2, dropped: 0, retained: 2 },
        events: after >= 2 ? [] : [{ seq: 1, source: 'device', kind: 'sync_job', result: 'error', operationId: 'c'.repeat(32), failureSummary: true },
          { seq: 2, source: 'device', kind: 'sync_job', result: 'error', operationId: 'c'.repeat(32), failureSummary: true }] };
    }
    throw new Error('unexpected request');
  };
  return { get, paths };
}
test('incremental audit reuses unchanged details and interaction cursor; changed evidence rechecks', async () => {
  const first = await runRecognitionAudit({ get: fixture().get, now: 1000 });
  assert.equal(first.report.complete, true); assert.equal(first.report.details.length, 1);
  assert.equal(first.report.interactions.uniqueFailures, 1);
  assert.equal(JSON.stringify(first).includes('private'), false);
  const network = fixture();
  const next = await runRecognitionAudit({ get: network.get, previous: first.cache, now: 2000 });
  assert.equal(next.report.complete, true); assert.equal(next.report.details.length, 0); assert.equal(next.report.reusedOrderDetails, 1);
  assert.equal(next.report.interactions.events.length, 0); assert.equal(network.paths.some(path => path.includes('orders?')), false);
  const changed = await runRecognitionAudit({ get: fixture({ evidenceKey: 'e2' }).get, previous: next.cache, now: 3000 });
  assert.equal(changed.report.details.length, 1);
});
test('inactive issues remain unresolved; version change and weekly history cause reads', async () => {
  const first = await runRecognitionAudit({ get: fixture().get, now: 1000 });
  const inactive = await runRecognitionAudit({ get: fixture({ status: 'ignored' }).get, previous: first.cache, now: 2000 });
  assert.equal(inactive.report.activeSamples, 0); assert.equal(inactive.report.issues[0].disposition, 'inactive_unresolved');
  const upgraded = await runRecognitionAudit({ get: fixture({ status: 'ignored', version: '3.2.3' }).get, previous: inactive.cache, now: 3000 });
  assert.equal(upgraded.report.details.length, 1);
  const weekly = await runRecognitionAudit({ get: fixture({ status: 'ignored', version: '3.2.3' }).get, previous: upgraded.cache, now: 8 * 86400000 });
  assert.equal(weekly.report.orderPages, 1); assert.equal(weekly.report.details.length, 1);
});
test('partial audit never advances cache and window reset is explicitly incomplete coverage', async () => {
  const first = await runRecognitionAudit({ get: fixture().get, now: 1000 });
  const failed = await runRecognitionAudit({ get: fixture({ fail: 'interactions' }).get, previous: first.cache, now: 2000 });
  assert.equal(failed.report.complete, false); assert.equal(failed.report.failure, 'HTTP_401'); assert.deepEqual(failed.cache, first.cache);
  assert.equal(JSON.stringify(failed).includes('private'), false);
  const reset = await runRecognitionAudit({ get: fixture({ reset: true }).get, previous: first.cache, now: 3000 });
  assert.equal(reset.report.complete, true); assert.equal(reset.report.interactions.coverageGap, true);
});
test('diagnostic redaction only keeps fixed categories, hashes, booleans and numbers', () => {
  assert.deepEqual(safeInteraction({ source: 'device', stage: 'private-message', token: 'secret', operationId: 'customer-order', durationCapped: true }), { source: 'device', durationCapped: true });
});

test('task aggregate counts remain full while detail coverage explicitly reports the retained limit', async () => {
  const network = fixture(), get = async path => path.endsWith('/recognition-tasks')
    ? { tasks: Array.from({ length: 100 }, (_, index) => ({ id: `t${index}`, status: 'review' })),
      groups: [{ platform: 'jd', contentKind: 'logistics', target: 'arrival_time', methodId: 'jd.arrival', methodVersion: 2, total: 101, states: { review: 101 } }] }
    : network.get(path);
  const { report } = await runRecognitionAudit({ get, now: 1000 });
  assert.equal(report.complete, true); assert.equal(report.taskCounts.review, 101);
  assert.deepEqual(report.taskDetailCoverage, { returned: 100, total: 101, limited: true, ledgerIsFullCurrentState: false });
});

test('real diagnostic projection distinguishes stored zero from effective alias and dispatch times', async t => {
  for (const platform of ['pdd', 'taobao']) {
    let stations = [];
    const store = new Store({ key: Buffer.alloc(32, 8), now: () => NOW, getLogisticsRules: () => globalThis.PickCodeLogistics.defaults(), getStationRules: () => ({ stations }) });
    t.after(() => store.close());
    store.saveAccount({ platform, label: 'synthetic', cookie: 'SYNTHETIC' }, 'fixture', true);
    store.importResult('fixture', { orders: [{ platformOrderId: 'synthetic', orderDate: ARRIVAL - 86400000 }], shipments: [{
      platformOrderId: 'synthetic', waybillNo: 'SYNTHETIC', status: 'arrived', station: WRAPPED, logisticsState: 'ok', logisticsCheckedAt: NOW,
      logisticsEvents: [arrivalEvent(platform), { time: ARRIVAL - 1000, timePrecision: 'second', description: '测试邮政已收取快件' }] }] });
    const row = store.snapshot(['fixture']).shipments[0], stored = store.shipment(row.id);
    Object.assign(stored, { station: WRAPPED, arrivalAt: 0, arrivalAtSource: 'unknown', arrivalAtPrecision: 'unknown', shippedAt: 0, shippedAtSource: 'unknown', shippedAtPrecision: 'unknown' });
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(stored), row.id);
    const api = createDiagnosticApi({ store, workflow: { tasks: () => [] } });
    const network = fixture(), get = async path => {
      if (path.includes('/orders?')) return { orders: [], nextCursor: null };
      if (path.includes('/orders/')) return api.order(row.orderId);
      if (path.includes('/recognition-review?')) return { nextCursor: null, rules: {}, samples: [{ orderId: row.orderId, shipmentId: row.id, evidenceKey: 'v1' }] };
      if (path.endsWith('/recognition-tasks')) return { tasks: [] };
      return network.get(path);
    };
    let result = await runRecognitionAudit({ get, now: NOW });
    let audited = result.report.details[0].shipments[0];
    assert.equal(audited.arrivalAt, 0); assert.equal(audited.quality.arrivalTime.reasonCode, 'STATION_CONFLICT');
    stations = catalog;
    result = await runRecognitionAudit({ get, now: NOW }); audited = result.report.details[0].shipments[0];
    assert.equal(audited.arrivalAt, ARRIVAL); assert.equal(audited.arrivalAtSource, 'platform_event');
    assert.equal(audited.storedTimes.arrivalAt, 0); assert.equal(audited.quality.arrivalTime.state, 'known');
    if (platform === 'taobao') {
      assert.equal(audited.shippedAt, ARRIVAL - 1000); assert.equal(audited.storedTimes.shippedAt, 0);
    }
    assert.equal(store.shipment(row.id).arrivalAt, 0, 'diagnostic reads must not write back');
  }
});
