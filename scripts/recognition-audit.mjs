import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(String(value)).digest('hex');
const ref = value => value ? hash(value).slice(0, 12) : '';
const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value || {}, key)).map(key => [key, value[key]]));
const countBy = (items, key) => items.reduce((out, item) => { const name = key(item); out[name] = (out[name] || 0) + 1; return out; }, {});
const failureCategories = ['JSON_PARSE', 'SCHEMA_FIELDS', 'TYPE_MISMATCH', 'ENUM_MISMATCH', 'CANDIDATE_NOT_FOUND', 'EVIDENCE_NOT_IN_INPUT', 'HARD_CONFLICT'];
const failureFields = ['version', 'target', 'action', 'reasonCode', 'candidateId', 'evidence', 'requiresReview', 'evidence.sourceId', 'evidence.quote'];
const safeValidation = value => failureCategories.includes(value?.category)
  ? { category: value.category, fields: (Array.isArray(value.fields) ? value.fields : []).filter(field => failureFields.includes(field)) } : undefined;
const numeric = ['seq', 'time', 'status', 'durationMs', 'count', 'ackCount', 'ageMs', 'appBuild', 'failureCapacity', 'failureRetained', 'failureDropped'];
const enums = {
  source: ['server', 'device'], kind: ['snapshot', 'shipment_detail', 'operations', 'sync_job', 'accounts', 'feedback', 'recognition', 'other_device'],
  result: ['success', 'metadata_only', 'not_modified', 'accepted', 'rejected', 'error'], mode: ['compact', 'full'],
  phase: ['request', 'import', 'sync', 'session'], trigger: ['manual', 'passive', 'order', 'enhancement'],
  ackResult: ['applied', 'already_applied', 'rejected', 'conflict', 'error'],
  stage: ['sync', 'request', 'validation', 'import', 'store_lock', 'database_read', 'upgrade_backup', 'core_init', 'core_execute', 'json', 'projection', 'persistence', 'cursor_commit', 'ack'],
  errorCode: ['none', 'network', 'unauthorized', 'invalid_response', 'stale_snapshot', 'stage_failed', 'cursor_failed', 'ack_rejected', 'collection_failed', 'credentials_unavailable', 'unavailable'],
};
export function safeInteraction(event) {
  const safe = {};
  for (const [key, allowed] of Object.entries(enums)) if (allowed.includes(event[key])) safe[key] = event[key];
  for (const key of numeric) if (Number.isSafeInteger(event[key]) && event[key] >= 0) safe[key] = event[key];
  for (const key of ['metadataOnly', 'durationCapped', 'failureSummary']) if (typeof event[key] === 'boolean') safe[key] = event[key];
  for (const [key, length] of [['operationId', 32], ['dataVersion', 64], ['deviceKey', 12]])
    if (typeof event[key] === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(event[key])) safe[key] = event[key];
  return safe;
}
function safeDetail(detail) {
  return { orderRef: ref(detail.order.id), platform: detail.order.platform,
    shipments: detail.shipments.map(row => ({ shipmentRef: ref(row.id), ...pick(row, ['status', 'picked', 'pickedAt', 'logisticsState', 'logisticsTruncated']),
      ...pick({ ...row, ...row.platformView }, ['shippedAt', 'shippedAtSource', 'shippedAtPrecision', 'arrivalAt', 'arrivalAtSource', 'arrivalAtPrecision']),
      storedTimes: pick(row, ['shippedAt', 'shippedAtSource', 'shippedAtPrecision', 'arrivalAt', 'arrivalAtSource', 'arrivalAtPrecision']),
      hasPickupCode: !!row.pickupCode, hasStation: !!row.station, eventCount: row.logisticsEvents?.length || 0,
      unknownEventTimes: (row.logisticsEvents || []).filter(event => !event.time).length,
      quality: row.platformView?.quality,
      arrivalCandidates: (row.platformView?.arrivalEvidence?.candidates || []).map(candidate => pick(candidate, ['time', 'precision', 'source', 'eventRef', 'usableForCurrent'])) })) };
}
export async function runRecognitionAudit({ get, previous = {}, now = Date.now(), scheduledAt = null }) {
  const report = { schemaVersion: 1, scheduledAt, startedAt: new Date(now).toISOString(), complete: false, requests: 0,
    details: [], interactions: { events: [], coverageGap: false }, limits: ['Retained windows are not full-day traffic.', 'Unverified fields are not accuracy measurements.', 'Inactive issues remain unresolved until verified.'] };
  const cache = structuredClone(previous), read = async path => { assert.match(path, /^\/v1\/diagnostics\//); report.requests++; return get(path); };
  async function pages(path, field) {
    let after = 0, first; const items = [], cursors = new Set();
    do {
      assert.ok(Number.isSafeInteger(after) && after >= 0 && !cursors.has(after)); cursors.add(after);
      const page = await read(`${path}?limit=100&after=${after}`); first ||= page;
      assert.ok(Array.isArray(page[field])); items.push(...page[field]); after = page.nextCursor;
    } while (after !== null);
    return { first, items, pages: cursors.size };
  }
  try {
    const status = await read('/v1/diagnostics/status'); report.serverVersion = status.serverVersion;
    assert.equal(status.scope, 'diagnostics:read');
    const accountData = await read('/v1/diagnostics/accounts');
    report.accounts = accountData.accounts.map(account => ({ accountRef: ref(account.id), ...pick(account, ['platform', 'status', 'enabled', 'lastSuccessAt', 'lastFullSuccessAt', 'lastAttemptAt', 'nextSyncAt', 'collectionCoverage']), hasError: !!account.error,
      freshnessMs: account.lastSuccessAt ? Math.max(0, now - account.lastSuccessAt) : null }));
    const taskSummary = await read('/v1/diagnostics/recognition-tasks'), tasks = taskSummary.tasks;
    const review = await pages('/v1/diagnostics/recognition-review', 'samples');
    report.reviewPages = review.pages; report.activeSamples = review.items.length;
    report.rules = review.first.rules; report.ai = review.first.ai;
    report.learning = { enabled: review.first.learning?.enabled, lastRun: review.first.learning?.lastRun ?? null };
    report.methodGroups = taskSummary.groups || [];
    report.taskCounts = taskSummary.groups ? taskSummary.groups.reduce((counts, group) => {
      for (const [state, count] of Object.entries(group.states)) counts[state] = (counts[state] || 0) + count;
      return counts;
    }, {}) : countBy(tasks, task => task.status);
    const totalTasks = Object.values(report.taskCounts).reduce((sum, count) => sum + count, 0);
    report.taskDetailCoverage = { returned: tasks.length, total: totalTasks, limited: totalTasks > tasks.length, ledgerIsFullCurrentState: false };
    if (totalTasks > tasks.length) report.limits.push('Task details are truncated; aggregate groups cover all retained tasks. Older ledger entries are historical observations.');
    report.aiReviews = (review.first.aiReviews || []).map(row => ({ reviewRef: ref(row.id), taskRef: ref(row.taskId),
      ...pick(row, ['status', 'target', 'attempts']), validationFailure: safeValidation(row.validationFailure) }));
    const revision = hash(JSON.stringify([status.serverVersion, report.rules]));
    const byOrder = new Map(), forceRead = new Set();
    const add = (id, evidence) => { if (id) byOrder.set(id, [...(byOrder.get(id) || []), evidence]); };
    for (const sample of review.items) add(sample.orderId, sample.evidenceKey || hash(JSON.stringify(sample)));
    for (const task of tasks) if (task.orderId) add(task.orderId, [task.id, task.status, task.reasonCode, task.sourceFingerprint, task.evidenceVersion]);
    const historicDue = !previous.historyCheckedAt || now - previous.historyCheckedAt >= 7 * 86400000;
    const legacy = review.items.some(sample => !sample.orderId);
    if (historicDue || legacy) {
      const orders = await pages('/v1/diagnostics/orders', 'orders'); report.orderPages = orders.pages;
      for (const order of legacy ? orders.items : orders.items.slice(0, 3)) {
        if (!byOrder.has(order.id)) byOrder.set(order.id, []);
        forceRead.add(order.id);
      }
      if (historicDue) cache.historyCheckedAt = now;
    }
    cache.orders ||= {}; report.reusedOrderDetails = 0;
    for (const [id, evidence] of byOrder) {
      const orderRef = ref(id), fingerprint = hash(JSON.stringify([revision, evidence]));
      if (!forceRead.has(id) && cache.orders[orderRef]?.fingerprint === fingerprint) { report.reusedOrderDetails++; continue; }
      assert.match(id, /^[a-f0-9]{32}$/);
      const detail = safeDetail(await read(`/v1/diagnostics/orders/${id}`));
      report.details.push(detail); cache.orders[orderRef] = { fingerprint, checkedAt: now };
    }
    cache.issues ||= {};
    for (const task of tasks) {
      const taskRef = ref(task.id), previousIssue = cache.issues[taskRef];
      cache.issues[taskRef] = { taskRef, orderRef: ref(task.orderId), ...pick(task, ['platform', 'target', 'status', 'reasonCode', 'retryCount', 'aiAttempts']),
        disposition: task.status === 'resolved' ? 'verified_resolved' : task.status === 'ignored' ? 'inactive_unresolved' : 'open',
        firstObservedAt: previousIssue?.firstObservedAt || now, lastObservedAt: now };
    }
    report.issues = Object.values(cache.issues);
    let after = previous.interactions?.after || 0, windowId = previous.interactions?.windowId, resetOnce = false;
    const cursors = new Set();
    do {
      assert.ok(!cursors.has(`${windowId}:${after}`)); cursors.add(`${windowId}:${after}`);
      const page = await read(`/v1/diagnostics/interactions?limit=100&after=${after}${windowId ? '&windowId=' + encodeURIComponent(windowId) : ''}`);
      if (page.resetRequired) {
        assert.equal(resetOnce, false); resetOnce = true; report.interactions.coverageGap = true;
        after = 0; windowId = undefined; continue;
      }
      if (after && page.window.firstSeq > after + 1) report.interactions.coverageGap = true;
      windowId = page.windowId; report.interactions.window = page.window;
      report.interactions.events.push(...page.events.map(safeInteraction));
      cache.interactions = { windowId, after: page.events.at(-1)?.seq || after };
      after = page.nextCursor;
    } while (after !== null);
    const failures = report.interactions.events.filter(event => event.failureSummary);
    report.interactions.uniqueFailures = new Set(failures.map(event => `${event.deviceKey}:${event.operationId}`)).size;
    report.interactions.uncorrelatedErrorRecords = report.interactions.events.filter(event => event.result === 'error' && !event.operationId).length;
    report.complete = true; cache.version = 1;
    return { report, cache };
  } catch (error) {
    report.failure = /^HTTP_[0-9]{3}$/.test(error.code || '') ? error.code : 'AUDIT_INCOMPLETE';
    return { report, cache: previous };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const day = process.argv[2]; assert.match(day || '', /^\d{4}-\d{2}-\d{2}$/);
  const base = process.env.PICKCODE_BASE_URL, token = process.env.PICKCODE_DIAGNOSTIC_TOKEN;
  assert.ok(base && token && !/\s/.test(token), 'Diagnostic configuration missing');
  assert.ok(['http:', 'https:'].includes(new URL(base).protocol));
  const output = resolve('artifacts', `recognition-daily-${day}-incremental.json`), cacheFile = resolve('artifacts/recognition-audit-cache.json');
  let previous = {}; try { previous = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let lastRequest = 0;
  const get = async path => {
    const wait = 650 - (Date.now() - lastRequest); if (wait > 0) await new Promise(done => setTimeout(done, wait));
    lastRequest = Date.now();
    const response = await fetch(new URL(path, base), { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw Object.assign(new Error('Diagnostic request failed'), { code: `HTTP_${response.status}` });
    return response.json();
  };
  const { report, cache } = await runRecognitionAudit({ get, previous, scheduledAt: `${day}T09:30:00+08:00` });
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  if (report.complete) { writeFileSync(cacheFile + '.tmp', JSON.stringify(cache, null, 2) + '\n'); renameSync(cacheFile + '.tmp', cacheFile); }
  console.log(JSON.stringify({ complete: report.complete, serverVersion: report.serverVersion, requests: report.requests, activeSamples: report.activeSamples,
    detailReads: report.details.length, reusedOrderDetails: report.reusedOrderDetails, uniqueFailures: report.interactions.uniqueFailures, failure: report.failure, output }));
  if (!report.complete) process.exitCode = 1;
}
