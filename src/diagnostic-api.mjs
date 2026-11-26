import { fail, hash } from './security.mjs';
import { nonPickupPlace } from './station-text.mjs';
import './logistics-rules.js';

const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const orderFields = ['id', 'accountId', 'platform', 'platformOrderId', 'title', 'orderStatus', 'tradeStatus', 'orderDate', 'orderDateSource', 'orderDateOrigin', 'orderDatePrecision', 'dateState', 'dateError', 'dateCheckedAt', 'firstSeenAt', 'archived'];
const shipmentFields = ['id', 'accountId', 'orderId', 'platform', 'waybillNo', 'carrier', 'status', 'station', 'pickupCode', 'shippedAt', 'shippedAtSource', 'shippedAtPrecision', 'arrivalAt', 'arrivalAtSource', 'arrivalAtPrecision', 'picked', 'pickedAt', 'pickupConfirmedAt', 'logisticsState', 'logisticsError', 'logisticsCheckedAt', 'logisticsDetailCheckedAt', 'logisticsTruncated', 'updatedAt'];
const eventFields = ['time', 'timeText', 'timePrecision', 'description', 'location', 'provider', 'providerStatus', 'providerStatusTag', 'providerSubStatus', 'providerStatusText'];
const taskFields = ['id', 'accountId', 'accountIds', 'orderId', 'shipmentId', 'candidateShipmentIds', 'target', 'method', 'status', 'reasonCode', 'retryCount', 'aiAttempts', 'nextRetryAt', 'createdAt', 'updatedAt'];
const feedbackReasons = new Set([
  'WITHDRAWN_REVIEW', 'WITHDRAWN', 'WITHDRAWN_NO_CANDIDATE', 'RULE_APPLIED', 'NO_NEW_RULE', 'MISSING_SOURCE_STATION',
  'NON_PICKUP_PLACE', 'SHIPMENT_STATION_MISMATCH', 'NO_UNIQUE_KNOWN_STATION', 'NO_UNIQUE_TARGET', 'AI_DAILY_LIMIT',
  'AI_RETRY_COOLDOWN', 'AI_NOT_CONFIGURED', 'ANALYSIS_FAILED', 'AI_DISABLED', 'PENDING_ANALYSIS', 'REVIEW_REQUIRED',
  'INVALID_FEEDBACK', 'INVALID_STATION', 'INVALID_FRAGMENT', 'FEEDBACK_CONFLICT', 'SCOPE_FORBIDDEN', 'STATION_QUEUE_FULL', 'FEEDBACK_LIMIT',
]);
const stationFailureCategories = new Set([
  'JSON_PARSE', 'SCHEMA_FIELDS', 'TYPE_MISMATCH', 'ENUM_MISMATCH', 'CANDIDATE_NOT_FOUND', 'EVIDENCE_NOT_IN_INPUT', 'HARD_CONFLICT',
  'AI_INVALID_RESULT', 'AI_TIMEOUT', 'AI_REQUEST_FAILED', 'AI_ENDPOINT_BLOCKED', 'AI_HTTP_ERROR', 'AI_RESPONSE_TOO_LARGE',
  'AI_DETAIL_LIMIT', 'AI_CONFIG_CHANGED', 'AI_NOT_CONFIGURED', 'AI_AUTOMATIC_DISABLED', 'AI_CHANNEL_UNAVAILABLE',
  'AI_DEFAULT_MISSING', 'AI_CHANNEL_DISABLED', 'AI_CHANNEL_INCOMPLETE', 'SERVICE_STOPPING',
]);
const feedbackRef = (...parts) => hash(JSON.stringify(parts)).slice(0, 24);
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const safeEnum = (value, allowed) => allowed.includes(value) ? value : '';
function stationShape(name, subLocation = '') {
  const value = typeof name === 'string' ? name.normalize('NFKC').trim() : '';
  return { present: !!value, generic: !!value && globalThis.PickCodeLogistics.pickupAddressPlaceholder(value),
    nonPickup: !!value && nonPickupPlace(value),
    hasLocker: /(?:[A-Z0-9零〇一二两三四五六七八九十]+\s*(?:号\s*)?(?:快递柜|自提柜|柜)|(?:快递柜|自提柜))/iu.test(value + ' ' + String(subLocation || '').normalize('NFKC')) };
}
function diagnosticFeedback(item) {
  const receipt = item.receipt || {}, ruleReceipt = item.deviceRuleReceipt || {};
  const rejected = item.status === 'rejected';
  const failureCategory = [item.failureCategory, item.analysis?.error?.validationFailure?.category, item.analysis?.error?.code]
    .find(category => stationFailureCategories.has(category));
  return {
    feedbackRef: rejected ? feedbackRef('rejected', item.device?.id, item.id, item.revision, item.reasonCode)
      : feedbackRef('feedback', item.device?.id, item.id),
    candidateRef: item.candidateId ? feedbackRef('station-candidate', item.candidateId) : '',
    kind: safeEnum(receipt.kind, ['station_correction', 'manual_match']),
    action: safeEnum(receipt.action, ['upsert', 'withdraw', 'rejected']),
    status: safeEnum(item.status, ['pending', 'review', 'applied', 'failed', 'withdrawn', 'rejected']),
    reasonCode: feedbackReasons.has(item.reasonCode) ? item.reasonCode : '',
    revision: safeCount(item.revision), ruleVersion: safeCount(item.ruleVersion),
    createdAt: safeCount(receipt.createdAt), updatedAt: safeCount(item.updatedAt),
    candidateStatus: safeEnum(item.candidateStatus, ['pending', 'review', 'approved', 'failed', 'ignored', 'withdrawn', 'unknown']),
    analysisAttemptCount: safeCount(item.analysisAttemptCount ?? item.analysisAttempts?.length),
    ...(failureCategory ? { failureCategory } : {}),
    sourceStation: stationShape(receipt.stationName),
    targetStation: { ...stationShape(item.targetStationName || receipt.otherStationName || item.rule?.stationName, receipt.subLocation), selected: !!receipt.targetStationId },
    deviceRuleReceipt: { received: ruleReceipt.received === true, stationRulesVersion: safeCount(ruleReceipt.stationRulesVersion),
      serverLogisticsRulesVersion: safeCount(ruleReceipt.serverLogisticsRulesVersion), effectStatus: 'unverified' },
  };
}

