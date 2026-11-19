import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { taobaoStageEvents, taobaoTransitEvents } from '../src/collector-enrichment.mjs';
import { hash } from '../src/security.mjs';
import { shippingEvidence } from '../src/shipment-lifecycle.mjs';

const NOW = Date.parse('2026-11-15T12:00:00+08:00');
const COLLECTED = Date.parse('2026-11-14T15:46:52+08:00');
const KEY = Buffer.alloc(32, 7);
const event = (time, description, extra = {}) => ({
  time, timeText: new Date(time).toISOString(), description, provider: 'taobao',
  timePrecision: 'second', ...extra,
});
const taobaoOrder = {
  platformOrderId: 'taobao-order', orderDate: Date.parse('2026-11-13T10:00:00+08:00'),
  orderDateOrigin: 'detail', orderDatePrecision: 'second',
};
const laterTransit = event(Date.parse('2026-11-14T16:00:00+08:00'), '测试快递已到达测试分拨中心');

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'taobao-collection-dispatch-'));
  const store = new Store({ filename: join(directory, 'cache.sqlite'), key: KEY, now: () => NOW, getLogisticsRules: () => [] });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.saveAccount({ platform: 'taobao', label: 'fixture', cookie: 'SYNTHETIC' }, 'account', true);
  return store;
}

test('only Taobao carrier collection proves dispatch while unsafe wording and timestamps remain unknown', () => {
  assert.equal(shippingEvidence([event(COLLECTED, '测试快递已收取快件')], {}, NOW, undefined, 'taobao').shippedAt, COLLECTED);
  assert.equal(shippingEvidence([event(COLLECTED, '测试邮政已收取快件')], {}, NOW, undefined, 'taobao').shippedAt, COLLECTED);
  for (const platform of ['jd', 'pdd', undefined]) {
    assert.equal(shippingEvidence([event(COLLECTED, '测试快递已收取快件')], {}, NOW, undefined, platform).shippedAt, 0, String(platform));
  }
  for (const description of [
    '预计测试快递已收取快件', '快递已收取快件，预计派送', '测试快递已收取快件但发货失败',
    '收件人已收取快件', '用户已收取快件', '收件人从邮政已收取快件', '退货包裹已收取快件',
  ]) {
    assert.equal(shippingEvidence([event(COLLECTED, description)], {}, NOW, undefined, 'taobao').shippedAt, 0, description);
  }
  assert.equal(shippingEvidence([event(NOW + 1, '测试快递已收取快件')], {}, NOW, undefined, 'taobao').shippedAt, 0);
  assert.equal(shippingEvidence([event(-1, '测试快递已收取快件')], {}, NOW, undefined, 'taobao').shippedAt, 0);
});

test('Taobao anchors an unknown month-day postal collection from the order year', t => {
  const store = fixture(t);
  const anchoredAt = Date.parse('2026-11-14T15:46:00+08:00');
  store.importResult('account', {
    orders: [taobaoOrder],
    shipments: [{
      platformOrderId: taobaoOrder.platformOrderId, waybillNo: 'TAOBAO-MONTH-DAY',
      status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW,
      logisticsEvents: [{ time: 0, timeText: '11-14 15:46', timePrecision: 'unknown', provider: 'taobao', description: '测试邮政已收取快件' }],
    }],
  });
  const shipment = store.snapshot(['account']).shipments[0];
  assert.equal(shipment.shippedAt, anchoredAt);
  assert.equal(shipment.shippedAtPrecision, 'minute');
  assert.equal(shipment.logisticsEvents[0].time, anchoredAt);
});

test('Taobao collection respects reset boundaries', () => {
  const resetAt = COLLECTED + 1000;
  assert.equal(shippingEvidence([
    event(COLLECTED, '测试快递已收取快件'), event(resetAt, '快件已退回发件人'),
  ], {}, NOW, undefined, 'taobao').shippedAt, 0);
  assert.equal(shippingEvidence([
    event(resetAt, '包裹已改派重新投递'), event(resetAt + 1000, '测试快递已收取快件'),
  ], {}, NOW, undefined, 'taobao').shippedAt, resetAt + 1000);
  assert.equal(shippingEvidence([
    { ...event(COLLECTED, '快件已退回发件人'), time: 0 }, event(COLLECTED + 1000, '测试快递已收取快件'),
  ], {}, NOW, undefined, 'taobao').shippedAt, 0);
});

test('Taobao import persists second-precision collection dispatch and exposes known quality', t => {
  const store = fixture(t);
  const shipments = [{
    platformOrderId: taobaoOrder.platformOrderId, waybillNo: 'TAOBAO-COLLECTION',
    status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW,
    logisticsEvents: [laterTransit, event(COLLECTED, '测试快递已收取快件')],
  }];
  store.importResult('account', { orders: [taobaoOrder], shipments });
  const first = store.snapshot(['account']).shipments[0];
  assert.equal(first.shippedAt, COLLECTED);
  assert.equal(first.shippedAtSource, 'platform_event');
  assert.equal(first.shippedAtPrecision, 'second');
  assert.equal(first.platformView.quality.shippedTime.state, 'known');
  assert.equal(first.platformView.quality.shippedTime.reasonCode, 'PLATFORM_EVIDENCE');
  assert.equal(store.shipment(first.id).shippedAt, COLLECTED);
  store.importResult('account', { orders: [taobaoOrder], shipments });
  assert.equal(store.snapshot(['account']).shipments[0].shippedAt, COLLECTED);
});

