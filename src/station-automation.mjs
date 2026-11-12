import { stationKey } from './station-text.mjs';
import { stationSubLocation } from '../public/station-location.js';

const placeParts = value => {
  const parts = new Map();
  for (const match of stationKey(value).matchAll(/(\d+)(卡|号(?:快递柜|自提柜|柜|楼|门)|栋|幢)/gu)) {
    const kind = match[2].replace(/号(?:快递柜|自提柜)/u, '号柜');
    if (!parts.has(kind)) parts.set(kind, new Set());
    parts.get(kind).add(match[1]);
  }
  for (const match of stationKey(value).matchAll(/([东南西北正侧后]{1,2})门/gu)) {
    if (!parts.has('方位门')) parts.set('方位门', new Set());
    parts.get('方位门').add(match[1]);
  }
  return parts;
};
const distinctive = value => {
  const key = stationKey(value);
  return key.length >= 6 && key.replace(/菜鸟|兔喜|丰巢|快递|生活|驿站|自提|服务|代收|号柜|站|店|柜|点|\d/gu, '').length >= 4;
};

export const stationLocationConflict = (...values) => [...placeParts(values.join('，')).values()].some(parts => parts.size > 1);

// AI selects a target; this independent check only accepts a unique literal identity.
// Similar names, new stations and guesses remain reviewable suggestions.
export function stationAutomationDecision(candidate, stations) {
  const suggestion = candidate.suggestion;
  if (!suggestion || !['pickup_station', 'locker'].includes(suggestion.kind) || !suggestion.targetStationId || suggestion.suggestedName)
    return { reason: '需要核对新站点或不确定结果' };
  const target = stations.find(station => station.enabled && station.id === suggestion.targetStationId);
  if (!target) return { reason: '目标站点已停用或不存在' };
  const aliasKey = stationKey(suggestion.alias), fragmentKey = stationKey(candidate.fragment);
  if (candidate.feedback && (!candidate.feedback.active || !candidate.feedback.verified || candidate.feedback.targetStationId !== target.id))
    return { reason: '人工样本已撤回、证据不足或目标不一致，请核对' };
  const matches = stations.filter(station => station.enabled && [station.name, ...station.aliases.map(alias => alias.name)]
    .some(name => distinctive(name) && aliasKey.includes(stationKey(name)) && fragmentKey.includes(stationKey(name))));
  if (!candidate.feedback && (matches.length !== 1 || matches[0].id !== target.id)) return { reason: '缺少唯一且逐字对应的已知站点名称' };
  if (candidate.feedback) {
    const sourceKey = stationKey(candidate.feedback.sourceStationName);
    if (!sourceKey || !aliasKey.includes(sourceKey)) return { reason: '人工样本的原站名未完整保留' };
    const owners = stations.filter(station => station.enabled && [station.name, ...station.aliases.map(alias => alias.name)].some(name => stationKey(name) === aliasKey));
    if (owners.some(station => station.id !== target.id)) return { reason: '原站名已属于其他启用站点' };
    const confirmedParts = placeParts([candidate.feedback.sourceStationName, candidate.feedback.subLocation, candidate.feedback.otherStationName, target.name].join('，'));
    if ([...confirmedParts.values()].some(values => values.size > 1)) return { reason: '人工确认两端的位置编号冲突，请核对' };
  }
  const parts = placeParts(suggestion.alias), required = placeParts(candidate.stationName), extra = placeParts(suggestion.subLocation), fragmentParts = placeParts(candidate.fragment);
  if ([...parts.values(), ...required.values(), ...extra.values(), ...fragmentParts.values()].some(values => values.size > 1)) return { reason: '片段包含冲突的位置编号' };
  for (const [kind, values] of [...required, ...extra]) {
    if (!parts.has(kind) || [...values].some(number => !parts.get(kind).has(number))) return { reason: '别名未完整保留位置编号' };
  }
  if (candidate.feedback?.subLocation && stationKey(stationSubLocation(candidate.feedback.subLocation)) !== stationKey(stationSubLocation(suggestion.subLocation))) return { reason: '人工样本的柜号未完整保留' };
  const existing = target.aliases.find(alias => stationKey(alias.name) === aliasKey);
  if (existing && (stationLocationConflict(target.name, existing.name, existing.subLocation, suggestion.subLocation)
    || stationSubLocation(existing.subLocation || '') !== stationSubLocation(suggestion.subLocation || ''))) return { reason: '已有别名的位置说明不同' };
  return { target, existing, alreadyKnown: aliasKey === stationKey(target.name) || !!existing, reason: '' };
}
