import { randomUUID } from 'node:crypto';
import { encryptCookie, decryptCookie, fail, hash, onlyKeys } from './security.mjs';
import { stationText, stationKey, redactStationFragment, nonPickupPlace, validateStationSuggestion } from './station-text.mjs';
import { validateAiBaseUrl } from './station-ai.mjs';
import { stationAutomationDecision, stationLocationConflict } from './station-automation.mjs';
import { stationSubLocation } from '../public/station-location.js';
import { AI_INTERVAL_MINUTES, AI_EVENT_COOLDOWN, aiDailyLimit } from './ai-policy.mjs';

const parse = row => row && JSON.parse(row.data);
const sources = ['manual', 'ai', 'sms', 'platform'];
const defaults = { channelId: '', defaultSelectionRevision: 0, channelName: '', baseUrl: '', model: '', enabled: false, autoApply: false, logisticsEnabled: false, intervalMinutes: AI_INTERVAL_MINUTES, dailyLimit: 20, lastRunAt: 0, lastEventAt: 0 };
const day = now => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);

export class StationStore {
  constructor({ db, key, now = Date.now, onRulesChanged }) {
    this.db = db; this.key = key; this.now = now; this.onRulesChanged = onRulesChanged;
    this.analysisListeners = new Set();
    this.aiConfigListeners = new Set();
    this.aiQueueListeners = new Set();
    this.stationRulesListeners = new Set();
    db.exec(`CREATE TABLE IF NOT EXISTS station_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO station_meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS station_catalog (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS station_candidates (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS station_candidate_receipts (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS station_ai_settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, credential TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_channels (id TEXT PRIMARY KEY, data TEXT NOT NULL, credential TEXT NOT NULL, credential_context TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS station_ai_usage (day TEXT PRIMARY KEY, calls INTEGER NOT NULL);`);
    const legacy = db.prepare('SELECT data,credential FROM station_ai_settings WHERE id=1').get(), config = parse(legacy);
    if (config && !Object.hasOwn(config, 'channelId')) {
      // Keep the legacy encrypted secret untouched and retain its authenticated context.
      const id = 'default', channel = { id, name: config.channelName || '默认渠道', baseUrl: config.baseUrl || '', model: config.model || '', enabled: true, jsonMode: true, revision: 1 };
      this.transaction(() => {
        db.prepare('INSERT OR IGNORE INTO ai_channels VALUES(?,?,?,?)').run(id, JSON.stringify(channel), legacy.credential, 'station-ai-key');
        db.prepare('UPDATE station_ai_settings SET data=? WHERE id=1').run(JSON.stringify({ ...config, channelId: id, defaultSelectionRevision: 1 }));
      });
    } else if (config && (!Number.isSafeInteger(config.defaultSelectionRevision) || config.defaultSelectionRevision < 0)) {
      db.prepare('UPDATE station_ai_settings SET data=? WHERE id=1').run(JSON.stringify({ ...config, defaultSelectionRevision: 0 }));
    }
    const saved = parse(db.prepare('SELECT data FROM station_ai_settings WHERE id=1').get());
    if (saved && (saved.intervalMinutes !== AI_INTERVAL_MINUTES || saved.dailyLimit !== aiDailyLimit(saved.dailyLimit))) {
      db.prepare('UPDATE station_ai_settings SET data=? WHERE id=1').run(JSON.stringify({ ...saved, intervalMinutes: AI_INTERVAL_MINUTES, dailyLimit: aiDailyLimit(saved.dailyLimit) }));
    }
  }
  transaction(fn) {
    const savepoint = `station_write_${this.transactionSequence = (this.transactionSequence || 0) + 1}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try { const result = fn(); this.db.exec(`RELEASE ${savepoint}`); return result; }
    catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw error; }
  }
  get revision() { return this.db.prepare('SELECT revision FROM station_meta WHERE id=1').get().revision; }
  bumpRevision() { this.db.exec('UPDATE station_meta SET revision=revision+1 WHERE id=1'); return this.revision; }
  stations() { return this.db.prepare('SELECT data FROM station_catalog ORDER BY rowid').all().map(parse); }
  station(id) { return parse(this.db.prepare('SELECT data FROM station_catalog WHERE id=?').get(id)); }
  stationRules() { return { revision: this.revision, stations: this.stations().filter(station => station.enabled) }; }
  saveStation(id, body) {
    onlyKeys(body, ['name', 'region', 'enabled', 'aliases']);
    if (id != null && !validId(id)) fail(400, 'INVALID_STATION', '站点ID无效');
    id ||= randomUUID();
    const old = this.station(id), name = stationText(body.name ?? old?.name, '站点名称'), region = stationText(body.region ?? old?.region ?? '', '地区', 80, false);
    if (nonPickupPlace(name) || redactStationFragment(name) !== name) fail(400, 'INVALID_STATION', '请输入不含敏感信息的取件站点');
    if (redactStationFragment(region) !== region) fail(400, 'INVALID_STATION', '地区不能包含联系方式、单号或取件码');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'INVALID_STATION', '启用状态无效');
    const rawAliases = body.aliases ?? old?.aliases ?? [];
    if (!Array.isArray(rawAliases) || rawAliases.length > 100) fail(400, 'INVALID_STATION', '每个站点最多100个别名');
    const aliasIds = new Set(), aliases = rawAliases.map(alias => {
      onlyKeys(alias, ['id', 'name', 'source', 'subLocation']);
      const aliasId = alias.id || randomUUID(), aliasName = stationText(alias.name, '别名'), subLocation = stationText(alias.subLocation ?? '', '柜号', 60, false);
      if (!validId(aliasId) || aliasIds.has(aliasId) || !sources.includes(alias.source ?? 'manual') || nonPickupPlace(aliasName) || nonPickupPlace(subLocation) || redactStationFragment(aliasName) !== aliasName || redactStationFragment(subLocation) !== subLocation) fail(400, 'INVALID_ALIAS', '别名格式无效或包含敏感信息');
      aliasIds.add(aliasId);
      return { id: aliasId, name: aliasName, source: alias.source ?? 'manual', subLocation };
    });
    const keys = aliases.map(alias => stationKey(alias.name));
    if (new Set(keys).size !== keys.length) fail(409, 'ALIAS_EXISTS', '同一别名不能重复');
    const others = this.stations().filter(s => s.id !== id);
    if (others.some(s => stationKey(s.name) === stationKey(name) && stationKey(s.region) === stationKey(region))) fail(409, 'STATION_EXISTS', '该地区已有同名站点');
    const ownedKeys = new Set([stationKey(name), ...keys].filter(Boolean));
    if ((body.enabled ?? old?.enabled ?? true) && others.some(s => s.enabled && [s.name, ...s.aliases.map(a => a.name)].some(value => ownedKeys.has(stationKey(value))))) fail(409, 'ALIAS_EXISTS', '名称或别名已属于其他启用站点');
    const saved = this.transaction(() => {
      const station = { id, name, region, enabled: body.enabled ?? old?.enabled ?? true, aliases, revision: this.revision + 1 };
      const all = [...others, station];
      if (all.length > 100 || all.reduce((sum, s) => sum + s.aliases.length, 0) > 1000 || Buffer.byteLength(JSON.stringify(all), 'utf8') > 100000) fail(400, 'STATION_LIMIT', '站点规则已达到容量上限，请先精简停用站点或别名');
      this.bumpRevision();
      this.db.prepare('INSERT INTO station_catalog VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, JSON.stringify(station));
      this.onRulesChanged?.(this.stationRules().stations);
      return station;
    });
    for (const listener of this.stationRulesListeners) { try { listener(); } catch { /* Rules remain authoritative when enrichment is unavailable. */ } }
    return saved;
  }
  candidates() { return this.db.prepare('SELECT data FROM station_candidates ORDER BY rowid DESC LIMIT 2000').all().map(parse); }
  candidate(id) { const value = parse(this.db.prepare('SELECT data FROM station_candidates WHERE id=?').get(id)); if (!value) fail(404, 'NOT_FOUND', '待核对片段不存在'); return value; }
  enqueue(items, { deviceId, source = 'sms', relationship } = {}) {
    if (!Array.isArray(items) || items.length > 20) fail(400, 'INVALID_CANDIDATES', '每次最多提交20条站点片段');
    if (!sources.includes(source) || deviceId !== undefined && !validId(deviceId)) fail(400, 'INVALID_CANDIDATES', '片段来源无效');
    const result = { accepted: 0, duplicates: 0, rejected: 0, acceptedIds: [], rejectedIds: [] };
    const received = this.transaction(() => {
      for (const item of items) {
        try {
          onlyKeys(item, ['id', 'stationName', 'fragment', 'source', 'region']);
          if (!validId(item.id) || (item.source !== undefined && item.source !== source)) fail(400, 'INVALID_FRAGMENT', '片段来源或ID无效');
          const fragment = redactStationFragment(item.fragment), stationName = redactStationFragment(item.stationName ?? ''), region = redactStationFragment(item.region ?? '');
          if (stationName.length > 120 || region.length > 80 || !fragment || !/[\p{L}]/u.test(fragment) || nonPickupPlace(fragment) || nonPickupPlace(stationName)) fail(400, 'INVALID_FRAGMENT', '片段不是取件站点');
          const fingerprint = hash(JSON.stringify([stationKey(stationName), stationKey(fragment), stationKey(region), ...(relationship ? [relationship] : [])]));
          const receipt = hash(JSON.stringify([source, deviceId || '', item.id]));
          if (this.db.prepare('SELECT id FROM station_candidate_receipts WHERE id=?').get(receipt)) { result.duplicates++; result.acceptedIds.push(item.id); continue; }
          const existing = parse(this.db.prepare('SELECT data FROM station_candidates WHERE fingerprint=?').get(fingerprint));
          if (existing) {
            this.updateCandidate(existing.id, { occurrences: Math.min(1000000, existing.occurrences + 1), updatedAt: this.now() }); result.duplicates++;
          } else {
            if (this.db.prepare('SELECT COUNT(*) AS count FROM station_candidates').get().count >= 2000) fail(429, 'STATION_QUEUE_FULL', '站点队列已满');
            const id = randomUUID(), candidate = { id, stationName, fragment, source, region, status: 'pending', eventPending: true, suggestion: null, evidence: [], occurrences: 1, attempts: 0, cancelledAttempts: 0, retryAt: 0, error: '', analysis: null, createdAt: this.now(), updatedAt: this.now(), ...(relationship ? { feedback: relationship } : {}) };
            this.db.prepare('INSERT INTO station_candidates VALUES(?,?,?)').run(id, fingerprint, JSON.stringify(candidate)); result.accepted++;
          }
          this.db.prepare('INSERT INTO station_candidate_receipts VALUES(?)').run(receipt);
          if (this.db.prepare('SELECT COUNT(*) AS count FROM station_candidate_receipts').get().count > 40000) this.db.exec('DELETE FROM station_candidate_receipts WHERE rowid IN (SELECT rowid FROM station_candidate_receipts ORDER BY rowid LIMIT 5000)');
          result.acceptedIds.push(item.id);
        } catch (error) {
          if (!error.status) throw error;
          result.rejected++; result.rejectedIds.push({ id: validId(item?.id) ? item.id : '', reason: error.code });
        }
      }
      return result;
    });
    if (received.accepted) for (const listener of this.aiQueueListeners) { try { listener(); } catch { /* Queue storage is independent of workers. */ } }
    return received;
  }
  updateCandidate(id, fields) {
    const candidate = { ...this.candidate(id), ...fields, updatedAt: this.now() };
    this.db.prepare('UPDATE station_candidates SET data=? WHERE id=?').run(JSON.stringify(candidate), id); return candidate;
  }
  onAnalysis(listener) {
    if (typeof listener !== 'function') throw new TypeError('analysis listener must be a function');
    this.analysisListeners.add(listener);
    return () => this.analysisListeners.delete(listener);
  }
  recordAnalysis(id, analysis) {
    if (Buffer.byteLength(JSON.stringify(analysis), 'utf8') > 24576) fail(400, 'AI_DETAIL_LIMIT', '分析详情超过大小限制');
    const old = this.candidate(id), candidate = { ...old, analysis, updatedAt: Math.max(this.now(), (old.updatedAt || 0) + 1) };
    this.db.prepare('UPDATE station_candidates SET data=? WHERE id=?').run(JSON.stringify(candidate), id);
    for (const listener of this.analysisListeners) listener(candidate);
    return candidate;
  }
  recordSuggestion(id, raw) {
    const candidate = this.candidate(id);
    if (candidate.status !== 'pending') return candidate;
    const suggestion = validateStationSuggestion(candidate, raw, this.stations());
    return this.updateCandidate(id, { suggestion, evidence: suggestion.evidence, status: ['home', 'hub'].includes(suggestion.kind) ? 'ignored' : suggestion.kind === 'unknown' ? 'unknown' : 'review', error: '',
      ...(candidate.feedback && !['pickup_station', 'locker'].includes(suggestion.kind) ? { automationReason: '当前站点别名分析无法优化此人工样本，请核对原因' } : {}) });
  }
  approveCandidate(id, body) {
    onlyKeys(body, ['stationId', 'alias', 'subLocation', 'name', 'region']);
    const candidate = this.candidate(id);
    if (!['pending', 'review', 'unknown', 'failed'].includes(candidate.status) || ['home', 'hub'].includes(candidate.suggestion?.kind)) fail(409, 'CANDIDATE_CLOSED', '该片段不能再次确认');
    const alias = stationText(body.alias ?? candidate.suggestion?.alias ?? candidate.stationName, '别名'), rawSubLocation = stationText(body.subLocation ?? candidate.suggestion?.subLocation ?? '', '柜号', 60, false);
    const subLocation = stationSubLocation(rawSubLocation);
    if ([candidate.fragment, candidate.stationName, alias, rawSubLocation].some(nonPickupPlace)) fail(400, 'INVALID_STATION', '中转、分拣、发货仓及住宅不是末端取件站点');
    if (!candidate.fragment.includes(alias) || [rawSubLocation, subLocation].some(value => value && !candidate.fragment.includes(value))) fail(400, 'INVALID_ALIAS', '确认的别名与柜号须来自片段');
    const stationId = body.stationId ?? candidate.suggestion?.targetStationId;
    let station = stationId ? this.station(stationId) : undefined;
    if (stationId && !station) fail(400, 'INVALID_STATION', '请选择有效站点');
    if (station && !station.enabled) fail(400, 'INVALID_STATION', '请先启用目标站点');
    const aliases = station?.aliases || [];
    const existing = aliases.find(a => stationKey(a.name) === stationKey(alias));
    if (existing && (stationLocationConflict(station.name, existing.name, existing.subLocation, rawSubLocation)
      || stationSubLocation(existing.subLocation || '') !== subLocation)) fail(409, 'ALIAS_EXISTS', '同名别名已有不同柜号，请在站点详情编辑');
    return this.transaction(() => {
      station = this.saveStation(station?.id, { name: station?.name || body.name || candidate.suggestion?.suggestedName || candidate.stationName, region: station?.region || body.region || candidate.region,
        enabled: true, aliases: existing ? aliases : [...aliases, { name: alias, subLocation, source: candidate.suggestion ? 'ai' : 'manual' }] });
      return { station, candidate: this.updateCandidate(id, { status: 'approved', stationId: station.id, approvedAlias: { name: alias, subLocation }, error: '' }) };
    });
  }
  autoApplyCandidate(id) {
    const config = this.aiConfig(), candidate = this.candidate(id);
    if (!config.enabled || !config.autoApply || candidate.status !== 'review') return candidate;
    const decision = stationAutomationDecision(candidate, this.stations());
    if (decision.reason) return this.updateCandidate(id, { automationReason: decision.reason });
    if (decision.alreadyKnown) return this.updateCandidate(id, { status: 'approved', stationId: decision.target.id, approvalMode: 'automatic', automationReason: '已有确认规则，无需重复修改' });
    try {
      return this.transaction(() => {
        const result = this.approveCandidate(id, {}), alias = result.station.aliases.find(value => stationKey(value.name) === stationKey(candidate.suggestion.alias));
        return this.updateCandidate(id, { approvalMode: 'automatic', automationReason: '', application: {
          stationId: result.station.id, alias, stationName: result.station.name, appliedAt: this.now(), revision: result.station.revision, rolledBackAt: 0,
        } });
      });
    } catch (error) {
      if (!error.status) throw error;
      return this.updateCandidate(id, { automationReason: '规则有冲突或容量不足，请核对后再应用' });
    }
  }
  autoApplyReviewed() {
    if (!this.aiConfig().enabled || !this.aiConfig().autoApply) return;
    for (const candidate of this.candidates()) if (candidate.status === 'review') this.autoApplyCandidate(candidate.id);
  }
  automationHistory() {
    return this.candidates().filter(candidate => candidate.application).map(candidate => {
      const application = candidate.application, station = this.station(application.stationId);
      const current = station?.aliases.find(alias => alias.id === application.alias.id);
      return { id: candidate.id, kind: 'station_alias', summary: `${application.stationName}：${application.alias.name}`,
        status: application.rolledBackAt ? 'rolled_back' : 'applied', appliedAt: application.appliedAt, rolledBackAt: application.rolledBackAt,
        canRollback: !application.rolledBackAt && !!current && JSON.stringify(current) === JSON.stringify(application.alias) };
    });
  }
  rollbackAutomaticAlias(id) {
    const candidate = this.candidate(id), application = candidate.application;
    if (!application || application.rolledBackAt) fail(409, 'AI_CHANGE_CLOSED', '该自动变更已回退或不存在');
    const station = this.station(application.stationId), current = station?.aliases.find(alias => alias.id === application.alias.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(application.alias)) fail(409, 'AI_CHANGE_CONFLICT', '别名已被人工修改，不能覆盖后续更改');
    return this.transaction(() => {
      this.saveStation(station.id, { aliases: station.aliases.filter(alias => alias.id !== current.id) });
      this.updateCandidate(id, { status: 'ignored', automationReason: '自动变更已回退', application: { ...application, rolledBackAt: this.now() } });
      return this.automationHistory().find(change => change.id === id);
    });
  }
  ignoreCandidate(id) {
    const candidate = this.candidate(id);
    if (candidate.status === 'approved') fail(409, 'CANDIDATE_CLOSED', '已确认片段不能忽略');
    return this.updateCandidate(id, { status: 'ignored', error: '' });
  }
  aiConfig() {
    const row = this.db.prepare('SELECT data,credential FROM station_ai_settings WHERE id=1').get(), config = { ...defaults, ...parse(row) };
    config.intervalMinutes = AI_INTERVAL_MINUTES; config.dailyLimit = aiDailyLimit(config.dailyLimit);
    const channel = this.aiChannel(config.channelId);
    const usageToday = this.db.prepare('SELECT calls FROM station_ai_usage WHERE day=?').get(day(this.now()))?.calls || 0;
    return { ...config, channelName: channel?.name || '', baseUrl: channel?.baseUrl || '', model: channel?.model || '', channelEnabled: !!channel?.enabled, jsonMode: channel?.jsonMode ?? true,
      hasApiKey: !!channel?.hasApiKey, apiKeyMasked: channel?.apiKeyMasked || '', usageToday, nextRunAt: config.lastRunAt ? config.lastRunAt + config.intervalMinutes * 60000 : 0,
      nextEventAt: config.lastEventAt ? config.lastEventAt + AI_EVENT_COOLDOWN : 0 };
  }
  saveAiConfig(body) {
    onlyKeys(body, ['channelId', 'channelName', 'baseUrl', 'model', 'apiKey', 'clearApiKey', 'enabled', 'autoApply', 'logisticsEnabled', 'intervalMinutes', 'dailyLimit', 'jsonMode']);
    const row = this.db.prepare('SELECT data,credential FROM station_ai_settings WHERE id=1').get(), old = { ...defaults, ...parse(row) };
    const config = { ...old, channelId: body.channelId ?? old.channelId,
      enabled: body.enabled ?? old.enabled, autoApply: body.autoApply ?? old.autoApply, logisticsEnabled: body.logisticsEnabled ?? old.logisticsEnabled,
      intervalMinutes: body.intervalMinutes ?? old.intervalMinutes, dailyLimit: body.dailyLimit === undefined ? old.dailyLimit : body.dailyLimit };
    if (typeof config.enabled !== 'boolean' || typeof config.autoApply !== 'boolean' || typeof config.logisticsEnabled !== 'boolean' || ![5, 60, 360, 1440].includes(config.intervalMinutes) || !Number.isSafeInteger(config.dailyLimit) || config.dailyLimit < 1 || typeof config.channelId !== 'string' || config.channelId && !validId(config.channelId)) fail(400, 'INVALID_AI_CONFIG', 'AI模式、频率或每日上限格式不正确');
    // Older administrators can still submit their saved frequency; the server policy is authoritative.
    config.intervalMinutes = AI_INTERVAL_MINUTES; config.dailyLimit = aiDailyLimit(config.dailyLimit);
    if (body.channelId !== undefined && !this.aiChannel(body.channelId)) fail(400, 'AI_CHANNEL_UNAVAILABLE', '请选择现有AI渠道');
    const fields = ['channelName', 'baseUrl', 'model', 'apiKey', 'clearApiKey', 'jsonMode'];
    const changesChannel = fields.some(key => Object.hasOwn(body, key));
    let prepared;
    if (changesChannel) {
      config.channelId ||= 'default';
      const patch = Object.fromEntries(fields.filter(key => Object.hasOwn(body, key)).map(key => [key === 'channelName' ? 'name' : key, body[key]]));
      prepared = this.prepareAiChannel(config.channelId, patch);
    }
    const channel = prepared ? { ...prepared.channel, hasApiKey: !!prepared.credential } : this.aiChannel(config.channelId);
    if (config.enabled && (!channel?.enabled || !channel.name || !channel.baseUrl || !channel.model || !channel.hasApiKey)) fail(400, 'AI_NOT_CONFIGURED', '请先配置并启用渠道、HTTPS地址、模型和API Key');
    if (old.channelId !== config.channelId) config.defaultSelectionRevision = old.defaultSelectionRevision + 1;
    this.transaction(() => {
      if (prepared) this.writeAiChannel(prepared);
      // Preserve the old row for rollback; registry credentials are authoritative.
      const credential = row?.credential || (body.apiKey ? encryptCookie(body.apiKey, this.key, 'station-ai-key') : '');
      this.db.prepare('INSERT INTO station_ai_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,credential=excluded.credential').run(JSON.stringify(config), credential);
    });
    this.notifyAiConfig({ credentialsChanged: old.channelId !== config.channelId || !!prepared?.changed, channelId: config.channelId });
    return this.aiConfig();
  }
  aiChannel(id) {
    const row = this.db.prepare('SELECT data,credential FROM ai_channels WHERE id=?').get(id || '');
    return row ? { ...parse(row), hasApiKey: !!row.credential, apiKeyMasked: row.credential ? '••••••••' : '' } : null;
  }
  aiChannels() { return this.db.prepare('SELECT id FROM ai_channels ORDER BY rowid').all().map(row => this.aiChannel(row.id)); }
  prepareAiChannel(id, body) {
    onlyKeys(body, ['name', 'baseUrl', 'model', 'apiKey', 'clearApiKey', 'enabled', 'jsonMode']);
    if (!validId(id)) fail(400, 'INVALID_AI_CONFIG', '渠道ID无效');
    const row = this.db.prepare('SELECT * FROM ai_channels WHERE id=?').get(id), old = parse(row);
    if (!row && this.aiChannels().length >= 10) fail(400, 'AI_CHANNEL_LIMIT', '最多保存10个AI渠道，请编辑或暂停已有渠道');
    const channel = { id, name: stationText(body.name ?? old?.name ?? '', '渠道名称', 80, false), baseUrl: body.baseUrl === undefined ? old?.baseUrl || '' : body.baseUrl === '' ? '' : validateAiBaseUrl(body.baseUrl),
      model: stationText(body.model ?? old?.model ?? '', '模型名称', 120, false), enabled: body.enabled ?? old?.enabled ?? true, jsonMode: body.jsonMode ?? old?.jsonMode ?? true, revision: (old?.revision || 0) + 1 };
    if (typeof channel.enabled !== 'boolean' || typeof channel.jsonMode !== 'boolean' || body.clearApiKey !== undefined && typeof body.clearApiKey !== 'boolean'
      || body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096 || /\s/u.test(body.apiKey))) fail(400, 'INVALID_AI_CONFIG', 'AI渠道设置格式不正确');
    let credential = row?.credential || '', context = row?.credential_context || `ai-channel:${id}`;
    if (body.apiKey) credential = encryptCookie(body.apiKey, this.key, context);
    if (body.clearApiKey) credential = '';
    const changed = !old || ['baseUrl', 'model', 'enabled', 'jsonMode'].some(key => channel[key] !== old[key]) || credential !== row.credential;
    if (!changed) channel.revision = old.revision;
    return { channel, credential, context, changed };
  }
  writeAiChannel({ channel, credential, context }) { this.db.prepare('INSERT INTO ai_channels VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,credential=excluded.credential,credential_context=excluded.credential_context').run(channel.id, JSON.stringify(channel), credential, context); }
  saveAiChannel(id, body) {
    if (id && !this.aiChannel(id)) fail(404, 'AI_CHANNEL_UNAVAILABLE', 'AI渠道不存在');
    const prepared = this.prepareAiChannel(id || randomUUID(), body), config = this.aiConfig();
    this.transaction(() => {
      this.writeAiChannel(prepared);
      if (!config.channelId) {
        const saved = parse(this.db.prepare('SELECT data FROM station_ai_settings WHERE id=1').get());
        this.db.prepare('INSERT INTO station_ai_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify({ ...defaults, ...saved, channelId: prepared.channel.id,
          defaultSelectionRevision: config.defaultSelectionRevision + 1 }), '');
      }
    });
    this.notifyAiConfig({ credentialsChanged: prepared.changed, channelId: prepared.channel.id });
    return this.aiChannel(prepared.channel.id);
  }
  aiChannelCredentials(id) {
    const row = this.db.prepare('SELECT * FROM ai_channels WHERE id=?').get(id || '');
    return row ? { ...this.aiChannel(id), apiKey: row.credential ? decryptCookie(row.credential, this.key, row.credential_context) : '' } : null;
  }
  notifyAiConfig(event) { for (const listener of this.aiConfigListeners) { try { listener(event); } catch { /* Configuration persists independently of workers. */ } } }
  onAiConfigChange(listener) { this.aiConfigListeners.add(listener); return () => this.aiConfigListeners.delete(listener); }
  onAiQueueChange(listener) { this.aiQueueListeners.add(listener); return () => this.aiQueueListeners.delete(listener); }
  onStationRulesChange(listener) { this.stationRulesListeners.add(listener); return () => this.stationRulesListeners.delete(listener); }
  aiCredentials() {
    const config = this.aiConfig();
    return { ...config, apiKey: this.aiChannelCredentials(config.channelId)?.apiKey || '' };
  }
  reserveAiCall() {
    const date = day(this.now());
    return this.transaction(() => {
      const config = this.aiConfig(); if (config.usageToday >= config.dailyLimit) return false;
      this.db.prepare('INSERT INTO station_ai_usage VALUES(?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1').run(date);
      this.db.prepare('DELETE FROM station_ai_usage WHERE day<?').run(day(this.now() - 32 * 86400000)); return true;
    });
  }
  markAiRun({ event = false } = {}) {
    const row = this.db.prepare('SELECT data FROM station_ai_settings WHERE id=1').get();
    if (row) this.db.prepare('UPDATE station_ai_settings SET data=? WHERE id=1').run(JSON.stringify({ ...parse(row), ...(!event ? { lastRunAt: this.now() } : {}), lastEventAt: this.now() }));
  }
}

export function enqueuePlatformCandidates(stations, snapshot, now = stations.now()) {
  const known = new Set(stations.stationRules().stations.flatMap(s => [s.name, ...s.aliases.map(a => a.name)]).map(stationKey));
  const items = (snapshot?.shipments || []).filter(s => (s.status === 'arrived' || s.status === 'signed' && globalThis.PickCodeLogistics.catalogPickupEvidence(s.logisticsEvents, stations.stationRules().stations).arrivalAt)
    && !s.picked && !s.pickupCompletion?.autoPicked && !s.hidden && !s.deleted && !s.archived
    && Number.isSafeInteger(s.arrivalAt) && s.arrivalAt > now - 45 * 86400000 && s.arrivalAt <= now
    && ['platform_event', 'locker'].includes(s.stationSource) && typeof s.station === 'string' && s.station.trim() && !nonPickupPlace(s.station) && !known.has(stationKey(s.station)))
    .map(s => ({ id: `platform-${hash(JSON.stringify([s.id, s.station, s.arrivalAt])).slice(0, 48)}`, stationName: s.station, fragment: s.station, source: 'platform' }));
  const result = { accepted: 0, duplicates: 0, rejected: 0 };
  for (let offset = 0; offset < items.length; offset += 20) {
    const batch = stations.enqueue(items.slice(offset, offset + 20), { source: 'platform' });
    for (const key of Object.keys(result)) result[key] += batch[key];
  }
  return result;
}

export function enqueueStationProposal(stations, body, deviceId) {
  onlyKeys(body, ['stationName', 'otherStationName', 'subLocation']);
  const stationName = redactStationFragment(stationText(body.stationName, '站名')), otherStationName = redactStationFragment(stationText(body.otherStationName, '另一站名'));
  const subLocation = redactStationFragment(stationText(body.subLocation ?? '', '柜号', 60, false));
  const owner = value => stations.stationRules().stations.filter(station => [station.name, ...station.aliases.map(alias => alias.name)].some(name => stationKey(name) && stationKey(name) === stationKey(value)));
  const first = owner(stationName), second = owner(otherStationName), target = first.length === 1 ? first[0] : second.length === 1 ? second[0] : null;
  const sourceStationName = first.length === 1 ? otherStationName : stationName;
  const relationship = { key: `proposal-${hash(JSON.stringify([stationName, otherStationName, subLocation]))}`, active: true, kind: 'station_correction',
    sourceStationName, otherStationName: first.length === 1 ? stationName : otherStationName, targetStationId: target?.id || '', subLocation, reason: 'user_confirmed',
    verified: !!target && !(first.length && second.length && first[0].id !== second[0].id) };
  const fragment = [sourceStationName, subLocation && !sourceStationName.includes(subLocation) ? subLocation : ''].filter(Boolean).join('，');
  return stations.enqueue([{ id: relationship.key, stationName: sourceStationName, fragment, source: 'manual' }], { deviceId, source: 'manual', relationship });
}
