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
  const cabinet = /(\d+)号?(?:快递柜|自提柜|柜)/u.exec(key);
  const gate = /([东南西北正侧后]{1,2})(?:大)?门/u.exec(key);
  const building = /(\d+)(?:号楼|栋|幢)/u.exec(key);
  const subLocation = stationSubLocation(alias?.subLocation || '')
    || [gate ? `${gate[1]}门` : '', building ? `${building[1]}栋` : '', cabinet ? `${cabinet[1]}号柜` : ''].filter(Boolean).join(' ');
  const conflict = !!selected.ambiguous || stationLocationConflict(value, target?.name || '', subLocation);
  return { id: conflict ? '' : selected.id, name: conflict ? '' : selected.name, subLocation: conflict ? '' : subLocation, rawName: value || '',
    displayName: !conflict && selected.name || value || '', conflict };
}

function timeQuality(shipment, field, events, now, platform, rules) {
  if (timestampKnown(shipment[field], now) && ['platform_event', 'locker_arrival', 'locker_created'].includes(shipment[`${field}Source`]))
    return quality('known', 'PLATFORM_EVIDENCE');
  const relevant = events.filter(event => field === 'shippedAt' ? shippingEvent(event.description, platform)
    : logistics.pickupArrivalEvent(event.description, shipment.station, rules) || /门口|门外/.test(event.description || ''));
  if (relevant.some(event => logistics.eventTimeIssue(event, now) === 'timeConflict'))
    return quality('ambiguous', 'TIME_CONFLICT');
  if (relevant.some(event => !timestampKnown(event.time, now))) return quality('unknown', 'EVENT_TIME_UNKNOWN');
  return quality('unknown', field === 'shippedAt' ? 'SHIPPED_TIME_NOT_PROVIDED' : 'ARRIVAL_TIME_NOT_PROVIDED');
}

export function projectShipmentView(shipment, { platform, orderStatus = '', catalog = [], rules, now = Date.now(), evidenceKey = '' } = {}) {
  const events = (shipment.logisticsEvents || []).slice().sort((a, b) => (b.time || 0) - (a.time || 0));
  const doorstep = logistics.doorstepEvidence(events, { platform, carrier: shipment.carrier }, now);
  const pickup = logistics.catalogPickupEvidence(events, catalog, rules);
  const textualPickup = logistics.pickupEvidence(events, rules);
  const rawStation = doorstep.arrivalAt ? '' : shipment.station || pickup.station || textualPickup.station || '';
  const station = stationView(rawStation, catalog);
  const stationEvent = rawStation && events.find(event => logistics.pickupArrivalEvent(event.description, rawStation, rules)
    && stationKey(event.description).includes(stationKey(rawStation)));
  if (stationEvent && stationLocationConflict(rawStation, station.name, station.subLocation, stationEvent.description))
    Object.assign(station, { id: '', name: '', subLocation: '', displayName: rawStation, conflict: true });
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
    arrivalAt: shipment.arrivalAt || 0, arrivalAtSource: shipment.arrivalAtSource || 'unknown', arrivalAtPrecision: shipment.arrivalAtPrecision || 'unknown',
    stationSource: shipment.stationSource || 'unknown',
    requiresReceiptConfirmation: !returning && !received && !shipment.archived && !shipment.hidden && !shipment.deleted
      && (deliveryMode === 'doorstep' || status === 'signed' && deliveryMode === 'unknown'),
    station, courierPhones: contacts.phones,
    quality: {
      arrivalTime: timeQuality(shipment, 'arrivalAt', events, now, platform, rules),
      shippedTime: timeQuality(shipment, 'shippedAt', events, now, platform, rules),
      station: station.conflict ? quality('ambiguous', 'STATION_CONFLICT') : station.id ? quality('known', 'STATION_RULE')
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
    const evidenceKey = hash(JSON.stringify([1, platform, orderStatus, catalog, rules, shipment.status, shipment.station, shipment.stationSource, shipment.carrier,
      shipment.arrivalAt, shipment.arrivalAtSource, shipment.arrivalAtPrecision, shipment.shippedAt, shipment.shippedAtSource, shipment.shippedAtPrecision,
      shipment.picked, shipment.pickupCompletion, shipment.archived, shipment.hidden, shipment.deleted, events,
      events.map(event => timestampKnown(event.time, now)), timestampKnown(shipment.arrivalAt, now), timestampKnown(shipment.shippedAt, now)]));
    let cached = this.entries.get(shipment.id);
    if (cached?.evidenceKey !== evidenceKey) {
      cached = projectShipmentView(shipment, { ...options, evidenceKey });
      this.entries.set(shipment.id, cached);
    }
    return structuredClone(cached);
  }
}
