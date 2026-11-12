import { stationSubLocation } from './station-location.js';

const get = id => document.getElementById(id);

const text = value => value === null || value === undefined ? '' : String(value);
const first = (...values) => values.find(value => value !== undefined && value !== null && text(value).trim() !== '') || '';

function aliasOf(value) {
  if (typeof value === 'string') return { id: '', name: value, source: '手动', subLocation: '' };
  return {
    id: first(value?.id),
    name: first(value?.name, value?.alias, value?.text),
    source: first(value?.sourceLabel, value?.source, '手动'),
    subLocation: first(value?.subLocation, value?.sub, value?.location),
  };
}

function stationOf(value) {
  const rawRegion = value?.region;
  const region = rawRegion && typeof rawRegion === 'object'
    ? [rawRegion.province, rawRegion.city, rawRegion.district, rawRegion.name].filter(Boolean).join(' · ')
    : first(rawRegion, value?.regionName);
  return {
    id: first(value?.id, value?.stationId),
    name: first(value?.name, value?.canonicalName, value?.canonical),
    region,
    enabled: value?.enabled !== false,
    aliases: (Array.isArray(value?.aliases) ? value.aliases : []).map(aliasOf).filter(alias => alias.name),
    raw: value,
  };
}

export function candidateOf(value) {
  const suggested = value?.suggestedStation || value?.targetStation || {};
  const suggestion = value?.suggestion || {};
  const source = value?.source || {};
  const rawText = first(value?.rawText, value?.fragment, value?.snippet, value?.rawSnippet, value?.sms, value?.sourceText, value?.feedback?.sourceStationName);
  const sms = first(value?.sms, value?.smsName, value?.messageSnippet, source.sms);
  return {
    id: first(value?.id, value?.candidateId),
    status: first(value?.status, value?.state, 'pending_review'),
    title: first(value?.title, value?.suggestedName, suggestion?.suggestedName, value?.name, value?.stationName, value?.rawSnippet, value?.snippet, '待核对站点片段'),
    rawText,
    sourceMissing: Boolean(value?.feedback) && !first(rawText, sms),
    sms,
    logistics: first(value?.logistics, value?.logisticsName, value?.platformStation, source.logistics, value?.feedback?.otherStationName),
    region: first(value?.sourceRegion, value?.region, value?.regionName, source.region),
    suggestedStationId: first(value?.stationId, value?.suggestedStationId, suggestion?.targetStationId, suggested.id, value?.feedback?.targetStationId),
    suggestedName: first(value?.suggestedStationName, value?.target, value?.targetName, suggestion?.suggestedName, suggested.name),
    alias: first(value?.alias, suggestion?.alias),
    subLocation: stationSubLocation(first(value?.subLocation, value?.sub, value?.locker, value?.lockerNo, suggestion?.subLocation, value?.feedback?.subLocation)),
    evidence: Array.isArray(value?.evidence) ? value.evidence.join('；') : Array.isArray(suggestion?.evidence) ? suggestion.evidence.join('；') : first(value?.evidence, suggestion?.evidence, value?.reason, value?.basis, '请核对原文与地区信息。'),
    occurrenceCount: Number(first(value?.occurrenceCount, value?.occurrences, value?.count, value?.times, 1)) || 1,
    raw: value,
  };
}

export function candidateSourceLabel(candidate) {
  const sourceText = candidate?.rawText || candidate?.sms;
  return sourceText || (candidate?.sourceMissing ? '未提交（无可学习的原站名）' : '未提供');
}

function cloneStation(station) {
  return { id: station.id, name: station.name, region: station.region, enabled: station.enabled, aliases: station.aliases.map(alias => ({ ...alias })) };
}

function sourceLabel(source) {
  const value = text(source).toLowerCase();
  if (value === 'platform') return '物流';
  if (value === 'sms') return '短信';
  if (value === 'manual') return '手动';
  if (value === 'ai') return 'AI辅助';
  if (value.includes('logistic') || value.includes('平台') || value.includes('物流')) return '物流';
  if (value.includes('sms') || value.includes('短信')) return '短信';
  if (value.includes('ai')) return 'AI辅助';
  return source || '手动';
}

export function compareStationNames(a, b, stations) {
  const key = value => text(value).normalize('NFKC').replace(/[零〇一二两三四五六七八九十]+(?=卡|号(?:柜|快递柜|自提柜|楼|门)|栋|幢)/gu, raw => {
    const digits = { 零:0, 〇:0, 一:1, 二:2, 两:2, 三:3, 四:4, 五:5, 六:6, 七:7, 八:8, 九:9 };
    const parts = raw.split('十'); return parts.length === 2 ? String((parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0)) : [...raw].map(c => digits[c]).join('');
  }).replace(/[\s\p{P}]+/gu, '').toLowerCase();
  const location = value => { const s = key(value); return [/(\d+)号?(?:快递柜|自提柜|柜)/u.exec(s)?.[1], /(东|西|南|北)(?:大)?门/u.exec(s)?.[1], /(\d+)卡/u.exec(s)?.[1], /(\d+)(?:栋|幢|号楼)/u.exec(s)?.[1]]; };
  const x = location(a), y = location(b);
  if (x.some((part, i) => part && y[i] && part !== y[i])) return { same: false, conflict: true };
  const lookup = value => stations.filter(s => s.enabled && [s.name, ...s.aliases.map(alias => alias.name)].some(name => key(name) === key(value)));
  const first = lookup(a), second = lookup(b);
  if (first.length > 1 || second.length > 1) return { same: false, conflict: false };
  return { same: !!key(a) && (key(a) === key(b) || first.length === 1 && second.length === 1 && first[0].id === second[0].id), conflict: first.length === 1 && second.length === 1 && first[0].id !== second[0].id };
}

