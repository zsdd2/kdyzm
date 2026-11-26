import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { StationStore } from '../src/stations.mjs';
import { StationAiJobs, publicAddress, validateAiBaseUrl, resolveAiEndpoint, requestAiJson } from '../src/station-ai.mjs';
import { LOGISTICS_TEST_RESULT } from '../src/ai-templates.mjs';

const NOW = Date.parse('2026-11-03T12:00:00+08:00');
function fixture(t, request) {
  let time = NOW;
  const db = new DatabaseSync(':memory:'), now = () => time;
  const stations = new StationStore({ db, key: Buffer.alloc(32, 4), now });
  stations.saveAiConfig({ channelName: '测试', baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'test-key', enabled: true });
  const jobs = new StationAiJobs({ stations, now, request, automaticEvents: false });
  t.after(async () => { await jobs.close(); db.close(); });
  return { stations, jobs, advance: duration => { time += duration; } };
}
const reply = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] });
const replyContent = content => ({ choices: [{ message: { content } }] });
const suggestion = { kind: 'locker', suggestedName: '4卡2号柜', alias: '4卡2号柜', subLocation: '2号柜', evidence: ['4卡2号柜'] };
const enqueue = (stations, id = 'c1', fragment = '包裹在4卡2号柜，电话13812345678，取件码7-6-7042') => stations.enqueue([{ id, stationName: '4卡2号柜', fragment, source: 'sms' }]);

test('manual requests explain each rejection and work independently of the automatic switch', async t => {
  let finish;
  const { stations, jobs } = fixture(t, () => new Promise(resolve => { finish = resolve; }));
  assert.equal(jobs.request().code, 'AI_NO_PENDING');
  stations.saveAiConfig({ enabled: false });
  assert.equal(jobs.runDue().code, 'AI_AUTOMATIC_DISABLED');
  enqueue(stations);
  assert.equal(jobs.request().accepted, true);
  assert.equal(jobs.request().code, 'AI_RUNNING');
  await new Promise(resolve => setImmediate(resolve));
  finish(reply(suggestion)); await jobs.running;
  assert.equal(stations.candidates()[0].status, 'review');
  stations.saveAiConfig({ enabled: false, clearApiKey: true });
  assert.equal(jobs.request().code, 'AI_NOT_CONFIGURED');
  await jobs.close();
  assert.equal(jobs.request().code, 'SERVICE_STOPPING');
});

test('candidate details record the exact latest sanitized input and only a validated result', async t => {
  let actual;
  const { stations, jobs } = fixture(t, async request => { actual = JSON.parse(request.body).messages[1].content; return reply(suggestion); });
  enqueue(stations);
  assert.equal(stations.candidates()[0].analysis, null);
  jobs.request(); await jobs.running;
  const candidate = stations.candidates()[0];
  assert.deepEqual(candidate.analysis.input, JSON.parse(actual));
  assert.deepEqual(candidate.analysis.result, candidate.suggestion);
  assert.equal(candidate.analysis.error, null);
  assert.equal(candidate.analysis.startedAt, NOW); assert.equal(candidate.analysis.finishedAt, NOW);
  assert.ok(!JSON.stringify(candidate.analysis).includes('test-key'));
  assert.ok(!JSON.stringify(candidate.analysis).includes('13812345678'));
});

