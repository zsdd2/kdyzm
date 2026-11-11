// Adapted from YUNXI-fi/Pickup-Code-Display, commit 034aad94559e8448644f4670408412ba7222a10d.
// Copyright (c) 2026. Non-commercial license: ../licenses/Pickup-Code-Display-LICENSE.txt.
// This adapter intentionally does not inherit upstream's automatic "picked" transitions.
import { createHash } from 'node:crypto';
import { normalizeProductImageUrl } from './product-image.mjs';
import { discoverPddSplit, fetchPddSplitTrack, fetchPddSplitCabinet, pddOrderMatches, pddWaybillMatches } from './pdd-split.mjs';
import { activeKnownOrders, activeKnownParcels, isActiveKnownOrder, anchorTaobaoEventTimes, corroborateTaobaoEventTimes, doorstepEvidence, eventStatus, homeDeliveryCompleted, logisticsEventTimeIssue, logisticsTimestamp, logisticsTimePrecision, normalizeLogisticsEvents, orderTimePrecision, pddShippingEvents, pickupCycleReset, pickupEvidence, taobaoDetailDateEvidence, taobaoStageEvents, taobaoTimeAnchorCandidate, taobaoTransitEvents } from './collector-enrichment.mjs';
import { jdShipmentStatus } from './shipment-lifecycle.mjs';

const APPKEY = '12574478';
const UA = 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Mobile Safari/537.36';
const HOSTS = new Set(['h5api.m.taobao.com', 'pages-g.m.taobao.com', 'buyertrade.taobao.com', 'mobile.yangkeduo.com', 'api.m.jd.com']);
const CARRIERS = { YTO: '圆通速递', ZTO: '中通快递', STO: '申通快递', YUNDA: '韵达速递', SF: '顺丰速运', EMS: 'EMS', JD: '京东物流', JTSD: '极兔速递', HTKY: '百世快递', YZPY: '邮政快递包裹' };

export class CollectorError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const expired = () => { throw new CollectorError('ACCOUNT_EXPIRED', '平台登录态已失效，请在后台更新 Cookie'); };
const upstream = () => { throw new CollectorError('UPSTREAM_ERROR', '平台接口暂不可用，请稍后重试'); };
const asText = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
function productImage(items, fields) {
  for (const item of Array.isArray(items) ? items : []) for (const field of fields) {
    const imageUrl = normalizeProductImageUrl(item?.[field]);
    if (imageUrl) return imageUrl;
  }
  return '';
}
function activeParcel(order, waybillNo) {
  const previous = order?.shipments?.find(parcel => asText(parcel.waybillNo) === asText(waybillNo));
  return !previous || activeKnownParcels(order).includes(previous);
}

export function timestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const n = Number(value);
    return n < 100000000000 ? n * 1000 : n;
  }
  // Platform timestamps without an offset are China local time, regardless of the server TZ.
  if (['second', 'minute'].includes(logisticsTimePrecision(value))) return logisticsTimestamp(value, raw => Date.parse(raw) || 0);
  const normalized = String(value).replace(/年|月/g, '-').replace('日', '').trim();
  return Date.parse(normalized) || 0;
}

export async function platformRequest(url, cookie, { fetchImpl = fetch, method = 'GET', body, headers = {}, encoding = 'utf-8' } = {}) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !HOSTS.has(target.hostname)) throw new CollectorError('INVALID_UPSTREAM', '不支持的平台接口');
  const response = await fetchImpl(url, { method, body, redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9', Cookie: cookie, ...headers } });
  if ([401, 403].includes(response.status)) {
    if (response.status === 401) expired();
    throw new CollectorError('UPSTREAM_BLOCKED', '平台拒绝访问或触发风控，请稍后重试');
  }
  if (response.status === 429) {
    const error = new CollectorError('UPSTREAM_RATE_LIMITED', '平台请求频率受限，请稍后重试');
    const retryAfter = response.headers.get('retry-after');
    const delay = /^\d+(?:\.\d+)?$/.test(retryAfter || '') ? Number(retryAfter) * 1000 : Date.parse(retryAfter || '') - Date.now();
    if (Number.isFinite(delay) && delay > 0) error.retryAfterMs = Math.min(delay, 15 * 60 * 1000);
    throw error;
  }
  if (!response.ok) upstream();
  const limit = 5 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) upstream();
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) { upstream(); } chunks.push(chunk); }
  return { text: new TextDecoder(encoding).decode(Buffer.concat(chunks)), headers: response.headers };
}
async function parallelLogistics(items, collect, { concurrency = 2, onResult } = {}) {
  const results = [];
  let next = 0, failure;
  // Stop dispatching on expiry, but drain the in-flight peer before returning the error.
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try {
        results[index] = await collect(items[index]);
        await onResult?.(results[index], items[index], index);
      }
      catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}
function mustStopLogistics(error, durable) {
  return ['ACCOUNT_EXPIRED', 'UPSTREAM_BLOCKED', 'UPSTREAM_RATE_LIMITED'].includes(error.code)
    || durable && (error.code === 'UPSTREAM_ERROR' || ['TimeoutError', 'AbortError', 'TypeError'].includes(error.name));
}
function json(text) {
  try { return JSON.parse(text); } catch { throw new CollectorError('UPSTREAM_FORMAT', '平台返回结构已变化，保留上次成功数据'); }
}
function withCookies(cookie, headers) {
  const values = new Map(cookie.split(';').map(v => { const i = v.indexOf('='); return [v.slice(0, i).trim(), v.slice(i + 1).trim()]; }));
  for (const raw of headers.getSetCookie?.() || []) {
    const pair = raw.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) values.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...values].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function mtop(session, data, pc = false, detail = false) {
  const api = detail ? 'mtop.taobao.order.query.detailv2' : pc ? 'mtop.taobao.order.queryboughtlistV2' : 'mtop.taobao.order.queryboughtlistv2';
  const base = `https://h5api.m.taobao.com/h5/${api}/1.0/`;
  const headers = { Origin: 'https://h5.m.taobao.com', Referer: 'https://h5.m.taobao.com/' };
  if (!session.refreshed) {
    const response = await platformRequest(`${base}?appKey=${APPKEY}`, session.cookie, { fetchImpl: session.fetchImpl, headers });
    const nextCookie = withCookies(session.cookie, response.headers);
    if (nextCookie !== session.cookie) session.onCookieRefresh?.(nextCookie);
    session.cookie = nextCookie;
    session.refreshed = true;
  }
  const token = session.cookie.match(/(?:^|;\s*)_m_h5_tk=([^;]+)/)?.[1].split('_')[0];
  if (!token) expired();
  const t = String(session.now());
  const raw = JSON.stringify(data);
  const sign = createHash('md5').update(`${token}&${t}&${APPKEY}&${raw}`).digest('hex');
  const post = pc || detail;
  const qs = new URLSearchParams({ jsv: '2.7.2', appKey: APPKEY, t, sign, v: '1.0', api, type: post ? 'originaljson' : 'jsonp', dataType: post ? 'json' : 'jsonp' });
  if (post) {
    Object.entries({ ecode: '1', timeout: '8000', valueType: 'original', ttid: detail ? '201200@taobao_h5_9.18.0' : '201200@taobao_iphone_99.99.99', needLogin: 'true', isHttps: '1', needRetry: 'true', preventFallback: 'true' }).forEach(([k, v]) => qs.set(k, v));
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else qs.set('data', raw);
  const response = await platformRequest(`${base}?${qs}`, session.cookie, { fetchImpl: session.fetchImpl, headers, method: post ? 'POST' : 'GET', body: post ? `data=${encodeURIComponent(raw)}` : undefined });
  const nextCookie = withCookies(session.cookie, response.headers);
  if (nextCookie !== session.cookie) session.onCookieRefresh?.(nextCookie);
  session.cookie = nextCookie;
  const content = response.text.trim();
  const parsed = json(content.startsWith('{') ? content : content.slice(content.indexOf('(') + 1, content.lastIndexOf(')')));
  const ret = Array.isArray(parsed.ret) ? parsed.ret.join(' ') : asText(parsed.retCode || parsed.ret);
  if (/SESSION_EXPIRED|TOKEN_EXOIRED|TOKEN_EXPIRED|NEED_LOGIN/.test(ret)) expired();
  if (ret && !ret.includes('SUCCESS')) upstream();
  if (!parsed.data || !Object.keys(parsed.data).length) {
    if (detail) throw new CollectorError('UPSTREAM_FORMAT', '平台未返回可解析订单详情');
    expired();
  }
  return parsed.data;
}

export function extractSsrFields(html) {
  const marker = "__ICE_SUSPENSE_LOADER__']['undefined'] = ";
  const at = html.indexOf(marker);
  if (at < 0) return null;
  const start = html.indexOf('{', at + marker.length);
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) { if (escape) escape = false; else if (c === '\\') escape = true; else if (c === '"') inString = false; continue; }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      const data = json(html.slice(start, i + 1)).result?.data;
      return (data?.newLogistics || data?.logisticsDetailH5)?.fields || null;
    }
  }
  return null;
}
function stageText(stage) {
  const label = stage.labelDesc;
  return (Array.isArray(label?.richContent) ? label.richContent.map(r => asText(r?.text)).join('') : '')
    || (typeof label === 'string' ? label : asText(label?.text || stage.text));
}
function codeOf(value) { return value.match(/(?:取件码|取货码|提货码|自提码)\s*(?:是|为)?\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,15})/)?.[1] || ''; }
function arrivalEvidence(value, rules) { return eventStatus(value, 'unknown', rules) === 'arrived'; }
function applyTrackEvidence(parcel, events, rules) {
  const doorstep = doorstepEvidence(events, parcel, parcel.logisticsCheckedAt);
  const pickup = pickupEvidence(events, rules);
  const evidence = doorstep.arrivalAt > pickup.arrivalAt ? doorstep : pickup;
  const reset = events.some(event => pickupCycleReset(event.description) && (!event.time || !parcel.arrivalAt || event.time >= parcel.arrivalAt));
  const stationConflict = evidence.station && parcel.station
    && evidence.station.replace(/[\s\p{P}]/gu, '') !== parcel.station.replace(/[\s\p{P}]/gu, '');
  if (evidence.arrivalAt || reset || stationConflict || !parcel.arrivalAt) Object.assign(parcel, evidence);
  else if (!parcel.station && evidence.station) Object.assign(parcel, { station: evidence.station, stationSource: evidence.stationSource });
  if (reset) parcel.pickupCode = '';
}