test('Taobao snapshot and shipment view repair explicit old zero read-only', t => {
  const store = fixture(t);
  store.importResult('account', {
    orders: [taobaoOrder],
    shipments: [{
      platformOrderId: taobaoOrder.platformOrderId, waybillNo: 'TAOBAO-LEGACY',
      status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW,
      logisticsEvents: [laterTransit, event(COLLECTED, '测试快递已收取快件')],
    }],
  });
  const saved = store.shipment(store.snapshot(['account']).shipments[0].id);
  const legacy = { ...saved, shippedAt: 0, shippedAtSource: 'unknown', shippedAtPrecision: 'unknown' };
  store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  const snapshot = store.snapshot(['account']).shipments[0];
  const view = store.shipmentView(store.shipment(legacy.id));
  assert.equal(snapshot.shippedAt, COLLECTED);
  assert.equal(snapshot.platformView.quality.shippedTime.state, 'known');
  assert.equal(view.quality.shippedTime.state, 'known');
  assert.equal(view.quality.shippedTime.reasonCode, 'PLATFORM_EVIDENCE');
  assert.equal(store.shipment(legacy.id).shippedAt, 0);
  assert.equal(store.shipment(legacy.id).shippedAtSource, 'unknown');
});

test('a v6 Taobao cache with explicit unknown dispatch upgrades once then uses the identical-evidence fast path', t => {
  const store = fixture(t);
  const input = {
    platformOrderId: taobaoOrder.platformOrderId, waybillNo: 'TAOBAO-V6-CACHE',
    status: 'transit', logisticsState: 'ok', logisticsCheckedAt: NOW,
    logisticsEvents: [laterTransit, event(COLLECTED, '测试邮政已收取快件')],
  };
  store.importResult('account', { orders: [taobaoOrder], shipments: [input] });
  const saved = store.shipment(store.snapshot(['account']).shipments[0].id);
  const { logisticsCheckedAt, logisticsDetailCheckedAt, logisticsUpdatedAt, updatedAt, ...evidence } = input;
  const legacyParserKey = hash(JSON.stringify(['shipment-lifecycle-v6', [], store.pickupCompletion.rules(), store.pickupCompletion.config()]));
  const legacy = {
    ...saved, shippedAt: 0, shippedAtSource: 'unknown', shippedAtPrecision: 'unknown',
    logisticsEvidenceHash: hash(JSON.stringify([legacyParserKey, evidence])),
  };
  store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  const upgraded = store.importResult('account', { orders: [taobaoOrder], shipments: [input] });
  assert.equal(upgraded.evidenceChanged, true);
  assert.deepEqual(upgraded.changedShipmentIds, [legacy.id]);
  assert.equal(store.shipment(legacy.id).shippedAt, COLLECTED);
  const repeated = store.importResult('account', { orders: [taobaoOrder], shipments: [input] });
  assert.equal(repeated.evidenceChanged, false);
  assert.deepEqual(repeated.changedShipmentIds, []);
});

test('Taobao stage and transit normalization retain provider-backed collection beyond 100 events', () => {
  const raw = Array.from({ length: 120 }, (_, i) => ({
    title: '运输中', subtitle: new Date(NOW - i * 1000).toISOString(), labelDesc: { text: `物流更新${i}` },
  }));
  raw.push({ title: '已发货', subtitle: new Date(COLLECTED).toISOString(), labelDesc: { text: '测试快递已收取快件' } });
  const stages = taobaoStageEvents(raw, value => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value), stage => stage.labelDesc?.text || '', undefined, NOW);
  assert.equal(stages.events.length, 100);
  const stageCollection = stages.events.find(item => item.description.includes('测试快递已收取快件'));
  assert.ok(stageCollection);
  assert.equal(stageCollection.provider, 'taobao');
  assert.equal(stageCollection.time, COLLECTED);
  const transitRaw = Array.from({ length: 120 }, (_, i) => ({ time: NOW - i * 1000, place: `运输更新${i}` }));
  transitRaw.push({ time: COLLECTED, place: '测试快递已收取快件' });
  const transit = taobaoTransitEvents({ address: transitRaw }, value => Number.isFinite(Number(value)) ? Number(value) : Date.parse(value), undefined, NOW);
  assert.equal(transit.events.length, 100);
  const transitCollection = transit.events.find(item => item.description === '测试快递已收取快件');
  assert.ok(transitCollection);
  assert.equal(transitCollection.provider, 'taobao');
  assert.equal(transitCollection.time, COLLECTED);
});