test('AI output boundary redacts legacy catalog and candidate text without rewriting the catalog', async t => {
  let actual;
  const { stations, jobs } = fixture(t, async request => { actual = JSON.parse(JSON.parse(request.body).messages[1].content); return reply(suggestion); });
  const old = stations.saveStation('old', { name: '合成服务站', region: '合成地区东区', aliases: [{ name: '合成一号柜' }] });
  const unsafe = { ...old, region: '合成地区 电话13812345678 邮箱test@example.com 取件码7-6-7042', name: old.name + '13812345678' };
  stations.db.prepare('UPDATE station_catalog SET data=? WHERE id=?').run(JSON.stringify(unsafe), old.id);
  stations.saveStation('safe', { name: '普通服务站', region: '合成地区西区' });
  enqueue(stations);
  const candidate = stations.candidates()[0];
  stations.updateCandidate(candidate.id, { region: '旧地区13812345678', fragment: candidate.fragment + ' 运单SF123456789012 https://example.com/private' });
  jobs.request(); await jobs.running;
  assert.ok(actual);
  for (const secret of ['13812345678', 'test@example.com', '7-6-7042', 'SF123456789012', 'https://example.com/private']) assert.ok(!JSON.stringify(actual).includes(secret), secret);
  assert.equal(actual.knownStations.find(s => s.id === 'safe').region, '合成地区西区');
  assert.deepEqual(stations.station('old'), unsafe);
  assert.deepEqual(stations.candidate(candidate.id).analysis.input, actual);
});

test('retry cooldown and daily budget refusals provide actionable reason codes', async t => {
  const { stations, jobs, advance } = fixture(t, async () => reply(suggestion));
  enqueue(stations);
  const candidate = stations.candidates()[0];
  stations.updateCandidate(candidate.id, { status: 'failed', attempts: 1, retryAt: NOW + 3600000 });
  const waiting = jobs.request();
  assert.equal(waiting.code, 'AI_RETRY_COOLDOWN'); assert.equal(waiting.retryAt, NOW + 3600000); assert.ok(waiting.message);
  advance(3600000); jobs.request(); await jobs.running;
  enqueue(stations, 'next', '另一条包裹在4卡2号柜');
  stations.saveAiConfig({ dailyLimit: 1 });
  const exhausted = jobs.request(); assert.equal(exhausted.code, 'AI_DAILY_LIMIT'); assert.ok(exhausted.message.includes('测试和重试'));
});

test('an excessive configured limit still allows at most twenty calls while upload batches remain capped at twenty', async t => {
  let calls = 0;
  const { stations, jobs } = fixture(t, async request => {
    calls++; const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    return reply({ kind: 'locker', suggestedName: input.fragment, alias: input.fragment, evidence: [input.fragment] });
  });
  stations.saveAiConfig({ dailyLimit: 30 });
  const items = Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, stationName: `4卡${i}号柜`, fragment: `4卡${i}号柜`, source: 'sms' }));
  assert.throws(() => stations.enqueue(items), { code: 'INVALID_CANDIDATES' });
  stations.enqueue(items.slice(0, 20)); stations.enqueue(items.slice(20));
  jobs.request(); await jobs.running;
  assert.equal(calls, 20); assert.equal(stations.aiConfig().usageToday, 20);
  assert.equal(stations.candidates().filter(c => c.status === 'review').length, 20);
  assert.equal(stations.candidates().filter(c => c.status === 'pending').length, 5);
});

test('analysis details never store provider errors, invalid model content, headers or API keys', async t => {
  const { stations, jobs } = fixture(t, async () => { throw Object.assign(new Error('PRIVATE_PROVIDER_BODY test-key 13812345678'), { code: 'PRIVATE_PROVIDER_CODE' }); });
  enqueue(stations); jobs.request(); await jobs.running;
  const detail = stations.candidates()[0].analysis;
  assert.equal(detail.result, null); assert.equal(detail.error.code, 'AI_REQUEST_FAILED'); assert.equal(detail.finishedAt, NOW);
  for (const secret of ['PRIVATE_PROVIDER', 'test-key', '13812345678', 'Authorization', 'headers']) assert.ok(!JSON.stringify(detail).includes(secret));
});

test('analysis context is bounded and the recorded JSON is exactly the bounded JSON sent to the model', async t => {
  let actual;
  const { stations, jobs } = fixture(t, async request => { actual = JSON.parse(JSON.parse(request.body).messages[1].content); return reply(suggestion); });
  for (let i = 0; i < 60; i++) stations.saveStation(`large-${i}`, { name: `合成${'长'.repeat(100)}站${i}` });
  enqueue(stations); jobs.request(); await jobs.running;
  const detail = stations.candidates()[0].analysis;
  assert.equal(actual.knownStationsTruncated, true); assert.ok(Buffer.byteLength(JSON.stringify(actual), 'utf8') <= 16384);
  assert.deepEqual(detail.input, actual); assert.ok(Buffer.byteLength(JSON.stringify(detail), 'utf8') <= 24576);
});

