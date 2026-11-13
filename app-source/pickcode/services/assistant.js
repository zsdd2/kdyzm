import '../server/src/logistics-rules.js';
import '../core/pickcode-core.js';
import packageInfo from '../package.json' with { type: 'json' };

const core = globalThis.PickCodeCore;
const storageKey = 'pickcode.private.state.v1';
const ONLINE_IMPORT_VERSION = 328;
let initialization;
let initialized = false;
let snapshotInFlight;
let cachedSnapshot;
let snapshotEpoch = 0;
let bindingEpoch = 0;
const onlineSyncs = new Map();
let snapshotFramePending = false;
let nativeSyncing = false;
let activeSyncs = 0;
export function getSyncStatus() { return { syncing: nativeSyncing || activeSyncs > 0 }; }
function syncStatusChanged() { uni.$emit('assistant-sync-status', getSyncStatus()); }
async function trackSync(operation) {
  activeSyncs++; syncStatusChanged();
  try { return await operation(); }
  finally { activeSyncs--; syncStatusChanged(); }
}
// A late native reply can reach the next WebView document; counters alone collide after reload.
const requestSession = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
let serial = 0;
const pending = new Map();
// Browser credentials live only in memory, and the preview can contact loopback fixtures only.
let previewSession;
let previewSync;
let previewStationUpload;
let previewFeedbackUpload;
let previewRecognitionUpload;
let previewQueue = Promise.resolve();
function localDispatch(action, payload = {}) {
  const previous = uni.getStorageSync(storageKey) || '';
  const backupKey = 'pickcode.private.backup.pre-3.2.0';
  if (previous && !uni.getStorageSync(backupKey)) uni.setStorageSync(backupKey, previous);
  const { state, result } = JSON.parse(core.dispatch(previous, JSON.stringify({ action, payload })));
  if (action !== 'snapshot') uni.setStorageSync(storageKey, JSON.stringify(state));
  return result;
}
function previewAddress(value) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('网页预览仅支持本机联调服务；真实服务请使用 Android 安装版');
  return url.origin;
}
async function previewFetch(path, options = {}, authenticated = true, session = previewSession) {
  if (!session) throw new Error('请先绑定本机服务');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(session.baseUrl + path, { ...options, redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${session.token}` } : {}), ...options.headers } });
    if (response.status === 304) return { unchanged: true };
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > 4000000) throw new Error('线上响应过大，已保留本地记录');
    const data = JSON.parse(body);
    if (!response.ok) { const error = new Error(data.error?.message || '线上服务暂不可用'); error.status = response.status; error.code = response.status === 401 ? 'device_unauthorized' : data.error?.code; throw error; }
    return { data, etag: response.headers.get('ETag') };
  } finally { clearTimeout(timer); }
}
function matchingFeedbackEnabled(snapshot) {
  return snapshot.online?.bound && snapshot.online.capabilities?.includes('matching_feedback_v1')
    && (snapshot.settings?.manualLearning !== false || snapshot.matchingFeedback?.pendingWithdrawalCount > 0);
}
function recognitionEnabled(snapshot) {
  return snapshot.online?.bound && snapshot.online.capabilities?.includes('recognition_workflow_v1');
}
function recognitionBatch(items) {
  if (!Array.isArray(items)) return [];
  const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const text = (value, max) => {
    if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('识别问题格式无效');
    return value;
  };
  return items.slice(0, 20).map(item => {
    if (!item || !id(item.id) || !integer(item.revision) || item.revision < 1 || !id(item.sourceId)
      || item.kind !== 'unmatched_pickup' || !['unresolved', 'resolved', 'withdrawn'].includes(item.state) || !integer(item.observedAt) || item.source?.occurredAt !== null && !integer(item.source?.occurredAt)
      || !Array.isArray(item.candidateShipmentIds) || item.state !== 'withdrawn' && !item.candidateShipmentIds.length || item.candidateShipmentIds.length > 20 || !item.candidateShipmentIds.every(id)
      || !Array.isArray(item.reasonCodes) || item.reasonCodes.length > 20 || !item.reasonCodes.every(reason => typeof reason === 'string' && /^[a-z_]{1,80}$/u.test(reason))) throw new Error('识别问题格式无效');
    const source = { occurredAt: item.source.occurredAt };
    for (const [key, max] of [['station', 120], ['carrier', 40], ['waybillNo', 32], ['pickupCode', 12], ['fragment', 120]]) source[key] = text(item.source[key], max);
    if ([source.station, source.fragment, source.carrier].some(value => /https?:\/\/|www\.|[0-9]{6,}|验证码|密码|取件码|取货码|手机号|运单号|订单号|先生|女士|收件人/iu.test(value))
      || source.waybillNo && !/^[A-Za-z0-9-]{6,32}$/u.test(source.waybillNo)
      || source.pickupCode && !core.validCode(source.pickupCode)) throw new Error('识别问题片段须先脱敏');
    source.waybillNo = ''; source.pickupCode = '';
    return { id: item.id, revision: item.revision, kind: item.kind, state: item.state, sourceId: item.sourceId, observedAt: item.observedAt, source,
      candidateShipmentIds: [...new Set(item.candidateShipmentIds)], reasonCodes: [...new Set(item.reasonCodes)] };
  });
}
function recognitionAck(items, data) {
  if (!Array.isArray(data?.accepted) || !Array.isArray(data?.issues)) throw new Error('识别问题尚未获后台确认');
  const sent = new Set(items.map(item => item.id + ':' + item.revision)), seen = new Set();
  const exact = item => item && Number.isSafeInteger(item.revision) && sent.has(item.id + ':' + item.revision);
  return { accepted: data.accepted.filter(item => {
    const key = item?.id + ':' + item?.revision;
    if (!exact(item) || seen.has(key)) return false;
    seen.add(key); return true;
  }).map(({ id, revision }) => ({ id, revision })),
  issues: data.issues.filter(item => exact(item) && ['pending', 'retrying', 'ai_pending', 'ai_running', 'review', 'resolved', 'failed', 'ignored', 'blocked'].includes(item.status))
    .map(item => ({ id: item.id, revision: item.revision, status: item.status, retryCount: Number.isSafeInteger(item.retryCount) && item.retryCount >= 0 && item.retryCount <= 1000 ? item.retryCount : 0,
      reasonCode: typeof item.reasonCode === 'string' && /^[A-Za-z0-9_]{0,80}$/u.test(item.reasonCode) ? item.reasonCode : '',
      nextRetryAt: Number.isSafeInteger(item.nextRetryAt) && item.nextRetryAt > 0 ? item.nextRetryAt : 0 })) };
}
function uploadPreviewRecognitionIssues() {
  const session = previewSession;
  if (!session?.token || !recognitionEnabled(localDispatch('snapshot'))) return;
  if (previewRecognitionUpload?.session === session) { previewRecognitionUpload.changed = true; return; }
  const operation = { session, changed: false };
  previewRecognitionUpload = operation;
  operation.promise = (async () => {
    try {
      const items = recognitionBatch(localDispatch('recognitionIssueBatch').items);
      if (!items.length) return;
      const { data } = await previewFetch('/v1/recognition-issues', { method: 'POST', priority: 'low', body: JSON.stringify({ schemaVersion: 1, items }) }, true, session);
      if (previewSession !== session || !recognitionEnabled(localDispatch('snapshot'))) return;
      changed(localDispatch('recognitionIssueAck', recognitionAck(items, data)));
    } catch (_) {
      if (previewSession === session && recognitionEnabled(localDispatch('snapshot'))) changed(localDispatch('recognitionIssueFailed'));
    }
  })().finally(() => {
    if (previewRecognitionUpload !== operation) return;
    previewRecognitionUpload = undefined;
    if (operation.changed && previewSession === session) uploadPreviewRecognitionIssues();
  });
}
function matchingFeedbackBatch(items) {
  if (!Array.isArray(items)) return [];
  const text = (value, max = 128) => {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('人工确认样本格式无效');
    return value.trim();
  };
  return items.slice(0, 20).map(item => {
    if (!item || !/^[A-Za-z0-9_-]{1,128}$/u.test(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1
      || !['upsert', 'withdraw'].includes(item.action)) throw new Error('人工确认样本格式无效');
    const safe = { id: item.id, revision: item.revision, action: item.action };
    if (safe.action === 'withdraw') return safe;
    if (!['station_correction', 'manual_match'].includes(item.kind) || !['', 'station_correction', 'manual_match', 'user_confirmed'].includes(item.reason || '')) throw new Error('人工确认样本格式无效');
    Object.assign(safe, { kind: item.kind, reason: item.reason || '' });
    for (const key of ['shipmentId', 'targetStationId']) {
      safe[key] = text(item[key]);
      if (safe[key] && !/^[A-Za-z0-9_-]{1,128}$/u.test(safe[key])) throw new Error('人工确认样本格式无效');
    }
    for (const key of ['stationName', 'otherStationName', 'subLocation']) {
      safe[key] = text(item[key], key === 'subLocation' ? 60 : 120);
      if (/https?:\/\/|www\.|[0-9]{6,}|验证码|取件码|取货码|提货码|手机号|运单号|订单号/iu.test(safe[key])) throw new Error('人工确认样本须先脱敏');
    }
    if (safe.kind === 'manual_match' && !safe.shipmentId || safe.kind === 'station_correction' && !safe.targetStationId) throw new Error('人工确认样本格式无效');
    return safe;
  });
}
function matchingFeedbackAck(items, data) {
  if (!Array.isArray(data?.accepted) || !Array.isArray(data?.items)
    || ['configured', 'enabled', 'autoApply'].some(key => typeof data[key] !== 'boolean')) throw new Error('人工确认样本尚未获后台确认');
  const sent = new Set(items.map(item => item.id + ':' + item.revision)), seen = new Set();
  const exact = item => item && Number.isSafeInteger(item.revision) && item.revision > 0 && sent.has(item.id + ':' + item.revision);
  return {
    accepted: data.accepted.filter(item => {
      const key = item?.id + ':' + item?.revision;
      if (!exact(item) || seen.has(key)) return false;
      seen.add(key); return true;
    }).map(({ id, revision }) => ({ id, revision })),
    items: data.items.filter(item => exact(item) && ['pending', 'applied', 'review', 'failed', 'withdrawn', 'rejected'].includes(item.status))
      .map(item => ({ id: item.id, revision: item.revision, status: item.status,
        reasonCode: typeof item.reasonCode === 'string' ? item.reasonCode.slice(0, 80) : '', message: typeof item.message === 'string' ? item.message.slice(0, 300) : '', ruleVersion: Number.isSafeInteger(item.ruleVersion) ? item.ruleVersion : 0,
        candidateId: typeof item.candidateId === 'string' ? item.candidateId.slice(0, 128) : '',
        error: typeof item.error === 'string' ? item.error.slice(0, 300) : '', updatedAt: Number.isSafeInteger(item.updatedAt) && item.updatedAt > 0 ? item.updatedAt : 0 })),
    configured: data.configured, enabled: data.enabled, autoApply: data.autoApply,
  };
}
function uploadPreviewMatchingFeedback() {
  const session = previewSession, snapshot = localDispatch('snapshot');
  if (!session?.token || !matchingFeedbackEnabled(snapshot)) return;
  if (previewFeedbackUpload?.session === session) { previewFeedbackUpload.changed = true; return; }
  const operation = { session, changed: false };
  previewFeedbackUpload = operation;
  operation.promise = (async () => {
    try {
      const items = matchingFeedbackBatch(localDispatch('matchingFeedbackBatch').items);
      if (!items.length) return;
      localDispatch('matchingFeedbackAttempt', { items });
      const { data } = await previewFetch('/v1/matching-feedback', { method: 'POST', body: JSON.stringify({ items }) }, true, session);
      if (previewSession !== session || !matchingFeedbackEnabled(localDispatch('snapshot'))) return;
      changed(localDispatch('matchingFeedbackAck', matchingFeedbackAck(items, data)));
    } catch (_) {
      if (previewSession === session && matchingFeedbackEnabled(localDispatch('snapshot'))) changed(localDispatch('matchingFeedbackFailed'));
    }
  })().finally(() => {
    if (previewFeedbackUpload !== operation) return;
    previewFeedbackUpload = undefined;
    // An edit/withdrawal made while this version was in flight gets one fresh attempt.
    if (operation.changed && previewSession === session) uploadPreviewMatchingFeedback();
  });
}
async function acknowledgePreviewStationRules(session) {
  const receipt = localDispatch('stationRuleReceiptBatch');
  if (!receipt.pending) return;
  const body = { stationRulesVersion: receipt.stationRulesVersion, serverLogisticsRulesVersion: receipt.serverLogisticsRulesVersion };
  try {
    const { data } = await previewFetch('/v1/station-rule-receipts', { method: 'POST', body: JSON.stringify(body) }, true, session);
    if (previewSession === session && data.accepted === true) localDispatch('stationRuleReceiptAck', body);
  } catch (_) { /* The persisted import remains valid; the next synchronization retries its receipt. */ }
}
function uploadPreviewStationCandidates() {
  const session = previewSession;
  const snapshot = localDispatch('snapshot');
  if (previewStationUpload || !session?.token || !snapshot.settings.stationEnhancement || !snapshot.online.capabilities?.includes('station_aliases_v1')) return;
  const { items } = localDispatch('stationCandidateBatch');
  if (!items.length) return;
  // This optional request runs independently of order synchronization and carries only public place fragments.
  previewStationUpload = (async () => {
    try {
      const { data } = await previewFetch('/v1/station-candidates', { method: 'POST', body: JSON.stringify({ items }) });
      if (previewSession !== session || !localDispatch('snapshot').settings.stationEnhancement) return;
      if (!Array.isArray(data.acceptedIds)) throw new Error('站点片段尚未获后台确认');
      changed(localDispatch('stationCandidateAck', { acceptedIds: data.acceptedIds.filter(id => items.some(item => item.id === id)), uploadedAt: Date.now() }));
    } catch (_) {
      if (previewSession === session && localDispatch('snapshot').settings.stationEnhancement) changed(localDispatch('stationCandidateFailed'));
    }
  })().finally(() => { previewStationUpload = undefined; });
}
async function previewOnline(action, payload) {
  if (action === 'onlineStatus') return { ...localDispatch('snapshot').online, bound: !!previewSession?.token };
  if (action === 'aiChannels') {
    const session = previewSession;
    const { data } = await previewFetch('/v1/ai/channels');
    if (session !== previewSession) throw new Error('后台绑定已变更，请重新选择渠道');
    return data;
  }
  if (action === 'stationProposal') {
    if (!previewSession?.token || !localDispatch('snapshot').online.capabilities?.includes('station_aliases_v1')) throw new Error('请先绑定支持站点管理的后台');
    const proposal = { stationName: payload.stationName, otherStationName: payload.otherStationName, subLocation: payload.subLocation || '' };
    return (await previewFetch('/v1/station-proposals', { method: 'POST', body: JSON.stringify(proposal) })).data;
  }
  if (action === 'bindOnline') {
    const baseUrl = previewAddress(payload.baseUrl);
    const previous = previewSession;
    previewSession = { baseUrl };
    try {
      const { data } = await previewFetch('/v1/devices', { method: 'POST', body: JSON.stringify({ code: payload.code, deviceName: '本机网页联调' }) }, false);
      if (!data.token || !data.deviceId) throw new Error('绑定响应不完整');
      previewSession = { baseUrl, token: data.token, deviceId: data.deviceId };
      return localDispatch('syncMeta', { bound: true, baseUrl, deviceId: data.deviceId, accounts: data.accounts || [], ...(data.familyIds ? { families: data.families || [], familyIds: data.familyIds, legacyAccountIds: data.legacyAccountIds || [] } : {}), lastSuccessAt: 0, error: '', errorCode: '' });
    } catch (error) { previewSession = previous; throw error; }
  }
  if (action === 'unbindOnline') {
    let message = '';
    try { if (previewSession) await previewFetch('/v1/devices/current', { method: 'DELETE' }); }
    catch (_) { message = '本机已解绑；服务端撤销未完成，可在后台撤销设备'; }
    previewSession = undefined;
    return localDispatch('syncMeta', { bound: false, baseUrl: '', deviceId: '', accounts: [], error: message, errorCode: message ? 'revoke_pending' : '' });
  }
  if (action === 'shipmentDetails') {
    const session = previewSession, target = localDispatch('shipmentDetailTarget', { id: payload.id });
    if (!session?.token) throw new Error('请先连接后台，已有物流缓存已保留');
    const { data } = await previewFetch('/v1/shipments/' + encodeURIComponent(target.remoteId) + '/logistics', {}, true, session);
    if (previewSession !== session) throw new Error('后台绑定已变更，请重新打开详情');
    return localDispatch('importShipmentDetails', { ...data, id: target.id, bindingKey: target.bindingKey });
  }
  if (previewSync) return previewSync;
  previewSync = (async () => {
    if (!previewSession?.token) throw new Error('请先绑定线上服务');
    try {
      const readSnapshot = async () => {
        const cachedOnline = localDispatch('snapshot').online;
        const reusable = cachedOnline.importVersion >= ONLINE_IMPORT_VERSION && !cachedOnline.needsPickupSync;
        const dataVersion = reusable ? cachedOnline.dataVersion || '' : '';
        const result = await previewFetch('/v1/snapshot?view=compact' + (dataVersion ? '&dataVersion=' + encodeURIComponent(dataVersion) : ''), { headers: previewSession.etag && !payload.force && action !== 'refreshOrder' && reusable ? { 'If-None-Match': previewSession.etag } : {} });
        if (!result.unchanged) {
          const current = localDispatch('snapshot').online;
          if (result.data.serverRevision < Math.max(current.serverRevision, current.metadataRevision || 0)) throw new Error('后台返回旧版本数据，已保留本地记录，请稍后重试');
          if (result.data.metadataOnly) {
            if (!dataVersion || result.data.dataVersion !== dataVersion) throw new Error('同步数据版本不匹配，请重新同步');
            localDispatch('syncMetadata', { meta: result.data, dataVersion, syncedAt: Date.now() });
          } else {
            localDispatch('syncImport', { snapshot: result.data, syncedAt: Date.now(), importVersion: ONLINE_IMPORT_VERSION });
            previewSession.jobOrders = new Set((result.data.orders || []).map(order => order.id));
          }
          previewSession.jobAccounts = new Set((result.data.accounts || []).map(account => account.id));
          previewSession.snapshotJobIds = new Set((result.data.syncJobs || []).map(job => job.id));
          previewSession.etag = result.etag;
        }
      };
      await readSnapshot();
      // Read current grants before replaying offline operations or polling old tasks.
      const operations = localDispatch('snapshot').operations;
      if (operations.length) {
        const { data } = await previewFetch('/v1/operations', { method: 'POST', body: JSON.stringify({ operations }) });
        localDispatch('syncAck', { appliedIds: (data.appliedIds || []).filter(id => operations.some(op => op.id === id)) });
        await readSnapshot();
      }
      const jobAllowed = job => job.orderId ? previewSession.jobOrders?.has(job.orderId) : previewSession.jobAccounts?.has(job.accountId);
      const online = localDispatch('snapshot').online;
      const now = Date.now();
      const conditional = !payload.force && action !== 'refreshOrder' && online.capabilities?.includes('conditionalSync')
        && (online.accounts || []).some(account => account.id && account.enabled !== false && account.status !== 'expired'
          && !(online.jobs || []).some(job => jobAllowed(job) && job.accountId === account.id && ['queued', 'running'].includes(job.state))
          && (!Number.isSafeInteger(account.lastFullSuccessAt) || account.lastFullSuccessAt <= 0 || account.lastFullSuccessAt > now
            || now - account.lastFullSuccessAt > 30 * 60000));
      let needsSnapshot = false;
      if (payload.force || action === 'refreshOrder' || conditional) {
        if (!online.capabilities?.includes('syncJobs') || (action === 'refreshOrder' && !online.capabilities?.includes('orderRefresh'))) throw new Error('请先将后台升级到3.1.5或以上版本，再重新获取订单');
        const path = action === 'refreshOrder' ? '/v1/orders/' + encodeURIComponent(localDispatch('onlineOrderTarget', { id: payload.id }).orderId) + '/refresh' : '/v1/accounts/sync';
        const { data } = await previewFetch(path, { method: 'POST', body: conditional ? JSON.stringify({ onlyIfStale: true }) : '{}' });
        if (!Array.isArray(data.jobs)) throw new Error('后台未返回采集任务，请升级后台后重试');
        const retained = (online.jobs || []).filter(job => jobAllowed(job) && !data.jobs.some(next => next.id === job.id) && (['queued','running'].includes(job.state) || !data.jobs.some(next => next.accountId === job.accountId && (!next.orderId || next.orderId === job.orderId))));
        localDispatch('syncMeta', { jobs: retained.concat(data.jobs) });
        needsSnapshot = !conditional || data.jobs.length > 0;
      }
      if (!needsSnapshot) {
        let detailRequests = 0;
        const jobs = await Promise.all((online.jobs || []).filter(jobAllowed).map(async job => {
          if (!['queued','running'].includes(job.state) || previewSession.snapshotJobIds?.has(job.id)) return job;
          if (detailRequests++ >= 3) return job;
          needsSnapshot = true;
          try {
            const { data } = await previewFetch('/v1/sync-jobs/' + encodeURIComponent(job.id));
            return data.job;
          } catch (error) {
            if (error.status === 403 && error.code === 'SCOPE_FORBIDDEN') return null;
            if (error.status !== 404 || error.code !== 'NOT_FOUND') throw error;
            return { ...job, state: 'error', retryAt: 0, error: '后台任务状态已失效，请重新刷新' };
          }
        }));
        localDispatch('syncMeta', { jobs: jobs.filter(Boolean) });
      }
      // A completed job can advance the snapshot after the first conditional read.
      if (needsSnapshot) await readSnapshot();
      await acknowledgePreviewStationRules(previewSession);
      const result = localDispatch('syncMeta', { lastSuccessAt: Date.now(), error: '', errorCode: '' });
      uploadPreviewStationCandidates();
      uploadPreviewMatchingFeedback();
      uploadPreviewRecognitionIssues();
      return result;
    } catch (error) {
      if (error.code === 'device_unauthorized') previewSession = undefined;
      return localDispatch('syncMeta', { ...(error.code === 'device_unauthorized' ? { bound: false } : {}), error: error.message || '同步失败，保留本地记录', errorCode: error.code || 'network_error' });
    }
  })().finally(() => { previewSync = undefined; });
  return previewSync;
}

function nativeBridge() { return typeof window !== 'undefined' && window.PickCodeNative; }
function rememberSnapshot(snapshot) {
  if (Array.isArray(snapshot?.codes) && Array.isArray(snapshot?.packages) && snapshot !== cachedSnapshot) {
    cachedSnapshot = snapshot;
    snapshotEpoch++;
  }
  return snapshot;
}
export function getCachedSnapshot() { return cachedSnapshot; }
function overviewOf(snapshot) {
  return { online: snapshot.online || {}, stats: {
    total: snapshot.codes.reduce((n, item) => n + (item.totalCount || 1), 0),
    picked: snapshot.codes.reduce((n, item) => n + (item.totalCount || 1) - (item.pendingCount ?? (item.isPicked ? 0 : 1)), 0),
  } };
}
function afterDisplayFrame(callback) {
  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    window.requestAnimationFrame(() => window.requestAnimationFrame(callback));
  } else callback();
}
function snapshotForDisplay(snapshot) {
  if (nativeBridge() && typeof window.requestAnimationFrame === 'function' && !snapshotFramePending) {
    snapshotFramePending = true;
    // Promise/Vue updates settle before the first frame; automatic work starts after that frame is painted.
    afterDisplayFrame(() => {
      snapshotFramePending = false;
      request('snapshotVisible').catch(() => {});
    });
  }
  return snapshot;
}

function browserUpdateStatus() {
  return {
    native: false,
    currentVersionName: packageInfo.version,
    currentVersionCode: 0,
    state: 'unsupported',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    release: null,
    error: '网页预览不支持在线更新，请使用 Android 安装版',
    canInstall: false,
  };
}
if (typeof window !== 'undefined') {
  window.addEventListener('pickcode-native', event => {
    const reply = event.detail;
    const operation = reply && pending.get(reply.id);
    if (!operation) return;
    clearTimeout(operation.timer);
    pending.delete(reply.id);
    if (reply.ok) operation.resolve(reply.data);
    else operation.reject(new Error(reply.error || '操作失败，请重试'));
  });
  window.addEventListener('pickcode-resume', () => {
    getSnapshot(false).then(changed).catch(() => { /* Visible pages show retryable load errors. */ });
  });
  window.addEventListener('pickcode-sync-status', event => {
    nativeSyncing = event.detail?.syncing === true;
    syncStatusChanged();
  });
}

function request(action, payload = {}) {
  const reading = ['snapshot', 'overview', 'onlineStatus'].includes(action);
  if (['bindOnline', 'unbindOnline'].includes(action)) { bindingEpoch++; onlineSyncs.clear(); }
  const epoch = snapshotEpoch, binding = bindingEpoch;
  return requestTransport(action, payload).then(result => {
    const full = Array.isArray(result?.codes) && Array.isArray(result?.packages);
    const versioned = Number.isSafeInteger(result?.localRevision) && result.localRevision >= 0
      && Number.isSafeInteger(cachedSnapshot?.localRevision) && cachedSnapshot.localRevision >= 0;
    if (versioned && result.localRevision < cachedSnapshot.localRevision) {
      if (full) return cachedSnapshot;
      if (action === 'overview') return overviewOf(cachedSnapshot);
    }
    // Reads can finish after a mutation; mutations themselves follow commit/completion order.
    if (cachedSnapshot && (reading && !versioned && epoch !== snapshotEpoch || binding !== bindingEpoch)) {
      if (action === 'overview') return overviewOf(cachedSnapshot);
      if (action === 'onlineStatus') return cachedSnapshot.online;
      if (full && (reading || ['syncOnline', 'refreshOrder', 'bindOnline', 'unbindOnline'].includes(action))) return cachedSnapshot;
      // A local write may commit before a new binding but reply after it; read both committed results.
      if (full) return request('snapshot');
    }
    return rememberSnapshot(result);
  });
}
function requestTransport(action, payload = {}) {
  const bridge = nativeBridge();
  if (bridge) return new Promise((resolve, reject) => {
    const id = `request-${requestSession}-${++serial}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('操作超时，请检查连接后重试')); }, action === 'savePickupImage' ? 600000 : action === 'generateTemplate' ? 90000 : 60000);
    pending.set(id, { resolve, reject, timer });
    try { bridge.request(id, JSON.stringify({ action, payload })); }
    catch (_) { clearTimeout(timer); pending.delete(id); reject(new Error('原生服务暂不可用')); }
  });
  if (action === 'onlineStatus') return previewOnline(action, payload);
  if (action === 'overview') return Promise.resolve(overviewOf(localDispatch('snapshot')));
  if (action === 'aiChannels') return previewOnline(action, payload);
  if (action === 'shipmentDetails') return previewOnline(action, payload);
  if (action === 'aiOptimizationStatus') return Promise.resolve({ enabled: false, channelId: '', pending: [], supported: false });
  if (['bindOnline','syncOnline','unbindOnline','refreshOrder','stationProposal'].includes(action)) {
    previewQueue = previewQueue.catch(() => {}).then(() => previewOnline(action, payload));
    return previewQueue;
  }
  if (['appUpdateStatus', 'checkAppUpdate', 'downloadAppUpdate', 'cancelAppUpdate', 'installAppUpdate'].includes(action)) {
    return Promise.resolve(browserUpdateStatus());
  }
  try {
    if (action === 'status') {
      const { result } = JSON.parse(core.dispatch(uni.getStorageSync(storageKey) || '', JSON.stringify({ action: 'snapshot' })));
      return Promise.resolve({ native: false, smsPermission: false, autoScan: result.settings.autoScan, lastScanAt: result.lastScanAt, batteryRestricted: false, widgetSupported: false, aiConfigured: false, aiModel: 'deepseek-flash' });
    }
    if (['scan','requestSmsPermission','openSystemSettings','pinWidget','setAiKey','generateTemplate','openShoppingApp', 'configureAiOptimization', 'approveAiProposal', 'ignoreAiProposal', 'analyzeAiProposals'].includes(action)) throw new Error('请在 Android 安装版中使用此功能');
    return Promise.resolve(localDispatch(action, payload));
  } catch (error) { return Promise.reject(error); }
}