export function createAnalysisDetails(analysis, { running = false } = {}) {
  const details = document.createElement('details'); details.className = 'analysis-details';
  const summary = document.createElement('summary'); summary.textContent = '分析详情'; details.append(summary);
  const note = value => { const row = document.createElement('p'); row.textContent = value; details.append(row); };
  if (!analysis || typeof analysis !== 'object') { note('尚未分析（尚无实际 AI 输入或返回）。'); return details; }
  const time = value => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString('zh-CN') : '';
  const startedAt = time(analysis.startedAt), finishedAt = time(analysis.finishedAt);
  if (startedAt) note(`最近调用：${startedAt}${finishedAt ? ` · 结束：${finishedAt}` : ''}`);
  if (!finishedAt) note(running ? '尚未完成（后台任务仍在运行）。' : '未完成（任务已停止或中断）。');
  const json = (label, value) => {
    const heading = document.createElement('p'); heading.className = 'analysis-label'; heading.textContent = label;
    const pre = document.createElement('pre'); pre.textContent = JSON.stringify(value, null, 2); details.append(heading, pre);
  };
  if (analysis.input && typeof analysis.input === 'object') {
    const input = {};
    for (const key of ['fragment', 'region', 'confirmedMapping', 'knownStations', 'knownStationsTruncated']) if (Object.prototype.hasOwnProperty.call(analysis.input, key)) input[key] = analysis.input[key];
    json('实际脱敏输入', input);
  } else note('没有已记录的实际脱敏输入。');
  if (analysis.result !== null && analysis.result !== undefined) json('校验后的返回结构', analysis.result);
  else note('尚无通过校验的返回结构。');
  if (analysis.error && typeof analysis.error === 'object') {
    const error = document.createElement('p'); error.className = 'analysis-error'; error.textContent = `安全错误：${text(analysis.error.message)}${analysis.error.code ? `（${text(analysis.error.code)}）` : ''}`; details.append(error);
  }
  return details;
}

