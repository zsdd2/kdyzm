import './logistics-rules.js';
import { hash } from './security.mjs';
import { stationKey } from './station-text.mjs';
import { stationLocationConflict } from './station-automation.mjs';
import { stationSubLocation } from '../public/station-location.js';
import { extractCourierContacts } from './logistics-contacts.js';
import { effectivePicked, pickupCompletionState } from './pickup-completion.mjs';
import { shippingEvent } from './shipment-lifecycle.mjs';

const logistics = globalThis.PickCodeLogistics;
const quality = (state, reasonCode) => ({ state, reasonCode });
const timestampKnown = (value, now) => Number.isSafeInteger(value) && value > 0 && value <= now;

function stationView(value, catalog) {
  const selected = logistics.catalogStation(value, catalog);
  const target = catalog.find(item => item.id === selected.id);
  const alias = target && [{ name: target.name }, ...(target.aliases || [])].find(item => stationKey(item.name) === stationKey(value));
  const key = stationKey(value);
  const cabinet = /((?:[A-Za-z]+区|\d+区)?[A-Za-z0-9]+)号?(?:快递柜|自提柜|柜)/u.exec(key);
  const gate = /([东南西北正侧后]{1,2})(?:大)?门/u.exec(key);
  const building = /((?:[A-Za-z]+区|\d+区)?[A-Za-z0-9]+)(?:号楼|栋|幢)/u.exec(key);
  const subLocation = stationSubLocation(alias?.subLocation || '')
    || [gate ? `${gate[1]}门` : '', building ? `${building[1]}栋` : '', cabinet ? `${cabinet[1]}号柜` : ''].filter(Boolean).join(' ');
  const conflict = !!selected.ambiguous || stationLocationConflict(value, target?.name || '', subLocation);
  return { id: conflict ? '' : selected.id, name: conflict ? '' : selected.name, subLocation: conflict ? '' : subLocation, rawName: value || '',
    displayName: !conflict && selected.name || value || '', conflict };
}

// Candidate identity comes from exact names or confirmed catalog aliases, never containment.
export function shipmentArrivalEvidence(shipment, { platform, catalog = [], rules, now = Date.now() } = {}) {
  const evidence = { methodId: `${['taobao', 'pdd', 'jd'].includes(platform) ? platform : 'other'}.arrival_evidence`, methodVersion: 2, candidates: [] };
  const events = (shipment.logisticsEvents || []).slice().sort((a, b) => (b.time || 0) - (a.time || 0));
  if (events.some(event => !timestampKnown(event.time, now) && !event.time && logistics.pickupCycleReset(event.description))) return evidence;
  const startedAt = shipment.pickupCycle?.evidenceKey && shipment.pickupCycle.evidenceKey !== 'initial' ? shipment.pickupCycle.startedAt || 0 : 0;
  const current = stationView(shipment.station || logistics.pickupEvidence(events, rules).station, catalog);
  for (const event of events) {
    if (event.time > now) continue;
    if (logistics.pickupCycleReset(event.description) || event.time && event.time < startedAt) break;
    const pickup = logistics.pickupEvidence([event], rules);
    const catalogPickup = !pickup.arrivalAt ? logistics.catalogPickupEvidence([event], catalog, rules) : pickup;
    const candidate = catalogPickup.arrivalAt ? catalogPickup : pickup;
    if (!timestampKnown(candidate.arrivalAt, now) || logistics.eventTimeIssue(event, now) === 'timeConflict') continue;
    const station = stationView(candidate.station, catalog);
    const identity = !current.rawName || !station.rawName || logistics.genericPickupStation(station.rawName) || stationKey(current.rawName) === stationKey(station.rawName)
      || current.id && current.id === station.id;
    const conflict = current.conflict || station.conflict
      || stationLocationConflict(current.rawName, current.subLocation, station.rawName, station.subLocation, event.description);
    evidence.candidates.push({ time: candidate.arrivalAt, precision: candidate.arrivalAtPrecision, source: 'platform_event',
      eventRef: hash(JSON.stringify([event.time, event.timeText || '', event.description, event.location || '', event.provider || '',
        event.providerStatus || '', event.providerSubStatus || ''])), station: candidate.station || '', stationId: station.id,
      usableForCurrent: !!identity && !conflict });
    break;
  }
  return evidence;
}

function timeQuality(shipment, field, events, now, platform, rules) {
  if (timestampKnown(shipment[field], now) && ['platform_event', 'locker_arrival', 'locker_created'].includes(shipment[`${field}Source`]))
    return quality('known', 'PLATFORM_EVIDENCE');
  const relevant = events.filter(event => field === 'shippedAt' ? shippingEvent(event.description, platform)
    : !logistics.pddCabinetExit(event) && (logistics.pickupArrivalEvent(event.description, shipment.station, rules) || /门口|门外/.test(event.description || '')));
  if (relevant.some(event => logistics.eventTimeIssue(event, now) === 'timeConflict'))
    return quality('ambiguous', 'TIME_CONFLICT');
  if (relevant.some(event => !timestampKnown(event.time, now))) return quality('unknown', 'EVENT_TIME_UNKNOWN');
  return quality('unknown', field === 'shippedAt' ? 'SHIPPED_TIME_NOT_PROVIDED' : 'ARRIVAL_TIME_NOT_PROVIDED');
}

