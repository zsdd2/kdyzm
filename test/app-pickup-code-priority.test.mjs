import test from 'node:test';
import assert from 'node:assert/strict';
import '../app-source/pickcode/core/load-core.mjs';

const t = Date.parse('2026-11-02T10:30:20+08:00');
const codeValue = '7-6-7042';

function fixture(platform = 'jd', options = {}) {
  const account = { id: options.accountId || `account-${platform}`, platform, status: 'ok' };
  const order = {
    id: options.orderId || `order-${platform}`,
    accountId: account.id,
    platform,
    platformOrderId: `platform-${platform}`,
    title: '测试包裹',
    orderDate: options.orderDate ?? t - 86400000,
    orderDateSource: options.orderDateSource || 'platform'
  };
  const shipment = {
    id: options.shipmentId || `shipment-${platform}`,
    orderId: order.id,
    accountId: account.id,
    waybillNo: options.waybillNo || 'JD12345678901',
    carrier: options.carrier || '京东物流',
    status: options.status || 'arrived',
    pickupCode: options.pickupCode ?? codeValue,
    station: options.station ?? '示例小区东门店',
    arrivalAt: options.arrivalAt ?? t,
    arrivalAtSource: options.arrivalAtSource || 'platform_event',
    arrivalAtPrecision: options.arrivalAtPrecision || 'second',
    stationSource: options.stationSource || 'platform_event',
    updatedAt: options.updatedAt || t,
    ...(options.pickupCycle ? { pickupCycle: options.pickupCycle } : {}),
    ...(options.pickupCycleHistory ? { pickupCycleHistory: options.pickupCycleHistory } : {}),
    ...(options.logisticsEvents ? { logisticsEvents: options.logisticsEvents } : {})
  };
  return { account, order, shipment };
}

function store(accounts, saved = '') {
  let state = saved;
  const call = (action = 'snapshot', payload = {}) => {
    const response = JSON.parse(globalThis.PickCodeCore.dispatch(
      state,
      JSON.stringify({ action, payload })
    ));
    state = JSON.stringify(response.state);
    return response.result;
  };
  call.saved = () => state;
  if (!saved) {
    call('syncMeta', {
      bound: true,
      baseUrl: 'https://fixture.example',
      deviceId: 'device-1',
      accounts
    });
  }
  return call;
}

function sync(call, records, revision = 1, capabilities = []) {
  return call('syncImport', {
    snapshot: {
      schemaVersion: 1,
      serverRevision: revision,
      accounts: records.map(record => record.account),
      orders: records.map(record => record.order),
      shipments: records.map(record => record.shipment),
      capabilities
    },
    syncedAt: t + 30000
  });
}

function ingestBody(date = t + 15000, body = `【菜鸟驿站】取件码${codeValue}`) {
  return { id: `sms-${date}-${body.length}`, date, address: '106900', body };
}

function pickupCodeResult(result) {
  return result.codes.find(item => item.sources.some(source => source.kind === 'pickup'));
}

function pickupSource(result) {
  return pickupCodeResult(result).sources[0];
}

test('taobao/jd/pdd all auto-bind a unique valid pickup code without station or arrival time', () => {
  for (const platform of ['taobao', 'jd', 'pdd']) {
    const record = fixture(platform, {
      station: '',
      arrivalAt: 0,
      arrivalAtSource: 'unknown',
      arrivalAtPrecision: 'unknown'
    });
    const call = store([record.account]);
    sync(call, [record]);
    const result = call('ingest', { messages: [ingestBody()] });
    const source = pickupSource(result);
    assert.equal(pickupCodeResult(result).sourceLabel, '订单＋短信', platform);
    assert.deepEqual(source.linkedShipmentIds, [result.packages[0].shipments[0].id], platform);
    assert.equal(source.matchBasis, '取件码一致', platform);
  }
});

test('unsupported platforms do not enter the code-priority candidate set', () => {
  const record = fixture('other');
  const call = store([record.account]);
  sync(call, [record]);
  const result = call('ingest', { messages: [ingestBody()] });
  const source = pickupSource(result);
  assert.equal(pickupCodeResult(result).sourceLabel, '短信');
  assert.deepEqual(source.linkedShipmentIds, []);
  assert.deepEqual(source.matchCandidates, []);
});

