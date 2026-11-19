// Synthetic structures from PDD-ARRIVAL-20261118 and Taobao TAOBAO-ARRIVAL-STRUCTURE; no real station identity is asserted.
export const NOW = Date.parse('2026-11-18T09:30:00+08:00');
export const ARRIVAL = Date.parse('2026-11-14T13:00:18+08:00');
export const STATION = '合成花园4卡菜鸟驿站';
export const WRAPPED = `${STATION}(合成品牌驿站${STATION})`;
export const catalog = [{ id: 'synthetic-station', name: STATION, enabled: true, aliases: [{ name: WRAPPED }] }];
export function arrivalEvent(platform, station = STATION, fields = {}) {
  return { time: ARRIVAL, timePrecision: 'second', provider: platform,
    ...(platform === 'pdd' ? { providerStatus: 'IN_CABINET', providerSubStatus: 'IN_CABINET_401' } : {}),
    description: `【代收点】您的快件已暂存至【${station}】，请及时领取`, ...fields };
}
export function completedEvent(platform, station = WRAPPED) {
  return { time: ARRIVAL + 2 * 86400000, timePrecision: 'second', provider: platform,
    ...(platform === 'pdd' ? { providerStatus: 'OUT_CABINET', providerSubStatus: 'OUT_CABINET_501' } : {}),
    description: `【代收点】快件已投递，收件人凭取件码在【${station}】领取` };
}
export const arrivalSamples = ['taobao', 'pdd', 'jd'].flatMap(platform => {
  const arrival = arrivalEvent(platform), complete = completedEvent(platform);
  const sample = (id, category, truth, events, expected, extras = {}) => ({ id: `${platform}-${id}`, platform, contentKind: 'logistics',
    target: 'arrival_time', methodId: `${platform}.arrival_evidence`, methodVersion: 2, category, truth,
    events, expected, ...extras });
  return [
    sample('same-station', 'positive', 'verified_synthetic', [completedEvent(platform, STATION), arrival], { arrivalAt: ARRIVAL, state: 'known', candidates: 1, usable: true }),
    sample('confirmed-alias', 'positive', 'verified_synthetic', [complete, arrival], { arrivalAt: ARRIVAL, state: 'known', candidates: 1, usable: true }, { catalog }),
    sample('unconfirmed-wrapper', 'boundary', 'unverified', [complete, arrival], { arrivalAt: 0, state: 'ambiguous', reasonCode: 'STATION_CONFLICT', candidates: 1, usable: false },
      { issueRef: platform === 'pdd' ? 'PDD-ARRIVAL-20261118' : platform === 'taobao' ? 'TAOBAO-ARRIVAL-STRUCTURE' : 'synthetic-station-wrapper' }),
    ...['包裹已改派，重新派送', '快件退回发件人', '快件已离开菜鸟驿站'].map((description, index) =>
      sample(`cycle-${index}`, 'negative', 'verified_synthetic', [{ time: ARRIVAL + 1000, timePrecision: 'second', description }, arrival], { arrivalAt: 0, state: 'unknown', candidates: 0 })),
    sample('undated-reset', 'boundary', 'verified_synthetic', [{ time: 0, description: '包裹已改投' }, arrival], { arrivalAt: 0, state: 'unknown', candidates: 0 }),
    ...['合成花园5卡菜鸟驿站', '合成花园4卡1栋菜鸟驿站', '合成花园4卡2号柜菜鸟驿站', '另一花园菜鸟驿站'].map((station, index) => {
      const oldStation = index === 1 ? '合成花园4卡2栋菜鸟驿站' : index === 2 ? '合成花园4卡1号柜菜鸟驿站' : STATION;
      return sample(`different-location-${index}`, 'negative', 'verified_synthetic', [completedEvent(platform, station), arrivalEvent(platform, oldStation)],
        { arrivalAt: 0, state: 'ambiguous', reasonCode: 'STATION_CONFLICT', candidates: 1, usable: false });
    }),
    sample('unknown-event-time', 'boundary', 'verified_synthetic', [arrivalEvent(platform, STATION, { time: 0, timePrecision: 'unknown' })],
      { arrivalAt: 0, state: 'unknown', candidates: 0 }),
    sample('future-event-time', 'negative', 'verified_synthetic', [arrivalEvent(platform, STATION, { time: NOW + 60000 })],
      { arrivalAt: 0, state: 'ambiguous', reasonCode: 'TIME_CONFLICT', candidates: 0 }),
  ];
});

export const aiSamples = ['taobao', 'pdd', 'jd'].flatMap(platform => ['event_time', 'station_match'].flatMap(target => {
  const input = target === 'event_time' ? { target, candidates: [], evidence: [{ sourceId: 'time-1', text: '11月9日 10:30' }] }
    : { target, candidates: [{ id: 'candidate-1', stationEvidenceId: 'candidate-1-station' }], clientConflictReasons: ['code_station_conflict'],
      evidence: [{ sourceId: 'source-station', text: STATION }, { sourceId: 'candidate-1-station', text: WRAPPED }] };
  const valid = { version: 1, target, action: target === 'event_time' ? 'review_time_format' : 'review_match',
    reasonCode: target === 'event_time' ? 'TIME_FORMAT_UNSUPPORTED' : 'STATION_NAME_VARIANT',
    candidateId: target === 'event_time' ? '' : 'candidate-1', evidence: input.evidence.map(item => ({ sourceId: item.sourceId, quote: item.text })), requiresReview: true };
  const base = { platform, contentKind: target === 'station_match' ? 'pickup_match' : 'logistics', target,
    methodId: `${platform}.${target === 'station_match' ? 'station_identity' : 'event_timestamp'}`, methodVersion: 1, input };
  return [
    { ...base, id: `${platform}-${target}-manual-review`, category: 'positive', truth: 'verified_synthetic', suggestion: valid, expected: { valid: true } },
    { ...base, id: `${platform}-${target}-invented-evidence`, category: 'negative', truth: 'verified_synthetic', suggestion: { ...valid,
      evidence: [{ sourceId: 'foreign', quote: '不存在的证据' }] }, expected: { valid: false, category: 'EVIDENCE_NOT_IN_INPUT' } },
    target === 'event_time'
      ? { ...base, id: `${platform}-${target}-invented-time`, category: 'boundary', truth: 'verified_synthetic',
        suggestion: { ...valid, timestamp: ARRIVAL }, expected: { valid: false, category: 'SCHEMA_FIELDS' } }
      : { ...base, id: `${platform}-${target}-unknown-identity`, category: 'boundary', truth: 'unverified',
        suggestion: valid, expected: { valid: true }, issueRef: 'station-identity-requires-human-confirmation' }
  ];
}));