test('clearing the key aborts active work and records only a safe cancellation', async t => {
  let finish, signal;
  const { stations, jobs } = fixture(t, request => { signal = request.signal; return new Promise(resolve => { finish = resolve; }); });
  enqueue(stations); jobs.request(); await new Promise(resolve => setImmediate(resolve));
  stations.saveAiConfig({ enabled: false, clearApiKey: true }); await jobs.running;
  assert.equal(signal.aborted, true); assert.equal(jobs.request().code, 'AI_NOT_CONFIGURED');
  let candidate = stations.candidates()[0]; assert.equal(candidate.status, 'pending'); assert.equal(candidate.analysis.error.code, 'AI_CONFIG_CHANGED');
  finish(reply(suggestion)); await new Promise(resolve => setImmediate(resolve));
  candidate = stations.candidates()[0]; assert.equal(candidate.suggestion, null); assert.equal(candidate.analysis.result, null);
});

test('channel changes cancel the whole batch in flight and between candidates', async t => {
  for (const patch of [{ baseUrl: 'https://next.example.com/v1' }, { model: 'next-model' }, { apiKey: 'next-key' }]) await t.test(Object.keys(patch)[0], async t => {
    let rejectFirst;
    const calls = [], { stations, jobs } = fixture(t, request => {
      calls.push(request);
      return calls.length === 1 ? new Promise((_, reject) => { rejectFirst = reject; }) : Promise.resolve(reply(suggestion));
    });
    enqueue(stations); enqueue(stations, 'c2', '另一条包裹在4卡2号柜');
    jobs.request(); await new Promise(resolve => setImmediate(resolve));
    stations.saveAiConfig(patch); await jobs.running;
    rejectFirst(Object.assign(new Error('temporary'), { code: 'AI_HTTP_ERROR', retryable: true }));
    assert.equal(calls.length, 1); assert.equal(stations.aiConfig().usageToday, 1);
    const attempted = stations.candidates().find(c => c.attempts);
    assert.equal(attempted.status, 'pending'); assert.ok(attempted.error.includes('配置或密钥已更改'));
    assert.equal(attempted.cancelledAttempts, 1, 'cancelled requests remain retryable with the replacement service');
    assert.equal(jobs.request().accepted, true); await jobs.running;
    assert.equal(calls.length, 3); assert.equal(stations.aiConfig().usageToday, 3);
    for (const call of calls.slice(1)) {
      assert.equal(call.url, patch.baseUrl || 'https://api.example.com/v1');
      assert.equal(JSON.parse(call.body).model, patch.model || 'test-model');
      assert.equal(call.headers.Authorization, `Bearer ${patch.apiKey || 'test-key'}`);
    }
    assert.ok(stations.candidates().every(c => c.status === 'review'));
  });
  await t.test('between candidates', async t => {
    let calls = 0, changed = false;
    const { stations, jobs } = fixture(t, async () => { calls++; return reply(suggestion); });
    enqueue(stations); enqueue(stations, 'c2', '另一条包裹在4卡2号柜');
    const recordSuggestion = stations.recordSuggestion.bind(stations);
    stations.recordSuggestion = (...args) => {
      const result = recordSuggestion(...args);
      if (!changed) { changed = true; stations.saveAiConfig({ model: 'next-model' }); }
      return result;
    };
    jobs.request(); await jobs.running;
    assert.equal(calls, 1); assert.equal(stations.candidates().filter(c => c.status === 'review').length, 1);
    assert.equal(stations.candidates().find(c => c.status === 'pending').analysis, null);
    assert.equal(jobs.request().accepted, true); await jobs.running; assert.equal(calls, 2);
  });
});