const TO_SHIP_TRADE_STATUS = 'WAIT_SELLER_SEND_GOODS';
const IN_TRANSIT_TRADE_STATUS = 'WAIT_BUYER_CONFIRM_GOODS';
const DONE_STATUS_TEXT = /(?<!待|未|拒)签收|拒签|交易成功|交易完成|交易关闭|已完成|已取消|失败|待付款|未付款|退款|退货/;
const TO_SHIP_STATUS_TEXT = /待发货|等待卖家发货|待卖家发货/;
const IN_TRANSIT_STATUS_TEXT = /待收货|已发货|运输中|派送中|派件中|物流派件中|待取件|物流中|已到达/;

function taobaoOrderInfo(order) {
  const platformOrderId = asText(order.id || order.orderId);
  const tradeStatus = asText(order.tradeStatus || order.extra?.tradeStatus || order.statusInfo?.tradeStatus);
  const orderStatus = asText(order.statusText || order.statusInfo?.text || order.extra?.statusText || order.extra?.tradeStatus);
  const orderDate = timestamp(order.createTime || order.orderTime || order.extra?.createTime);
  const orderDatePrecision = orderTimePrecision(order.createTime || order.orderTime || order.extra?.createTime);
  const rawAmount = order.payInfo?.actualFee ?? order.payInfo?.actualPay;
  const amount = rawAmount != null && /^\d+(?:\.\d+)?$/.test(String(rawAmount)) ? Number(rawAmount) : null;
  return { platformOrderId, tradeStatus, orderStatus, orderDate, orderDatePrecision, amount, refundStatus: asText(order.refundStatus) };
}

function taobaoOrderKind({ tradeStatus, orderStatus }) {
  if ((!tradeStatus || [TO_SHIP_TRADE_STATUS, IN_TRANSIT_TRADE_STATUS].includes(tradeStatus))
    && arrivalEvidence(orderStatus) && !/交易成功|交易完成|交易关闭|已完成|已取消|退款|退货/.test(orderStatus)) return 'in_transit';
  if (DONE_STATUS_TEXT.test(orderStatus)) return 'skip';
  if (tradeStatus === TO_SHIP_TRADE_STATUS) return 'to_ship';
  if (tradeStatus === IN_TRANSIT_TRADE_STATUS) return 'in_transit';
  if (tradeStatus) return 'skip';
  if (TO_SHIP_STATUS_TEXT.test(orderStatus)) return 'to_ship';
  if (IN_TRANSIT_STATUS_TEXT.test(orderStatus)) return 'in_transit';
  return 'skip';
}

export function taobaoParcels(fields, platformOrderId, fallbackCode = '', rules, checkedAt = Date.now()) {
  const packages = Array.isArray(fields.multiPackages?.packages) ? fields.multiPackages.packages : [];
  const baseNo = asText(fields.mailNo || fields.logisticCompany?.mailNo).trim();
  const sources = [...new Map(packages.filter(p => asText(p?.mailNo).trim()).map(p => [asText(p.mailNo).trim(), { ...p, mailNo: asText(p.mailNo).trim() }])).values()];
  if (baseNo && !sources.some(parcel => parcel.mailNo === baseNo)) sources.push({ mailNo: baseNo });
  return sources.map(parcel => {
    // A parent-level code is unsafe to copy onto every split shipment.
    const detail = parcel.fields || (parcel.multiStage ? parcel : null);
    const matches = value => [value?.mailNo, value?.logisticCompany?.mailNo].every(no => !asText(no).trim() || asText(no).trim() === parcel.mailNo);
    const specific = detail && matches(detail) ? detail : null;
    const selected = specific || ((!baseNo && sources.length === 1 || parcel.mailNo === baseNo) && matches(fields) ? fields : {});
    const allStages = Array.isArray(selected.multiStage) ? selected.multiStage.filter(stage => stage && typeof stage === 'object') : [];
    const stages = allStages.filter(stage => logisticsTimestamp(stage.time || stage.date || stage.occurTime || stage.subtitle, timestamp) <= checkedAt);
    let pickupCode = '', arrived = false;
    for (const stage of stages) {
      const content = stageText(stage);
      if (pickupCycleReset(`${stage.title || ''} ${content}`)) break;
      const card = stage.cardDesc || {};
      const code = asText(card.custom?.expressCode?.code) || codeOf(content);
      pickupCode ||= code;
      if (arrivalEvidence(`${stage.title || ''} ${content}`, rules)) arrived = true;
    }
    if (!pickupCode && sources.length === 1 && !stages.some(stage => pickupCycleReset(`${stage.title || ''} ${stageText(stage)}`))) pickupCode = fallbackCode;
    // A current structured collection code is itself evidence that the parcel is at a pickup point.
    arrived ||= !!pickupCode;
    const latest = `${stages[0]?.title || ''} ${stages[0] ? stageText(stages[0]) : ''}`;
    // The first stage is the platform's current event. A current station pickup
    // notice wins over generic "signed" wording; otherwise a current signature
    // supersedes older arrival/code evidence while that evidence is retained.
    const latestCard = stages[0]?.cardDesc || {};
    const latestCardText = `${latestCard.title || ''} ${latestCard.subTitle || ''}`;
    const latestStructuredPickup = !!latestCard.custom?.expressCode?.code || /驿站|代收点|代收|自提柜|快递柜|丰巢/.test(latestCardText);
    const latestAtPickupPoint = latestStructuredPickup || arrivalEvidence(latest, rules);
    const latestTitle = asText(stages[0]?.title).trim();
    const latestBody = stages[0] ? stageText(stages[0]) : '';
    const latestTransitTitle = /运输|发货|揽收|派送|派件中/.test(latestTitle);
    const latestTransit = latestTransitTitle || /运输|发货|揽收|派送|派件中/.test(latestBody);
    const latestBodySigned = /已完成签收|签收成功|已签收/.test(latestBody)
      && !/(?:未|待|拒绝?|请|等待|当面)[^，,。；;！？!?]{0,8}(?:已完成签收|签收成功|已签收)/.test(latestBody);
    const latestSigned = homeDeliveryCompleted(latest) || (!latestTransitTitle && /^(?:签收|已签收|签收成功)$/.test(latestTitle)) || (!latestTransitTitle && latestBodySigned);
    const status = latestAtPickupPoint ? 'arrived' : latestSigned ? 'signed' : latestTransit ? 'transit' : arrived ? 'arrived' : 'unknown';
    const { events: logisticsEvents, truncated: logisticsTruncated } = taobaoStageEvents(allStages, timestamp, stageText, rules, checkedAt);
    const carrier = asText(parcel.cpName || CARRIERS[parcel.cpCode] || selected.logisticCompany?.name || parcel.cpCode);
    const pickup = pickupEvidence(stages.filter(stage => stage && !/^送至/.test(asText(stage.title))).map(stage => {
      const rawTime = stage.time || stage.date || stage.occurTime || stage.subtitle;
      const description = `${stage.title || ''}：${stageText(stage)}`;
      return { time: logisticsTimestamp(rawTime, timestamp), timePrecision: logisticsTimePrecision(rawTime), description,
        station: arrivalEvidence(description, rules) ? [stage.cardDesc?.title, stage.cardDesc?.subTitle].filter(Boolean).join(' ') : '' };
    }), rules);
    const doorstep = doorstepEvidence(logisticsEvents, { carrier }, checkedAt);
    const evidence = doorstep.arrivalAt > pickup.arrivalAt ? doorstep : pickup;
    return { platformOrderId, waybillNo: parcel.mailNo, carrier,
      pickupCode, ...evidence, status, logisticsEvents, logisticsTruncated,
      logisticsState: logisticsEvents.length ? 'ok' : specific || selected === fields ? 'empty' : 'unavailable' };
  });
}

