import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { encryptCookie, decryptCookie, hash, secret, fail, text, onlyKeys } from './security.mjs';
import { serverVersion, capabilities } from './version.mjs';
import { corroborateTaobaoEventTimes, doorstepEvidence, genericPickupStation, pickupCycleReset, pickupEvidence, eventStatus, providerEventFields, mergeProviderEventFields, logisticsEventTimeIssue, logisticsTimePrecision } from './collector-enrichment.mjs';
import { PickupCompletionStore } from './pickup-completion-store.mjs';
import { effectivePicked, pickupCompletionState } from './pickup-completion.mjs';
import { normalizeRetentionFields, orderRetention, retainedSignedShipment, validRetentionDate } from './order-retention.mjs';
import { cookieIdentity } from './cookie-sync.mjs';
import { COLLECTION_COOLDOWN, scheduledSyncAt } from './collection-schedule.mjs';
import { jdShipmentStatus, retainMilestoneEvents, shippingEvidence } from './shipment-lifecycle.mjs';
import { normalizeProductImageUrl } from './product-image.mjs';

export const stableId = (...values) => hash(JSON.stringify(values)).slice(0, 32);
const parse = row => row && JSON.parse(row.data);
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : 0;
const shortText = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const waybillKey = value => String(value || '').normalize('NFKC').replace(/\s+/gu, '').toUpperCase();
function logisticsData(input, old = {}, reuseEvents = false, rules, now) {
  const checkedAt = validTime(input.logisticsCheckedAt);
  if (checkedAt && checkedAt < (old.logisticsCheckedAt || 0)) return logisticsData({}, old, false, rules, now);
  const supplied = Array.isArray(input.logisticsEvents) ? input.logisticsEvents : [];
  const datedTaobao = new Map();
  for (const event of supplied) {
    if (event?.provider !== 'taobao' || !validTime(event.time) || event.time > now || !event.timeText) continue;
    const key = JSON.stringify([event.timeText, event.description, event.location || '']), prior = datedTaobao.get(key);
    datedTaobao.set(key, prior === undefined ? event : prior && prior.time === event.time ? prior : null);
  }
  const seen = new Map();
  const events = reuseEvents ? old.logisticsEvents || [] : [...supplied, ...(old.logisticsEvents || [])].filter(e => e && typeof e === 'object').map(e => ({
    time: validTime(e.time), timeText: shortText(e.timeText, 100), description: shortText(e.description, 600), location: shortText(e.location, 120),
    ...(['second', 'minute', 'unknown'].includes(e.timePrecision) ? { timePrecision: e.timePrecision } : {}), ...providerEventFields(e)
  })).filter(e => {
    // A corroborated Taobao stage replaces its exact legacy undated copy, including pre-provider records.
    const dated = !e.time && datedTaobao.get(JSON.stringify([e.timeText, e.description, e.location]));
    if (dated && Object.entries(providerEventFields(e)).every(([key, value]) => dated[key] === value)) return false;
    const key = JSON.stringify([e.time, e.time ? '' : e.timeText, e.description, e.location, logisticsEventTimeIssue(e, now) === 'timeConflict']);
    if (!e.description) return false;
    const matches = seen.get(key) || [];
    if (matches.some(prior => mergeProviderEventFields(prior, e))) return false;
    matches.push(e); seen.set(key, matches); return true;
  }).sort((a, b) => b.time - a.time);
  const state = ['ok', 'empty', 'error', 'unavailable'].includes(input.logisticsState) ? input.logisticsState : old.logisticsState || '';
  return { logisticsEvents: retainMilestoneEvents(events, rules, now), logisticsState: state,
    logisticsError: input.logisticsState ? shortText(input.logisticsError, 200) || ({ error: '物流查询未完成，已保留原轨迹', unavailable: '平台未返回该运单轨迹', empty: '平台本次未返回物流轨迹' }[state] || '') : old.logisticsError || '',
    logisticsCheckedAt: Math.max(checkedAt, old.logisticsCheckedAt || 0),
    logisticsDetailCheckedAt: Math.max(validTime(input.logisticsDetailCheckedAt), old.logisticsDetailCheckedAt || 0),
    logisticsUpdatedAt: Math.max(old.logisticsUpdatedAt || 0, !reuseEvents && state === 'ok' && supplied.some(e => e?.description) ? validTime(input.logisticsUpdatedAt) || checkedAt : 0),
    logisticsTruncated: !!(input.logisticsTruncated || old.logisticsTruncated || events.length > 100) };
}
function pickupData(input = {}, old = {}, events = [], rules, now = Date.now(), platform) {
  if (input.logisticsCheckedAt && input.logisticsCheckedAt < (old.logisticsCheckedAt || 0)) return pickupData({}, old, [], rules, now, platform);
  if (input.arrivalAtSource === 'platform_event' && events.some(event => event.time === input.arrivalAt && logisticsEventTimeIssue(event, now) === 'timeConflict')) return pickupData({}, old, [], rules, now, platform);
  const source = value => ['platform_event', 'locker_arrival', 'locker_created'].includes(value) ? value : 'unknown';
  const precision = value => ['second', 'minute'].includes(value) ? value : 'unknown';
  const inputArrival = validTime(input.arrivalAt) && input.arrivalAt <= now ? input.arrivalAt : 0;
  const explicitArrival = inputArrival && source(input.arrivalAtSource) !== 'unknown';
  const arrivalAt = explicitArrival ? inputArrival : validTime(old.arrivalAt) || inputArrival;
  const station = explicitArrival && Object.hasOwn(input, 'stationSource') ? shortText(input.station, 300)
    : shortText(input.station, 300) || shortText(old.station, 300);
  let result = { arrivalAt, arrivalAtSource: arrivalAt ? source(explicitArrival ? input.arrivalAtSource : old.arrivalAtSource) : 'unknown',
    arrivalAtPrecision: arrivalAt ? precision(explicitArrival ? input.arrivalAtPrecision : old.arrivalAtPrecision) : 'unknown', station,
    stationSource: station ? ['platform_event', 'locker'].includes(input.stationSource) && input.station ? input.stationSource
      : station === old.station && ['platform_event', 'locker'].includes(old.stationSource) ? old.stationSource : 'unknown' : 'unknown' };
  const doorstep = doorstepEvidence(events, { platform, carrier: input.carrier || old.carrier }, now);
  const pickup = pickupEvidence(events.map(event => logisticsEventTimeIssue(event, now) === 'timeConflict' ? { ...event, time: 0 } : event), rules);
  const evidence = doorstep.arrivalAt > pickup.arrivalAt ? doorstep : pickup;
  const reset = events.some(event => pickupCycleReset(event.description || '') && (!event.time || event.time <= now) && (!event.time || !arrivalAt || event.time >= arrivalAt));
  const newCycle = events.some(event => pickupCycleReset(event.description || '') && (!event.time || event.time <= now) && (!event.time || event.time >= validTime(old.arrivalAt)));
  const stationConflict = input.station && old.station && ['platform_event', 'locker'].includes(input.stationSource)
    && input.station.replace(/[\s\p{P}]/gu, '') !== old.station.replace(/[\s\p{P}]/gu, '');
  if (evidence.arrivalAt && (!explicitArrival || evidence.arrivalAt >= arrivalAt)) {
    const keepSpecificStation = !newCycle && station && !genericPickupStation(station) && genericPickupStation(evidence.station);
    const useEvidenceStation = evidence.station && !keepSpecificStation;
    result = { ...evidence, station: useEvidenceStation ? evidence.station : newCycle || evidence === doorstep ? '' : station,
      stationSource: useEvidenceStation ? evidence.stationSource : newCycle || evidence === doorstep ? 'unknown' : result.stationSource };
  }
  else if (reset || (!explicitArrival && stationConflict)) result = evidence;
  else if (rules && input.logisticsState === 'ok' && input.logisticsEvents?.length && !explicitArrival
    && Object.hasOwn(input, 'arrivalAt') && old.arrivalAtSource === 'platform_event' && !input.logisticsTruncated && !old.logisticsTruncated
    && !events.some(event => logisticsEventTimeIssue(event, now) === 'timeConflict')) {
    // A successful refreshed track supersedes previous template evidence. Structured locker evidence remains valid.
    result = evidence;
  }
  // Legacy cache timestamps and station names carry no provenance on their own.
  return result;
}
const genericCarrier = value => /^(?:快递|物流|快递公司|物流公司|其他|其它|其他快递|其它快递|未知|未知快递|未知物流|UNKNOWN|OTHER|EXPRESS)$/iu.test(String(value || '').normalize('NFKC').trim());
// Older PDD imports stored cabinet.companyName pickup operators in the carrier field.
const pddCabinetCarrier = (value, platform) => platform === 'pdd' && /(?:代收点|快递超市|驿站|快递柜|自提柜)$/u.test(String(value || '').normalize('NFKC').trim());
const carrierKey = value => {
  if (genericCarrier(value)) return '';
  const name = String(value || '').normalize('NFKC').toUpperCase().replace(/[\s._-]+/gu, '');
  for (const [pattern, key] of [[/中通|^ZTO(?:EXPRESS)?$/, 'ZTO'], [/圆通|^YTO(?:EXPRESS)?$/, 'YTO'],
    [/申通|^STO(?:EXPRESS)?$/, 'STO'], [/顺丰|^SF(?:EXPRESS)?$/, 'SF'], [/韵达|^YUNDA(?:EXPRESS)?$/, 'YUNDA'],
    [/极兔|^JT(?:S?D)?(?:EXPRESS)?$/, 'JTSD'], [/邮政快递包裹|^YZPY$/, 'YZPY'], [/^EMS$/, 'EMS'],
    [/邮政/, 'EMS'], [/京东|^JD(?:EXPRESS)?$/, 'JD'], [/百世|^HTKY(?:EXPRESS)?$/, 'HTKY']]) if (pattern.test(name)) return key;
  return name;
};

