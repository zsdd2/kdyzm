import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { RecognitionWorkflow } from '../src/recognition-workflow.mjs';
import { RecognitionAi } from '../src/recognition-ai.mjs';
import '../app-source/pickcode/core/load-core.mjs';

const NOW = Date.parse('2026-11-12T09:30:00+08:00'), MINUTE = 60000;
const unknownEvents = () => [
  { time: 0, timeText: '11-11 09:18', timePrecision: 'unknown', description: '打印完成',
    provider: 'taobao', providerStatus: 'waitdo', providerStatusText: '打印完成' },
  { time: 0, timeText: '11-11 09:17', timePrecision: 'unknown', description: '仓库已接单：仓库已接单',
    provider: 'taobao', providerStatus: 'waitdo', providerStatusTag: '仓库已接单', providerStatusText: '仓库已接单' },
];
const validEvent = (index = 0) => {
  const time = Date.parse('2026-11-11T10:00:00+08:00') + index * MINUTE;
  return { time, timeText: new Date(time + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' '),
    timePrecision: 'second', description: `合成运输节点${index}`, provider: 'taobao' };
};
const progress = task => ({ status: task.status, retryCount: task.retryCount,
  aiAttempts: task.aiAttempts, evidenceVersion: task.evidenceVersion });

function fixture(t, events = [...unknownEvents(), validEvent()], { beforeReply } = {}) {
  let clock = NOW, adapter;
  const now = () => clock, store = new Store({ filename: ':memory:', key: Buffer.alloc(32, 3), now });
  const requests = [], calls = [];
  const workflow = new RecognitionWorkflow({ store, now, automaticEvents: false,
    requestOrder: (accountId, orderId) => {
      const job = { id: `job-${requests.length + 1}`, accountId, orderId, state: 'completed', startedAt: now(), finishedAt: now() };
      requests.push(job); return { job, done: Promise.resolve(job) };
    },
    analyze: task => adapter.analyze(task),
  });
  adapter = new RecognitionAi({ store, workflow, now, stations: { aiConfig: () => ({ enabled: true }) },
    assistance: {
      defaultRoute: () => ({ channelId: 'synthetic' }),
      call: async (_channelId, messages) => {
        const input = JSON.parse(messages[1].content); calls.push(input);
        await beforeReply?.();
        const suggestion = { version: 1, target: input.target, action: 'review_time_format', reasonCode: 'TIME_FORMAT_UNSUPPORTED',
          candidateId: '', evidence: [{ sourceId: input.evidence[0].sourceId, quote: input.evidence[0].text }], requiresReview: true };
        return { choices: [{ message: { content: JSON.stringify(suggestion) } }] };
      },
    },
  });
  const account = store.saveAccount({ platform: 'taobao', label: '合成账号', cookie: 'SYNTHETIC' }, 'time-evidence', true);
  store.importResult(account.id, { orders: [{ platformOrderId: 'synthetic-order', orderDate: NOW - 2 * 86400000 }],
    shipments: [{ platformOrderId: 'synthetic-order', waybillNo: 'synthetic-waybill', status: 'transit', logisticsState: 'ok', logisticsEvents: [] }] });
  const shipment = store.snapshot([account.id]).shipments[0];
  const patch = values => {
    const next = { ...store.shipment(shipment.id), ...values };
    store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(next), shipment.id); return next;
  };
  patch({ logisticsEvents: events });
  const observe = () => workflow.observe({ shipments: [store.shipment(shipment.id)] });
  const run = async () => { workflow.runDue(); await workflow.running; };
  const retryCycle = async () => {
    for (const minutes of [5, 10, 15]) { clock += minutes * MINUTE; await run(); }
    await run();
  };
  const task = () => workflow.latestForShipment(shipment.id, 'event_time');
  const reachReview = async () => {
    observe(); await retryCycle();
    assert.deepEqual(progress(task()), { status: 'review', retryCount: 3, aiAttempts: 1, evidenceVersion: 1 });
    assert.equal(task().reasonCode, 'AI_REVIEW_REQUIRED');
    assert.equal(requests.length, 3); assert.equal(calls.length, 1);
    return task();
  };
  t.after(async () => { await adapter.close(); await workflow.close(); store.close(); });
  return { store, workflow, adapter, shipment, requests, calls, patch, observe, run, retryCycle, task, reachReview,
    advance: amount => { clock += amount; } };
}

