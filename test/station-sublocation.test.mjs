import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StationStore } from '../src/stations.mjs';
import { validateStationSuggestion } from '../src/station-text.mjs';
import { stationAutomationDecision } from '../src/station-automation.mjs';
import { candidateOf } from '../public/station-admin.js';
import { StationAiJobs, STATION_SYSTEM } from '../src/station-ai.mjs';
import { createService } from '../src/service.mjs';
import { randomBytes } from 'node:crypto';

const alias = '合成花园4卡5号柜兔喜快递柜';
const station = { id: 'station', name: '合成城区花园4卡店', enabled: true, aliases: [] };
const suggestion = { kind: 'locker', targetStationId: station.id, suggestedName: '', alias, subLocation: '4卡 5号柜', evidence: [alias] };
const candidate = { stationName: alias, fragment: `${alias}，4卡 5号柜`, suggestion,
  feedback: { active: true, verified: true, targetStationId: station.id, sourceStationName: alias, otherStationName: station.name, subLocation: '4卡 5号柜' } };

test('AI原文校验后将门店卡位与取件柜号分开，仍保留完整别名和证据', () => {
  const result = validateStationSuggestion(candidate, suggestion, [station]);
  assert.equal(result.subLocation, '5号柜');
  assert.equal(result.alias, alias);
  assert.deepEqual(result.evidence, [alias]);
  assert.equal(suggestion.subLocation, '4卡 5号柜');
  const shop = '合成城区花园4卡店合成路代收点';
  const empty = validateStationSuggestion({ stationName: shop, fragment: shop }, { ...suggestion, alias: shop, subLocation: '4卡', evidence: [shop] }, [station]);
  assert.equal(empty.subLocation, '');
  assert.throws(() => validateStationSuggestion(candidate, { ...suggestion, subLocation: '4卡2号柜' }, [station]), { code: 'AI_INVALID_RESULT' });
});

test('旧建议和旧人工反馈在后台显示柜号，无柜号不显示卡位，也不修改原记录', () => {
  assert.equal(candidateOf(candidate).subLocation, '5号柜');
  assert.equal(candidateOf({ ...candidate, suggestion: { ...suggestion, subLocation: '4卡' } }).subLocation, '');
  assert.equal(candidateOf({ ...candidate, suggestion: null }).subLocation, '5号柜');
  assert.equal(candidate.suggestion.subLocation, '4卡 5号柜');
  for (const subLocation of ['东门', '东门2区', 'A区2号柜', '三号柜']) assert.equal(candidateOf({ subLocation }).subLocation, subLocation);
});

test('新柜号建议兼容旧人工反馈及旧别名，但卡位和柜号冲突仍禁止自动应用', () => {
  const normalized = { ...candidate, suggestion: { ...suggestion, subLocation: '5号柜' } };
  assert.equal(stationAutomationDecision(normalized, [station]).reason, '');
  const legacy = { ...station, aliases: [{ name: alias, subLocation: '4卡 5号柜' }] };
  assert.equal(stationAutomationDecision(normalized, [legacy]).alreadyKnown, true);
  for (const subLocation of ['5卡 5号柜', '4卡 2号柜']) {
    assert.ok(stationAutomationDecision({ ...normalized, feedback: { ...candidate.feedback, subLocation } }, [station]).reason);
    assert.ok(stationAutomationDecision(normalized, [{ ...station, aliases: [{ name: alias, subLocation }] }]).reason);
  }
});

test('旧建议人工确认会保存正确柜号，原片段与现有规则证据保持不变', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const stations = new StationStore({ db, key: Buffer.alloc(32, 5) });
  stations.saveStation(station.id, { name: station.name });
  stations.enqueue([{ id: 'legacy', stationName: alias, fragment: candidate.fragment }]);
  const id = stations.candidates()[0].id;
  stations.updateCandidate(id, { status: 'review', suggestion });
  const before = stations.candidate(id).fragment;
  const result = stations.approveCandidate(id, {});
  assert.equal(result.station.aliases[0].subLocation, '5号柜');
  assert.equal(result.station.aliases[0].name, alias);
  assert.equal(result.candidate.fragment, before);
});

test('旧人工反馈送入AI时去除卡位但保留原站名；读数据不触发目录迁移', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const stations = new StationStore({ db, key: Buffer.alloc(32, 5) });
  stations.saveStation(station.id, { name: station.name, aliases: [{ name: alias, subLocation: '4卡 5号柜' }] });
  const jobs = new StationAiJobs({ stations, automaticEvents: false }); t.after(() => jobs.close());
  const before = stations.stationRules(), input = jobs.input(candidate);
  assert.equal(input.confirmedMapping.subLocation, '5号柜');
  assert.equal(input.confirmedMapping.sourceStationName, alias);
  assert.deepEqual(stations.stationRules(), before);
  assert.match(STATION_SYSTEM, /4卡属于站点门店位置/);
});

test('后台页面可加载共用子位置模块', async t => {
  const service = createService({ encryptionKey: '35'.repeat(32), adminToken: randomBytes(32).toString('hex'), fixture: true, scheduler: false });
  t.after(() => service.close());
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const response = await fetch(`http://127.0.0.1:${service.server.address().port}/station-location.js`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /javascript/);
  assert.match(await response.text(), /export function stationSubLocation/);
});
