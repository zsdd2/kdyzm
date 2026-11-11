/* Time labels use recorded evidence; illustrative progress never fills missing times. */
const own = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);
const validAt = value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : null;
const precision = value => ['second', 'minute', 'day'].includes(value) ? value : 'unknown';
const autoKinds = ['user_collected', 'recipient_pickup', 'recipient_signed'];
// Keep a newly completed card mounted through drive, stop and record folding.
const JOURNEY_COMPLETION_MS = 2600;

function chinaDate(at) { return new Date(at + 8 * 3600000); }
function pad(value) { return String(value).padStart(2, '0'); }
function dateKey(at) {
  if (!at) return 'unknown';
  const value = chinaDate(at);
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
}
function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const at = Date.UTC(year, month - 1, day) - 8 * 3600000;
  return dateKey(at) === value ? at : null;
}
function timeText(at, accuracy) {
  if (!at) return '待获取';
  const value = chinaDate(at);
  const day = `${pad(value.getUTCMonth() + 1)}/${pad(value.getUTCDate())}`;
  return accuracy === 'day' ? day : `${day} ${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}`;
}
function effectiveCollected(shipment) {
  if (!shipment || shipment.receiptState === 'expired_signed') return false;
  if (shipment.pickupCompletion?.manualOverride === 'pending') return false;
  return shipment.picked === true || shipment.isPicked === true;
}

function collectedEvidence(shipment = {}) {
  const unknown = { at: null, source: 'unknown', precision: 'unknown' };
  if (!effectiveCollected(shipment)) return unknown;
  if (shipment.pickedAtCycleId && shipment.pickupCycle?.id && shipment.pickedAtCycleId !== shipment.pickupCycle.id) return unknown;
  if (own(shipment, 'pickedAt')) {
    const at = validAt(shipment.pickedAt);
    return at && ['user_confirmed', 'platform_pickup', 'recipient_signed'].includes(shipment.pickedAtSource)
      ? { at, source: shipment.pickedAtSource, precision: precision(shipment.pickedAtPrecision) } : unknown;
  }
  const completion = shipment.pickupCompletion;
  if (shipment.pickupManualAction === 'pick' && completion?.manualOverride === 'picked') {
    const at = validAt(own(shipment, 'pickupConfirmedAt') ? shipment.pickupConfirmedAt : shipment.pickupManualAt);
    return at ? { at, source: 'user_confirmed', precision: 'second' } : unknown;
  }
  if (!completion?.manualOverride && completion?.autoPicked && autoKinds.includes(completion.evidence?.kind)) {
    const at = validAt(completion.evidence.eventTime);
    if (!at) return unknown;
    const event = (shipment.logisticsEvents || []).find(row => row.time === at && row.description === completion.evidence.description);
    return { at, source: completion.evidence.kind === 'recipient_signed' ? 'recipient_signed' : 'platform_pickup',
      precision: precision(completion.evidence.timePrecision || event?.timePrecision) };
  }
  return unknown;
}

function shipmentCollectedAt(shipment) { return collectedEvidence(shipment).at; }
function packageCollectedAt(order) {
  const shipments = Array.isArray(order?.shipments) ? order.shipments.filter(Boolean) : [];
  if (!shipments.length) return null;
  const times = shipments.map(shipmentCollectedAt);
  // One unknown member could have been collected last; do not guess the full-order date.
  return times.every(Boolean) && shipments.every(row => !row.pickupConflict && !row.needsPickupAssignment) ? Math.max(...times) : null;
}
function packageCollectedDateKey(order) { return dateKey(packageCollectedAt(order)); }
function comparePackagesByCollectedAt(left, right) { return (packageCollectedAt(right) || 0) - (packageCollectedAt(left) || 0); }

