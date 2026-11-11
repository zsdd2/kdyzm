/* Shared ES5 logistics parser: Node, WebView and Android Rhino use this source. */
var PickCodeLogistics = (function () {
  'use strict';
  var POINT = /驿站|代收点|自提点|自提站|自提柜|快递柜|快递超市|智能柜|丰巢|菜鸟|门店|便利店/;
  var FUTURE = /下一站|发往|运往|开往|前往|将(?:到|达|至)|目的(?:地|站)|即将/;
  var UNREALIZED = /预计|预定|计划|将(?:于|在|送|到|存|暂存|放)|尚未|未(?:能|曾)?(?:到|送|投|存|暂存|放)|失败|未成功|无法|未能|(?:请|要求|希望|安排|同意|约定|等待)[^，,。；;！？!?]{0,12}(?:暂存|存放|存入|到达|送达|送到|送至|投递|放)/;
  var REMINDER = /催取|提醒|再次通知|尽快|逾期|滞留|超时/;
  var PERSONAL_COMPLETION = /(?:本人|收件人|用户|客户)已(?:经)?(?:完成)?(?:签收|领取|取件|取走)/;
  var SPLIT = /[，,。；;！？!?\n\r]/;
  var KEYS = ['id', 'name', 'enabled', 'kind', 'starts', 'end', 'keywords', 'sample', 'expectedStation', 'origin'];
  function text(value) { return typeof value === 'string' || typeof value === 'number' ? String(value).replace(/^\s+|\s+$/g, '') : ''; }
  function stationKey(value) { return text(value).replace(/[\s!"#$%&'()*+,\-./:;<>?=@[\]\\^_`{|}~，。；：！？、（）【】「」“”‘’《》〈〉…·—]/g, ''); }
  function genericPickupStation(value) { return /^(?:菜鸟驿站|驿站|代收点|自提点|自提站|自提柜|快递柜|智能柜|丰巢|丰巢快递柜|快递代收点|代收站|快递站)$/.test(stationKey(value)); }
  function pickupCycleReset(value) {
    return text(value).split(SPLIT).some(function (part) {
      return /退回|退件|退货|退签|拒签|拒绝?签收|改投|改派|转投|重新(?:派送|投递|揽收)|取出(?:了)?(?:快递柜|自提柜)|离开[^，,。；;！？!?]*(?:驿站|代收点|快递柜)/.test(part)
        && !/预计|预定|计划|即将|将于|申请|预约|准备|等待|待审核|审核中|是否|疑似|可能|取消|撤销|希望|要求|请/.test(part)
        && !/(?:未(?:能|曾|有)?|没有|没能|无法|无需)(?:退回|退件|退货|退签|拒签|改投|改派|转投|重新|取出|离开)/.test(part)
        && !/(?:退回|退件|退货|退签|拒签|改投|改派|转投|投递|派送|揽收)[^，,。；;！？!?]{0,8}(?:失败|未成功)/.test(part);
    });
  }
  function homeDeliveryCompleted(value) {
    var description = text(value);
    return /已(?:经)?(?:成功)?(?:送达|妥投)|妥投成功|已(?:经)?(?:送(?:到|至)|派送(?:到|至)|投递(?:到|至)|放(?:在|到|至)?)[^，,。；;！？!?]{0,12}门口|(?:^|[：:\s])(?:送达|妥投)(?:$|[：:\s])/.test(description)
      && !/(?:未|待|等待|预计|预定|计划|将|请|要求|希望|安排|同意|约定)[^，,。；;！？!?]{0,12}(?:送达|妥投|送到|送至|投递|放)/.test(description)
      && !/(?:送达|妥投|派送|投递)[^，,。；;！？!?]{0,8}(?:失败|未成功)/.test(description);
  }
  function clean(candidate, catalogAlias) {
    var raw = text(candidate).replace(/^[：:\s]+/, '');
    // A provider may prepend its brand/action before an explicit pickup address.
    // Stay within the already validated action fragment; never borrow a later destination.
    var address = /(?:取件|取货|自提)地址\s*[:：]\s*/.exec(raw);
    if (address) raw = raw.slice(address.index + address[0].length);
    var repeated = /^([^()（）]+)[(（]([^()（）]+)[)）]\s*([^()（）]+)$/.exec(raw);
    if (repeated && stationKey(repeated[2]) === stationKey(repeated[3])
      && !/(?:[东南西北正侧后]门|[A-Za-z0-9一二三四五六七八九十]+\s*(?:号?柜|卡|栋|幢|单元|号楼|座|门))/.test(repeated[1])
      && !/分拣|转运|分拨|物流中心|营业部|家门口|家中|收件人|本人/.test(raw)) raw = text(repeated[2]);
    var bracket = raw.match(/^[【「“]([^】」”]+)[】」”](\s*[A-Za-z0-9一二三四五六七八九十]+号柜)?/);
    var station = text((bracket ? bracket[1] + (bracket[2] || '') : raw).replace(/^[【「“\s]+|[】」”\s]+$/g, '')
      .split(/(?:[，,。；;！？!?]|请|取件码|取货码|提货码|凭码|等待取件|待取件|已签收|已代收|联系电话|电话)/)[0]);
    return station && station.length <= 120 && !/分拣|转运|分拨|物流中心|营业部|家门口|家中|收件人|本人/.test(station)
      && (catalogAlias || POINT.test(station) || /店$/.test(station)) ? station : '';
  }
  function defaults() {
    var station = '幸福小区菜鸟驿站';
    function rule(id, name, kind, starts, prefix) {
      return { id: id, name: name, enabled: true, kind: kind, starts: starts, end: '', keywords: [],
        sample: prefix + station + '，请及时取件', expectedStation: station, origin: 'builtin' };
    }
    return [
      rule('builtin-arrival-storage', '存放与暂存', 'arrival', ['存放至', '存放到', '存放在', '存入', '暂存至', '暂存到', '暂存于', '暂存在'], '您的快件已暂存至'),
      rule('builtin-arrival-reached', '到达取件点', 'arrival', ['已经成功到达', '已经成功到', '已成功到达', '已成功到', '已经到达', '已经到', '已到达', '已到', '到达'], '您的快件已到达'),
      rule('builtin-arrival-delivery', '送达与投递', 'arrival', ['送达', '送到', '送至', '派送到', '派送至', '投递至', '投递到', '妥投至', '妥投到'], '您的快件已送达'),
      rule('builtin-arrival-placement', '放置取件点', 'arrival', ['放置到', '放置于', '放置至', '放置在', '放在', '放到', '放至'], '您的快件已放置到'),
      rule('builtin-location-storage', '当前位置', 'location', ['仍在', '存放于', '位于', '已在', '在'], '包裹仍在'),
      rule('builtin-location-collection', '前往领取位置', 'location', ['请您及时到', '请您及时至', '请您尽快到', '请您尽快至', '请您到', '请您至', '请及时到', '请及时至', '请尽快到', '请尽快至', '请到', '请至'], '请您及时到')
    ];
  }
  function ruleList(rules) { return Array.isArray(rules) ? rules : defaults(); }
  function fragments(value) {
    var pattern = /[^，,。；;！？!?\n\r]+/g, match, output = [];
    while ((match = pattern.exec(value))) output.push({ value: match[0], tail: value.slice(match.index) });
    return output;
  }
  function unrealizedAction(prefix, kind) {
    // Editable verbs may be unknown to the fixed vocabulary. Check their own preceding wording too.
    // A terminal status label and the completed "已将包裹..." construction are not future instructions.
    var value = prefix.replace(/待取件|待自提|待领取|已(?:经)?将/g, '');
    if (/(?:未|没有|还没|没|不能|不可|不应|不要|不曾|不再|不会|无法|将|即将|准备|待|等待|计划|预计|预定)[^，,。；;！？!?]{0,16}$/.test(value)) return true;
    return kind === 'arrival' && /(?:请|要求|希望|约定|安排|同意|正在)[^，,。；;！？!?]{0,16}$/.test(value);
  }
  function fragmentMatch(fragment, rules, catalogAlias) {
    var current = fragment.value.split(FUTURE)[0], list = ruleList(rules), i, j, rule, at, suffix, endAt, station, extended, address;
    for (i = 0; i < list.length; i++) {
      rule = list[i];
      if (!rule || !rule.enabled || !Array.isArray(rule.starts)) continue;
      if ((rule.keywords || []).some(function (word) { return current.indexOf(word) < 0; })) continue;
      for (j = 0; j < rule.starts.length; j++) {
        if (!rule.starts[j]) continue;
        at = current.indexOf(rule.starts[j]);
        while (at >= 0) {
          if (unrealizedAction(current.slice(0, at + rule.starts[j].length), rule.kind)) {
            at = current.indexOf(rule.starts[j], at + rule.starts[j].length); continue;
          }
          suffix = current.slice(at + rule.starts[j].length);
          if (rule.end) {
            endAt = suffix.indexOf(rule.end);
            // An explicit trailing marker may begin with the fragment separator (e.g. "，地址：").
            // The extracted station itself must still end inside this action's fragment.
            if (endAt < 0 && current === fragment.value) {
              extended = fragment.tail.slice(at + rule.starts[j].length);
              endAt = extended.indexOf(rule.end);
              if (endAt >= 0 && !SPLIT.test(extended.slice(0, endAt)) && !FUTURE.test(extended.slice(0, endAt))) suffix = extended;
              else endAt = -1;
            }
            if (endAt < 0) { at = current.indexOf(rule.starts[j], at + rule.starts[j].length); continue; }
            suffix = suffix.slice(0, endAt);
          }
          // A completed storage clause may identify its pickup address immediately after a comma.
          address = !rule.end && rule.kind === 'arrival' && current === fragment.value && /(?:暂存|存放)$/.test(text(suffix))
            && !/分拣|转运|分拨|物流中心|营业部|门口|门前|家中|家里|住处|收件人|本人/.test(current)
            ? /^[，,]\s*(?:取件|取货|自提)地址\s*[:：]\s*([^，,。；;！？!?\n\r]+)/.exec(fragment.tail.slice(fragment.value.length)) : null;
          if (address && FUTURE.test(address[1])) address = null;
          station = clean(address ? address[1] : suffix, catalogAlias);
          if (station) return { station: station, ruleId: rule.id, kind: rule.kind, origin: rule.origin, pickupAddress: !!address };
          at = current.indexOf(rule.starts[j], at + rule.starts[j].length);
        }
      }
    }
    var receipt = current.match(/由(.+?)(?:已(?:签收|代收)|代收)/)
      || current.match(/(?:^|[：:])([^：:]+?)(?:已(?:签收|代收)|代收|等待取件|待取件)/);
    station = receipt ? clean(receipt[1], catalogAlias) : '';
    return station ? { station: station, ruleId: '', kind: /代收|已签收/.test(current) ? 'arrival' : 'location' } : null;
  }
  function stationMatch(description, rules) {
    var value = text(description), parts, i, match;
    if (UNREALIZED.test(value) || pickupCycleReset(value)) return null;
    parts = fragments(value);
    for (i = 0; i < parts.length; i++) { match = fragmentMatch(parts[i], rules); if (match) return match; }
    return null;
  }
  function pickupStation(description, rules) {
    var match = stationMatch(description, rules);
    return match ? match.station : '';
  }
  function pickupArrivalEvent(description, stationHint, rules) {
    var value = text(description), parts, i, match;
    if (!value || UNREALIZED.test(value) || pickupCycleReset(value) || REMINDER.test(value)) return false;
    parts = fragments(value);
    for (i = 0; i < parts.length; i++) {
      match = fragmentMatch(parts[i], rules);
      if (match && match.kind === 'arrival' && (match.origin === 'manual' || match.pickupAddress || POINT.test(match.station) || /取件|取货|自提|代收/.test(parts[i].value))) return true;
    }
    return !FUTURE.test(value) && !/转运|分拣|分拨|物流中心/.test(value)
      && ((!!stationHint && POINT.test(stationHint) && /^(?:签收|已签收|签收成功)(?:[:：\s]|$)/.test(value))
        || /^(?:待取件|已到站|到站|已入柜|入柜|待自提)(?:[:：\s]|$)/.test(value));
  }
  function timePrecision(value) {
    var raw = text(value);
    if (/^\d{10,13}$/.test(raw)) return 'second';
    if (/^\d{4}[-年/]\d{2}[-月/]\d{2}日?[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(raw)) return 'second';
    if (/^\d{4}[-年/]\d{2}[-月/]\d{2}日?[ T]\d{2}:\d{2}(?:Z|[+-]\d{2}:?\d{2})?$/.test(raw)) return 'minute';
    return 'unknown';
  }
  function eventTimeIssue(event, now) {
    if (typeof event.time !== 'number' || !isFinite(event.time) || Math.floor(event.time) !== event.time || event.time <= 0 || event.time > 8640000000000000) return 'unknownTime';
    if (event.time > now) return 'timeConflict';
    var raw = text(event.timeText), parsed = 0, precision = timePrecision(raw), unit;
    if (/^\d{10,13}$/.test(raw)) parsed = Number(raw) * (raw.length <= 10 ? 1000 : 1);
    else if (/^\d{4}[-年/]\d{1,2}[-月/]\d{1,2}日?[ T]\d{1,2}:\d{2}/.test(raw)) {
      raw = raw.replace(/年|月|\//g, '-').replace('日', '').replace(' ', 'T').replace(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2})/, function (_, year, month, day, hour) {
        return year + '-' + ('0' + month).slice(-2) + '-' + ('0' + day).slice(-2) + 'T' + ('0' + hour).slice(-2);
      });
      precision = timePrecision(raw);
      if (precision !== 'unknown') parsed = Date.parse(/Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : raw + '+08:00') || 0;
    }
    unit = precision === 'minute' ? 60000 : 1000;
    if (parsed && Math.floor(parsed / unit) !== Math.floor(event.time / unit)) return 'timeConflict';
    return ['second', 'minute'].indexOf(event.timePrecision) >= 0 || !event.timePrecision && precision !== 'unknown' ? '' : 'unknownPrecision';
  }
  function pickupEvidence(events, rules, activeOnly) {
    var empty = { arrivalAt: 0, arrivalAtSource: 'unknown', arrivalAtPrecision: 'unknown', station: '', stationSource: 'unknown' };
    var station = '', i, event, description, described, describedMatch, card, candidate, arrival;
    events = Array.isArray(events) ? events : [];
    // Backfill must not revive a completed pickup; history readers still retain its arrival milestone.
    if (events.some(function (item) { return !item.time && (pickupCycleReset(item.description) || activeOnly && (PERSONAL_COMPLETION.test(item.description) || eventStatus(item.description, 'unknown', rules) === 'signed')); })) return empty;
    for (i = 0; i < events.length; i++) {
      event = events[i]; description = text(event.description);
      if (pickupCycleReset(description) || activeOnly && PERSONAL_COMPLETION.test(description)) break;
      describedMatch = stationMatch(description, rules);
      described = describedMatch ? describedMatch.station : '';
      card = event.station ? clean(event.station) : '';
      candidate = !described || genericPickupStation(described) ? card || described : described;
      arrival = pickupArrivalEvent(description, candidate, rules);
      if (activeOnly && !arrival && eventStatus(description, 'unknown', rules) === 'signed') break;
      if (candidate && (arrival || /取件|取货|自提|代收/.test(description)
        || (describedMatch && describedMatch.ruleId && describedMatch.kind === 'location'))) station = station || candidate;
      if (!arrival) continue;
      if (station && candidate && stationKey(station) !== stationKey(candidate)) break;
      station = station || candidate;
      if (!event.time) continue;
      return { arrivalAt: event.time, arrivalAtSource: 'platform_event', arrivalAtPrecision: ['second', 'minute', 'unknown'].indexOf(event.timePrecision) >= 0 ? event.timePrecision : timePrecision(event.timeText),
        station: station, stationSource: station ? 'platform_event' : 'unknown' };
    }
    empty.station = station; empty.stationSource = station ? 'platform_event' : 'unknown'; return empty;
  }
  function doorstepEvidence(events, shipment, now) {
    // Doorstep delivery dates arrival; recipient collection still needs its own evidence or confirmation.
    var empty = { arrivalAt: 0, arrivalAtSource: 'unknown', arrivalAtPrecision: 'unknown', station: '', stationSource: 'unknown' };
    var carrier = text(shipment && shipment.carrier).toUpperCase().replace(/[\s._-]+/g, ''), i, event, description;
    if ((!shipment || shipment.platform !== 'jd') && !/京东|顺丰|^(?:JD|SF)(?:EXPRESS)?$/.test(carrier)) return empty;
    now = typeof now === 'number' ? now : Date.now();
    events = (Array.isArray(events) ? events : []).slice().sort(function (a, b) { return (b.time || 0) - (a.time || 0); });
    if (events.some(function (item) { return eventTimeIssue(item, now) === 'unknownTime'
      && (pickupCycleReset(item.description) || pickupArrivalEvent(item.description) || POINT.test(item.description) && eventStatus(item.description) === 'arrived'); })) return empty;
    for (i = 0; i < events.length; i++) {
      event = events[i]; description = text(event.description);
      if (event.time > now) continue;
      if (pickupCycleReset(description) || pickupArrivalEvent(description) || POINT.test(description) && eventStatus(description) === 'arrived') return empty;
      if (!/门口|门外/.test(description) || !homeDeliveryCompleted(description)
        || POINT.test(description) || /代收|代签|门卫|保安|前台|邻居|转运|分拣|分拨|物流中心|联系不上|无法联系|未联系上|取消|撤销|疑似|可能|是否|[?？]/.test(description)
        || UNREALIZED.test(description) || FUTURE.test(description)) continue;
      if (['unknownTime', 'timeConflict'].indexOf(eventTimeIssue(event, now)) >= 0) return empty;
      if (events.some(function (other) { return other.time === event.time && text(other.description) === description
        && eventTimeIssue(other, now) === 'timeConflict'; })) return empty;
      return { arrivalAt: event.time, arrivalAtSource: 'platform_event', arrivalAtPrecision: ['second', 'minute', 'unknown'].indexOf(event.timePrecision) >= 0 ? event.timePrecision : timePrecision(event.timeText),
        station: '', stationSource: 'unknown' };
    }
    return empty;
  }
  function catalogStationKey(value) {
    var digits = {'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
    value = text(value); if (value.normalize) value = value.normalize('NFKC');
    value = value.replace(/[！-～]/g, function (character) { return String.fromCharCode(character.charCodeAt(0) - 65248); }).replace(/[－—–]/g, '-');
    return value.replace(/[零〇一二两三四五六七八九十]+(?=卡|号(?:柜|快递柜|自提柜|楼|门)|栋|幢)/g, function (number) {
      if (number.indexOf('十') >= 0) { var parts = number.split('十'); return String((parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0)); }
      return number.split('').map(function (character) { return digits[character]; }).join('');
    }).replace(/[\s，,。()（）【】\[\]·:：；;]/g, '');
  }
  function catalogLocationConflict(values) {
    var seen = {}, conflict = false;
    values.forEach(function (value) {
      var key = catalogStationKey(value), pattern = /((?:[A-Za-z]{1,3}区|\d{1,2}区)?[A-Za-z0-9]{1,6})(号?(?:快递柜|自提柜|柜)|卡|号楼|栋|幢)|([东南西北正侧后]{1,2})(?:大)?门/g, match, kind, location;
      while ((match = pattern.exec(key))) {
        kind = match[3] ? 'gate' : /柜/.test(match[2]) ? 'cabinet' : /卡/.test(match[2]) ? 'card' : 'building';
        location = match[3] || match[1].toUpperCase();
        if (seen[kind] && seen[kind] !== location) conflict = true;
        seen[kind] = location;
      }
    });
    return conflict;
  }
  function catalogEntries(catalog) {
    var entries = [];
    (Array.isArray(catalog) ? catalog : []).forEach(function (station) {
      if (!station || station.enabled === false || !station.id) return;
      [{name:station.name,subLocation:''}].concat(station.aliases || []).forEach(function (alias) {
        var key = catalogStationKey(alias.name);
        if (key && !genericPickupStation(key)) entries.push({id:station.id,name:station.name,alias:alias.name,subLocation:alias.subLocation || '',key:key});
      });
    });
    return entries;
  }
  function catalogStation(value, catalog) {
    var key = catalogStationKey(value), found = [], names = [value], owners = [];
    catalogEntries(catalog).forEach(function (entry) {
      if (entry.key !== key) return;
      found.push(entry); names.push(entry.name,entry.subLocation);
      if (owners.indexOf(entry.id) < 0) owners.push(entry.id);
    });
    var ambiguous = owners.length > 1 || !!found.length && catalogLocationConflict(names);
    return {id:owners.length === 1 && !ambiguous ? owners[0] : '',name:owners.length === 1 && !ambiguous ? found[0].name : '',ambiguous:ambiguous};
  }
  function catalogPickupEvidence(events, catalog, rules) {
    var empty = pickupEvidence([], rules), entries = catalogEntries(catalog), selected, event, i, parts, j, match, key, candidate, locations, starts = [];
    if (!entries.length) return empty;
    // The directory confirms identity; only an explicit completed storage action supplies arrival evidence.
    ['已经成功','已经','已成功','已'].forEach(function (prefix) {
      ['交付给','交付至','托管至','托管到','托管于','寄存至','寄存到','寄存于','保管至','保管于','收存至','收存于','入库至','入库到','入库于','转存至','转存到','转存于'].forEach(function (action) { starts.push(prefix + action); });
    });
    var combined = ruleList(rules).concat([{id:'catalog-completed-pickup',enabled:true,kind:'arrival',origin:'manual',end:'',keywords:[],
      starts:starts}]);
    events = Array.isArray(events) ? events : [];
    if (events.some(function (item) { return !item.time && (pickupCycleReset(item.description) || PERSONAL_COMPLETION.test(item.description) || eventStatus(item.description, 'unknown', rules) === 'signed'); })) return empty;
    for (i = 0; i < events.length; i++) {
      event = events[i];
      if (pickupCycleReset(event.description)) break;
      if (UNREALIZED.test(event.description) || REMINDER.test(event.description)) continue;
      if (PERSONAL_COMPLETION.test(event.description)) return empty;
      parts = fragments(text(event.description));
      candidate = null;
      for (j = 0; j < parts.length; j++) {
        match = fragmentMatch(parts[j], combined, true);
        if (!match || match.kind !== 'arrival') continue;
        key = catalogStationKey(match.station); selected = catalogStation(match.station,catalog);
        if (!selected.id || candidate && catalogStationKey(candidate.station) !== key) return empty;
        locations = [match.station,selected.name,event.description];
        entries.forEach(function (entry) { if (entry.key === key && entry.id === selected.id) locations.push(entry.subLocation); });
        if (catalogLocationConflict(locations)) return empty;
        candidate = {arrivalAt:event.time || 0,arrivalAtSource:event.time ? 'platform_event' : 'unknown',
          arrivalAtPrecision:event.time ? ['second','minute','unknown'].indexOf(event.timePrecision) >= 0 ? event.timePrecision : timePrecision(event.timeText) : 'unknown',
          station:match.station,stationSource:'platform_event'};
      }
      if (candidate) return candidate;
      if (eventStatus(event.description, 'unknown', rules) === 'signed') return empty;
    }
    return empty;
  }
  function eventStatus(description, fallback, rules) {
    var value = text(description), safe = !UNREALIZED.test(value) && !pickupCycleReset(value);
    if (pickupArrivalEvent(value, '', rules)) return 'arrived';
    if (safe && !FUTURE.test(value) && !/转运|分拣|分拨|物流中心/.test(value) && /(?:存入|已(?:经)?(?:成功)?(?:存放至|到达?|送(?:达|到|至)|派送(?:到|至)|妥投(?:至|到)?|投递(?:至|到)|放(?:在|到|至)?))[^，,。；;！？!?]*(?:驿站|代收点|柜|丰巢)|(?:驿站|代收点|自提柜|快递柜)代收/.test(value)) return 'arrived';
    if (homeDeliveryCompleted(value)) return 'signed';
    if (safe && !FUTURE.test(value) && /待取件|等待取件|待自提|已存放至|存入.*(?:柜|驿站)|请(?:您)?(?:及时|尽快)?(?:取件|领取)|催取|取件提醒|凭取货码/.test(value)) return 'arrived';
    if (/已完成签收|签收成功|已签收/.test(value) && !/签收失败|拒绝?签收|拒签/.test(value)
      && !/(?:未|待|拒绝?|请|等待|当面)[^，,。；;！？!?]{0,8}(?:已完成签收|签收成功|已签收)/.test(value)) return 'signed';
    if (/运输|发货|揽收|派送|派件中/.test(value)) return 'transit';
    return fallback || 'unknown';
  }
  function stringField(value, label, max, required) {
    if (typeof value !== 'string' || value.length > max || (required && !text(value)) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(label + '格式不正确');
    return text(value);
  }
  function normalizeRule(rule) {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule) || Object.keys(rule).some(function (key) { return KEYS.indexOf(key) < 0; })) throw new Error('规则包含不支持的字段；仅支持明文，不支持正则或脚本');
    var id = stringField(rule.id, '规则编号', 80, true);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('规则编号只能包含字母、数字、下划线和短横线');
    if (typeof rule.enabled !== 'boolean' || ['arrival', 'location'].indexOf(rule.kind) < 0) throw new Error('规则类型或启用状态不正确');
    if (!Array.isArray(rule.starts) || !rule.starts.length || rule.starts.length > 20) throw new Error('请填写1至20项前面文字');
    if (!Array.isArray(rule.keywords) || rule.keywords.length > 10) throw new Error('关键词最多10项');
    if (['builtin', 'manual'].indexOf(rule.origin) < 0) throw new Error('规则来源不正确');
    function phrases(values, label) { return values.map(function (value) {
      var phrase = stringField(value, label, 80, true);
      if (SPLIT.test(phrase)) throw new Error(label + '须位于同一个标点片段内');
      return phrase;
    }); }
    return { id: id, name: stringField(rule.name, '规则名称', 80, true), enabled: rule.enabled, kind: rule.kind,
      starts: phrases(rule.starts, '前面文字'), end: stringField(rule.end, '后面文字', 80, false), keywords: phrases(rule.keywords, '关键词'),
      sample: stringField(rule.sample, '验证样例', 600, false), expectedStation: stringField(rule.expectedStation, '预期站点', 120, false), origin: rule.origin };
  }
  function preview(rule, sample) {
    var value = stringField(sample, '验证样例', 600, false), enabled = {}, key, match = null, parts, i;
    for (key in rule) if (Object.prototype.hasOwnProperty.call(rule, key)) enabled[key] = rule[key];
    enabled.enabled = true;
    var station = pickupStation(value, [enabled]), arrival = pickupArrivalEvent(value, station, [enabled]);
    if (!UNREALIZED.test(value) && !pickupCycleReset(value)) {
      parts = fragments(value);
      for (i = 0; i < parts.length; i++) { match = fragmentMatch(parts[i], [enabled]); if (match && match.ruleId === rule.id) break; match = null; }
    }
    var reason = UNREALIZED.test(value) ? '预计、否定或未完成事件，已排除' : pickupCycleReset(value) ? '退回、改派或离站事件，已排除'
      : !match ? '未命中本条明文模板或不是有效取件站点' : REMINDER.test(value) ? '已识别站点；催取提醒不作为到站时间' : arrival ? '已识别取件站点和到站事件' : '已识别站点位置，不作为到站时间';
    return { station: match ? station : '', arrival: !!match && arrival, status: eventStatus(value, 'unknown', [enabled]), ruleId: match ? match.ruleId : '', reason: reason };
  }
  function validateRule(rule) {
    var normalized = normalizeRule(rule), result;
    if (normalized.enabled) {
      if (!normalized.sample || !normalized.expectedStation) throw new Error('启用规则前请填写验证样例和预期站点');
      result = preview(normalized, normalized.sample);
      if (result.ruleId !== normalized.id || result.station !== normalized.expectedStation || (normalized.kind === 'arrival' && !result.arrival)) throw new Error('验证样例未按本条规则识别预期站点或到站事件');
    }
    return normalized;
  }
  function validateRules(rules) {
    if (!Array.isArray(rules) || rules.length > 100 || JSON.stringify(rules).length > 60000) throw new Error('规则最多100条，总大小不得超过60000字符');
    var ids = Object.create(null), output = rules.map(validateRule);
    output.forEach(function (rule) { if (Object.prototype.hasOwnProperty.call(ids, rule.id)) throw new Error('规则编号不能重复'); ids[rule.id] = true; });
    return output;
  }
  return { defaults: defaults, validateRule: validateRule, validateRules: validateRules, pickupStation: pickupStation, pickupArrivalEvent: pickupArrivalEvent,
    pickupEvidence: pickupEvidence, doorstepEvidence: doorstepEvidence, eventTimeIssue: eventTimeIssue, catalogStation: catalogStation, catalogPickupEvidence: catalogPickupEvidence, eventStatus: eventStatus, homeDeliveryCompleted: homeDeliveryCompleted, genericPickupStation: genericPickupStation,
    pickupCycleReset: pickupCycleReset, test: function (rule, sample) {
      var draft = {}, key;
      if (rule && typeof rule === 'object' && !Array.isArray(rule)) {
        for (key in rule) if (Object.prototype.hasOwnProperty.call(rule, key)) draft[key] = rule[key];
        if (!draft.id) draft.id = 'preview';
      } else draft = rule;
      return preview(normalizeRule(draft), sample);
    } };
}());
if (typeof globalThis !== 'undefined') globalThis.PickCodeLogistics = PickCodeLogistics;