test('hard code evidence conflicts stay unlinked and rank code_conflict first', () => {
  const cases = [
    {
      name: 'station',
      shipment: { station: '示例小区西门店' },
      body: `【菜鸟驿站】您的包裹在示例小区东门店，取件码${codeValue}`,
      reason: 'code_station_conflict'
    },
    {
      name: 'cabinet',
      shipment: { station: '示例小区2号柜' },
      body: `【菜鸟驿站】您的包裹在示例小区1号柜，取件码${codeValue}`,
      reason: 'code_cabinet_conflict'
    },
    {
      name: 'carrier',
      shipment: { carrier: '圆通速递' },
      body: `【菜鸟驿站】您的中通快递包裹在示例小区东门店，取件码${codeValue}`,
      reason: 'code_carrier_conflict'
    },
    {
      name: 'waybill',
      shipment: { waybillNo: 'JD12345678901' },
      body: `【菜鸟驿站】运单号JD99999999999，取件码${codeValue}`,
      reason: 'code_waybill_conflict'
    },
    {
      name: 'time',
      body: `【菜鸟驿站】取件码${codeValue}`,
      date: t + 3 * 86400000,
      reason: 'code_time_conflict'
    },
    {
      name: 'cycle',
      shipment: { logisticsEvents: [{ time: t + 600000, description: '包裹已改投，重新派送中' }] },
      body: `【菜鸟驿站】取件码${codeValue}`,
      date: t + 300000,
      reason: 'code_cycle_conflict'
    }
  ];

  for (const item of cases) {
    const record = fixture('jd', item.shipment);
    const call = store([record.account]);
    sync(call, [record], 1, ['recognition_workflow_v1', 'interaction_diagnostics_v1']);
    const result = call('ingest', { messages: [ingestBody(item.date || t + 15000, item.body)] });
    const source = pickupSource(result);
    assert.equal(pickupCodeResult(result).sourceLabel, '短信', item.name);
    assert.deepEqual(source.linkedShipmentIds, [], item.name);
    assert.equal(source.matchCandidates[0].decisionReason, 'code_conflict', item.name);
    assert.equal(source.matchCandidates[0].conflictReasonCode, item.reason, item.name);
    const batch = call('recognitionIssueBatch');
    assert.ok(batch.items[0].reasonCodes.includes('code_conflict'), item.name);
    assert.ok(batch.items[0].reasonCodes.includes(item.reason), item.name);
  }
});

test('a real initial pickup cycle does not reject a later normal SMS', () => {
  const record = fixture('jd', {
    pickupCycle: { id: 'cycle-initial', startedAt: t - 3600000, status: 'active' }
  });
  const call = store([record.account]);
  sync(call, [record]);
  const result = call('ingest', { messages: [ingestBody(t + 15000)] });
  assert.equal(pickupCodeResult(result).sourceLabel, '订单＋短信');
  assert.equal(pickupSource(result).matchCandidates[0].decisionReason, 'code');
});

test('same-code packages preserve every candidate, including cross-account duplicates', () => {
  const first = fixture('taobao', { accountId: 'a1', orderId: 'o1', shipmentId: 's1', waybillNo: 'YT12345678901' });
  const second = fixture('jd', { accountId: 'a2', orderId: 'o2', shipmentId: 's2', waybillNo: 'JD12345678901' });
  const call = store([first.account, second.account]);
  sync(call, [first, second]);
  const result = call('ingest', { messages: [ingestBody()] });
  const source = pickupSource(result);
  assert.equal(pickupCodeResult(result).sourceLabel, '短信');
  assert.deepEqual(source.linkedShipmentIds, []);
  assert.equal(source.matchCandidates.length, 2);
  assert.ok(source.matchCandidates.every(candidate => candidate.kind === 'code'));
});

test('a multi-package SMS does not auto-bind one same-code shipment without station and arrival evidence', () => {
  const record = fixture('jd', { station: '', arrivalAt: 0 });
  const call = store([record.account]);
  sync(call, [record]);
  const result = call('ingest', {
    messages: [ingestBody(t + 15000, `【菜鸟驿站】您有2个包裹在示例小区东门店，取件码${codeValue}`)]
  });
  assert.equal(pickupCodeResult(result).sourceLabel, '短信');
  assert.deepEqual(pickupSource(result).linkedShipmentIds, []);
});

