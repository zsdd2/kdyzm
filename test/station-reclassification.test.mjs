import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import '../src/logistics-rules.js';
import { StationStore } from '../src/stations.mjs';
import { createService } from '../src/service.mjs';

const engine = globalThis.PickCodeLogistics;
const NOW = Date.parse('2026-11-07T12:00:00+08:00'), AT = NOW - 60000;
const NAME = '合成幸福菜鸟驿站', ALIAS = `${NAME}2号柜`;
const catalog = [{ id: 'station-a', name: NAME, enabled: true, aliases: [{ name: ALIAS, subLocation: '2号柜' }] }];
const events = (description, time = AT) => [{ time, timePrecision: 'second', description }];
const recognize = (description, stations = catalog, rules = engine.defaults()) => engine.catalogPickupEvidence(events(description), stations, rules);
const empty = { arrivalAt: 0, arrivalAtSource: 'unknown', arrivalAtPrecision: 'unknown', station: '', stationSource: 'unknown' };

test('catalog recognition requires one exact enabled owner and preserves location numbers', () => {
  assert.deepEqual(engine.catalogStation(ALIAS, catalog), { id: 'station-a', name: NAME, ambiguous: false });
  assert.equal(engine.catalogStation(`${NAME}二号柜`, catalog).id, 'station-a');
  assert.equal(engine.catalogStation(`${NAME}２号柜`, catalog).id, 'station-a');
  assert.equal(engine.catalogStation(`${NAME}3号柜`, catalog).id, '');
  assert.equal(engine.catalogStation(`${NAME}南门`, catalog).id, '');
  assert.equal(engine.catalogStation(ALIAS, catalog.map(s => ({ ...s, enabled: false }))).id, '');
  assert.deepEqual(engine.catalogStation(ALIAS, [...catalog, { id: 'station-b', name: ALIAS, enabled: true }]), { id: '', name: '', ambiguous: true });
  assert.equal(engine.catalogStation('合成幸福四季花园店', [{ id: 's', name: '合成幸福4季花园店', enabled: true }]).id, '');
});

test('catalog evidence accepts a literal completed pickup action and original event time only', () => {
  assert.deepEqual(recognize(`已交付给${ALIAS}`), { arrivalAt: AT, arrivalAtSource: 'platform_event', arrivalAtPrecision: 'second', station: ALIAS, stationSource: 'platform_event' });
  assert.equal(recognize(`已寄存于${NAME}`).station, NAME);
  assert.equal(recognize(`已到达${NAME}`).station, NAME);
  assert.equal(recognize(`已交付给${NAME}二号柜`).station, `${NAME}二号柜`);
  const undated = engine.catalogPickupEvidence(events(`已交付给${ALIAS}`, 0), catalog);
  assert.equal(undated.station, ALIAS); assert.equal(undated.arrivalAt, 0); assert.equal(undated.arrivalAtSource, 'unknown');
  assert.deepEqual(recognize(`已交付给${NAME}南门`), empty);
  const alias = '合成幸福小区西侧服务处', stations = [{ id: 'station-a', name: NAME, enabled: true, aliases: [{ name: alias }] }];
  assert.deepEqual(recognize(`已签收：包裹已送达【${alias}】，请凭码取件`, stations), { arrivalAt: AT, arrivalAtSource: 'platform_event', arrivalAtPrecision: 'second', station: alias, stationSource: 'platform_event' });
  for (const text of [`预计送达【${alias}】`, `下一站【${alias}】正在运输中`, `正在发往【${alias}】`, `未能送达【${alias}】`, `送达【${alias}】失败`, `已到达中转分拣中心，最终取件点【${alias}】`, `催取提醒：包裹已送达【${alias}】`]) {
    assert.deepEqual(recognize(text, stations), empty, text);
  }
});

