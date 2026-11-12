import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { Store } from './store.mjs';
import { AdminConfiguration } from './configuration.mjs';
import { createCollector } from './collectors.mjs';
import { LogisticsRuleStore } from './logistics-rule-store.mjs';
import { createSyncJobs } from './sync-jobs.mjs';
import { StationStore, enqueuePlatformCandidates, enqueueStationProposal } from './stations.mjs';
import { StationAiJobs } from './station-ai.mjs';
import { MatchingFeedbackStore } from './matching-feedback.mjs';
import { AiAssistance } from './ai-assistance.mjs';
import { LogisticsAiJobs } from './logistics-ai.mjs';
import { LogisticsDailyLearning } from './logistics-daily-learning.mjs';
import { RecognitionWorkflow } from './recognition-workflow.mjs';
import { RecognitionAi } from './recognition-ai.mjs';
import { createRecognitionApi } from './recognition-api.mjs';
import { DiagnosticAccess } from './diagnostic-access.mjs';
import { createDiagnosticApi } from './diagnostic-api.mjs';
import { stationKey } from './station-text.mjs';
import { PickupCompletionAi } from './pickup-completion-ai.mjs';
import { serverVersion } from './version.mjs';
import { orderRetention } from './order-retention.mjs';
import { createAppUpdateHandler } from './app-updates.mjs';
import { createCookieSyncHandler } from './cookie-sync.mjs';
import { fail, hash, HttpError, onlyKeys, publicUrl, RateLimiter } from './security.mjs';

const PUBLIC = new URL('../public/', import.meta.url);
const STATIC = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/admin.js', ['admin.js', 'text/javascript; charset=utf-8']], ['/station-admin.js', ['station-admin.js', 'text/javascript; charset=utf-8']], ['/station-admin.css', ['station-admin.css', 'text/css; charset=utf-8']], ['/sync-status.js', ['sync-status.js', 'text/javascript; charset=utf-8']], ['/admin.css', ['admin.css', 'text/css; charset=utf-8']]]);
STATIC.set('/logistics-admin.js', ['logistics-admin.js', 'text/javascript; charset=utf-8']);
STATIC.set('/pickup-completion-admin.js', ['pickup-completion-admin.js', 'text/javascript; charset=utf-8']);
STATIC.set('/station-location.js', ['station-location.js', 'text/javascript; charset=utf-8']);

async function bodyOf(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'JSON_REQUIRED', '请使用 application/json');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) { length += chunk.length; if (length > 65536) fail(413, 'BODY_TOO_LARGE', '请求过大'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'INVALID_JSON', 'JSON格式不正确'); }
}
function send(res, status, data, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(data === undefined ? undefined : JSON.stringify(data));
}