test('an explicit waybill disambiguates the same code and later same-code siblings do not reopen that binding', () => {
  const first = fixture('taobao', { shipmentId: 's1', waybillNo: 'YT12345678901', carrier: '圆通' });
  const second = fixture('taobao', { shipmentId: 's2', waybillNo: 'YT12345678902', carrier: '圆通' });
  const call = store([first.account]);
  sync(call, [first]);
  let result = call('ingest', { messages: [ingestBody(t + 15000,
    `【圆通速递】您的圆通运单号${first.shipment.waybillNo}已到示例小区东门店，取件码${codeValue}`)] });
  const target = pickupSource(result).linkedShipmentIds[0];
  assert.ok(target);
  result = sync(call, [first, second], 2);
  result = call('snapshot');
  assert.deepEqual(pickupSource(result).linkedShipmentIds, [target]);
  assert.equal(pickupSource(result).matchNeedsReview, false);
});

test('canonical platforms never automatically override different pickup codes using an exact waybill', () => {
  for (const platform of ['taobao', 'jd', 'pdd']) {
    const record = fixture(platform);
    const call = store([record.account]);
    sync(call, [record], 1, ['recognition_workflow_v1']);
    const result = call('ingest', { messages: [ingestBody(t + 15000,
      `【菜鸟驿站】您的包裹运单号${record.shipment.waybillNo}在示例小区东门店，取件码654321`)] });
    assert.deepEqual(pickupSource(result).linkedShipmentIds, [], platform);
    assert.equal(pickupSource(result).matchCandidates[0].conflictReasonCode, 'code_mismatch', platform);
    assert.ok(JSON.stringify(call('recognitionIssueBatch')).includes('code_mismatch'), platform);
    assert.equal(result.operations.length, 0, platform);
  }
});

test('a late same-code competitor keeps the confirmed link and requests review', () => {
  const first = fixture('jd', { shipmentId: 's1', waybillNo: 'JD12345678901' });
  const second = fixture('jd', { shipmentId: 's2', waybillNo: 'JD12345678902' });
  const call = store([first.account]);
  sync(call, [first]);
  let result = call('ingest', { messages: [ingestBody()] });
  const originalId = pickupSource(result).linkedShipmentIds[0];
  result = sync(call, [first, second], 2);
  const source = pickupSource(result);
  assert.deepEqual(source.linkedShipmentIds, [originalId]);
  assert.equal(source.matchNeedsReview, true);
  assert.equal(pickupCodeResult(result).needsMatchReview, true);
});

test('a late platform pickup-code correction keeps the time-linked SMS and opens recognition review', () => {
  const record = fixture('jd', { pickupCode: '' });
  const call = store([record.account]);
  sync(call, [record], 1, ['recognition_workflow_v1', 'interaction_diagnostics_v1']);
  let result = call('ingest', {
    messages: [ingestBody(t + 15000, '【菜鸟驿站】您的包裹在示例小区东门店，取件码654321')]
  });
  const sourceId = pickupSource(result).sourceId;
  const linkedId = pickupSource(result).linkedShipmentIds[0];
  assert.ok(linkedId);
  const corrected = {
    ...record,
    shipment: { ...record.shipment, pickupCode: '123456', updatedAt: t + 60000 }
  };
  result = sync(call, [corrected], 2, ['recognition_workflow_v1', 'interaction_diagnostics_v1']);
  assert.equal(pickupSource(result).sourceId, sourceId);
  assert.deepEqual(pickupSource(result).linkedShipmentIds, [linkedId]);
  assert.equal(pickupSource(result).matchNeedsReview, true);
  const issues = call('recognitionIssueBatch').items;
  assert.ok(issues.length > 0);
  assert.ok(JSON.stringify(issues).includes('code_mismatch'));
});

