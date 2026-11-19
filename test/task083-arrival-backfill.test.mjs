import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/logistics-rules.js';
import { normalizeLogisticsEvents } from '../src/collector-enrichment.mjs';
import { createCollector, timestamp } from '../src/collectors.mjs';
import { Store } from '../src/store.mjs';

const engine = globalThis.PickCodeLogistics;
const AT = timestamp('2026-11-09 17:59:37'), NOW = AT + 3600000;
const NAME = '兔喜快递超市', DESCRIPTION = `【驿站】您的包裹已存放至【${NAME}】`;
const catalog = [{ id: 'station-a', name: NAME, enabled: true, aliases: [] }];
const event = (description = DESCRIPTION, time = AT, precision = 'second') => ({ time, timePrecision: precision, description });

test('快递超市完成存放文案立即产出原始秒级时间，无需目录或AI', async () => {
  const normalized = normalizeLogisticsEvents([{ time: '2026-11-09 17:59:37', description: DESCRIPTION }], timestamp).events;
  assert.equal(engine.eventStatus(DESCRIPTION), 'arrived');
  assert.deepEqual(engine.pickupEvidence(normalized), { arrivalAt: AT, arrivalAtSource: 'platform_event', arrivalAtPrecision: 'second', station: NAME, stationSource: 'platform_event' });
  const result = await createCollector({ now: () => NOW, fetchImpl: async () => new Response(JSON.stringify({ shipping: {
    tracking_number: 'SYNTHETIC-TASK083', traces: [{ time: '2026-11-09 17:59:37', info: DESCRIPTION }]
  } })) })({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder: { platformOrderId: 'o', shipments: [{ waybillNo: 'SYNTHETIC-TASK083', status: 'transit' }] } });
  assert.equal(result.shipments[0].arrivalAt, AT);
  assert.equal(result.shipments[0].arrivalAtPrecision, 'second');
});

test('超市名称、地址、未来和催取不能单独变成到站时间', () => {
  for (const description of ['已存放至幸福超市', `取件地址：${NAME}`, `包裹仍在${NAME}`, `预计${DESCRIPTION}`, `尚未存放至${NAME}`, `催取提醒：${DESCRIPTION}`, `已发往${NAME}`, `已退回后${DESCRIPTION}`]) {
    assert.equal(engine.pickupEvidence([event(description)]).arrivalAt, 0, description);
  }
  assert.equal(engine.pickupEvidence([event(DESCRIPTION, 0)]).arrivalAt, 0);
});