test('mere station mentions, instructions and invalid or completed history cannot create arrivals', () => {
  for (const description of [
    `运输途中经过${NAME}`, `下一站${NAME}`, `已发往${NAME}`, `请您到${NAME}领取`, `包裹仍在${NAME}`,
    `预计已交付给${NAME}`, `未能已交付给${NAME}`, `将于明日交付给${NAME}`, `请快递员已交付给${NAME}`,
    `再次通知：已交付给${NAME}`, `催取提醒：已交付给${NAME}`, `快件退回后已交付给${NAME}`,
    `已交付给杭州转运中心，下一站${NAME}`, `已送达家门口，取件点${NAME}`, `已签收：本人已签收，${NAME}`
  ]) assert.deepEqual(recognize(description), empty, description);
  for (const latest of ['已签收：本人已签收', '已取出快递柜，重新派送中', '已退回发件人']) {
    assert.deepEqual(engine.catalogPickupEvidence([...events(latest, AT + 1), ...events(`已交付给${NAME}`)], catalog), empty, latest);
  }
  for (const undated of ['已签收：本人已签收', '本人已取件', '用户已经领取', '包裹已送达家门口']) {
    assert.deepEqual(engine.catalogPickupEvidence([...events(`已交付给${NAME}`), ...events(undated, 0)], catalog), empty, undated);
  }
  assert.deepEqual(engine.catalogPickupEvidence([{ time: AT, station: NAME, description: '待取件' }], catalog), empty);
});

test('catalog evidence rejects same-name ambiguity and conflicting cabinet or gate evidence', () => {
  const ambiguous = [...catalog, { id: 'station-b', name: NAME, enabled: true, aliases: [] }];
  assert.deepEqual(recognize(`已交付给${NAME}`, ambiguous), empty);
  assert.deepEqual(recognize(`已交付给${ALIAS}，柜号为3号柜`), empty);
  assert.deepEqual(recognize(`已交付给${NAME}，已到达另一幸福菜鸟驿站`), empty);
  for (const [name, alias] of [['合成东门菜鸟驿站', '合成西门菜鸟驿站'], ['合成3栋菜鸟驿站', '合成4栋菜鸟驿站'], ['合成4卡菜鸟驿站', '合成5卡菜鸟驿站']]) {
    assert.deepEqual(recognize(`已交付给${alias}`, [{ id: 's', name, enabled: true, aliases: [{ name: alias }] }]), empty);
  }
  const subLocation = [{ id: 's', name: NAME, enabled: true, aliases: [{ name: `${NAME}南门`, subLocation: '2号柜' }] }];
  assert.deepEqual(recognize(`已交付给${NAME}南门，柜号3号柜`, subLocation), empty);
});

test('catalog refresh callback is in the station transaction and cannot leave a partial rule change', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec('CREATE TABLE fixture_projection(value TEXT)');
  const stations = new StationStore({ db, key: Buffer.alloc(32, 4), now: () => NOW });
  stations.saveStation('station-a', { name: NAME });
  const before = stations.stationRules();
  stations.onRulesChanged = values => { db.prepare('INSERT INTO fixture_projection VALUES(?)').run(values[0].aliases[0].name); throw new Error('synthetic projection failure'); };
  assert.throws(() => stations.saveStation('station-a', { aliases: [{ name: ALIAS }] }), /synthetic projection failure/);
  assert.deepEqual(stations.stationRules(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fixture_projection').get().count, 0);
});

async function fixture(t, options = {}) {
  const service = createService({ encryptionKey: randomBytes(32).toString('hex'), adminToken: randomBytes(24).toString('hex'), scheduler: false, fixture: true, now: () => NOW,
    aiRequest: async () => ({ choices: [{ message: { content: JSON.stringify({ kind: 'locker', targetStationId: 'station-a', alias: ALIAS, subLocation: '2号柜', evidence: [ALIAS] }) } }] }), ...options });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve)); t.after(() => service.close());
  const account = service.store.saveAccount({ platform: 'pdd', label: '合成', cookie: 'SYNTHETIC' }, undefined, true);
  return { service, account };
}

