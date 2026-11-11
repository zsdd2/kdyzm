import './logistics-rules.js';
import { completionConflict } from './pickup-completion.mjs';

const logistics = globalThis.PickCodeLogistics;
const validTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : 0;
const precision = value => ['second', 'minute'].includes(value) ? value : 'unknown';

export function shippingEvent(description, platform) {
  const text = typeof description === 'string' ? description.normalize('NFKC').replace(/\s+/gu, '') : '';
  const dispatched = platform !== 'jd' && /已(?:经)?(?:成功)?发货|发货(?:完成|成功)/.test(text);
  // Status, waybill assignment, warehouse printing and intermediate departures are not dispatch evidence.
  if (!text || /[?？]|是否|疑似|可能|取消|撤销|虚假|误报|退回|退货|退件|寄回|逆向/.test(text)
    || /(?:预计|预定|计划|将于|即将|尚未|未|没有|准备|预约|申请|请|要求|希望|安排)[^，,。；;]{0,12}(?:发货|揽收)/.test(text)
    || /(?:等待|待)[^，,。；;]{0,12}发货/.test(text)
    // A completed merchant dispatch can precede carrier collection.
    || !dispatched && /(?:等待|待)[^，,。；;]{0,12}揽收/.test(text)
    || /(?:发货|揽收)[^，,。；;]{0,8}(?:失败|未成功|异常|有误)/.test(text)) return false;
  return dispatched || /已(?:经)?(?:成功)?揽收|揽收(?:完成|成功)|已(?:由|被)[^，,。；;]{1,50}揽收/.test(text);
}

export function shippingEvidence(events = [], old = {}, now = Date.now(), cycle = old.pickupCycle, platform) {
  const empty = { shippedAt: 0, shippedAtSource: 'unknown', shippedAtPrecision: 'unknown' };
  const resets = events.filter(event => logistics.pickupCycleReset(event.description || ''));
  // An undated return/redirect cannot safely be ordered against either a saved or newly seen dispatch.
  if (resets.some(event => !validTime(event.time))) return empty;
  const boundary = Math.max(cycle?.evidenceKey && cycle.evidenceKey !== 'initial' ? validTime(cycle.startedAt) : 0,
    ...resets.filter(event => event.time <= now).map(event => validTime(event.time)), 0);
  const candidates = events.filter(event => validTime(event.time) > boundary && event.time <= now && shippingEvent(event.description, platform))
    .map(event => ({ shippedAt: event.time, shippedAtSource: 'platform_event', shippedAtPrecision: precision(event.timePrecision) }));
  // Legacy JD caches also accepted merchant dispatch; only a retained collection event can prove that timestamp.
  if (platform !== 'jd' && old.shippedAtSource === 'platform_event' && validTime(old.shippedAt) > boundary && old.shippedAt <= now) {
    candidates.push({ shippedAt: old.shippedAt, shippedAtSource: 'platform_event', shippedAtPrecision: precision(old.shippedAtPrecision) });
  }
  // Dispatch and carrier acceptance may both be present; the first explicit event starts this cycle.
  return candidates.sort((a, b) => a.shippedAt - b.shippedAt || (a.shippedAtPrecision === 'unknown') - (b.shippedAtPrecision === 'unknown'))[0] || empty;
}

export function jdShipmentStatus(events = [], fallback = 'unknown', rules, now = Date.now(), hasCurrentPickupCode = false) {
  const usable = events.filter(event => logistics.eventTimeIssue(event, now) !== 'timeConflict');
  for (const event of usable) {
    const text = event.description || '', status = logistics.eventStatus(text, 'unknown', rules);
    if (status === 'arrived' || status === 'signed') return status;
    if (logistics.pickupCycleReset(text)) return 'transit';
    // Current pickup evidence outranks earlier movement, while a new movement or return still takes priority.
    if (hasCurrentPickupCode && event !== usable[0]) continue;
    if (shippingEvent(text, 'jd')) return 'transit';
    // Later carrier nodes prove transit, but cannot supply a missing collection time.
    if (text.split(/[，,。；;]/).some(part => !/预计|预定|计划|即将|尚未|未|没有|等待|准备|预约|取消|撤销|失败|是否|疑似|可能|[?？]/.test(part)
      && !/仓|打印|打包|包装/.test(part)
      && /运输中|派送中|派件中|正在(?:派送|派件)|已(?:经)?(?:从|到达|离开|发往)[^，,。；;]{0,80}(?:分拨|分拣|转运|营业|站|中心)/.test(part))) return 'transit';
  }
  if (fallback === 'arrived' || fallback === 'signed') return fallback;
  return usable.some(event => /仓|打印|打包|包装|出库|发货|揽收/.test(event.description || '')) ? 'unknown' : fallback;
}

export function retainMilestoneEvents(events, rules, now = Date.now(), limit = 100) {
  if (events.length <= limit) return events;
  const kept = new Set(), groups = new Map();
  const key = event => JSON.stringify([event.time, event.time ? '' : event.timeText, event.description, event.location || '']);
  for (const event of events) { const id = key(event), group = groups.get(id) || []; group.push(event); groups.set(id, group); }
  const pin = event => {
    if (!event) return true;
    const group = groups.get(key(event)).filter(item => !kept.has(item));
    if (kept.size + group.length > limit) return false;
    for (const item of group) kept.add(item);
    return true;
  };
  // Saved completion evidence can outlive a truncated timeline; its latest counterevidence must survive too.
  pin(events.find(event => event.provider === 'pdd' && event.providerStatus === 'IN_CABINET' && validTime(event.time)));
  pin(events.find(event => event.provider === 'pdd' && event.providerStatus === 'IN_CABINET' && !validTime(event.time)));
  const conflicts = events.filter(event => completionConflict(event.description) || logistics.eventTimeIssue(event, now) === 'timeConflict');
  pin(conflicts.find(event => validTime(event.time)));
  pin(conflicts.find(event => !validTime(event.time)));
  const reset = events.find(event => validTime(event.time) && event.time <= now && logistics.pickupCycleReset(event.description || ''));
  pin(reset);
  pin(events.find(event => validTime(event.time) && event.time > now && logistics.pickupCycleReset(event.description || '')));
  pin(events.find(event => !validTime(event.time) && logistics.pickupCycleReset(event.description || '')));
  const shipped = events.filter(event => validTime(event.time) && shippingEvent(event.description));
  pin(shipped.filter(event => !reset || event.time > reset.time).at(-1));
  pin(shipped.filter(event => (!reset || event.time > reset.time) && shippingEvent(event.description, 'jd')).at(-1));
  pin(events.find(event => validTime(event.time) && event.time <= now && (!reset || event.time > reset.time)
    && jdShipmentStatus([event], 'unknown', rules, now) === 'transit'));
  const arrival = logistics.pickupEvidence(events.filter(event => !validTime(event.time) || event.time <= now), rules);
  pin(events.find(event => arrival.arrivalAt && event.time === arrival.arrivalAt
    && logistics.pickupArrivalEvent(event.description, arrival.station, rules)));
  const doorstep = logistics.doorstepEvidence(events, { platform: 'jd' }, now);
  pin(events.find(event => doorstep.arrivalAt && event.time === doorstep.arrivalAt && /门口|门外/.test(event.description)));
  // Keep the bounded timeline useful while retaining evidence needed for later imports and rule edits.
  for (const event of events) { if (kept.size >= limit || !pin(event)) break; }
  return events.filter(event => kept.has(event));
}