test('late same-code review survives snapshot and does not queue a pick operation', () => {
  const first = fixture('jd', { shipmentId: 's1', waybillNo: 'JD12345678901' });
  const call = store([first.account]);
  sync(call, [first]);
  let result = call('ingest', { messages: [ingestBody()] });
  const originalId = pickupSource(result).linkedShipmentIds[0];
  const second = fixture('jd', { shipmentId: 's2', waybillNo: 'JD12345678902' });
  result = sync(call, [first, second], 2);
  assert.equal(pickupSource(result).matchNeedsReview, true);
  result = call('snapshot');
  assert.equal(pickupSource(result).matchNeedsReview, true);
  const pickupId = pickupCodeResult(result).id;
  result = call('update', { id: pickupId, patch: { isPicked: true } });
  assert.deepEqual(pickupSource(result).linkedShipmentIds, [originalId]);
  assert.equal(pickupCodeResult(result).needsMatchReview, true);
  assert.equal(result.operations.some(operation => operation.action === 'pick'), false);
});

test('an initial cycle at the collection timestamp does not reject an SMS sent 15 seconds earlier', () => {
  const record = fixture('jd', {
    pickupCycle: { id: 'cycle-initial', startedAt: t, status: 'active', evidenceKey: 'initial' }
  });
  const call = store([record.account]);
  sync(call, [record]);
  const result = call('ingest', {
    messages: [ingestBody(t - 15000, `【菜鸟驿站】您的包裹在示例小区东门店，取件码${codeValue}`)]
  });
  const source = pickupSource(result);
  assert.equal(pickupCodeResult(result).sourceLabel, '订单＋短信');
  assert.equal(source.matchCandidates.some(candidate => candidate.conflictReasonCode === 'code_cycle_conflict'), false);
});

test('persisted initial and legacy cycles do not treat first collection as a delivery reset', () => {
  for (const evidenceKey of ['initial', 'legacy']) {
    const record = fixture('jd');
    const original = store([record.account]);
    sync(original, [record]);
    const saved = JSON.parse(original.saved());
    saved.shipments[0].pickupCycle.startedAt = t;
    saved.shipments[0].pickupCycle.evidenceKey = evidenceKey;
    const call = store([record.account], JSON.stringify(saved));
    const result = call('ingest', { messages: [ingestBody(t - 15000)] });
    assert.equal(pickupCodeResult(result).sourceLabel, '订单＋短信', evidenceKey);
    assert.equal(pickupSource(result).matchCandidates.some(candidate => candidate.conflictReasonCode === 'code_cycle_conflict'), false);
  }
});

test('an exact waybill still matches a platform parcel whose pickup code is absent', () => {
  const record = fixture('jd', { pickupCode: '' });
  const call = store([record.account]);
  sync(call, [record]);
  const result = call('ingest', {
    messages: [ingestBody(
      t + 15000,
      `【菜鸟驿站】您的包裹运单号${record.shipment.waybillNo}在示例小区东门店，取件码654321`
    )]
  });
  assert.equal(pickupCodeResult(result).sourceLabel, '订单＋短信');
  assert.equal(pickupSource(result).matchBasis, '运单号一致');
});

test('manual bindings and historical cycles are preserved and never silently reassigned', () => {
  const manualRecord = fixture('jd', { pickupCode: '' });
  const call = store([manualRecord.account]);
  sync(call, [manualRecord]);
  let result = call('ingest', { messages: [ingestBody()] });
  const sourceId = pickupSource(result).sourceId;
  const targetId = result.packages[0].shipments[0].id;
  result = call('linkSource', { sourceId, shipmentIds: [targetId] });
  assert.deepEqual(pickupSource(result).linkedShipmentIds, [targetId]);
  const competitor = fixture('jd', { shipmentId: 's2', waybillNo: 'JD12345678902' });
  result = sync(call, [manualRecord, competitor], 2);
  assert.deepEqual(pickupSource(result).linkedShipmentIds, [targetId]);

  const historical = fixture('jd', {
    logisticsEvents: [{ time: t + 3600000, description: '包裹已改投，重新派送中' }]
  });
  const historyCall = store([historical.account]);
  sync(historyCall, [historical]);
  result = historyCall('ingest', { messages: [ingestBody()] });
  assert.equal(pickupCodeResult(result).sourceLabel, '短信');
  assert.equal(pickupSource(result).matchCandidates[0].conflictReasonCode, 'code_cycle_conflict');
});