const platformPackageKey = input => String(input?.platformPackageKey || input?.platformPackageId || input?.packageKey || input?.packageId || '').trim();
const identifierSource = input => shortText(input?.identifierSource || input?.source || 'import', 80) || 'import';
const cycleReset = (events, current, now) => {
  const start = validTime(current?.startedAt);
  return (events || []).filter(event => pickupCycleReset(event?.description || '') && validTime(event?.time) > start && validTime(event?.time) <= validTime(now))
    .sort((a, b) => validTime(b.time) - validTime(a.time))[0] || null;
};
const pickupCycleData = (shipmentId, input, old, events, now) => {
  const existing = old?.pickupCycle && typeof old.pickupCycle === 'object' ? old.pickupCycle : null;
  const history = Array.isArray(old?.pickupCycleHistory) ? old.pickupCycleHistory.filter(item => item && typeof item === 'object') : [];
  const latestEvidenceAt = (events || []).reduce((latest, event) => Math.max(latest, validTime(event?.time)), 0);
  const initialStartedAt = validTime(old?.arrivalAt) || validTime(input?.arrivalAt) || validTime(old?.logisticsCheckedAt)
    || latestEvidenceAt || validTime(old?.updatedAt) || validTime(now) || 1;
  const current = existing && existing.id ? { id: String(existing.id), startedAt: validTime(existing.startedAt) || initialStartedAt,
    evidenceKey: shortText(existing.evidenceKey, 300) || 'initial', status: existing.status === 'closed' ? 'closed' : 'active' } :
    { id: stableId(shipmentId, 'pickup-cycle', 'initial'), startedAt: initialStartedAt, evidenceKey: 'initial', status: 'active' };
  // A legacy record gets one deterministic initial cycle; only later imports may rotate it.
  const reset = existing ? cycleReset(events, current, now) : null;
  if (!reset) return { pickupCycle: current, pickupCycleHistory: history, cycleChanged: false };
  const evidenceKey = `${validTime(reset.time)}:${shortText(reset.description, 300)}`;
  if (current.evidenceKey === evidenceKey) return { pickupCycle: current, pickupCycleHistory: history, cycleChanged: false };
  const previous = { ...current, status: 'closed', pickupCompletion: old?.pickupCompletion || null, picked: !!old?.picked,
    pickupManualAt: validTime(old?.pickupManualAt), pickupManualOperation: shortText(old?.pickupManualOperation, 200), pickupManualAction: old?.pickupManualAction || '', pickupConfirmedAt: validTime(old?.pickupConfirmedAt),
    shippedAt: validTime(old?.shippedAt), shippedAtSource: old?.shippedAtSource || 'unknown', shippedAtPrecision: old?.shippedAtPrecision || 'unknown',
    arrivalAt: validTime(old?.arrivalAt), arrivalAtSource: old?.arrivalAtSource || 'unknown', arrivalAtPrecision: old?.arrivalAtPrecision || 'unknown' };
  const next = { id: stableId(shipmentId, 'pickup-cycle', evidenceKey), startedAt: validTime(reset.time), evidenceKey, status: 'active' };
  const seen = new Set(history.map(item => item.id));
  return { pickupCycle: next, pickupCycleHistory: seen.has(previous.id) ? history : [...history, previous].slice(-20), cycleChanged: true };
};