test('cancelled third calls remain recoverable while actual calls consume quota and closed candidates stay closed', async t => {
  await t.test('repeated cancellation cannot bypass the daily quota', async t => {
    let calls = 0;
    const { stations, jobs, advance } = fixture(t, () => ++calls <= 2 ? new Promise(() => {}) : Promise.resolve(reply(suggestion)));
    stations.saveAiConfig({ dailyLimit: 2 }); enqueue(stations);
    const id = stations.candidates()[0].id; stations.updateCandidate(id, { attempts: 2 });
    for (let i = 1; i <= 2; i++) {
      assert.equal(jobs.request().accepted, true); await new Promise(resolve => setImmediate(resolve));
      stations.saveAiConfig({ model: `replacement-${i}` }); await jobs.running;
      const candidate = stations.candidate(id);
      assert.equal(candidate.status, 'pending'); assert.equal(candidate.suggestion, null);
      assert.equal(candidate.attempts, 2 + i); assert.equal(candidate.cancelledAttempts, i);
      assert.equal(candidate.analysis.error.code, 'AI_CONFIG_CHANGED');
      assert.equal(stations.aiConfig().usageToday, i);
    }
    assert.equal(jobs.request().code, 'AI_DAILY_LIMIT'); assert.equal(calls, 2);
    advance(86400000); assert.equal(jobs.request().accepted, true); await jobs.running;
    assert.equal(calls, 3); assert.equal(stations.candidate(id).status, 'review');
    assert.equal(stations.candidate(id).attempts, 5); assert.equal(stations.aiConfig().usageToday, 1);
  });
  for (const status of ['approved', 'ignored']) await t.test(status, async t => {
    let finish;
    const { stations, jobs } = fixture(t, () => new Promise(resolve => { finish = resolve; }));
    enqueue(stations); const id = stations.candidates()[0].id; stations.updateCandidate(id, { attempts: 2 });
    jobs.request(); await new Promise(resolve => setImmediate(resolve));
    status === 'approved' ? stations.approveCandidate(id, {}) : stations.ignoreCandidate(id);
    stations.saveAiConfig({ model: 'replacement-model' }); await jobs.running;
    assert.equal(stations.candidate(id).status, status); assert.equal(jobs.request().code, 'AI_NO_PENDING');
    finish(reply(suggestion)); await new Promise(resolve => setImmediate(resolve));
    assert.equal(stations.candidate(id).status, status); assert.equal(stations.candidate(id).suggestion, null);
  });
});

test('disabling the automatic switch cancels automatic work while manual work continues', async t => {
  for (const automatic of [false, true]) await t.test(String(automatic), async t => {
    let finish, signal;
    const { stations, jobs } = fixture(t, request => { signal = request.signal; return new Promise(resolve => { finish = resolve; }); });
    enqueue(stations); automatic ? jobs.runDue() : jobs.request(); await new Promise(resolve => setImmediate(resolve));
    stations.saveAiConfig({ enabled: false });
    assert.equal(signal.aborted, automatic);
    if (!automatic) finish(reply(suggestion));
    await jobs.running;
    const candidate = stations.candidates()[0];
    assert.equal(candidate.status, automatic ? 'pending' : 'review');
    assert.equal(candidate.analysis.error?.code ?? null, automatic ? 'AI_AUTOMATIC_DISABLED' : null);
  });
});

test('AI calls are asynchronous, deduplicated, redacted and require human approval', async t => {
  let finish, outbound;
  const { stations, jobs } = fixture(t, request => { outbound = request; return new Promise(resolve => { finish = resolve; }); });
  enqueue(stations);
  const started = jobs.request(); assert.equal(started.accepted, true); assert.equal(started.running, true); assert.equal(started.code, 'AI_ACCEPTED');
  const repeated = jobs.request(); assert.equal(repeated.accepted, false); assert.equal(repeated.running, true); assert.equal(repeated.code, 'AI_RUNNING');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(outbound.headers.Authorization, 'Bearer test-key');
  assert.ok(!outbound.body.includes('13812345678'));
  assert.ok(!outbound.body.includes('7-6-7042'));
  const body = JSON.parse(outbound.body);
  assert.equal(body.response_format.type, 'json_object');
  assert.equal(body.tools, undefined);
  finish(reply(suggestion)); await jobs.running;
  assert.equal(stations.candidates()[0].status, 'review');
  assert.equal(stations.stations().length, 0);
  stations.approveCandidate(stations.candidates()[0].id, {});
  assert.equal(stations.stations()[0].aliases[0].subLocation, '2号柜');
});

