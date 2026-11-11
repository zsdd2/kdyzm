import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, jdParcels, pddParcels, taobaoParcels, timestamp } from '../src/collectors.mjs';
import { normalizeLogisticsEvents, pickupEvidence, pickupStation } from '../src/collector-enrichment.mjs';
import { Store } from '../src/store.mjs';

const NOW = Date.parse('2026-11-02T16:00:00+08:00');
const ARRIVAL = '2026-11-02 14:30:25';
const STATION = '菜鸟驿站（幸福小区东门店）';
const actual = `您的快件已存放至【${STATION}】，请及时取件`;
const reminder = `催取提醒，您的快件仍在【${STATION}】，请尽快取件`;
const response = data => new Response(JSON.stringify(data));
const jd = steps => jdParcels({ multiPackageTrackInfoList: [{ carriageInfo: { carriageId: 'A' },
  trackGroupInfo: { orderTrackShowList: steps.map(([time, description]) => ({ CreationTime: time, Content: description })) } }] }, 'o', NOW)[0];
const tb = steps => taobaoParcels({ mailNo: 'A', multiStage: steps.map(([time, description]) => ({ time, title: '物流更新', labelDesc: { text: description } })) }, 'o')[0];
async function pdd(steps, cabinet = {}) {
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => String(url).includes('order_list_v4')
    ? response({ orders: [{ order_sn: 'o', tracking_number: 'A' }], has_more: false })
    : String(url).includes('/cabinet/') ? response({ result: cabinet })
    : response({ shipping: { tracking_number: 'A', traces: steps.map(([time, info]) => ({ time, info })) } })
  })({ platform: 'pdd' }, 'pdd_user_id=SYNTHETIC');
  return result.shipments[0];
}

test('all collectors retain the real arrival and exact station when the newest event is a reminder', async () => {
  const steps = [['2026-11-02 15:40:00', reminder], [ARRIVAL, actual], ['2026-11-02 13:00:00', '已到达杭州转运分拣中心']];
  for (const parcel of [tb(steps), jd(steps), await pdd(steps)]) {
    assert.equal(parcel.status, 'arrived');
    assert.equal(parcel.arrivalAt, timestamp(ARRIVAL));
    assert.equal(parcel.arrivalAtSource, 'platform_event');
    assert.equal(parcel.arrivalAtPrecision, 'second');
    assert.equal(parcel.station, STATION);
    assert.equal(parcel.stationSource, 'platform_event');
  }
});

test('a route arrival cannot certify a future pickup station even after a later reminder', async () => {
  for (const description of [`您的快件已到达【杭州转运中心】，下一站【${STATION}】`,
    `您的快件已到达【杭州转运中心】发往【${STATION}】`,
    `您的快件已到达【杭州中心】，将到【${STATION}】`,
    `您的快件已到达【杭州中心】下一站【${STATION}】`]) {
    assert.equal(pickupStation(description), '', description);
    for (const steps of [[[ARRIVAL, description]], [['2026-11-02 15:40:00', reminder], [ARRIVAL, description]]]) {
      for (const parcel of [tb(steps), jd(steps), await pdd(steps)]) {
        assert.equal(parcel.arrivalAt, 0, description);
        assert.equal(parcel.arrivalAtSource, 'unknown', description);
        assert.equal(parcel.arrivalAtPrecision, 'unknown', description);
        if (steps.length === 1) assert.equal(parcel.station, '', description);
      }
    }
  }
});