async function initialize(refreshDisplay = true) {
  let snapshot = await request('snapshot', { refresh: refreshDisplay });
  const readLegacy = key => {
    const value = uni.getStorageSync(key);
    if (!value) return [];
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed)) throw new Error('原有数据格式异常，已保留原始数据，请先检查备份');
    return parsed;
  };
  // Never overwrite or remove the original keys. A failed migration is retried without data loss.
  if (!snapshot.migrated) snapshot = await request('migrate', { legacyCodes: readLegacy('packageCodes'), legacyRules: readLegacy('matchRulesList') });
  if (!snapshot.packagesMigrated) snapshot = await request('migratePackages', { legacyPackages: readLegacy('packageData') });
  if (!nativeBridge() && !previewSession && snapshot.online?.bound) snapshot = await request('syncMeta', { bound: false, errorCode: 'preview_session_expired', error: '网页重载后请重新绑定本机联调服务' });
  initialized = true;
  return snapshotForDisplay(snapshot);
}
function ready(refreshDisplay = true) {
  if (!initialization) initialization = initialize(refreshDisplay).catch(error => { initialization = undefined; throw error; });
  return initialization;
}
function changed(snapshot) { rememberSnapshot(snapshot); uni.$emit('assistant-changed', snapshot); return snapshot; }
export function getSnapshot(refreshDisplay = true) {
  if (!initialized) return ready(refreshDisplay);
  if (!snapshotInFlight) snapshotInFlight = request('snapshot', { refresh: refreshDisplay }).then(snapshotForDisplay).finally(() => { snapshotInFlight = undefined; });
  return snapshotInFlight;
}
export async function mutate(action, payload = {}) {
  await ready();
  const snapshot = changed(await request(action, payload));
  if (!nativeBridge() && ['settings', 'linkSource', 'unlinkSource', 'setStation', 'resetStation', 'remove', 'ignore'].includes(action)) uploadPreviewMatchingFeedback();
  if (!nativeBridge() && ['settings', 'ingest', 'linkSource', 'unlinkSource', 'setStation', 'resetStation', 'refreshStations', 'ignore', 'remove', 'restore'].includes(action)) uploadPreviewRecognitionIssues();
  return snapshot;
}
export async function testLogisticsRule(rule, sample) { await ready(); return request('testLogisticsRule', { rule, sample }); }
export async function scanSms() { await ready(); return changed(await request('scan')); }
export async function getRuntimeStatus() { await ready(); return request('status'); }
export function getAppUpdateStatus() { return request('appUpdateStatus'); }
export function checkAppUpdate() { return request('checkAppUpdate'); }
export function downloadAppUpdate() { return request('downloadAppUpdate'); }
export function cancelAppUpdate() { return request('cancelAppUpdate'); }
export function installAppUpdate() { return request('installAppUpdate'); }
export async function getOnlineStatus() {
  const firstRead = !initialized;
  await ready();
  return firstRead ? cachedSnapshot.online : request('onlineStatus');
}
export async function getOverview() {
  const firstRead = !initialized;
  await ready();
  return firstRead ? overviewOf(cachedSnapshot) : request('overview');
}
export async function proposeStation(payload) { await ready(); return request('stationProposal', payload); }
export async function bindOnline(baseUrl, code) { await ready(); return changed(await request('bindOnline', { baseUrl, code })); }
export function syncOnline(force = false) {
  force = !!force;
  if (onlineSyncs.has(force)) return onlineSyncs.get(force);
  const operation = (async () => {
    await ready();
    if (!force && typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') await new Promise(afterDisplayFrame);
    return trackSync(async () => changed(await request('syncOnline', { force })));
  })().finally(() => { if (onlineSyncs.get(force) === operation) onlineSyncs.delete(force); });
  onlineSyncs.set(force, operation);
  return operation;
}
let refreshInFlight;
let onlineRefreshInFlight;
const orderRefreshes = new Map();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function jobOutcome(snapshot) {
  const online = snapshot.online || {}, jobs = online.jobs || [];
  const pending = jobs.some(job => ['queued','running'].includes(job.state));
  const failed = jobs.find(job => ['error','disabled','expired'].includes(job.state) || job.state === 'completed' && job.error && !job.dateError && !job.logisticsError);
  const collectionError = ['collection_incomplete','collection_retryable'].includes(online.errorCode);
  let error = collectionError ? '' : online.error || '';
  if (!error && failed) {
    error = failed.state === 'expired' ? '账号登录已失效，请在后台更新' : failed.state === 'disabled' ? '账号已停用，请在后台启用' : failed.error || '后台采集失败，请稍后重试';
  }
  const notices = jobs.filter(job => job.state === 'completed').flatMap(job => [job.dateError, job.logisticsError]).filter(Boolean);
  const notice = online.notice || [...new Set(notices)].join('；');
  const cooldown = jobs.find(job => job.state === 'cooldown');
  if (!error && cooldown) error = cooldown.retryAt > Date.now() ? '后台处于采集冷却期，请稍后重新获取' : '本次采集未执行，现可重新获取订单';
  return { pending, error, notice, blocked: !!online.error && !collectionError };
}
async function waitForOnline(snapshot, onProgress) {
  const deadline = Date.now() + 25000;
  const jobIds = new Set((snapshot.online?.jobs || []).filter(job => ['queued', 'running'].includes(job.state)).map(job => job.id));
  let outcome = jobOutcome(snapshot);
  let firstPoll = true;
  while (outcome.pending && !outcome.blocked && Date.now() < deadline) {
    const cooling = snapshot.online.jobs.some(job => job.state === 'queued' && job.retryAt > Date.now());
    const jobs = snapshot.online.jobs.filter(job => ['queued', 'running'].includes(job.state));
    const progress = logisticsProgressText(snapshot.online.jobs.filter(job => jobIds.has(job.id)));
    const retrying = jobs.some(job => job.throttled === true || job.continuation === true && job.state === 'queued');
    onProgress?.({ label: progress ? `${progress}${retrying ? '，等待自动继续…' : '…'}` : cooling ? '已排队，冷却结束后将自动获取订单…' : '后台正在获取订单与物流…' });
    await delay(firstPoll && !cooling ? 300 : 1500);
    firstPoll = false;
    snapshot = await syncOnline(false);
    outcome = jobOutcome(snapshot);
  }
  const pendingJobs = (snapshot.online?.jobs || []).filter(job => ['queued', 'running'].includes(job.state));
  const continuing = pendingJobs.some(job => job.continuation === true) || !!logisticsProgressText(pendingJobs);
  const pendingNotice = outcome.pending ? continuing ? [logisticsProgressText((snapshot.online?.jobs || []).filter(job => jobIds.has(job.id))), '后台会自动继续查询，稍后刷新查看结果'].filter(Boolean).join('，') : '后台仍在处理中，稍后刷新查看' : '';
  return { snapshot, onlineError: outcome.error, onlineNotice: outcome.notice, pending: outcome.pending, pendingNotice };
}
function logisticsProgressText(jobs) {
  const progress = jobs.map(job => job.logisticsProgress).filter(value => value && Number.isFinite(value.total) && value.total > 0 && value.total <= 100000 && Number.isFinite(value.completed) && value.completed >= 0 && value.completed <= value.total);
  if (!progress.length) return '';
  const total = progress.reduce((sum, value) => sum + Math.floor(value.total), 0), completed = progress.reduce((sum, value) => sum + Math.floor(value.completed), 0);
  return `物流查询任务 ${completed}/${total}`;
}
export function refreshOnline(onProgress) {
  if (onlineRefreshInFlight) return onlineRefreshInFlight;
  onlineRefreshInFlight = (async () => {
    await ready();
    return waitForOnline(await syncOnline(true), onProgress);
  })().finally(() => { onlineRefreshInFlight = undefined; });
  return onlineRefreshInFlight;
}
let smsRefreshInFlight;
export function scanAndMatch() {
  if (smsRefreshInFlight) return smsRefreshInFlight;
  smsRefreshInFlight = (async () => {
    await ready();
    let smsError = '';
    try {
      let status = await getRuntimeStatus();
      if (!status.native) throw new Error('短信匹配请使用 Android 安装版');
      if (!status.smsPermission) { await requestSmsPermission(); status = await getRuntimeStatus(); }
      if (!status.smsPermission) throw new Error('尚未获得短信权限');
      await scanSms();
    } catch (error) { smsError = error.message || '短信扫描失败，已有记录已保留'; }
    return { snapshot: changed(await request('refreshStations')), smsError };
  })().finally(() => { smsRefreshInFlight = undefined; });
  return smsRefreshInFlight;
}
const detailRequests = new Map();
export function loadShipmentDetails(id) {
  const key = bindingEpoch + ':' + id;
  if (detailRequests.has(key)) return detailRequests.get(key);
  const operation = ready().then(() => request('shipmentDetails', { id })).then(changed)
    .finally(() => { if (detailRequests.get(key) === operation) detailRequests.delete(key); });
  detailRequests.set(key, operation);
  return operation;
}
export function refreshAll(onProgress) {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    await ready();
    let smsError = '', onlineError = '', onlineNotice = '', pending = false, pendingNotice = '';
    const scan = async () => {
      try {
        onProgress?.({ label: '正在匹配短信并刷新订单…' });
        let status = await getRuntimeStatus();
        if (!status.native) throw new Error('短信匹配请使用 Android 安装版');
        if (!status.smsPermission) { await requestSmsPermission(); status = await getRuntimeStatus(); }
        if (!status.smsPermission) throw new Error('尚未获得短信权限，订单刷新可正常进行');
        await scanSms();
      } catch (error) { smsError = error.message || '短信匹配失败'; }
    };
    const online = async () => {
      try {
        if (!(await getSnapshot()).online?.bound) return;
        const result = await refreshOnline(onProgress);
        onlineError = result.onlineError; onlineNotice = result.onlineNotice; pending = result.pending; pendingNotice = result.pendingNotice;
      } catch (error) { onlineError = error.message || '订单刷新失败，已保留本地记录'; }
    };
    await Promise.all([scan(), online()]);
    return { snapshot: changed(await request('refreshStations')), smsError, onlineError, onlineNotice, pending, pendingNotice };
  })().finally(() => { refreshInFlight = undefined; });
  return refreshInFlight;
}
export function refreshOrder(id, onProgress) {
  if (orderRefreshes.has(id)) return orderRefreshes.get(id);
  const operation = (async () => {
    await ready();
    onProgress?.({ label: '正在重新获取该订单…' });
    const result = await waitForOnline(changed(await request('refreshOrder', { id })), onProgress);
    return { ...result, smsError: '' };
  })().finally(() => orderRefreshes.delete(id));
  orderRefreshes.set(id, operation);
  return operation;
}
export async function unbindOnline() { await ready(); return changed(await request('unbindOnline')); }
export function requestSmsPermission() { return request('requestSmsPermission'); }
export function openSystemSettings(page = 'app') { return request('openSystemSettings', { page }); }
export function pinWidget(size) { return request('pinWidget', { size }); }
export function openShoppingApp(platform) { return request('openShoppingApp', { platform }); }
export function dialPhone(phone) {
  if (typeof phone !== 'string' || phone !== phone.trim() || !/^\+?[0-9]{5,15}$/.test(phone)) return Promise.reject(new Error('电话号码格式无效'));
  if (nativeBridge()) return request('dialPhone', { phone });
  if (typeof uni === 'undefined' || typeof uni.makePhoneCall !== 'function') return Promise.reject(new Error('当前环境无法打开拨号界面'));
  return new Promise((resolve, reject) => {
    uni.makePhoneCall({ phoneNumber: phone, success: () => resolve({ opened: true }), fail: () => reject(new Error('无法打开拨号界面，请手动拨打')) });
  });
}
export function exportPickupImage(mode, dataUrl) {
  if (!nativeBridge() || !['save', 'share'].includes(mode)) return Promise.reject(new Error('当前环境不支持此图片操作'));
  return request(mode === 'save' ? 'savePickupImage' : 'sharePickupImage', { dataUrl });
}
export function setAiKey(key, model) { return request('setAiKey', { key, model }); }
export function getAiChannels() { return request('aiChannels'); }
export function getAiOptimizationStatus() { return request('aiOptimizationStatus'); }
export function configureAiOptimization(enabled) { return request('configureAiOptimization', { enabled }); }
export async function approveAiProposal(id) {
  const result = await request('approveAiProposal', { id });
  uni.$emit('assistant-changed');
  return result;
}
export function ignoreAiProposal(id) { return request('ignoreAiProposal', { id }); }
export function analyzeAiProposals() { return request('analyzeAiProposals'); }
export async function generateTemplate(sample, expectedCode) {
  const candidate = await request('generateTemplate', { sample, expectedCode });
  return core.validateCandidate(candidate, sample, expectedCode);
}
export function getPresets() { return core.builtins(); }
export function previewRule(sample, rule) { return core.parse(sample, [{ ...core.validateRule(rule), enabled: true }], false); }
export function validateCandidate(candidate, sample, expectedCode) { return core.validateCandidate(candidate, sample, expectedCode); }