export function createDiagnosticApi({ store, workflow, interactions, matchingFeedback }) {
  const accounts = () => store.accounts().map(account => pick(account, ['id', 'platform', 'label', 'enabled', 'status', 'lastSuccessAt', 'lastFullSuccessAt', 'lastAttemptAt', 'nextSyncAt', 'error', 'warnings', 'collectionCoverage']));
  function orders(params) {
    const allowed = ['limit', 'after', 'query', 'platform', 'accountId'];
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) fail(400, 'INVALID_DIAGNOSTIC_QUERY', '查询参数无效');
    const limit = Number(params.get('limit') ?? 30), after = Number(params.get('after') ?? 0);
    const query = (params.get('query') || '').trim().toLowerCase(), platform = params.get('platform') || '', accountId = params.get('accountId') || '';
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < 0 || query.length > 120 || accountId.length > 128
      || platform && !['taobao', 'jd', 'pdd'].includes(platform)) fail(400, 'INVALID_DIAGNOSTIC_QUERY', '查询参数无效');
    const accountMap = new Map(store.accounts().map(account => [account.id, account]));
    const rows = store.db.prepare('SELECT rowid AS seq,data FROM orders WHERE rowid>? ORDER BY rowid LIMIT 1000').all(after);
    const result = []; let cursor = after, more = false;
    for (const row of rows) {
      if (result.length === limit) { more = true; break; }
      cursor = row.seq;
      const order = JSON.parse(row.data), account = accountMap.get(order.accountId);
      if (!account || accountId && order.accountId !== accountId || platform && account.platform !== platform) continue;
      if (query && ![order.id, order.platformOrderId, order.title].some(value => String(value || '').toLowerCase().includes(query))) continue;
      result.push({ ...pick(order, orderFields), platform: account.platform });
    }
    return { orders: result, nextCursor: more || rows.length === 1000 ? cursor : null };
  }
  function order(id) {
    if (!/^[a-f0-9]{32}$/u.test(id)) fail(400, 'INVALID_DIAGNOSTIC_QUERY', '订单ID无效');
    const value = store.order(id), account = value && store.account(value.accountId);
    if (!account) fail(404, 'NOT_FOUND', '订单不存在');
    const rows = store.db.prepare("SELECT data FROM shipments WHERE account_id=? AND json_extract(data,'$.orderId')=? ORDER BY id").all(value.accountId, id)
      .map(row => JSON.parse(row.data));
    const aliases = new Map(rows.map(shipment => [shipment.id, store.shipmentAlias(shipment.id).alias]).filter(([, alias]) => alias));
    const projection = store.orderShipmentProjection({ ...value, platform: account.platform }, rows, aliases);
    const shipments = rows.filter(shipment => !aliases.has(shipment.id))
      .map(shipment => ({ ...pick(shipment, shipmentFields),
        ...(projection.unverifiedWaybills.has(shipment.id) ? { waybillVerification: 'unverified' } : {}),
        platformView: store.shipmentView(shipment, value),
        pickupCycle: shipment.pickupCycle ? pick(shipment.pickupCycle, ['id', 'startedAt', 'evidenceKey', 'status']) : null,
        pickupCompletion: shipment.pickupCompletion ? { ...pick(shipment.pickupCompletion, ['version', 'autoPicked', 'manualOverride', 'completedAt']),
          evidence: shipment.pickupCompletion.evidence ? pick(shipment.pickupCompletion.evidence, ['kind', 'eventTime', 'timePrecision', 'description', 'provider', 'ruleId', 'ruleVersion']) : null } : null,
        logisticsEvents: (shipment.logisticsEvents || []).map(event => pick(event, eventFields)) }));
    const shipmentIds = new Set(shipments.map(shipment => shipment.id));
    return { order: { ...pick(value, orderFields), platform: account.platform,
      ...(projection.sharedShipmentIds.length ? { sharedShipmentIds: projection.sharedShipmentIds } : {}) }, shipments,
      tasks: workflow.tasks().filter(task => task.accountId === value.accountId && (task.orderId === id || shipmentIds.has(task.shipmentId))
        || (task.candidateShipmentIds || []).some(candidate => shipmentIds.has(candidate))).map(task => pick(task, taskFields)) };
  }
  function interactionQuery(params) {
    const allowed = ['limit', 'after', 'cursor', 'windowId'];
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1))
      fail(400, 'INVALID_DIAGNOSTIC_QUERY', '诊断游标参数无效');
    const number = name => {
      const raw = params.get(name);
      return raw === null ? undefined : Number(raw);
    };
    return interactions.read({ limit: number('limit'), after: number('after'), cursor: number('cursor'), windowId: params.get('windowId') ?? undefined });
  }
  function stationFeedback(params) {
    const allowed = ['limit', 'before', 'from', 'to'];
    const invalidQuery = () => fail(400, 'INVALID_DIAGNOSTIC_QUERY', '站点反馈查询参数无效');
    if ([...params.keys()].some(key => !allowed.includes(key) || params.getAll(key).length !== 1)) invalidQuery();
    const integer = (name, fallback, minimum, maximum) => {
      const raw = params.get(name);
      if (raw === null) return fallback;
      const value = Number(raw);
      if (!/^\d{1,16}$/u.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalidQuery();
      return value;
    };
    const limit = integer('limit', 50, 1, 100), before = integer('before', 0, 0, Number.MAX_SAFE_INTEGER);
    const from = integer('from', 0, 0, 8640000000000000), to = integer('to', 0, 0, 8640000000000000);
    if (to && from > to) invalidQuery();
    const result = matchingFeedback.adminQuery({ limit, before, from, to, readOnly: true });
    return { items: result.items.map(diagnosticFeedback), nextCursor: result.nextCursor || null };
  }
  return { accounts, orders, order, interactions: interactionQuery, stationFeedback };
}
