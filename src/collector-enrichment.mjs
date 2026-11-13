// Protocol evidence (public sources, inspected 2026-10-31):
// Taobao SSR stages render title/subtitle/labelDesc; the final "送至" stage is a recipient block.
// https://g.alicdn.com/code/npm/@ali/mtb-logistics-v2/1.0.46/js/p_h5-detail-index.js
// Taobao transit_step.do returns expressId, expressName, address:[{place,time}] (GBK).
// https://raw.githubusercontent.com/YUNXI-fi/Pickup-Code-Display/034aad94559e8448644f4670408412ba7222a10d/app/server/taobao.js
// PDD order page getExpressData uses GET order/{sn}/shipping, query_type=2, entry_source=2, ts.
// Its shipping.traces expose info, displayTime/time, timestamp/timeStamp after snake_case conversion.
// https://static.pddpic.com/assets/js/react_order_96cc80d6b098f9c948e4.js
// HTTP base URL is location.origin + '/proxy/api/' (not '/proxy/api/api/' for order/... paths).
// https://static.pddpic.com/assets/js/react_pdd_1f39d1dc7c9162e89c34.js
// Taobao detailv2 POST and order-info fields.labels[{name,value}] renderer:
// https://g.alicdn.com/code/npm/@ali/tb-trade-odetail/0.0.330/js/p_h5-home.js
// The label text is server-provided. Only an explicit creation/order label is accepted;
// payment/shipping/receipt labels and unlabeled dates never qualify as the order date.

import './logistics-rules.js';
import { completionKind } from './pickup-completion.mjs';
import { retainMilestoneEvents, shippingEvent } from './shipment-lifecycle.mjs';
const logistics = globalThis.PickCodeLogistics;
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
export const shortText = (value, limit) => text(value).slice(0, limit);

export function taobaoDetailDate(data, timestamp) {
  return taobaoDetailDateEvidence(data, timestamp).orderDate;
}

export function taobaoDetailDateEvidence(data, timestamp) {
  const cells = data?.data;
  if (!cells || typeof cells !== 'object') return { orderDate: 0, orderDatePrecision: 'unknown' };
  for (const cell of Object.values(cells)) {
    for (const label of Array.isArray(cell?.fields?.labels) ? cell.fields.labels : []) {
      if (!/^(?:创建时间|下单时间)[:：]?$/.test(text(label?.name))) continue;
      const value = text(label.value);
      const orderDatePrecision = orderTimePrecision(value);
      if (!/^\d{4}[-年/]/.test(value) || !['second', 'minute'].includes(orderDatePrecision)) continue;
      const date = timestamp(value);
      if (date) return { orderDate: date, orderDatePrecision };
    }
  }
  return { orderDate: 0, orderDatePrecision: 'unknown' };
}