async function collectTaobao(cookie, { fetchImpl, now, maxPages, knownOrders = [], targetOrder, rules, runLogistics, onProgress, durableLogistics, onCookieRefresh }) {
  const session = { cookie, fetchImpl, now, onCookieRefresh };
  const orders = [], shipments = [], orderUpdates = [], warnings = [], logisticsFailures = [];
  const seen = new Set();
  const known = new Map(knownOrders.map(order => [asText(order.platformOrderId), order]));
  const knownParcels = id => activeKnownParcels(known.get(id));
  const logisticsOrders = [];
  let dateBudget = 10;
  let skippedCount = 0;
  const dateAttempted = new Set();
  let pickupCodes = {};
  async function enrichDate(metadata, forceDetail = false) {
    const previous = known.get(metadata.platformOrderId);
    const verifiedDetail = previous?.orderDateOrigin === 'detail' && ['second', 'minute', 'day'].includes(previous.orderDatePrecision);
    if (dateBudget <= 0 || dateAttempted.has(metadata.platformOrderId) || (verifiedDetail && (!targetOrder || previous.orderDate > 0)) || (!forceDetail && !targetOrder && !previous && metadata.orderDate)) return;
    const checkedAt = now();
    if (!targetOrder && previous?.dateCheckedAt && checkedAt - previous.dateCheckedAt < 24 * 60 * 60 * 1000) return;
    dateBudget--; dateAttempted.add(metadata.platformOrderId);
    metadata.dateCheckedAt = checkedAt;
    try {
      const data = await mtop(session, { appVersion: '3.0', appName: 'tborder', archive: false, from: 'OrderListActivity', useV2: 'true',
        bizOrderId: metadata.platformOrderId, extParams: JSON.stringify({ weexPage: 'neworderdetail4', isTBH5: 'true', useNewDetail: true, appChannel: '' }),
        ttid: '201200@taobao_h5_9.18.0', requestIdentity: '#t#ip#h5', condition: JSON.stringify({ version: '1.0.0' }) }, false, true);
      const { orderDate, orderDatePrecision } = taobaoDetailDateEvidence(data, timestamp);
      Object.assign(metadata, { dateState: orderDate ? 'ok' : 'empty', dateError: orderDate ? '' : '平台详情未返回有效下单日期' });
      if (orderDate) Object.assign(metadata, { orderDate, orderDatePrecision, orderDateOrigin: 'detail' });
    } catch (error) {
      if (mustStopLogistics(error, durableLogistics)) { stopped = error; interruption++; throw error; }
      Object.assign(metadata, { dateState: 'error', dateError: error.code === 'UPSTREAM_BLOCKED' ? '平台拒绝日期查询或触发风控，请稍后重试' : '日期查询未完成，已保留原日期' });
      warnings.push('部分下单日期补查暂不可用，未用同步时间替代');
    }
  }
  let stopped, interruption = 0;
  async function collectLogistics(platformOrderId) {
    const warnings = [], logisticsFailures = [];
    const checkedAt = now();
    try {
      const result = await platformRequest(`https://pages-g.m.taobao.com/wow/z/app/mtb/logisticsV2/h5-detail?x-ssr=true&bizOrderId=${encodeURIComponent(platformOrderId)}`, session.cookie, { fetchImpl });
      const fields = extractSsrFields(result.text);
      if (!fields) warnings.push('部分订单暂无可解析物流，订单仍保留');
      const parcels = taobaoParcels(fields || {}, platformOrderId, pickupCodes[platformOrderId], rules, checkedAt)
        .filter(parcel => activeParcel(known.get(platformOrderId), parcel.waybillNo));
      // The official package switch supplies these selectors; fetch only siblings without their own detail.
      for (const parcel of parcels.filter(item => item.logisticsState === 'unavailable')) {
        const selector = fields?.multiPackages?.packages?.find(item => asText(item?.mailNo).trim() === parcel.waybillNo);
        if (!selector || !asText(selector.cpCode || selector.orderCode)) continue;
        try {
          const query = new URLSearchParams({ 'x-ssr': 'true', bizOrderId: platformOrderId, mailNo: parcel.waybillNo });
          for (const key of ['cpCode', 'orderCode']) if (asText(selector[key])) query.set(key, asText(selector[key]));
          const detail = await platformRequest(`https://pages-g.m.taobao.com/wow/z/app/mtb/logisticsV2/h5-detail?${query}`, session.cookie, { fetchImpl });
          const selectedFields = extractSsrFields(detail.text);
          const selectedParcel = taobaoParcels(selectedFields || {}, platformOrderId, '', rules, checkedAt)
            .find(item => item.waybillNo === parcel.waybillNo && item.logisticsState !== 'unavailable');
          if (selectedParcel) Object.assign(parcel, selectedParcel);
          else parcel.logisticsError = '平台未返回该分包的独立物流';
        } catch (error) {
          if (mustStopLogistics(error, durableLogistics)) {
            const ready = parcels.filter(item => item.logisticsState === 'ok').map(item => ({ ...structuredClone(item), logisticsCheckedAt: checkedAt, logisticsUpdatedAt: checkedAt }));
            if (ready.length) await onProgress?.({ orders: [], orderUpdates: [], shipments: ready, logisticsFailures: [], warnings: [] });
            stopped = error; interruption++; throw error;
          }
          parcel.logisticsError = '分包物流查询失败，已保留其余运单';
          warnings.push('部分分包物流查询失败，已保留其余运单');
        }
      }
      // A partial split response must also record the attempt for known active
      // waybills it omits, without copying another parcel's events or pickup code.
      for (const parcel of knownParcels(platformOrderId)) {
        if (parcels.some(item => item.waybillNo === asText(parcel.waybillNo))) continue;
        parcels.push({ platformOrderId, waybillNo: asText(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status,
          logisticsEvents: [], logisticsState: 'unavailable', logisticsError: '平台未返回该运单轨迹' });
      }
      for (const parcel of parcels) {
        parcel.logisticsCheckedAt = checkedAt;
        if (parcel.logisticsState !== 'unavailable') parcel.logisticsUpdatedAt = checkedAt;
      }
      if (!parcels.length) logisticsFailures.push({ platformOrderId, state: 'unavailable', logisticsCheckedAt: checkedAt });
      if (parcels.length > 1 && parcels.some(p => p.logisticsState === 'unavailable')) warnings.push('部分拆单运单仅返回单号，等待平台提供各运单物流');
      return { platformOrderId, parcels, warnings, logisticsFailures };
    } catch (error) {
      if (mustStopLogistics(error, durableLogistics)) { stopped = error; interruption++; throw error; }
      // Full PC tracking remains available when the active parcel's SSR summary fails.
      const parcels = knownParcels(platformOrderId).map(parcel => ({ platformOrderId, waybillNo: asText(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status,
        logisticsEvents: [], logisticsState: 'error', logisticsError: '物流摘要查询失败，已保留原轨迹', logisticsCheckedAt: checkedAt }));
      if (!parcels.length) logisticsFailures.push({ platformOrderId, state: 'error', logisticsCheckedAt: checkedAt });
      warnings.push('部分订单物流读取失败，已保留原运单');
      return { platformOrderId, parcels, warnings, logisticsFailures };
    }
  }
  if (targetOrder) {
    const platformOrderId = asText(targetOrder.platformOrderId), metadata = { platformOrderId };
    await enrichDate(metadata); orderUpdates.push(metadata);
    logisticsOrders.push(platformOrderId);
  } else {
    try {
      const data = await mtop(session, { tabCode: 'waitConfirm', appVersion: '3.0', OrderType: 'OrderList', condition: { inner: 1, deviceLevel: 'high', version: '1.0.0', reqFrom: 'tbpc' }, appName: 'tborder', templateConfigVersion: 0, forceBoughtlist4: 4, page: '1' }, true);
      for (const [key, cell] of Object.entries(data.data || {})) {
        if (key.startsWith('comServiceTips_')) {
          const code = codeOf((cell.fields?.singleLineRiceText || []).map(x => x.richStr || '').join(' '));
          if (code) pickupCodes[cell.id || key.slice('comServiceTips_'.length)] = code;
        }
      }
    } catch (error) {
      if (mustStopLogistics(error, durableLogistics)) { stopped = error; interruption++; throw error; }
      warnings.push('订单列表取件码暂不可用，仍保留物流和无码运单');
    }
    for (let page = 1; page <= maxPages; page++) {
      const data = await mtop(session, { tabCode: 'all', page: String(page), orderType: 'OrderList', templateConfigVersion: '0', appName: 'tborder', appVersion: '3.0', condition: '{"version":"1.0.0","appChannel":""}', ttid: '201200@taobao_h5_9.18.0', requestIdentity: '#t#ip#h5' });
      const inner = typeof data.result === 'string' ? json(data.result) : data.result || data.data;
      if (!Array.isArray(inner?.mainOrders)) throw new CollectorError('UPSTREAM_FORMAT', '淘宝订单字段已变化，保留上次数据');
      if (!inner.mainOrders.length) break;
      let newCount = 0;
      for (const order of inner.mainOrders) {
        const info = taobaoOrderInfo(order);
        const platformOrderId = info.platformOrderId;
        if (!platformOrderId || seen.has(platformOrderId)) continue;
        newCount++; seen.add(platformOrderId);
        const kind = taobaoOrderKind(info);
        if (kind === 'skip') skippedCount++;
        const previous = known.get(platformOrderId);
        if (previous && !isActiveKnownOrder(previous) || kind === 'skip' && !previous) continue;
        const metadata = { platformOrderId, tradeStatus: info.tradeStatus, orderStatus: info.orderStatus, orderDate: info.orderDate, orderDatePrecision: info.orderDatePrecision, ...(info.orderDate ? { orderDateOrigin: 'list' } : {}), refundStatus: info.refundStatus };
        await enrichDate(metadata);
        if (kind === 'skip') orderUpdates.push(metadata);
        if (kind !== 'skip') {
          orders.push({ ...metadata, title: (order.subOrders || []).map(s => s.itemInfo?.title || '').filter(Boolean).join(' / '), amount: info.amount,
            imageUrl: productImage((order.subOrders || []).map(suborder => suborder.itemInfo), ['pic', 'picUrl', 'imageUrl']) });
        }
        // Waiting for seller shipment has no useful logistics detail yet.
        if (kind === 'to_ship') continue;
        logisticsOrders.push(platformOrderId);
      }
      if (!newCount) { warnings.push('平台分页重复，停止本轮采集并保留已有记录'); break; }
      if (page === maxPages) warnings.push('已达到分页上限；缺席订单不会标记为已取或删除');
    }
    for (const order of activeKnownOrders(knownOrders, seen, knownOrders.length)) logisticsOrders.push(asText(order.platformOrderId));
  }
  async function collectComplete({ platformOrderId }) {
    const attempt = interruption;
    const result = await collectLogistics(platformOrderId);
    if (attempt !== interruption) throw stopped;
    const { parcels, warnings, logisticsFailures } = result;
    const checkedAt = now();
    const fullTracks = new Map();
    for (const parcel of parcels) Object.assign(parcel, { logisticsCheckedAt: checkedAt, logisticsDetailCheckedAt: checkedAt });
    try {
      const response = await platformRequest(`https://buyertrade.taobao.com/trade/json/transit_step.do?bizOrderId=${encodeURIComponent(platformOrderId)}`, session.cookie,
        { fetchImpl, encoding: 'gbk', headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://buyertrade.taobao.com/' } });
      const data = json(response.text);
      if (!Array.isArray(data.address)) throw new CollectorError('UPSTREAM_FORMAT', '淘宝物流轨迹字段已变化');
      // The fallback returns one expressId. Never fan its track out across a split order.
      let parcel = parcels.find(item => item.waybillNo === asText(data.expressId));
      if (!parcels.length && asText(data.expressId) && activeParcel(known.get(platformOrderId), data.expressId)) {
        parcel = { platformOrderId, waybillNo: asText(data.expressId), carrier: asText(data.expressName), status: 'unknown', logisticsEvents: [],
          logisticsState: 'empty', logisticsCheckedAt: checkedAt, logisticsDetailCheckedAt: checkedAt };
        parcels.push(parcel);
      }
      if (parcel) {
        const transit = taobaoTransitEvents(data, timestamp, rules, checkedAt);
        fullTracks.set(parcel.waybillNo, transit.events);
        const metadata = [orders.find(order => order.platformOrderId === platformOrderId), orderUpdates.find(order => order.platformOrderId === platformOrderId), known.get(platformOrderId)]
          .find(order => order?.orderDateOrigin === 'detail' && order.orderDate > 0);
        const notBefore = metadata?.orderDate || 0;
        parcel.logisticsEvents = corroborateTaobaoEventTimes(parcel.logisticsEvents, transit.events, checkedAt, { notBefore });
        const usableSummary = parcel.logisticsEvents.filter(event => logisticsEventTimeIssue(event, checkedAt) !== 'timeConflict');
        const latestTransit = transit.events.find(event => logisticsEventTimeIssue(event, checkedAt) !== 'timeConflict');
        const canUpdateStatus = parcel.status === 'unknown' || !parcel.logisticsEvents.length
          || (usableSummary.length && usableSummary.every(event => event.time > 0) && latestTransit?.time >= usableSummary[0].time);
        const combined = normalizeLogisticsEvents([...transit.events, ...parcel.logisticsEvents], timestamp, rules, checkedAt);
        const events = combined.events;
        if (events.length) {
          parcel.logisticsEvents = events;
          parcel.logisticsTruncated = !!(transit.truncated || parcel.logisticsTruncated || combined.truncated);
          parcel.logisticsState = 'ok';
          parcel.logisticsError = '';
          // An undated SSR pickup notice can be newer than a dated PC event.
          // Only replace its current state when the two sources can be ordered.
          const usable = events.filter(event => logisticsEventTimeIssue(event, checkedAt) !== 'timeConflict');
          if (canUpdateStatus && usable.length) parcel.status = eventStatus(usable[0].description, parcel.status, rules);
          parcel.carrier ||= asText(data.expressName);
          if (canUpdateStatus) applyTrackEvidence(parcel, usable, rules);
        }
        parcel.logisticsUpdatedAt = checkedAt;
        if (!events.length) { parcel.logisticsState = 'empty'; parcel.logisticsError = '平台本次未返回物流轨迹'; }
        for (let i = logisticsFailures.length - 1; i >= 0; i--) if (logisticsFailures[i].platformOrderId === platformOrderId) logisticsFailures.splice(i, 1);
      }
    } catch (error) {
      if (mustStopLogistics(error, durableLogistics)) { stopped = error; interruption++; throw error; }
      for (const parcel of parcels) parcel.logisticsError = '完整物流查询失败，当前仅保留已有节点';
      for (const parcel of parcels.filter(item => !item.logisticsEvents.length)) {
        parcel.logisticsState = 'error';
        parcel.logisticsError = '完整物流查询失败，已保留上次轨迹';
        delete parcel.logisticsUpdatedAt;
      }
      warnings.push('部分物流轨迹补查失败，已保留上次轨迹');
    }
    if (attempt !== interruption) throw stopped;
    const updates = [];
    const detailOrder = () => [orders.find(order => order.platformOrderId === platformOrderId), orderUpdates.find(order => order.platformOrderId === platformOrderId), known.get(platformOrderId)]
      .find(order => order?.orderDateOrigin === 'detail' && order.orderDate > 0 && ['second', 'minute', 'day'].includes(order.orderDatePrecision));
    if (!detailOrder() && parcels.some(parcel => parcel.logisticsEvents.some(taobaoTimeAnchorCandidate))) {
      const metadata = { platformOrderId };
      try { await enrichDate(metadata, true); }
      catch (error) {
        await onProgress?.({ orders: [], orderUpdates: [], shipments: parcels, warnings, logisticsFailures });
        throw error;
      }
      if (attempt !== interruption) throw stopped;
      if (metadata.dateCheckedAt) {
        updates.push(metadata);
        const listed = orders.find(order => order.platformOrderId === platformOrderId);
        const prior = orderUpdates.find(order => order.platformOrderId === platformOrderId);
        if (listed) Object.assign(listed, metadata);
        else if (prior) Object.assign(prior, metadata);
        else orderUpdates.push(metadata);
      }
    }
    const anchor = detailOrder();
    for (const parcel of parcels) {
      parcel.logisticsEvents = anchorTaobaoEventTimes(parcel.logisticsEvents, anchor, checkedAt, fullTracks.get(parcel.waybillNo));
    }
    return { shipments: parcels, orderUpdates: updates, warnings, logisticsFailures };
  }
  for (const order of (targetOrder ? [] : knownOrders).filter(item => isActiveKnownOrder(item) && !seen.has(asText(item.platformOrderId))).sort((a, b) => (a.dateCheckedAt || 0) - (b.dateCheckedAt || 0))) {
    if (dateBudget <= 0) break;
    const metadata = { platformOrderId: asText(order.platformOrderId) };
    await enrichDate(metadata);
    if (metadata.dateCheckedAt) orderUpdates.push(metadata);
  }
  await onProgress?.({ orders, shipments: [], orderUpdates, logisticsFailures: [], warnings: [...new Set(warnings)] });
  const lastLogisticsCheck = id => {
    const parcels = knownParcels(id);
    return parcels.length ? Math.min(...parcels.map(parcel => parcel.logisticsDetailCheckedAt || 0)) : 0;
  };
  const candidates = [...new Set(logisticsOrders)].map(platformOrderId => ({ platformOrderId }))
    .sort((a, b) => lastLogisticsCheck(a.platformOrderId) - lastLogisticsCheck(b.platformOrderId));
  const results = await runLogistics(candidates, collectComplete, {
    stage: 'taobao-detail', concurrency: 2, key: item => item.platformOrderId,
    onResult: async result => {
      warnings.push(...result.warnings); logisticsFailures.push(...result.logisticsFailures);
      await onProgress?.({ orders: [], orderUpdates: [], ...result });
    },
  });
  const byOrder = new Map(candidates.map((item, index) => [item.platformOrderId, results[index]]));
  for (const id of new Set(logisticsOrders)) shipments.push(...byOrder.get(id).shipments);
  for (const item of candidates) if (!logisticsOrders.includes(item.platformOrderId)) shipments.push(...byOrder.get(item.platformOrderId).shipments);
  if (skippedCount) warnings.push(`订单筛选：本轮保留${orders.length}笔，跳过${skippedCount}笔已结束或非待收货订单`);
  return { orders, shipments, orderUpdates, logisticsFailures, warnings: [...new Set(warnings)], refreshedCookie: session.cookie };
}

function pddCheck(value) {
  if (String(value.error_code) === '40001') expired();
  if (value.error_code || value.success === false) upstream();
  return value;
}
const PDD_WAYBILL_PLACEHOLDERS = new Set(['待发货', '暂无', '无', '0', 'WAITING_FOR_CARRIER']);
const pddWaybill = value => asText(value).normalize('NFKC').trim();
const validPddWaybill = value => {
  const waybillNo = pddWaybill(value);
  return !!waybillNo && !PDD_WAYBILL_PLACEHOLDERS.has(waybillNo.toUpperCase());
};
// Official orders.html bundle (2026-10-31): UI tab 2/3 -> PATH_TYPE unshipping/unreceived;
// getOrdersList uses PATH_TYPE and a separate offset per tab. Keep the existing GET transport.
// https://static.pddpic.com/assets/js/react_orders_7c4eb98c8a268eacd674.js
function pddStatusText(order) {
  return asText(order.order_status_text || order.status_text || order.order_status_prompt)
    || (/\D/.test(asText(order.order_status)) ? asText(order.order_status) : '');
}
function pddOrderKind(order, type) {
  const status = pddStatusText(order);
  const combined = asText(order.combined_order_status);
  // Official combined states: 0=Unpayed, 5=Cancelled, 10=Expired, 15=Deleted.
  // Received/refund enums do not prove pickup or a full refund; keep records returned by these active tabs.
  if (/交易成功|交易完成|交易关闭|订单已完成|订单已结束|已取消|待付款|未付款|待支付|未支付/.test(status)
    || /全额退款(?:已)?(?:成功|完成)|已全额退款/.test(`${status} ${asText(order.refund_status)}`)
    || ['0', '5', '10', '15'].includes(combined)
    || asText(order.order_status) === '2' || asText(order.pay_status) === '0') return 'skip';
  if (combined === '3' || asText(order.shipping_status) === '1' || IN_TRANSIT_STATUS_TEXT.test(status)) return 'in_transit';
  if (combined === '2' || TO_SHIP_STATUS_TEXT.test(status)) return 'to_ship';
  return type === 'unshipping' ? 'to_ship' : 'in_transit';
}
export function pddParcels(order, cabinet, rules) {
  const platformOrderId = asText(order.order_sn);
  const listed = order.shipping_list || order.express_list || order.package_list;
  const parcels = Array.isArray(listed) && listed.length ? listed : order.tracking_number ? [order] : [];
  return parcels.filter(parcel => validPddWaybill(parcel.tracking_number || parcel.mail_no)).map(parcel => {
    const waybillNo = pddWaybill(parcel.tracking_number || parcel.mail_no);
    const cabinetMatches = pddOrderMatches(cabinet, platformOrderId) && pddWaybillMatches(cabinet, waybillNo)
      && (parcels.length === 1 || pddWaybill(cabinet.tracking_number || cabinet.trackingNumber) === waybillNo);
    const code = cabinetMatches ? asText(cabinet.code).trim() : '';
    const statusText = asText(parcel.shipping_status_text || order.order_status_text || order.status_text);
    const status = eventStatus(statusText, /交易成功|交易完成/.test(statusText) ? 'signed' : code || (cabinetMatches && cabinet.arrival_time) ? 'arrived' : 'transit', rules);
    const arrivalTime = cabinetMatches && status === 'arrived' ? cabinet.arrival_time || cabinet.create_time : 0;
    const arrivalAt = logisticsTimestamp(arrivalTime, timestamp);
    const station = cabinetMatches && status === 'arrived' ? asText(cabinet.address) : '';
    return { platformOrderId, waybillNo, carrier: asText(parcel.shipping_name || parcel.company_name),
      pickupCode: code, station, stationSource: station ? 'locker' : 'unknown', status, arrivalAt,
      arrivalAtSource: arrivalAt ? cabinet.arrival_time ? 'locker_arrival' : 'locker_created' : 'unknown',
      arrivalAtPrecision: arrivalAt ? logisticsTimePrecision(arrivalTime) : 'unknown' };
  });
}
async function collectPdd(cookie, { fetchImpl, maxPages, now, knownOrders = [], targetOrder, rules, runLogistics, onProgress, durableLogistics }) {
  const uid = cookie.match(/(?:^|;\s*)(?:pdd_user_id|pdduid)=([^;]+)/)?.[1];
  if (!uid) expired();
  const headers = { Referer: 'https://mobile.yangkeduo.com/orders.html' };
  const orders = [], shipments = [], orderUpdates = [], warnings = [], logisticsFailures = [];
  const seen = new Set();
  const known = new Map(knownOrders.map(order => [asText(order.platformOrderId), order]));
  let skippedCount = 0;
  const splitOptions = platformOrderId => ({ expectedOrderId: platformOrderId, pddCheck,
    platformRequest: url => platformRequest(url, cookie, { fetchImpl, headers }) });
  const applyShipping = (parcel, shipping, checkedAt) => {
    const { events, truncated } = pddShippingEvents(shipping, timestamp, rules, checkedAt);
    Object.assign(parcel, { logisticsEvents: events, logisticsTruncated: truncated,
      logisticsState: events.length ? 'ok' : 'empty', logisticsError: events.length ? '' : '平台本次未返回物流轨迹',
      logisticsCheckedAt: checkedAt, logisticsUpdatedAt: checkedAt });
    const usable = events.filter(event => logisticsEventTimeIssue(event, checkedAt) !== 'timeConflict');
    if (usable.length) { parcel.status = eventStatus(usable[0].description, parcel.status, rules); applyTrackEvidence(parcel, usable, rules); }
  };
  async function collectLogistics({ platformOrderId, parcels: inputParcels, missingFromList }) {
    const parcels = structuredClone(inputParcels), logisticsFailures = [], warnings = [], splitParcels = [];
    const checkedAt = now();
    try {
      const query = new URLSearchParams({ query_type: '2', entry_source: '2', ts: String(checkedAt) });
      const response = await platformRequest(`https://mobile.yangkeduo.com/proxy/api/order/${encodeURIComponent(platformOrderId)}/shipping?${query}`, cookie, { fetchImpl, headers });
      const payload = pddCheck(json(response.text)), shipping = payload.shipping;
      if (!shipping || !Array.isArray(shipping.traces)) throw new CollectorError('UPSTREAM_FORMAT', '拼多多物流轨迹字段已变化');
      const waybillNo = pddWaybill(shipping.tracking_number || shipping.trackingNumber);
      if (!pddOrderMatches(payload, platformOrderId) || !pddOrderMatches(shipping, platformOrderId) || !pddWaybillMatches(shipping, waybillNo)) {
        throw new CollectorError('UPSTREAM_FORMAT', '拼多多物流订单或运单标识不匹配');
      }
      let target = waybillNo ? parcels.find(parcel => parcel.waybillNo === waybillNo) : parcels.length === 1 ? parcels[0] : null;
      if (!target && validPddWaybill(waybillNo) && activeParcel(known.get(platformOrderId), waybillNo)) {
        const candidate = { platformOrderId, waybillNo, carrier: asText(shipping.shipping_name || shipping.shippingName), status: 'unknown' };
        applyShipping(candidate, shipping, checkedAt);
        // A new waybill needs its own usable track; cached sibling events cannot establish it.
        if (candidate.logisticsEvents.some(event => logisticsEventTimeIssue(event, checkedAt) !== 'timeConflict')) {
          parcels.push(candidate); target = candidate;
        }
      } else if (target) {
        if (waybillNo === target.waybillNo) target.carrier = asText(shipping.shipping_name || shipping.shippingName) || target.carrier;
        applyShipping(target, shipping, checkedAt);
      }
      let discovered = { parcels: [], failures: [] };
      try { discovered = await discoverPddSplit(shipping, splitOptions(platformOrderId)); }
      catch (error) {
        if (mustStopLogistics(error, durableLogistics)) {
          // A retryable sibling query must not discard the independently verified main track.
          if (target) await onProgress?.({ orders: [], orderUpdates: [], shipments: [structuredClone(target)], logisticsFailures: [], warnings: [] });
          throw error;
        }
        warnings.push('分包列表查询失败，已保留主运单轨迹');
      }
      splitParcels.push(...discovered.parcels.filter(parcel => parcel.waybillNo !== target?.waybillNo && activeParcel(known.get(platformOrderId), parcel.waybillNo))
        .map(parcel => ({ ...parcel, platformOrderId })));
      logisticsFailures.push(...discovered.failures.filter(failure => failure.waybillNo).map(failure => ({ platformOrderId, ...failure, logisticsCheckedAt: checkedAt })));
      if (discovered.failures.some(failure => !failure.waybillNo)) warnings.push('部分分包缺少有效运单标识，已保留其余已验证运单');
      if (!parcels.length && !splitParcels.length) logisticsFailures.push({ platformOrderId, state: 'unavailable', logisticsCheckedAt: checkedAt });
      for (const parcel of parcels) {
        if (parcel !== target && !splitParcels.some(split => split.waybillNo === parcel.waybillNo)) logisticsFailures.push({ platformOrderId, waybillNo: parcel.waybillNo, state: 'unavailable', logisticsCheckedAt: checkedAt });
      }
    } catch (error) {
      if (mustStopLogistics(error, durableLogistics)) throw error;
      if (!parcels.length) logisticsFailures.push({ platformOrderId, state: 'error', logisticsCheckedAt: checkedAt });
      for (const parcel of parcels) logisticsFailures.push({ platformOrderId, waybillNo: parcel.waybillNo, state: 'error', logisticsCheckedAt: checkedAt });
      warnings.push('部分物流轨迹读取失败，已保留上次轨迹');
    }
    return { shipments: missingFromList ? parcels.filter(parcel => parcel.logisticsState) : parcels, logisticsFailures, warnings, splitParcels };
  }
  const applyResult = async result => {
    logisticsFailures.push(...result.logisticsFailures); warnings.push(...result.warnings);
    const { splitParcels, ...delta } = result;
    await onProgress?.({ orders: [], orderUpdates: [], ...delta });
  };
  async function collectSplits(results) {
    const candidates = [...new Map(results.flatMap(result => result.splitParcels || []).map(parcel => [`${parcel.platformOrderId}:${parcel.waybillNo}`, parcel])).values()];
    const splitResults = await runLogistics(candidates, async candidate => {
      const checkedAt = now(), platformOrderId = candidate.platformOrderId;
      const result = { shipments: [], logisticsFailures: [], warnings: [] };
      try {
        const detail = await fetchPddSplitTrack(candidate, { ...splitOptions(platformOrderId), queryType: 2 });
        if (detail.failure) result.logisticsFailures.push({ platformOrderId, ...detail.failure, logisticsCheckedAt: checkedAt });
        else {
          const parcel = { platformOrderId, waybillNo: candidate.waybillNo, carrier: candidate.carrier, status: 'unknown' };
          if (candidate.external === '1') {
            try {
              const resultCabinet = await fetchPddSplitCabinet(candidate, splitOptions(platformOrderId));
              if (resultCabinet.cabinet) Object.assign(parcel, pddParcels({ order_sn: platformOrderId, tracking_number: candidate.waybillNo,
                shipping_name: candidate.carrier }, resultCabinet.cabinet, rules)[0]);
              else result.warnings.push('部分分包柜码信息未通过运单核对，已保留物流轨迹');
            } catch (error) {
              if (mustStopLogistics(error, durableLogistics)) {
                applyShipping(parcel, detail.shipping, checkedAt);
                await onProgress?.({ orders: [], orderUpdates: [], shipments: [parcel], logisticsFailures: [], warnings: [] });
                throw error;
              }
              result.warnings.push('部分分包取件码查询失败，已保留物流轨迹');
            }
          }
          applyShipping(parcel, detail.shipping, checkedAt); result.shipments.push(parcel);
        }
      } catch (error) {
        if (mustStopLogistics(error, durableLogistics)) throw error;
        result.logisticsFailures.push({ platformOrderId, waybillNo: candidate.waybillNo, state: 'error', logisticsCheckedAt: checkedAt });
      }
      return result;
    }, { stage: 'pdd-split-track', concurrency: 2, key: item => `${item.platformOrderId}:${item.waybillNo}`, onResult: applyResult });
    return splitResults.flatMap(result => result.shipments);
  }
  if (targetOrder) {
    const platformOrderId = asText(targetOrder.platformOrderId);
    const parcels = activeKnownParcels(targetOrder).filter(parcel => validPddWaybill(parcel.waybillNo)).map(parcel => ({
      platformOrderId, waybillNo: pddWaybill(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status,
    }));
    const hasDate = targetOrder.orderDateSource === 'platform' && targetOrder.orderDate > 0;
    const metadata = { platformOrderId, dateCheckedAt: now(), dateState: 'unavailable',
      dateError: hasDate ? '拼多多暂不支持单单日期详情查询，已保留平台列表日期' : '拼多多暂未提供可验证的单单日期查询，日期仍待确认' };
    await onProgress?.({ orders: [], orderUpdates: [metadata], shipments: [], logisticsFailures: [], warnings: [] });
    const results = await runLogistics([{ platformOrderId, parcels }], async candidate => {
      const cabinet = await enrichCabinet({ ...candidate, orderStatus: targetOrder.orderStatus });
      const result = await collectLogistics({ ...candidate, parcels: cabinet.shipments });
      result.warnings.push(...cabinet.warnings); return result;
    }, { stage: 'pdd-logistics', concurrency: 2, key: item => item.platformOrderId, onResult: applyResult });
    const splits = await collectSplits(results);
    const combined = new Map([...(results[0]?.shipments || parcels), ...splits].map(parcel => [parcel.waybillNo, parcel]));
    return { orders: [], orderUpdates: [metadata], shipments: [...combined.values()], logisticsFailures, warnings };
  }
  const listedOrders = new Map(), rejectedIds = new Set();
  for (const type of ['unshipping', 'unreceived']) {
    let offset = '';
    const rangeSeen = new Set();
    for (let page = 1; page <= maxPages; page++) {
      const query = new URLSearchParams({ pdduid: uid, page: String(page), type });
      if (offset) query.set('offset', offset);
      // A failure in either range aborts this batch; callers keep the previous successful snapshot.
      const response = await platformRequest(`https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4?${query}`, cookie, { fetchImpl, headers });
      const data = pddCheck(json(response.text));
      if (!Array.isArray(data.orders)) throw new CollectorError('UPSTREAM_FORMAT', '拼多多订单字段已变化，保留上次数据');
      if (!data.orders.length) break;
      let newCount = 0;
      for (const order of data.orders) {
        const platformOrderId = asText(order.order_sn);
        if (!platformOrderId || rangeSeen.has(platformOrderId)) continue;
        newCount++; rangeSeen.add(platformOrderId); seen.add(platformOrderId);
        const previous = listedOrders.get(platformOrderId);
        const kind = pddOrderKind(order, type);
        const knownOrder = known.get(platformOrderId);
        if (knownOrder && !isActiveKnownOrder(knownOrder) || kind === 'skip' && !knownOrder) {
          if (kind === 'skip') skippedCount++;
          rejectedIds.add(platformOrderId); listedOrders.delete(platformOrderId); continue;
        }
        if (rejectedIds.has(platformOrderId)) continue;
        const ranks = { to_ship: 0, in_transit: 1, skip: 2 };
        const useIncoming = !previous || ranks[kind] >= ranks[previous.kind];
        const merged = useIncoming ? { ...previous?.order, ...order } : { ...order, ...previous.order };
        const parcels = new Map((previous?.parcels || []).map(parcel => [parcel.waybillNo, parcel]));
        for (const parcel of pddParcels(order, {}, rules).filter(parcel => activeParcel(knownOrder, parcel.waybillNo))) {
          const prior = parcels.get(parcel.waybillNo);
          parcels.set(parcel.waybillNo, { ...parcel, carrier: parcel.carrier || prior?.carrier || '',
            status: parcel.status === 'signed' || prior?.status === 'signed' ? 'signed' : parcel.status });
        }
        const orderStatus = pddStatusText(order) || (kind === 'to_ship' ? '待发货' : kind === 'in_transit' ? '待收货' : asText(order.order_status));
        listedOrders.set(platformOrderId, { order: merged, kind: useIncoming ? kind : previous.kind,
          orderStatus: useIncoming ? orderStatus : previous.orderStatus, parcels: [...parcels.values()] });
      }
      if (!newCount) { warnings.push(`平台${type === 'unshipping' ? '待发货' : '待收货'}分页重复，停止该范围采集并保留已有记录`); break; }
      offset = asText(data.orders.at(-1)?.offset);
      if (data.has_more === false || data.hasMore === false) break;
      if (page === maxPages) warnings.push(`已达到${type === 'unshipping' ? '待发货' : '待收货'}分页上限；缺席订单不会标记为已取或删除`);
    }
  }
  const listed = [];
  for (const [platformOrderId, { order, kind, orderStatus, parcels }] of listedOrders) {
    const metadata = { platformOrderId,
      amount: Number.isFinite(order.order_amount) ? order.order_amount / 100 : null, orderDate: timestamp(order.order_time || order.created_time || order.create_time),
      ...(timestamp(order.order_time || order.created_time || order.create_time) ? { orderDateOrigin: 'list', orderDatePrecision: orderTimePrecision(order.order_time || order.created_time || order.create_time) } : {}),
      orderStatus, refundStatus: asText(order.refund_status) };
    if (kind === 'skip') {
      skippedCount++; orderUpdates.push(metadata); seen.delete(platformOrderId);
      continue;
    }
    orders.push({ ...metadata, title: (order.order_goods || []).map(g => g.goods_name || g.goods_title || '').filter(Boolean).join(' / '),
      imageUrl: productImage(order.order_goods, ['thumb_url', 'thumbUrl']) });
    listed.push({ platformOrderId, kind, orderStatus, parcels });
  }
  await onProgress?.({ orders, shipments: [], orderUpdates, logisticsFailures: [], warnings: [...new Set(warnings)] });
  async function enrichCabinet({ platformOrderId, orderStatus, parcels: inputParcels }) {
    const parcels = structuredClone(inputParcels), warnings = [];
    if (parcels.length) {
      try {
        const response = await platformRequest(`https://mobile.yangkeduo.com/proxy/api/api/express/cabinet/${encodeURIComponent(platformOrderId)}`, cookie, { fetchImpl, headers });
        const cabinet = pddCheck(json(response.text)).result || {};
        const enriched = pddParcels({ order_sn: platformOrderId, order_status_text: orderStatus,
          shipping_list: parcels.map(parcel => ({ tracking_number: parcel.waybillNo, shipping_name: parcel.carrier,
            shipping_status_text: parcel.status === 'signed' ? '已签收' : parcel.status === 'arrived' ? '待取件' : '' })) }, cabinet, rules);
        for (let i = 0; i < parcels.length; i++) Object.assign(parcels[i], enriched[i]);
      } catch (error) {
        if (mustStopLogistics(error, durableLogistics)) throw error;
        warnings.push('部分驿站取件码暂不可用，无码运单继续保留');
      }
    }
    for (const parcel of activeKnownParcels(knownOrders.find(item => asText(item.platformOrderId) === platformOrderId))) {
      if (parcels.some(item => item.waybillNo === pddWaybill(parcel.waybillNo))) continue;
      parcels.push({ platformOrderId, waybillNo: pddWaybill(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status });
    }
    return { shipments: parcels, logisticsFailures: [], warnings };
  }
  const candidates = listed.map(item => ({ ...item, parcels: [...item.parcels] }));
  for (const candidate of candidates) for (const parcel of activeKnownParcels(knownOrders.find(order => asText(order.platformOrderId) === candidate.platformOrderId))) {
    if (!candidate.parcels.some(item => item.waybillNo === pddWaybill(parcel.waybillNo))) candidate.parcels.push({
      platformOrderId: candidate.platformOrderId, waybillNo: pddWaybill(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status });
  }
  for (const order of activeKnownOrders(knownOrders, seen, knownOrders.length)) {
    const platformOrderId = asText(order.platformOrderId);
    const parcels = activeKnownParcels(order).map(parcel => ({
      platformOrderId, waybillNo: pddWaybill(parcel.waybillNo), carrier: asText(parcel.carrier), status: parcel.status,
    }));
    candidates.push({ platformOrderId, parcels, missingFromList: true });
  }
  const lastChecked = id => {
    const parcels = activeKnownParcels(knownOrders.find(order => asText(order.platformOrderId) === id));
    return parcels.length ? Math.min(...parcels.map(parcel => parcel.logisticsCheckedAt || 0)) : 0;
  };
  const selected = candidates.filter(candidate => candidate.parcels.length || candidate.missingFromList || candidate.kind === 'in_transit')
    .sort((a, b) => lastChecked(a.platformOrderId) - lastChecked(b.platformOrderId));
  let interrupted = 0, interruption;
  const results = await runLogistics(selected, async candidate => {
    const generation = interrupted;
    try {
      const cabinet = candidate.missingFromList ? { shipments: candidate.parcels, warnings: [] } : await enrichCabinet(candidate);
      if (generation !== interrupted) throw interruption;
      const result = await collectLogistics({ ...candidate, parcels: cabinet.shipments });
      result.warnings.push(...cabinet.warnings);
      return result;
    } catch (error) { if (mustStopLogistics(error, durableLogistics)) { interrupted++; interruption = error; } throw error; }
  }, {
    stage: 'pdd-logistics', concurrency: 2, key: item => item.platformOrderId, onResult: applyResult,
  });
  const byOrder = new Map(selected.map((item, index) => [item.platformOrderId, results[index]]));
  for (const candidate of candidates) shipments.push(...(byOrder.get(candidate.platformOrderId)?.shipments || candidate.parcels));
  for (const item of selected) if (!candidates.some(candidate => candidate.platformOrderId === item.platformOrderId)) shipments.push(...byOrder.get(item.platformOrderId).shipments);
  for (const parcel of await collectSplits(results)) {
    const index = shipments.findIndex(current => current.platformOrderId === parcel.platformOrderId && current.waybillNo === parcel.waybillNo);
    if (index < 0) shipments.push(parcel); else shipments[index] = parcel;
  }
  if (skippedCount) warnings.push(`订单筛选：本轮保留${orders.length}笔，跳过${skippedCount}笔已结束或非待发货/待收货订单`);
  return { orders, shipments, orderUpdates, logisticsFailures, warnings: [...new Set(warnings)] };
}

function jdCheck(data) {
  // Verified PC buyer APIs return HTTP 200 with { code: 3 } after logout.
  if (String(data?.code) === '3') expired();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new CollectorError('UPSTREAM_FORMAT', '京东返回结构已变化，已保留原记录');
  if (data.success === false || (data.code != null && String(data.code) !== '0')) upstream();
  return data;
}

function jdOrderKind(order) {
  const status = asText(order.statusInfo?.orderStateName);
  // PC samples: type 4 is local services, type 69 / wareType 1 is virtual goods.
  if ([4, 69].includes(Number(order.orderType)) || order.wareList?.length && order.wareList.every(ware => Number(ware.wareType) === 1)) return 'skip';
  if (Number(order.statusInfo?.orderState) !== 18 && arrivalEvidence(status)
    && !/已完成|已取消|已关闭|交易关闭|退款/.test(status)) return 'in_transit';
  if (Number(order.statusInfo?.orderState) === 18 || /已完成|已签收|已取消|已关闭|交易关闭|待付款|待支付|未付款|全额退款|退款完成|已退款/.test(status)) return 'skip';
  if (/待发货|等待发货|等待卖家发货|等待出库|正在出库/.test(status)) return 'to_ship';
  if (/待收货|等待收货|已发货|等待揽收|运输中|派送中|派件中|待签收|待取件|待自提/.test(status)) return 'in_transit';
  return 'skip';
}

export function jdParcels(data, platformOrderId, checkedAt, rules) {
  if (!Array.isArray(data.multiPackageTrackInfoList)) throw new CollectorError('UPSTREAM_FORMAT', '京东物流字段已变化，已保留原轨迹');
  return data.multiPackageTrackInfoList.flatMap(item => {
    const group = item?.trackGroupInfo || {};
    const carriage = item?.carriageInfo || group.orderCarriageInfo || {};
    const waybillNo = asText(carriage.carriageId);
    if (!waybillNo) return [];
    if (!Array.isArray(group.orderTrackShowList)) throw new CollectorError('UPSTREAM_FORMAT', '京东物流节点字段已变化，已保留原轨迹');
    const { events, truncated } = normalizeLogisticsEvents(group.orderTrackShowList.map(step => ({
      time: step?.CreationTime, description: [asText(step?.StatusName), asText(step?.Content)].filter(Boolean).join('：'),
    })), timestamp, rules, checkedAt);
    const usable = events.filter(event => logisticsEventTimeIssue(event, checkedAt) !== 'timeConflict');
    const latest = usable[0];
    let pickupCode = pickupCycleReset(latest?.description || '') ? '' : asText(group.checkCode).trim() || codeOf(latest?.description || '');
    const status = jdShipmentStatus(usable, pickupCode ? 'arrived' : 'unknown', rules, checkedAt, !!pickupCode);
    if (!pickupCode && status === 'arrived') {
      for (const event of usable) {
        if (pickupCycleReset(event.description) || eventStatus(event.description, 'unknown', rules) === 'signed') break;
        if (event.time > 0 && event.time <= checkedAt && (pickupCode = codeOf(event.description))) break;
      }
    }
    const doorstep = doorstepEvidence(usable, { platform: 'jd' }, checkedAt);
    const pickup = status === 'signed' ? pickupEvidence([], rules) : pickupEvidence(usable, rules);
    const evidence = doorstep.arrivalAt > pickup.arrivalAt ? doorstep : pickup;
    return [{ platformOrderId, waybillNo, carrier: asText(carriage.carrier), status, pickupCode,
      ...evidence,
      logisticsEvents: events, logisticsTruncated: truncated, logisticsState: events.length ? 'ok' : 'empty',
      logisticsCheckedAt: checkedAt, logisticsDetailCheckedAt: checkedAt, ...(events.length ? { logisticsUpdatedAt: checkedAt } : {}) }];
  });
}

async function collectJd(cookie, { fetchImpl, now, maxPages, knownOrders = [], targetOrder, rules, runLogistics, onProgress, durableLogistics, onCookieRefresh }) {
  const orders = [], shipments = [], orderUpdates = [], logisticsFailures = [], warnings = [];
  const session = { cookie };
  const request = async (functionId, input, detail = false) => {
    // Verified 2026-11-01 with fresh Node requests: PC Cookie is sufficient;
    // no captured h5st, device token, UUID, detail PassKey or browser is required.
    const query = new URLSearchParams({ appid: detail ? 'details-jd-com' : 'order-jd-com', client: 'pc', clientVersion: '1.0.0',
      loginType: '3', t: String(now()), functionId });
    if (detail) query.set('body', JSON.stringify(input));
    const response = await platformRequest(`https://api.m.jd.com/api?${query}`, session.cookie, { fetchImpl, method: 'POST',
      body: detail ? undefined : new URLSearchParams({ body: JSON.stringify(input) }).toString(),
      headers: { Origin: detail ? 'https://details.jd.com' : 'https://order.jd.com',
        Referer: detail ? 'https://details.jd.com/' : 'https://order.jd.com/center/list.action', 'Content-Type': 'application/x-www-form-urlencoded' } });
    const nextCookie = withCookies(session.cookie, response.headers);
    if (nextCookie !== session.cookie) onCookieRefresh?.(nextCookie);
    session.cookie = nextCookie;
    return jdCheck(json(response.text));
  };
  async function detail({ platformOrderId }) {
    const shipments = [], orderUpdates = [], logisticsFailures = [], warnings = [];
    const checkedAt = now();
    try {
      const data = await request('pcdetail_traceMultiPackage', { orderId: platformOrderId }, true);
      const known = knownOrders.find(order => asText(order.platformOrderId) === platformOrderId);
      const returnedParcels = jdParcels(data, platformOrderId, checkedAt, rules).filter(parcel => activeParcel(known, parcel.waybillNo));
      const parcels = returnedParcels.filter(parcel => {
        if (!parcel.logisticsEvents.length && !parcel.pickupCode && known?.shipments?.some(old => asText(old.waybillNo) === parcel.waybillNo)) {
          logisticsFailures.push({ platformOrderId, waybillNo: parcel.waybillNo, state: 'empty', logisticsCheckedAt: checkedAt });
          return false;
        }
        return true;
      });
      // The PC API formats its submit time with a literal HTML line break.
      const submitDate = asText(data.processTimeInfo?.submitDate).replace(/\s*<br\s*\/?>\s*/gi, ' ');
      const orderDate = logisticsTimestamp(submitDate, timestamp);
      const returned = new Set(returnedParcels.map(parcel => parcel.waybillNo));
      const missing = activeKnownParcels(known).filter(parcel => !returned.has(asText(parcel.waybillNo)));
      const terminal = returnedParcels.length && !missing.length && returnedParcels.every(parcel => parcel.status === 'signed');
      const update = { platformOrderId, ...(orderDate ? { orderDate, orderDatePrecision: orderTimePrecision(submitDate), orderDateOrigin: 'detail' } : {}), dateCheckedAt: checkedAt,
        dateState: orderDate ? 'ok' : 'empty', ...(terminal ? { orderStatus: '已签收' } : {}) };
      orderUpdates.push(update);
      shipments.push(...parcels);
      for (const parcel of missing) logisticsFailures.push({ platformOrderId, waybillNo: asText(parcel.waybillNo), state: 'unavailable', logisticsCheckedAt: checkedAt });
      if (!returnedParcels.length && !missing.length) logisticsFailures.push({ platformOrderId, state: 'unavailable', logisticsCheckedAt: checkedAt });
    } catch (error) {
      if (mustStopLogistics(error, durableLogistics)) throw error;
      logisticsFailures.push({ platformOrderId, state: 'error', logisticsCheckedAt: checkedAt });
      orderUpdates.push({ platformOrderId, dateCheckedAt: checkedAt, dateState: 'error', dateError: '京东订单日期补查失败，已保留原日期' });
      warnings.push('部分京东订单详情读取失败，已保留原记录');
    }
    return { shipments, orderUpdates, logisticsFailures, warnings };
  }
  const collectDetails = candidates => runLogistics(candidates, detail, {
    stage: 'jd-detail', concurrency: 1, key: item => item.platformOrderId,
    onResult: async result => {
      shipments.push(...result.shipments); logisticsFailures.push(...result.logisticsFailures); warnings.push(...result.warnings);
      for (const update of result.orderUpdates) {
        const listed = orders.find(order => order.platformOrderId === update.platformOrderId);
        if (listed) Object.assign(listed, update); else orderUpdates.push(update);
      }
      await onProgress?.({ orders: [], ...result });
    },
  });
  if (targetOrder) {
    await collectDetails([{ platformOrderId: asText(targetOrder.platformOrderId) }]);
    return { orders, shipments, orderUpdates, logisticsFailures, warnings, refreshedCookie: session.cookie };
  }
  const seen = new Set(), candidates = new Set();
  let skipped = 0;
  for (let page = 1; page <= maxPages; page++) {
    const data = await request('pcorder_center_list', { page, d: 1, s: 4096 });
    if (data.success !== true || !Array.isArray(data.data?.orderList)) throw new CollectorError('UPSTREAM_FORMAT', '京东订单字段已变化，已保留原记录');
    const list = data.data.orderList;
    if (!list.length) break;
    let added = 0;
    for (const order of list) {
      const platformOrderId = asText(order.orderId);
      if (!platformOrderId || seen.has(platformOrderId)) continue;
      seen.add(platformOrderId); added++;
      const kind = jdOrderKind(order);
      const known = knownOrders.find(item => asText(item.platformOrderId) === platformOrderId);
      if (known && !isActiveKnownOrder(known) || kind === 'skip' && !known) { if (kind === 'skip') skipped++; continue; }
      const rawAmount = order.itemPayInfo?.shouldPay;
      const metadata = { platformOrderId,
        amount: rawAmount != null && /^\d+(?:\.\d+)?$/.test(String(rawAmount)) ? Number(rawAmount) : null,
        orderDate: timestamp(order.dateSubmit), orderDatePrecision: orderTimePrecision(order.dateSubmit), orderDateOrigin: 'list', tradeStatus: asText(order.statusInfo?.orderState),
        orderStatus: asText(order.statusInfo?.orderStateName) };
      if (kind === 'skip') { skipped++; orderUpdates.push(metadata); }
      else orders.push({ ...metadata, title: (order.wareList || []).map(ware => asText(ware.name)).filter(Boolean).join(' / '),
        imageUrl: productImage(order.wareList, ['imgPath', 'imageUrl', 'imgUrl']) });
      // JD can assign a waybill and publish warehouse events before the order leaves the warehouse.
      if (kind !== 'skip' || isActiveKnownOrder(known)) candidates.add(platformOrderId);
    }
    if (!added) { warnings.push('京东分页重复，已停止采集；缺席订单不会删除或标记已取'); break; }
    if (Number.isInteger(data.data.totalNum) && seen.size >= data.data.totalNum) break;
    if (page === maxPages) warnings.push('已达到京东分页上限；缺席订单不会删除或标记已取');
  }
  for (const order of activeKnownOrders(knownOrders, new Set(candidates), knownOrders.length)) candidates.add(asText(order.platformOrderId));
  const lastChecked = id => {
    const known = knownOrders.find(order => asText(order.platformOrderId) === id);
    const parcels = activeKnownParcels(known);
    return parcels.length ? Math.min(...parcels.map(parcel => parcel.logisticsCheckedAt || 0)) : known?.dateCheckedAt || 0;
  };
  await onProgress?.({ orders, shipments: [], orderUpdates, logisticsFailures: [], warnings: [...new Set(warnings)] });
  await collectDetails([...candidates].sort((a, b) => lastChecked(a) - lastChecked(b)).map(platformOrderId => ({ platformOrderId })));
  if (skipped) warnings.push(`京东订单筛选：保留${orders.length}笔待发货/待收货订单，跳过${skipped}笔已结束或非快递订单`);
  return { orders, shipments, orderUpdates, logisticsFailures, warnings: [...new Set(warnings)], refreshedCookie: session.cookie };
}

export function createCollector({ fetchImpl = fetch, now = Date.now, maxPages = 5, getLogisticsRules } = {}) {
  return async (account, cookie, { trackedOrderIds = [], knownOrders = [], targetOrder, runLogistics = parallelLogistics, onProgress, durableLogistics = false, onCookieRefresh } = {}) => {
    if (targetOrder && !isActiveKnownOrder(targetOrder)) return { orders: [], orderUpdates: [], shipments: [], logisticsFailures: [], warnings: [] };
    const rules = getLogisticsRules ? JSON.parse(JSON.stringify(getLogisticsRules())) : undefined;
    const options = { fetchImpl, now, maxPages, trackedOrderIds, knownOrders: targetOrder ? [targetOrder] : knownOrders, targetOrder, rules, runLogistics, durableLogistics, onCookieRefresh,
      onProgress: onProgress ? result => onProgress({ ...structuredClone(result), ...(rules ? { logisticsRules: rules } : {}) }) : undefined };
    const collect = { taobao: collectTaobao, pdd: collectPdd, jd: collectJd }[account.platform];
    if (!collect) throw new CollectorError('INVALID_PLATFORM', '不支持的授权平台');
    const result = await collect(cookie, options);
    // Keep the parser snapshot with this import, even if an administrator edits rules mid-request.
    if (rules) result.logisticsRules = rules;
    return result;
  };
}
