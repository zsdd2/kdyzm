import { randomBytes } from 'node:crypto';
import { fail, hash, onlyKeys } from './security.mjs';

const DEFAULT_CAPACITY = 500;
const MAX_BATCH = 50;
const MAX_LIMIT = 100;
const MAX_STATUS = 599;
const MAX_DURATION_MS = 120000;
const MAX_COUNT = 10000;

export const interactionKinds = Object.freeze([
  'snapshot',
  'shipment_detail',
  'operations',
  'sync_job',
  'accounts',
  'feedback',
  'recognition',
  'other_device'
]);
const results = new Set(['success', 'metadata_only', 'not_modified', 'accepted', 'rejected', 'error']);
const modes = new Set(['compact', 'full']);
const ackResults = new Set(['applied', 'already_applied', 'rejected', 'conflict', 'error']);
const phases = new Set(['request', 'import', 'sync', 'session']);
const triggers = new Set(['manual', 'passive', 'order', 'enhancement']);
const stages = new Set(['sync', 'request', 'validation', 'import', 'store_lock', 'database_read', 'upgrade_backup', 'core_init', 'core_execute', 'json', 'projection', 'persistence', 'cursor_commit', 'ack']);
const errorCodes = new Set(['none', 'network', 'unauthorized', 'invalid_response', 'stale_snapshot', 'stage_failed', 'cursor_failed', 'ack_rejected', 'collection_failed', 'credentials_unavailable', 'unavailable']);
const v2Fields = ['operationId', 'appBuild', 'dataVersion', 'stage', 'errorCode', 'durationCapped', 'failureSummary', 'failureCapacity', 'failureRetained', 'failureDropped'];

const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const optionalInteger = (value, min, max) => value === undefined || integer(value, min, max);
const optionalEnum = (value, allowed) => value === undefined || allowed.has(value);

function validateEvent(value, { client = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_INPUT', '诊断事件格式不正确');
  const allowed = ['kind', 'result', 'status', 'durationMs', 'count', 'mode', 'metadataOnly', 'ackCount', 'ackResult', 'phase', 'trigger', 'ageMs', ...v2Fields];
  if (client) onlyKeys(value, allowed);
  if (!interactionKinds.includes(value.kind) || !optionalEnum(value.result, results)
    || !optionalInteger(value.status, 100, MAX_STATUS)
    || !optionalInteger(value.durationMs, 0, MAX_DURATION_MS)
    || !optionalInteger(value.count, 0, MAX_COUNT)
    || !optionalEnum(value.mode, modes)
    || (value.metadataOnly !== undefined && typeof value.metadataOnly !== 'boolean')
    || !optionalInteger(value.ackCount, 0, MAX_COUNT)
    || !optionalInteger(value.ageMs, 0, 604800000)
    || !optionalEnum(value.phase, phases)
    || !optionalEnum(value.trigger, triggers)
    || !optionalEnum(value.ackResult, ackResults)
    || (value.operationId !== undefined && (typeof value.operationId !== 'string' || !/^[a-f0-9]{32}$/.test(value.operationId)))
    || !optionalInteger(value.appBuild, 1, 2147483647)
    || (value.dataVersion !== undefined && (typeof value.dataVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.dataVersion)))
    || !optionalEnum(value.stage, stages) || !optionalEnum(value.errorCode, errorCodes)
    || (value.durationCapped !== undefined && (typeof value.durationCapped !== 'boolean' || value.durationCapped && value.durationMs !== MAX_DURATION_MS))
    || (value.failureSummary !== undefined && (typeof value.failureSummary !== 'boolean' || value.failureSummary && (value.result !== 'error' || !value.operationId || value.kind !== 'sync_job' || !value.stage || !value.errorCode || value.errorCode === 'none')))
    || !optionalInteger(value.failureCapacity, 1, 128)
    || !optionalInteger(value.failureRetained, 0, 128)
    || !optionalInteger(value.failureDropped, 0, MAX_COUNT)) {
    fail(400, 'INVALID_INPUT', '诊断事件包含无效字段');
  }
  return {
    kind: value.kind,
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.status === undefined ? {} : { status: value.status }),
    ...(value.durationMs === undefined ? {} : { durationMs: value.durationMs }),
    ...(value.count === undefined ? {} : { count: value.count }),
    ...(value.mode === undefined ? {} : { mode: value.mode }),
    ...(value.metadataOnly === undefined ? {} : { metadataOnly: value.metadataOnly }),
    ...(value.ackCount === undefined ? {} : { ackCount: value.ackCount }),
    ...(value.phase === undefined ? {} : { phase: value.phase }),
    ...(value.trigger === undefined ? {} : { trigger: value.trigger }),
    ...(value.ageMs === undefined ? {} : { ageMs: value.ageMs }),
    ...(value.ackResult === undefined ? {} : { ackResult: value.ackResult }),
    ...Object.fromEntries(v2Fields.filter(key => value[key] !== undefined).map(key => [key, value[key]]))
  };
}