test('a lone JSON code fence can carry a valid station suggestion', async t => {
  const { stations, jobs } = fixture(t, async () => replyContent('```json\r\n' + JSON.stringify(suggestion) + '\r\n```'));
  enqueue(stations); jobs.request(); await jobs.running;
  const [candidate] = stations.candidates();
  assert.equal(candidate.status, 'review');
  assert.equal(candidate.analysis.result.alias, suggestion.alias);
  assert.equal(candidate.analysis.error, null);
});

test('hallucinated ids, aliases, evidence, executable fields and tool calls are rejected', async t => {
  const fenced = '```json\n' + JSON.stringify(suggestion) + '\n```';
  const cases = [
    [reply({ ...suggestion, targetStationId: 'missing', suggestedName: '' }), 'CANDIDATE_NOT_FOUND', ['targetStationId']],
    [reply({ ...suggestion, alias: '模型编造的站名' }), 'EVIDENCE_NOT_IN_INPUT', ['alias']],
    [reply({ ...suggestion, evidence: ['输入中不存在的证据'] }), 'EVIDENCE_NOT_IN_INPUT', ['evidence']],
    [reply({ ...suggestion, suggestedName: 'https://evil.example.com' }), 'UNSAFE_TEXT', ['suggestedName']],
    [reply({ ...suggestion, script: 'curl https://evil.example.com' }), 'SCHEMA_FIELDS', []],
    [{ choices: [{ message: { content: fenced, tool_calls: [{ type: 'function' }] } }] }, 'SCHEMA_FIELDS', []],
    [replyContent('```json\n{}\n```'), 'ENUM_MISMATCH', ['kind']],
    [replyContent('说明\n' + fenced), 'JSON_PARSE', []],
    [replyContent(fenced + '\n' + fenced), 'JSON_PARSE', []],
    [replyContent('```json\n{invalid}\n```'), 'JSON_PARSE', []],
  ];
  for (let i = 0; i < cases.length; i++) await t.test(String(i), async t => {
    const [response, category, fields] = cases[i];
    const { stations, jobs } = fixture(t, async () => response); enqueue(stations); jobs.request(); await jobs.running;
    assert.equal(stations.candidates()[0].status, 'failed');
    assert.ok(stations.candidates()[0].error.includes('校验'));
    assert.equal(stations.candidates()[0].analysis.result, null);
    assert.equal(stations.candidates()[0].analysis.error.code, 'AI_INVALID_RESULT');
    assert.deepEqual(stations.candidates()[0].analysis.error.validationFailure, { category, fields });
    assert.equal(stations.stations().length, 0);
  });
});

test('unknown stays for manual review and home/hub classifications cannot create aliases', async t => {
  for (const kind of ['unknown', 'home', 'hub']) await t.test(kind, async t => {
    const { stations, jobs } = fixture(t, async () => reply({ kind, targetStationId: '', suggestedName: '', alias: '', subLocation: '', evidence: [] }));
    enqueue(stations); jobs.request(); await jobs.running;
    assert.equal(stations.candidates()[0].status, kind === 'unknown' ? 'unknown' : 'ignored');
    assert.equal(stations.stations().length, 0);
    if (kind !== 'unknown') assert.throws(() => stations.approveCandidate(stations.candidates()[0].id, {}), { code: 'CANDIDATE_CLOSED' });
  });
});