export function initStationAdmin({ api, notice }) {
  if (!get('station-settings-view')) return;

  const state = {
    loaded: false,
    open: false,
    stations: [],
    candidates: [],
    selectedId: '',
    draft: null,
    newStation: false,
    dirty: false,
    query: '',
    queueOpen: false,
    aiConfig: null,
    aiDirty: false,
    aiSaving: false,
    aiVersion: 0,
    channels: [],
    channelId: null,
    channelDirty: false,
    channelSaving: false,
    channelTesting: false,
    channelVersion: 0,
    session: 0,
    aiRunning: false,
    aiPollTimer: null,
    aiPolling: false,
    tuningSupported: false,
    tuningVersion: 0,
    optimizationBusy: false,
    reviewCandidate: null,
    analysisOpen: new Set(),
    feedbackItems: [],
    feedbackCursor: '',
    feedbackLoading: false,
  };

  const setHidden = (id, hidden) => { get(id).hidden = hidden; };
  const setText = (id, value) => { get(id).textContent = text(value); };
  const button = (label, handler, className = 'secondary') => {
    const element = document.createElement('button');
    element.type = 'button'; element.className = className; element.textContent = label;
    element.addEventListener('click', async () => { if (element.disabled) return; element.disabled = true; try { await handler(); } catch (error) { notice(error.message || '操作未完成，请重试。', true); } finally { element.disabled = false; } }); return element;
  };

  function normalized(value) { return text(value).trim().toLowerCase().replace(/[\s\p{P}]+/gu, ''); }
  function currentStation() { return state.stations.find(station => station.id === state.selectedId); }
  function selectedOrDraft() { return state.draft || currentStation(); }

  function renderDirectory() {
    const list = get('station-list');
    const query = state.query.toLowerCase();
    const visible = state.stations.filter(station => !query || [station.name, station.region, ...station.aliases.map(alias => alias.name)].some(value => text(value).toLowerCase().includes(query)));
    setText('station-total', `${state.stations.length} 个`);
    list.replaceChildren();
    if (!visible.length) {
      const empty = document.createElement('p'); empty.className = 'station-list-empty'; empty.textContent = state.stations.length ? '没有匹配的站点' : '尚无站点'; list.append(empty);
    }
    for (const station of visible) {
      const item = document.createElement('button'); item.type = 'button'; item.className = `station-item ${station.id === state.selectedId && !state.queueOpen ? 'active' : ''}`;
      item.setAttribute('aria-current', station.id === state.selectedId && !state.queueOpen ? 'true' : 'false');
      const nameRow = document.createElement('span'); nameRow.className = 'station-name-row';
      const name = document.createElement('strong'); name.textContent = station.name || '未命名站点'; nameRow.append(name, document.createTextNode('›'));
      const meta = document.createElement('span'); meta.className = 'station-meta'; meta.textContent = `${station.region || '未填写地区'} · ${station.aliases.length} 个名称`;
      const status = document.createElement('span'); status.className = `station-status ${station.enabled ? '' : 'paused'}`; status.textContent = station.enabled ? '启用中' : '已暂停';
      item.append(nameRow, meta, status); item.addEventListener('click', () => selectStation(station.id)); list.append(item);
    }
    setText('station-queue-count', state.candidates.length);
    setText('candidate-count', `${state.candidates.length} 条候选与人工样本`);
  }

  function renderAliases() {
    const list = get('alias-list'); list.replaceChildren();
    const draft = selectedOrDraft();
    const aliases = draft?.aliases || [];
    setText('alias-count', `${aliases.length} 个名称`);
    if (!aliases.length) {
      const empty = document.createElement('p'); empty.className = 'no-alias'; empty.textContent = '暂无别名，添加物流或短信中的站点名称'; list.append(empty); return;
    }
    aliases.forEach((alias, index) => {
      const row = document.createElement('div'); row.className = 'alias-row';
      const source = document.createElement('select'); source.setAttribute('aria-label', `别名 ${index + 1} 来源`);
      for (const optionValue of ['物流', '短信', '手动', 'AI辅助']) { const option = document.createElement('option'); option.value = optionValue; option.textContent = optionValue; source.append(option); }
      source.value = sourceLabel(alias.source);
      const name = document.createElement('input'); name.value = alias.name; name.maxLength = 200; name.setAttribute('aria-label', `别名 ${index + 1} 原始名称`);
      const location = document.createElement('input'); location.value = alias.subLocation; location.maxLength = 120; location.placeholder = '例如：2号柜'; location.setAttribute('aria-label', `别名 ${index + 1} 子位置`);
      const actions = document.createElement('span'); actions.className = 'alias-actions';
      const remove = button('删除', () => {
        if (!confirm('移除这个别名？已确认的历史关联不会被拆开。')) return;
        aliases.splice(index, 1); state.dirty = true; renderAliases(); renderDirectory();
      }, 'textbtn danger-text');
      actions.append(remove); row.append(source, name, location, actions); list.append(row);
      const update = () => { alias.source = source.value; alias.name = name.value; alias.subLocation = location.value; state.dirty = true; renderDirectory(); };
      source.addEventListener('change', update); name.addEventListener('input', update); location.addEventListener('input', update);
    });
  }

  function renderDetail() {
    const draft = selectedOrDraft();
    const hasStation = Boolean(draft);
    setHidden('station-detail-body', !hasStation || state.queueOpen);
    setHidden('station-empty', hasStation || state.queueOpen);
    setHidden('station-queue-view', !state.queueOpen);
    if (!hasStation || state.queueOpen) return;
    setText('station-detail-name', draft.name || '新增站点'); setText('station-detail-subtitle', draft.region || '填写地区，避免同名门店混淆');
    get('station-id').value = draft.id || ''; get('station-name').value = draft.name; get('station-region').value = draft.region;
    const toggle = get('station-enabled'); toggle.setAttribute('aria-checked', String(draft.enabled)); toggle.classList.toggle('off', !draft.enabled);
    setText('station-enabled-label', draft.enabled ? '启用站点' : '已暂停站点'); renderAliases();
  }

  function selectStation(id) {
    if (state.dirty && !confirm('当前站点有未保存更改，切换后将丢失。继续？')) return;
    state.selectedId = id; state.draft = cloneStation(state.stations.find(station => station.id === id)); state.newStation = false; state.dirty = false; state.queueOpen = false; renderDirectory(); renderDetail();
  }

  function newStation() {
    if (state.dirty && !confirm('当前站点有未保存更改，新增后将丢失。继续？')) return;
    state.selectedId = ''; state.draft = { id: '', name: '', region: '', enabled: true, aliases: [] }; state.newStation = true; state.dirty = false; state.queueOpen = false; renderDirectory(); renderDetail(); get('station-name').focus();
  }

  function showQueue() { state.queueOpen = true; setText('station-detail-name', 'AI 待核对'); setText('station-detail-subtitle', '自动分析，确认后加入站点别名'); renderDirectory(); renderDetail(); renderCandidates(); renderFeedback(); }
  function showStation() { state.queueOpen = false; if (!state.draft && state.stations[0]) selectStation(state.stations[0].id); else { renderDirectory(); renderDetail(); } }

  function renderCandidate(candidate) {
    const article = document.createElement('article'); article.className = `candidate ${candidate.suggestedStationId ? '' : 'muted'}`;
    const head = document.createElement('div'); head.className = 'candidate-head';
    const title = document.createElement('div'); title.className = 'candidate-title';
    const heading = document.createElement('h3'); heading.textContent = candidate.title;
    const sourceLine = document.createElement('p');
    sourceLine.textContent = `${candidate.raw.feedback ? candidate.raw.feedback.kind === 'manual_match' ? '人工匹配样本 · ' : '站点修正样本 · ' : ''}原文：${candidateSourceLabel(candidate)}${candidate.region ? ` · 地区：${candidate.region}` : ''}`;
    title.append(heading, sourceLine);
    const status = document.createElement('span'); status.className = `candidate-status ${candidate.suggestedStationId ? '' : 'neutral'}`; status.textContent = ({ pending: '待分析', unknown: '待核对', approved: '已应用', withdrawn: '已撤回', ignored: candidate.raw.application?.rolledBackAt ? '已回滚' : '已忽略', failed: '分析失败' })[candidate.status] || (candidate.suggestedStationId ? '建议归入已有站点' : '需选择站点'); head.append(title, status); article.append(head);
    const path = document.createElement('div'); path.className = 'candidate-path';
    const logistics = document.createElement('span'); logistics.textContent = `物流已知：${candidate.logistics || '未提供'}`;
    const targetName = candidate.suggestedName || state.stations.find(station => station.id === candidate.suggestedStationId)?.name;
    const target = document.createElement('span'); target.textContent = targetName ? `建议站点：${targetName}` : '请选择标准站点';
    path.append(logistics, document.createTextNode(' → '), target);
    if (candidate.subLocation) { const sub = document.createElement('span'); sub.textContent = `子位置：${candidate.subLocation}`; path.append(document.createTextNode(' · '), sub); }
    article.append(path);
    const evidence = document.createElement('p'); evidence.className = 'evidence'; evidence.textContent = `证据：${candidate.evidence} · 出现 ${candidate.occurrenceCount} 次`; article.append(evidence);
    if (candidate.raw.error) { const error = document.createElement('p'); error.className = 'warning-note'; error.textContent = candidate.raw.error + (candidate.raw.retryAt ? ' · 下次重试：' + new Date(candidate.raw.retryAt).toLocaleString('zh-CN') : ''); article.append(error); }
    if (candidate.raw.automationReason) { const reason = document.createElement('p'); reason.className = 'warning-note'; reason.textContent = candidate.raw.automationReason; article.append(reason); }
    const analysis = createAnalysisDetails(candidate.raw.analysis, { running: state.aiRunning }); analysis.open = state.analysisOpen.has(candidate.id);
    analysis.addEventListener('toggle', () => { if (analysis.open) state.analysisOpen.add(candidate.id); else state.analysisOpen.delete(candidate.id); }); article.append(analysis);
    const actions = document.createElement('div'); actions.className = 'candidate-actions';
    if (!['approved', 'withdrawn', 'ignored'].includes(candidate.status)) actions.append(button('忽略', () => ignoreCandidate(candidate), 'textbtn'), button(candidate.suggestedStationId ? '核对并加入' : '核对并选择', () => openReview(candidate), 'primary')); article.append(actions);
    if (!candidate.suggestedStationId) { const warning = document.createElement('p'); warning.className = 'warning-note'; warning.textContent = '无法唯一确定时必须选择站点；住宅地址和物流中转站不会加入规则。'; article.append(warning); }
    return article;
  }

  function renderCandidates() {
    const list = get('candidate-list'); list.replaceChildren();
    if (!state.candidates.length) { const empty = document.createElement('p'); empty.className = 'candidate-empty'; empty.textContent = '当前没有待核对候选'; list.append(empty); return; }
    state.candidates.forEach(candidate => list.append(renderCandidate(candidate)));
  }

  function feedbackStatus(value) {
    return ({ pending: '待分析', applied: '规则已应用', review: '待核对', failed: '分析失败', withdrawn: '已撤回', rejected: '已拒收' })[value.status] || value.status || '未知';
  }

  function renderFeedbackItem(value) {
    const article = document.createElement('article'); article.className = `candidate ${value.status === 'withdrawn' ? 'muted' : ''}`;
    const head = document.createElement('div'); head.className = 'candidate-head';
    const title = document.createElement('div'); title.className = 'candidate-title';
    const heading = document.createElement('h3'); heading.textContent = value.receipt?.kind === 'manual_match' ? '人工匹配反馈' : '站点修正反馈';
    const receiptLine = document.createElement('p'); receiptLine.textContent = `${value.device?.name || '未命名设备'} · 收据 ${value.id || value.receipt?.id || '未提供'} · 版本 ${value.revision || value.receipt?.revision || 0}`;
    title.append(heading, receiptLine);
    const status = document.createElement('span'); status.className = `candidate-status ${value.status === 'applied' ? '' : 'neutral'}`; status.textContent = feedbackStatus(value); head.append(title, status); article.append(head);
    const path = document.createElement('div'); path.className = 'candidate-path';
    for (const label of [`原因：${value.message || value.error || '未提供'}`, `入口：${value.receipt?.reason || value.receipt?.kind || '未提供'}`, `收据版本：${value.revision || value.receipt?.revision || 0}`]) { const item = document.createElement('span'); item.textContent = label; path.append(item); }
    article.append(path);
    const evidence = document.createElement('p'); evidence.className = 'evidence'; evidence.textContent = `状态码：${value.reasonCode || '未分类'} · 更新时间：${value.updatedAt ? new Date(value.updatedAt).toLocaleString('zh-CN') : '尚无'}`; article.append(evidence);
    const chain = document.createElement('details'); chain.className = 'analysis-details'; const summary = document.createElement('summary'); summary.textContent = '查看收据关联链路'; chain.append(summary);
    const note = text => { const row = document.createElement('p'); row.textContent = text; chain.append(row); };
    note(`候选：${value.candidateId || '无候选（收据仍保留）'}${value.candidate?.status ? ` · ${value.candidate.status}` : ''}`);
    if (value.candidate?.fragment) note(`候选片段：${value.candidate.fragment}`);
    const deviceReceipt = value.deviceRuleReceipt;
    note(`设备规则确认：${deviceReceipt?.received ? `已确认站点规则 ${deviceReceipt.stationRulesVersion}、物流规则 ${deviceReceipt.serverLogisticsRulesVersion}` : '未确认（设备尚未上报规则回执）'} · 效果：未验证`);
    if (value.analysisAttempts?.length) {
      note(`分析历史：${value.analysisAttempts.length} 次（失败与成功均保留）`);
      for (const attempt of value.analysisAttempts) note(`分析 ${attempt.startedAt ? new Date(attempt.startedAt).toLocaleString('zh-CN') : '未开始'}：${attempt.error?.message || attempt.error?.code || (attempt.result ? '已返回并通过校验' : '未完成')} · 效果：未验证`);
    }
    if (value.analysis) chain.append(createAnalysisDetails(value.analysis)); else note('分析：尚无分析记录。');
    if (value.rule) note(`规则：${value.rule.stationName || value.rule.stationId || '未提供'} · 版本 ${value.rule.revision || 0} · ${value.rule.status === 'rolled_back' ? '已回滚' : '当前记录'}`);
    else note('规则：没有可追踪的规则变更；“规则已应用”之外的状态不代表识别效果已验证。');
    article.append(chain); return article;
  }

  function renderFeedback() {
    const list = get('matching-feedback-list'); if (!list) return; list.replaceChildren();
    if (!state.feedbackItems.length) { const empty = document.createElement('p'); empty.className = 'candidate-empty'; empty.textContent = '尚无后台反馈收据。'; list.append(empty); }
    else state.feedbackItems.forEach(value => list.append(renderFeedbackItem(value)));
    setText('matching-feedback-count', state.feedbackItems.length ? `${state.feedbackItems.length} 条已读取` : '尚无记录');
    const more = get('matching-feedback-more'); if (more) more.hidden = !state.feedbackCursor || state.feedbackLoading;
  }

  async function loadFeedback(reset = true) {
    if (state.feedbackLoading || !get('matching-feedback-list')) return;
    const session = state.session; state.feedbackLoading = true; const before = reset ? '' : state.feedbackCursor;
    try {
      const query = new URLSearchParams({ limit: '50' }); if (before) query.set('before', before);
      const value = id => get(id)?.value?.trim() || '';
      for (const [id, key] of [['matching-feedback-status', 'status'], ['matching-feedback-kind', 'kind'], ['matching-feedback-reason', 'reasonCode'], ['matching-feedback-device', 'device'], ['matching-feedback-station', 'station']]) if (value(id)) query.set(key, value(id));
      const from = value('matching-feedback-from'), to = value('matching-feedback-to');
      if (from) query.set('from', String(Date.parse(`${from}T00:00:00`))); if (to) query.set('to', String(Date.parse(`${to}T23:59:59.999`)));
      const data = await api(`/v1/admin/matching-feedback?${query}`); if (session !== state.session) return;
      state.feedbackItems = reset ? (data.items || []) : [...state.feedbackItems, ...(data.items || [])]; state.feedbackCursor = data.nextCursor || ''; renderFeedback();
    } finally { state.feedbackLoading = false; renderFeedback(); }
  }

  function fillReviewStations(selectedId = '') {
    const select = get('review-station'); select.replaceChildren();
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = '请选择标准站点'; select.append(blank);
    for (const station of state.stations) { const option = document.createElement('option'); option.value = station.id; option.textContent = `${station.name} · ${station.region || '未填写地区'}`; select.append(option); }
    const create = document.createElement('option'); create.value = '__new__'; create.textContent = '新建站点（需填写名称和地区）'; select.append(create); select.value = selectedId || '';
    setHidden('review-new-fields', select.value !== '__new__');
  }

  function openReview(candidate) {
    state.reviewCandidate = candidate; const evidence = get('review-evidence'); evidence.replaceChildren();
    for (const [label, value] of [['原文片段', candidate.rawText || candidate.sms], ['物流已知', candidate.logistics], ['地区', candidate.region], ['判断依据', candidate.evidence]]) {
      const row = document.createElement('p'); const strong = document.createElement('strong'); strong.textContent = `${label}：`; row.append(strong, document.createTextNode(value || '未提供')); evidence.append(row);
    }
    fillReviewStations(candidate.suggestedStationId); get('review-alias').value = candidate.alias || candidate.raw.stationName || candidate.rawText || ''; get('review-new-name').value = candidate.suggestedName || ''; get('review-new-region').value = candidate.region || ''; get('review-sub-location').value = candidate.subLocation || '';
    get('station-review-dialog').showModal();
  }

  async function ignoreCandidate(candidate) {
    await api(`/v1/admin/station-candidates/${encodeURIComponent(candidate.id)}/ignore`, { method: 'POST', body: '{}' });
    await loadCandidates(); notice('候选已忽略。');
  }

  async function loadStations() {
    const data = await api('/v1/admin/stations'); state.stations = (data.stations || []).map(stationOf); state.loaded = true;
    if (!state.selectedId || !state.stations.some(station => station.id === state.selectedId)) state.selectedId = state.stations[0]?.id || '';
    if (!state.draft || (!state.newStation && state.draft.id !== state.selectedId)) state.draft = state.selectedId ? cloneStation(currentStation()) : null;
    renderDirectory(); renderDetail();
  }

  async function loadCandidates() {
    const session = state.session, data = await api('/v1/admin/station-candidates'); if (session !== state.session) return;
    state.candidates = (data.candidates || []).map(candidateOf).filter(candidate => candidate.raw.feedback || !['ignored', 'approved', 'withdrawn'].includes(candidate.status)); if (data.running !== undefined) state.aiRunning = Boolean(data.running); renderDirectory(); renderCandidates(); scheduleAiPoll();
  }

  function channelOptions(id, selected, editing = false) {
    const select = get(id); select.replaceChildren();
    const blank = document.createElement('option'); blank.value = ''; blank.textContent = editing ? '新增渠道' : '请选择渠道'; select.append(blank);
    for (const channel of state.channels) { const option = document.createElement('option'); option.value = channel.id; option.textContent = `${channel.name || '未命名渠道'}${channel.enabled ? '' : '（已暂停）'}${channel.hasApiKey ? '' : '（未配置密钥）'}`; select.append(option); }
    if (selected && !state.channels.some(channel => channel.id === selected)) { const missing = document.createElement('option'); missing.value = selected; missing.textContent = '所选渠道已不可用'; select.append(missing); }
    select.value = selected || '';
  }

  function channelActions() {
    const channel = state.channels.find(item => item.id === state.channelId);
    get('ai-test').disabled = state.channelSaving || state.channelTesting || !channel?.hasApiKey;
    get('ai-clear-key').disabled = state.channelSaving || !channel?.hasApiKey;
    get('ai-channel-save').disabled = state.channelSaving;
  }

  function clearChannelTest(message = '保存后可测试各项合成任务，调用计入共享额度。') {
    setText('ai-test-result', message); get('ai-capability-results').replaceChildren();
  }

  function applyChannel(id) {
    state.channelId = id || ''; state.channelDirty = false; state.channelVersion++;
    const channel = state.channels.find(item => item.id === id);
    channelOptions('ai-channel-edit', state.channelId, true);
    get('ai-channel-name').value = channel?.name || ''; get('ai-base-url').value = channel?.baseUrl || ''; get('ai-model').value = channel?.model || ''; get('ai-api-key').value = '';
    get('ai-channel-enabled').value = String(channel?.enabled !== false);
    setText('ai-key-state', channel?.hasApiKey ? '已配置；留空保留原密钥' : '未配置；留空保留原密钥');
    setText('ai-channel-result', channel ? `正在编辑：${channel.name}${channel.enabled ? '' : '（已暂停）'}` : '新增渠道，最多保存 10 个。密钥只保存在后台。');
    clearChannelTest(); channelActions();
  }

  async function loadChannels() {
    const session = state.session, version = state.channelVersion;
    const data = await api('/v1/admin/ai-channels');
    if (session !== state.session || version !== state.channelVersion || state.channelSaving) return;
    state.channels = data.channels || [];
    setText('ai-channel-count', `${state.channels.length} / 10 个渠道，供站点、物流和手机短信模板共用`);
    if (!state.channelDirty) applyChannel(state.channelId === null ? data.defaultChannelId || state.channels[0]?.id || '' : state.channelId);
    channelOptions('ai-channel-select', state.aiDirty ? get('ai-channel-select').value : state.aiConfig?.channelId);
  }

  function applyConfig(config, force = false) {
    state.aiConfig = config || {};
    state.tuningSupported = typeof config?.autoApply === 'boolean' && typeof config?.logisticsEnabled === 'boolean';
    setHidden('ai-auto-apply-row', !state.tuningSupported);
    setHidden('ai-optimization-history', !state.tuningSupported);
    setHidden('ai-logistics-candidates', !state.tuningSupported);
    if (!state.tuningSupported) setHidden('ai-daily-learning', true);
    if (force || !state.aiDirty && !state.aiSaving) {
      get('ai-enabled').setAttribute('aria-checked', String(Boolean(config?.enabled))); get('ai-enabled').classList.toggle('off', !config?.enabled);
      get('ai-auto-apply').checked = Boolean(config?.autoApply && config?.logisticsEnabled);
      channelOptions('ai-channel-select', config?.channelId); get('ai-interval').value = '360'; get('ai-limit').value = String(Math.min(config?.dailyLimit || 20, 20)); state.aiDirty = false;
    }
    const configured = Boolean(config?.channelId && config?.channelEnabled && config?.hasApiKey && config?.baseUrl && config?.model);
    setText('ai-config-state', configured ? config.enabled ? config.autoApply && config.logisticsEnabled ? '自动调优已开启' : '自动分析已开启' : '自动优化已关闭' : config?.channelId ? '渠道不可用' : '待配置');
    setText('ai-application-note', config?.enabled && config?.autoApply ? '通过证据校验的站点别名自动应用；有歧义的建议留待核对。不会合并标准站点，也不会直接修改包裹归属。' : '当前仅生成建议，确认后才会加入站点别名；可在 AI 设置中开启自动调优。');
    setText('ai-usage', Number.isSafeInteger(config?.usageToday) && config.usageToday >= 0 ? `今日已用 ${config.usageToday} 次 / ${config.dailyLimit || 20} 次` : '当日用量尚未读取');
    setText('ai-frequency-label', !configured ? '请选择可用渠道' : config?.enabled ? '每 6 小时 · 新证据提前检查' : '自动已关闭 · 可手动分析');
  }

  async function loadAiConfig() {
    const session = state.session, version = state.aiVersion;
    const data = await api('/v1/admin/station-ai'); if (session !== state.session || version !== state.aiVersion || state.aiSaving) return;
    if (data.config) applyConfig(data.config); if (data.running !== undefined) state.aiRunning = Boolean(data.running);
    if (state.tuningSupported) await loadOptimization();
    scheduleAiPoll();
  }

  async function loadOptimization() {
    if (state.optimizationBusy) return;
    const session = state.session, version = ++state.tuningVersion;
    const results = await Promise.allSettled([api('/v1/admin/ai-optimization/history'), api('/v1/admin/logistics-ai')]);
    if (session !== state.session || version !== state.tuningVersion) return;
    const [history, logistics] = results;
    setText('ai-optimization-result', results.some(result => result.status === 'rejected') ? '部分优化记录暂时无法读取，将自动重试。' : '自动修改保留记录；回滚只撤销该次修改，人工后续改动会受到保护。');
    if (history.status === 'fulfilled') {
      const changes = history.value.changes || [], list = get('ai-optimization-list'); list.replaceChildren();
      setText('ai-optimization-count', `${changes.length} 条`);
      if (!changes.length) list.textContent = '暂无自动修改。';
      for (const change of changes) {
        const row = document.createElement('article'), title = document.createElement('p'), detail = document.createElement('p'); row.className = 'optimization-item';
        const label = change.kind === 'station_alias' ? '站点别名' : '物流规则';
        title.textContent = text(change.summary).startsWith(label) ? change.summary : `${label} · ${change.summary || '自动优化'}`;
        detail.textContent = `${change.status === 'rolled_back' ? '已回滚' : '已应用'}${change.appliedAt ? ' · ' + new Date(change.appliedAt).toLocaleString('zh-CN') : ''}`;
        row.append(title, detail);
        if (change.canRollback && ['station_alias', 'logistics_rule'].includes(change.kind)) row.append(button('回滚本次修改', async () => {
          if (state.optimizationBusy) return;
          if (!confirm('回滚这次自动修改？其他规则及人工后续改动不会被覆盖。')) return;
          const currentSession = state.session; state.tuningVersion++; state.optimizationBusy = true;
          try { await api(`/v1/admin/ai-optimization/history/${change.kind}/${encodeURIComponent(change.id)}/rollback`, { method: 'POST', body: '{}' }); }
          finally { state.optimizationBusy = false; }
          if (currentSession !== state.session) return;
          await Promise.all([loadOptimization(), loadCandidates()]);
          if (!state.dirty) { state.draft = null; await loadStations(); }
          notice('已回滚，授权设备同步后重新核对。');
        }));
        list.append(row);
      }
    }
    if (logistics.status === 'fulfilled') {
      renderDailyLearning(logistics.value.dailyLearning);
      const candidates = (logistics.value.candidates || []).filter(item => !['applied', 'ignored', 'rolled_back'].includes(item.status));
      const list = get('ai-logistics-list'); list.replaceChildren(); setText('ai-logistics-count', `${candidates.length} 条`);
      if (!candidates.length) list.textContent = '暂无待处理物流片段。';
      for (const candidate of candidates) {
        const row = document.createElement('article'), title = document.createElement('p'), detail = document.createElement('p'); row.className = 'optimization-item';
        title.textContent = candidate.fragment || '物流片段';
        detail.textContent = candidate.automationReason || candidate.error || ({ pending: '等待自动分析', review: '证据不足，需核对', failed: '分析失败，等待重试' })[candidate.status] || '待处理';
        row.append(title, detail, button('忽略', async () => {
          if (state.optimizationBusy) return;
          const currentSession = state.session; state.tuningVersion++; state.optimizationBusy = true;
          try { await api(`/v1/admin/logistics-ai/${encodeURIComponent(candidate.id)}/ignore`, { method: 'POST', body: '{}' }); }
          finally { state.optimizationBusy = false; }
          if (currentSession === state.session) await loadOptimization();
        })); list.append(row);
      }
    }
    else if (!get('ai-daily-learning').hidden) setText('ai-daily-state', '暂时无法读取');
  }

  function renderDailyLearning(daily) {
    setHidden('ai-daily-learning', !daily);
    if (!daily) return;
    const run = daily.lastRun, states = run?.states || {};
    const status = { queued: '等待分析', waiting_retry: '等待重试', requires_review: '需核对', awaiting_review: '待审核', complete: '已处理', no_candidates: '无新候选' };
    setText('ai-daily-state', !daily.enabled ? '已暂停' : daily.running ? '检查中' : run?.error ? '等待续跑' : status[run?.aiStatus] || '尚未运行');
    const next = daily.nextRunAt ? new Date(daily.nextRunAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未安排';
    setText('ai-daily-schedule', `每天 03:00（北京时间）${daily.enabled ? ` · 下次检查 ${next}` : ' · 开启物流自动分析后运行'}`);
    setText('ai-daily-result', run ? `${run.day}：检查 ${run.scanned} 条，变化 ${run.changed} 条；候选 ${run.candidateCount} 条，已分析 ${run.processedCount} 条。规则已应用 ${run.appliedRules} 条，已补全时间 ${run.backfilledCount} 单${states.rolled_back ? `，已回滚 ${states.rolled_back} 条` : ''}。${run.error || ''}${run.truncated ? '剩余记录将在下一次检查继续。' : ''}` : '尚无每日学习记录。');
    const issues = run?.issues;
    setText('ai-daily-issues', issues ? `当前待核对 ${run.unconfirmedCount} 单：缺到货时间 ${issues.missingArrival}，时间无法识别 ${issues.unknownTime}，精度未知 ${issues.unknownPrecision}，时间冲突 ${issues.timeConflict}。同一包裹可能包含多项。` : '检查结果将在运行后显示。');
  }

  function stationWorkspaceVisible() { return state.open && !document.hidden && !get('station-settings-view').hidden && !get('page-settings').hidden && !get('workspace').hidden; }

  function scheduleAiPoll() {
    clearTimeout(state.aiPollTimer); state.aiPollTimer = null;
    if (!stationWorkspaceVisible() || state.aiPolling || !state.aiRunning && !state.aiConfig?.enabled) return;
    state.aiPollTimer = setTimeout(async () => {
      state.aiPollTimer = null; if (!stationWorkspaceVisible()) return;
      const session = state.session; state.aiPolling = true;
      const results = await Promise.allSettled([loadCandidates(), loadAiConfig(), loadFeedback(true)]);
      if (session !== state.session) return;
      state.aiPolling = false;
      const failure = results.find(result => result.status === 'rejected');
      if (failure && stationWorkspaceVisible()) notice(failure.reason?.message || '分析状态暂时无法更新。', true);
      scheduleAiPoll();
    }, state.aiRunning ? 3000 : 10000);
  }

  async function loadWorkspace() {
    if (!state.open) return;
    try { await Promise.all([loadStations(), loadCandidates(), loadFeedback(true), loadAiConfig(), loadChannels()]); } catch (error) { notice(error.message || '站点管理暂时无法读取。', true); }
  }

  async function saveStation(event) {
    event.preventDefault(); const draft = selectedOrDraft(); if (!draft) return;
    draft.name = get('station-name').value.trim(); draft.region = get('station-region').value.trim();
    if (!draft.name || !draft.region) throw new Error('请填写标准名称和所在地区。');
    const aliases = draft.aliases.filter(alias => alias.name.trim()).map(alias => ({ id: alias.id || undefined, name: alias.name.trim(), source: ({ 物流: 'platform', 短信: 'sms', 手动: 'manual', AI辅助: 'ai' })[sourceLabel(alias.source)] || sourceLabel(alias.source) || 'manual', subLocation: alias.subLocation.trim() }));
    const body = { name: draft.name, region: draft.region, enabled: draft.enabled, aliases };
    const data = await api(draft.id ? `/v1/admin/stations/${encodeURIComponent(draft.id)}` : '/v1/admin/stations', { method: draft.id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    const saved = stationOf(data.station); state.stations = state.stations.filter(station => station.id !== saved.id); state.stations.push(saved); state.selectedId = saved.id; state.draft = cloneStation(saved); state.newStation = false; state.dirty = false; renderDirectory(); renderDetail(); notice('站点规则已保存，授权设备将在同步时获取新版本。');
  }

  function verifyStation() {
    const logistics = get('verify-logistics').value.trim(); const sms = get('verify-sms').value.trim(); const result = get('verify-result');
    if (!logistics || !sms) { result.className = 'verify-result warning'; result.textContent = '请分别填写物流站名和短信站名后再验证。'; return; }
    const { same, conflict } = compareStationNames(logistics, sms, state.stations);
    result.className = `verify-result ${same ? 'ok' : 'warning'}`; result.textContent = same ? '已保存的规则识别为同站点；仍需检查真实到站时间、双方唯一性和其他冲突。' : conflict ? '站点、柜号、卡位、楼栋或门向存在差异，不能自动关联。' : '名称尚未确认为同站点，请先保存并核对别名关系；本次验证使用已保存规则。';
  }

  async function saveAi(event) {
    event.preventDefault(); if (state.aiSaving) return;
    const channelId = get('ai-channel-select').value, body = { enabled: get('ai-enabled').getAttribute('aria-checked') === 'true', intervalMinutes: Number(get('ai-interval').value), dailyLimit: Number(get('ai-limit').value) };
    if (state.tuningSupported) { body.autoApply = get('ai-auto-apply').checked; body.logisticsEnabled = body.autoApply; }
    if (channelId) body.channelId = channelId;
    if (body.enabled && !channelId) throw new Error('请先保存并选择可用渠道。');
    if (!Number.isSafeInteger(body.dailyLimit) || body.dailyLimit < 1 || body.dailyLimit > 20) throw new Error('每日调用上限须为1至20的整数。');
    const session = state.session; state.aiVersion++; state.aiSaving = true;
    setFormBusy('ai-settings-form', true); setText('ai-settings-result', '正在保存…');
    try { const data = await api('/v1/admin/station-ai', { method: 'PATCH', body: JSON.stringify(body) }); if (session !== state.session) return; state.aiVersion++; applyConfig(data.config || data, true); setText('ai-settings-result', '自动优化设置已保存。'); }
    catch (error) { if (session === state.session) setText('ai-settings-result', error.message || '设置未保存，请重试。'); }
    finally { state.aiSaving = false; setFormBusy('ai-settings-form', false); scheduleAiPoll(); }
    if (session === state.session && stationWorkspaceVisible()) {
      try { await Promise.all([loadCandidates(), ...(state.tuningSupported ? [loadOptimization()] : [])]); } catch (error) { notice(error.message || '候选暂时无法更新，稍后自动重试。', true); }
    }
  }

  function setFormBusy(id, busy) {
    const form = get(id); form.setAttribute('aria-busy', String(busy));
    for (const control of form.querySelectorAll('input, select, button')) control.disabled = busy;
  }

  async function saveChannel(event, clearKey = false) {
    event?.preventDefault(); if (state.channelSaving) return;
    const id = state.channelId, body = clearKey ? { clearApiKey: true, enabled: false } : { name: get('ai-channel-name').value.trim(), baseUrl: get('ai-base-url').value.trim(), model: get('ai-model').value.trim(), enabled: get('ai-channel-enabled').value === 'true' };
    if (!clearKey && (!body.name || !body.baseUrl || !body.model)) throw new Error('请填写渠道名称、HTTPS接口地址和模型。');
    const key = get('ai-api-key').value.trim(); if (!clearKey && key) body.apiKey = key;
    const session = state.session; state.channelVersion++; state.channelSaving = true; clearChannelTest('渠道设置正在更新，请保存后重新测试。');
    setFormBusy('ai-channel-form', true); setText('ai-channel-result', '正在保存渠道…');
    try {
      const data = await api(id ? `/v1/admin/ai-channels/${encodeURIComponent(id)}` : '/v1/admin/ai-channels', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      if (session !== state.session) return;
      if (data.channel) state.channels = state.channels.map(channel => channel.id === data.channel.id ? data.channel : channel); else state.channels = data.channels || [];
      const savedId = data.channel?.id || state.channels.at(-1)?.id || id; applyChannel(savedId);
      setText('ai-channel-count', `${state.channels.length} / 10 个渠道，供站点、物流和手机短信模板共用`);
      setText('ai-channel-result', clearKey ? '密钥已清除，此渠道已暂停。' : '渠道已保存。');
      await loadAiConfig();
    } catch (error) { if (session === state.session) setText('ai-channel-result', error.message || '渠道未保存，请重试。'); }
    finally { state.channelSaving = false; setFormBusy('ai-channel-form', false); channelActions(); }
  }

  async function clearApiKey() {
    if (!state.channelId || !confirm('清除此渠道已保存的 API Key 并暂停渠道？使用此渠道的站点和手机优化将停止。')) return;
    await saveChannel(null, true);
  }

  async function testAi() {
    if (state.channelDirty) throw new Error('请先保存渠道，再进行能力测试。');
    if (!state.channelId) throw new Error('请先保存渠道。');
    const session = state.session, version = state.channelVersion, id = state.channelId;
    state.channelTesting = true; channelActions(); clearChannelTest('正在测试连接和各项合成任务…');
    try {
      const data = await api(`/v1/admin/ai-channels/${encodeURIComponent(id)}/test`, { method: 'POST', body: '{}' });
      if (session !== state.session || version !== state.channelVersion) return;
      setText('ai-test-result', `测试已完成：${data.message || '请查看各项校验结果。'}`);
      for (const [capability, label] of [['station_alias', '站点别名'], ['sms_template', '短信模板'], ...(data.capabilities?.logistics_rule ? [['logistics_rule', '物流识别']] : [])]) {
        const result = data.capabilities?.[capability], row = document.createElement('li'); row.textContent = `${label}：${result?.ok === true ? '校验通过' : '未通过'} · ${result?.message || '未收到有效校验结果'}`; get('ai-capability-results').append(row);
      }
      await loadAiConfig();
    } catch (error) { if (session === state.session && version === state.channelVersion) clearChannelTest(error.message || '测试未完成，请重试。'); }
    finally { state.channelTesting = false; channelActions(); }
  }

  async function runAi() {
    if (state.aiDirty || state.channelDirty) throw new Error('请先保存 AI 设置，再提交分析。');
    const data = await api('/v1/admin/station-ai/run', { method: 'POST', body: '{}' }); state.aiRunning = Boolean(data.running ?? data.accepted); scheduleAiPoll(); notice(data.message || (data.accepted ? '分析任务已提交，正在后台处理。' : '分析任务未接受。'), !data.accepted);
  }

  async function approveCandidate(event) {
    event.preventDefault(); const candidate = state.reviewCandidate; if (!candidate) return;
    const stationId = get('review-station').value; if (!stationId) throw new Error('请先选择标准站点。');
    const body = { stationId: stationId === '__new__' ? '' : stationId, alias: get('review-alias').value.trim(), subLocation: get('review-sub-location').value.trim() };
    if (!body.alias) throw new Error('请填写原文中真实的站点别名。');
    if (stationId === '__new__') { body.name = get('review-new-name').value.trim(); body.region = get('review-new-region').value.trim(); if (!body.name || !body.region) throw new Error('新建站点必须填写标准名称和地区。'); }
    await api(`/v1/admin/station-candidates/${encodeURIComponent(candidate.id)}/approve`, { method: 'POST', body: JSON.stringify(body) }); get('station-review-dialog').close(); state.reviewCandidate = null; await Promise.all([loadStations(), loadCandidates(), loadFeedback(true)]); notice('候选已人工确认并加入站点规则。');
  }

  function switchSettings(view) {
    const station = view === 'station'; state.open = station; setHidden('settings-basic-view', station); setHidden('station-settings-view', !station); get('basic-settings-tab').classList.toggle('active', !station); get('station-settings-tab').classList.toggle('active', station); setText('settings-page-title', station ? '站点管理' : '服务设置'); clearTimeout(state.aiPollTimer); state.aiPollTimer = null;
    if (station) loadWorkspace();
  }

  get('basic-settings-tab').addEventListener('click', () => switchSettings('basic'));
  get('station-settings-tab').addEventListener('click', () => switchSettings('station'));
  get('logistics-settings-tab').addEventListener('click', () => { state.open = false; clearTimeout(state.aiPollTimer); state.aiPollTimer = null; });
  for (const id of ['nav-accounts', 'nav-devices']) get(id).addEventListener('click', () => { clearTimeout(state.aiPollTimer); state.aiPollTimer = null; });
  get('nav-settings').addEventListener('click', () => { if (state.open) loadWorkspace(); });
  get('station-add').addEventListener('click', newStation);
  get('station-search-input').addEventListener('input', event => { state.query = event.target.value.trim(); renderDirectory(); });
  get('station-queue-entry').addEventListener('click', showQueue);
  get('matching-feedback-more').addEventListener('click', () => loadFeedback(false).catch(error => notice(error.message || '反馈流水暂时无法读取。', true)));
  get('matching-feedback-filter').addEventListener('click', () => loadFeedback(true).catch(error => notice(error.message || '反馈筛选暂时无法读取。', true)));
  get('ai-open-settings').addEventListener('click', () => { showQueue(); get('ai-settings-panel').open = true; get('ai-settings-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
  const guarded = (id, handler) => get(id).addEventListener('click', async () => { const element = get(id); if (element.disabled) return; element.disabled = true; try { await handler(); } catch (error) { notice(error.message || '操作未完成，请重试。', true); } finally { if (id === 'ai-test' || id === 'ai-clear-key') channelActions(); else element.disabled = false; } });
  guarded('ai-run', runAi);
  guarded('ai-test', testAi);
  guarded('ai-clear-key', clearApiKey);
  get('station-form').addEventListener('submit', event => saveStation(event).catch(error => notice(error.message || '站点未保存。', true)));
  get('station-name').addEventListener('input', () => { state.dirty = true; });
  get('station-region').addEventListener('input', () => { state.dirty = true; });
  get('alias-add').addEventListener('click', () => { const draft = selectedOrDraft(); if (!draft) return; draft.aliases.push({ name: '', source: '手动', subLocation: '' }); state.dirty = true; renderAliases(); renderDirectory(); get('alias-list').querySelector('input')?.focus(); });
  get('station-enabled').addEventListener('click', () => { const draft = selectedOrDraft(); if (!draft) return; draft.enabled = !draft.enabled; state.dirty = true; renderDetail(); });
  get('verify-station').addEventListener('click', verifyStation);
  get('station-review-close').addEventListener('click', () => get('station-review-dialog').close()); get('review-cancel').addEventListener('click', () => get('station-review-dialog').close());
  get('review-station').addEventListener('change', event => setHidden('review-new-fields', event.target.value !== '__new__'));
  get('station-review-form').addEventListener('submit', event => approveCandidate(event).catch(error => notice(error.message || '候选未加入。', true)));
  get('ai-settings-form').addEventListener('submit', event => saveAi(event).catch(error => notice(error.message || 'AI 设置未保存。', true)));
  const markAiDirty = () => { state.aiDirty = true; state.aiVersion++; setText('ai-settings-result', '有未保存的更改。'); };
  get('ai-settings-form').addEventListener('input', markAiDirty);
  get('ai-auto-apply').addEventListener('change', markAiDirty);
  get('ai-open-logistics').addEventListener('click', () => get('logistics-settings-tab').click());
  get('ai-interval').addEventListener('change', markAiDirty); get('ai-channel-select').addEventListener('change', markAiDirty);
  get('ai-enabled').addEventListener('click', () => { const next = get('ai-enabled').getAttribute('aria-checked') !== 'true'; get('ai-enabled').setAttribute('aria-checked', String(next)); get('ai-enabled').classList.toggle('off', !next); markAiDirty(); });
  get('ai-channel-form').addEventListener('submit', event => saveChannel(event).catch(error => notice(error.message || '渠道未保存。', true)));
  const markChannelDirty = event => { if (event.target.id === 'ai-channel-edit') return; state.channelDirty = true; state.channelVersion++; clearChannelTest('渠道有未保存的更改，请保存后重新测试。'); };
  get('ai-channel-form').addEventListener('input', markChannelDirty); get('ai-channel-enabled').addEventListener('change', markChannelDirty);
  get('ai-channel-edit').addEventListener('change', event => {
    if (state.channelDirty && !confirm('当前渠道有未保存更改，切换后将丢失。继续？')) { event.target.value = state.channelId || ''; return; }
    applyChannel(event.target.value);
  });
  get('logout').addEventListener('click', () => { state.open = false; state.session++; state.aiVersion++; state.channelVersion++; state.channelId = null; state.channelDirty = false; state.aiDirty = false; state.aiPolling = false; get('ai-api-key').value = ''; clearChannelTest(); clearTimeout(state.aiPollTimer); state.aiPollTimer = null; });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { clearTimeout(state.aiPollTimer); state.aiPollTimer = null; } else if (state.open) loadWorkspace(); });
  renderDirectory(); renderDetail();
}