test('reviewed event-time evidence ignores new valid events and unrelated shipment changes', async t => {
  const updates = {
    'new valid transport event': f => f.patch({ logisticsEvents: [validEvent(1), ...f.store.shipment(f.shipment.id).logisticsEvents] }),
    'changed valid event': f => f.patch({ logisticsEvents: [...unknownEvents(), { ...validEvent(2), description: '已更新的合成运输节点' }] }),
    'unrelated status and station': f => f.patch({ status: 'signed', station: '合成中转站' }),
    'reordered abnormal events': f => f.patch({ logisticsEvents: [validEvent(), ...unknownEvents().reverse()] }),
    'duplicated abnormal event': f => f.patch({ logisticsEvents: [...unknownEvents(), unknownEvents()[0], validEvent()] }),
  };
  for (const [name, update] of Object.entries(updates)) await t.test(name, async t => {
    const f = fixture(t), reviewed = await f.reachReview();
    update(f); f.observe();
    const immediately = progress(f.task());
    await f.retryCycle();
    assert.deepEqual({ immediately, afterward: progress(f.task()), requests: f.requests.length, calls: f.calls.length },
      { immediately: progress(reviewed), afterward: progress(reviewed), requests: 3, calls: 1 });
  });
});

test('changed abnormal time evidence earns a fresh retry cycle and review', async t => {
  const f = fixture(t), reviewed = await f.reachReview();
  f.patch({ logisticsEvents: [{ ...unknownEvents()[0], timeText: '11-11 09:19' }, unknownEvents()[1], validEvent()] });
  f.observe();
  assert.deepEqual(progress(f.task()), { status: 'pending', retryCount: 0, aiAttempts: 0, evidenceVersion: reviewed.evidenceVersion + 1 });
  await f.retryCycle();
  assert.deepEqual(progress(f.task()), { status: 'review', retryCount: 3, aiAttempts: 1, evidenceVersion: reviewed.evidenceVersion + 1 });
  assert.equal(f.requests.length, 6); assert.equal(f.calls.length, 2);
});

test('repairing every abnormal event time resolves the task without another AI call', async t => {
  const f = fixture(t), reviewed = await f.reachReview();
  const repaired = unknownEvents().map(event => ({ ...event, time: Date.parse(`2026-${event.timeText.replace(' ', 'T')}:00+08:00`), timePrecision: 'minute' }));
  f.patch({ logisticsEvents: [...repaired, validEvent()] }); f.observe(); await f.retryCycle();
  assert.deepEqual(progress(f.task()), { ...progress(reviewed), status: 'resolved' });
  assert.equal(f.task().reasonCode, 'DETERMINISTIC_MATCH');
  assert.equal(f.requests.length, 3); assert.equal(f.calls.length, 1);
});

test('event-time AI evidence includes abnormal times beyond twelve valid events and excludes valid times', async t => {
  const f = fixture(t, [...Array.from({ length: 13 }, (_, index) => validEvent(index)), ...unknownEvents()]);
  await f.reachReview();
  assert.deepEqual(f.calls[0].evidence.map(item => item.text).sort(), unknownEvents().map(event => event.timeText).sort());
});

