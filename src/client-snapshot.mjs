import { fail, hash } from './security.mjs';

const entities = ['orders', 'shipments', 'shipmentIdentifiers', 'shipmentAliases', 'hiddenIds', 'deletedIds', 'events'];

// Job progress and collection timestamps must not resend unchanged order histories.
export function clientSnapshot(snapshot, knownVersion = '') {
  if (knownVersion && !/^[a-f0-9]{64}$/.test(knownVersion)) fail(400, 'INVALID_CURSOR', '同步版本无效，请重新同步');
  const compact = { ...snapshot, projectionVersion: 2, serverLogisticsRules: [],
    shipments: snapshot.shipments.map(shipment => ({ ...shipment, logisticsEvents: [],
      logisticsEventCount: shipment.logisticsEventCount ?? shipment.logisticsEvents.length,
      detailsAvailable: shipment.detailsAvailable ?? (shipment.logisticsEvents.length > 0 || !!shipment.logisticsTruncated) })) };
  const identity = { serverVersion: snapshot.serverVersion, familyIds: snapshot.familyIds, legacyAccountIds: snapshot.legacyAccountIds,
    accounts: snapshot.accounts.map(({ id, familyId }) => ({ id, familyId })) };
  const dataVersion = hash(JSON.stringify([identity, ...entities.map(key => compact[key])],
    (key, value) => ['logisticsCheckedAt', 'logisticsDetailCheckedAt', 'logisticsUpdatedAt', 'dateCheckedAt', 'updatedAt'].includes(key) ? undefined : value));
  if (knownVersion !== dataVersion) return { ...compact, dataVersion, metadataOnly: false };
  const metadata = { ...compact, dataVersion, metadataOnly: true };
  for (const key of entities) delete metadata[key];
  return metadata;
}

export function shipmentDetails(store, device, id) {
  if (!/^[a-f0-9]{32}$/.test(id)) fail(400, 'INVALID_SHIPMENT', '运单标识无效');
  let shipment = store.shipment(store.shipmentAlias(id).id);
  const order = shipment && store.order(shipment.orderId);
  if (!shipment || !store.canRead(device, shipment) || !store.canRead(device, order)) fail(403, 'SCOPE_FORBIDDEN', '运单不在授权范围内');
  shipment = store.normalizedShipment(shipment, order);
  const result = { shipmentId: shipment.id, orderId: shipment.orderId, evidenceKey: store.shipmentView(shipment, order).evidenceKey,
    logisticsState: shipment.logisticsState || 'unavailable', logisticsEvents: [], logisticsTruncated: !!shipment.logisticsTruncated };
  let bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  for (const event of shipment.logisticsEvents || []) {
    const size = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1;
    if (bytes + size > 1800000) { result.logisticsTruncated = true; break; }
    result.logisticsEvents.push(event); bytes += size;
  }
  return result;
}