function duration(start, end) {
  if (!start || !end || end < start) return '—';
  const minutes = Math.floor((end - start) / 60000);
  if (!minutes) return '不足1分';
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes / 60) % 24;
  return (days ? `${days}天` : '') + (hours ? `${hours}时` : '') + (minutes % 60 ? `${minutes % 60}分` : '');
}
function parcelJourneySegments(journey, now = Date.now()) {
  const points = Array.isArray(journey?.points) ? journey.points : [];
  const known = points.filter(point => validAt(point?.at));
  const ordered = known.every((point, index) => !index || point.at >= known[index - 1].at);
  const accurate = point => validAt(point?.at) && ['second', 'minute'].includes(point.precision) &&
    !['unknown', 'legacy', 'sms_received', 'sms_sent', 'locker_created'].includes(point.source);
  return ['waiting', 'transit', 'pickup'].map((key, index) => {
    const start = points[index], end = points[index + 1];
    const ongoing = !journey?.completed && index === journey?.currentIndex && !end?.at;
    return { key, label: ['待发货', '运输', '待取'][index], ongoing, text: ordered && accurate(start) && (accurate(end) || ongoing)
      ? duration(start.at, ongoing ? validAt(now) : end.at) : '—' };
  });
}
function parcelJourneyProgress(journey) {
  if (journey?.completed === true) return 3;
  const index = journey?.currentIndex;
  if (!Number.isInteger(index) || index < 0 || index > 3) return -1;
  // Position means observed stage, never a delivery estimate based on elapsed time.
  return [0, 1.5, 2, 3][index];
}
function parcelJourney(shipment = {}, order = {}) {
  shipment = shipment || {}; order = order || {};
  const orderValue = order.dateOverride || order.orderDate || shipment.orderDate;
  const orderSource = order.dateOverride ? 'manual' : order.orderDateSource || shipment.orderDateSource || 'unknown';
  const dayAt = dateOnly(orderValue);
  const orderAt = ['platform', 'manual'].includes(orderSource) ? dayAt || validAt(orderValue) : null;
  const picked = collectedEvidence(shipment);
  const completed = effectiveCollected(shipment);
  const points = [
    { key: 'order', label: '下单', at: orderAt, source: orderSource, precision: dayAt ? 'day' : precision(order.orderDatePrecision || shipment.orderDatePrecision) },
    { key: 'ship', label: '发货', at: shipment.shippedAtSource === 'platform_event' ? validAt(shipment.shippedAt) : null, source: shipment.shippedAtSource || 'unknown', precision: precision(shipment.shippedAtPrecision) },
    { key: 'arrival', label: '到货', at: ['platform_event', 'locker_arrival'].includes(shipment.arrivalAtSource) ? validAt(shipment.arrivalAt) : null, source: shipment.arrivalAtSource || 'unknown', precision: precision(shipment.arrivalAtPrecision) },
    { key: 'pickup', label: shipment.isHomeDelivery || picked.source === 'recipient_signed' ? '签收' : '取件', ...picked },
  ];
  let currentIndex = completed ? 3 : points[2].at || shipment.needsReceiptConfirmation || ['arrived', 'awaiting_code'].includes(shipment.status) ? 2
    : points[1].at || shipment.status === 'transit' ? 1 : points[0].at || order.id || shipment.orderId ? 0 : -1;
  if (!completed && ['returning', 'returned'].includes(shipment.status)) currentIndex = -1;
  points.forEach((point, index) => {
    point.text = point.at ? timeText(point.at, point.precision) : index === 3 && !completed ? shipment.isHomeDelivery ? '待确认' : '待取件' : '待获取';
    point.state = index === currentIndex && !completed ? 'current' : point.at || index < currentIndex || index === 3 && completed ? 'done' : 'pending';
  });
  const segments = parcelJourneySegments({ points, currentIndex, completed });
  const carrier = typeof shipment.carrier === 'string' ? shipment.carrier.trim() : '';
  return { points, segments, currentIndex, completed,
    parcelId: shipment.id ? 'shipment:' + shipment.id : order.id || shipment.orderId ? 'order:' + (order.id || shipment.orderId) : '',
    carrier: /^(?:unknown|other|未知(?:快递|物流|承运商|快递公司)?|快递公司未知|其他(?:快递|物流)?|暂无|未识别|线上包裹|[-—–]+)$/i.test(carrier) ? '' : carrier };
}

export { parcelJourney, parcelJourneySegments, parcelJourneyProgress, JOURNEY_COMPLETION_MS, shipmentCollectedAt, packageCollectedAt, packageCollectedDateKey, comparePackagesByCollectedAt };