export function logisticsTimestamp(value, timestamp) {
  const raw = text(value);
  // Never assign a fabricated year to platform labels such as "10-30 12:45" or "今天".
  if (/^\d{10,13}$/.test(raw)) return timestamp(value);
  const normalized = raw.replace(/年|月|\//g, '-').replace('日', '').replace(' ', 'T')
    .replace(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}))?/, (_, year, month, day, hour) =>
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}${hour === undefined ? '' : `T${hour.padStart(2, '0')}`}`);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(normalized)) return 0;
  return timestamp(/Z$|[+-]\d{2}:?\d{2}$/.test(normalized) ? normalized : `${normalized}${normalized.length === 10 ? 'T00:00:00' : ''}+08:00`);
}

export function logisticsTimePrecision(value) {
  const raw = text(value);
  if (/^\d{10,13}$/.test(raw)) return 'second';
  if (/^\d{4}[-年/]\d{1,2}[-月/]\d{1,2}日?[ T]\d{1,2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(raw)) return 'second';
  if (/^\d{4}[-年/]\d{1,2}[-月/]\d{1,2}日?[ T]\d{1,2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$/.test(raw)) return 'minute';
  return 'unknown';
}

export function orderTimePrecision(value) {
  const result = logisticsTimePrecision(value);
  return result !== 'unknown' ? result : /^\d{4}[-年/]\d{1,2}[-月/]\d{1,2}日?$/.test(text(value)) ? 'day' : 'unknown';
}

export function logisticsEventTimeIssue(event, now) {
  return logistics.eventTimeIssue(event, now);
}

export function providerEventFields(event) {
  if (!['pdd', 'taobao'].includes(event?.provider)) return {};
  const fields = { provider: event.provider };
  for (const [key, limit] of [['providerStatus', 64], ['providerStatusTag', 120], ['providerSubStatus', 64], ['providerStatusText', 120]]) {
    if (typeof event[key] === 'string' && event[key].trim()) fields[key] = event[key].trim().slice(0, limit);
  }
  return fields;
}

const TAOBAO_STAGE_STATUSES = new Set(['waitdo', 'doing', 'done']);

export function logisticsEventDescriptionKey(event) {
  const description = event.description || '';
  return event.provider === 'taobao'
    ? description.replace(/^(?:运输中|派送中|派件中|待取件|已揽件|已发货|已下单|仓库处理中)[：:]\s*/u, '')
    : description;
}

export function mergeProviderEventFields(target, source) {
  const fields = providerEventFields(source);
  // UI-only delivery stages can merge; collection statuses remain evidence for completion.
  if (target.provider === 'taobao' && fields.provider === 'taobao'
    && TAOBAO_STAGE_STATUSES.has(target.providerStatus) && TAOBAO_STAGE_STATUSES.has(fields.providerStatus)
    && [target, source].every(event =>
      /^(?:运输中|派送中|派件中|待取件|已揽件|已发货|已下单|仓库处理中)(?:[：:]|$)/u.test(event.providerStatusTag || event.description || '')
      && !/签收|领取|取出|取走|提走|提货|提取|自提|收取|收货|已取件|取件成功|退回|退货|退件|改派|改投|转寄|取消|撤销/u
        .test([event.description, event.providerStatusText].join(' ')))) delete fields.providerStatus;
  // Conflicting platform facts must remain separate so completion can see both sides.
  if (Object.keys(fields).some(key => target[key] && target[key] !== fields[key])) return false;
  Object.assign(target, fields);
  return true;
}

export function normalizeLogisticsEvents(events, timestamp, rules, now) {
  const seen = new Map(), output = [];
  for (const event of events.slice(0, 2000)) {
    if (!event || typeof event !== 'object') continue;
    const normalized = {
      time: logisticsTimestamp(event.time, timestamp),
      timeText: shortText(event.timeText ?? event.time, 100),
      description: shortText(event.description, 600),
      location: shortText(event.location, 120),
      timePrecision: ['second', 'minute', 'unknown'].includes(event.timePrecision) ? event.timePrecision : logisticsTimePrecision(event.time),
      ...providerEventFields(event),
    };
    if (!normalized.description) continue;
    const key = JSON.stringify([normalized.time, normalized.time ? '' : normalized.timeText, logisticsEventDescriptionKey(normalized), normalized.location,
      logisticsEventTimeIssue(normalized, now ?? Date.now()) === 'timeConflict']);
    const matches = seen.get(key) || [];
    if (matches.some(prior => mergeProviderEventFields(prior, normalized))) continue;
    matches.push(normalized); seen.set(key, matches); output.push(normalized);
  }
  // Stable sorting keeps unknown timestamps in their original relative order.
  output.sort((a, b) => b.time - a.time);
  return { events: retainMilestoneEvents(output, rules, now), truncated: events.length > 2000 || output.length > 100 };
}

export function taobaoStageEvents(stages, timestamp, stageText, rules, now) {
  const result = normalizeLogisticsEvents(stages.slice(0, 2001).filter(stage => stage && !/^送至/.test(text(stage.title))).map(stage => ({
    time: stage.time || stage.date || stage.occurTime || stage.subtitle,
    timeText: stage.time || stage.date || stage.occurTime || stage.subtitle,
    description: [text(stage.title), stageText(stage)].filter(Boolean).join('：'),
    provider: 'taobao', providerStatus: stage.status, providerStatusTag: stage.title, providerStatusText: stageText(stage),
  })), timestamp, rules, now);
  result.truncated ||= stages.length > 2000;
  return result;
}

export function corroborateTaobaoEventTimes(events, fullTrack, now = Date.now(), { notBefore = 0, allowLegacy = false } = {}) {
  return events.map(event => {
    if (event.provider !== 'taobao' && !(allowLegacy && !event.provider) || event.time || !/^\d{2}-\d{2} \d{2}:\d{2}$/.test(event.timeText)) return event;
    // Use only a unique full timestamp returned for this waybill, never the server's current year.
    const matches = new Set(fullTrack.filter(other => Number.isSafeInteger(other.time) && other.time > 0 && other.time >= notBefore && other.time <= now
      && other.time < 8640000000000000 - 8 * 3600000
      && new Date(other.time + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ') === event.timeText).map(other => other.time));
    if ((event.providerStatusTag === '已签收' || /^(?:已签收|签收)[：:]/.test(event.description)) && !fullTrack.some(other => matches.has(other.time)
      && (/^(?:签收|已签收|签收成功)$/.test(other.description.trim()) || eventStatus(other.description, 'unknown') === 'signed'))) return event;
    return matches.size === 1 ? { ...event, provider: 'taobao', time: [...matches][0], timePrecision: 'minute' } : event;
  });
}

export function taobaoTimeAnchorCandidate(event) {
  const description = text(event.description).normalize('NFKC').replace(/\s+/gu, '');
  const stage = text(event.providerStatusTag).normalize('NFKC').replace(/\s+/gu, '');
  const status = eventStatus(description, 'unknown');
  const operational = status === 'transit' || status === 'arrived'
    || /待取件|待领取|待自提|运输中|派送中|派件中|入站|到站|入库|入柜/.test(stage)
    || /(?:快件|包裹|快递)已(?:发往|到达|离开)/.test(description);
  const hardUnsafe = /预计|预估|预期|估计|estimated?|expected|签收|取出|领取|取走|提走|退回|退货|退件|改派|改投|转寄|取消|撤销|失败|异常|有误/i.test(description);
  const uncertainOperational = /尚未|等待(?:揽收|发货|派送|签收)|待(?:发货|派送|签收)/i.test(description);
  return event.provider === 'taobao' && !event.time && /^\d{2}-\d{2} \d{2}:\d{2}$/.test(event.timeText)
    && !hardUnsafe
    && !completionKind(event.description)
    && !pickupCycleReset(event.description)
    && (shippingEvent(event.description) || ['已下单', '仓库处理中'].includes(event.providerStatusTag) || operational && !uncertainOperational)
    && status !== 'signed';
}

export function anchorTaobaoEventTimes(events, order, now, fullTrack = [], { observedAt = now, savedEvents = [] } = {}) {
  const offset = 8 * 3600000, date = order?.orderDate;
  const validTime = value => Number.isSafeInteger(value) && value > 0 && value < 8640000000000000 - offset;
  if (!validTime(now) || validTime(date) && date > now) return events;
  const hasOrderDate = validTime(date) && ['second', 'minute', 'day'].includes(order?.orderDatePrecision);
  const fullDates = [...events, ...fullTrack, ...savedEvents].filter(event => validTime(event.time)
    && logisticsTimePrecision(event.timeText) !== 'unknown' && !logisticsEventTimeIssue(event, now));
  const fallback = validTime(observedAt) && observedAt <= now ? observedAt : now;
  const anchor = new Date((hasOrderDate ? date : fullDates.length ? Math.min(...fullDates.map(event => event.time)) : fallback) + offset);
  const year = anchor.getUTCFullYear(), month = anchor.getUTCMonth() + 1;
  if (year > 9999) return events;
  const lateDecember = month === 12 && anchor.getUTCDate() >= 20
    || fullDates.some(event => { const d = new Date(event.time + offset); return d.getUTCFullYear() === year && d.getUTCMonth() === 11 && d.getUTCDate() >= 20; });
  // An order normally stays in one year; only the late-December/January boundary rolls over.
  const labelYear = label => lateDecember && label.startsWith('01-') ? year + 1
    : !hasOrderDate && month === 1 && /^12-(?:2\d|3[01]) /.test(label) ? year - 1 : year;
  if (fullDates.some(event => {
    const label = new Date(event.time + offset).toISOString();
    return Number(label.slice(0, 4)) !== labelYear(label.slice(5, 16).replace('T', ' '));
  })) return events;
  // A minute label may describe the same minute as the second-precision order time.
  const notBefore = !hasOrderDate ? 0 : order.orderDatePrecision === 'day'
    ? Math.floor((date + offset) / 86400000) * 86400000 - offset : Math.floor(date / 60000) * 60000;
  return events.map(event => {
    if (!taobaoTimeAnchorCandidate(event)) return event;
    // A matching PC minute left unresolved by corroboration is conflicting evidence.
    if (fullTrack.some(other => Number.isSafeInteger(other.time) && other.time > 0 && other.time < 8640000000000000 - offset
      && new Date(other.time + offset).toISOString().slice(5, 16).replace('T', ' ') === event.timeText)) return event;
    const candidate = Date.parse(`${labelYear(event.timeText)}-${event.timeText.replace(' ', 'T')}:00+08:00`);
    return validTime(candidate) && candidate >= notBefore && candidate <= now
      && new Date(candidate + offset).toISOString().slice(5, 16).replace('T', ' ') === event.timeText
      ? { ...event, time: candidate, timePrecision: 'minute' } : event;
  }).sort((a, b) => b.time - a.time);
}

export function taobaoTransitEvents(data, timestamp, rules, now) {
  return normalizeLogisticsEvents(data.address.slice(0, 2001).map(step => ({ time: step?.time, description: step?.place })), timestamp, rules, now);
}

export function pddShippingEvents(shipping, timestamp, rules, now) {
  return normalizeLogisticsEvents(shipping.traces.slice(0, 2001).map(trace => ({
    time: trace?.timestamp || trace?.time_stamp || trace?.timeStamp || trace?.time,
    timeText: trace?.display_time || trace?.displayTime || trace?.time || trace?.timestamp || trace?.time_stamp || trace?.timeStamp,
    description: trace?.info,
    provider: 'pdd',
    providerStatus: trace?.status,
    providerStatusTag: trace?.status_tag ?? trace?.statusTag,
    providerSubStatus: trace?.sub_status ?? trace?.subStatus,
    providerStatusText: trace?.trace_status_tip ?? trace?.traceStatusTip,
  })), timestamp, rules, now);
}

export const homeDeliveryCompleted = logistics.homeDeliveryCompleted;
export const genericPickupStation = logistics.genericPickupStation;
export const pickupCycleReset = logistics.pickupCycleReset;
export const pickupStation = logistics.pickupStation;
export const pickupArrivalEvent = logistics.pickupArrivalEvent;
export const pickupEvidence = logistics.pickupEvidence;
export const doorstepEvidence = logistics.doorstepEvidence;
export const eventStatus = logistics.eventStatus;

export function activeKnownParcels(order) {
  if (order?.archived || order?.hidden || order?.deleted) return [];
  return (Array.isArray(order?.shipments) ? order.shipments : []).filter(parcel => {
    const waybill = text(parcel?.waybillNo).normalize('NFKC').trim();
    return waybill && !['0', '待发货', '暂无', '无', 'WAITING_FOR_CARRIER'].includes(waybill.toUpperCase())
      && !parcel.picked && !parcel.hidden && !parcel.deleted && !parcel.archived;
  });
}

export function isActiveKnownOrder(order) {
  if (!order || order.archived || order.hidden || order.deleted) return false;
  if (order.shipments?.length) return activeKnownParcels(order).length > 0;
  const status = text(order.orderStatus), trade = text(order.tradeStatus);
  if (/交易成功|交易完成|交易关闭|已完成|已取消|待付款|未付款|全额退款|退款完成|已退款/.test(status)) return false;
  return ['WAIT_SELLER_SEND_GOODS', 'WAIT_BUYER_CONFIRM_GOODS'].includes(trade)
    || eventStatus(status, 'unknown') === 'arrived'
    || /待发货|等待发货|等待卖家发货|待卖家发货|等待出库|正在出库|待收货|等待收货|已发货|等待揽收|运输中|派送中|派件中|待签收|待取件|待自提|已到达/.test(status);
}

export function activeKnownOrders(orders, seen, limit = 20) {
  const checkedAt = order => activeKnownParcels(order).length ? Math.min(...activeKnownParcels(order).map(parcel => parcel.logisticsCheckedAt || 0)) : order.dateCheckedAt || 0;
  return orders.filter(order => !seen.has(String(order.platformOrderId)) && isActiveKnownOrder(order))
    .sort((a, b) => checkedAt(a) - checkedAt(b))
    .slice(0, limit);
}
