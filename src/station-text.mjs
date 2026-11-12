import { fail } from './security.mjs';
import { stationSubLocation } from '../public/station-location.js';

// Keep this recognition boundary aligned with core locationNumbers/matchStationKey.
export function stationKey(value) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const key = String(value || '').normalize('NFKC').replace(/[－—–]/gu, '-').replace(/[零〇一二两三四五六七八九十]+(?=卡|号(?:柜|快递柜|自提柜|楼|门)|栋|幢)/gu, number => {
    if (number.includes('十')) { const [tens, units] = number.split('十'); return String((tens ? digits[tens] : 1) * 10 + (units ? digits[units] : 0)); }
    return [...number].map(character => digits[character]).join('');
  }).replace(/[\s，,。()（）【】\[\]·:：。；;]/gu, '');
  return key.length >= 2 && !/^(?:未知地址|手动添加|快递站|站点|地址|门口|菜鸟驿站|兔喜生活|菜鸟|丰巢|驿站|快递柜|自提柜|代收点)$/u.test(key) ? key : '';
}
const forbidden = /[<>`\u0000-\u001f\u007f]|(?:https?|javascript|data):|www\.|\$\(|\b(?:curl|wget|powershell|cmd\.exe)\b/i;
export function stationText(value, name, max = 120, required = true) {
  if (typeof value !== 'string' || value.length > max || forbidden.test(value) || (required && !value.trim())) fail(400, 'INVALID_STATION', `${name}格式不正确`);
  return value.normalize('NFKC').trim();
}

// Only these short station fragments cross the AI boundary; raw SMS never belongs in this queue.
export function redactStationFragment(value) {
  if (typeof value !== 'string' || value.length > 600) fail(400, 'INVALID_FRAGMENT', '站点片段须在600字以内');
  return value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/(?:https?:\/\/|www\.)[^\s，。；;<>]+/giu, '[链接已移除]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[邮箱已移除]')
    .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}|(?:0\d{2,3}[- ]?)\d{7,8}(?:[-转]\d{1,6})?/gu, '[电话已移除]')
    .replace(/(?:取件码|提货码|取货码|验证码|开柜码|密码)\s*(?:为|是)?\s*[:：]?\s*[A-Z0-9]+(?:[-—_ ]+[A-Z0-9]+)*/giu, '[取件码已移除]')
    .replace(/(?:运单号?|快递单号|物流单号|订单号)\s*[:：]?\s*[A-Z0-9][A-Z0-9-]{3,}/giu, '[单号已移除]')
    .replace(/\b[A-Z0-9]*\d[A-Z0-9-]{7,}\b/giu, '[编号已移除]')
    .replace(/\b\d+(?:[-—_]\d+){1,}\b/gu, '[取件码已移除]')
    .replace(/\d{4,}/gu, '[编号已移除]').replace(/\s+/gu, ' ').trim();
}

export const nonPickupPlace = value => /中转|分拣|分拨|转运|集散|处理中心|航空部|发货仓|发件仓|揽收仓|仓储中心|配送中心|家门外|送货上门|住宅|\d+栋\d+室/u.test(value)
  || /家门口/u.test(value) && !/驿站|快递柜|自提柜|代收点/u.test(value);

export function validateStationSuggestion(candidate, value, stations) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['kind', 'targetStationId', 'suggestedName', 'alias', 'subLocation', 'evidence'].includes(k))) fail(400, 'AI_INVALID_RESULT', 'AI结果字段无效');
  if (!['pickup_station', 'locker', 'home', 'hub', 'unknown'].includes(value.kind)) fail(400, 'AI_INVALID_RESULT', 'AI结果类型无效');
  const read = (key, max) => {
    try { return stationText(value[key] ?? '', key, max, false); }
    catch { fail(400, 'AI_INVALID_RESULT', 'AI结果包含不支持的文字'); }
  };
  const targetStationId = read('targetStationId', 128), suggestedName = read('suggestedName', 120), alias = read('alias', 120), subLocation = read('subLocation', 60);
  const evidence = typeof value.evidence === 'string' ? [value.evidence] : value.evidence;
  if (!Array.isArray(evidence) || evidence.length > 5 || evidence.some(e => typeof e !== 'string' || !e || e.length > 200 || !candidate.fragment.includes(e) || redactStationFragment(e) !== e)) fail(400, 'AI_INVALID_RESULT', 'AI证据必须引用脱敏原文');
  if (targetStationId && !stations.some(s => s.id === targetStationId && s.enabled)) fail(400, 'AI_INVALID_RESULT', 'AI目标站点不存在或已停用');
  if (targetStationId && suggestedName) fail(400, 'AI_INVALID_RESULT', 'AI结果只能指定一个目标');
  for (const text of [alias, subLocation]) if (text && (!candidate.fragment.includes(text) || redactStationFragment(text) !== text)) fail(400, 'AI_INVALID_RESULT', 'AI别名与柜号必须来自脱敏原文');
  if (suggestedName && (!candidate.fragment.includes(suggestedName) || nonPickupPlace(suggestedName) || redactStationFragment(suggestedName) !== suggestedName)) fail(400, 'AI_INVALID_RESULT', 'AI新站点名称必须来自脱敏原文');
  if (['pickup_station', 'locker'].includes(value.kind) && (!alias || !evidence.length || (!targetStationId && !suggestedName)
    || [candidate.fragment, candidate.stationName, alias, subLocation].some(nonPickupPlace))) fail(400, 'AI_INVALID_RESULT', 'AI结果缺少可核对的末端取件站点信息');
  const detail = stationSubLocation(subLocation);
  if (detail && !candidate.fragment.includes(detail)) fail(400, 'AI_INVALID_RESULT', 'AI子位置必须是原文中的连续片段');
  return { kind: value.kind, targetStationId, suggestedName, alias, subLocation: detail, evidence };
}