export function createService({ filename = ':memory:', encryptionKey, adminToken, baseUrl, lanBaseUrl,
  now = Date.now, collector, fixture = false, scheduler = true, corsOrigins = [], log = console.log, aiRequest, appUpdateDirectory } = {}) {
  const appUpdates = createAppUpdateHandler({ directory: appUpdateDirectory });
  const origins = new Set(corsOrigins.map(publicUrl));
  const configuration = new AdminConfiguration({ filename, encryptionKey, adminToken, baseUrl, lanBaseUrl, now, log });
  let logisticsRules;
  const getLogisticsRules = () => logisticsRules.read().rules;
  const store = new Store({ filename, key: configuration.key, now, getLogisticsRules });
  logisticsRules = new LogisticsRuleStore(store.db, now, { onRulesChanged: rules => store.refreshLogisticsRules(rules) });
  const stations = new StationStore({ db: store.db, key: configuration.key, now, onRulesChanged: catalog => store.refreshStationRecognition(catalog) });
  const matchingFeedback = new MatchingFeedbackStore({ store, stations, now });
  let jobs, recognitionAi;
  const recognition = new RecognitionWorkflow({ store, now, automaticEvents: scheduler,
    requestOrder: (accountId, orderId) => jobs.request(accountId, orderId), analyze: task => recognitionAi.analyze(task),
    refreshAnalysis: task => recognitionAi?.refresh(task),
    authorizeReport: task => {
      const owner = store.devices().find(device => device.id === task.deviceId && !device.revokedAt);
      return !!owner && task.candidateShipmentIds.every(id => store.canRead(owner, store.shipment(id)));
    } });
  const stationAi = new StationAiJobs({ stations, now, automaticEvents: scheduler,
    allowAutomatic: candidate => candidate.source === 'manual' || recognition.tasks().some(task => {
      const shipment = store.shipment(task.shipmentId);
      return shipment && recognition.allowAutomatic(shipment) && [task.source?.station, shipment.station]
        .some(name => name && stationKey(name) === stationKey(candidate.stationName));
    }), ...(aiRequest ? { request: aiRequest } : {}) });
  const aiAssistance = new AiAssistance({ stations, now, ...(aiRequest ? { request: aiRequest } : {}) });
  const logisticsAi = new LogisticsAiJobs({ stations, rules: logisticsRules, store, assistance: aiAssistance, now, automaticEvents: scheduler,
    allowAutomatic: (shipment, target) => recognition.allowAutomatic(shipment, target) });
  const logisticsDaily = new LogisticsDailyLearning({ store, stations, logisticsAi, now, automaticEvents: scheduler });
  recognitionAi = new RecognitionAi({ store, stations, logisticsAi, assistance: aiAssistance, workflow: recognition, now });
  const recognitionApi = createRecognitionApi({ store, workflow: recognition, recognitionAi, stations, logisticsRules, logisticsDaily, now });
  const diagnosticAccess = new DiagnosticAccess({ store, now });
  const diagnosticApi = createDiagnosticApi({ store, workflow: recognition });
  const pickupCompletion = store.pickupCompletion;
  const pickupCompletionAi = new PickupCompletionAi({ store, completionStore: pickupCompletion, stations, assistance: aiAssistance, now, automaticEvents: scheduler });
  const enrichCandidates = (accountIds, shipmentIds) => {
    store.refreshStationRecognition(stations.stationRules().stations, shipmentIds);
    const snapshot = shipmentIds ? { shipments: shipmentIds.map(id => store.shipment(id)).filter(shipment => shipment
      && !orderRetention(store.order(shipment.orderId), now()).archived) } : store.snapshot(accountIds);
    recognition.observe(snapshot);
    enqueuePlatformCandidates(stations, { shipments: snapshot.shipments.filter(shipment => recognition.allowAutomatic(shipment)) }, now());
    logisticsAi.intake(snapshot);
    pickupCompletionAi.intake(snapshot);
  };
  const unsubscribeOptimization = stations.onAiConfigChange(() => {
    if (stations.aiConfig().enabled) enrichCandidates(store.accounts().filter(account => account.enabled).map(account => account.id));
  });
  if (stations.aiConfig().enabled) enrichCandidates(store.accounts().filter(account => account.enabled).map(account => account.id));
  else store.refreshStationRecognition(stations.stationRules().stations);
  pickupCompletionAi.intake(store.snapshot(store.accounts().filter(account => account.enabled).map(account => account.id)));
  recognition.observe(store.snapshot(store.accounts().filter(account => account.enabled).map(account => account.id)));
  const rate = new RateLimiter(now);
  jobs = createSyncJobs({ store, collector: collector || createCollector({ now, getLogisticsRules }), now,
    onImported: (accountId, shipmentIds) => enrichCandidates([accountId], shipmentIds),
    onCompleted: () => store.refreshStationRecognition(stations.stationRules().stations) });
  const running = jobs.running;
  const allowed = (device, id) => { if (!device.accountIds.includes(id)) fail(403, 'SCOPE_FORBIDDEN', '账号不在授权范围内'); };
  const admin = req => {
    rate.check(`admin:${req.socket.remoteAddress}`, 120);
    configuration.authenticate(req.headers['x-admin-token']);
  };
  const credentialLimit = req => {
    rate.check(`credentials:${req.socket.remoteAddress}`, 10, 10 * 60000);
    rate.check('credentials:global', 100, 10 * 60000);
  };
  const pairingLimit = req => {
    rate.check(`pair:${req.socket.remoteAddress}`, 10, 10 * 60000);
    rate.check('pair:global', 100, 10 * 60000);
  };
  const device = req => {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ') || auth.length > 300) fail(401, 'DEVICE_UNAUTHORIZED', '请绑定设备');
    const current = store.device(auth.slice(7));
    rate.check(`device:${current.id}`, 180);
    return current;
  };
  const requestSync = id => jobs.request(id).done;
  const cookieSync = createCookieSyncHandler({ store, jobs, configuration, now, rate, fixture, bodyOf, send, admin });
  const timer = scheduler ? setInterval(() => {
    jobs.runDue();
    recognition.runDue();
    stationAi.runDue();
    logisticsAi.runDue();
    logisticsDaily.runDue();
    pickupCompletionAi.runDue();
  }, 30000).unref() : null;

  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, configuration.baseUrl || 'http://localhost');
      const path = url.pathname;
      const origin = req.headers.origin;
      let localFixtureOrigin = false;
      if (fixture && origin) {
        try { const source = new URL(origin); localFixtureOrigin = source.origin === origin && source.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname); } catch { /* Invalid Origin is rejected below. */ }
      }
      const chromeOrigin = typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
      const extensionOrigin = chromeOrigin && path.startsWith('/v1/cookie-sync/');
      const corsAllowed = origins.has(origin) || localFixtureOrigin || extensionOrigin;
      let sameHost = false;
      if (origin && req.headers.host) {
        try {
          const source = new URL(origin);
          sameHost = source.origin === origin && ['http:', 'https:'].includes(source.protocol) && source.host === new URL(`${source.protocol}//${req.headers.host}`).host;
        } catch { /* Invalid Origin or Host is rejected below. */ }
      }
      if (origin && origin !== configuration.baseUrl && !sameHost && !corsAllowed) fail(403, 'ORIGIN_FORBIDDEN', '来源不允许');
      if (chromeOrigin && !extensionOrigin) fail(403, 'ORIGIN_FORBIDDEN', '插件只能访问 Cookie 同步接口');
      if (origin && corsAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Expose-Headers', 'ETag');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-None-Match, X-Admin-Token', 'Access-Control-Max-Age': '600' });
        res.end(); return;
      }
      if (req.url.startsWith('/app-updates') && await appUpdates(req, res)) return;
      if (req.method === 'GET' && STATIC.has(path)) {
        const [file, type] = STATIC.get(path);
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        const content = await readFile(new URL(file, PUBLIC));
        res.end(file === 'index.html' ? content.toString('utf8').replaceAll('__SERVER_VERSION__', serverVersion) : content); return;
      }
      if (path === '/health' && req.method === 'GET') { send(res, 200, { ok: true, serviceId: configuration.serviceId }); return; }
      if (!path.startsWith('/v1/')) fail(404, 'NOT_FOUND', '接口不存在');

      if (path === '/v1/setup' && req.method === 'GET') { send(res, 200, configuration.status()); return; }
      if (path === '/v1/setup' && req.method === 'POST') {
        if (configuration.initialized) fail(409, 'ALREADY_INITIALIZED', '服务已初始化');
        credentialLimit(req);
        const body = await bodyOf(req); onlyKeys(body, ['setupCode', 'password', 'baseUrl']);
        send(res, 200, await configuration.setup(body)); return;
      }
      configuration.requireInitialized();
      if (path.startsWith('/v1/diagnostics/')) {
        rate.check(`diagnostics:${req.socket.remoteAddress}`, 120);
        const auth = req.headers.authorization;
        const credential = typeof auth === 'string' && auth.startsWith('Bearer ') && diagnosticAccess.authenticate(auth.slice(7));
        if (!credential) fail(401, 'DIAGNOSTIC_UNAUTHORIZED', '请提供有效的只读诊断 API 凭据');
        rate.check(`diagnostic-token:${credential.id}`, 120);
        if (req.method !== 'GET') fail(405, 'READ_ONLY', '诊断 API 仅支持读取');
        if (path === '/v1/diagnostics/status') { send(res, 200, { serverVersion, serverTime: now(), scope: 'diagnostics:read', expiresAt: null }); return; }
        if (path === '/v1/diagnostics/accounts') { send(res, 200, { accounts: diagnosticApi.accounts() }); return; }
        if (path === '/v1/diagnostics/orders') { send(res, 200, diagnosticApi.orders(url.searchParams)); return; }
        const diagnosticOrder = path.match(/^\/v1\/diagnostics\/orders\/([^/]+)$/);
        if (diagnosticOrder) { send(res, 200, diagnosticApi.order(diagnosticOrder[1])); return; }
        if (path === '/v1/diagnostics/recognition-tasks') { send(res, 200, recognition.summary()); return; }
        if (path === '/v1/diagnostics/recognition-review') {
          send(res, 200, recognitionApi.review({ limit: Number(url.searchParams.get('limit') ?? 100), after: Number(url.searchParams.get('after') ?? 0) })); return;
        }
        fail(404, 'NOT_FOUND', '诊断接口不存在');
      }
      if ((path.startsWith('/v1/cookie-sync/') || path.startsWith('/v1/admin/cookie-sync/')) && await cookieSync(req, res, url)) return;
      if (path === '/v1/admin/login' && req.method === 'POST') {
        credentialLimit(req);
        const body = await bodyOf(req); onlyKeys(body, ['password']);
        send(res, 200, await configuration.login(body.password)); return;
      }

      if (path === '/v1/devices' && req.method === 'POST') {
        // Never trust a client-provided X-Forwarded-For to partition guessing limits.
        pairingLimit(req);
        const body = await bodyOf(req);
        onlyKeys(body, ['code', 'deviceName']);
        send(res, 201, store.redeem(body.code, body.deviceName)); return;
      }
      if (path === '/v1/pairing-codes/preview' && req.method === 'POST') {
        pairingLimit(req);
        const body = await bodyOf(req); onlyKeys(body, ['code']);
        send(res, 200, { service: { name: '取件助手', baseUrl: configuration.baseUrl }, ...store.previewPairing(body.code) }); return;
      }
      if (path === '/v1/pairing-codes' && req.method === 'POST') {
        admin(req);
        const body = await bodyOf(req);
        configuration.authenticate(req.headers['x-admin-token']);
        onlyKeys(body, ['accountIds', 'familyIds']);
        const baseUrl = configuration.baseUrl;
        if (!baseUrl) fail(409, 'BASE_URL_REQUIRED', '请先在设置中填写HTTPS服务地址，再生成绑定码');
        const pair = store.createPairing(body);
        const qrPayload = JSON.stringify({ schemaVersion: 1, baseUrl, code: pair.code });
        const qrDataUrl = await QRCode.toDataURL(qrPayload, { width: 256, margin: 2, errorCorrectionLevel: 'M' });
        configuration.authenticate(req.headers['x-admin-token']);
        send(res, 201, { ...pair, baseUrl, qrPayload, qrDataUrl }); return;
      }
      if (path.startsWith('/v1/admin/')) {
        admin(req);
        if (path === '/v1/admin/diagnostic-tokens' && req.method === 'GET') { send(res, 200, { credentials: diagnosticAccess.list() }); return; }
        if (path === '/v1/admin/diagnostic-tokens' && req.method === 'POST') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 201, diagnosticAccess.create(body)); return;
        }
        const diagnosticToken = path.match(/^\/v1\/admin\/diagnostic-tokens\/([^/]+)$/);
        if (diagnosticToken && req.method === 'DELETE') { send(res, 200, diagnosticAccess.revoke(diagnosticToken[1])); return; }
        if (path === '/v1/admin/recognition-tasks' && req.method === 'GET') { send(res, 200, recognition.summary()); return; }
        if (path === '/v1/admin/recognition-review' && req.method === 'GET') {
          send(res, 200, recognitionApi.review({ limit: Number(url.searchParams.get('limit') ?? 100), after: Number(url.searchParams.get('after') ?? 0) })); return;
        }
        const completionStatus = () => ({ config: pickupCompletion.config(), ...pickupCompletionAi.status() });
        if (path === '/v1/admin/pickup-completion' && req.method === 'GET') { send(res, 200, completionStatus()); return; }
        if (path === '/v1/admin/pickup-completion' && req.method === 'PUT') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          pickupCompletion.saveConfig(body); pickupCompletionAi.configChanged();
          send(res, 200, completionStatus()); return;
        }
        if (path === '/v1/admin/pickup-completion/history' && req.method === 'GET') { send(res, 200, { changes: pickupCompletionAi.history(), candidates: pickupCompletionAi.candidates() }); return; }
        if (path === '/v1/admin/pickup-completion/candidates' && req.method === 'GET') { send(res, 200, { candidates: pickupCompletionAi.candidates() }); return; }
        if (path === '/v1/admin/pickup-completion/rollback' && req.method === 'POST') {
          const body = await bodyOf(req); onlyKeys(body, ['historyId']); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, { change: pickupCompletionAi.rollback(body.historyId) }); return;
        }
        const channelList = () => { const config = stations.aiConfig(); return { channels: stations.aiChannels(), dailyLimit: config.dailyLimit, usageToday: config.usageToday, defaultChannelId: config.channelId }; };
        if (path === '/v1/admin/ai-channels' && req.method === 'GET') { send(res, 200, channelList()); return; }
        if (path === '/v1/admin/ai-channels' && req.method === 'POST') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          stations.saveAiChannel(undefined, body); send(res, 201, channelList()); return;
        }
        const aiChannelPath = path.match(/^\/v1\/admin\/ai-channels\/([^/]+)(\/test)?$/);
        if (aiChannelPath && !aiChannelPath[2] && req.method === 'PATCH') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, { channel: stations.saveAiChannel(aiChannelPath[1], body) }); return;
        }
        if (aiChannelPath?.[2] && req.method === 'POST') {
          onlyKeys(await bodyOf(req), []); configuration.authenticate(req.headers['x-admin-token']);
          rate.check('station-ai:test', 5, 60000);
          const result = await aiAssistance.test(aiChannelPath[1]); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, result); return;
        }
        if (path === '/v1/admin/logistics-rules' && req.method === 'GET') { send(res, 200, logisticsRules.read()); return; }
        if (path === '/v1/admin/logistics-rules' && req.method === 'PATCH') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, logisticsRules.save(body)); return;
        }
        if (path === '/v1/admin/logistics-rules/test' && req.method === 'POST') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, logisticsRules.test(body)); return;
        }
        if (path === '/v1/admin/stations' && req.method === 'GET') { send(res, 200, { stations: stations.stations(), revision: stations.revision }); return; }
        if (path === '/v1/admin/stations' && req.method === 'POST') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 201, { station: stations.saveStation(undefined, body) }); return;
        }
        const stationPath = path.match(/^\/v1\/admin\/stations\/([^/]+)$/);
        if (stationPath && req.method === 'PATCH') {
          if (!stations.station(stationPath[1])) fail(404, 'NOT_FOUND', '站点不存在');
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, { station: stations.saveStation(stationPath[1], body) }); return;
        }
        if (path === '/v1/admin/matching-feedback' && req.method === 'GET') {
          const number = (name, fallback = 0) => {
            const raw = url.searchParams.get(name);
            if (raw === null || raw === '') return fallback;
            const value = Number(raw); if (!Number.isSafeInteger(value) || value < 0) fail(400, 'INVALID_FEEDBACK_QUERY', `${name}参数无效`); return value;
          };
          const limit = number('limit', 50);
          if (limit < 1 || limit > 100) fail(400, 'INVALID_FEEDBACK_QUERY', '每页反馈数须为1到100');
          send(res, 200, matchingFeedback.adminQuery({ limit, before: number('before'), from: number('from'), to: number('to'),
            status: url.searchParams.get('status') || '', kind: url.searchParams.get('kind') || '', reasonCode: url.searchParams.get('reasonCode') || '',
            device: url.searchParams.get('device') || '', station: url.searchParams.get('station') || '' })); return;
        }
        if (path === '/v1/admin/station-candidates' && req.method === 'GET') { send(res, 200, { candidates: stations.candidates(), running: !!stationAi.running }); return; }
        const candidatePath = path.match(/^\/v1\/admin\/station-candidates\/([^/]+)\/(approve|ignore)$/);
        if (candidatePath && req.method === 'POST') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          if (candidatePath[2] === 'ignore') { onlyKeys(body, []); send(res, 200, { candidate: stations.ignoreCandidate(candidatePath[1]) }); }
          else send(res, 200, stations.approveCandidate(candidatePath[1], body));
          return;
        }
        if (path === '/v1/admin/station-ai' && req.method === 'GET') { send(res, 200, { config: stations.aiConfig(), running: !!stationAi.running }); return; }
        if (path === '/v1/admin/logistics-ai' && req.method === 'GET') { send(res, 200, { candidates: logisticsAi.candidates(), running: !!logisticsAi.running, dailyLearning: logisticsDaily.summary() }); return; }
        const logisticsCandidatePath = path.match(/^\/v1\/admin\/logistics-ai\/([^/]+)\/ignore$/);
        if (logisticsCandidatePath && req.method === 'POST') {
          onlyKeys(await bodyOf(req), []); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, { candidate: logisticsAi.ignore(logisticsCandidatePath[1]) }); return;
        }
        if (path === '/v1/admin/ai-optimization/history' && req.method === 'GET') {
          send(res, 200, { changes: [...stations.automationHistory(), ...logisticsAi.history()].sort((a, b) => b.appliedAt - a.appliedAt) }); return;
        }
        const optimizationRollback = path.match(/^\/v1\/admin\/ai-optimization\/history\/(station_alias|logistics_rule)\/([^/]+)\/rollback$/);
        if (optimizationRollback && req.method === 'POST') {
          onlyKeys(await bodyOf(req), []); configuration.authenticate(req.headers['x-admin-token']);
          const change = optimizationRollback[1] === 'station_alias' ? stations.rollbackAutomaticAlias(optimizationRollback[2]) : logisticsAi.rollback(optimizationRollback[2]);
          send(res, 200, { change }); return;
        }
        if (path === '/v1/admin/station-ai' && req.method === 'PATCH') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, { config: stations.saveAiConfig(body) }); return;
        }
        if (path === '/v1/admin/station-ai/test' && req.method === 'POST') {
          onlyKeys(await bodyOf(req), []); configuration.authenticate(req.headers['x-admin-token']);
          rate.check('station-ai:test', 5, 60000);
          const result = await stationAi.testConnection(); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, result); return;
        }
        if (path === '/v1/admin/station-ai/run' && req.method === 'POST') {
          onlyKeys(await bodyOf(req), []); configuration.authenticate(req.headers['x-admin-token']);
          rate.check('station-ai:run', 10, 60000);
          send(res, 202, stationAi.request()); return;
        }
        if (path === '/v1/admin/families' && req.method === 'GET') { send(res, 200, { families: store.families() }); return; }
        if (path === '/v1/admin/families' && req.method === 'POST') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 201, { family: store.saveFamily(body) }); return;
        }
        const familyPath = path.match(/^\/v1\/admin\/families\/([^/]+)$/);
        if (familyPath && req.method === 'PATCH') {
          if (!store.family(familyPath[1])) fail(404, 'NOT_FOUND', '家人不存在');
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, { family: store.saveFamily(body, familyPath[1]) }); return;
        }
        const devicePath = path.match(/^\/v1\/admin\/devices\/([^/]+)$/);
        if (devicePath && req.method === 'PATCH') {
          const body = await bodyOf(req); configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, { device: store.updateDevice(devicePath[1], body) }); return;
        }
        if (path === '/v1/admin/status' && req.method === 'GET') { send(res, 200, { fixture, serverVersion, baseUrl: configuration.baseUrl, lanBaseUrl: configuration.lanBaseUrl, configurationMode: configuration.mode }); return; }
        if (path === '/v1/admin/settings' && req.method === 'PATCH') {
          const body = await bodyOf(req); onlyKeys(body, ['baseUrl', 'lanBaseUrl']);
          configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, configuration.settings(body.baseUrl, body.lanBaseUrl)); return;
        }
        if (path === '/v1/admin/password' && req.method === 'POST') {
          credentialLimit(req);
          const body = await bodyOf(req); onlyKeys(body, ['currentPassword', 'password']);
          configuration.authenticate(req.headers['x-admin-token']);
          send(res, 200, await configuration.changePassword(req.headers['x-admin-token'], body.currentPassword, body.password)); return;
        }
        if (path === '/v1/admin/accounts' && req.method === 'GET') {
          send(res, 200, { accounts: store.accounts().map(account => ({ ...account, syncJob: jobs.latest(account.id) })), serverTime: now() }); return;
        }
        if (path === '/v1/admin/accounts' && req.method === 'POST') {
          const body = await bodyOf(req);
          configuration.authenticate(req.headers['x-admin-token']);
          send(res, 201, { account: store.saveAccount(body, undefined, fixture) }); return;
        }
        if (path === '/v1/admin/devices' && req.method === 'GET') { send(res, 200, { devices: store.devices() }); return; }
        const accountPath = path.match(/^\/v1\/admin\/accounts\/([^/]+)(\/sync)?$/);
        if (accountPath) {
          if (!store.account(accountPath[1])) fail(404, 'NOT_FOUND', '账号不存在');
          if (!accountPath[2] && req.method === 'PATCH') {
            const body = await bodyOf(req);
            configuration.authenticate(req.headers['x-admin-token']);
            send(res, 200, { account: store.saveAccount(body, accountPath[1], fixture) }); return;
          }
          if (accountPath[2] && req.method === 'POST') {
            const body = await bodyOf(req);
            configuration.authenticate(req.headers['x-admin-token']);
            onlyKeys(body, []); send(res, 202, { accepted: true, jobs: [jobs.request(accountPath[1]).job] }); return;
          }
        }
        fail(404, 'NOT_FOUND', '管理接口不存在');
      }
      const revokePath = path.match(/^\/v1\/devices\/([^/]+)$/);
      if (revokePath && revokePath[1] !== 'current' && req.method === 'DELETE') {
        admin(req); send(res, 200, store.revoke(revokePath[1])); return;
      }
      const current = device(req);
      if (path === '/v1/ai/channels' && req.method === 'GET') { send(res, 200, aiAssistance.channels()); return; }
      if (path === '/v1/ai/template-proposals' && req.method === 'POST') {
        const body = await bodyOf(req), authorized = device(req);
        rate.check(`ai-template:${authorized.id}`, 4, 60000);
        rate.check(`ai-template-hour:${authorized.id}`, 20, 3600000);
        const identityOf = value => hash(JSON.stringify([req.headers.authorization, value.id, [...value.accountIds].sort(), [...(value.familyIds || [])].sort(), [...(value.legacyAccountIds || [])].sort()]));
        const identity = identityOf(authorized);
        const authorize = () => { if (identityOf(store.device(req.headers.authorization.slice(7))) !== identity) fail(403, 'SCOPE_FORBIDDEN', '设备授权已变化，请重新准备建议'); };
        const result = await aiAssistance.template(body, identity, authorize);
        authorize(); send(res, 200, result); return;
      }
      if (path === '/v1/connection' && req.method === 'GET') {
        send(res, 200, { schemaVersion: 1, serviceId: configuration.serviceId, lanBaseUrl: configuration.lanBaseUrl }); return;
      }
      if (path === '/v1/station-candidates' && req.method === 'POST') {
        const body = await bodyOf(req); onlyKeys(body, ['items']);
        const authorized = device(req); rate.check(`station-upload:${authorized.id}`, 12, 3600000);
        send(res, 200, stations.enqueue(body.items, { deviceId: authorized.id, source: 'sms' })); return;
      }
      if (path === '/v1/station-proposals' && req.method === 'POST') {
        const body = await bodyOf(req); const authorized = device(req);
        rate.check(`station-proposal:${authorized.id}`, 20, 3600000);
        send(res, 202, enqueueStationProposal(stations, body, authorized.id)); return;
      }
      if (path === '/v1/matching-feedback' && req.method === 'GET') { send(res, 200, matchingFeedback.summary(current)); return; }
      if (path === '/v1/recognition-issues' && req.method === 'POST') {
        const body = await bodyOf(req), authorized = device(req);
        rate.check(`recognition-issues:${authorized.id}`, 60, 3600000);
        send(res, 200, recognitionApi.submit(authorized, body)); return;
      }
      if (path === '/v1/matching-feedback' && req.method === 'POST') {
        const body = await bodyOf(req), authorized = device(req);
        rate.check(`matching-feedback:${authorized.id}`, 60, 3600000);
        send(res, 200, matchingFeedback.submit(authorized, body)); return;
      }
      if (path === '/v1/station-rule-receipts' && req.method === 'POST') {
        const body = await bodyOf(req), authorized = device(req);
        rate.check(`station-rule-receipts:${authorized.id}`, 120, 3600000);
        send(res, 200, matchingFeedback.submitRuleReceipt(authorized, body, { stationRulesVersion: stations.revision, serverLogisticsRulesVersion: logisticsRules.read().revision })); return;
      }
      if (path === '/v1/devices/current' && req.method === 'DELETE') { send(res, 200, store.revoke(current.id)); return; }
      if (path === '/v1/accounts' && req.method === 'GET') { send(res, 200, { accounts: store.accounts(current.accountIds), familyIds: current.familyIds, legacyAccountIds: current.legacyAccountIds, families: store.families(current.familyIds) }); return; }
      if (path === '/v1/accounts/sync' && req.method === 'POST') {
        const body = await bodyOf(req); onlyKeys(body, ['onlyIfStale']);
        if (body.onlyIfStale !== undefined && typeof body.onlyIfStale !== 'boolean') fail(400, 'INVALID_INPUT', 'onlyIfStale 必须是布尔值');
        store.refreshStationRecognition(stations.stationRules().stations);
        send(res, 202, { accepted: true, jobs: device(req).accountIds.map(id => jobs.request(id, '', { onlyIfStale: body.onlyIfStale === true }))
          .filter(Boolean).map(record => record.job) }); return;
      }
      const syncPath = path.match(/^\/v1\/accounts\/([^/]+)\/sync$/);
      if (syncPath && req.method === 'POST') {
        onlyKeys(await bodyOf(req), []); allowed(device(req), syncPath[1]);
        send(res, 202, { accepted: true, jobs: [jobs.request(syncPath[1]).job] }); return;
      }
      const orderRefresh = path.match(/^\/v1\/orders\/([^/]+)\/refresh$/);
      if (orderRefresh && req.method === 'POST') {
        onlyKeys(await bodyOf(req), []);
        const order = store.order(orderRefresh[1]);
        if (!store.canRead(device(req), order)) fail(403, 'SCOPE_FORBIDDEN', '订单不在授权范围内');
        send(res, 202, { accepted: true, jobs: [jobs.request(order.accountId, order.id).job] }); return;
      }
      const jobPath = path.match(/^\/v1\/sync-jobs\/([^/]+)$/);
      if (jobPath && req.method === 'GET') {
        const job = jobs.read(jobPath[1]);
        if (job.orderId) {
          if (!store.canRead(current, store.order(job.orderId))) fail(403, 'SCOPE_FORBIDDEN', '订单不在授权范围内');
        } else allowed(current, job.accountId);
        send(res, 200, { job }); return;
      }
      if (path === '/v1/snapshot' && req.method === 'GET') {
        const requested = url.searchParams.getAll('accountId');
        requested.forEach(id => { if (!store.canFilterAccount(current, id)) fail(403, 'SCOPE_FORBIDDEN', '账号不在授权范围内'); });
        const rules = stations.stationRules(), logistics = logisticsRules.read();
        const additional = { stationRulesVersion: rules.revision, stationRules: rules.stations, matchingFeedback: matchingFeedback.summary(current),
          recognitionIssues: recognitionApi.issues(current, requested),
          serverLogisticsRulesVersion: logistics.revision,
          serverLogisticsRules: logistics.rules.map(({ id, name, enabled, kind, starts, end, keywords, origin }) => ({ id, name, enabled, kind, starts, end, keywords, origin })),
          ...jobs.snapshot(current, requested.length ? requested : undefined) };
        const snapshot = Object.assign(store.snapshot(current, requested.length ? requested : undefined, Buffer.byteLength(JSON.stringify(additional), 'utf8')), additional);
        snapshot.capabilities = [...new Set([...(snapshot.capabilities || []), 'station_rule_receipts_v1', 'recognition_workflow_v1'])];
        const etag = `"${hash(JSON.stringify(snapshot))}"`;
        const matches = (req.headers['if-none-match'] || '').split(',').map(t => t.trim().replace(/^W\//, '')).includes(etag);
        send(res, matches ? 304 : 200, matches ? undefined : snapshot, { ETag: etag }); return;
      }
      if (path === '/v1/operations' && req.method === 'POST') {
        const body = await bodyOf(req); onlyKeys(body, ['operations']);
        send(res, 200, store.applyOperations(device(req), body.operations)); return;
      }
      const operationPath = path.match(/^\/v1\/operations\/([^/]+)$/);
      if (operationPath && req.method === 'GET') { send(res, 200, store.operation(current, decodeURIComponent(operationPath[1]))); return; }
      fail(404, 'NOT_FOUND', '接口不存在');
    } catch (error) {
      if (!res.headersSent) send(res, error instanceof HttpError ? error.status : 500, { error: { code: error instanceof HttpError ? error.code : 'INTERNAL_ERROR', message: error instanceof HttpError ? error.message : '服务暂不可用' } });
      else res.end();
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.maxHeadersCount = 60;
  return { server, store, requestSync, fixture, running, jobs, stations, stationAi, matchingFeedback, aiAssistance, logisticsRules, logisticsAi, logisticsDaily, recognition, recognitionAi, pickupCompletion, pickupCompletionAi,
    async close() {
      cookieSync.close();
      unsubscribeOptimization();
      const dailyClosing = logisticsDaily.close();
      const recognitionClosing = recognition.close();
      const recognitionAiClosing = recognitionAi.close();
      aiAssistance.close();
      if (timer) clearInterval(timer);
      await dailyClosing;
      await recognitionClosing;
      await recognitionAiClosing;
      await new Promise(resolve => server.close(resolve));
      await jobs.close();
      await stationAi.close();
      await logisticsAi.close();
      await pickupCompletionAi.close();
      store.close();
    } };
}

export const serviceDirectory = fileURLToPath(new URL('../', import.meta.url));