function explicitAddressForStoredArrival(shipment, events, pickup, catalog, rules, now) {
  const at = shipment.arrivalAt;
  if (shipment.stationSource !== 'platform_event' || !logistics.pickupAddressPlaceholder(shipment.station)
    || shipment.arrivalAtSource !== 'platform_event' || !timestampKnown(at, now) || pickup.arrivalAt !== at
    || (shipment.pickupCycle?.evidenceKey && shipment.pickupCycle.evidenceKey !== 'initial' && !(at > shipment.pickupCycle.startedAt))) return '';
  const selected = logistics.catalogStation(shipment.station, catalog);
  if (selected.id || selected.ambiguous) return '';
  const sameTime = events.filter(event => event.time === at);
  if (!sameTime.some(event => logistics.pickupAddress(event.description, rules) === pickup.station)
    || sameTime.some(event => {
      const station = logistics.pickupStation(event.description, rules);
      return logistics.eventTimeIssue(event, now) === 'timeConflict'
        || station && !logistics.pickupAddressPlaceholder(station) && stationKey(station) !== stationKey(pickup.station);
    })) return '';
  return pickup.station;
}

export function projectShipmentView(shipment, { platform, orderStatus = '', catalog = [], rules, now = Date.now(), evidenceKey = '' } = {}) {
  const events = (shipment.logisticsEvents || []).slice().sort((a, b) => (b.time || 0) - (a.time || 0));
  const doorstep = logistics.doorstepEvidence(events, { platform, carrier: shipment.carrier }, now);
  const pickup = logistics.catalogPickupEvidence(events, catalog, rules);
  const textualPickup = logistics.pickupEvidence(events, rules);
  const exitUsedAsArrival = platform === 'pdd' && shipment.arrivalAtSource === 'platform_event'
    && events.some(event => event.time && event.time === shipment.arrivalAt && logistics.pddCabinetExit(event));
  const explicitAddress = explicitAddressForStoredArrival(shipment, events, textualPickup, catalog, rules, now);
  const entryStation = exitUsedAsArrival && (logistics.genericPickupStation(shipment.station) || logistics.pickupAddressPlaceholder(shipment.station)) && textualPickup.arrivalAt
    ? textualPickup.station : '';
  const rawStation = doorstep.arrivalAt ? '' : explicitAddress || entryStation || shipment.station || textualPickup.station || pickup.station || '';
  const station = stationView(rawStation, catalog);
  const stationEvent = rawStation && events.find(event => !logistics.pddCabinetExit(event) && logistics.pickupArrivalEvent(event.description, rawStation, rules)
    && stationKey(event.description).includes(stationKey(rawStation)));
  if (stationEvent && stationLocationConflict(rawStation, station.name, station.subLocation, stationEvent.description))
    Object.assign(station, { id: '', name: '', subLocation: '', displayName: rawStation, conflict: true });
  const arrivalEvidence = shipmentArrivalEvidence({ ...shipment, station: rawStation }, { platform, catalog, rules, now });
  const candidate = arrivalEvidence.candidates[0];
  const priorCycle = shipment.pickupCycle?.evidenceKey && shipment.pickupCycle.evidenceKey !== 'initial'
    && shipment.arrivalAt && shipment.arrivalAt <= (shipment.pickupCycle.startedAt || 0);
  const reset = priorCycle || events.some(event => logistics.pickupCycleReset(event.description) && (!event.time || event.time <= now)
    && (!event.time || !shipment.arrivalAt || event.time >= shipment.arrivalAt));
  const structuredArrival = timestampKnown(shipment.arrivalAt, now) && ['locker_arrival', 'locker_created'].includes(shipment.arrivalAtSource)
    && (!candidate || shipment.arrivalAt >= candidate.time);
  const stationConflict = !!candidate && !candidate.usableForCurrent && !structuredArrival;
  const confirmedAlias = candidate?.usableForCurrent && candidate.stationId && candidate.stationId === station.id
    && stationKey(candidate.station) !== stationKey(rawStation);
  const trustedArrival = timestampKnown(shipment.arrivalAt, now) && ['platform_event', 'locker_arrival', 'locker_created'].includes(shipment.arrivalAtSource);
  const completed = !!shipment.picked || effectivePicked(pickupCompletionState(shipment));
  const unknownArrival = { arrivalAt: 0, arrivalAtSource: 'unknown', arrivalAtPrecision: 'unknown' };
  const arrival = exitUsedAsArrival ? candidate?.usableForCurrent
    ? { arrivalAt: candidate.time, arrivalAtSource: candidate.source, arrivalAtPrecision: candidate.precision } : unknownArrival
    : stationConflict || reset && !candidate || shipment.arrivalAt && !timestampKnown(shipment.arrivalAt, now) ? unknownArrival
    : confirmedAlias && !completed && !trustedArrival ? { arrivalAt: candidate.time, arrivalAtSource: candidate.source, arrivalAtPrecision: candidate.precision }
      : { arrivalAt: shipment.arrivalAt || 0, arrivalAtSource: shipment.arrivalAtSource || 'unknown', arrivalAtPrecision: shipment.arrivalAtPrecision || 'unknown' };
  let status = shipment.status || 'unknown';
  const latest = events.find(event => timestampKnown(event.time, now));
  if (latest && !/预计|即将|将于|申请|预约|准备|是否|疑似|请|未退|没有退|取消退|无需退/.test(latest.description)) {
    if (/已退(?:回|货)|退(?:回|货).{0,12}(?:完成|签收)|发件人已签收退件/.test(latest.description)) status = 'returned';
    else if (/退回中|退货中|退件运输|退货运输|正在退回|已拒收|已拒签|已拒绝?签收|已退件|拒收退回|退回发件人/.test(latest.description)) status = 'returning';
  }
  const returning = ['returning', 'returned'].includes(status);
  const deliveryMode = returning ? 'unknown' : doorstep.arrivalAt ? 'doorstep'
    : /柜|丰巢/.test(rawStation) ? 'locker' : rawStation ? 'station' : 'unknown';
  if (doorstep.arrivalAt && !returning) status = 'signed';
  const contacts = extractCourierContacts(shipment);
  const received = !!shipment.picked || effectivePicked(pickupCompletionState(shipment));
  const awaitingShipment = platform === 'jd' && status === 'unknown' && !shipment.arrivalAt && !shipment.shippedAt
    && (/WAIT_SELLER_SEND_GOODS|待发货|等待发货|等待卖家发货|卖家待发货|等待出库|正在出库/i.test(orderStatus)
      || [orderStatus, ...events.map(event => event.description)].some(text => /进入.{0,20}仓库|仓库处理中|准备出库|等待出库|正在出库|(?:等待|待)[^，,。；;]{0,12}揽收|正在打包|打包完成|打印完成/.test(text)));
  return { version: 1, status, deliveryMode, awaitingShipment,
    shippedAt: shipment.shippedAt || 0, shippedAtSource: shipment.shippedAtSource || 'unknown', shippedAtPrecision: shipment.shippedAtPrecision || 'unknown',
    ...arrival, arrivalEvidence,
    stationSource: shipment.stationSource || 'unknown',
    requiresReceiptConfirmation: !returning && !received && !shipment.archived && !shipment.hidden && !shipment.deleted
      && (deliveryMode === 'doorstep' || status === 'signed' && deliveryMode === 'unknown'),
    station, courierPhones: contacts.phones,
    quality: {
      arrivalTime: stationConflict ? quality('ambiguous', 'STATION_CONFLICT') : timeQuality({ ...shipment, ...arrival }, 'arrivalAt', events, now, platform, rules),
      shippedTime: timeQuality(shipment, 'shippedAt', events, now, platform, rules),
      station: station.conflict || stationConflict ? quality('ambiguous', 'STATION_CONFLICT') : station.id ? quality('known', 'STATION_RULE')
        : rawStation && !logistics.genericPickupStation(rawStation) && (['platform_event', 'locker'].includes(shipment.stationSource)
          || [pickup.station, textualPickup.station].includes(rawStation)) ? quality('known', 'PLATFORM_EVIDENCE') : quality('unknown', 'STATION_NOT_PROVIDED'),
      courier: quality(contacts.state, contacts.reasonCode)
    }, evidenceKey };
}

export class ShipmentViewCache {
  constructor() { this.entries = new Map(); }
  project(shipment, options) {
    const { platform, orderStatus = '', catalog = [], rules, now = Date.now() } = options;
    const events = shipment.logisticsEvents || [];
    // A future event becoming usable invalidates its projection without a per-second cache key.
    const evidenceKey = hash(JSON.stringify([3, platform, orderStatus, catalog, rules, shipment.status, shipment.station, shipment.stationSource, shipment.carrier,
      shipment.arrivalAt, shipment.arrivalAtSource, shipment.arrivalAtPrecision, shipment.shippedAt, shipment.shippedAtSource, shipment.shippedAtPrecision,
      shipment.picked, shipment.pickupCompletion, shipment.pickupCycle, shipment.archived, shipment.hidden, shipment.deleted, events,
      events.map(event => timestampKnown(event.time, now)), timestampKnown(shipment.arrivalAt, now), timestampKnown(shipment.shippedAt, now)]));
    let cached = this.entries.get(shipment.id);
    if (cached?.evidenceKey !== evidenceKey) {
      cached = projectShipmentView(shipment, { ...options, evidenceKey });
      this.entries.set(shipment.id, cached);
    }
    return structuredClone(cached);
  }
}