test('AI-approved aliases immediately refresh original cached station evidence without another collection', async t => {
  const { service, account } = await fixture(t);
  service.stations.saveStation('station-a', { name: NAME });
  service.store.importResult(account.id, { orders: [{ platformOrderId: 'o', title: '合成', orderDate: AT - 86400000 }], shipments: [{ platformOrderId: 'o', waybillNo: 'SYNTHETIC12345678', status: 'unknown', logisticsState: 'ok', logisticsEvents: events(`已交付给${ALIAS}`) }] });
  const before = service.store.snapshot([account.id]); assert.equal(before.shipments[0].station, '');
  service.stations.saveAiConfig({ channelName: '合成', baseUrl: 'https://api.example.com/v1', model: 'fixture', apiKey: randomBytes(24).toString('hex'), enabled: true, autoApply: true, logisticsEnabled: false });
  service.stations.enqueue([{ id: 'fixture', stationName: ALIAS, fragment: ALIAS, source: 'platform' }], { source: 'platform' });
  service.stationAi.request(); await service.stationAi.running;
  assert.equal(service.stations.candidates()[0].approvalMode, 'automatic');
  const after = service.store.snapshot([account.id]);
  assert.equal(after.shipments[0].station, ALIAS); assert.equal(after.shipments[0].arrivalAt, AT);
  assert.ok(after.serverRevision > before.serverRevision); assert.equal(after.shipments[0].picked, false);
  assert.deepEqual(service.store.refreshStationRecognition(service.stations.stationRules().stations), { changed: 0 });
  assert.equal(service.store.snapshot([account.id]).serverRevision, after.serverRevision);
});

test('one-click account sync does not refresh the whole cache when collection changes no evidence', async t => {
  const { service, account } = await fixture(t, { collector: async () => ({ orders: [], shipments: [], warnings: [] }) });
  const device = service.store.redeem(service.store.createPairing({ accountIds: [account.id] }).code, '合成设备');
  let calls = 0; const original = service.store.refreshStationRecognition.bind(service.store);
  service.store.refreshStationRecognition = (...args) => { calls++; return original(...args); };
  const request = () => fetch(`http://127.0.0.1:${service.server.address().port}/v1/accounts/sync`, { method: 'POST', headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' }, body: '{}' }).then(res => res.json());
  const started = await request(); assert.equal(started.accepted, true);
  for (let n = 0; n < 30 && ['queued', 'running'].includes(service.jobs.read(started.jobs[0].id).state); n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.jobs.read(started.jobs[0].id).state, 'completed'); assert.equal(calls, 0);
  const before = calls; await request(); assert.equal(calls, before);
});

test('collection refreshes only the shipments changed by the import callback', async t => {
  const { service, account } = await fixture(t, {
    collector: async () => ({
      orders: [{ platformOrderId: 'changed-order', title: '合成', orderDate: AT - 86400000 }],
      shipments: [{ platformOrderId: 'changed-order', waybillNo: 'SYNTHETIC-CHANGED', status: 'unknown',
        logisticsState: 'ok', logisticsEvents: events(`已交付给${NAME}`) }],
      warnings: []
    })
  });
  service.stations.saveStation('station-a', { name: NAME });
  const device = service.store.redeem(service.store.createPairing({ accountIds: [account.id] }).code, '合成设备');
  const calls = [], original = service.store.refreshStationRecognition.bind(service.store);
  service.store.refreshStationRecognition = (...args) => { calls.push(args); return original(...args); };
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}/v1/accounts/sync`, {
    method: 'POST', headers: { Authorization: `Bearer ${device.token}`, 'Content-Type': 'application/json' }, body: '{}'
  });
  const started = await response.json();
  for (let n = 0; n < 30 && ['queued', 'running'].includes(service.jobs.read(started.jobs[0].id).state); n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(service.jobs.read(started.jobs[0].id).state, 'completed');
  const shipment = service.store.snapshot([account.id]).shipments.find(item => item.waybillNo === 'SYNTHETIC-CHANGED');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], [shipment.id]);
  assert.equal(shipment.station, NAME);
});