test('legacy reviewed tasks learn the time fingerprint without invalidating their saved review', async t => {
  const f = fixture(t), reviewed = await f.reachReview();
  const legacy = { ...reviewed }, reviews = structuredClone(f.adapter.reviews());
  delete legacy.timeEvidenceFingerprint;
  f.workflow.save(legacy); f.observe();
  assert.deepEqual(progress(f.task()), progress(reviewed));
  assert.equal(f.task().sourceFingerprint, reviewed.sourceFingerprint);
  assert.equal(f.task().timeEvidenceFingerprint, reviewed.timeEvidenceFingerprint);
  assert.ok(f.task().timeEvidenceFingerprint);
  assert.deepEqual(f.adapter.reviews(), reviews);
  await f.retryCycle();
  assert.deepEqual(f.adapter.reviews(), reviews);
  assert.equal(f.requests.length, 3); assert.equal(f.calls.length, 1);
});

test('a new pickup cycle starts fresh retries even when abnormal time text is unchanged', async t => {
  const f = fixture(t), reviewed = await f.reachReview();
  f.patch({ pickupCycle: { ...f.store.shipment(f.shipment.id).pickupCycle, id: 'synthetic-next-cycle' } });
  f.observe();
  assert.deepEqual(progress(f.task()), { status: 'pending', retryCount: 0, aiAttempts: 0, evidenceVersion: reviewed.evidenceVersion + 1 });
  assert.notEqual(f.task().sourceFingerprint, reviewed.sourceFingerprint);
  await f.retryCycle();
  assert.deepEqual(progress(f.task()), { status: 'review', retryCount: 3, aiAttempts: 1, evidenceVersion: reviewed.evidenceVersion + 1 });
  assert.equal(f.requests.length, 6); assert.equal(f.calls.length, 2);
});

test('an in-flight time review accepts only results for the current abnormal evidence', async t => {
  for (const changed of [false, true]) await t.test(changed ? 'changed abnormal time rejects the stale result' : 'new valid event keeps the result', async t => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const f = fixture(t, undefined, { beforeReply: async () => { started.resolve(); await release.promise; } });
    f.observe();
    for (const minutes of [5, 10, 15]) { f.advance(minutes * MINUTE); await f.run(); }
    const original = f.task();
    assert.equal(original.status, 'ai_pending');
    const running = f.run();
    try {
      await started.promise;
      const events = changed
        ? [{ ...unknownEvents()[0], timeText: '11-11 09:19' }, unknownEvents()[1], validEvent()]
        : [validEvent(1), ...f.store.shipment(f.shipment.id).logisticsEvents];
      f.patch({ logisticsEvents: events }); f.observe();
    } finally {
      release.resolve(); await running;
    }
    if (changed) {
      assert.deepEqual(progress(f.task()), { status: 'pending', retryCount: 0, aiAttempts: 0, evidenceVersion: original.evidenceVersion + 1 });
      const stale = f.adapter.reviews().find(review => review.sourceFingerprint === original.sourceFingerprint);
      assert.equal(stale.reasonCode, 'SOURCE_CHANGED'); assert.equal(stale.suggestion, null);
      assert.equal(f.adapter.reviews().some(review => review.sourceFingerprint === f.task().sourceFingerprint), false);
      await f.retryCycle();
      assert.deepEqual(progress(f.task()), { status: 'review', retryCount: 3, aiAttempts: 1, evidenceVersion: original.evidenceVersion + 1 });
      assert.equal(f.requests.length, 6); assert.equal(f.calls.length, 2);
    } else {
      assert.deepEqual(progress(f.task()), { status: 'review', retryCount: 3, aiAttempts: 1, evidenceVersion: original.evidenceVersion });
      assert.equal(f.task().sourceFingerprint, original.sourceFingerprint);
      const current = f.adapter.reviews().find(review => review.sourceFingerprint === f.task().sourceFingerprint);
      assert.equal(current.reasonCode, 'AI_REVIEW_REQUIRED'); assert.ok(current.suggestion);
      await f.retryCycle();
      assert.equal(f.requests.length, 3); assert.equal(f.calls.length, 1);
    }
  });
});
