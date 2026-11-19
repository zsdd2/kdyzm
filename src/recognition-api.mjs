import { fail, hash, onlyKeys } from './security.mjs';
import { serverVersion } from './version.mjs';

export function createRecognitionApi({ store, workflow, recognitionAi, stations, logisticsRules, logisticsDaily, now }) {
  const readable = (device, task) => (task.candidateShipmentIds || [task.shipmentId]).every(id => store.canRead(device, store.shipment(id)));
  const issue = task => ({ id: task.clientId, revision: task.reportRevision, status: task.status,
    retryCount: task.retryCount, reasonCode: task.reasonCode, nextRetryAt: task.nextRetryAt || 0 });
  const issues = (device, accountIds) => workflow.tasks().filter(task => task.deviceId === device.id && readable(device, task)
    && (!accountIds?.length || (task.accountIds || [task.accountId]).every(id => accountIds.includes(id)))).slice(-100).map(issue);
  function submit(device, body) {
    onlyKeys(body, ['schemaVersion', 'items']);
    if (body.schemaVersion !== 1 || !Array.isArray(body.items) || body.items.length < 1 || body.items.length > 20)
      fail(400, 'INVALID_RECOGNITION_REPORT', '识别问题批次格式无效');
    for (const report of body.items) {
      if (!report || typeof report !== 'object' || !Array.isArray(report.candidateShipmentIds)) fail(400, 'INVALID_RECOGNITION_REPORT', '识别问题格式无效');
      const previous = workflow.tasks().find(task => task.deviceId === device.id && task.clientId === report.id);
      // Withdrawal belongs to the reporting device even after its parcel scope changes.
      if (report.state === 'withdrawn' && previous) continue;
      if (previous && !readable(device, previous)) fail(403, 'SCOPE_FORBIDDEN', '识别问题不在设备授权范围内');
      for (const id of report.candidateShipmentIds) {
        const shipment = store.shipment(id);
        if (!shipment || store.shipmentAlias(id).id !== id || !store.canRead(device, shipment)) fail(403, 'SCOPE_FORBIDDEN', '候选包裹不在设备授权范围内');
      }
    }
    const accepted = store.transaction(() => body.items.map(report => {
      const task = workflow.submit(report, { deviceId: device.id });
      return { id: task.clientId, revision: task.reportRevision };
    }));
    return { accepted, issues: issues(device) };
  }
  function review({ limit = 100, after = 0 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < 0)
      fail(400, 'INVALID_RECOGNITION_QUERY', '复盘分页参数无效');
    const samples = [];
    let cursor = after, more = false;
    // Bounded pages keep daily review off the collection path, including large old databases.
    const rows = store.db.prepare('SELECT rowid AS seq,id FROM shipments WHERE rowid>? ORDER BY rowid LIMIT 1000').all(after);
    for (const row of rows) {
      if (samples.length === limit) { more = true; break; }
      cursor = row.seq;
      const scope = workflow.scope(row.id);
      if (scope.closed) continue;
      const { shipment, account } = scope;
      samples.push({ shipmentId: shipment.id, orderId: shipment.orderId,
        evidenceKey: hash(JSON.stringify([shipment.status, shipment.station, shipment.pickupCode, shipment.arrivalAt, shipment.arrivalAtSource,
          shipment.shippedAt, shipment.shippedAtSource, shipment.pickupCycle, shipment.pickupCompletion, shipment.logisticsState, shipment.logisticsEvents])),
        platform: account.platform, status: shipment.status, station: shipment.station,
        logisticsState: shipment.logisticsState, arrivalAt: shipment.arrivalAt, arrivalAtSource: shipment.arrivalAtSource,
        arrivalAtPrecision: shipment.arrivalAtPrecision, blocked: !!scope.blocked,
        logisticsEvents: (shipment.logisticsEvents || []).slice(0, 12).map(({ time, timeText, description, provider }) =>
          ({ time, timeText, description: String(description || '').slice(0, 600), provider })) });
    }
    more ||= rows.length === 1000;
    const ai = stations.aiConfig();
    return { schemaVersion: 1, serverVersion, generatedAt: now(), nextCursor: more ? cursor : null,
      workflow: workflow.summary(), samples, learning: logisticsDaily.summary(), aiReviews: recognitionAi.reviews().slice(0, 100),
      rules: { stationVersion: stations.revision, logisticsVersion: logisticsRules.read().revision },
      ai: { enabled: ai.enabled, autoApply: ai.autoApply, dailyLimit: ai.dailyLimit, usageToday: ai.usageToday } };
  }
  return { issues, submit, review, readable };
}