export class Store {
  constructor({ filename = ':memory:', key, now = Date.now, getLogisticsRules }) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.key = key;
    this.now = now;
    this.getLogisticsRules = getLogisticsRules;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta VALUES(1,0);
      CREATE TABLE IF NOT EXISTS families (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL, credential TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL, account_ids TEXT NOT NULL, created_at INTEGER NOT NULL, revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS pairing (code_hash TEXT PRIMARY KEY, account_ids TEXT NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shipments (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS order_natural_keys (account_id TEXT NOT NULL REFERENCES accounts(id), platform TEXT NOT NULL, platform_order_id TEXT NOT NULL, order_id TEXT NOT NULL REFERENCES orders(id), PRIMARY KEY(account_id,platform,platform_order_id));
      CREATE TABLE IF NOT EXISTS shipment_identifiers (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL REFERENCES accounts(id), platform TEXT NOT NULL, shipment_id TEXT NOT NULL REFERENCES shipments(id), order_id TEXT NOT NULL REFERENCES orders(id), platform_package_key TEXT NOT NULL DEFAULT '', carrier_raw TEXT NOT NULL DEFAULT '', carrier_key TEXT NOT NULL DEFAULT '', waybill_raw TEXT NOT NULL DEFAULT '', waybill_key TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS shipment_identifiers_platform_package_idx ON shipment_identifiers(account_id,platform,platform_package_key);
      CREATE INDEX IF NOT EXISTS shipment_identifiers_waybill_idx ON shipment_identifiers(account_id,order_id,carrier_key,waybill_key);
      CREATE TABLE IF NOT EXISTS shipment_aliases (old_shipment_id TEXT PRIMARY KEY, target_shipment_id TEXT NOT NULL REFERENCES shipments(id), account_id TEXT NOT NULL REFERENCES accounts(id), platform TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', evidence TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, CHECK(old_shipment_id <> target_shipment_id));
      CREATE TABLE IF NOT EXISTS operations (device_id TEXT NOT NULL REFERENCES devices(id), id TEXT NOT NULL, payload_hash TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(device_id,id));`);
    this.transaction(() => {
      for (const table of ['devices', 'pairing']) {
        if (!this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'family_ids')) {
          this.db.exec(`ALTER TABLE ${table} ADD COLUMN family_ids TEXT NOT NULL DEFAULT '[]'`);
        }
      }
      for (const column of ['source_cycle_id', 'target_cycle_id']) {
        if (!this.db.prepare('PRAGMA table_info(shipment_aliases)').all().some(item => item.name === column)) {
          this.db.exec(`ALTER TABLE shipment_aliases ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
        }
      }
      this.migrateIdentityState();
      for (const account of this.accounts()) if (account.collectionScheduleVersion !== 1) {
        this.updateAccount(account.id, { collectionScheduleVersion: 1, intervalMinutes: 15, lastFullSuccessAt: 0,
          nextSyncAt: scheduledSyncAt(account.platform, Math.max(this.now(), (account.lastAttemptAt || 0) + COLLECTION_COOLDOWN)) });
      }
    });
    new PickupCompletionStore({ store: this, now });
  }
  close() { this.db.close(); }
  transaction(fn) {
    const savepoint = this.db.isTransaction ? `store_${this.transactionSequence = (this.transactionSequence || 0) + 1}` : '';
    this.db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT'); return result; }
    catch (e) { this.db.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK'); throw e; }
  }
  migrateIdentityState() {
    let changed = false;
    for (const row of this.db.prepare('SELECT data FROM orders').all()) {
      const order = parse(row), account = this.account(order.accountId);
      if (!account || !order.platformOrderId) continue;
      const result = this.db.prepare('INSERT OR IGNORE INTO order_natural_keys(account_id,platform,platform_order_id,order_id) VALUES(?,?,?,?)')
        .run(order.accountId, account.platform, String(order.platformOrderId), order.id);
      changed ||= !!result.changes;
    }
    for (const row of this.db.prepare('SELECT data FROM shipments').all()) {
      const shipment = parse(row), account = this.account(shipment.accountId);
      if (!account) continue;
      const { cycleChanged, ...cycle } = pickupCycleData(shipment.id, {}, shipment, shipment.logisticsEvents || [], this.now());
      if (JSON.stringify(cycle.pickupCycle) !== JSON.stringify(shipment.pickupCycle) || JSON.stringify(cycle.pickupCycleHistory) !== JSON.stringify(shipment.pickupCycleHistory)) {
        Object.assign(shipment, cycle);
        this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(shipment), shipment.id);
        changed = true;
      }
      if (!this.db.prepare('SELECT 1 FROM shipment_identifiers WHERE shipment_id=? LIMIT 1').get(shipment.id)) {
        const identifierChanged = this.saveShipmentIdentifier(shipment, account.platform, { source: 'legacy' }, this.now());
        changed = changed || identifierChanged;
      }
    }
    if (this.reconcileDuplicateShipments()) changed = true;
    if (changed) this.revision();
  }
  reconcileDuplicateShipments(accountId = '') {
    const rows = (accountId ? this.db.prepare('SELECT data FROM shipments WHERE account_id=?').all(accountId)
      : this.db.prepare('SELECT data FROM shipments').all()).map(parse).filter(shipment => this.shipmentAlias(shipment.id).id === shipment.id);
    const accounts = new Map(this.accounts().map(account => [account.id, account]));
    const knownCarriers = new Set(['ZTO', 'YTO', 'STO', 'SF', 'YUNDA', 'JTSD', 'YZPY', 'EMS', 'JD', 'HTKY']);
    const waybillGroups = new Map(), groups = [];
    for (const shipment of rows) {
      const carrier = carrierKey(shipment.carrier), waybill = waybillKey(shipment.waybillNo), account = accounts.get(shipment.accountId);
      if (!account || !shipment.orderId || pddCabinetCarrier(shipment.carrier, account.platform) || carrier && !knownCarriers.has(carrier) || !waybill) continue;
      const key = JSON.stringify([shipment.accountId, account.platform, shipment.orderId, waybill]);
      if (!waybillGroups.has(key)) waybillGroups.set(key, []);
      waybillGroups.get(key).push(shipment);
    }
    for (const members of waybillGroups.values()) {
      const carriers = new Set(members.map(shipment => carrierKey(shipment.carrier)).filter(Boolean));
      if (carriers.size === 1) groups.push(members);
      else for (const carrier of carriers) groups.push(members.filter(shipment => carrierKey(shipment.carrier) === carrier));
    }
    const identifiers = this.db.prepare('SELECT shipment_id,platform_package_key FROM shipment_identifiers').all();
    const operated = new Set(this.db.prepare('SELECT data FROM operations').all().map(parse).map(operation => operation.shipmentId).filter(Boolean));
    const confirmedTargets = new Set(this.db.prepare('SELECT target_shipment_id FROM shipment_aliases').all().map(alias => alias.target_shipment_id));
    const location = value => String(value || '').normalize('NFKC').replace(/[\s\p{P}]/gu, '');
    const observedAt = shipment => Math.max(validTime(shipment.logisticsCheckedAt), ...(shipment.logisticsEvents || [])
      .map(event => validTime(event.time)).filter(at => at <= this.now()), 0);
    let changed = 0;
    for (const members of groups) {
      if (members.length < 2) continue;
      // Only repair unused legacy duplicates. Explicit decisions, distinct platform boxes,
      // a later delivery cycle or conflicting pickup locations require a separate review.
      if (members.some(shipment => shipment.picked || shipment.hidden || shipment.deleted || shipment.manualAt || shipment.pickupManualAt
        || shipment.pickupManualOperation || shipment.pickupCompletion?.manualOverride || operated.has(shipment.id) || confirmedTargets.has(shipment.id)
        || shipment.pickupCycleHistory?.length || shipment.pickupCycle?.evidenceKey !== 'initial')) continue;
      const ids = new Set(members.map(shipment => shipment.id));
      const packageKeys = new Set(identifiers.filter(item => ids.has(item.shipment_id)).map(item => item.platform_package_key).filter(Boolean));
      const codes = new Set(members.map(shipment => String(shipment.pickupCode || '').trim()).filter(Boolean));
      const stations = new Set(members.map(shipment => location(shipment.station)).filter(Boolean));
      if (packageKeys.size > 1 || codes.size > 1 || stations.size > 1 || new Set(members.map(shipment => shipment.familyId || '')).size > 1) continue;
      const sorted = members.slice().sort((left, right) => observedAt(right) - observedAt(left) || left.id.localeCompare(right.id));
      const target = sorted[0], newest = observedAt(target);
      const sameObservation = shipment => JSON.stringify([shipment.status, String(shipment.pickupCode || '').trim(), location(shipment.station)]);
      if (sorted.some(shipment => observedAt(shipment) === newest && sameObservation(shipment) !== sameObservation(target))) continue;
      const account = accounts.get(target.accountId);
      for (const old of sorted.slice(1)) {
        this.db.prepare(`INSERT INTO shipment_aliases(old_shipment_id,target_shipment_id,account_id,platform,reason,evidence,created_at,source_cycle_id,target_cycle_id) VALUES(?,?,?,?,?,?,?,?,?)`)
          .run(old.id, target.id, target.accountId, account.platform, 'normalized_legacy_identity',
            'Same account, order and normalized waybill with one specific carrier; no conflicting package or manual decision', this.now(), old.pickupCycle.id, target.pickupCycle.id);
        changed++;
      }
    }
    return changed;
  }
  saveShipmentIdentifier(shipment, platform, input = {}, at = this.now()) {
    const packageKey = platformPackageKey(input) || platformPackageKey(shipment);
    const carrierRaw = String(input.carrier || shipment.carrier || '');
    const waybillRaw = String(input.waybillNo || shipment.waybillNo || '');
    const carrier = carrierKey(carrierRaw), waybill = waybillKey(waybillRaw);
    if (!packageKey && !waybill) return false;
    const source = identifierSource(input);
    const existing = this.db.prepare(`SELECT id FROM shipment_identifiers WHERE shipment_id=? AND platform=? AND platform_package_key=? AND carrier_key=? AND waybill_key=? LIMIT 1`)
      .get(shipment.id, platform, packageKey, carrier, waybill);
    if (existing) {
      this.db.prepare(`UPDATE shipment_identifiers SET carrier_raw=?,waybill_raw=?,source=?,updated_at=? WHERE id=?`)
        .run(carrierRaw, waybillRaw, source, at, existing.id);
      return false;
    } else {
      this.db.prepare(`INSERT INTO shipment_identifiers(account_id,platform,shipment_id,order_id,platform_package_key,carrier_raw,carrier_key,waybill_raw,waybill_key,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(shipment.accountId, platform, shipment.id, shipment.orderId, packageKey, carrierRaw, carrier, waybillRaw, waybill, source, at, at);
      return true;
    }
  }
  shipmentAlias(id, max = 20) {
    let current = String(id || ''), seen = new Set(), alias = null;
    for (let i = 0; i < max; i++) {
      if (seen.has(current)) fail(500, 'ALIAS_CYCLE', '包裹历史别名存在循环');
      seen.add(current);
      const row = this.db.prepare('SELECT * FROM shipment_aliases WHERE old_shipment_id=?').get(current);
      if (!row) return { id: current, alias };
      alias ||= row;
      current = row.target_shipment_id;
    }
    fail(500, 'ALIAS_CYCLE', '包裹历史别名层级过深');
  }
  saveShipmentAlias(oldId, targetId, { reason = '', evidence = '' } = {}) {
    if (!shortText(reason, 300) && !shortText(evidence, 2000)) fail(400, 'INVALID_ALIAS', '包裹别名必须提供确认依据');
    const existingAlias = this.db.prepare('SELECT old_shipment_id FROM shipment_aliases WHERE old_shipment_id=?').get(String(oldId));
    if (existingAlias) fail(409, 'INVALID_ALIAS', '包裹别名已经确认，不能重复改写');
    const old = this.shipment(String(oldId));
    const target = this.shipment(String(targetId));
    if (!old || !target || old.accountId !== target.accountId || old.orderId !== target.orderId) fail(400, 'INVALID_ALIAS', '包裹别名必须属于同一账号和订单');
    if (old.picked || target.picked || old.pickupCompletion?.manualOverride || target.pickupCompletion?.manualOverride) fail(409, 'INVALID_ALIAS', '已有领取决定的包裹不能建立别名');
    const account = this.account(target.accountId);
    if (!account || this.shipmentAlias(target.id).id !== target.id) fail(409, 'INVALID_ALIAS', '包裹别名不能形成循环');
    const sourceCycleId = old.pickupCycle?.id || '', targetCycleId = target.pickupCycle?.id || '';
    return this.transaction(() => {
      this.db.prepare(`INSERT INTO shipment_aliases(old_shipment_id,target_shipment_id,account_id,platform,reason,evidence,created_at,source_cycle_id,target_cycle_id) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(old_shipment_id) DO UPDATE SET target_shipment_id=excluded.target_shipment_id,reason=excluded.reason,evidence=excluded.evidence,source_cycle_id=excluded.source_cycle_id,target_cycle_id=excluded.target_cycle_id`)
        .run(old.id, target.id, target.accountId, account.platform, shortText(reason, 300), shortText(evidence, 2000), this.now(), sourceCycleId, targetCycleId);
      this.revision();
      return { oldShipmentId: old.id, targetShipmentId: target.id };
    });
  }
  operationShipmentResolution(device, originalId) {
    const resolved = this.shipmentAlias(originalId);
    const shipment = this.shipment(resolved.id);
    if (!shipment) fail(resolved.alias ? 409 : 403, resolved.alias ? 'UNRESOLVED_TARGET' : 'SCOPE_FORBIDDEN', resolved.alias ? '包裹目标已无法解析，请重新同步后重试' : '运单不在授权范围内');
    const alias = resolved.alias;
    if (alias && (alias.account_id !== shipment.accountId || !this.canRead(device, shipment))) fail(403, 'SCOPE_FORBIDDEN', '运单不在授权范围内');
    if (!this.canRead(device, shipment)) fail(403, 'SCOPE_FORBIDDEN', '运单不在授权范围内');
    return { shipment, alias: resolved.alias };
  }
  operationShipment(device, originalId) { return this.operationShipmentResolution(device, originalId).shipment; }
  revision() {
    this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
    return this.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision;
  }
  refreshLogisticsRules(rules = this.getLogisticsRules?.()) {
    const savepoint = `logistics_projection_${this.projectionSequence = (this.projectionSequence || 0) + 1}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      let changed = 0;
      for (const row of this.db.prepare('SELECT data FROM shipments').all()) {
        const old = parse(row), events = old.logisticsEvents || [];
        if (!events.length || old.stationSource === 'locker' || ['locker_arrival', 'locker_created'].includes(old.arrivalAtSource)) continue;
        if (events.some(event => logisticsEventTimeIssue(event, this.now()) === 'timeConflict')) continue;
        const platform = this.account(old.accountId)?.platform;
        const doorstep = doorstepEvidence(events, { platform, carrier: old.carrier }, this.now());
        const station = pickupEvidence(events, rules);
        const evidence = doorstep.arrivalAt > station.arrivalAt ? doorstep : station;
        const pickup = evidence.arrivalAt ? pickupData({ logisticsState: 'ok', logisticsEvents: events, arrivalAt: 0 }, old, events, rules, this.now(), platform) : evidence;
        const fallback = old.status === 'arrived' && old.arrivalAtSource === 'platform_event' ? 'unknown' : old.status;
        const status = platform === 'jd' ? jdShipmentStatus(events, fallback, rules, this.now(), fallback === 'arrived' && !!old.pickupCode)
          : eventStatus(events[0].description, fallback, rules);
        if (status === old.status && Object.keys(pickup).every(key => pickup[key] === old[key])) continue;
        const updated = this.pickupCompletion.project({ ...old, ...pickup, status, updatedAt: this.now() });
        this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(updated), old.id);
        changed++;
      }
      if (changed) this.revision();
      this.db.exec(`RELEASE ${savepoint}`);
      return { changed };
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw error; }
  }
  refreshStationRecognition(catalog, shipmentIds) {
    const logistics = globalThis.PickCodeLogistics, rules = this.getLogisticsRules?.();
    const savepoint = `station_projection_${this.projectionSequence = (this.projectionSequence || 0) + 1}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      let changed = 0;
      const orders = shipmentIds ? null : new Map(this.db.prepare('SELECT data FROM orders').all().map(parse).map(order => [order.id, order]));
      const selected = shipmentIds ? shipmentIds.map(id => this.db.prepare('SELECT data FROM shipments WHERE id=?').get(id)).filter(Boolean)
        : this.db.prepare('SELECT data FROM shipments').all();
      for (const row of selected) {
        const old = parse(row), order = orders ? orders.get(old.orderId) : this.order(old.orderId), account = this.account(old.accountId);
        if (!account?.enabled || this.shipmentAlias(old.id).id !== old.id || !order || orderRetention(order, this.now()).archived || order.hidden || order.deleted
          || old.picked || old.pickupCompletion?.autoPicked || effectivePicked(pickupCompletionState(old)) || old.hidden || old.deleted
          || !old.logisticsEvents?.length || old.stationSource === 'locker') continue;
        if (old.logisticsEvents.some(event => logisticsEventTimeIssue(event, this.now()) === 'timeConflict')) continue;
        const trustedArrival = validTime(old.arrivalAt) && ['platform_event', 'locker_arrival'].includes(old.arrivalAtSource);
        const knownStation = logistics.catalogStation(old.station, catalog).id;
        if (knownStation && trustedArrival) continue;
        let evidence = logistics.catalogPickupEvidence(old.logisticsEvents, catalog, rules);
        if (!evidence.arrivalAt && !trustedArrival) evidence = pickupEvidence(old.logisticsEvents, rules, true);
        if (!evidence.arrivalAt || evidence.arrivalAt > this.now() || !evidence.station && !old.station) continue;
        const updated = { ...old, ...evidence, status: 'arrived', updatedAt: this.now() };
        if (knownStation || !evidence.station) for (const key of ['station', 'stationSource']) updated[key] = old[key];
        if (trustedArrival) for (const key of ['arrivalAt', 'arrivalAtSource', 'arrivalAtPrecision']) updated[key] = old[key];
        if (['status', 'station', 'stationSource', 'arrivalAt', 'arrivalAtSource', 'arrivalAtPrecision'].every(key => updated[key] === old[key])) continue;
        this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(updated), old.id);
        changed++;
      }
      if (changed) this.revision();
      this.db.exec(`RELEASE ${savepoint}`);
      return { changed };
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}`); this.db.exec(`RELEASE ${savepoint}`); throw error; }
  }
  family(id) { return this.db.prepare('SELECT id,name FROM families WHERE id=?').get(id); }
  families(ids) {
    const allowed = ids && new Set(ids);
    return this.db.prepare('SELECT id,name FROM families ORDER BY rowid').all().filter(family => !allowed || allowed.has(family.id));
  }
  saveFamily(body, id = randomUUID()) {
    onlyKeys(body, ['name']);
    const name = text(body.name, '家人姓名', 80);
    if (this.families().some(family => family.id !== id && family.name === name)) fail(409, 'FAMILY_NAME_EXISTS', '家人姓名已存在');
    this.db.prepare('INSERT INTO families(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(id, name);
    this.revision();
    return this.family(id);
  }
  accountFamily(account) {
    if (!account) return account;
    const familyId = account.familyId || '';
    return { ...account, familyId, familyName: this.family(familyId)?.name || '' };
  }
  account(id) { return this.accountFamily(parse(this.db.prepare('SELECT data FROM accounts WHERE id=?').get(id))); }
  order(id) { return parse(this.db.prepare('SELECT data FROM orders WHERE id=?').get(id)); }
  shipment(id) { return parse(this.db.prepare('SELECT data FROM shipments WHERE id=?').get(id)); }
  accounts(ids) {
    const allowed = ids && new Set(ids);
    return this.db.prepare('SELECT data FROM accounts ORDER BY id').all().map(parse).filter(a => !allowed || allowed.has(a.id)).map(a => this.accountFamily(a));
  }
  saveAccount(body, id = randomUUID(), fixture = false, { preserveSyncSchedule = false, inTransaction = false } = {}) {
    if (inTransaction && !this.db.isTransaction) throw new Error('saveAccount requires an active transaction');
    onlyKeys(body, ['platform', 'label', 'cookie', 'enabled', 'intervalMinutes', 'familyId']);
    const old = this.account(id);
    const familyId = body.familyId === undefined ? old?.familyId || '' : text(body.familyId, '家人ID', 128, false);
    if (familyId && !this.family(familyId)) fail(400, 'INVALID_FAMILY', '请选择有效家人，待归属请留空');
    const platform = body.platform ?? old?.platform;
    if (!['taobao', 'pdd', 'jd'].includes(platform) || (old && platform !== old.platform)) fail(400, 'INVALID_PLATFORM', '平台必须是淘宝、拼多多或京东，创建后不可改变');
    const intervalMinutes = body.intervalMinutes ?? old?.intervalMinutes ?? 15;
    if (![15, 30, 60].includes(intervalMinutes)) fail(400, 'INVALID_INTERVAL', '同步间隔仅支持15、30或60分钟');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'INVALID_INPUT', 'enabled 必须是布尔值');
    const label = text(body.label ?? old?.label, '账号名称', 80);
    let credential = this.db.prepare('SELECT credential FROM accounts WHERE id=?').get(id)?.credential;
    if (body.cookie !== undefined || !old) {
      const cookie = text(body.cookie, 'Cookie', 16384);
      if (/\r|\n/.test(cookie)) fail(400, 'INVALID_COOKIE', 'Cookie 不得包含换行');
      if (!fixture && platform === 'pdd' && (!/(?:^|;\s*)PDDAccessToken=/.test(cookie) || !/(?:^|;\s*)(?:pdd_user_id|pdduid)=/.test(cookie))) fail(400, 'INVALID_COOKIE', '缺少拼多多登录字段');
      if (!fixture && platform === 'jd' && !/(?:^|;\s*)(?:thor|light_key)=[^;\s]+/.test(cookie)) fail(400, 'INVALID_COOKIE', '缺少京东网页版登录字段，请从订单页复制完整 Cookie');
      credential = encryptCookie(cookie, this.key, id);
    }
    const data = { id, platform, label, familyId, familyName: this.family(familyId)?.name || '',
      familyAssigned: !!(familyId || old?.familyAssigned || old?.familyId), enabled: body.enabled ?? old?.enabled ?? true, intervalMinutes,
      status: body.cookie !== undefined || !old ? 'configured' : old.status, lastSuccessAt: old?.lastSuccessAt || 0,
      collectionScheduleVersion: 1, lastFullSuccessAt: old?.lastFullSuccessAt || 0,
      lastAttemptAt: body.cookie !== undefined && !preserveSyncSchedule ? 0 : old?.lastAttemptAt || 0,
      nextSyncAt: !old || (body.cookie !== undefined && !preserveSyncSchedule) || intervalMinutes !== old.intervalMinutes
        ? scheduledSyncAt(platform, this.now(), intervalMinutes) : old.nextSyncAt,
      error: body.cookie !== undefined ? '' : old?.error || '', revision: this.revision(), fixture,
      // Ownership changes also invalidate results collected under the previous scope.
      credentialVersion: (old?.credentialVersion || 0) + (body.cookie !== undefined || !old || familyId !== old.familyId ? 1 : 0),
      warnings: old?.warnings || [] };
    const save = () => {
      this.db.prepare('INSERT INTO accounts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,credential=excluded.credential').run(id, JSON.stringify(data), credential);
      if (old && !old.familyId && !old.familyAssigned && familyId) {
        for (const table of ['orders', 'shipments']) {
          for (const row of this.db.prepare(`SELECT data FROM ${table} WHERE account_id=?`).all(id)) {
            const record = parse(row);
            if (record.familyId) continue;
            Object.assign(record, { familyId, familyName: data.familyName });
            this.db.prepare(`UPDATE ${table} SET data=? WHERE id=?`).run(JSON.stringify(record), record.id);
          }
        }
      }
    };
    if (inTransaction) save(); else this.transaction(save);
    return data;
  }
  cookie(id) {
    const row = this.db.prepare('SELECT credential FROM accounts WHERE id=?').get(id);
    return row && decryptCookie(row.credential, this.key, id);
  }
  refreshCookie(id, cookie) {
    const account = this.account(id);
    let identity;
    try { identity = cookieIdentity(account.platform, this.cookie(id), false); }
    catch (error) { if (error.code !== 'COOKIE_IDENTITY_REQUIRED') throw error; }
    // Legacy manual credentials may lack an identity; rotations must preserve any known identity.
    if (identity) {
      let nextIdentity;
      try { nextIdentity = cookieIdentity(account.platform, cookie); } catch { /* Reject incomplete rotations below. */ }
      if (nextIdentity !== identity) fail(409, 'ACCOUNT_EXPIRED', '平台登录信息已失效，请重新同步登录信息');
    }
    this.db.prepare('UPDATE accounts SET credential=? WHERE id=?').run(encryptCookie(cookie, this.key, id), id);
  }
  updateAccount(id, fields) {
    const account = this.account(id);
    if (!account) fail(404, 'NOT_FOUND', '账号不存在');
    const updated = { ...account, ...fields, revision: this.revision() };
    this.db.prepare('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify(updated), id);
    return updated;
  }
  validateIds(ids, lookup, allowEmpty = false) {
    if (!Array.isArray(ids) || (!allowEmpty && !ids.length) || ids.length > 100 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id || !lookup(id))) fail(400, 'INVALID_SCOPE', '请选择有效的家人或账号范围');
    return [...ids];
  }
  scope(familyIds = [], legacyAccountIds = []) {
    const familySet = new Set(familyIds);
    const accountIds = [...new Set([...legacyAccountIds, ...this.accounts().filter(a => a.familyId && familySet.has(a.familyId)).map(a => a.id)])];
    return { familyIds, legacyAccountIds, accountIds };
  }
  canRead(device, record) {
    if (!record) return false;
    const legacy = device.legacyAccountIds ?? (device.familyIds === undefined ? device.accountIds || [] : []);
    return legacy.includes(record.accountId) || !!record.familyId && (device.familyIds || []).includes(record.familyId);
  }
  canFilterAccount(device, id) {
    return device.accountIds.includes(id) || this.db.prepare('SELECT data FROM orders WHERE account_id=?').all(id).map(parse).some(order => this.canRead(device, order));
  }
  scopeSummary(scope) {
    const accounts = this.accounts(scope.accountIds).map(({ id, platform, label, familyId, familyName }) => ({ id, platform, label, familyId, familyName }));
    return { familyIds: scope.familyIds, legacyAccountIds: scope.legacyAccountIds, families: this.families(scope.familyIds).map(family => ({ ...family, accountCount: accounts.filter(a => a.familyId === family.id).length })),
      accountIds: scope.accountIds, accounts, includeFutureAccounts: scope.familyIds.length > 0 };
  }
  createPairing(input) {
    const body = Array.isArray(input) ? { accountIds: input } : input;
    onlyKeys(body, ['familyIds', 'accountIds']);
    if ((body.familyIds !== undefined) === (body.accountIds !== undefined)) fail(400, 'INVALID_SCOPE', '请选择家人整组授权或旧版账号授权');
    const familyIds = body.familyIds === undefined ? [] : this.validateIds(body.familyIds, id => this.family(id));
    const accountIds = body.accountIds === undefined ? [] : this.validateIds(body.accountIds, id => this.account(id));
    const code = hash(secret()).slice(0, 16).toUpperCase();
    const expiresAt = this.now() + 10 * 60000;
    this.db.prepare('DELETE FROM pairing WHERE expires_at<? OR used_at IS NOT NULL').run(this.now());
    this.db.prepare('INSERT INTO pairing(code_hash,account_ids,expires_at,used_at,family_ids) VALUES(?,?,?,NULL,?)').run(hash(code), JSON.stringify(accountIds), expiresAt, JSON.stringify(familyIds));
    return { code, expiresAt, ...this.scopeSummary(this.scope(familyIds, accountIds)) };
  }
  pairing(code) {
    code = text(code, '绑定码', 80).toUpperCase();
    const pair = this.db.prepare('SELECT * FROM pairing WHERE code_hash=?').get(hash(code));
    if (!pair || pair.used_at !== null || pair.expires_at <= this.now()) fail(400, 'INVALID_PAIRING_CODE', '绑定码无效、已使用或已过期');
    return pair;
  }
  previewPairing(code) {
    const pair = this.pairing(code);
    return { scope: this.scopeSummary(this.scope(JSON.parse(pair.family_ids), JSON.parse(pair.account_ids))), expiresAt: pair.expires_at };
  }
  redeem(code, deviceName) {
    code = text(code, '绑定码', 80).toUpperCase();
    deviceName = text(deviceName, '设备名称', 80);
    return this.transaction(() => {
      const pair = this.pairing(code);
      const token = `pcd_${secret()}`;
      const deviceId = randomUUID();
      this.db.prepare('UPDATE pairing SET used_at=? WHERE code_hash=?').run(this.now(), hash(code));
      this.db.prepare('INSERT INTO devices(id,token_hash,name,account_ids,created_at,revoked_at,family_ids) VALUES(?,?,?,?,?,NULL,?)').run(deviceId, hash(token), deviceName, pair.account_ids, this.now(), pair.family_ids);
      const scope = this.scope(JSON.parse(pair.family_ids), JSON.parse(pair.account_ids));
      return { token, deviceId, ...this.scopeSummary(scope), accounts: this.accounts(scope.accountIds), serverTime: this.now() };
    });
  }
  device(token) {
    const row = this.db.prepare('SELECT * FROM devices WHERE token_hash=? AND revoked_at IS NULL').get(hash(token));
    if (!row) fail(401, 'DEVICE_UNAUTHORIZED', '设备授权无效，请重新绑定');
    return { id: row.id, ...this.scope(JSON.parse(row.family_ids), JSON.parse(row.account_ids)) };
  }
  devices() {
    return this.db.prepare('SELECT id,name,account_ids,family_ids,created_at,revoked_at FROM devices ORDER BY created_at DESC').all()
      .map(row => ({ id: row.id, name: row.name, ...this.scope(JSON.parse(row.family_ids), JSON.parse(row.account_ids)), createdAt: row.created_at, revokedAt: row.revoked_at }));
  }
  updateDevice(id, body) {
    onlyKeys(body, ['familyIds', 'accountIds']);
    const row = this.db.prepare('SELECT * FROM devices WHERE id=?').get(id);
    if (!row) fail(404, 'NOT_FOUND', '设备不存在');
    if (row.revoked_at !== null) fail(409, 'DEVICE_REVOKED', '已撤销设备不能重新授权');
    const familyIds = body.familyIds === undefined ? JSON.parse(row.family_ids) : this.validateIds(body.familyIds, familyId => this.family(familyId), true);
    const accountIds = body.accountIds === undefined ? JSON.parse(row.account_ids) : this.validateIds(body.accountIds, accountId => this.account(accountId), true);
    this.db.prepare('UPDATE devices SET family_ids=?,account_ids=? WHERE id=?').run(JSON.stringify(familyIds), JSON.stringify(accountIds), id);
    this.revision();
    return this.devices().find(device => device.id === id);
  }
  revoke(id) {
    const result = this.db.prepare('UPDATE devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.now(), id);
    if (!result.changes && !this.db.prepare('SELECT id FROM devices WHERE id=?').get(id)) fail(404, 'NOT_FOUND', '设备不存在');
    return { revoked: true };
  }
  importResult(accountId, result, { partial = false, reconcile = true } = {}) {
    const rules = result.logisticsRules ?? this.getLogisticsRules?.();
    const completionRules = this.pickupCompletion.rules(), completionConfig = this.pickupCompletion.config();
    const parserKey = hash(JSON.stringify(['shipment-lifecycle-v5', rules, completionRules, completionConfig]));
    const changedShipmentIds = [];
    const account = this.account(accountId);
    if (!account) fail(404, 'NOT_FOUND', '账号不存在');
    this.transaction(() => {
      const orderIds = new Map();
      const identityWarnings = [];
      if (reconcile) this.reconcileDuplicateShipments(accountId);
      const admittedIds = new Set(result.orders.map(input => String(input.platformOrderId)));
      for (const input of [...(result.orderUpdates || []), ...result.orders]) {
        const platformOrderId = String(input.platformOrderId);
        const id = stableId(accountId, account.platform, 'order', platformOrderId);
        orderIds.set(platformOrderId, id);
        const old = parse(this.db.prepare('SELECT data FROM orders WHERE id=?').get(id));
        // Filtered orders may refresh existing history, but must not create new shopping records.
        if (!old && !admittedIds.has(platformOrderId)) continue;
        const inputDate = validTime(input.orderDate) <= this.now() + 300000 ? validTime(input.orderDate) : 0;
        const verifiedDate = old?.orderDateSource === 'platform' && old.orderDate > 0;
        const checkedAt = validTime(input.dateCheckedAt) <= this.now() + 300000 ? validTime(input.dateCheckedAt) : 0;
        const incomingDetail = input.orderDateOrigin === 'detail';
        const replaceDate = !!inputDate && (!verifiedDate || (incomingDetail && (old?.orderDateOrigin !== 'detail' || checkedAt >= (old?.dateCheckedAt || 0))));
        const datePrecision = value => ['second', 'minute', 'day'].includes(value) ? value : 'unknown';
        const refreshPrecision = replaceDate || inputDate && inputDate === old?.orderDate && datePrecision(old?.orderDatePrecision) === 'unknown';
        const order = { ...old, id, accountId, platform: account.platform, platformOrderId,
          familyId: old ? old.familyId || '' : account.familyId, familyName: old ? old.familyName || '' : account.familyName,
          title: String(input.title || old?.title || ''), amount: input.amount == null ? old?.amount ?? null : input.amount,
          imageUrl: normalizeProductImageUrl(input.imageUrl) || normalizeProductImageUrl(old?.imageUrl),
          orderDate: replaceDate ? inputDate : old?.orderDate || 0,
          orderDatePrecision: refreshPrecision ? datePrecision(input.orderDatePrecision) : datePrecision(old?.orderDatePrecision),
          orderDateSource: replaceDate || verifiedDate ? 'platform' : old?.orderDate ? 'legacy' : 'unknown',
          orderDateOrigin: replaceDate ? incomingDetail ? 'detail' : 'list' : old?.orderDateOrigin || (verifiedDate ? 'list' : ''),
          dateCheckedAt: Math.max(old?.dateCheckedAt || 0, checkedAt),
          dateState: checkedAt >= (old?.dateCheckedAt || 0) && ['ok', 'empty', 'error', 'unavailable'].includes(input.dateState) ? input.dateState : old?.dateState || (inputDate ? 'ok' : 'unknown'),
          dateError: checkedAt >= (old?.dateCheckedAt || 0) && input.dateState ? shortText(input.dateError, 200) : old?.dateError || '',
          dateOverride: old?.dateOverride ?? null, dateOverrideAt: old?.dateOverrideAt || 0,
          firstSeenAt: old?.firstSeenAt || this.now(), tradeStatus: input.tradeStatus || old?.tradeStatus || '',
          orderStatus: input.orderStatus || old?.orderStatus || '',
          refundStatus: input.refundStatus || old?.refundStatus || '' };
        this.db.prepare('INSERT INTO orders VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, accountId, JSON.stringify(order));
        this.db.prepare('INSERT OR REPLACE INTO order_natural_keys(account_id,platform,platform_order_id,order_id) VALUES(?,?,?,?)')
          .run(accountId, account.platform, platformOrderId, id);
      }
      for (const input of result.shipments) {
        if (!input.waybillNo) continue;
        const orderId = orderIds.get(String(input.platformOrderId)) || stableId(accountId, account.platform, 'order', String(input.platformOrderId));
        const order = this.order(orderId);
        if (!order) continue;
        // Order + carrier + waybill keeps every split parcel and prevents cross-account collisions.
        const carrier = pddCabinetCarrier(input.carrier, account.platform) ? '' : carrierKey(input.carrier);
        const waybill = waybillKey(input.waybillNo);
        const packageKey = platformPackageKey(input);
        const indexed = packageKey ? [...new Set(this.db.prepare('SELECT shipment_id FROM shipment_identifiers WHERE account_id=? AND platform=? AND order_id=? AND platform_package_key=?')
          .all(accountId, account.platform, orderId, packageKey).map(row => this.shipmentAlias(row.shipment_id).id))] : [];
        if (indexed.length > 1) {
          identityWarnings.push('多个包裹候选使用相同平台包裹键，未自动新增包裹，请核对');
          continue;
        }
        const observedWaybill = this.db.prepare("SELECT data FROM shipments WHERE account_id=? AND json_extract(data,'$.orderId')=?").all(accountId, orderId).map(parse)
          .filter(s => waybillKey(s.waybillNo) === waybill);
        const observedIds = new Set(observedWaybill.map(s => this.shipmentAlias(s.id).id));
        const packageIdentifiers = this.db.prepare('SELECT shipment_id,platform_package_key FROM shipment_identifiers WHERE account_id=? AND order_id=? AND platform_package_key<>?')
          .all(accountId, orderId, '').map(row => ({ id: this.shipmentAlias(row.shipment_id).id, key: row.platform_package_key })).filter(row => observedIds.has(row.id));
        if (!packageKey && observedIds.size > 1 && new Set(packageIdentifiers.map(row => row.key)).size > 1) {
          identityWarnings.push('同号运单属于多个平台分包，本次缺少包裹键，未自动更新包裹');
          continue;
        }
        const sameWaybill = observedWaybill.filter(s => {
          if (!packageKey || indexed.length) return true;
          const keys = packageIdentifiers.filter(row => row.id === this.shipmentAlias(s.id).id).map(row => row.key);
          return !keys.length || keys.includes(packageKey);
        });
        // Prefer one exact carrier or one previously unknown carrier. Multiple candidates are
        // ambiguous: do not manufacture another shipment while trying to resolve the identity.
        const sameWaybillIds = new Set(sameWaybill.map(candidate => this.shipmentAlias(candidate.id).id));
        const exact = carrier ? sameWaybill.filter(s => s.carrier && !pddCabinetCarrier(s.carrier, account.platform) && carrierKey(s.carrier) === carrier) : [];
        const unknown = sameWaybill.filter(s => !carrierKey(s.carrier) || sameWaybillIds.size === 1 && pddCabinetCarrier(s.carrier, account.platform));
        const genericCandidate = (genericCarrier(input.carrier) || pddCabinetCarrier(input.carrier, account.platform))
          && sameWaybillIds.size === 1;
        if (!indexed.length && !carrier && !unknown.length && sameWaybill.length && !genericCandidate) {
          identityWarnings.push('承运商未知且已有其他承运商同号包裹，未自动新增包裹，请核对');
          continue;
        }
        const previous = indexed.length === 1 ? [{ id: this.shipmentAlias(indexed[0]).id }] : carrier ? (exact.length ? exact : unknown) : genericCandidate ? sameWaybill : unknown;
        const canonicalIds = [...new Set(previous.map(candidate => this.shipmentAlias(candidate.id).id))];
        if (canonicalIds.length > 1 || (sameWaybillIds.size > 1 && !canonicalIds.length)) {
          identityWarnings.push('多个包裹候选使用相同规范运单，未自动新增包裹，请核对承运商');
          continue;
        }
        const canonicalCandidates = canonicalIds.map(candidateId => this.shipment(candidateId)).filter(candidate => candidate
          && candidate.accountId === accountId && candidate.orderId === orderId);
        if (canonicalIds.length > 1 || canonicalCandidates.length !== canonicalIds.length) {
          identityWarnings.push('包裹历史别名解析后存在多个或越权候选，未自动新增包裹，请核对');
          continue;
        }
        const id = canonicalIds.length === 1 ? canonicalIds[0] : packageKey && observedWaybill.length && !sameWaybill.length
          ? stableId(accountId, account.platform, orderId, carrier, waybill, 'package', packageKey) : stableId(accountId, account.platform, orderId, carrier, waybill);
        const old = parse(this.db.prepare('SELECT data FROM shipments WHERE id=?').get(id));
        const { logisticsCheckedAt, logisticsDetailCheckedAt, logisticsUpdatedAt, updatedAt, ...evidence } = input;
        const logisticsEvidenceHash = hash(JSON.stringify([parserKey, evidence]));
        // Identical evidence needs only a query timestamp; preserve manual decisions and avoid rerunning parsers/AI.
        if (old?.logisticsEvidenceHash === logisticsEvidenceHash
          && !(input.logisticsEvents || []).some(event => validTime(event.time) > (old.logisticsCheckedAt || 0))) {
          const updated = { ...old, ...logisticsData(input, old, true, rules, this.now()) };
          if (JSON.stringify(updated) !== JSON.stringify(old)) this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(updated), id);
          continue;
        }
        const inputCheckedAt = validTime(input.logisticsCheckedAt), oldCheckedAt = validTime(old?.logisticsCheckedAt);
        const trustedEvent = Array.isArray(input.logisticsEvents) && input.logisticsEvents.some(event => validTime(event?.time) > oldCheckedAt);
        const hasPersistedLogistics = oldCheckedAt > 0 || validTime(old?.arrivalAt) > 0 || (old?.logisticsEvents || []).length > 0;
        const staleLogistics = !!old && ((inputCheckedAt > 0 && oldCheckedAt > 0 && inputCheckedAt < oldCheckedAt)
          || (inputCheckedAt === 0 && hasPersistedLogistics && !trustedEvent));
        const status = ['transit', 'arrived', 'signed', 'unknown'].includes(input.status) ? input.status : 'unknown';
        // Merged PC records can carry H5 provider fields; their complete, consistent timestamp still dates old SSR prose.
        const datedOld = !staleLogistics && account.platform === 'taobao' && input.logisticsState === 'ok' && old ? { ...old,
          logisticsEvents: corroborateTaobaoEventTimes(old.logisticsEvents || [], (input.logisticsEvents || []).filter(event =>
            (!event.provider || event.provider === 'taobao') && logisticsTimePrecision(event.timeText) !== 'unknown' && !logisticsEventTimeIssue(event, this.now())), this.now(),
            { allowLegacy: true, notBefore: order.orderDateOrigin === 'detail' ? order.orderDate || 0 : 0 }) } : old;
        const logistics = staleLogistics ? logisticsData({}, old, false, rules, this.now()) : logisticsData(input, datedOld, false, rules, this.now());
        const pickup = staleLogistics ? pickupData({}, old || {}, old?.logisticsEvents || [], rules, this.now(), account.platform) : pickupData(input, old || {}, logistics.logisticsEvents, rules, this.now(), account.platform);
        const cycleState = staleLogistics ? pickupCycleData(id, input, old || {}, old?.logisticsEvents || [], this.now())
          : pickupCycleData(id, input, old || {}, logistics.logisticsEvents, this.now());
        const { cycleChanged, ...cycle } = cycleState;
        const shipping = shippingEvidence(logistics.logisticsEvents, cycleChanged ? {} : old || {}, this.now(), cycle.pickupCycle, account.platform);
        const projectedStatus = account.platform !== 'jd' || ['arrived', 'signed'].includes(status) ? status
          : status === 'unknown' && ['arrived', 'signed'].includes(old?.status) ? old.status
            : jdShipmentStatus(logistics.logisticsEvents, old?.status || status, rules, this.now());
        let shipment = { id, orderId, accountId, familyId: old ? old.familyId || '' : order.familyId || '',
          familyName: old ? old.familyName || '' : order.familyName || '', waybillNo: old?.waybillNo || String(input.waybillNo), carrier: carrier ? input.carrier : old?.carrier || input.carrier || '', status: staleLogistics ? old.status : projectedStatus,
          pickupCode: staleLogistics ? old.pickupCode || '' : input.pickupCode || (!pickup.arrivalAt && (old?.arrivalAt || logistics.logisticsEvents.some(event => pickupCycleReset(event.description) && (!event.time || event.time <= this.now()))) ? '' : old?.pickupCode) || '', ...pickup,
          updatedAt: input.updatedAt || this.now(), picked: cycleChanged ? false : old?.picked || false, hidden: old?.hidden || false,
          deleted: old?.deleted || false, manualAt: old?.manualAt || 0,
          pickupCompletion: cycleChanged ? pickupCompletionState({}) : pickupCompletionState(old), pickupManualAt: cycleChanged ? 0 : old?.pickupManualAt || 0,
          pickupManualOperation: cycleChanged ? '' : old?.pickupManualOperation || '', pickupManualAction: cycleChanged ? '' : old?.pickupManualAction || '', pickupConfirmedAt: cycleChanged ? 0 : validTime(old?.pickupConfirmedAt),
          ...cycle, ...shipping,
          ...logistics };
        if (staleLogistics) shipment.updatedAt = old.updatedAt || shipment.updatedAt;
        shipment = this.pickupCompletion.project(shipment, { rules: completionRules, config: completionConfig });
        shipment.logisticsEvidenceHash = logisticsEvidenceHash;
        this.db.prepare('INSERT INTO shipments VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, accountId, JSON.stringify(shipment));
        this.saveShipmentIdentifier(shipment, account.platform, input, this.now());
        changedShipmentIds.push(id);
      }
      for (const failure of result.logisticsFailures || []) {
        if (!['error', 'unavailable', 'empty'].includes(failure.state)) continue;
        const orderId = stableId(accountId, account.platform, 'order', String(failure.platformOrderId));
        const rows = this.db.prepare('SELECT data FROM shipments WHERE account_id=?').all(accountId).map(parse);
        for (const old of rows.filter(s => s.orderId === orderId && (!failure.waybillNo || s.waybillNo === failure.waybillNo))) {
          if (failure.logisticsCheckedAt && failure.logisticsCheckedAt < (old.logisticsCheckedAt || 0)) continue;
          const updated = { ...old, ...logisticsData({ logisticsState: failure.state, logisticsError: failure.logisticsError, logisticsCheckedAt: failure.logisticsCheckedAt || this.now(), logisticsDetailCheckedAt: failure.logisticsDetailCheckedAt }, old, false, rules, this.now()), updatedAt: this.now() };
          this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(updated), old.id);
        }
      }
      // Absence, pagination, refunds and source signatures never change manual state or tombstones.
      this.updateAccount(accountId, { status: partial ? 'syncing' : 'ok', ...(!partial ? { lastSuccessAt: this.now() } : {}), error: '',
        warnings: [...new Set([...(partial ? account.warnings || [] : []), ...(result.warnings || []), ...identityWarnings])] });
    });
    return { evidenceChanged: changedShipmentIds.length > 0, changedShipmentIds };
  }
  applyOrderRetention() {
    return this.transaction(() => {
      let changed = 0;
      for (const row of this.db.prepare('SELECT data FROM orders').all()) {
        const order = parse(row), retained = normalizeRetentionFields(order, this.now());
        if (JSON.stringify(order) === JSON.stringify(retained)) continue;
        this.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(retained), order.id);
        changed++;
      }
      if (changed) this.revision();
      return changed;
    });
  }
  snapshot(scope, accountFilter, additionalBytes = 0) {
    const device = Array.isArray(scope) ? { accountIds: scope, legacyAccountIds: scope, familyIds: [] } : scope;
    const narrowed = accountFilter && new Set(accountFilter);
    const visible = record => this.canRead(device, record) && (!narrowed || narrowed.has(record.accountId));
    this.applyOrderRetention();
    const accounts = this.accounts(device.accountIds).filter(account => !narrowed || narrowed.has(account.id));
    const orders = this.db.prepare('SELECT data FROM orders ORDER BY id').all().map(parse).filter(visible)
      .map(o => {
        const { archiveAnchorDate, archiveAnchorSource, archivedAt, archiveRestoredAnchor, archiveRestoredAt, orderDatePrecision, ...publicOrder } = o;
        return { ...publicOrder, familyId: o.familyId || '', familyName: o.familyName || '', orderDateSource: o.orderDateSource || (o.orderDate ? 'legacy' : 'unknown'), firstSeenAt: o.firstSeenAt || 0,
          dateOverride: o.dateOverride ?? null, dateOverrideAt: o.dateOverrideAt || 0, dateState: o.dateState || 'unknown', dateError: o.dateError || '', archived: !!o.archived,
          ...(['second', 'minute', 'day'].includes(orderDatePrecision) ? { orderDatePrecision } : {}), retention: orderRetention(o, this.now()) };
      });
    const orderById = new Map(orders.map(order => [order.id, order]));
    const shipments = this.db.prepare('SELECT data FROM shipments ORDER BY id').all().map(parse).filter(visible)
      .filter(shipment => this.shipmentAlias(shipment.id).id === shipment.id).map(s => {
      // Configured services publish evidence persisted by imports or explicit rule changes.
      const platform = orderById.get(s.orderId)?.platform;
      const legacyDoorstep = !validTime(s.arrivalAt) ? doorstepEvidence(s.logisticsEvents, { platform, carrier: s.carrier }, this.now()) : {};
      const pickup = pickupData(legacyDoorstep, s, this.getLogisticsRules ? [] : s.logisticsEvents || [], undefined, this.now(), platform);
      const { pickupCycleHistory, logisticsEvidenceHash, shippedAt, shippedAtSource, shippedAtPrecision, pickupManualAt, pickupManualOperation, pickupManualAction, pickupConfirmedAt, ...publicShipment } = s;
      // Imports persist both proven timestamps and explicit unknowns; only legacy rows need parsing here.
      let shipping = {};
      const jd = orderById.get(s.orderId)?.platform === 'jd';
      if (jd) {
        shipping = shippingEvidence(s.logisticsEvents || [], s, this.now(), s.pickupCycle, 'jd');
        if (!['arrived', 'signed'].includes(s.status)) publicShipment.status = jdShipmentStatus(s.logisticsEvents || [], s.status, this.getLogisticsRules?.(), this.now());
      } else if (!['shippedAt', 'shippedAtSource', 'shippedAtPrecision'].every(field => Object.hasOwn(s, field))) {
        shipping = shippingEvidence(s.logisticsEvents || [], s, this.now());
      } else if (validTime(shippedAt) && shippedAt <= this.now() && shippedAtSource === 'platform_event'
        && (!s.pickupCycle?.evidenceKey || s.pickupCycle.evidenceKey === 'initial' || shippedAt > validTime(s.pickupCycle.startedAt))) {
        shipping = { shippedAt, shippedAtSource, shippedAtPrecision: ['second', 'minute'].includes(shippedAtPrecision) ? shippedAtPrecision : 'unknown' };
      }
      const manual = pickupManualAt || pickupManualOperation || pickupManualAction ? {
        pickupManualAt: validTime(pickupManualAt), pickupManualOperation: shortText(pickupManualOperation, 200),
        pickupManualAction: ['pick', 'restore', 'resumeAutoPickup'].includes(pickupManualAction) ? pickupManualAction : '', pickupConfirmedAt: validTime(pickupConfirmedAt) } : {};
      const compactCycle = s.pickupCycle ? { id: s.pickupCycle.id, startedAt: s.pickupCycle.startedAt, evidenceKey: s.pickupCycle.evidenceKey, status: s.pickupCycle.status } : undefined;
      const archived = !!orderById.get(s.orderId)?.archived;
      const receipt = retainedSignedShipment(s, archived, this.now());
      return { ...publicShipment, ...(archived ? { archived: true } : {}), ...(receipt || {}), ...(compactCycle ? { pickupCycle: compactCycle } : {}), ...(pickupCycleHistory?.length ? { pickupCycleHistory } : {}), ...pickup, pickupCompletion: pickupCompletionState(s), pickupCode: s.arrivalAt && !pickup.arrivalAt ? '' : s.pickupCode,
        ...(jd || shipping.shippedAt ? shipping : {}), ...manual,
        familyId: s.familyId || '', familyName: s.familyName || '' };
    });
    const visibleShipmentIds = new Set(shipments.map(shipment => shipment.id));
    const shipmentIdentifiers = this.db.prepare('SELECT account_id,platform,shipment_id,order_id,platform_package_key,carrier_raw,carrier_key,waybill_raw,waybill_key,source,created_at,updated_at FROM shipment_identifiers ORDER BY id').all()
      .map(row => ({ row, canonicalId: this.shipmentAlias(row.shipment_id).id }))
      .filter(({ row, canonicalId }) => visibleShipmentIds.has(canonicalId) && this.canRead(device, this.shipment(canonicalId)))
      .map(({ row, canonicalId }) => ({ accountId: row.account_id, platform: row.platform, shipmentId: canonicalId, ...(canonicalId === row.shipment_id ? {} : { originalShipmentId: row.shipment_id }), orderId: row.order_id,
        platformPackageKey: row.platform_package_key, carrier: row.carrier_raw, carrierKey: row.carrier_key, waybillNo: row.waybill_raw, waybillKey: row.waybill_key, source: row.source,
        createdAt: row.created_at, updatedAt: row.updated_at }));
    const shipmentAliases = this.db.prepare('SELECT old_shipment_id,target_shipment_id,account_id,platform,reason,evidence,created_at,source_cycle_id,target_cycle_id FROM shipment_aliases ORDER BY created_at').all()
      .filter(row => visibleShipmentIds.has(row.target_shipment_id)).map(row => ({ oldShipmentId: row.old_shipment_id,
        targetShipmentId: row.target_shipment_id, accountId: row.account_id, platform: row.platform, reason: row.reason, evidence: row.evidence, createdAt: row.created_at,
        ...(row.source_cycle_id ? { sourceCycleId: row.source_cycle_id } : {}), ...(row.target_cycle_id ? { targetCycleId: row.target_cycle_id } : {}) }));
    const familyIds = device.familyIds || [];
    const families = this.families([...new Set([...familyIds, ...accounts.map(a => a.familyId), ...orders.map(o => o.familyId), ...shipments.map(s => s.familyId)].filter(Boolean))]);
    const histories = shipments.map(shipment => {
      const events = shipment.logisticsEvents || [];
      shipment.logisticsEvents = []; shipment.logisticsTruncated = !!shipment.logisticsTruncated;
      return { shipment, events };
    });
    const { enabled, aiEnabled } = this.pickupCompletion.config();
    const snapshot = { schemaVersion: 1, serverVersion, capabilities, pickupCompletion: { version: 1, enabled, aiEnabled }, identity: { version: 1 }, serverRevision: this.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision, familyIds, legacyAccountIds: device.legacyAccountIds || [], families, accounts, orders, shipments, shipmentIdentifiers, shipmentAliases,
      hiddenIds: shipments.filter(s => s.hidden).map(s => s.id), deletedIds: shipments.filter(s => s.deleted).map(s => s.id),
      events: shipments.filter(s => s.arrivalAt).map(s => ({ id: stableId(s.id, 'arrival', s.arrivalAt), shipmentId: s.id, arrivedAt: s.arrivalAt, code: s.pickupCode, stationKey: s.station })),
      syncWarnings: accounts.flatMap(a => (a.warnings || []).map(message => ({ accountId: a.id, message }))) };
    const responseLimit = Math.max(0, 1900000 - additionalBytes);
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > responseLimit) {
      // Clients treat these absent optional values as empty; retain every non-default fact.
      for (const order of orders) {
        for (const field of ['dateError', 'tradeStatus', 'orderStatus', 'refundStatus', 'imageUrl']) if (order[field] === '') delete order[field];
        if (order.dateCheckedAt === 0) delete order.dateCheckedAt;
      }
    }
    let imageBudgetBytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
    if (imageBudgetBytes > responseLimit) {
      // Omit older thumbnails before identity/cycle facts; SQLite and existing client images remain intact.
      for (const order of orders.slice().sort((a, b) => (a.orderDate || 0) - (b.orderDate || 0))) {
        if (!order.imageUrl) continue;
        const before = Buffer.byteLength(JSON.stringify(order), 'utf8');
        delete order.imageUrl;
        imageBudgetBytes -= before - Buffer.byteLength(JSON.stringify(order), 'utf8');
        if (imageBudgetBytes <= responseLimit) break;
      }
    }
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > responseLimit) {
      // Optional cycle metadata is retained in SQLite and omitted only when the complete response is already over Android's cap.
      for (const shipment of shipments) {
        if (!shipment.pickupCycle || shipment.pickupCycleHistory?.length) continue;
        delete shipment.pickupCycle;
        if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= responseLimit) break;
      }
    }
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > responseLimit && shipmentIdentifiers.length) {
      const allIdentifiers = snapshot.shipmentIdentifiers;
      let low = 0, high = allIdentifiers.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        snapshot.shipmentIdentifiers = allIdentifiers.slice(0, middle);
        if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') <= responseLimit) low = middle;
        else high = middle - 1;
      }
      snapshot.shipmentIdentifiers = allIdentifiers.slice(0, low);
    }
    // Android caps the entire response at 2,000,000 bytes, not just the histories.
    // Reserve headroom and trim this response only; the SQLite cache remains intact.
    let historyBudget = Math.max(0, 1900000 - additionalBytes - Buffer.byteLength(JSON.stringify(snapshot), 'utf8'));
    histories.sort((a, b) => Number(a.shipment.picked || a.shipment.hidden) - Number(b.shipment.picked || b.shipment.hidden));
    for (const { shipment, events } of histories) {
      for (const event of events) {
        const size = Buffer.byteLength(JSON.stringify(event), 'utf8') + (shipment.logisticsEvents.length ? 1 : 0);
        if (size > historyBudget) { shipment.logisticsTruncated = true; continue; }
        shipment.logisticsEvents.push(event); historyBudget -= size;
      }
    }
    return snapshot;
  }
  applyOperations(device, operations) {
    if (!Array.isArray(operations) || !operations.length || operations.length > 100) fail(400, 'INVALID_OPERATIONS', '每批操作须为1到100条');
    return this.transaction(() => {
      const appliedIds = [];
      for (const input of operations) {
        if (input?.action === 'restoreExpiredOrder') {
          onlyKeys(input, ['id', 'orderId', 'action', 'anchorDate', 'occurredAt']);
          const operation = { id: text(input.id, '操作ID', 128), orderId: text(input.orderId, '订单ID', 128), action: input.action,
            anchorDate: text(input.anchorDate, '归档锚点日期', 10), occurredAt: input.occurredAt };
          if (!validRetentionDate(operation.anchorDate) || !Number.isSafeInteger(operation.occurredAt) || operation.occurredAt <= 0 || operation.occurredAt > this.now() + 5 * 60000) fail(400, 'INVALID_OPERATION', '归档恢复日期或操作时间无效');
          const order = this.order(operation.orderId);
          if (!this.canRead(device, order)) fail(403, 'SCOPE_FORBIDDEN', '订单不在授权范围内');
          const digest = hash(JSON.stringify(operation));
          const old = this.db.prepare('SELECT payload_hash FROM operations WHERE device_id=? AND id=?').get(device.id, operation.id);
          if (old && old.payload_hash !== digest) fail(409, 'OPERATION_CONFLICT', '相同操作ID不能用于不同内容');
          if (!old) {
            const retention = orderRetention(order, this.now());
            const stale = retention.anchorDate !== operation.anchorDate || order.archiveRestoredAt && operation.occurredAt <= order.archiveRestoredAt;
            if (!stale) {
              const restored = { ...order, archived: false, archiveAnchorDate: retention.anchorDate, archiveAnchorSource: retention.anchorSource,
                archivedAt: retention.archivedAt, archiveRestoredAnchor: operation.anchorDate, archiveRestoredAt: operation.occurredAt };
              this.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(restored), order.id);
            }
            this.updateAccount(order.accountId, {});
            this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(device.id, operation.id, digest, JSON.stringify({ ...operation, appliedAt: this.now(), status: stale ? 'superseded' : 'applied' }));
          }
          appliedIds.push(operation.id); continue;
        }
        if (input?.action === 'setOrderDate') {
          onlyKeys(input, ['id', 'orderId', 'action', 'date', 'occurredAt']);
          const operation = { id: text(input.id, '操作ID', 128), orderId: text(input.orderId, '订单ID', 128), action: input.action, date: input.date, occurredAt: input.occurredAt };
          const validDate = operation.date === null || (typeof operation.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(operation.date)
            && Number.isFinite(Date.parse(operation.date + 'T00:00:00Z')) && new Date(operation.date + 'T00:00:00Z').toISOString().slice(0, 10) === operation.date);
          if (!validDate || !Number.isSafeInteger(operation.occurredAt) || operation.occurredAt <= 0 || operation.occurredAt > this.now() + 300000) fail(400, 'INVALID_OPERATION', '日期或操作时间无效');
          const order = this.order(operation.orderId);
          if (!this.canRead(device, order)) fail(403, 'SCOPE_FORBIDDEN', '订单不在授权范围内');
          const digest = hash(JSON.stringify(operation));
          const old = this.db.prepare('SELECT payload_hash FROM operations WHERE device_id=? AND id=?').get(device.id, operation.id);
          if (old && old.payload_hash !== digest) fail(409, 'OPERATION_CONFLICT', '相同操作ID不能用于不同内容');
          if (!old) {
            const stale = order.dateOverrideAt && operation.occurredAt <= order.dateOverrideAt;
            if (!stale) {
              Object.assign(order, { dateOverride: operation.date, dateOverrideAt: operation.occurredAt });
              this.db.prepare('UPDATE orders SET data=? WHERE id=?').run(JSON.stringify(order), order.id);
            }
            // Acknowledging a stale offline edit must still refresh the client's optimistic value.
            this.updateAccount(order.accountId, {});
            this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(device.id, operation.id, digest, JSON.stringify({ ...operation, appliedAt: this.now(), status: stale ? 'superseded' : 'applied' }));
          }
          appliedIds.push(operation.id); continue;
        }
        onlyKeys(input, ['id', 'shipmentId', 'action', 'occurredAt', 'pickupCycleId', 'pickedAt']);
        const operation = { id: text(input.id, '操作ID', 128), shipmentId: text(input.shipmentId, '运单ID', 128), action: input.action, occurredAt: input.occurredAt };
        if (Object.hasOwn(input, 'pickupCycleId')) operation.pickupCycleId = text(input.pickupCycleId, '领取周期ID', 128);
        if (!['pick', 'restore', 'resumeAutoPickup', 'hide', 'unhide'].includes(operation.action) || !Number.isSafeInteger(operation.occurredAt) || operation.occurredAt < 0 || operation.occurredAt > this.now() + 5 * 60000) fail(400, 'INVALID_OPERATION', '不支持的操作或时间');
        if (Object.hasOwn(input, 'pickedAt')) {
          if (operation.action !== 'pick' || !Number.isSafeInteger(input.pickedAt) || input.pickedAt < 0 || input.pickedAt > operation.occurredAt) fail(400, 'INVALID_OPERATION', '取件确认时间无效');
          operation.pickedAt = input.pickedAt;
        }
        const digest = hash(JSON.stringify(operation));
        const old = this.db.prepare('SELECT payload_hash FROM operations WHERE device_id=? AND id=?').get(device.id, operation.id);
        if (old && old.payload_hash !== digest) fail(409, 'OPERATION_CONFLICT', '相同操作ID不能用于不同内容');
        if (old) { appliedIds.push(operation.id); continue; }
        const resolution = this.operationShipmentResolution(device, operation.shipmentId);
        const shipment = resolution.shipment;
        const currentCycleId = shipment.pickupCycle?.id || '';
        if (['pick', 'restore', 'resumeAutoPickup'].includes(operation.action)) {
          const aliasCycleBridge = resolution.alias && operation.pickupCycleId && operation.pickupCycleId === resolution.alias.source_cycle_id
            && currentCycleId && currentCycleId === resolution.alias.target_cycle_id;
          if (operation.pickupCycleId && currentCycleId && operation.pickupCycleId !== currentCycleId && !aliasCycleBridge) fail(409, 'PICKUP_CYCLE_CONFLICT', '领取周期已变化，请刷新后重试');
          if (!operation.pickupCycleId && currentCycleId && operation.occurredAt < validTime(shipment.pickupCycle?.startedAt) && (shipment.pickupCycleHistory || []).length) {
            fail(409, 'PICKUP_CYCLE_CONFLICT', '离线领取命令属于旧周期，请刷新后重试');
          }
        }
        const pickupAction = ['pick', 'restore', 'resumeAutoPickup'].includes(operation.action);
        const stale = pickupAction && (shipment.pickupManualOperation || shipment.pickupManualAt) && operation.occurredAt < (shipment.pickupManualAt || 0);
        if (!stale) {
          if (pickupAction) {
            const state = pickupCompletionState(shipment);
            state.manualOverride = operation.action === 'pick' ? 'picked' : operation.action === 'restore' ? 'pending' : '';
            let confirmedAt = operation.action === 'pick' ? operation.pickedAt ?? operation.occurredAt : 0;
            if (shipment.pickupCycleHistory?.length && confirmedAt < validTime(shipment.pickupCycle?.startedAt)) confirmedAt = 0;
            Object.assign(shipment, { pickupCompletion: state, picked: effectivePicked(state), pickupManualAt: operation.occurredAt, pickupManualOperation: `${device.id}:${operation.id}`, pickupManualAction: operation.action, pickupConfirmedAt: confirmedAt });
            if (operation.action === 'resumeAutoPickup') Object.assign(shipment, this.pickupCompletion.project(shipment));
          } else shipment.hidden = operation.action === 'hide';
          shipment.manualAt = this.now();
          this.db.prepare('UPDATE shipments SET data=? WHERE id=?').run(JSON.stringify(shipment), shipment.id);
        }
        this.db.prepare('INSERT INTO operations VALUES(?,?,?,?)').run(device.id, operation.id, digest, JSON.stringify({ ...operation, appliedAt: this.now(), status: stale ? 'superseded' : 'applied' }));
        this.updateAccount(shipment.accountId, {});
        appliedIds.push(operation.id);
      }
      return { appliedIds };
    });
  }
  operation(device, id) {
    const result = parse(this.db.prepare('SELECT data FROM operations WHERE device_id=? AND id=?').get(device.id, id));
    if (!result) fail(404, 'NOT_FOUND', '操作不存在');
    const record = result.orderId ? this.order(result.orderId) : this.operationShipment(device, result.shipmentId);
    if (!this.canRead(device, record)) fail(403, 'SCOPE_FORBIDDEN', '记录不在授权范围内');
    return result;
  }
}
