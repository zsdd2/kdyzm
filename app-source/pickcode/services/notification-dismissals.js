const storageKey = 'pickcode.notification-dismissals.v1';
const limit = 200;

export function notificationScope(snapshot) {
  const online = snapshot?.online || {};
  return JSON.stringify([!!online.bound, online.baseUrl || '', online.deviceId || '',
    (online.accounts || []).map(account => String(account.id || '')).sort()]);
}

export function notificationVersion(notice) {
  const shipment = notice.receipt?.shipment, item = notice.item;
  return JSON.stringify([notice.kind, notice.title, notice.body, notice.time || 0, notice.progress || null,
    shipment ? [shipment.status, shipment.pickupCycle?.id, shipment.evidenceKey || shipment.platformView?.evidenceKey || shipment.logisticsEvents?.[0]] : null,
    notice.reminder ? [notice.reminder.date, notice.reminder.kind, notice.reminder.body] : null,
    item ? [item.pendingCount, item.unassignedPickedCount, item.conflicts, (item.sources || []).map(source => [source.sourceId,
      source.matchNeedsReview, source.linkedShipmentIds, (source.matchCandidates || []).map(candidate => [candidate.shipmentId, candidate.kind, candidate.decisionReason]).sort()]).sort()] : null,
    notice.completions?.map(entry => [entry.shipmentId, entry.shipment.pickupCompletion?.completedAt, entry.shipment.pickupCompletion?.evidence])]);
}

export function readNotificationDismissals(storage = globalThis.uni) {
  try {
    const raw = storage?.getStorageSync?.(storageKey);
    const rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(rows) ? rows.filter(row => row && typeof row.scope === 'string' && typeof row.id === 'string' && typeof row.version === 'string').slice(-limit) : [];
  } catch (_) { return []; }
}

export function visibleNotificationItems(items, dismissed, scope) {
  return items.filter(item => !dismissed.some(row => row.scope === scope && row.id === item.id && row.version === notificationVersion(item)));
}

export function dismissNotificationItem(dismissed, notice, scope, storage = globalThis.uni) {
  const next = dismissed.filter(row => row.scope !== scope || row.id !== notice.id)
    .concat({ scope, id: notice.id, version: notificationVersion(notice) }).slice(-limit);
  storage.setStorageSync(storageKey, JSON.stringify(next));
  return next;
}
