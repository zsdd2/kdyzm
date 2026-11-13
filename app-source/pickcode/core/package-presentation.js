/* Pure presentation helpers for package grouping and history folding. */

const UNKNOWN_DATE = 'unknown';

function isDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2100 && date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function localDateKey(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return isDateOnly(value) ? value : UNKNOWN_DATE;
  }
  const date = new Date(new Date(value).getTime() + 8 * 3600000);
  if (Number.isNaN(date.getTime())) return UNKNOWN_DATE;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function packageDateKey(item) {
  if (!item || typeof item !== 'object') return UNKNOWN_DATE;
  if (isDateOnly(item.dateOverride)) return item.dateOverride;
  if (item.source !== 'manual' && !['platform', 'manual'].includes(item.orderDateSource)) return UNKNOWN_DATE;
  if (item.orderDate == null || item.orderDate === '' || item.orderDate === 0 || item.orderDate === '0') return UNKNOWN_DATE;
  return localDateKey(item.orderDate);
}

function hasUncollectedPickup(item) {
  return (Array.isArray(item?.shipments) ? item.shipments : []).some((shipment) => {
    if (!shipment || shipment.hidden || shipment.picked) return false;
    const visibleCode = typeof shipment.displayPickupCode === 'string' ? shipment.displayPickupCode.trim() : '';
    const rawCode = typeof shipment.pickupCode === 'string' ? shipment.pickupCode.trim() : '';
    // Prefer the resolved display code, but retain any raw/conflicting code conservatively.
    return Boolean(visibleCode || rawCode);
  });
}

function isPackageCollected(item) {
  if (!item || item.source !== 'online' || !Array.isArray(item.shipments) || !item.shipments.length) return false;
  return item.shipments.every((shipment) => shipment && shipment.picked === true &&
    shipment.pickupConflict !== true && shipment.needsPickupAssignment !== true);
}

function shouldArchivePackage(item, now = new Date()) {
  if (!item || typeof item !== 'object') return false;
  if (item.retention?.version === 1 && typeof item.retention.archived === 'boolean') return item.retention.archived;
  const orderKey = packageDateKey(item);
  const key = orderKey === UNKNOWN_DATE && Number(item.firstSeenAt) > 0 ? localDateKey(item.firstSeenAt) : orderKey;
  if (item.archiveRestoredAnchor === key && Number(item.archiveRestoredAt) > 0) return false;
  if (item.archived === true) return true;
  if (key === UNKNOWN_DATE) return false;
  const [year, month, day] = key.split('-').map(Number);
  const orderDay = Date.UTC(year, month - 1, day) / 86400000;
  const todayKey = localDateKey(now);
  if (todayKey === UNKNOWN_DATE) return false;
  const [todayYear, todayMonth, todayDate] = todayKey.split('-').map(Number);
  const today = Date.UTC(todayYear, todayMonth - 1, todayDate) / 86400000;
  const ageDays = today - orderDay;
  return ageDays > 30;
}

const PROGRESS_KEYS = ['all', 'pickup', 'transit', 'waiting', 'done', 'other'];
const UNRECEIVED_PROGRESS = ['pickup', 'transit', 'waiting'];
function normalizedText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function packagePlatform(item) {
  if (normalizedText(item?.source) === 'manual' || normalizedText(item?.platform) === 'manual') return 'manual';
  const platform = normalizedText(item?.platform);
  if (['taobao', '淘宝', 'tmall', '天猫'].includes(platform)) return 'taobao';
  if (['jd', '京东', 'jingdong'].includes(platform)) return 'jd';
  if (['pdd', '拼多多', 'pinduoduo'].includes(platform)) return 'pdd';
  return 'other';
}

function shipmentProgress(shipment, order) {
  if (!shipment || typeof shipment !== 'object') return 'other';
  if (['returning', 'returned'].includes(shipment.status)) return 'other';
  const picked = shipment.picked === true;
  const pickedWithoutReviewIssue = picked && shipment.pickupConflict !== true && shipment.needsPickupAssignment !== true;
  if (pickedWithoutReviewIssue) return 'done';
  if (shipment.needsReceiptConfirmation === true || shipment.needsPickupAssignment === true || shipment.displayPickupCode || shipment.pickupCode) return 'pickup';
  if (picked) return 'pickup';
  const status = normalizedText(shipment.status);
  if (status === 'transit') return 'transit';
  if (['arrived', 'awaiting_code', 'pending', 'signed'].includes(status)) return 'pickup';
  if (shipment.platformView) return shipment.platformView.awaitingShipment === true ? 'waiting' : 'other';
  if ((!status || status === 'unknown') && !(shipment.arrivalAt > 0) && !(shipment.smsArrivalAt > 0) && packagePlatform(order) === 'jd' && hasExplicitWaitingStatus(order, shipment)) return 'waiting';
  return 'other';
}