test('Taobao full-track supplement extracts an older arrival behind a current reminder', async () => {
  const result = await createCollector({ now: () => NOW, fetchImpl: async url => {
    const target = new URL(url);
    if (target.hostname === 'pages-g.m.taobao.com') return new Response(`<script>window['__ICE_SUSPENSE_LOADER__']['undefined'] = ${JSON.stringify({ result: { data: { newLogistics: { fields: { mailNo: 'A' } } } } })};</script>`);
    if (target.hostname === 'buyertrade.taobao.com') return new Response(JSON.stringify({ expressId: 'A', address: [
      { time: ARRIVAL, place: actual }, { time: '2026-11-02 15:00:00', place: reminder },
    ] }).replace(/[^\x00-\x7f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
    return response({ ret: ['SUCCESS'], data: { data: {} } });
  } })({ platform: 'taobao' }, '_m_h5_tk=SYNTHETIC_1793350000', {
    targetOrder: { platformOrderId: 'o', shipments: [{ waybillNo: 'A', status: 'transit' }] },
  });
  assert.equal(result.shipments[0].arrivalAt, timestamp(ARRIVAL));
  assert.equal(result.shipments[0].arrivalAtSource, 'platform_event');
  assert.equal(result.shipments[0].station, STATION);
});

test('minute and unknown time precision survive normalization and Taobao structured station cards', () => {
  const parcel = taobaoParcels({ mailNo: 'A', multiStage: [{ title: '待取件', time: '2026-11-02 14:30',
    cardDesc: { title: '丰巢快递柜', subTitle: '幸福小区西门3号柜' } }] }, 'o')[0];
  assert.equal(parcel.arrivalAt, timestamp('2026-11-02 14:30'));
  assert.equal(parcel.arrivalAtPrecision, 'minute');
  assert.equal(parcel.station, '丰巢快递柜 幸福小区西门3号柜');
  assert.equal(parcel.logisticsEvents[0].timePrecision, 'minute');
  const signedCard = taobaoParcels({ mailNo: 'B', multiStage: [{ title: '签收', labelDesc: { text: '已存放至驿站' }, time: ARRIVAL,
    cardDesc: { title: STATION, custom: { expressCode: { code: '7-1-1234' } } } }] }, 'o')[0];
  assert.equal(signedCard.station, STATION);
  assert.equal(signedCard.arrivalAtSource, 'platform_event');
  const events = normalizeLogisticsEvents([{ time: '2026-11-02', description: actual }, { time: '11-02 14:30', description: actual }], timestamp).events;
  assert.ok(events.every(event => event.timePrecision === 'unknown'));
  assert.equal(pickupEvidence(events).arrivalAtPrecision, 'unknown');
});

test('sorting centers, projected or failed arrivals provide no pickup time or station', async () => {
  for (const description of ['已到达杭州转运分拣中心', `预计已送达【${STATION}】`, `未能存入【${STATION}】，入柜失败`,
    '请快递员存放至幸福小区菜鸟驿站', '催取提醒，请及时取件']) {
    for (const parcel of [tb([[ARRIVAL, description]]), jd([[ARRIVAL, description]]), await pdd([[ARRIVAL, description]])]) {
      assert.equal(parcel.arrivalAt, 0, description);
      assert.equal(parcel.arrivalAtSource, 'unknown', description);
      assert.equal(parcel.station, '', description);
    }
  }
});

test('returns and redirects cut off the old pickup cycle and a later arrival starts a new cycle', async () => {
  for (const boundary of ['快件已退回，等待退件', '已改投幸福小区西门菜鸟驿站', '重新派送中']) {
    const steps = [['2026-11-02 15:00:00', boundary], [ARRIVAL, actual]];
    for (const parcel of [tb(steps), jd(steps), await pdd(steps)]) {
      assert.equal(parcel.arrivalAt, 0, boundary);
      assert.equal(parcel.station, '', boundary);
    }
    const next = ['2026-11-02 15:30:00', '已存入【丰巢快递柜幸福小区西门3号柜】，请取件'];
    for (const parcel of [tb([next, ...steps]), jd([next, ...steps]), await pdd([next, ...steps])]) {
      assert.equal(parcel.arrivalAt, timestamp(next[0]));
      assert.equal(parcel.station, '丰巢快递柜幸福小区西门3号柜');
    }
  }
});

test('station parsing preserves doors, shop names and cabinet numbers and never treats a route node as a pickup station', () => {
  for (const station of [STATION, '菜鸟驿站（幸福小区西门店）', '丰巢快递柜幸福小区东门1号柜', '丰巢快递柜幸福小区东门2号柜']) {
    assert.equal(pickupStation(`您的包裹已存入【${station}】，凭码取件`), station);
  }
  assert.equal(pickupStation('快件由【杭州转运中心】发往幸福小区'), '');
  assert.equal(pickupStation('已到达杭州分拣中心，请等待派送'), '');
  assert.equal(pickupStation('已存放至菜鸟驿站'), '菜鸟驿站');
  assert.equal(pickupStation('已到达驿站'), '驿站');
  const moved = pickupEvidence(normalizeLogisticsEvents([
    { time: '2026-11-02 15:00:00', description: '催取提醒，包裹在【菜鸟驿站（幸福小区西门店）】，请取件' },
    { time: ARRIVAL, description: actual },
  ], timestamp).events);
  assert.equal(moved.arrivalAt, 0);
  assert.equal(moved.station, '菜鸟驿站（幸福小区西门店）');
});

test('PDD explicitly distinguishes actual cabinet arrival from record creation, including no-code arrival', async () => {
  const order = { order_sn: 'o', tracking_number: 'A', order_status_text: '待取件' };
  const created = pddParcels(order, { code: '123456', address: STATION, create_time: '2026-11-02 14:29' })[0];
  assert.equal(created.arrivalAtSource, 'locker_created');
  assert.equal(created.arrivalAtPrecision, 'minute');
  assert.equal(created.stationSource, 'locker');
  const arrived = pddParcels({ ...order, order_status_text: '' }, { address: STATION, arrival_time: ARRIVAL, create_time: '2026-11-02 14:29:00' })[0];
  assert.equal(arrived.status, 'arrived');
  assert.equal(arrived.pickupCode, '');
  assert.equal(arrived.arrivalAt, timestamp(ARRIVAL));
  assert.equal(arrived.arrivalAtSource, 'locker_arrival');
  assert.equal((await pdd([['2026-11-02 15:00:00', reminder]], { code: '123456', address: STATION, create_time: ARRIVAL })).arrivalAtSource, 'locker_created');
});

function storeFixture(t, filename) {
  const key = Buffer.alloc(32, 2);
  let store = new Store({ filename, key, now: () => NOW });
  t.after(() => store.close());
  const account = store.saveAccount({ platform: 'taobao', label: '合成', cookie: 'SYNTHETIC' }, 'a', true);
  const order = { platformOrderId: 'o', title: '合成订单' };
  const shipment = { platformOrderId: 'o', waybillNo: 'A', status: 'arrived' };
  const sync = input => {
    store.importResult(account.id, { orders: [order], shipments: [{ ...shipment, ...input }] });
    return store.snapshot([account.id]).shipments[0];
  };
  return { store, account, sync, reopen: () => { store.close(); store = new Store({ filename, key, now: () => NOW }); return store; } };
}

test('store never fills arrival time from a sync clock, and leaves unsupported legacy evidence unknown', t => {
  const { sync } = storeFixture(t);
  assert.equal(sync({}).arrivalAt, 0);
  const legacy = sync({ arrivalAt: NOW, station: STATION });
  assert.equal(legacy.arrivalAt, NOW);
  assert.equal(legacy.arrivalAtSource, 'unknown');
  assert.equal(legacy.arrivalAtPrecision, 'unknown');
  assert.equal(legacy.stationSource, 'unknown');
});

test('generic arrival station cannot erase a specific raw or proven station or certify its provenance', t => {
  const { sync } = storeFixture(t);
  const rawStation = '中山石岐远洋风景4卡店';
  const logisticsEvents = [{ time: timestamp(ARRIVAL), description: '已到达驿站', location: '中山石岐' }];
  const raw = sync({ station: rawStation, pickupCode: '7-6-7042', arrivalAt: timestamp(ARRIVAL), logisticsEvents,
    logisticsState: 'ok', logisticsCheckedAt: NOW });
  assert.equal(raw.station, rawStation);
  assert.equal(raw.stationSource, 'unknown');
  assert.equal(raw.arrivalAtSource, 'platform_event');
  const merged = sync({ logisticsEvents, logisticsState: 'ok', logisticsCheckedAt: NOW + 1 });
  assert.equal(merged.station, rawStation);
  assert.equal(merged.stationSource, 'unknown');
  const proven = sync({ station: rawStation, stationSource: 'locker', arrivalAt: timestamp(ARRIVAL),
    arrivalAtSource: 'locker_arrival', arrivalAtPrecision: 'second', logisticsEvents, logisticsState: 'ok', logisticsCheckedAt: NOW + 2 });
  assert.equal(proven.station, rawStation);
  assert.equal(proven.stationSource, 'locker');
});

test('store keeps locker record creation distinct from arrival and rejects stale evidence updates', t => {
  const { sync } = storeFixture(t);
  const created = sync({ arrivalAt: timestamp(ARRIVAL), arrivalAtSource: 'locker_created', arrivalAtPrecision: 'second',
    station: STATION, stationSource: 'locker', logisticsCheckedAt: NOW });
  assert.equal(created.arrivalAtSource, 'locker_created');
  const stale = sync({ arrivalAt: NOW, arrivalAtSource: 'platform_event', arrivalAtPrecision: 'minute', station: '错误站点',
    stationSource: 'platform_event', logisticsCheckedAt: NOW - 1 });
  assert.equal(stale.arrivalAt, created.arrivalAt);
  assert.equal(stale.arrivalAtSource, 'locker_created');
  assert.equal(stale.station, STATION);
  assert.equal(stale.stationSource, 'locker');
});

test('store persists optional provenance and event precision through merge, full snapshot and reopen', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pickcode-evidence-'));
  const { account, sync, reopen } = storeFixture(t, join(directory, 'cache.sqlite'));
  t.after(() => {
    assert.ok(directory.startsWith(join(tmpdir(), 'pickcode-evidence-')));
    rmSync(directory, { recursive: true, force: true });
  });
  const events = normalizeLogisticsEvents([{ time: '2026-11-02 14:30', description: actual }], timestamp).events;
  const first = sync({ ...pickupEvidence(events), logisticsEvents: events, logisticsState: 'ok', logisticsCheckedAt: NOW });
  const empty = sync({ logisticsEvents: [], logisticsState: 'empty', logisticsCheckedAt: NOW + 1 });
  assert.equal(empty.arrivalAt, first.arrivalAt);
  assert.equal(empty.arrivalAtSource, 'platform_event');
  assert.equal(empty.arrivalAtPrecision, 'minute');
  assert.equal(empty.stationSource, 'platform_event');
  assert.equal(empty.logisticsEvents[0].timePrecision, 'minute');
  const reopened = reopen().snapshot([account.id]).shipments[0];
  assert.equal(reopened.arrivalAtPrecision, 'minute');
  assert.equal(reopened.logisticsEvents[0].timePrecision, 'minute');
  assert.equal(reopened.station, STATION);
});

test('legacy cache can be repaired only from retained independent platform events, and redirects clear it', t => {
  const { store, account, sync } = storeFixture(t);
  const first = sync({ arrivalAt: NOW, station: '旧的同步推断地址', pickupCode: 'OLD', logisticsEvents: [
    { time: timestamp('2026-11-02 14:30'), timeText: '2026-11-02 14:30', description: actual },
  ], logisticsState: 'ok', logisticsCheckedAt: NOW });
  assert.equal(first.arrivalAt, timestamp('2026-11-02 14:30'));
  assert.equal(first.arrivalAtSource, 'platform_event');
  assert.equal(first.arrivalAtPrecision, 'minute');
  assert.equal(first.station, STATION);
  const redirected = sync({ status: 'transit', logisticsEvents: normalizeLogisticsEvents([
    { time: '2026-11-02 15:30:00', description: '快件退回后改投，重新派送中' },
  ], timestamp).events, logisticsState: 'ok', logisticsCheckedAt: NOW + 1 });
  assert.equal(redirected.arrivalAt, 0);
  assert.equal(redirected.arrivalAtSource, 'unknown');
  assert.equal(redirected.station, '');
  assert.equal(redirected.pickupCode, '');
  assert.equal(store.snapshot([account.id]).shipments[0].arrivalAt, 0);
  const next = sync({ arrivalAt: timestamp('2026-11-02 15:40:00'), arrivalAtSource: 'platform_event', arrivalAtPrecision: 'second',
    station: '', stationSource: 'unknown', logisticsEvents: normalizeLogisticsEvents([
      { time: '2026-11-02 15:40:00', description: '待取件' },
    ], timestamp).events, logisticsState: 'ok', logisticsCheckedAt: NOW + 2 });
  assert.equal(next.station, '');
  assert.equal(next.arrivalAt, timestamp('2026-11-02 15:40:00'));
});