test('station validation diagnostics persist only fixed categories and field names', async t => {
  const providerEcho = 'synthetic-private-provider-body';
  const { stations, jobs } = fixture(t, async () => {
    throw Object.assign(new Error(providerEcho), { code: 'AI_INVALID_RESULT',
      validationFailure: { category: 'SCHEMA_FIELDS', fields: ['evidence', providerEcho], raw: providerEcho } });
  });
  enqueue(stations); jobs.request(); await jobs.running;
  const [candidate] = stations.candidates();
  assert.deepEqual(candidate.analysis.error.validationFailure, { category: 'SCHEMA_FIELDS', fields: ['evidence'] });
  assert.ok(!JSON.stringify(candidate).includes(providerEcho));
});

test('finite retries consume the daily budget and provider errors never persist secrets', async t => {
  let calls = 0;
  const { stations, jobs } = fixture(t, async () => { calls++; throw Object.assign(new Error('test-key echoed request'), { retryable: true }); });
  stations.saveAiConfig({ dailyLimit: 2 }); enqueue(stations); enqueue(stations, 'c2', '另一条包裹在4卡2号柜');
  jobs.request(); await jobs.running;
  assert.equal(calls, 2);
  assert.equal(stations.aiConfig().usageToday, 2);
  assert.equal(stations.candidates().filter(c => c.status === 'pending').length, 0);
  assert.equal(stations.candidates().filter(c => c.status === 'failed').length, 2);
  assert.ok(!JSON.stringify(stations.candidates()).includes('test-key'));
  assert.equal(jobs.request().code, 'AI_DAILY_LIMIT');
});

test('transient failures retry after the configured interval and stop after three total attempts', async t => {
  let calls = 0;
  const { stations, jobs, advance } = fixture(t, async () => { calls++; throw Object.assign(new Error('temporary'), { retryable: true }); });
  enqueue(stations); jobs.request(); await jobs.running;
  assert.equal(calls, 1);
  assert.equal(stations.candidates()[0].attempts, 1);
  assert.equal(stations.candidates()[0].retryAt, NOW + 360 * 60000);
  assert.equal(jobs.request().accepted, false);
  advance(360 * 60000); assert.equal(jobs.runDue().accepted, true); await jobs.running;
  assert.equal(calls, 2);
  advance(360 * 60000); assert.equal(jobs.runDue().accepted, true); await jobs.running;
  assert.equal(calls, 3);
  assert.equal(stations.candidates()[0].attempts, 3);
  assert.equal(stations.candidates()[0].retryAt, 0);
  advance(86400000); assert.equal(jobs.runDue().accepted, false);
});

test('scheduled empty queues and completed candidates make no calls; new evidence uses the event cooldown', async t => {
  let calls = 0;
  const { stations, jobs, advance } = fixture(t, async () => { calls++; return reply(suggestion); });
  assert.equal(jobs.runDue().accepted, false); assert.equal(calls, 0); assert.equal(stations.aiConfig().lastRunAt, 0);
  enqueue(stations); assert.equal(jobs.runDue().accepted, true); await jobs.running;
  assert.equal(calls, 1);
  enqueue(stations, 'c2', '另一条包裹在4卡2号柜'); assert.equal(jobs.runDue().accepted, false);
  advance(60000); assert.equal(jobs.runDue().accepted, true); await jobs.running;
  assert.equal(calls, 2);
  advance(86400000); assert.equal(stations.aiConfig().usageToday, 0); assert.equal(jobs.runDue().accepted, false);
});

test('connection testing sends a fixed privacy-free payload and uses the same daily budget', async t => {
  const outbound = [];
  const { stations, jobs } = fixture(t, async request => { outbound.push(request); const input = JSON.parse(JSON.parse(request.body).messages[1].content);
    return reply(input.expectedStation ? LOGISTICS_TEST_RESULT : input.fragment ? { kind: 'locker', suggestedName: '合成驿站', alias: input.fragment, subLocation: '2号柜', evidence: [input.fragment] }
      : { name: '合成模板', signature: '合成快递', keywords: ['取件码'], kind: 'pickup', rules: { code: { start: '取件码', end: '，' }, express: { start: '', end: '' }, address: { start: '已到', end: '，' } } }); });
  enqueue(stations); stations.saveAiConfig({ enabled: false });
  const result = await jobs.testConnection(); assert.equal(result.ok, true);
  assert.equal(result.capabilities.station_alias.ok, true); assert.equal(result.capabilities.sms_template.ok, true);
  assert.ok(outbound.every(request => !JSON.parse(request.body).messages[1].content.includes('4卡')));
  assert.equal(outbound.length, 3); assert.equal(result.capabilities.logistics_rule.ok, true);
  assert.equal(stations.aiConfig().usageToday, 3);
  assert.equal(stations.candidates()[0].status, 'pending');
  assert.equal(jobs.runDue().code, 'AI_AUTOMATIC_DISABLED');
});