function visibleShipments(item) {
  return Array.isArray(item?.shipments)
    ? item.shipments.filter((shipment) => shipment && typeof shipment === 'object' && !shipment.hidden)
    : [];
}

function hasExplicitWaitingStatus(item, shipment) {
  const status = [item?.tradeStatus, item?.orderStatus].filter(Boolean).join(' ');
  const warehouse = /进入.{0,20}仓库|仓库处理中|准备出库|等待出库|正在出库|(?:等待|待)[^，,。；;]{0,12}揽收|正在打包|打包完成|打印完成/;
  return /WAIT_SELLER_SEND_GOODS|待发货|等待发货|等待卖家发货|卖家待发货|等待出库|正在出库/i.test(status)
    || packagePlatform(item) === 'jd' && (warehouse.test(status)
      || Array.isArray(shipment?.logisticsEvents) && shipment.logisticsEvents.some(event => warehouse.test(event?.description || '')));
}

function isProgressKey(value) {
  return typeof value === 'string' && PROGRESS_KEYS.includes(value.trim().toLowerCase());
}

function packageProgressMatches(item, key = 'all') {
  if (!item || typeof item !== 'object') return false;
  const progress = normalizedText(key) || 'all';
  if (!isProgressKey(progress)) return false;
  if (packagePlatform(item) === 'manual') return progress === 'other';

  const shipments = visibleShipments(item);
  const matches = value => progress === 'all' ? UNRECEIVED_PROGRESS.includes(value) : value === progress;
  if (shipments.length) return shipments.some(shipment => matches(shipmentProgress(shipment, item)));
  // Hidden shipments are still real shipments: never resurrect them as an order placeholder.
  if (Array.isArray(item.shipments) && item.shipments.some(shipment => shipment && typeof shipment === 'object')) return false;
  const packageStatus = normalizedText(item.status);
  // `picked` is the core's user-confirmed receipt summary, not a platform trade status.
  const fallback = packageStatus === 'picked' ? 'done'
    : ['pending', 'awaiting_code', 'arrived', 'signed'].includes(packageStatus) ? 'pickup'
    : packageStatus === 'transit' ? 'transit'
    : hasExplicitWaitingStatus(item) ? 'waiting' : 'other';
  return matches(fallback);
}

function aggregateFor(items, progress) {
  const matchedItems = items.filter((item) => packageProgressMatches(item, progress));
  const matchingShipments = matchedItems.flatMap((item) => matchingShipmentsFor(item, progress));
  const total = matchedItems.reduce((count, item) => packagePlatform(item) === 'manual'
    ? count
    : count + Math.max(1, matchingShipmentsFor(item, progress).length), 0);
  const orders = matchedItems.length;
  return { orders, total,
    onlineOrders: matchedItems.filter((item) => packagePlatform(item) !== 'manual').length,
    manual: matchedItems.filter((item) => packagePlatform(item) === 'manual').length,
    matchingShipments: matchingShipments.length };
}

function matchingShipmentsFor(item, progress) {
  const shipments = visibleShipments(item);
  if (progress === 'all') return shipments.filter(shipment => UNRECEIVED_PROGRESS.includes(shipmentProgress(shipment, item)));
  return shipments.filter((shipment) => shipmentProgress(shipment, item) === progress);
}

function summarizePackages(items, progress = 'all') {
  const scopedItems = Array.isArray(items)
    ? items.filter((item) => item && typeof item === 'object')
    : [];
  const selectedProgress = normalizedText(progress) || 'all';
  const selected = isProgressKey(selectedProgress) ? selectedProgress : 'all';
  const counts = Object.fromEntries(PROGRESS_KEYS.map((key) => [key, aggregateFor(scopedItems, key)]));
  const selectedCounts = counts[selected];
  const platforms = Object.fromEntries(['taobao', 'jd', 'pdd', 'manual', 'other'].map((platform) => {
    const platformItems = scopedItems.filter((item) => packagePlatform(item) === platform);
    return [platform, aggregateFor(platformItems, 'all')];
  }));
  return {
    progress: selected,
    orders: selectedCounts.orders,
    total: selectedCounts.total,
    onlineOrders: selectedCounts.onlineOrders,
    manual: scopedItems.filter(item => packagePlatform(item) === 'manual').length,
    platforms,
    pickup: counts.pickup.total,
    transit: counts.transit.total,
    waiting: counts.waiting.total,
    done: counts.done.total,
    other: counts.other.orders,
  };
}

export {
  packageDateKey,
  shouldArchivePackage,
  isPackageCollected,
  hasUncollectedPickup,
  packagePlatform,
  shipmentProgress,
  packageProgressMatches,
  summarizePackages,
};