test('采集器派生的到货时间不能绕过原始显示时间冲突，保留已有可信记录', async t => {
  const result = await createCollector({ now: () => NOW, fetchImpl: async () => new Response(JSON.stringify({ shipping: {
    tracking_number: 'SYNTHETIC-TASK083', traces: [{ timestamp: AT, displayTime: '2026-11-09 16:59:37', info: DESCRIPTION }]
  } })) })({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC', { targetOrder: { platformOrderId: 'o', shipments: [{ waybillNo: 'SYNTHETIC-TASK083', status: 'transit' }] } });
  assert.equal(result.shipments[0].arrivalAt, 0);
  assert.equal(engine.eventTimeIssue(result.shipments[0].logisticsEvents[0], NOW), 'timeConflict');
  for (const trusted of [0, AT - 60000]) {
    const { store, read } = fixture(t, { arrivalAt: trusted, arrivalAtSource: trusted ? 'platform_event' : 'unknown',
      arrivalAtPrecision: trusted ? 'minute' : 'unknown', logisticsEvents: [] });
    const accountId = read().accountId;
    store.importResult(accountId, result);
    assert.equal(read().arrivalAt, trusted);
    assert.equal(read().arrivalAtPrecision, trusted ? 'minute' : 'unknown');
  }
});

function fixture(t, changes = {}) {
  const store = new Store({ key: Buffer.alloc(32, 8), now: () => NOW, getLogisticsRules: () => engine.defaults() });
  t.after(() => store.close());
  const account = store.saveAccount({ platform: 'pdd', label: '合成', cookie: 'SYNTHETIC' }, undefined, true);
  store.importResult(account.id, { orders: [{ platformOrderId: 'o', title: '合成时间回填', orderDate: AT - 86400000 }],
    shipments: [{ platformOrderId: 'o', waybillNo: 'SYNTHETIC-TASK083', status: 'arrived' }] });
  const initial = store.snapshot([account.id]).shipments[0];
  const legacy = { ...initial, station: NAME, stationSource: 'platform_event', arrivalAt: 0, arrivalAtSource: 'unknown', arrivalAtPrecision: 'unknown',
    logisticsEvents: [event()], logisticsCheckedAt: NOW - 100, ...changes };
  store.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(legacy), legacy.id);
  return { store, read: () => store.snapshot([account.id]).shipments[0] };
}

test('已归属目录站点仍回填缺失时间，保留原站名并幂等', t => {
  const { store, read } = fixture(t, { station: '人工确认站名', stationSource: 'unknown' });
  const known = [{ ...catalog[0], aliases: [{ name: '人工确认站名' }] }];
  store.getStationRules = () => ({ stations: known });
  assert.deepEqual(store.refreshStationRecognition(known), { changed: 1 });
  assert.equal(read().arrivalAt, AT);
  assert.equal(read().station, '人工确认站名');
  assert.equal(read().stationSource, 'unknown');
  assert.equal(read().arrivalAtSource, 'platform_event');
  assert.equal(read().arrivalAtPrecision, 'second');
  const revision = store.snapshot([]).serverRevision;
  assert.deepEqual(store.refreshStationRecognition(known), { changed: 0 });
  assert.equal(store.snapshot([]).serverRevision, revision);
});

test('无目录也重放明确动作，保留原始分钟或未知精度', t => {
  for (const precision of ['minute', 'unknown']) {
    const { store, read } = fixture(t, { logisticsEvents: [event(DESCRIPTION, AT, precision)] });
    assert.deepEqual(store.refreshStationRecognition([]), { changed: 1 });
    assert.equal(read().arrivalAt, AT);
    assert.equal(read().arrivalAtPrecision, precision);
  }
});

test('已有可信时间不被重放替换，未知时间不使用抓取时间补造', t => {
  for (const source of ['platform_event', 'locker_arrival']) {
    const { store, read } = fixture(t, { arrivalAt: AT - 1000, arrivalAtSource: source, arrivalAtPrecision: 'minute' });
    assert.deepEqual(store.refreshStationRecognition(catalog), { changed: 0 });
    assert.equal(read().arrivalAt, AT - 1000);
    assert.equal(read().arrivalAtPrecision, 'minute');
  }
  for (const time of [0, NOW + 1000]) {
    const { store, read } = fixture(t, { logisticsEvents: [event(DESCRIPTION, time)] });
    assert.deepEqual(store.refreshStationRecognition(catalog), { changed: 0 });
    assert.equal(read().arrivalAt, 0);
  }
});

test('完成、退回、自动领取和催取历史不能通过缺失时间回填重新到站', t => {
  const cases = [
    { picked: true }, { pickupCompletion: { version: 1, autoPicked: true } },
    ...['本人已签收', '用户已经领取', '已送达家门口', '已退回发件人'].map(description => ({ logisticsEvents: [event(description, AT + 1000), event()] })),
    { logisticsEvents: [event(), event('本人已取件', 0)] },
    { logisticsEvents: [event(`催取提醒：${DESCRIPTION}`)] }
  ];
  for (const changes of cases) {
    const { store, read } = fixture(t, changes);
    assert.deepEqual(store.refreshStationRecognition(catalog), { changed: 0 }, JSON.stringify(changes));
    assert.equal(read().arrivalAt, 0);
  }
});

test('完成后仍保留历史到站里程碑，仅主动回填路径拒绝重开', () => {
  const events = [event('本人已签收', AT + 1000), event()];
  assert.equal(engine.pickupEvidence(events).arrivalAt, AT);
  assert.equal(engine.pickupEvidence(events, undefined, true).arrivalAt, 0);
});

test('独立目录站点不能借用其他站点的到站时间', t => {
  const { store, read } = fixture(t, { station: '人工确认站名', stationSource: 'unknown' });
  const known = [...catalog, { id: 'manual', name: '人工确认站名', enabled: true }];
  store.getStationRules = () => ({ stations: known });
  assert.deepEqual(store.refreshStationRecognition(known), { changed: 0 });
  assert.equal(read().arrivalAt, 0);
  assert.equal(read().station, '人工确认站名');
  assert.equal(read().platformView.quality.arrivalTime.reasonCode, 'STATION_CONFLICT');
});