test('close aborts active work promptly and never writes a late model response', async t => {
  let finish, signal;
  const { stations, jobs } = fixture(t, async request => { signal = request.signal; return new Promise(resolve => { finish = resolve; }); });
  enqueue(stations); jobs.request();
  await new Promise(resolve => setImmediate(resolve));
  await jobs.close();
  assert.equal(signal.aborted, true);
  finish(reply(suggestion));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stations.candidates()[0].status, 'pending');
  assert.equal(jobs.request().accepted, false);
});

test('public HTTPS endpoint validation blocks private, special, credentialed and redirected destinations', async () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.0.1', '100.64.0.1', '169.254.169.254', '198.18.0.1', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2002:7f00:1::', '2001:db8::1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(publicAddress(address), true, address);
  for (const url of ['http://api.example.com', 'https://localhost', 'https://host.local', 'https://2130706433', 'https://0x7f000001', 'https://127.1', 'https://[::1]', 'https://user:pass@api.example.com', 'https://api.example.com?token=x', 'https://api.example.com#x']) assert.throws(() => validateAiBaseUrl(url), { code: 'AI_ENDPOINT_BLOCKED' }, url);
  const endpoint = await resolveAiEndpoint('https://api.example.com/v1/', async () => [{ address: '1.1.1.1', family: 4 }]);
  assert.equal(endpoint.url.href, 'https://api.example.com/v1/chat/completions');
  assert.equal(endpoint.address, '1.1.1.1');
  await assert.rejects(resolveAiEndpoint('https://api.example.com', async () => [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }]), { code: 'AI_ENDPOINT_BLOCKED' });
  await assert.rejects(requestAiJson({ url: 'https://api.example.com', headers: {}, body: '{}', signal: new AbortController().signal }, async () => [{ address: '10.0.0.1', family: 4 }]), { code: 'AI_ENDPOINT_BLOCKED' });
});

test('HTTPS transport pins the validated DNS address, refuses redirects and limits response bytes', async () => {
  const resolver = async () => [{ address: '1.1.1.1', family: 4 }];
  const options = { url: 'https://api.example.com/v1', headers: { Authorization: 'Bearer SYNTHETIC' }, body: '{}', signal: new AbortController().signal };
  let calls = 0, captured;
  const requester = (statusCode, content) => (url, settings, callback) => {
    calls++; captured = { url, settings };
    const req = new EventEmitter(); req.setTimeout = () => req;
    req.end = () => { const response = Readable.from([Buffer.from(content)]); response.statusCode = statusCode; callback(response); };
    return req;
  };
  assert.deepEqual(await requestAiJson(options, resolver, requester(200, '{"ok":true}')), { ok: true });
  assert.equal(captured.url.hostname, 'api.example.com');
  assert.equal(captured.settings.agent, false);
  captured.settings.lookup('api.example.com', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '1.1.1.1'); assert.equal(family, 4); });
  captured.settings.lookup('api.example.com', { all: true }, (error, addresses) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '1.1.1.1', family: 4 }]); });
  await assert.rejects(requestAiJson(options, resolver, requester(302, '{"location":"https://127.0.0.1"}')), { code: 'AI_HTTP_ERROR' });
  assert.equal(calls, 2);
  await assert.rejects(requestAiJson(options, resolver, requester(200, ' '.repeat(65537))), { code: 'AI_RESPONSE_TOO_LARGE' });
});
