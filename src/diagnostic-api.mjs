import { fail } from './security.mjs';

const pick = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const orderFields = ['id', 'accountId', 'platform', 'platformOrderId', 'title', 'orderStatus', 'tradeStatus', 'orderDate', 'orderDateSource', 'orderDateOrigin', 'orderDatePrecision', 'dateState', 'dateError', 'dateCheckedAt', 'firstSeenAt', 'archived'];
const shipmentFields = ['id', 'accountId', 'orderId', 'platform', 'waybillNo', 'carrier', 'status', 'station', 'pickupCode', 'shippedAt', 'shippedAtSource', 'shippedAtPrecision', 'arrivalAt', 'arrivalAtSource', 'arrivalAtPrecision', 'picked', 'pickedAt', 'pickupConfirmedAt', 'logisticsState', 'logisticsError', 'logisticsCheckedAt', 'logisticsDetailCheckedAt', 'logisticsTruncated', 'updatedAt'];
const eventFields = ['time', 'timeText', 'timePrecision', 'description', 'location', 'provider', 'providerStatus', 'providerStatusTag', 'providerSubStatus', 'providerStatusText'];
const taskFields = ['id', 'accountId', 'accountIds', 'orderId', 'shipmentId', 'candidateShipmentIds', 'target', 'method', 'status', 'reasonCode', 'retryCount', 'aiAttempts', 'nextRetryAt', 'createdAt', 'updatedAt'];

export function createDiagnosticApi({ store, workflow, interactions }) {
  const accounts = () => store.accounts().map(account => pick(account, ['id', 'platform', 'label', 'enabled', 'status', 'lastSuccessAt', 'lastFullSuccessAt', 'lastAttemptAt', 'nextSyncAt', 'error', 'warnings']));
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
    const shipments = store.db.prepare("SELECT data FROM shipments WHERE account_id=? AND json_extract(data,'$.orderId')=? ORDER BY id").all(value.accountId, id)
      .map(row => JSON.parse(row.data)).filter(shipment => store.shipmentAlias(shipment.id).id === shipment.id)
      .map(shipment => ({ ...pick(shipment, shipmentFields),
        pickupCycle: shipment.pickupCycle ? pick(shipment.pickupCycle, ['id', 'startedAt', 'evidenceKey', 'status']) : null,
        pickupCompletion: shipment.pickupCompletion ? { ...pick(shipment.pickupCompletion, ['version', 'autoPicked', 'manualOverride', 'completedAt']),
          evidence: shipment.pickupCompletion.evidence ? pick(shipment.pickupCompletion.evidence, ['kind', 'eventTime', 'timePrecision', 'description', 'provider', 'ruleId', 'ruleVersion']) : null } : null,
        logisticsEvents: (shipment.logisticsEvents || []).map(event => pick(event, eventFields)) }));
    const shipmentIds = new Set(shipments.map(shipment => shipment.id));
    return { order: { ...pick(value, orderFields), platform: account.platform }, shipments,
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
  return { accounts, orders, order, interactions: interactionQuery };
}