export function createInteractionDiagnostics({ now = Date.now, capacity = DEFAULT_CAPACITY } = {}) {
  if (!integer(capacity, 1, 10000)) throw new Error('interaction diagnostics capacity must be a positive safe integer');
  const salt = randomBytes(16).toString('hex');
  const windowId = randomBytes(12).toString('base64url');
  const events = [];
  let nextSeq = 1;
  let total = 0;
  let dropped = 0;
  // This shares the event window's bound; retries never count the same retained operation twice.
  const failureKeys = new Set();

  const deviceKey = deviceId => deviceId ? hash(`${salt}:${deviceId}`).slice(0, 12) : undefined;
  const append = (event, source, deviceId) => {
    try {
      const entry = {
        seq: nextSeq++,
        time: now(),
        source,
        ...event,
        ...(deviceId ? { deviceKey: deviceKey(deviceId) } : {})
      };
      total++;
      if (events.length >= capacity) {
        const removed = events.shift();
        if (removed.failureSummary) failureKeys.delete(`${removed.deviceKey}:${removed.operationId}`);
        dropped++;
      }
      events.push(entry);
      if (entry.failureSummary) failureKeys.add(`${entry.deviceKey}:${entry.operationId}`);
      return entry;
    } catch {
      return null;
    }
  };

  return {
    capacity,
    deviceKey,
    recordClient(deviceId, input) {
      if (!Array.isArray(input) || input.length < 1 || input.length > MAX_BATCH) fail(400, 'INVALID_INPUT', '诊断事件批次不正确');
      const normalized = input.map(value => validateEvent(value, { client: true }));
      return { accepted: normalized.filter(event => event.failureSummary && failureKeys.has(`${deviceKey(deviceId)}:${event.operationId}`)
        || append(event, 'device', deviceId)).length };
    },
    recordServer(event, deviceId) {
      try {
        const normalized = validateEvent(event);
        return append(normalized, 'server', deviceId);
      } catch {
        return null;
      }
    },
    read({ limit = 50, after = 0, cursor, windowId: requestedWindowId } = {}) {
      const effectiveAfter = cursor === undefined ? after : cursor;
      if (!integer(limit, 1, MAX_LIMIT) || !integer(effectiveAfter, 0, Number.MAX_SAFE_INTEGER)) fail(400, 'INVALID_DIAGNOSTIC_QUERY', '诊断游标参数无效');
      if (requestedWindowId !== undefined && (typeof requestedWindowId !== 'string' || requestedWindowId.length < 1 || requestedWindowId.length > 64))
        fail(400, 'INVALID_DIAGNOSTIC_QUERY', '诊断窗口参数无效');
      const lastSeq = events.at(-1)?.seq || 0;
      const firstSeq = events[0]?.seq || 0;
      const resetRequired = (requestedWindowId !== undefined && requestedWindowId !== windowId) || effectiveAfter > lastSeq;
      const selected = (resetRequired ? events : events.filter(event => event.seq > effectiveAfter)).slice(0, limit);
      const nextCursor = selected.length === limit && selected.at(-1)?.seq < lastSeq ? selected.at(-1).seq : null;
      return {
        events: selected.map(event => ({ ...event })),
        windowId,
        resetRequired,
        window: { firstSeq, lastSeq, retained: events.length, dropped, total },
        nextCursor
      };
    },
    stats() {
      return { windowId, firstSeq: events[0]?.seq || 0, lastSeq: events.at(-1)?.seq || 0, retained: events.length, dropped, total };
    }
  };
}

export const interactionLimits = Object.freeze({ maxBatch: MAX_BATCH, maxLimit: MAX_LIMIT, maxDurationMs: MAX_DURATION_MS, maxCount: MAX_COUNT });
