/* Trusted, dependency-free ES5 domain engine. The identical file runs in browser and Android Rhino. */
var PickCodeCore = (function () {
  'use strict';
  var logistics = typeof PickCodeLogistics !== 'undefined' ? PickCodeLogistics : globalThis.PickCodeLogistics;
  var stationRecognitionCache={};
  var snapshotIndex=null;
  function text(value, max) { return typeof value === 'string' ? value.slice(0, max || 4096) : ''; }
  function productImageUrl(value) {
    if (typeof value !== 'string' || value.length > 2048) return '';
    var url = value.trim();
    if (/[\s\u0000-\u001f\u007f\\]/.test(url)) return '';
    var match = /^(?:https?:)?\/\/((?:[a-z0-9]+(?:-[a-z0-9]+)*\.)*(?:alicdn\.com|360buyimg\.com|pddpic\.com)|img\.yangkeduo\.com)(?::443)?(\/[^#]*)?(?:#.*)?$/i.exec(url);
    return match ? 'https://' + match[1].toLowerCase() + (match[2] || '/') : '';
  }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function fail(message) { throw new Error(message); }
  function normalize(value) { return text(value).replace(/[－—–]/g, '-').replace(/\r\n/g, '\n'); }
  function pad(value) { return value < 10 ? '0' + value : '' + value; }
  function time(value) { var d = new Date(value); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function timestamp(value) {
    if (typeof value === 'number') return isFinite(value) && value > 0 ? value : 0;
    if (typeof value !== 'string') return 0;
    if (/^\d{13}$/.test(value)) return Number(value);
    // V8 and Rhino parse locale/space-separated dates differently. Interpret legacy local timestamps explicitly.
    var m = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(value.trim());
    if (m) {
      var d = new Date(Number(m[1]),Number(m[2])-1,Number(m[3]),Number(m[4]||0),Number(m[5]||0),Number(m[6]||0));
      return d.getFullYear()===Number(m[1]) && d.getMonth()===Number(m[2])-1 && d.getDate()===Number(m[3]) ? d.getTime() : 0;
    }
    var parsed = new Date(value).getTime(); return isFinite(parsed) && parsed > 0 ? parsed : 0;
  }
  function hash(value) { var a = 5381, b = 0, i; for (i = 0; i < value.length; i++) { a = ((a << 5) + a) ^ value.charCodeAt(i); b = value.charCodeAt(i) + (b << 6) + (b << 16) - b; } return (a >>> 0).toString(36) + (b >>> 0).toString(36); }
  function validCode(code) {
    return /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(code) && /\d/.test(code) && code.length >= 3 && code.length <= 12 && !/^\d{9,}$/.test(code) && !/^(?:JT|YT|SF|JD|ZTO|STO|YTO)\d{8,}$/i.test(code);
  }
  function delimit(start, end) { return { start: start || '', end: end || '' }; }
  function makeRule(id, name, signature, start, end, addressStart, addressEnd, keywords, kind, priority, sample) {
    return { id: id, name: name, enabled: true, signature: signature, keywords: keywords || [], kind: kind || 'pickup', priority: priority || 50, rules: { code: delimit(start, end), express: delimit('', ''), address: delimit(addressStart, addressEnd) }, smsContent: sample || '', expectedCode: '', origin: 'builtin', createTime: '2026-10-30' };
  }
  function builtins() {
    return [
      makeRule('builtin-cainiao', '菜鸟驿站', '菜鸟驿站', '取件码', '', '在', '，', [], 'pickup', 80, '【菜鸟驿站】您有2个包裹在示例小区驿站，取件码7-6-7042查看全部取件码'),
      makeRule('builtin-tuxi', '兔喜生活 · 取件码', '兔喜生活', '取件码', '', '到达', '，', [], 'pickup', 80, '【兔喜生活】您有包裹已到达示例小区兔喜快递柜，取件码为357591'),
      makeRule('builtin-tuxi-legacy', '兔喜生活 · 凭码来取', '兔喜生活', '凭', '来', '已到', '，', [], 'pickup', 70, '【兔喜生活】您的中通快递包裹已到示例驿站，凭Y17-123来取'),
      makeRule('builtin-diguanjia', '递管家', '递管家', '取件码', '', '已到', '，', [], 'pickup', 70, '【递管家】您的邮政包裹已到示例小区，请凭取件码25363454到1号快递柜取件'),
      makeRule('builtin-hivebox', '丰巢', '丰巢', '取件码', '', '已到', '，', [], 'pickup', 70, '【丰巢】您的快递已到示例快递柜，取件码123456'),
      makeRule('builtin-code', '通用 · 明确取件码', '', '取件码', '', '', '', ['取件码'], 'pickup', 10),
      makeRule('builtin-goods', '通用 · 取货码', '', '取货码', '', '', '', ['取货码'], 'pickup', 10),
      makeRule('builtin-delivery', '通用 · 提货码', '', '提货码', '', '', '', ['提货码'], 'pickup', 10),
      makeRule('builtin-arrival', '到站通知 · 凭手机号或运单号', '', '', '', '已到', '，', ['请凭手机号或运单号取件'], 'arrival', 100),
      makeRule('builtin-reminder', '催取提醒 · 超期未取', '', '', '', '', '', ['未取', '已取请忽略'], 'reminder', 100)
    ];
  }
  function validateRule(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('模板格式无效');
    var name = text(input.name, 60).trim(), signature = text(input.signature, 40).trim();
    if (!name) fail('请输入规则名称');
    var kind = input.kind || 'pickup';
    if (['pickup', 'arrival', 'reminder'].indexOf(kind) < 0) fail('模板类型无效');
    var fields = {}, keys = ['code', 'express', 'address'];
    keys.forEach(function (key) {
      var field = input.rules && input.rules[key] || {};
      if (field.pattern || field.regex || field.script || field.flags) fail('仅支持前后文字模板');
      fields[key] = delimit(text(field.start, 80).trim(), text(field.end, 80).trim());
      if (!fields[key].start && fields[key].end) fail('结束文字需要对应的起始文字');
    });
    if (kind === 'pickup' && !fields.code.start) fail('请设置取件码起始文字');
    var keywords = (Array.isArray(input.keywords) ? input.keywords : []).slice(0, 8).map(function (x) { return text(x, 40).trim(); }).filter(Boolean);
    if (kind !== 'pickup' && !signature && !keywords.length) fail('提醒模板需要短信签名或关键词');
    return { id: text(input.id, 100), name: name, enabled: input.enabled !== false, priority: Math.max(0, Math.min(1000, Number(input.priority) || 50)), signature: signature.replace(/^【|】$/g, ''), keywords: keywords, kind: kind, rules: fields, smsContent: text(input.smsContent), expectedCode: text(input.expectedCode, 30), origin: ['builtin','manual','deepseek','ai'].indexOf(input.origin) >= 0 ? input.origin : 'manual', createTime: text(input.createTime, 40) };
  }
  function extract(body, field, isCode) {
    if (!field || !field.start) return '';
    var start = body.indexOf(field.start);
    if (start < 0) return '';
    var remaining = body.slice(start + field.start.length), end = field.end ? remaining.indexOf(field.end) : -1;
    if (field.end && end < 0) return '';
    if (end >= 0) remaining = remaining.slice(0, end);
    if (isCode) {
      var match = /^\s*(?:为|是)?\s*[:：]?\s*([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)/.exec(remaining);
      return match && validCode(match[1]) ? match[1] : '';
    }
    return remaining.trim().slice(0, 120);
  }
  function parse(body, rules, allowFallback) {
    body = normalize(body);
    if (!body || body.length > 4096 || /验证码|动态密码|登录密码|支付密码/.test(body)) return null;
    var signatureMatch = /(?:【([^】]+)】|\[([^\]]+)\])/.exec(body), signature = signatureMatch ? (signatureMatch[1] || signatureMatch[2]) : '';
    var sorted = (rules || builtins()).filter(function (r) { return r.enabled !== false; }).slice().sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
    for (var i = 0; i < sorted.length; i++) {
      var r;
      try { r = validateRule(sorted[i]); } catch (_) { continue; }
      if (r.signature && r.signature !== signature) continue;
      if (r.keywords.some(function (k) { return body.indexOf(k) < 0; })) continue;
      // No-code reminders never swallow a valid explicit pickup code.
      if (r.kind !== 'pickup' && /(?:取件码|取货码|提货码)\s*(?:为|是)?\s*[:：]?\s*[A-Za-z0-9]/.test(body)) continue;
      var code = r.kind === 'pickup' ? extract(body, r.rules.code, true) : '';
      if (r.kind === 'pickup' && !code) continue;
      var company = extract(body, r.rules.express, false);
      if (!company) { var companyMatch = /(?:您的?|的)(中通快递|中通|圆通速递|圆通|申通快递|申通|韵达快递|韵达|极兔速递|极兔|顺丰速运|顺丰|邮政|京东)/.exec(body); company = companyMatch ? companyMatch[1] : signature; }
      var count = /(?:有|共)(\d+)个包裹/.exec(body);
      return { kind: r.kind, code: code, express: company, address: extract(body, r.rules.address, false), ruleId: r.id, packageCount: count ? Number(count[1]) : 1 };
    }
    // Conservative no-code arrival/reminder fallback; address and waybill digits are not codes.
    var fallbackKind = /未取|催取|超\d+天/.test(body) ? 'reminder' : 'arrival';
    if (allowFallback !== false && sorted.some(function(r){return r.id==='builtin-'+fallbackKind;}) && /快递|速递|驿站|包裹|快递柜/.test(body) && /已到|到达|未取|待取/.test(body)) return { kind: fallbackKind, code: '', express: signature, address: '', ruleId: 'arrival-fallback', packageCount: 1 };
    return null;
  }
  function validateCandidate(candidate, sample, expectedCode) {
    if (candidate && candidate.rule) candidate = candidate.rule;
    if (!candidate || candidate.script || candidate.regex || candidate.code || candidate.javascript) fail('AI 返回了不支持的模板格式');
    var rule = validateRule(candidate);
    rule.enabled = true; rule.origin = 'deepseek'; rule.priority = 100; rule.smsContent = text(sample); rule.expectedCode = text(expectedCode).trim(); rule.id = '';
    if (!rule.signature && !rule.keywords.length) fail('生成模板缺少适用范围，请重新生成');
    var result = parse(sample, [rule], false);
    if (!result || (rule.kind === 'pickup' && (!validCode(rule.expectedCode) || result.code !== rule.expectedCode)) || (rule.kind !== 'pickup' && rule.expectedCode)) fail('生成结果与正确取件码不一致，未保存');
    return rule;
  }
  function initial() { return { version: 1, sequence: 0, items: [], sources: [], rules: builtins(), settings: { autoScan: false, widgetPrivacy: false, stationEnhancement: false }, lastScanAt: 0, summary: { added: 0, reminders: 0, ignored: 0 }, migrated: false }; }
  function byId(list, id) {
    var index=snapshotIndex&&(list===snapshotIndex.state.orders?snapshotIndex.orders:list===snapshotIndex.state.shipments?snapshotIndex.shipments:null);
    return index&&typeof id==='string'?index[id]:list.filter(function (x) { return x.id === id; })[0];
  }
  function snapshotLookups(state) {
    function ids(list){var result=Object.create(null);list.forEach(function(x){if(typeof x.id==='string'&&!result[x.id])result[x.id]=x;});return result;}
    var index={state:state,orders:ids(state.orders),shipments:ids(state.shipments),groups:Object.create(null),codes:Object.create(null)};
    state.items.forEach(function(item){if(!item.mergedInto)item.members.forEach(function(member){if(!member.closedCycleId&&typeof member.shipmentId==='string'&&!index.groups[member.shipmentId])index.groups[member.shipmentId]=item;});});
    return index;
  }
  function unique(list) { return list.filter(function (x, i) { return x && list.indexOf(x) === i; }); }
  function locationNumbers(value) {
    var digits={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
    return value.replace(/[零〇一二两三四五六七八九十]+(?=卡|号(?:柜|快递柜|自提柜|楼|门)|栋|幢)/g,function(s){
      if(s.indexOf('十')>=0){var p=s.split('十');return String((p[0]?digits[p[0]]:1)*10+(p[1]?digits[p[1]]:0));}
      return s.split('').map(function(c){return digits[c];}).join('');
    });
  }
  function stationKey(value) { return locationNumbers(normalize(text(value,200))).replace(/[\s，,。()（）]/g,''); }
  function carrierKey(value) { return text(value,100).replace(/速递|快递|速运|物流/g,'').replace(/YTO|圆通速递/ig,'圆通').replace(/ZTO/ig,'中通').replace(/STO/ig,'申通').replace(/JT/ig,'极兔').replace(/SF/ig,'顺丰').replace(/JD/ig,'京东'); }
  function sourceWaybill(body) { var m=/(?:JT|YT|SF|JD|ZTO|STO)\d{8,}|(?:运单号|快递单号|单号)\s*[:：]?\s*([A-Za-z0-9]{10,30})/i.exec(body); return m ? (m[1]||m[0]).toUpperCase() : ''; }
  function samePlace(state,a,b) { return stationMatch(state,a,b)==='same'; }
  function matchStationKey(value) {
    var key=stationKey(value).replace(/[【】\[\]·:：。；;]/g,'');
    return key.length>=2&&!/^(?:未知地址|手动添加|快递站|站点|地址|门口|菜鸟驿站|兔喜生活|菜鸟|丰巢|驿站|快递柜|自提柜|代收点)$/.test(key)?key:'';
  }
  function stationLocation(value) {
    var key=stationKey(value),cabinet=/(\d+)号?(?:快递柜|自提柜|柜)/.exec(key),gate=/(东|西|南|北)(?:大)?门/.exec(key),card=/(\d+)卡/.exec(key),building=/(\d+)(?:号楼|栋|幢)/.exec(key);
    return {cabinet:cabinet?cabinet[1]:'',gate:gate?gate[1]+'门':'',card:card?card[1]:'',building:building?building[1]:''};
  }
  function locationConflict(a,b) { return ['cabinet','gate','card','building'].some(function(key){return a[key]&&b[key]&&a[key]!==b[key];}); }
  function recognizeStation(state,value) {
    var cacheKey='$'+text(value,200);if(stationRecognitionCache[cacheKey])return stationRecognitionCache[cacheKey];
    var key=matchStationKey(value),found=[],location=stationLocation(value);
    if(key)(state.stationRules||[]).forEach(function(rule){
      if(!rule.enabled)return;
      var names=[{name:rule.name,subLocation:''}].concat(rule.aliases||[]),matching=names.filter(function(alias){return matchStationKey(alias.name)===key;});
      if(matching.length){var alias=matching[0],extra=stationLocation(alias.subLocation);found.push({id:rule.id,name:rule.name,region:rule.region,subLocation:alias.subLocation||'',ruleSubLocation:alias.subLocation||'',location:{cabinet:location.cabinet||extra.cabinet,gate:location.gate||extra.gate,card:location.card||extra.card,building:location.building||extra.building}});}
    });
    var result=found.length===1?found[0]:{id:'',name:'',region:'',subLocation:'',location:location};
    result.key=key;result.ambiguous=found.length>1;
    result.subLocation=result.subLocation.replace(/[0-9０-９零〇一二两三四五六七八九十]+\s*卡/g,'').replace(/\s+/g,' ').trim()||[location.gate,location.building?location.building+'栋':'',location.cabinet?location.cabinet+'号柜':''].filter(Boolean).join(' ');
    stationRecognitionCache[cacheKey]=result;return result;
  }
  function stationMatch(state,a,b) {
    var x=recognizeStation(state,a),y=recognizeStation(state,b);
    if(locationConflict(x.location,y.location))return 'different';
    var left=cabinetDisplay([a,x.ruleSubLocation]),right=cabinetDisplay([b,y.ruleSubLocation]);
    if(left.pickupCabinetConflict||right.pickupCabinetConflict||left.pickupCabinet&&right.pickupCabinet&&left.pickupCabinet!==right.pickupCabinet)return 'different';
    if(x.ambiguous||y.ambiguous)return 'review';
    if(x.id&&y.id)return x.id===y.id?'same':'different';
    return !x.key||!y.key?'unknown':x.key===y.key?'same':'different';
  }
  function cabinetLocations(value) {
    var normalized=normalize(text(value,400)),found=[],match,pattern=/((?:[A-Za-z]{1,3}区|[0-9]{1,2}区)?(?:[A-Za-z]{1,3}|[0-9]{1,4}|[零〇一二两三四五六七八九十]{1,3}))\s*号?\s*(?:快递柜|自提柜|柜)/g;
    while((match=pattern.exec(normalized))){
      if(match.index&&/[A-Za-z0-9]/.test(normalized.charAt(match.index-1)))continue;
      var identifier=match[1].replace(/\s/g,'').toUpperCase(),label=/^[A-Z]{1,3}$/.test(identifier)?identifier+'柜':locationNumbers(identifier+'号柜');
      if(found.indexOf(label)<0)found.push(label);
    }
    return found;
  }
  function cabinetDisplay(values) {
    var found=[];(values||[]).forEach(function(value){cabinetLocations(value).forEach(function(label){if(found.indexOf(label)<0)found.push(label);});});
    return {pickupCabinet:found.length===1?found[0]:'',pickupCabinetConflict:found.length>1};
  }
  function publicStation(state,value) {
    var r=recognizeStation(state,value),cabinet=cabinetDisplay([value,r.ruleSubLocation||'']);
    return {stationCanonical:r.name,stationCanonicalId:r.id,stationSubLocation:r.subLocation,stationDisplayName:r.name||text(value,200),pickupCabinet:cabinet.pickupCabinet,pickupCabinetConflict:cabinet.pickupCabinetConflict};
  }
  function stationReviewRelated(a,b) {
    if(locationConflict(stationLocation(a),stationLocation(b)))return false;
    var x=matchStationKey(a).replace(/兔喜|生活|服务站|快递|门店|店/g,''),y=matchStationKey(b).replace(/兔喜|生活|服务站|快递|门店|店/g,'');
    if(x.length<4||y.length<4)return false;
    for(var i=0;i<=x.length-4;i++){var part=x.slice(i,i+4);if(y.indexOf(part)>=0&&!/市|区|镇|街|路|大道|社区/.test(part))return true;}
    return false;
  }
  function stationRules(values) {
    if(!Array.isArray(values)||values.length>1000)fail('站点规则格式无效');
    var ids=[];
    return values.map(function(rule){
      if(!rule||typeof rule.id!=='string'||!rule.id||rule.id.length>100||ids.indexOf(rule.id)>=0||!text(rule.name,120).trim()||!Array.isArray(rule.aliases)||rule.aliases.length>200||rule.enabled!==undefined&&typeof rule.enabled!=='boolean')fail('站点规则格式无效');
      ids.push(rule.id);
      return {id:text(rule.id,100),name:text(rule.name,120).trim(),region:text(rule.region,120),enabled:rule.enabled!==false,revision:Number(rule.revision)||0,aliases:rule.aliases.map(function(alias){if(!alias||!text(alias.name,120).trim())fail('站点别名格式无效');return {id:text(alias.id,100),name:text(alias.name,120).trim(),source:text(alias.source,40),subLocation:text(alias.subLocation,120)};})};
    });
  }
  function serverLogisticsRules(values) {
    var fields=['id','name','enabled','kind','starts','end','keywords','origin'];
    if(!Array.isArray(values)||values.length>100||JSON.stringify(values).length>60000)fail('后台物流规则格式无效');
    var enabled=values.map(function(value){
      if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.enabled!=='boolean'||Object.keys(value).some(function(key){return fields.indexOf(key)<0;}))fail('后台物流规则格式无效');
      return value.enabled;
    });
    // Validate declarative fields without importing private administrator samples. Actual events still pass all parser guards.
    return logistics.validateRules(values.map(function(value){var rule=clone(value);rule.enabled=false;rule.sample='';rule.expectedStation='';return rule;}))
      .map(function(rule,index){rule.enabled=enabled[index];return rule;});
  }
  function sourceLinks(state,source) { return unique(state.pickupBindings.filter(function(b){var ship=byId(state.shipments,b.shipmentId);return b.sourceId===source.id&&ship&&ship.pickupCycle&&b.cycleId===ship.pickupCycle.id&&(b.status==='confirmed'||b.status==='review_required');}).map(function(b){return b.shipmentId;})); }
  function ensurePickupCycle(state,ship) {
    if(!ship.pickupCycle)ship.pickupCycle={id:newId(state,'cycle-'),startedAt:ship.arrivalAt||ship.smsArrivalAt||0,status:'active',evidenceKey:'legacy'};
    ship.pickupCycleHistory=ship.pickupCycleHistory||[];
    return ship.pickupCycle;
  }
  function bindingStatus(binding,status,reason) {
    if(binding.status===status&&binding.reason===reason)return;
    binding.history=binding.history||[];
    if(binding.status)binding.history.push({status:binding.status,reason:binding.reason||'',version:binding.version||0,changedAt:binding.changedAt||0});
    binding.status=status;binding.reason=reason;binding.version=(binding.version||0)+1;binding.changedAt=Date.now();
  }
  function confirmPickupBinding(state,source,ship,manual) {
    if(manual)delete source.retiredCycleShipmentId;
    var cycle=ensurePickupCycle(state,ship),binding=state.pickupBindings.filter(function(b){return b.sourceId===source.id&&b.shipmentId===ship.id&&b.cycleId===cycle.id;})[0];
    if(!binding){binding={id:newId(state,'binding-'),sourceId:source.id,shipmentId:ship.id,cycleId:cycle.id,pieceIndex:sourceLinks(state,source).length+1,method:manual?'manual':'automatic',evidence:source.matchBasis||'source_match',createdAt:Date.now()};state.pickupBindings.push(binding);}
    if(manual)binding.method='manual';
    if(manual||!binding.status)bindingStatus(binding,'confirmed',manual?'user_confirmed':'unique_evidence');
    projectSourceBindings(state,source);
  }
  function projectSourceBindings(state,source) {
    var links=sourceLinks(state,source),rows=state.pickupBindings.filter(function(b){return b.sourceId===source.id&&links.indexOf(b.shipmentId)>=0&&(b.status==='confirmed'||b.status==='review_required');});
    source.linkedShipmentIds=links;source.linkedShipmentId=links[0]||'';
    if(rows.length){source.manualLinked=rows.every(function(b){return b.method==='manual';});source.manualUnlinked=false;source.matchNeedsReview=rows.some(function(b){return b.status==='review_required';});}
  }
  function migratePickupBindings(state) {
    state.pickupBindings=state.pickupBindings||[];
    state.shipments.forEach(function(ship){ensurePickupCycle(state,ship);});
    state.operations.forEach(function(op){if(!op.localCycleId&&['pick','restore','resumeAutoPickup'].indexOf(op.action)>=0){var ship=state.shipments.filter(function(ship){return ship.remoteId===op.shipmentId&&ship.serviceKey===op.serviceKey;})[0];if(ship)op.localCycleId=ship.pickupCycle.id;}});
    if(state.pickupBindingsVersion===1){state.sources.forEach(function(source){projectSourceBindings(state,source);});return;}
    state.sources.forEach(function(source){
      var ids=unique((Array.isArray(source.linkedShipmentIds)?source.linkedShipmentIds:[]).concat(source.linkedShipmentId||[])),manual=!!source.manualLinked,review=!!source.matchNeedsReview;
      ids.forEach(function(id){var ship=byId(state.shipments,id);if(!ship)return;confirmPickupBinding(state,source,ship,manual);if(review)state.pickupBindings.filter(function(b){return b.sourceId===source.id&&b.shipmentId===id;}).forEach(function(b){bindingStatus(b,'review_required','legacy_review');});});
    });
    state.pickupBindingsVersion=1;
    state.sources.forEach(function(source){projectSourceBindings(state,source);});
  }
  function sourceItem(state,source) { return state.items.filter(function(i){return !i.mergedInto&&!i.deleted&&i.sourceIds.indexOf(source.id)>=0;})[0]; }
  function sourceParsed(state,source) { var p=source.parsed||parse(source.body,state.rules);return p||{}; }
  function rawSourceStation(state,source) {
    var parsed=sourceParsed(state,source);if(parsed.address)return parsed.address;
    var m=/(?:已到达|已到|存放至|存入|包裹在|快递在)([^，,。；;！!]{2,100})/.exec(source.body||'');
    return m?m[1].split(/(?:请凭|凭取|取件码|取货码)/)[0].trim():'';
  }
  function sourceStation(state,source) { var correction=activeCorrection(state,source);return correction?correction.stationName:rawSourceStation(state,source); }
  function stationFragment(value) {
    var fragment=text(value,400).replace(/https?:\/\/\S+|www\.\S+/ig,'').replace(/(?:取件码|取货码|提货码|运单号|订单号|快递单号|手机号|电话|联系)\s*(?:为|是)?\s*[:：]?\s*[A-Za-z0-9*+\- ]+/g,'')
      .replace(/(?:JT|YT|SF|JD|ZTO|STO)\d{8,}|[A-Za-z]*\d{9,}[A-Za-z0-9]*|\d{3,}(?:-\d+)+/ig,'')
      .replace(/[^，,。；;！!]*?(?:先生|女士|同学|收件人|收货人)[:：]?/g,'').replace(/【[^】]*】|\[[^\]]*\]/g,'').trim();
    fragment=fragment.split(/(?:请凭|凭取|取件码|取货码|提货码|联系电话|客服电话|请及时|请尽快|取件时间|营业时间)/)[0].trim();
    var end=/(?:快递柜|自提柜|驿站|代收点|便利店|服务站|超市|门店|[东西南北]门(?:口)?|\d+号柜|店|小区|广场|花园|公寓|大厦)(?!.*(?:快递柜|自提柜|驿站|代收点|便利店|服务站|超市|门店|[东西南北]门|\d+号柜|店|小区|广场|花园|公寓|大厦))/.exec(fragment);
    if(!end)return '';
    fragment=fragment.slice(0,end.index+end[0].length).replace(/^[\s:：·（(]+|[\s）)]+$/g,'');
    if(fragment.length<2||fragment.length>120||/\d{6,}|验证码|密码|订单|运单|姓名|收件人|手机|电话|优惠|退订|先生|女士|尊敬|您好/.test(fragment)||!matchStationKey(fragment))return '';
    return fragment;
  }
  function suspectStation(body,parsedAddress) {
    if(!/快递|速递|包裹|驿站|快递柜|自提柜/.test(body)||!/取件|取货|待取|领取|来取|已到|到达|存入|存放|放置/.test(body)||/验证码|动态密码|登录密码|支付密码|银行|贷款|理财|信用卡|促销|退订|优惠券|中奖|秒杀|限时活动/.test(body))return '';
    var station=stationFragment(parsedAddress||'');if(station)return station;
    var m=/(?:已到达|已到|已放置在|放置在|存放至|存入|包裹在|快递在|已送至|请到)([^，,。；;！!]{2,160})/.exec(body);
    return m?stationFragment(m[1]):'';
  }
  function candidateActive(state,candidate) {
    if(!candidate||!candidate.date||candidate.date<Date.now()-7*86400000)return false;
    if(!candidate.sourceIds||!candidate.sourceIds.length)return true;
    return candidate.sourceIds.some(function(id){var source=sourceFor(state,id),item=source&&sourceItem(state,source);return source&&!source.deleted&&!source.ignored&&!(item&&item.isPicked);});
  }
  function sourceStationConflict(state,source) {
    // Reuse current recommendation windows; a known SMS alias can still need review against an unknown platform station.
    if(sourceRecommendations(state,source).some(function(candidate){return candidate.decisionReason==='station_unconfirmed';}))return true;
    var parsed=sourceParsed(state,source),times=sourceTimes(source);
    return state.shipments.some(function(shipment){return !matchLinkReason(state,shipment,source,true)&&stationMatch(state,sourceStation(state,source),shipment.station)==='different'&&
      (closeArrival(shipment,times.sent||times.received)||!!times.sent&&closeArrival(shipment,times.received)||parsed.code&&shipment.pickupCode===parsed.code&&near(source.date,shipment.arrivalAt));});
  }
  function queueStationCandidate(state,body,address,sourceId,date) {
    if(!state.settings.stationEnhancement)return;
    var name=suspectStation(body,address);if(!name)return;
    var recognition=recognizeStation(state,name),source=sourceId&&sourceFor(state,sourceId);
    if(recognition.id&&!(source&&sourceStationConflict(state,source)))return;
    var id='station-'+hash(name),queue=state.stationEnhancement;
    if(queue.sentIds.indexOf(id)>=0)return;
    var existing=byId(queue.pending,id);
    if(existing){if(sourceId)existing.sourceIds=unique(existing.sourceIds.concat(sourceId));return;}
    queue.pending.push({id:id,stationName:name,fragment:name,source:'sms',sourceIds:sourceId?[sourceId]:[],date:date});
    if(queue.pending.length>200)queue.pending=queue.pending.slice(-200);
  }
  function refreshStationCandidates(state) {
    var queue=state.stationEnhancement;
    queue.pending=queue.pending.filter(function(candidate){return candidateActive(state,candidate)&&(!recognizeStation(state,candidate.stationName).id||(candidate.sourceIds||[]).some(function(id){var source=sourceFor(state,id);return source&&sourceStationConflict(state,source);}));});
    if(!state.settings.stationEnhancement)return;
    state.sources.forEach(function(source){if(source.deleted||source.ignored)return;var item=sourceItem(state,source);if(item&&item.isPicked)return;queueStationCandidate(state,source.body,sourceStation(state,source),source.id,source.date);});
  }
  function stationCandidateBatch(state) {
    refreshStationCandidates(state);
    var items=state.settings.stationEnhancement&&state.online.bound?state.stationEnhancement.pending.slice(0,20).map(function(candidate){return {id:candidate.id,stationName:candidate.stationName,fragment:candidate.fragment,source:'sms'};}):[];
    return {items:items};
  }
  // Human decisions are local overrides. Original SMS and platform evidence remain intact.
  function feedbackBinding(state) { return state.online.bound?(state.online.serviceKey||'')+'|'+state.online.deviceId:''; }
  function activeCorrection(state,entity) { var c=entity&&entity.stationCorrection;return c&&c.binding===feedbackBinding(state)?c:null; }
  function publicCorrection(state,entity) { var c=activeCorrection(state,entity);return c?{id:c.id,stationId:c.stationId,stationName:c.stationName,originalStation:c.originalStation,changedAt:c.changedAt}:null; }
  function restoreStationProjection(state) {
    state.shipments.forEach(function(s){if(s.automaticStation!==undefined){s.station=s.automaticStation;delete s.automaticStation;}});
    state.items.forEach(function(i){if(i.automaticStation!==undefined){i.address=i.automaticStation;delete i.automaticStation;}});
  }
  function rawStation(entity,key) { return entity.automaticStation!==undefined?entity.automaticStation:entity[key]||''; }
  function applyStationCorrections(state) {
    state.items.forEach(function(i){
      if(i.mergedInto||i.deleted)return;
      var c=activeCorrection(state,i),sources=liveSources(state,i),ships=i.members.map(function(m){return byId(state.shipments,m.shipmentId);}).filter(Boolean),related=c?[c]:[];
      sources.concat(ships).forEach(function(e){var v=activeCorrection(state,e);if(v)related.push(v);});
      related.sort(function(a,b){return b.changedAt-a.changedAt||Number(b.id.replace('correction-',''))-Number(a.id.replace('correction-',''));});c=related[0];
      if(!c)return;
      if(i.automaticStation===undefined)i.automaticStation=activeCorrection(state,i)?i.address||'':sources.length?rawSourceStation(state,sources[0]):ships.length?rawStation(ships[0],'station'):i.address||'';
      i.stationCorrection=clone(c);i.stationCorrection.originalStation=i.automaticStation;i.address=c.stationName;
      // A shared code remains one pickup decision when a later match adds its shipment.
      sources.concat(ships).forEach(function(e){
        if(ships.indexOf(e)>=0&&!boundShipment(state,e))return;
        var existing=activeCorrection(state,e);if(existing&&existing.id===c.id)return;
        var value=clone(c);value.originalStation=sources.indexOf(e)>=0?rawSourceStation(state,e):rawStation(e,'station');e.stationCorrection=value;
      });
    });
    state.shipments.forEach(function(s){var c=activeCorrection(state,s);if(c){if(s.automaticStation===undefined)s.automaticStation=s.station||'';s.station=c.stationName;}});
  }
  function stationChoices(state) {
    return state.stationRules.filter(function(r){return r.enabled;}).map(function(r){var usage=0,last=0;
      state.items.forEach(function(i){if(i.deleted||i.mergedInto)return;var c=activeCorrection(state,i),place=recognizeStation(state,i.address);if(c&&c.stationId===r.id||!c&&place.id===r.id){usage++;last=Math.max(last,c?c.changedAt:i.date||0);}});
      return {id:r.id,name:r.name,usage:usage,lastUsedAt:last};
    }).sort(function(a,b){return b.usage-a.usage||b.lastUsedAt-a.lastUsedAt||(a.name<b.name?-1:1);});
  }
  function feedbackRows(state) { var binding=feedbackBinding(state);return binding?state.matchingFeedback.items.filter(function(row){return row.binding===binding;}):[]; }
  function withdrawFeedback(row,reason) { if(row.action==='withdraw')return;row.action='withdraw';row.revision++;row.status='queued';row.updatedAt=Date.now();row.remoteUpdatedAt=0;row.error='';row.reasonCode=reason||'SOURCE_INVALIDATED'; }
  function correctionEvent(state,id,kind,original,target,local) {
    var event={id:id,kind:kind,originalStation:original||'',stationName:target||'',changedAt:Date.now(),binding:feedbackBinding(state),local:local,feedback:[],submission:state.settings.manualLearning===false?'learning_paused':!feedbackBinding(state)?'not_bound':'eligible'};
    state.correctionEvents.push(event);return event;
  }
  function queueFeedback(state,key,payload,local) {
    if(state.settings.manualLearning===false||!feedbackBinding(state))return;
    var binding=feedbackBinding(state),id='feedback-'+state.clientId+'-'+hash(binding+'|'+key),row=byId(state.matchingFeedback.items,id);
    if(row&&row.action==='upsert'&&JSON.stringify(row.payload)===JSON.stringify(payload)){var repeated=byId(state.correctionEvents,local.correctionId);if(repeated&&!repeated.feedback.some(function(ref){return ref.id===row.id&&ref.revision===row.revision;}))repeated.feedback.push({id:row.id,revision:row.revision});return;}
    if(!row){
      if(feedbackRows(state).length>=500){state.matchingFeedback.lastError='人工学习样本库已满，本次操作已保存，暂未加入学习';return;}
      row={id:id,revision:0,binding:binding};state.matchingFeedback.items.push(row);
    }
    row.revision++;row.action='upsert';row.status='queued';row.payload=payload;row.local=local;row.updatedAt=Date.now();row.remoteUpdatedAt=0;row.error='';
    var event=byId(state.correctionEvents,local.correctionId);if(event)event.feedback.push({id:row.id,revision:row.revision});
  }
  function queueManualMatch(state,source) {
    sourceLinks(state,source).forEach(function(id){var ship=byId(state.shipments,id);if(!ship||!boundShipment(state,ship))return;
      var correction=activeCorrection(state,source)||activeCorrection(state,ship),raw=rawStation(ship,'station'),place=recognizeStation(state,raw),name=stationFragment(rawSourceStation(state,source));
      queueFeedback(state,'match|'+source.id+'|'+id,{kind:'manual_match',shipmentId:ship.remoteId,stationName:name,otherStationName:stationFragment(raw),targetStationId:correction?correction.stationId:place.id||'',subLocation:recognizeStation(state,rawSourceStation(state,source)).subLocation||'',reason:'manual_match'},
        {sourceId:source.id,shipmentId:id,correctionId:source.lastMatchCorrectionId||''});
    });
  }
  function stationTargets(state,p) {
    var ship=p.shipmentId&&byId(state.shipments,p.shipmentId),group=p.pickupId?itemFor(state,p.pickupId):ship&&groupForShipment(state,ship.id);
    if(p.shipmentId&&(!ship||!boundShipment(state,ship)||packageHidden(state,ship)))fail('包裹已变化，请刷新后重试');
    if(group&&!groupVisible(state,group))fail('取件记录已变化，请刷新后重试');
    if(!group&&!ship)fail('请选择需要更换站点的包裹');
    var sources=group?liveSources(state,group):[],ships=group?activeMembers(state,group).map(function(m){return byId(state.shipments,m.shipmentId);}).filter(Boolean):[ship];
    if(ships.some(function(s){return !boundShipment(state,s);}))fail('包裹不在当前授权范围，请重新绑定后操作');
    return {group:group,sources:sources,ships:ships,all:(group?[group]:[]).concat(sources,ships)};
  }
  function changeStation(state,p,reset) {
    var targets=stationTargets(state,p),ids=unique(targets.all.map(function(e){var c=activeCorrection(state,e);return c&&c.id;})),rule=reset?null:byId(state.stationRules,p.stationId);
    if(!reset&&(!rule||!rule.enabled))fail('请选择已启用的常用站点');
    if(reset&&!ids.length)return;
    // Reset every projection of this shared-code decision, including merged/restored SMS cards.
    state.items.concat(state.sources,state.shipments).forEach(function(e){if(e.stationCorrection&&ids.indexOf(e.stationCorrection.id)>=0)delete e.stationCorrection;});
    feedbackRows(state).forEach(function(row){if(row.local&&(ids.indexOf(row.local.correctionId)>=0||row.payload.kind==='manual_match'&&targets.sources.some(function(source){return source.id===row.local.sourceId;})))withdrawFeedback(row);});
    if(reset){
      correctionEvent(state,newId(state,'correction-'),'station_reset','','自动识别',{sourceIds:targets.sources.map(function(s){return s.id;}),shipmentIds:targets.ships.map(function(s){return s.id;})});
      restoreStationProjection(state);
      if(targets.group&&!targets.group.protected){var automatic=targets.sources.length?rawSourceStation(state,targets.sources[0]):targets.ships.length?targets.ships[0].station:'';if(automatic)targets.group.address=automatic;}
      targets.sources.forEach(function(source){if(source.manualLinked)queueManualMatch(state,source);});return;
    }
    var correctionId=newId(state,'correction-'),binding=feedbackBinding(state),changedAt=Date.now();
    correctionEvent(state,correctionId,'station_correction',targets.sources.length?rawSourceStation(state,targets.sources[0]):targets.ships.length?rawStation(targets.ships[0],'station'):'',rule.name,{sourceIds:targets.sources.map(function(s){return s.id;}),shipmentIds:targets.ships.map(function(s){return s.id;})});
    targets.all.forEach(function(e){var original=state.sources.indexOf(e)>=0?rawSourceStation(state,e):rawStation(e,state.shipments.indexOf(e)>=0?'station':'address');
      e.stationCorrection={id:correctionId,stationId:rule.id,stationName:rule.name,originalStation:original,changedAt:changedAt,binding:binding};});
    var evidence=targets.sources.length?targets.sources:targets.ships.length?targets.ships:[targets.group];
    evidence.forEach(function(e){var isSource=state.sources.indexOf(e)>=0,ship=isSource?targets.ships[0]:state.shipments.indexOf(e)>=0?e:null;
      var raw=isSource?rawSourceStation(state,e):rawStation(e,ship?'station':'address');
      queueFeedback(state,'station|'+e.id,{kind:'station_correction',shipmentId:ship&&boundShipment(state,ship)?ship.remoteId:'',stationName:stationFragment(raw),otherStationName:ship?stationFragment(rawStation(ship,'station')):'',targetStationId:rule.id,subLocation:recognizeStation(state,raw).subLocation||'',reason:'station_correction'},
        {sourceId:isSource?e.id:'',shipmentId:ship?ship.id:'',itemId:!isSource&&!ship?e.id:'',correctionId:correctionId});
    });
    targets.sources.forEach(function(source){if(source.manualLinked)queueManualMatch(state,source);});
  }
  function refreshMatchingFeedback(state) {
    feedbackRows(state).forEach(function(row){
      if(row.action==='withdraw')return;
      var local=row.local||{},source=local.sourceId&&sourceFor(state,local.sourceId),ship=local.shipmentId&&byId(state.shipments,local.shipmentId);
      var invalid=local.sourceId&&(!source||source.deleted||source.ignored)||local.shipmentId&&(!ship||!boundShipment(state,ship));
      if(row.payload.kind==='manual_match')invalid=invalid||!source||!source.manualLinked||sourceLinks(state,source).indexOf(local.shipmentId)<0;
      else {var owner=source||ship||byId(state.items,local.itemId),correction=activeCorrection(state,owner);invalid=invalid||source&&local.shipmentId&&!sourceLinks(state,source).length||!correction||correction.id!==local.correctionId||owner.deleted||owner.ignored;}
      if(invalid)withdrawFeedback(row);
    });
  }
  function matchingFeedbackBatch(state) {
    refreshMatchingFeedback(state);
    var rows=feedbackRows(state).filter(function(r){return (r.status==='queued'||r.status==='failed')&&(r.action==='withdraw'||state.settings.manualLearning!==false);});
    rows.sort(function(a,b){return (a.action==='withdraw'?0:1)-(b.action==='withdraw'?0:1)||a.updatedAt-b.updatedAt;});
    return {items:capability(state,'matching_feedback_v1')?rows.slice(0,20).map(function(r){var value=r.action==='withdraw'?{}:clone(r.payload);value.id=r.id;value.revision=r.revision;value.action=r.action;return value;}):[]};
  }
  function importMatchingFeedback(state,value,ack) {
    if(!value||typeof value!=='object')return;
    ['configured','enabled','autoApply'].forEach(function(k){if(typeof value[k]==='boolean')state.matchingFeedback[k]=value[k];});
    var rows=feedbackRows(state),accepted=Array.isArray(value.accepted)?value.accepted:[];
    if(ack)rows.forEach(function(row){if(accepted.some(function(a){return a.id===row.id&&a.revision===row.revision;})){if(row.action==='withdraw')row.status='withdrawn';else if(row.status==='queued'||row.status==='failed')row.status='submitted';row.error='';state.matchingFeedback.lastUploadAt=Date.now();state.matchingFeedback.lastError='';}});
    (Array.isArray(value.items)?value.items:[]).forEach(function(item){var row=byId(rows,item.id);
      if(!row||item.revision!==row.revision||['pending','applied','review','failed','withdrawn'].indexOf(item.status)<0||row.action==='withdraw'&&item.status!=='withdrawn'||timestamp(item.updatedAt)<(row.remoteUpdatedAt||0))return;
      row.remoteUpdatedAt=timestamp(item.updatedAt);row.status=item.status==='pending'?'submitted':item.status;row.error=item.error?'学习结果需核对，请在后台查看原因':'';
      row.reasonCode=text(item.reasonCode,80);row.message=text(item.message,300);row.ruleVersion=Number(item.ruleVersion)||0;row.candidateId=text(item.candidateId,120);
    });
    (ack?(Array.isArray(value.rejected)?value.rejected:[]).concat((Array.isArray(value.items)?value.items:[]).filter(function(item){return item.status==='rejected';})):[]).forEach(function(item){var row=byId(rows,item.id);if(row&&item.revision===row.revision){row.status='failed';row.error='样本暂未被后台接收，将重试；请检查后台配置';}});
  }
  function matchingFeedbackSummary(state) {
    var rows=feedbackRows(state),q=state.matchingFeedback,summary={enabled:state.settings.manualLearning!==false,pendingCount:0,submittedCount:0,appliedCount:0,reviewCount:0,failedCount:0,pendingWithdrawalCount:0,lastUploadAt:q.lastUploadAt||0,lastError:q.lastError||'',waitingReason:'',items:[]};
    rows.forEach(function(row){if(row.action==='withdraw'){if(row.status!=='withdrawn'){summary.pendingCount++;summary.pendingWithdrawalCount++;}return;}
      var key={queued:'pendingCount',submitted:'submittedCount',applied:'appliedCount',review:'reviewCount',failed:'failedCount'}[row.status];if(key)summary[key]++;
    });
    if(!state.online.bound)summary.waitingReason='绑定后台后可自动提交人工学习样本';
    else if(!capability(state,'matching_feedback_v1'))summary.waitingReason='等待后台升级，人工学习样本已保留';
    else if(state.settings.manualLearning===false)summary.waitingReason='人工学习已暂停，已撤回的样本仍会同步';
    else if(q.configured===false)summary.waitingReason='等待后台配置默认 AI 服务';
    else if(q.enabled===false)summary.waitingReason='后台 AI 优化已暂停，样本已保留';
    else if(q.autoApply===false)summary.waitingReason='后台自动应用已关闭，优化结果需管理员确认';
    summary.items=rows.slice().sort(function(a,b){return b.updatedAt-a.updatedAt;}).map(function(r){return {id:r.id,revision:r.revision,status:r.status,label:r.payload.kind==='station_correction'?'站点修正':'人工匹配',error:r.error||'',reasonCode:r.reasonCode||'',message:r.message||'',ruleVersion:r.ruleVersion||0,correctionId:r.local.correctionId||'',attempts:r.attempts||0,lastAttemptAt:r.lastAttemptAt||0};});
    summary.corrections=state.correctionEvents.filter(function(e){return !e.binding||e.binding===feedbackBinding(state);}).slice().reverse().map(function(e){var linked=summary.items.filter(function(r){return r.correctionId===e.id||(e.feedback||[]).some(function(ref){return ref.id===r.id;});}).map(function(r){var value=clone(r),ref=(e.feedback||[]).filter(function(ref){return ref.id===r.id;})[0];if(ref&&ref.revision<r.revision&&r.status!=='withdrawn'&&r.status!=='queued')value.status='superseded';return value;});return {id:e.id,kind:e.kind,originalStation:e.originalStation,stationName:e.stationName,changedAt:e.changedAt,submission:e.submission,items:linked};});
    return summary;
  }
  function recognizedCarrier(value) { var m=/(中通|圆通|申通|韵达|极兔|顺丰|邮政|京东)/.exec(carrierKey(value));return m?m[1]:''; }
  function recognitionEnabled(state) { return state.online.bound&&capability(state,'recognition_workflow_v1'); }
  function recognitionRows(state) { var binding=feedbackBinding(state);return binding?state.recognitionIssues.items.filter(function(row){return row.binding===binding;}):[]; }
  function recognitionRowActive(state,row) {
    var source=sourceFor(state,row.localSourceId);
    return source&&!source.deleted&&!source.ignored&&!source.manualUnlinked&&row.payload.candidateShipmentIds.length>0
      &&row.payload.candidateShipmentIds.every(function(id){return state.shipments.some(function(ship){return ship.remoteId===id&&recognitionShipment(state,ship);});});
  }
  function recognitionShipment(state,shipment) {
    var disposition=shipment&&shipmentDisposition(shipment);
    return boundShipment(state,shipment)&&/^[A-Za-z0-9_-]{1,128}$/.test(shipment.remoteId||'')&&!packageHidden(state,shipment)&&!shipmentArchived(state,shipment)&&!shipment.picked
      &&!deliveredWithoutPickup(state,shipment)&&!(disposition&&['returning','returned'].indexOf(disposition.kind)>=0);
  }
  function recognitionFingerprint(payload,candidates) {
    return hash(JSON.stringify(payload.state==='resolved'?payload:[payload,candidates.map(function(ship){return [ship.remoteId,ship.waybillNo,ship.station,ship.carrier,ship.arrivalAt,ship.arrivalAtSource,ship.arrivalAtPrecision,ship.pickupCode,ship.status];})]));
  }
  function scrubRecognitionSources(state) {
    state.recognitionIssues.items.forEach(function(row){
      var payload=row.payload,source=payload&&payload.source;if(!source||!source.waybillNo&&!source.pickupCode)return;
      var ids=payload.candidateShipmentIds||[],candidates=state.shipments.filter(function(ship){return ids.indexOf(ship.remoteId)>=0;}).sort(function(a,b){return a.remoteId.localeCompare(b.remoteId);});
      // Preserve ACKs and revisions only when the legacy fingerprint still describes the current evidence.
      var unchanged=row.fingerprint===recognitionFingerprint(payload,candidates);
      source.waybillNo='';source.pickupCode='';
      if(unchanged)row.fingerprint=recognitionFingerprint(payload,candidates);
    });
  }
  // Refresh on business mutations only. Rendering a snapshot or retrying an upload is not a recognition attempt.
  function refreshRecognitionIssues(state) {
    if(!recognitionEnabled(state))return;
    var binding=feedbackBinding(state),active=state.shipments.filter(function(ship){return recognitionShipment(state,ship);});
    recognitionRows(state).forEach(function(row){
      var source=sourceFor(state,row.localSourceId);
      if(source&&!source.deleted&&!source.ignored&&!source.manualUnlinked||row.payload.state==='withdrawn')return;
      if(!row.submitted&&!row.acknowledged&&!row.remote){state.recognitionIssues.items=state.recognitionIssues.items.filter(function(value){return value!==row;});return;}
      row.revision++;row.payload={kind:'unmatched_pickup',state:'withdrawn',sourceId:row.payload.sourceId,
        source:{station:'',carrier:'',waybillNo:'',pickupCode:'',occurredAt:null,fragment:''},candidateShipmentIds:[],reasonCodes:['source_withdrawn']};
      row.observedAt=Date.now();row.fingerprint='withdrawn';row.acknowledged=false;delete row.remote;
    });
    state.sources.forEach(function(source){
      var parsed=sourceParsed(state,source),item=sourceItem(state,source),row=recognitionRows(state).filter(function(value){return value.localSourceId===source.id;})[0];
      if(source.deleted||source.ignored||source.manualUnlinked||parsed.kind!=='pickup'||!item||item.isPicked)return;
      var links=sourceLinks(state,source).filter(function(id){return active.some(function(ship){return ship.id===id;});}),resolved=links.length>=Math.max(1,Number(parsed.packageCount)||1)&&!source.matchNeedsReview;
      if(resolved&&!row)return;
      var recommendations=source.matchCandidates||[],ids=unique(recommendations.concat(source.matchConflicts||[]).map(function(value){return value.shipmentId;}));
      var candidates=resolved?active.filter(function(ship){return links.indexOf(ship.id)>=0;}):active.filter(function(ship){return ids.indexOf(ship.id)>=0;});
      // One authorized parcel is useful diagnostic context, never sufficient evidence to link it.
      if(!resolved&&!candidates.length&&active.length===1)candidates=active;
      if(!candidates.length)return;
      candidates=candidates.slice(0,20).sort(function(a,b){return a.remoteId.localeCompare(b.remoteId);});
      var sourceKey=binding+'|'+state.recognitionIssues.epoch+'|'+source.id,sourceId='source-'+hash(state.clientId+'|'+sourceKey),station=state.settings.stationEnhancement?stationFragment(sourceStation(state,source)):'',times=sourceTimes(source);
      var carrier=carrierKey(parsed.express),reasons=resolved?[]:unique(recommendations.filter(function(value){return candidates.some(function(ship){return ship.id===value.shipmentId;});}).map(function(value){return value.decisionReason;}).filter(function(value){return /^[a-z_]{1,80}$/.test(value||'');}));
      if(!resolved&&(source.matchConflicts||[]).length)reasons.push('evidence_conflict');
      if(!resolved&&!reasons.length)reasons.push('insufficient_evidence');
      var payload={kind:'unmatched_pickup',state:resolved?'resolved':'unresolved',sourceId:sourceId,
        source:{station:station,carrier:/^[\u4e00-\u9fffA-Za-z0-9 ·-]{1,40}$/.test(carrier)?carrier:'',waybillNo:'',pickupCode:'',occurredAt:times.sent||times.received||null,fragment:station},
        candidateShipmentIds:unique(candidates.map(function(ship){return ship.remoteId;})),reasonCodes:unique(reasons).slice(0,20)};
      var fingerprint=recognitionFingerprint(payload,candidates);
      if(row&&row.fingerprint===fingerprint)return;
      if(!row){if(recognitionRows(state).length>=500)return;row={id:'recognition-'+state.clientId+'-'+hash(sourceKey),revision:0,binding:binding,localSourceId:source.id};state.recognitionIssues.items.push(row);}
      row.revision++;row.fingerprint=fingerprint;row.payload=payload;row.observedAt=Date.now();row.acknowledged=false;delete row.remote;
    });
  }
  function recognitionIssueBatch(state) {
    var items=[];
    if(recognitionEnabled(state))recognitionRows(state).forEach(function(row){
      if(items.length>=20||row.acknowledged||row.payload.state!=='withdrawn'&&!recognitionRowActive(state,row))return;
      // A prepared request can reach the service before its ACK; later withdrawal must retire that revision too.
      row.submitted=true;var value=clone(row.payload);value.id=row.id;value.revision=row.revision;value.observedAt=row.observedAt;items.push(value);
    });
    return {schemaVersion:1,items:items};
  }
  function importRecognitionIssues(state,value,ack) {
    if(!value)return;
    var items=Array.isArray(value)?value:value.issues;
    if(!Array.isArray(items))return;
    var rows=recognitionRows(state),accepted=Array.isArray(value.accepted)?value.accepted:[];
    rows.forEach(function(row){
      if(ack&&accepted.some(function(item){return item&&item.id===row.id&&item.revision===row.revision;})){row.acknowledged=true;state.recognitionIssues.lastError='';}
      items.forEach(function(item){
        if(!item||item.id!==row.id||item.revision!==row.revision||['pending','retrying','ai_pending','ai_running','review','resolved','failed','ignored','blocked'].indexOf(item.status)<0)return;
        var retry=Number(item.retryCount)||0;if(retry<0||retry>1000||Math.floor(retry)!==retry||row.remote&&retry<row.remote.retryCount)return;
        var premature=item.status==='resolved'&&row.payload.state!=='resolved';
        row.remote={id:row.id,revision:row.revision,status:premature?'review':item.status,retryCount:retry,reasonCode:premature?'LOCAL_MATCH_PENDING':/^[A-Za-z0-9_]{0,80}$/.test(item.reasonCode||'')?item.reasonCode||'':'',nextRetryAt:timestamp(item.nextRetryAt)};
      });
    });
  }
  function recognitionIssueSummary(state,sourceId) {
    return recognitionRows(state).filter(function(row){return (!sourceId||row.localSourceId===sourceId)&&(row.payload.state==='withdrawn'||recognitionRowActive(state,row));}).map(function(row){return row.remote?clone(row.remote):{id:row.id,revision:row.revision,status:row.acknowledged?'pending':'queued',retryCount:0,reasonCode:row.payload.reasonCodes[0]||'',nextRetryAt:0};});
  }
  function matchConflict(state,source,shipment) {
    var wb=sourceWaybill(source.body),p=sourceParsed(state,source),a=recognizedCarrier(p.express),b=recognizedCarrier(shipment.carrier);
    if(wb&&shipment.waybillNo.toUpperCase()!==wb)return '短信运单号与该包裹不同';
    if(a&&b&&a!==b)return '短信快递公司与该包裹不同';
    if(correctionLocationConflict(state,source,shipment))return '短信取件位置与该包裹不同';
    var station=stationMatch(state,sourceStation(state,source),shipment.station);
    if(station==='different')return '短信取件站点与该包裹不同';
    if(station==='review')return '短信取件站点存在规则歧义，请后台核对';
    return '';
  }
  function deliveredWithoutPickup(state,shipment) { return shipment.status==='signed'&&!groupForShipment(state,shipment.id)&&!/驿站|代收点|快递柜|自提柜|丰巢/.test(shipment.station||''); }
  function matchLinkReason(state,shipment,source,ignoreOccupied) {
    if(!boundShipment(state,shipment))return '包裹不在当前授权范围';
    if(packageHidden(state,shipment))return '包裹已隐藏或删除';
    if(shipmentArchived(state,shipment))return '包裹已归档到过期订单，可恢复后匹配';
    if(!text(shipment.waybillNo,60).trim())return '暂无有效运单号，请先刷新物流';
    var disposition=shipmentDisposition(shipment);if(disposition&&['returning','returned'].indexOf(disposition.kind)>=0)return '包裹已进入退货流程';
    var own=source&&sourceLinks(state,source).indexOf(shipment.id)>=0;
    if(shipment.picked&&!own)return '包裹已领取';
    if(deliveredWithoutPickup(state,shipment))return '包裹已送达，无需取件码';
    if(!ignoreOccupied&&state.sources.some(function(s){return s!==source&&!s.ignored&&!s.deleted&&sourceLinks(state,s).indexOf(shipment.id)>=0;}))return '包裹已关联其他取件短信';
    return '';
  }
  function sourceTimes(source) {
    var received=timestamp(source.receivedAt)||source.date,sent=timestamp(source.sentAt);
    return {received:received,sent:sent&&sent<=received+300000?sent:0};
  }
  function trustedArrival(shipment) { return !!shipment.arrivalAt&&['platform_event','locker_arrival'].indexOf(shipment.arrivalAtSource)>=0; }
  function arrivalDelta(shipment,date) {
    if(!date||!shipment.arrivalAt)return null;
    if(shipment.arrivalAtPrecision==='second')return Math.abs(date-shipment.arrivalAt);
    if(shipment.arrivalAtPrecision!=='minute')return null;
    var start=Math.floor(shipment.arrivalAt/60000)*60000;
    return Math.max(start-date,date-(start+59999),0);
  }
  function closeArrival(shipment,date) {
    var delta=arrivalDelta(shipment,date);return delta!==null&&delta<=60000;
  }
  function sameSubLocation(state,a,b) {
    var x=recognizeStation(state,a),y=recognizeStation(state,b),left=cabinetDisplay([a,x.ruleSubLocation]),right=cabinetDisplay([b,y.ruleSubLocation]);
    return !!(left.pickupCabinet&&left.pickupCabinet===right.pickupCabinet||x.ruleSubLocation&&y.ruleSubLocation&&stationKey(x.ruleSubLocation)===stationKey(y.ruleSubLocation));
  }
  function timeMatch(state,source,shipment) {
    if(shipment.pickupCode||(shipment.status!=='arrived'&&sourceLinks(state,source).indexOf(shipment.id)<0)||!trustedArrival(shipment)||matchConflict(state,source,shipment)||matchLinkReason(state,shipment,source,true))return null;
    var times=sourceTimes(source),preferred=times.sent||times.received,address=sourceStation(state,source),station=stationMatch(state,address,shipment.station);
    var primaryDelta=arrivalDelta(shipment,preferred),receivedDelta=times.sent?arrivalDelta(shipment,times.received):null;
    // Weak edges remain in the graph so a stronger candidate cannot hide competition.
    var primary=primaryDelta!==null&&primaryDelta<=1800000,received=receivedDelta!==null&&receivedDelta<=1800000;
    if(!primary&&!received)return null;
    var carrier=recognizedCarrier(sourceParsed(state,source).express),sameCarrier=!!carrier&&carrier===recognizedCarrier(shipment.carrier),subLocation=sameSubLocation(state,address,shipment.station),evidence=['arrival_time'];
    if(station==='same')evidence.push('station');if(sameCarrier)evidence.push('carrier');if(subLocation)evidence.push('sub_location');
    var eligible=primary&&station==='same'&&(primaryDelta<=300000||sameCarrier||subLocation);
    var decision=!primary?'received_time_only':station!=='same'?'station_unconfirmed':eligible?'strong_evidence':'insufficient_evidence';
    var reason=!primary?'仅接收时间相近，需确认发送时间':station!=='same'?'时间相近，站点未确认，需确认包裹':!eligible?'站点一致，时间间隔较长，需确认包裹':primaryDelta<=300000?'站点一致、时间相近':sameCarrier?'站点与快递公司一致、时间相近':'站点与柜机位置一致、时间相近';
    return {shipmentId:shipment.id,kind:station==='same'?'time_station':'time',stationMatch:station,deltaMs:primary?primaryDelta:receivedDelta,primary:primary,received:received,
      evidence:evidence,autoEligible:eligible,decisionReason:decision,timeBasis:primary&&times.sent?'sent':'received',arrivalPrecision:shipment.arrivalAtPrecision,reason:reason};
  }
  function sourceRecommendations(state,source) {
    var strong=sourceCandidates(state,source),times=sourceTimes(source),parsed=sourceParsed(state,source),result=[];
    if(parsed.kind!=='pickup')return result;
    state.shipments.forEach(function(shipment){
      if(matchLinkReason(state,shipment,source))return;
      var arrivalKnown=trustedArrival(shipment),delta=arrivalKnown?Math.abs(shipment.arrivalAt-(times.sent||times.received)):null,withinRecommendationWindow=!arrivalKnown||delta<=48*60*60*1000;
      var conflict=matchConflict(state,source,shipment);
      if(conflict){if(withinRecommendationWindow&&(conflict==='短信取件站点存在规则歧义，请后台核对'||conflict==='短信取件站点与该包裹不同'&&stationReviewRelated(sourceStation(state,source),shipment.station)))result.push({shipmentId:shipment.id,kind:'station',stationMatch:'review',deltaMs:delta,autoEligible:false,decisionReason:'station_unconfirmed',evidence:[],reason:conflict==='短信取件站点存在规则歧义，请后台核对'?'站点规则存在歧义，需后台核对':'站点名称相近，需后台核对'});return;}
      var match=timeMatch(state,source,shipment),known=strong.some(function(s){return s.id===shipment.id;});
      if(known)match={shipmentId:shipment.id,kind:sourceWaybill(source.body)?'waybill':'code',stationMatch:stationMatch(state,sourceStation(state,source),shipment.station),deltaMs:shipment.arrivalAt?Math.abs(shipment.arrivalAt-(times.sent||times.received)):0,reason:sourceWaybill(source.body)?'运单号一致':'取件码与站点一致'};
      if(!match&&withinRecommendationWindow&&stationMatch(state,sourceStation(state,source),shipment.station)==='same')match={shipmentId:shipment.id,kind:'station',stationMatch:'same',deltaMs:delta,autoEligible:false,decisionReason:arrivalKnown?'insufficient_evidence':'arrival_time_unknown',evidence:['station'],reason:arrivalKnown?'站点一致，需确认包裹':'站点一致，时间未知，需确认包裹'};
      if(match)result.push(match);
    });
    var ranks={waybill:0,code:1,time_station:2,time:3,station:4};
    return result.sort(function(a,b){return ranks[a.kind]-ranks[b.kind]||(a.deltaMs==null?Infinity:a.deltaMs)-(b.deltaMs==null?Infinity:b.deltaMs);});
  }
  function groupNeedsMatchReview(state,item) {return liveSources(state,item).some(function(s){return !!s.matchNeedsReview;});}
  function near(a,b) { return a>0 && b>0 && Math.abs(a-b)<=48*60*60*1000; }
  function familyId(value) { return text(value,200).trim(); }
  function familyName(value) { return text(value,100).trim(); }
  function publicIds(values) { return unique((Array.isArray(values)?values:[]).map(familyId)); }
  function authorizationScope(input) {
    var familyScope=input.familyIds!==undefined;
    return {hasFamilyScope:familyScope,familyIds:publicIds(input.familyIds),legacyAccountIds:publicIds(input.legacyAccountIds!==undefined?input.legacyAccountIds:familyScope?[]:input.accountIds!==undefined?input.accountIds:(Array.isArray(input.accounts)?input.accounts:[]).map(function(a){return a&&a.id;}))};
  }
  function canReadRecord(scope,record) {
    return !!(record&&((scope.legacyAccountIds||[]).indexOf(record.accountId)>=0||(record.familyId&&(scope.familyIds||[]).indexOf(record.familyId)>=0)));
  }
  function boundRecord(state,record) { return !!(record&&state.online.bound&&record.serviceKey===state.online.serviceKey&&canReadRecord(state.online,record)); }
  function publicFamilies(families) {
    var seen=[];
    return (Array.isArray(families)?families:[]).slice(0,100).filter(function(f){var id=f&&familyId(f.id);if(!id||seen.indexOf(id)>=0)return false;seen.push(id);return true;}).map(function(f){return {id:familyId(f.id),name:familyName(f.name)||'家人'};});
  }
  function retainFamily(target,input) {
    var id=familyId(input.familyId),name=familyName(input.familyName);
    // Ownership belongs to this historical parcel. Moving an account cannot move its old parcels.
    if(id&&(!target.familyId||target.familyId===id)){target.familyId=id;if(name)target.familyName=name;}
  }
  function publicAccounts(accounts) { return (Array.isArray(accounts)?accounts:[]).slice(0,100).filter(function(a){return a&&typeof a==='object';}).map(function(a){return {id:text(a.id,200),familyId:familyId(a.familyId),familyName:familyId(a.familyId)?familyName(a.familyName):'',platform:text(a.platform,40),label:text(a.label,100),status:text(a.status,40),enabled:a.enabled!==false,lastAttemptAt:timestamp(a.lastAttemptAt),lastSuccessAt:timestamp(a.lastSuccessAt),lastFullSuccessAt:typeof a.lastFullSuccessAt==='number'&&isFinite(a.lastFullSuccessAt)&&a.lastFullSuccessAt>0&&a.lastFullSuccessAt<=9007199254740991&&Math.floor(a.lastFullSuccessAt)===a.lastFullSuccessAt?a.lastFullSuccessAt:0,warnings:Array.isArray(a.warnings)&&a.warnings.length?['部分订单信息未获取完整，可单独重新获取']:[],error:a.error?(a.status==='expired'?'账号登录已失效，请在后台更新':'账号同步失败，请在后台检查'):''};}); }
  function detailNotice(kind,state,error) {
    var label=kind==='date'?'下单日期':'物流';
    if(['empty','unavailable','unknown'].indexOf(state)>=0)return '平台暂未提供可用'+label;
    if(state==='error'||error)return kind==='date'?'部分下单日期未更新，已保留原日期':'部分物流未更新，已保留历史轨迹';
    return '';
  }
  function pendingJob(job) {return job.state==='queued'||job.state==='running';}
  function publicJobs(jobs) {
    return (Array.isArray(jobs)?jobs:[]).slice(0,100).filter(function(j){return j&&/^[A-Za-z0-9_-]{1,100}$/.test(j.id)&&['queued','running','completed','error','cooldown','disabled','expired'].indexOf(j.state)>=0;}).map(function(j){
      var pending=pendingJob(j),retryAt=timestamp(j.retryAt),dateState=text(j.dateState,30),logisticsState=text(j.logisticsState,30);
      var dateError=pending?'':detailNotice('date',dateState,j.dateError),logisticsError=pending?'':detailNotice('logistics',logisticsState,j.logisticsError);
      // Older Android clients promoted optional detail warnings to a generic job error.
      var partial=j.state==='completed'&&(dateError||logisticsError);
      var error=pending?'':j.state==='cooldown'?(retryAt>Date.now()?'后台处于采集冷却期，请稍后重新获取':'本次采集未执行，现可重新获取订单'):j.state==='expired'?'账号登录已失效，请在后台更新':j.state==='disabled'?'账号已停用，请在后台启用':j.state==='error'||j.error&&!partial?'采集未完成，请稍后重试或检查后台账号':'';
      var value={id:j.id,accountId:text(j.accountId,200),orderId:text(j.orderId,200),familyId:familyId(j.familyId),state:j.state,retryAt:retryAt,createdAt:timestamp(j.createdAt),updatedAt:timestamp(j.updatedAt),startedAt:timestamp(j.startedAt),finishedAt:timestamp(j.finishedAt),error:error,dateState:dateState,dateError:dateError,logisticsState:logisticsState,logisticsError:logisticsError};
      function count(n){return typeof n==='number'&&isFinite(n)?Math.max(0,Math.min(100000,Math.floor(n))):0;}
      if(j.logisticsProgress&&typeof j.logisticsProgress==='object'&&!Array.isArray(j.logisticsProgress)){
        var progress={};['total','completed','active','attempts','durationMs'].forEach(function(key){progress[key]=count(j.logisticsProgress[key]);});
        progress.completed=Math.min(progress.total,progress.completed);progress.active=Math.min(progress.total-progress.completed,progress.active);value.logisticsProgress=progress;
      }
      if(j.retryCount!==undefined)value.retryCount=count(j.retryCount);
      ['continuation','throttled'].forEach(function(key){if(j[key]!==undefined)value[key]=j[key]===true;});
      return value;
    });
  }
  function recoverOnlineJobs(online) {
    online.jobs=online.jobs.filter(function(job){
      if(job.state!=='cooldown'||!job.retryAt)return true;
      var account=byId(online.accounts||[],job.accountId);
      // A cached "ok" predating this cooldown is not evidence that the rejected request ran.
      return !(account&&account.status==='ok'&&!account.error&&timestamp(account.lastSuccessAt)>=job.retryAt);
    });
    var notices=[];
    online.jobs.forEach(function(job){if(job.state==='completed'){if(job.dateError)notices.push(job.dateError);if(job.logisticsError)notices.push(job.logisticsError);}});
    online.notice=unique(notices).join('；');
    if((!online.errorCode&&!online.error)||online.errorCode==='collection_incomplete'||online.errorCode==='collection_retryable'){
      var failed=online.jobs.filter(function(j){return j.state!=='cooldown'&&j.error;})[0]||online.jobs.filter(function(j){return j.state==='cooldown';})[0];
      online.error=failed?failed.error:'';
      online.errorCode=failed?(failed.state==='cooldown'&&failed.retryAt<=Date.now()?'collection_retryable':'collection_incomplete'):'';
    }
  }
  function mergeSnapshotJobs(state,snap) {
    var scope=authorizationScope(snap);
    function readable(job) {
      var order=job.orderId&&state.orders.filter(function(o){return o.remoteId===job.orderId&&o.accountId===job.accountId&&o.serviceKey===state.online.serviceKey;})[0];
      var account=byId(snap.accounts,job.accountId);
      return canReadRecord(scope,{accountId:job.accountId,familyId:job.familyId||(order&&order.familyId)||(!job.orderId&&account&&account.familyId)||''});
    }
    function sameScope(a,b) {return a.accountId===b.accountId&&a.orderId===b.orderId;}
    function version(job) {return Math.max(job.updatedAt,job.finishedAt,job.startedAt,job.createdAt);}
    // Android 3.1.21 caches omitted timestamps; the server's dated latest scope summary supersedes those jobs.
    function supersedesPending(next,job) {return next.createdAt>job.createdAt&&version(next)>=version(job);}
    var jobs=state.online.jobs.filter(readable);
    if(Array.isArray(snap.syncJobs))publicJobs(snap.syncJobs).filter(readable).forEach(function(next){
      var current=jobs.filter(function(job){return sameScope(job,next);}),same=byId(current,next.id);
      if(same){
        if(version(next)<version(same)||version(next)===version(same)&&!pendingJob(same)&&pendingJob(next))return;
      } else if(current.some(function(job){return pendingJob(job)&&!supersedesPending(next,job);})){return;}
      if(current.some(function(job){return job.id!==next.id&&!pendingJob(job)&&(job.createdAt>next.createdAt||job.createdAt===next.createdAt&&version(job)>version(next));})){
        if(same){jobs=jobs.filter(function(job){return job.id!==same.id;});if(pendingJob(next))jobs.push(next);}
        return;
      }
      jobs=jobs.filter(function(job){return !sameScope(job,next)||pendingJob(job)&&job.id!==next.id&&!supersedesPending(next,job);});
      jobs.push(next);
    });
    if(jobs.length>100)jobs.sort(function(a,b){return Number(pendingJob(b))-Number(pendingJob(a))||b.createdAt-a.createdAt||version(b)-version(a);});
    state.online.jobs=jobs.slice(0,100);
  }
  function dateOnly(value) {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return 0;
    var parts=value.split('-').map(Number),utc=Date.UTC(parts[0],parts[1]-1,parts[2]),d=new Date(utc);
    return parts[0]>=2000&&parts[0]<=2100&&d.getUTCFullYear()===parts[0]&&d.getUTCMonth()===parts[1]-1&&d.getUTCDate()===parts[2]?utc-8*3600000:0;
  }
  // Retention uses the same China calendar day in the phone, widget and service.
  function retentionDate(value) {
    if(dateOnly(value))return value;
    var at=timestamp(value);if(!at)return '';
    return new Date(at+8*3600000).toISOString().slice(0,10);
  }
  function orderRetention(order,now) {
    var anchor=retentionDate(order.dateOverride),source='order_date';
    if(!anchor&&(order.source==='manual'||order.orderDateSource==='platform'))anchor=retentionDate(order.orderDate);
    if(!anchor){anchor=retentionDate(order.firstSeenAt);source='first_seen';}
    var expired=!!(anchor&&Math.floor((now+8*3600000)/86400000)-Math.floor((dateOnly(anchor)+8*3600000)/86400000)>30);
    var restored=!!(anchor&&order.archiveRestoredAnchor===anchor&&timestamp(order.archiveRestoredAt));
    return {version:1,archived:expired&&!restored,anchorDate:anchor,anchorSource:source,archivedAt:anchor?dateOnly(anchor)+31*86400000:0,restoredAt:restored?timestamp(order.archiveRestoredAt):0};
  }
  function shipmentArchived(state,ship) {var order=byId(state.orders,ship.orderId);return !!(order&&orderRetention(order,Date.now()).archived);}
  function expiredReceived(state,ship) {var d=shipmentDisposition(ship);return shipmentArchived(state,ship)&&shipmentStatus(state,ship)==='signed'&&!(d&&['returning','returned'].indexOf(d.kind)>=0);}
  function boundOrder(state,o) { return !!(o&&o.source==='online'&&boundRecord(state,o)); }
  function boundShipment(state,s) { return !!(s&&boundRecord(state,s)&&boundOrder(state,byId(state.orders,s.orderId))); }
  function capability(state,name) { return (state.online.capabilities||[]).indexOf(name)>=0; }
  function extendState(state) {
    state.orders=state.orders||[]; state.shipments=state.shipments||[]; state.operations=state.operations||[];
    // An old queued operation may already have reached the server. Never add wire fields on retry.
    state.operations.forEach(function(op){if(op.action==='pick'&&typeof op.wirePickedAt!=='boolean')op.wirePickedAt=false;});
    state.settings=state.settings||{};state.settings.stationEnhancement=state.settings.stationEnhancement===true;state.settings.manualLearning=state.settings.manualLearning!==false;
    state.matchingFeedback=state.matchingFeedback||{items:[],lastError:'',lastUploadAt:0};
    state.matchingFeedback.items=state.matchingFeedback.items||[];
    state.recognitionIssues=state.recognitionIssues||{items:[],lastError:''};state.recognitionIssues.items=state.recognitionIssues.items||[];
    state.recognitionIssues.epoch=state.recognitionIssues.epoch||hash(String(Date.now())+String(Math.random()));
    scrubRecognitionSources(state);
    state.correctionEvents=state.correctionEvents||[];
    state.stationRules=state.stationRules||[];state.stationRulesVersion=state.stationRulesVersion||0;
    if(!Array.isArray(state.logisticsRules))state.logisticsRules=logistics.defaults();
    state.logisticsRulesRevision=state.logisticsRulesRevision||1;
    state.serverLogisticsRules=state.serverLogisticsRules||[];state.serverLogisticsRulesVersion=state.serverLogisticsRulesVersion||0;
    state.stationEnhancement=state.stationEnhancement||{pending:[],sentIds:[],lastUploadAt:0,lastError:''};
    state.stationEnhancement.pending=state.stationEnhancement.pending||[];state.stationEnhancement.sentIds=state.stationEnhancement.sentIds||[];
    state.online=state.online||{bound:false,baseUrl:'',deviceId:'',accounts:[],lastSuccessAt:0,errorCode:'',error:''};
    state.online.accounts=state.online.accounts||[];
    if(typeof state.online.hasFamilyScope!=='boolean')state.online.hasFamilyScope=!!(state.online.familyIds&&state.online.familyIds.length);
    if(!Array.isArray(state.online.legacyAccountIds))state.online.legacyAccountIds=state.online.hasFamilyScope?[]:state.online.accounts.map(function(a){return a.id;});
    state.online.legacyAccountIds=publicIds(state.online.legacyAccountIds);
    state.online.families=publicFamilies(state.online.families);state.online.familyIds=unique((Array.isArray(state.online.familyIds)?state.online.familyIds:[]).map(familyId));
    state.online.revision=typeof state.online.revision==='number'?state.online.revision:-1;
    state.online.capabilities=state.online.capabilities||[];state.online.jobs=publicJobs(state.online.jobs);recoverOnlineJobs(state.online);
    state.clientId=state.clientId||hash(String(Date.now())+String(Math.random()));
    if(!state.correctionEventsVersion){
      state.items.concat(state.sources,state.shipments).forEach(function(entity){var c=entity.stationCorrection;if(c&&!byId(state.correctionEvents,c.id))state.correctionEvents.push({id:c.id,kind:'station_correction',originalStation:c.originalStation||'',stationName:c.stationName,changedAt:c.changedAt,binding:c.binding||'',local:{},feedback:[],submission:'recovered'});});
      state.matchingFeedback.items.forEach(function(row){var id=row.local&&row.local.correctionId||'recovered-'+row.id,event=byId(state.correctionEvents,id);if(!event){event={id:id,kind:row.payload.kind,originalStation:row.payload.stationName||'',stationName:'历史人工确认',changedAt:row.updatedAt,binding:row.binding,local:row.local||{},feedback:[],submission:'recovered'};state.correctionEvents.push(event);}event.feedback.push({id:row.id,revision:row.revision});});
      state.correctionEventsVersion=1;
    }
    migratePickupBindings(state);
    state.items.forEach(function(i){
      i.sourceIds=unique((i.sourceIds||[]).concat(i.sourceId||[])); i.members=i.members||[];
      if(!i.members.length)i.members.push({id:i.id+'-member-1',shipmentId:'',picked:!!i.isPicked});
      i.history=i.history||[];
    });
  }
  function packageHidden(state,s) { var o=byId(state.orders,s.orderId); return !!(s.hidden||s.deleted||(o&&(o.hidden||o.deleted))); }
  function activeMembers(state,i) { return i.members.filter(function(m){var s=byId(state.shipments,m.shipmentId);return !m.closedCycleId&&(!s||!packageHidden(state,s)&&!shipmentArchived(state,s));}); }
  function groupForShipment(state,id) {
    if(snapshotIndex&&snapshotIndex.state===state&&typeof id==='string')return snapshotIndex.groups[id];
    return state.items.filter(function(i){return !i.mergedInto&&i.members.some(function(m){return !m.closedCycleId&&m.shipmentId===id;});})[0];
  }
  function liveSources(state,i) { return i.sourceIds.map(function(id){return sourceFor(state,id);}).filter(function(s){return s&&!s.deleted&&!s.ignored;}); }
  function recordCode(i,code,type,date,sourceId) {
    if(!validCode(code))return;
    if(!i.history.some(function(h){return h.code===code&&h.sourceId===sourceId&&h.date===date;}))i.history.push({code:code,sourceType:type,date:date,sourceId:sourceId});
  }
  function hasOnlineCode(state,i) { return activeMembers(state,i).some(function(m){var s=byId(state.shipments,m.shipmentId);return s&&s.arrivalAt>0&&validCode(s.pickupCode);}); }
  function groupVisible(state,i) {
    if(i.deleted||i.mergedInto||!activeMembers(state,i).length)return false;
    var members=activeMembers(state,i);
    if(members.every(function(m){var ship=byId(state.shipments,m.shipmentId),d=ship&&shipmentDisposition(ship);return d&&['returning','returned','doorstep'].indexOf(d.kind)>=0;}))return false;
    return !!(i.isManual||(i.legacy&&!i.sourceIds.length)||hasOnlineCode(state,i)||liveSources(state,i).some(function(s){return s.kind==='pickup'&&!s.retiredCycleShipmentId;}));
  }
  function addMembers(state,i,count) {
    count=Math.max(1,Math.min(50,Number(count)||1));
    while(i.members.length<count)i.members.push({id:newId(state,'member-'),shipmentId:'',picked:!!i.isPicked});
  }
  function attachShipment(state,i,s) {
    var existing=i.members.filter(function(m){return !m.closedCycleId&&m.shipmentId===s.id;})[0];
    if(!existing){
      existing=i.members.filter(function(m){return !m.shipmentId;})[0];
      if(existing){
        existing.shipmentId=s.id;
        var allKnownCollected=!groupNeedsMatchReview(state,i)&&liveSources(state,i).some(function(source){var parsed=sourceParsed(state,source);return parsed.kind==='pickup'&&Number(parsed.packageCount)>=i.members.length;});
        if(existing.picked&&s.manualPicked===undefined&&(existing.independentPicked===undefined||allKnownCollected)){delete existing.independentPicked;setShipmentPicked(state,s,true,i.members.length>1?commonPickupTime(i.members):recordedPickup(existing));}
      }
      else {existing={id:newId(state,'member-'),shipmentId:s.id,picked:!!s.picked};i.members.push(existing);}
    }
    if(existing.independentPicked!==undefined)existing.picked=!!existing.independentPicked;
    else if(s.pickupCompletion||s.manualPicked!==undefined||s.picked){existing.picked=!!s.picked;savePickupTime(existing,recordedPickup(s));}
    if(i.deleted){s.hidden=true;s.manualHidden=true;}
    return existing;
  }
  function queueOperation(state,s,action) {
    if(!boundShipment(state,s))return;
    var op={id:state.clientId+'-'+newId(state,'op-'),shipmentId:s.remoteId,action:action,occurredAt:Date.now(),serviceKey:s.serviceKey,deviceId:state.online.deviceId};
    if(action==='pick'){op.pickedAt=timestamp(s.pickedAt);op.wirePickedAt=capability(state,'pickup_confirmed_at_v1');}
    if(['pick','restore','resumeAutoPickup'].indexOf(action)>=0){op.localCycleId=ensurePickupCycle(state,s).id;if(capability(state,'pickup_cycles_v1')&&s.pickupCycle.remoteId)op.pickupCycleId=s.pickupCycle.remoteId;}
    state.operations.push(op);
    if(['pick','restore','resumeAutoPickup'].indexOf(action)>=0){s.pickupManualAt=op.occurredAt;s.pickupManualAction=action;s.pickupManualOperation=state.online.deviceId+':'+op.id;s.pickupManualPickedAtSent=op.wirePickedAt===true;}
  }
  function recordedPickup(value) {
    var unknown={at:0,source:'unknown',precision:'unknown'};
    if(!value||!value.picked)return unknown;
    if(value.pickedAt!==undefined)return {at:timestamp(value.pickedAt),source:value.pickedAtSource||'unknown',precision:value.pickedAtPrecision||'unknown'};
    var completion=value.pickupCompletion;
    if(value.pickupManualAction==='pick'&&completion&&completion.manualOverride==='picked'){
      var manualAt=timestamp(value.pickupConfirmedAt!==undefined?value.pickupConfirmedAt:value.pickupManualAt);
      return {at:manualAt,source:manualAt?'user_confirmed':'unknown',precision:manualAt?'second':'unknown'};
    }
    var evidence=completion&&completion.evidence;
    if(completion&&!completion.manualOverride&&completion.autoPicked&&evidence&&['user_collected','recipient_pickup','recipient_signed'].indexOf(evidence.kind)>=0){
      var at=timestamp(evidence.eventTime),event=(value.logisticsEvents||[]).filter(function(e){return e.time===at&&e.description===evidence.description;})[0];
      return {at:at,source:evidence.kind==='recipient_signed'?'recipient_signed':'platform_pickup',precision:evidence.timePrecision||event&&event.timePrecision||'unknown'};
    }
    return unknown;
  }
  function savePickupTime(value,timing) {
    value.pickedAt=timestamp(timing.at);value.pickedAtSource=value.pickedAt?timing.source:'unknown';value.pickedAtPrecision=value.pickedAt?timing.precision:'unknown';
  }
  function clearPickupTime(value) { delete value.pickedAt;delete value.pickedAtSource;delete value.pickedAtPrecision;delete value.pickedAtCycleId; }
  function commonPickupTime(members) {
    var rows=members.filter(function(m){return m.picked;}).map(recordedPickup),first=rows[0];
    return first&&first.at&&rows.every(function(row){return row.at===first.at&&row.source===first.source;})?first:{at:0,source:'unknown',precision:'unknown'};
  }
  function setMemberPicked(state,m,picked,independent,timing) {
    timing=timing===undefined?(m.picked?recordedPickup(m):{at:Date.now(),source:'user_confirmed',precision:'second'}):timing;
    m.picked=!!picked;
    if(picked)savePickupTime(m,timing);else clearPickupTime(m);
    if(independent||!m.shipmentId||m.independentPicked!==undefined){m.independentPicked=!!picked;return;}
    var s=byId(state.shipments,m.shipmentId);
    if(s)setShipmentPicked(state,s,picked,timing);
  }
  function setShipmentPicked(state,s,picked,timing) {
    timing=timing===undefined?(s.picked?recordedPickup(s):{at:Date.now(),source:'user_confirmed',precision:'second'}):timing;
    s.picked=!!picked;s.manualPicked=!!picked;
    if(picked){savePickupTime(s,timing);s.pickedAtCycleId=ensurePickupCycle(state,s).id;s.pickupConfirmedAt=s.pickedAt;}
    else {clearPickupTime(s);s.pickupConfirmedAt=0;}
    if(s.pickupCompletion)s.pickupCompletion.manualOverride=picked?'picked':'pending';
    queueOperation(state,s,picked?'pick':'restore');
  }
  function completionState(input) {
    if(!input||input.version!==1||typeof input.autoPicked!=='boolean'||['','picked','pending'].indexOf(input.manualOverride)<0)return null;
    var e=input.evidence,evidence=null;
    if(e&&typeof e==='object'){evidence={kind:text(e.kind,60),description:text(e.description,600),eventTime:timestamp(e.eventTime),fingerprint:text(e.fingerprint,200),ruleId:text(e.ruleId,120),ruleVersion:text(e.ruleVersion,80)};mergeProviderEventFields(evidence,e);}
    if(evidence&&['second','minute','unknown'].indexOf(e.timePrecision)>=0)evidence.timePrecision=e.timePrecision;
    return {version:1,autoPicked:input.autoPicked,manualOverride:input.manualOverride,completedAt:timestamp(input.completedAt),evidence:evidence};
  }
  function importCompletion(state,s,input,supported) {
    var next=supported&&completionState(input.pickupCompletion);
    if(!next)return false;
    var pending=state.operations.filter(function(op){
      if(op.status==='cycle_closed'||op.shipmentId!==s.remoteId&&(s.remoteAliases||[]).indexOf(op.shipmentId)<0||op.serviceKey!==s.serviceKey||op.deviceId!==state.online.deviceId||['pick','restore','resumeAutoPickup'].indexOf(op.action)<0)return false;
      if(op.localCycleId&&s.pickupCycle&&op.localCycleId!==s.pickupCycle.id)return false;
      if(!input.pickupCycle)return true;
      var sourceCycle=op.pickupCycleId||s.pickupCycle&&s.pickupCycle.remoteId;
      return !sourceCycle||sourceCycle===input.pickupCycle.id||(s.remoteCycleBridges||[]).some(function(bridge){return bridge.sourceShipmentId===op.shipmentId&&bridge.targetShipmentId===input.id&&bridge.sourceCycleId===sourceCycle&&bridge.targetCycleId===input.pickupCycle.id;});
    });
    if(pending.length){
      var latest=pending[pending.length-1];
      next.manualOverride=latest.action==='pick'?'picked':latest.action==='restore'?'pending':'';
      s.pickupManualAt=latest.occurredAt;s.pickupManualOperation=latest.deviceId+':'+latest.id;s.pickupManualAction=latest.action;s.pickupManualPickedAtSent=latest.wirePickedAt===true;
      if(latest.action==='pick'&&latest.pickedAt!==undefined){savePickupTime(s,{at:timestamp(latest.pickedAt),source:'user_confirmed',precision:'second'});s.pickupConfirmedAt=timestamp(latest.pickedAt);s.pickedAtCycleId=ensurePickupCycle(state,s).id;}
      else if(latest.action!=='pick'){clearPickupTime(s);s.pickupConfirmedAt=0;if(latest.action==='resumeAutoPickup')savePickupTime(s,{at:0,source:'unknown',precision:'unknown'});}
      // Keep the optimistic manual state until the server acknowledges and returns its decision.
    } else {
      s.picked=next.manualOverride==='picked'||(!next.manualOverride&&next.autoPicked);
      if(next.manualOverride)s.manualPicked=next.manualOverride==='picked';else delete s.manualPicked;
      if(input.pickupManualAction!==undefined){
        var sameOperation=s.pickupManualOperation&&s.pickupManualOperation===input.pickupManualOperation;
        var preserveLocalTime=sameOperation&&s.pickedAt!==undefined&&s.pickupManualPickedAtSent!==true;
        s.pickupManualAt=timestamp(input.pickupManualAt);s.pickupManualOperation=text(input.pickupManualOperation,400);s.pickupManualAction=['pick','restore','resumeAutoPickup'].indexOf(input.pickupManualAction)>=0?input.pickupManualAction:'';
        if(!sameOperation)delete s.pickupManualPickedAtSent;
        if(preserveLocalTime)s.pickupConfirmedAt=timestamp(s.pickedAt);
        else if(input.pickupConfirmedAt!==undefined)s.pickupConfirmedAt=timestamp(input.pickupConfirmedAt);
        else if(!sameOperation)delete s.pickupConfirmedAt;
        if(next.manualOverride==='picked'&&s.pickupManualAction==='pick'){
          if(!preserveLocalTime&&(!sameOperation||input.pickupConfirmedAt!==undefined)){clearPickupTime(s);savePickupTime(s,{at:timestamp(s.pickupConfirmedAt!==undefined?s.pickupConfirmedAt:s.pickupManualAt),source:'user_confirmed',precision:'second'});s.pickedAtCycleId=ensurePickupCycle(state,s).id;}
        } else clearPickupTime(s);
      } else if(next.manualOverride!=='picked')clearPickupTime(s);
    }
    s.pickupCompletion=next;return true;
  }
  function mergeSource(state,source,shipment,manual) {
    var original=state.items.filter(function(i){return i.sourceIds.indexOf(source.id)>=0&&!i.mergedInto;})[0];
    if(manual&&original&&!original.isPicked){
      var anonymousPicked=original.members.filter(function(m){return !m.shipmentId&&m.picked;}).length;
      if(anonymousPicked){original.unassignedPickupTime=commonPickupTime(original.members.filter(function(m){return !m.shipmentId;}));original.unassignedPickedCount=Math.max(original.unassignedPickedCount||0,anonymousPicked);original.members.forEach(function(m){if(!m.shipmentId){m.picked=false;delete m.independentPicked;clearPickupTime(m);}});}
    }
    var target=groupForShipment(state,shipment.id);
    if(!target&&original){target=original;attachShipment(state,target,shipment);}
    if(!target)return;
    if(original&&original!==target){
      source.originalItemId=source.originalItemId||original.id;
      original.mergedInto=target.id;
      var originalSequence=Number((/\d+$/.exec(original.id)||[])[0]),targetSequence=Number((/\d+$/.exec(target.id)||[])[0]);
      if(originalSequence<targetSequence){target.date=original.date;target.sendDate=original.sendDate;}
      if(original.protected&&original.codeOverride){target.code=original.code;target.codeOverride=true;}
      if(original.protected){['remark','address','company'].forEach(function(k){if(original[k])target[k]=original[k];});target.protected=true;}
      target.tags=unique((target.tags||[]).concat(original.tags||[]));
      target.sourceIds=unique(target.sourceIds.concat(original.sourceIds));
      original.history.forEach(function(h){recordCode(target,h.code,h.sourceType,h.date,h.sourceId);});
      original.members.forEach(function(m){var ship=byId(state.shipments,m.shipmentId);if(ship)attachShipment(state,target,ship);});
      addMembers(state,target,original.members.length);
      if(original.isPicked){
        var transferred=0;
        if(!manual&&target.members.filter(function(m){return !!m.shipmentId;}).length>original.members.length){target.unassignedPickedCount=Math.max(target.unassignedPickedCount||0,original.members.length);target.unassignedPickupTime=commonPickupTime(original.members);}
        else target.members.forEach(function(m){if(manual?m.shipmentId===shipment.id:transferred<original.members.length){setMemberPicked(state,m,true,false,commonPickupTime(original.members));transferred++;}});
      }
      else {
        var anonymousPicked=original.members.filter(function(m){return !m.shipmentId&&m.picked;}).length;
        // A count-only SMS cannot tell which newly discovered waybill was collected.
        // Preserve the count and request explicit assignment before uploading any particular waybill.
        target.unassignedPickedCount=Math.max(target.unassignedPickedCount||0,anonymousPicked,original.unassignedPickedCount||0);
        if(anonymousPicked||original.unassignedPickedCount)target.unassignedPickupTime=original.unassignedPickupTime||commonPickupTime(original.members.filter(function(m){return !m.shipmentId;}));
        original.members.filter(function(m){return m.shipmentId&&m.picked;}).forEach(function(m){var same=target.members.filter(function(x){return x.shipmentId===m.shipmentId;})[0];if(same)setMemberPicked(state,same,true,false,recordedPickup(m));});
      }
    }
    target.sourceIds=unique(target.sourceIds.concat(source.id));target.sourceId=target.sourceIds[0]||'';
    confirmPickupBinding(state,source,shipment,manual);source.manualUnlinked=false;
    if(manual){source.manualLinked=true;source.matchBasis='人工匹配';source.matchNeedsReview=false;}
    var parsed=source.parsed||parse(source.body,state.rules);
    if(parsed&&parsed.kind==='pickup'){
      addMembers(state,target,parsed.packageCount);
      recordCode(target,parsed.code,'短信',source.date,source.id);
      if(!shipment.arrivalAt)shipment.smsArrivalAt=source.date;
    }
    if(!target.address||target.address==='未知地址')target.address=shipment.station||target.address;
  }
  function pendingAliasItem(state,item) { return !!(item&&!item.deleted&&!item.isPicked&&activeMembers(state,item).some(function(member){return !member.picked;})); }
  function pendingAliasShipment(state,shipment,source) { return shipment.status==='arrived'&&!shipment.picked&&!matchLinkReason(state,shipment,source,true); }
  function correctionLocationConflict(state,source,shipment) {
    if(!source||!shipment||!activeCorrection(state,source)&&!activeCorrection(state,shipment))return false;
    var left=rawSourceStation(state,source),right=rawStation(shipment,'station');
    return locationConflict(recognizeStation(state,left).location,recognizeStation(state,right).location)||!!(cabinetDisplay([left]).pickupCabinet&&cabinetDisplay([right]).pickupCabinet&&cabinetDisplay([left]).pickupCabinet!==cabinetDisplay([right]).pickupCabinet);
  }
  function groupStationEvidence(state,item) {
    if(!item)return [];
    var values=[rawStation(item,'address')];liveSources(state,item).forEach(function(s){values.push(rawSourceStation(state,s));});
    item.members.forEach(function(m){var s=byId(state.shipments,m.shipmentId);if(s)values.push(rawStation(s,'station'));});return values;
  }
  function stationEvidenceConflict(state,left,right) {
    var a=cabinetDisplay(left),b=cabinetDisplay(right);
    if(a.pickupCabinetConflict||b.pickupCabinetConflict||a.pickupCabinet&&b.pickupCabinet&&a.pickupCabinet!==b.pickupCabinet)return true;
    return left.some(function(x){return right.some(function(y){return locationConflict(recognizeStation(state,x).location,recognizeStation(state,y).location);});});
  }
  function automaticPlaceMatch(state,a,b,item,shipment,source) {
    if(correctionLocationConflict(state,source,shipment))return false;
    if((activeCorrection(state,item)||activeCorrection(state,shipment))&&stationEvidenceConflict(state,groupStationEvidence(state,item),[rawStation(shipment,'station')]))return false;
    if(!samePlace(state,a,b))return false;
    // Existing exact-name contracts can fill late parcel details; new aliases only reconcile active pickups.
    return matchStationKey(a)===matchStationKey(b)||pendingAliasItem(state,item)&&pendingAliasShipment(state,shipment,source);
  }
  function automaticGroupPlaceMatch(state,a,b) {
    if((activeCorrection(state,a)||activeCorrection(state,b))&&stationEvidenceConflict(state,groupStationEvidence(state,a),groupStationEvidence(state,b)))return false;
    if(!samePlace(state,a.address,b.address))return false;
    if(matchStationKey(a.address)===matchStationKey(b.address))return true;
    return pendingAliasItem(state,a)&&pendingAliasItem(state,b)&&a.members.concat(b.members).every(function(member){var shipment=byId(state.shipments,member.shipmentId);return shipment&&pendingAliasShipment(state,shipment,null);});
  }
  function sourceCandidates(state,s) {
    var p=s.parsed||parse(s.body,state.rules);if(!p)return [];
    var wb=sourceWaybill(s.body),carrier=carrierKey(p.express);
    var exact=wb?state.shipments.filter(function(x){return boundShipment(state,x)&&!packageHidden(state,x)&&x.waybillNo.toUpperCase()===wb&&(!carrier||/菜鸟|兔喜|拼多多|驿站/.test(carrier)||carrier===carrierKey(x.carrier));}):[];
    if(wb)return exact;
    if(p.kind!=='pickup')return [];
    return state.shipments.filter(function(x){return boundShipment(state,x)&&!packageHidden(state,x)&&x.pickupCode===p.code&&automaticPlaceMatch(state,x.station,sourceStation(state,s),sourceItem(state,s),x,s)&&near(x.arrivalAt,s.date);});
  }
  function mergeSharedPickupGroups(state) {
    var groups=[];
    state.items.forEach(function(i){
      if(i.deleted||i.mergedInto||i.unassignedPickedCount||!i.members.length)return;
      var ships=i.members.map(function(m){return byId(state.shipments,m.shipmentId);});
      // Count-only SMS and completed groups retain their original pickup boundary.
      if(ships.some(function(s){return !s;})||!ships.some(function(s){return !s.picked;}))return;
      var service=ships[0].serviceKey;
      if(ships.some(function(s){return s.serviceKey!==service;}))return;
      var target=groups.filter(function(g){return g.service===service&&g.item.code===i.code&&automaticGroupPlaceMatch(state,g.item,i)&&near(g.item.date,i.date);})[0];
      if(!target){groups.push({service:service,item:i});return;}
      target=target.item;
      i.members.forEach(function(m){if(!target.members.some(function(other){return other.shipmentId===m.shipmentId;}))target.members.push(clone(m));});
      target.sourceIds=unique(target.sourceIds.concat(i.sourceIds));target.sourceId=target.sourceIds[0]||'';
      i.history.forEach(function(h){recordCode(target,h.code,h.sourceType,h.date,h.sourceId);});
      target.tags=unique((target.tags||[]).concat(i.tags||[]));
      if(i.remark&&i.remark!==target.remark)target.remark=target.remark?target.remark+' / '+i.remark:i.remark;
      i.mergedInto=target.id;
    });
  }
  function reconcileOnline(state) {
    state.shipments.forEach(function(s){
      if(!s.arrivalAt||!validCode(s.pickupCode))return;
      var i=groupForShipment(state,s.id);
      // A historical code on a newly imported signed parcel must not create a new pickup.
      // Existing groups keep the user's independent pickup state.
      if(!i&&s.status!=='arrived')return;
      if(!i){
        var matches=state.items.filter(function(x){return !x.deleted&&!x.mergedInto&&(!x.isPicked||x.members.some(function(m){return !m.shipmentId;}))&&x.code===s.pickupCode&&automaticPlaceMatch(state,x.address,s.station,x,s,null)&&near(x.date,s.arrivalAt)&&x.members.some(function(m){var other=byId(state.shipments,m.shipmentId);return other&&other.serviceKey===s.serviceKey;});});
        if(matches.length===1)i=matches[0];
        else {i={id:newId(state,'online-'),sourceId:'',sourceIds:[],members:[],history:[],code:s.pickupCode,date:s.arrivalAt,sendDate:time(s.arrivalAt),company:s.carrier||'线上包裹',address:s.station||'未知地址',isPicked:false,isManual:false,tags:[],remark:'',protected:false};state.items.push(i);}
      }
      attachShipment(state,i,s);recordCode(i,s.pickupCode,'订单',s.codeUpdatedAt||s.updatedAt,s.id);
    });
    mergeSharedPickupGroups(state);
    state.sources.forEach(function(s){
      if(s.ignored||s.deleted||s.manualUnlinked)return;
      var links=sourceLinks(state,s);
      if(links.length){links.forEach(function(id){var linked=byId(state.shipments,id);if(linked)mergeSource(state,s,linked,false);});return;}
      var candidates=sourceCandidates(state,s);s.candidateShipmentIds=candidates.map(function(x){return x.id;});
      var groups=unique(candidates.map(function(x){var g=groupForShipment(state,x.id);return g?g.id:x.id;}));
      if(candidates.length&&groups.length===1){mergeSource(state,s,candidates[0],false);s.matchBasis=sourceWaybill(s.body)?'运单号一致':'取件码与站点一致';}
    });
    var graph=[],reverse={};
    state.sources.forEach(function(source){
      var p=sourceParsed(state,source),item=sourceItem(state,source),links=sourceLinks(state,source);
      if(source.ignored||source.deleted||source.manualUnlinked||source.manualLinked||p.kind!=='pickup'||!item||item.isPicked||sourceWaybill(source.body))return;
      if(links.length&&!/时间/.test(source.matchBasis||''))return;
      if(!links.length&&sourceCandidates(state,source).length)return;
      var matches=[];
      state.shipments.forEach(function(shipment){
        if(state.sources.some(function(other){return other!==source&&!other.ignored&&!other.deleted&&sourceLinks(state,other).indexOf(shipment.id)>=0&&(other.manualLinked||!/时间/.test(other.matchBasis||''));}))return;
        var match=timeMatch(state,source,shipment);if(match){matches.push(match);(reverse[shipment.id]||(reverse[shipment.id]=[])).push(source.id);}
      });
      graph.push({source:source,matches:matches,count:Number(p.packageCount)||1});
    });
    graph.forEach(function(entry){
      var source=entry.source,matches=entry.matches,links=sourceLinks(state,source),single=matches.length===1&&matches[0].autoEligible&&reverse[matches[0].shipmentId].length===1&&entry.count===1;
      matches.forEach(function(match){
        if(matches.length>1){match.decisionReason='multiple_shipments';match.reason+='；存在多个包裹候选，需人工确认';}
        else if(reverse[match.shipmentId].length>1){match.decisionReason='multiple_sources';match.reason+='；存在多条取件短信，需人工确认';}
        else if(entry.count!==1){match.decisionReason='multiple_pieces';match.reason+='；多件短信需人工确认';}
        else if(single)match.decisionReason='automatic';
      });
      if(links.length){source.matchNeedsReview=matches.some(function(m){return links.indexOf(m.shipmentId)<0||reverse[m.shipmentId].length>1;});state.pickupBindings.filter(function(b){return b.sourceId===source.id&&links.indexOf(b.shipmentId)>=0&&(b.status==='confirmed'||b.status==='review_required');}).forEach(function(b){bindingStatus(b,source.matchNeedsReview?'review_required':'confirmed',source.matchNeedsReview?'evidence_conflict':'retained_confirmation');});}
      else if(single){mergeSource(state,source,byId(state.shipments,matches[0].shipmentId),false);source.matchBasis=matches[0].reason;source.matchNeedsReview=false;}
      source.timeMatchCandidates=matches;
    });
    state.sources.forEach(function(source){
      source.matchCandidates=sourceRecommendations(state,source);
      (source.timeMatchCandidates||[]).forEach(function(match){var index=-1;source.matchCandidates.some(function(m,i){if(m.shipmentId!==match.shipmentId)return false;index=i;return true;});if(index<0)source.matchCandidates.push(match);else source.matchCandidates[index]=match;});
      delete source.timeMatchCandidates;
      source.candidateShipmentIds=source.matchCandidates.map(function(m){return m.shipmentId;});
      source.matchConflicts=[];
      if(!source.ignored&&!source.deleted)state.shipments.forEach(function(shipment){if(!matchLinkReason(state,shipment,source)){var reason=matchConflict(state,source,shipment);if(reason)source.matchConflicts.push({shipmentId:shipment.id,reason:reason});}});
    });
    state.items.forEach(function(i){
      i.members.forEach(function(m){var s=byId(state.shipments,m.shipmentId);if(m.independentPicked!==undefined)m.picked=!!m.independentPicked;else if(s)m.picked=!!s.picked;});
      var members=activeMembers(state,i);i.isPicked=members.length>0&&members.every(function(m){return m.picked;});
    });
  }
  function publicCode(state,i) {
    var cached=snapshotIndex&&snapshotIndex.state===state&&snapshotIndex.codes[i.id];
    if(cached&&cached.item===i)return cached.value;
    var value=clone(i),members=activeMembers(state,i),sources=i.sourceIds.map(function(id){return sourceFor(state,id);}).filter(Boolean);
    value.stationCorrection=publicCorrection(state,i);delete value.automaticStation;
    var place=publicStation(state,i.address);value.stationCanonical=place.stationCanonical;value.stationCanonicalId=place.stationCanonicalId;value.stationSubLocation=place.stationSubLocation;value.stationDisplayName=place.stationDisplayName;
    value.sources=sources.map(function(s){var parsed=sourceParsed(state,s),station=publicStation(state,sourceStation(state,s));return {sourceId:s.id,body:s.body,sender:s.sender,date:s.date,receivedAt:s.receivedAt||s.date,sentAt:s.sentAt||0,ignored:!!s.ignored,kind:s.kind,
      stationCanonical:station.stationCanonical,stationCanonicalId:station.stationCanonicalId,stationSubLocation:station.stationSubLocation,stationDisplayName:station.stationDisplayName,pickupCabinet:station.pickupCabinet,pickupCabinetConflict:station.pickupCabinetConflict,
      packageCount:Math.max(1,Math.min(50,Number(parsed.packageCount)||1)),address:sourceStation(state,s),company:parsed.express||'',linkedShipmentId:s.linkedShipmentId||'',linkedShipmentIds:sourceLinks(state,s),
      matchCandidates:clone(s.matchCandidates||[]),matchConflicts:clone(s.matchConflicts||[]),matchBasis:s.matchBasis||'',matchNeedsReview:!!s.matchNeedsReview,recognitionIssues:recognitionIssueSummary(state,s.id)};}).sort(function(a,b){return a.date-b.date;});
    var first=sources.filter(function(s){return !s.ignored&&!s.deleted;})[0];value.sourceBody=first?first.body:'';value.sourceId=first?first.id:'';
    var cabinetValues=[i.address,rawStation(i,'address'),place.pickupCabinet],cabinetConflict=place.pickupCabinetConflict;
    liveSources(state,i).forEach(function(source){var address=sourceStation(state,source),sourcePlace=publicStation(state,address);cabinetValues.push(address,rawSourceStation(state,source),sourcePlace.pickupCabinet);cabinetConflict=cabinetConflict||sourcePlace.pickupCabinetConflict;});
    members.forEach(function(member){var shipment=byId(state.shipments,member.shipmentId);if(shipment){var shipmentPlace=publicStation(state,shipment.station);cabinetValues.push(shipment.station,rawStation(shipment,'station'),shipmentPlace.pickupCabinet);cabinetConflict=cabinetConflict||shipmentPlace.pickupCabinetConflict;}});
    var cabinet=cabinetDisplay(cabinetValues);value.pickupCabinet=cabinetConflict?'':cabinet.pickupCabinet;value.pickupCabinetConflict=cabinetConflict||cabinet.pickupCabinetConflict;
    value.members=members.map(function(m){var s=byId(state.shipments,m.shipmentId),o=s&&byId(state.orders,s.orderId),timing=recordedPickup(m.independentPicked!==undefined?m:s||m),member={id:m.id,shipmentId:m.shipmentId,orderId:s?s.orderId:'',platformOrderId:o?o.platformOrderId||'':'',familyId:s?s.familyId||'':'',familyName:s?s.familyName||'':'',title:o?o.title:'待取包裹',platform:o?o.platform:'短信',waybillNo:s?s.waybillNo:'',picked:!!m.picked,pickedAt:timing.at,pickedAtSource:timing.source,pickedAtPrecision:timing.precision};if(m.independentPicked!==undefined)member.independentPicked=!!m.independentPicked;return member;});
    var timedMembers=value.members.filter(function(m){return m.picked&&m.pickedAt;});
    value.pickedAt=timedMembers.length===members.length&&members.length?Math.max.apply(Math,timedMembers.map(function(m){return m.pickedAt;})):0;
    var lastPicked=timedMembers.filter(function(m){return m.pickedAt===value.pickedAt;})[0];value.pickedAtSource=lastPicked?lastPicked.pickedAtSource:'unknown';value.pickedAtPrecision=lastPicked?lastPicked.pickedAtPrecision:'unknown';
    value.arrivalAt=sources.length?Math.min.apply(Math,sources.map(function(source){return source.date;})):0;value.arrivalAtSource=value.arrivalAt?'sms_received':'unknown';value.arrivalAtPrecision='unknown';
    value.families=[];value.members.forEach(function(m){if(!value.families.some(function(f){return f.id===m.familyId;}))value.families.push({id:m.familyId,name:m.familyId?(m.familyName||'家人'):'待归属'});});
    value.totalCount=members.length;value.unassignedPickedCount=Math.min(i.unassignedPickedCount||0,members.filter(function(m){return !m.picked;}).length);
    value.needsPickupAssignment=value.unassignedPickedCount>0;
    value.needsMatchReview=groupNeedsMatchReview(state,i);
    value.pendingCount=members.filter(function(m){return !m.picked;}).length-value.unassignedPickedCount;
    var online=members.some(function(m){return !!m.shipmentId;}),sms=liveSources(state,i).length>0;
    value.sourceLabel=online?(sms?'订单＋短信':'线上订单'):(i.isManual?'手动添加':'短信');
    value.candidateShipmentIds=unique(sources.reduce(function(ids,s){return ids.concat(s.linkedShipmentId?[]:(s.candidateShipmentIds||[]));},[]));
    var history=i.history.filter(function(h){var src=sourceFor(state,h.sourceId);return !src||(i.sourceIds.indexOf(src.id)>=0&&!src.ignored&&!src.deleted);});
    var codes=unique(history.map(function(h){return h.code;}));
    value.conflicts=codes.length>1&&(!i.resolvedCodes||codes.some(function(c){return i.resolvedCodes.indexOf(c)<0;}))?codes.map(function(code){return history.filter(function(h){return h.code===code;}).sort(function(a,b){return b.date-a.date;})[0];}):[];
    delete value.history;delete value.mergedInto;delete value.protected;delete value.resolvedCodes;
    if(snapshotIndex&&snapshotIndex.state===state)snapshotIndex.codes[i.id]={item:i,value:value};
    return value;
  }
  function mergeProviderEventFields(target,source) {
    if(['pdd','taobao'].indexOf(source.provider)<0)return true;
    var fields={provider:source.provider};
    [['providerStatus',64],['providerStatusTag',120],['providerSubStatus',64],['providerStatusText',120]].forEach(function(pair){
      var value=source[pair[0]];if(typeof value==='string'&&value.trim())fields[pair[0]]=value.trim().slice(0,pair[1]);
    });
    if(Object.keys(fields).some(function(key){return target[key]&&target[key]!==fields[key];}))return false;
    Object.keys(fields).forEach(function(key){target[key]=fields[key];});
    return true;
  }
  function logisticsEvents(values) {
    var seen={},events=[];
    (Array.isArray(values)?values:[]).slice(0,1000).forEach(function(value,index){
      if(!value||typeof value!=='object')return;
      var e={time:timestamp(value.time),timeText:text(value.timeText,100),description:text(value.description,600),location:text(value.location,120)};
      if(['second','minute','unknown'].indexOf(value.timePrecision)>=0)e.timePrecision=value.timePrecision;
      mergeProviderEventFields(e,value);
      var key=JSON.stringify([e.time,e.time?'':e.timeText,e.description,e.location,logistics.eventTimeIssue(e,Date.now())==='timeConflict']);
      if(!e.description)return;
      var matches=seen[key]||[];
      if(matches.some(function(prior){return mergeProviderEventFields(prior,e);}))return;
      matches.push(e);seen[key]=matches;e.index=index;events.push(e);
    });
    var datedTaobao={};
    events.forEach(function(e){
      if(e.provider!=='taobao'||!e.time||e.time>Date.now()||!e.timeText)return;
      var key=JSON.stringify([e.timeText,e.description,e.location]);
      if(datedTaobao[key]===undefined)datedTaobao[key]=e;
      else if(datedTaobao[key]&&datedTaobao[key].time!==e.time)datedTaobao[key]=false;
    });
    // Replace only an identical undated summary; conflicting provider facts must survive.
    events=events.filter(function(e){
      if(e.time||!e.timeText)return true;
      var dated=datedTaobao[JSON.stringify([e.timeText,e.description,e.location])];
      return !dated||['provider','providerStatus','providerStatusTag','providerSubStatus','providerStatusText'].some(function(key){return e[key]&&e[key]!==dated[key];});
    });
    events.sort(function(a,b){return b.time-a.time||a.index-b.index;});
    if(events.length<=100)return events.map(function(e){delete e.index;return e;});
    var groups={},kept=[];
    function eventKey(e){return JSON.stringify([e.time,e.time?'':e.timeText,e.description,e.location]);}
    events.forEach(function(e){var key=eventKey(e);(groups[key]||(groups[key]=[])).push(e);});
    function keep(e){
      if(!e)return true;
      var group=groups[eventKey(e)].filter(function(item){return kept.indexOf(item)<0;});
      if(kept.length+group.length>100)return false;
      kept=kept.concat(group);return true;
    }
    keep(events.filter(function(e){return e.provider==='pdd'&&e.providerStatus==='IN_CABINET';})[0]);
    keep(events.filter(function(e){return e.provider==='pdd'&&e.providerStatus==='IN_CABINET'&&!e.time;})[0]);
    for(var i=0;i<events.length;i++){if(kept.length>=100||!keep(events[i]))break;}
    return events.filter(function(e){return kept.indexOf(e)>=0;}).map(function(e){delete e.index;return e;});
  }
  function shipmentStatus(state,s) {
    if(s.platformView)return s.platformView.status;
    var disposition=shipmentDisposition(s);if(disposition)return disposition.kind==='doorstep'?'signed':disposition.kind;
    var order=byId(state.orders,s.orderId);
    if(s.status==='unknown'&&order&&order.platform==='jd'&&text(s.waybillNo,60).trim()&&(s.arrivalAt||s.smsArrivalAt))return 'arrived';
    return s.status;
  }
  // Bump when bundled logistics parsing changes so persisted projections are reevaluated independently of user rules.
  var logisticsProjectionVersion=5;
  var logisticsFields=['status','station','stationSource','arrivalAt','arrivalAtSource','arrivalAtPrecision'];
  function restorePlatformLogistics(s) {
    if(s.platformLogistics)logisticsFields.forEach(function(key){s[key]=s.platformLogistics[key];});
  }
  function rememberPlatformLogistics(s) {
    s.platformLogistics={};logisticsFields.forEach(function(key){s.platformLogistics[key]=s[key];});
    s.localLogisticsRevision=0;
  }
  function refreshLocalLogistics(state) {
    // Device rules keep precedence, including a user's disabled rule with the same ID.
    var rules=state.logisticsRules.concat(state.serverLogisticsRules.filter(function(rule){return !byId(state.logisticsRules,rule.id);}));
    state.shipments.forEach(function(s){
      if(s.platformView){if(!activeCorrection(state,s))s.station=s.platformView.station.rawName;return;}
      var logisticsChanged=s.localLogisticsRevision!==state.logisticsRulesRevision||s.localLogisticsVersion!==logisticsProjectionVersion||s.localLogisticsServerRevision!==state.serverLogisticsRulesVersion;
      if(!s.remoteId||!logisticsChanged&&s.localStationRulesVersion===state.stationRulesVersion)return;
      s.localStationRulesVersion=state.stationRulesVersion;
      if(!logisticsChanged&&trustedArrival(s)&&(recognizeStation(state,s.station).id||activeCorrection(state,s)))return;
      if(!s.platformLogistics)rememberPlatformLogistics(s);
      if(logisticsChanged)restorePlatformLogistics(s);
      s.localLogisticsRevision=state.logisticsRulesRevision;
      s.localLogisticsVersion=logisticsProjectionVersion;
      s.localLogisticsServerRevision=state.serverLogisticsRulesVersion;
      var events=s.logisticsEvents||[];
      if(!events.length||s.picked||s.pickupCompletion&&s.pickupCompletion.autoPicked||s.hidden||s.deleted||shipmentArchived(state,s)||s.arrivalAtSource==='locker_arrival'||s.stationSource==='locker')return;
      if(events.some(function(event){return logistics.eventTimeIssue(event,Date.now())==='timeConflict';}))return;
      if(undatedPickupTransition(events)==='arrival'&&!timestamp(s.platformLogistics.arrivalAt)&&s.platformLogistics.status==='arrived'&&s.platformLogistics.station&&s.platformLogistics.stationSource==='platform_event')return;
      var knownStation=recognizeStation(state,s.station).id||activeCorrection(state,s);
      var catalogEvidence=!knownStation||!trustedArrival(s)?logistics.catalogPickupEvidence(events,state.stationRules,rules):null;
      if(catalogEvidence&&(!catalogEvidence.arrivalAt||catalogEvidence.arrivalAt>Date.now()))catalogEvidence=null;
      var evidence=logistics.pickupEvidence(events,rules,!trustedArrival(s));
      if(evidence.arrivalAt>Date.now())evidence=logistics.pickupEvidence([],rules);
      if(!catalogEvidence&&!trustedArrival(s)&&evidence.arrivalAt&&evidence.arrivalAt<=Date.now())catalogEvidence=evidence;
      if(!catalogEvidence&&(!logisticsChanged||s.status==='signed'))return;
      if(catalogEvidence){
        if(knownStation)['station','stationSource'].forEach(function(key){catalogEvidence[key]=s[key];});
        evidence=catalogEvidence;
      }
      if(evidence.arrivalAt&&trustedArrival(s))['arrivalAt','arrivalAtSource','arrivalAtPrecision'].forEach(function(key){evidence[key]=s[key];});
      // Text timelines omit platform card fields; retain a specific card station for the same arrival.
      if(evidence.arrivalAt&&evidence.arrivalAt===s.platformLogistics.arrivalAt&&s.platformLogistics.station&&
        (!evidence.station||logistics.genericPickupStation(evidence.station))&&!logistics.genericPickupStation(s.platformLogistics.station)){
        evidence.station=s.platformLogistics.station;evidence.stationSource=s.platformLogistics.stationSource;
      }
      // Rules interpret original platform events locally; they never create a remote operation.
      ['station','stationSource','arrivalAt','arrivalAtSource','arrivalAtPrecision'].forEach(function(key){s[key]=evidence[key];});
      if(evidence.arrivalAt&&(catalogEvidence||logistics.pickupArrivalEvent(events[0].description,evidence.station,rules)))s.status='arrived';
    });
  }
  function undatedPickupTransition(events) {
    var undated=events.filter(function(event){return logistics.eventTimeIssue(event,Date.now())==='unknownTime';});
    if(undated.some(function(event){return logistics.pickupCycleReset(event.description);}))return 'reset';
    return undated.some(function(event){return logistics.pickupArrivalEvent(event.description)||
      /驿站|代收点|自提点|自提站|自提柜|快递柜|快递超市|智能柜|丰巢|菜鸟|门店|便利店/.test(event.description)&&logistics.eventStatus(event.description)==='arrived';})?'arrival':'';
  }
  function shipmentDisposition(s) {
    if(s.platformView){var view=s.platformView,kind=['returning','returned'].indexOf(view.status)>=0?view.status:view.deliveryMode==='doorstep'?'doorstep':'';return kind?{kind:kind,eventTime:s.arrivalAt||0,description:''}:null;}
    var events=logisticsEvents(s.logisticsEvents),latest=events[0];
    if(!latest||!latest.time||latest.time>Date.now())return null;
    var description=latest.description;
    if(/预计|即将|将于|申请|预约|准备|是否|疑似|请|未退|没有退|取消退|无需退|未送|没有送|尚未|送达失败/.test(description))return null;
    var kind=/已退(?:回|货)|退(?:回|货).{0,12}(?:完成|签收)|发件人已签收退件/.test(description)?'returned':/退回中|退货中|退件运输|退货运输|正在退回|已拒收|已拒签|已拒绝?签收|已退件|拒收退回|退回发件人/.test(description)?'returning':/已(?:经)?(?:成功)?(?:送(?:到|至|达)|派送(?:到|至)|放(?:在|到|至)?|投递(?:到|至)).{0,16}(?:门口|门前|家中|家里|住处)/.test(description)&&!/驿站|代收点|快递柜|自提柜/.test(description)?'doorstep':'';
    return kind&&!(kind==='doorstep'&&undatedPickupTransition(events))?{kind:kind,eventTime:latest.time,description:description}:null;
  }
  function actualPickupCycleReset(event) {
    var at=timestamp(event.time);
    return at>0&&at<=Date.now()&&logistics.pickupCycleReset(event.description);
  }
  function publicShipment(state,s) {
    var group=groupForShipment(state,s.id),pickup=group&&groupVisible(state,group)?publicCode(state,group):null;
    var view=s.platformView,detail=view&&s.shipmentDetails,detailValid=detail&&detail.evidenceKey===view.evidenceKey&&detail.bindingKey===detailBinding(state)&&boundShipment(state,s);
    var events=logisticsEvents(view?(detailValid?detail.logisticsEvents:[]):s.logisticsEvents),latest=events.length?events[0].description:'';
    var currentPickupPoint=/驿站|代收点|自提柜|快递柜|丰巢/.test(latest);
    var atHome=!currentPickupPoint&&/已(?:经)?(?:成功)?(?:送(?:到|至|达)|派送(?:到|至)|放(?:在|到|至)?|投递(?:到|至)).{0,16}(?:门口|门前|家中|家里|住处)/.test(latest);
    var atPickupPoint=currentPickupPoint||(!atHome&&/驿站|代收点|自提柜|快递柜|丰巢/.test(s.station||''));
    var disposition=shipmentDisposition(s),returning=disposition&&['returning','returned'].indexOf(disposition.kind)>=0;
    var homeDelivery=view?view.deliveryMode==='doorstep':!returning&&!undatedPickupTransition(events)&&(disposition&&disposition.kind==='doorstep'||s.status==='signed'&&!pickup&&!atPickupPoint&&(!validCode(s.pickupCode)||atHome));
    var linkReason=matchLinkReason(state,s,null,false),station=view&&!activeCorrection(state,s)?{stationCanonical:view.station.name,stationCanonicalId:view.station.id,stationSubLocation:view.station.subLocation,stationDisplayName:view.station.displayName,pickupCabinet:view.station.subLocation,pickupCabinetConflict:view.station.conflict}:publicStation(state,s.station);
    var archived=shipmentArchived(state,s),autoReceived=!s.picked&&expiredReceived(state,s),received=!!s.picked||autoReceived,order=byId(state.orders,s.orderId),timing=recordedPickup(s);
    // Cached parcels use the same delivery evidence without waiting for another collection.
    var doorstep=!view&&homeDelivery?logistics.doorstepEvidence(events,{platform:order&&order.platform,carrier:s.carrier}):null;
    var arrival=doorstep&&doorstep.arrivalAt?doorstep:{arrivalAt:s.arrivalAt||(!view?s.smsArrivalAt:0)||0,arrivalAtSource:s.arrivalAt?s.arrivalAtSource||'unknown':'unknown',arrivalAtPrecision:s.arrivalAt?s.arrivalAtPrecision||'unknown':'unknown'};
    return {id:s.id,familyId:s.familyId||'',familyName:s.familyName||'',waybillNo:s.waybillNo,carrier:s.carrier,status:returning?disposition.kind:shipmentStatus(state,s),pickupCode:homeDelivery||returning?'':s.pickupCode,station:s.station,stationCorrection:publicCorrection(state,s),arrivalAt:arrival.arrivalAt,picked:received,archived:archived,receiptState:autoReceived?'expired_signed':s.picked?'picked':'pending',receiptLabel:autoReceived?'超期自动确认收到':'',hidden:packageHidden(state,s),pickupDisposition:disposition,pickupCycle:clone(s.pickupCycle),pickupCycleHistory:clone(s.pickupCycleHistory||[]),
      stationCanonical:station.stationCanonical,stationCanonicalId:station.stationCanonicalId,stationSubLocation:station.stationSubLocation,stationDisplayName:station.stationDisplayName,pickupCabinet:pickup?pickup.pickupCabinet:station.pickupCabinet,pickupCabinetConflict:pickup?pickup.pickupCabinetConflict:station.pickupCabinetConflict,
      isHomeDelivery:homeDelivery,needsReceiptConfirmation:(view?view.requiresReceiptConfirmation:homeDelivery)&&!received&&!archived&&!packageHidden(state,s),pickupCompletion:s.pickupCompletion?clone(s.pickupCompletion):undefined,
      detailBindingKey:view?detailBinding(state):undefined,canLoadDetails:!!(view&&boundShipment(state,s)&&!packageHidden(state,s)),platformView:view?clone(view):undefined,deliveryMode:view?view.deliveryMode:undefined,courierPhones:view?clone(view.courierPhones):undefined,fieldQuality:view?clone(view.quality):undefined,evidenceKey:view?view.evidenceKey:undefined,detailState:view?(detailValid?'loaded':detail?'stale':'not_loaded'):undefined,
      orderDate:order?(dateOnly(order.dateOverride)||order.orderDate||0):0,orderDateSource:order?(order.dateOverride?'manual':order.orderDateSource||'unknown'):'unknown',orderDatePrecision:order?(order.dateOverride?'day':order.orderDatePrecision||'unknown'):'unknown',
      shippedAt:s.shippedAt||0,shippedAtSource:s.shippedAtSource||'unknown',shippedAtPrecision:s.shippedAtPrecision||'unknown',pickedAt:timing.at,pickedAtSource:timing.source,pickedAtPrecision:timing.precision,pickedAtCycleId:s.pickedAtCycleId||'',pickupManualAt:s.pickupManualAt||0,pickupManualAction:s.pickupManualAction||'',pickupManualOperation:s.pickupManualOperation||'',pickupConfirmedAt:s.pickupConfirmedAt,
      canPick:boundShipment(state,s)&&!returning&&!archived,displayPickupCode:pickup?(pickup.conflicts.length?'':pickup.code):'',pickupConflict:!!(pickup&&pickup.conflicts.length),pickupId:pickup?pickup.id:'',needsPickupAssignment:!!(pickup&&pickup.needsPickupAssignment),
      canLinkPickup:!linkReason,pickupLinkReason:linkReason,arrivalAtSource:arrival.arrivalAtSource,arrivalAtPrecision:arrival.arrivalAtPrecision,stationSource:s.stationSource||'unknown',
      logisticsEvents:events,logisticsState:detailValid?detail.logisticsState:s.logisticsState||'',logisticsError:s.logisticsError?'本次物流查询未成功，已保留历史轨迹':'',logisticsCheckedAt:s.logisticsCheckedAt||0,logisticsUpdatedAt:s.logisticsUpdatedAt||0,logisticsTruncated:detailValid?detail.logisticsTruncated:!!s.logisticsTruncated};
  }
  function publicPackages(state,codes) {
    var shipsByOrder=Object.create(null),pickupsByOrder=Object.create(null),waitingByOrder=Object.create(null);
    state.shipments.forEach(function(s){if(typeof s.orderId==='string')(shipsByOrder[s.orderId]||(shipsByOrder[s.orderId]=[])).push(s);});
    codes.forEach(function(i){var seen=Object.create(null);i.members.forEach(function(m){var key=m.orderId;if(typeof key!=='string')return;if(!seen[key]){(pickupsByOrder[key]||(pickupsByOrder[key]=[])).push(i.id);seen[key]=true;}if(!m.picked)waitingByOrder[key]=true;});});
    return state.orders.map(function(o){
      var indexed=typeof o.id==='string',ships=indexed?shipsByOrder[o.id]||[]:state.shipments.filter(function(s){return s.orderId===o.id;});
      var active=ships.filter(function(s){return !packageHidden(state,s);});
      var pickupIds=indexed?pickupsByOrder[o.id]||[]:codes.filter(function(i){return i.members.some(function(m){return m.orderId===o.id;});}).map(function(i){return i.id;});
      var waiting=indexed?!!waitingByOrder[o.id]:codes.some(function(i){return i.members.some(function(m){return m.orderId===o.id&&!m.picked;});});
      var unpicked=active.filter(function(s){return !s.picked&&!expiredReceived(state,s);});
      var status=waiting?'pending':active.length&&!unpicked.length?'picked':unpicked.some(function(s){return shipmentStatus(state,s)==='arrived'||(s.status==='unknown'&&s.smsArrivalAt);})?'awaiting_code':unpicked.some(function(s){return shipmentStatus(state,s)==='transit';})?'transit':unpicked.some(function(s){return shipmentStatus(state,s)==='signed';})?'signed':unpicked.some(function(s){return shipmentStatus(state,s)==='returning';})?'returning':unpicked.length&&unpicked.every(function(s){return shipmentStatus(state,s)==='returned';})?'returned':o.source==='manual'?'manual':'unknown';
       var retention=orderRetention(o,Date.now());
       return {id:o.id,source:o.source,familyId:o.familyId||'',familyName:o.familyName||'',platform:o.platform,platformOrderId:o.platformOrderId||'',title:o.title,imageUrl:productImageUrl(o.imageUrl),amount:o.amount,waybillNo:o.waybillNo||'',orderDate:dateOnly(o.dateOverride)||o.orderDate,orderDateSource:o.dateOverride?'manual':o.orderDateSource||(o.source==='manual'?'manual':o.orderDate?'legacy':'unknown'),orderDatePrecision:o.dateOverride?'day':o.orderDatePrecision||'unknown',orderDateOrigin:o.orderDateOrigin||'',dateCheckedAt:o.dateCheckedAt||0,firstSeenAt:o.firstSeenAt||0,tradeStatus:o.tradeStatus||'',status:status,orderStatus:o.orderStatus||'',refundStatus:o.refundStatus||'',archived:retention.archived,retention:retention,archiveRestoredAnchor:o.archiveRestoredAnchor||'',archiveRestoredAt:o.archiveRestoredAt||0,hidden:!!(o.hidden||o.deleted),checked:!!o.checked,shipments:ships.map(function(s){return publicShipment(state,s);}),pickupIds:pickupIds,
        canRefresh:boundOrder(state,o)&&capability(state,'orderRefresh'),canEditDate:boundOrder(state,o)&&capability(state,'orderDateOverride'),dateOverride:o.dateOverride||null,platformOrderDate:o.orderDate||0,platformOrderDateSource:o.orderDateSource||'unknown',dateState:o.dateState||'',dateError:o.dateError?'平台未返回可用下单日期，可重试或手动修改':''};
    }).sort(function(a,b){return b.orderDate-a.orderDate;});
  }
  function currentOperations(state) {return state.operations.filter(function(op){
    if(op.status==='cycle_closed')return false;
    var orderAction=op.action==='setOrderDate'||op.action==='restoreExpiredOrder',owners=orderAction?state.orders:state.shipments,remoteId=orderAction?op.orderId:op.shipmentId;
    return state.online.bound&&op.serviceKey===state.online.serviceKey&&op.deviceId===state.online.deviceId&&owners.some(function(o){return (o.remoteId===remoteId||!orderAction&&(o.remoteAliases||[]).indexOf(remoteId)>=0)&&o.serviceKey===op.serviceKey&&(orderAction?boundOrder(state,o):boundShipment(state,o));});
    }).map(function(op){if(op.action==='setOrderDate')return {id:op.id,orderId:op.orderId,action:op.action,date:op.date,occurredAt:op.occurredAt};if(op.action==='restoreExpiredOrder')return {id:op.id,orderId:op.orderId,action:op.action,anchorDate:op.anchorDate,occurredAt:op.occurredAt};var value={id:op.id,shipmentId:op.shipmentId,action:op.action,occurredAt:op.occurredAt};if(op.pickupCycleId)value.pickupCycleId=op.pickupCycleId;if(op.action==='pick'&&op.pickedAt!==undefined&&op.wirePickedAt===true)value.pickedAt=op.pickedAt;return value;});}
  function clearPickupCycle(state,shipment,evidence,completion) {
    var previous=clone(ensurePickupCycle(state,shipment));previous.status='closed';previous.closedAt=evidence.time;previous.closeReason='logistics_reroute';previous.completion=clone(completion||shipment.pickupCompletion||{picked:!!shipment.picked,manualPicked:shipment.manualPicked});previous.pickupTime=recordedPickup(shipment);
    shipment.pickupCycleHistory.push(previous);
    state.pickupBindings.filter(function(b){return b.shipmentId===shipment.id&&b.cycleId===previous.id&&(b.status==='confirmed'||b.status==='review_required');}).forEach(function(b){bindingStatus(b,'cycle_closed','logistics_reroute');});
    shipment.pickupCycle={id:newId(state,'cycle-'),startedAt:evidence.time,status:'active',evidenceKey:JSON.stringify([evidence.time,evidence.description])};
    state.operations.forEach(function(op){if(op.shipmentId===shipment.remoteId&&op.serviceKey===shipment.serviceKey&&['pick','restore','resumeAutoPickup'].indexOf(op.action)>=0&&(op.localCycleId===previous.id||!op.localCycleId&&op.occurredAt<evidence.time)){op.status='cycle_closed';op.closeReason='pickup_cycle_changed';}});
    delete shipment.manualPicked;shipment.picked=false;
    clearPickupTime(shipment);delete shipment.pickupManualAt;delete shipment.pickupManualAction;delete shipment.pickupManualOperation;delete shipment.pickupConfirmedAt;delete shipment.pickupManualPickedAtSent;
    if(shipment.pickupCompletion)shipment.pickupCompletion={version:1,autoPicked:false,manualOverride:'',completedAt:0,evidence:null};
    var group=groupForShipment(state,shipment.id);shipment.smsArrivalAt=0;
    var correction=shipment.stationCorrection;
    if(correction)delete shipment.stationCorrection;
    if(!group)return;
    liveSources(state,group).forEach(function(source){
      if(!state.pickupBindings.some(function(b){return b.sourceId===source.id&&b.shipmentId===shipment.id&&b.cycleId===previous.id;}))return;
      projectSourceBindings(state,source);
      source.manualUnlinked=!source.linkedShipmentIds.length;source.matchNeedsReview=false;source.matchBasis='物流已改投，旧凭证已结束';if(!source.linkedShipmentIds.length)source.retiredCycleShipmentId=shipment.id;
      if(correction&&!source.linkedShipmentIds.length&&source.stationCorrection&&source.stationCorrection.id===correction.id)delete source.stationCorrection;
    });
    group.history=group.history.filter(function(h){return h.sourceId!==shipment.id;});
    if(liveSources(state,group).length)group.members.forEach(function(member){if(member.shipmentId===shipment.id)member.closedCycleId=previous.id;});
    else group.members=group.members.filter(function(member){return member.shipmentId!==shipment.id;});
    if(correction&&group.stationCorrection&&group.stationCorrection.id===correction.id&&!activeMembers(state,group).some(function(member){return member.shipmentId;}))delete group.stationCorrection;
  }
  function coalesceShipmentAliases(state,existing,input,aliases) {
    var target=existing.slice().sort(function(a,b){
      function weight(ship){return state.operations.filter(function(op){return op.shipmentId===ship.remoteId&&op.serviceKey===ship.serviceKey&&op.status!=='cycle_closed';}).length*100+state.pickupBindings.filter(function(binding){return binding.shipmentId===ship.id;}).length*10+(ship.stationCorrection?5:0)+(ship.remoteId===input.id?1:0);}
      return weight(b)-weight(a);
    })[0];
    existing.forEach(function(ship){
      var remote=ship.remoteCanonicalId||ship.remoteId,bridge=aliases.filter(function(a){return a.oldShipmentId===remote;})[0];
      if(remote!==input.id&&(!bridge||!bridge.sourceCycleId||!bridge.targetCycleId||!input.pickupCycle||bridge.targetCycleId!==input.pickupCycle.id||ship.pickupCycle&&ship.pickupCycle.remoteId&&ship.pickupCycle.remoteId!==bridge.sourceCycleId))fail('包裹身份映射缺少可验证的周期桥，请导出数据核对');
      if(ship!==target&&['manualPicked','manualHidden'].some(function(key){return ship[key]!==undefined&&target[key]!==undefined&&ship[key]!==target[key];}))fail('包裹身份映射与本地人工决定冲突，请导出数据核对');
      if(ship!==target&&ship.stationCorrection&&target.stationCorrection&&ship.stationCorrection.stationId!==target.stationCorrection.stationId)fail('包裹身份映射与本地站点修正冲突，请导出数据核对');
    });
    state.shipmentIdentityHistory=state.shipmentIdentityHistory||[];
    existing.forEach(function(ship){
      if(ship===target)return;
      state.shipmentIdentityHistory.push({shipment:clone(ship),targetShipmentId:target.id,reason:'server_confirmed_alias',mergedAt:Date.now()});
      ['manualPicked','manualHidden','stationCorrection'].forEach(function(key){if(target[key]===undefined&&ship[key]!==undefined)target[key]=clone(ship[key]);});
      if(target.pickedAt===undefined&&ship.pickedAt!==undefined){savePickupTime(target,recordedPickup(ship));target.pickedAtCycleId=ensurePickupCycle(state,target).id;['pickupManualAt','pickupManualAction','pickupManualOperation','pickupConfirmedAt','pickupManualPickedAtSent'].forEach(function(key){if(ship[key]!==undefined)target[key]=ship[key];});}
      if(target.manualPicked!==undefined)target.picked=target.manualPicked;
      if(target.manualHidden!==undefined)target.hidden=target.manualHidden;
      target.remoteAliases=unique((target.remoteAliases||[]).concat(ship.remoteId,ship.remoteCanonicalId||'',ship.remoteAliases||[]));
      var oldCycle=ship.pickupCycle&&ship.pickupCycle.id,newCycle=ensurePickupCycle(state,target).id;
      state.pickupBindings.forEach(function(binding){if(binding.shipmentId===ship.id){binding.identityOrigin=binding.identityOrigin||{shipmentId:ship.id,cycleId:binding.cycleId};binding.shipmentId=target.id;if(binding.cycleId===oldCycle)binding.cycleId=newCycle;}});
      state.items.forEach(function(item){item.members.forEach(function(member){if(member.shipmentId===ship.id){member.shipmentId=target.id;if(member.closedCycleId===oldCycle)member.closedCycleId=newCycle;}});
        var seen={};item.members=item.members.filter(function(member){if(!member.shipmentId||member.closedCycleId)return true;var previous=seen[member.shipmentId];if(!previous){seen[member.shipmentId]=member;return true;}if(member.independentPicked!==undefined)previous.independentPicked=member.independentPicked;return false;});
        item.history.forEach(function(entry){if(entry.sourceId===ship.id)entry.sourceId=target.id;});
      });
      state.operations.forEach(function(op){if(op.shipmentId===ship.remoteId&&op.serviceKey===ship.serviceKey&&op.localCycleId===oldCycle)op.localCycleId=newCycle;});
      state.sources.forEach(function(source){if(source.retiredCycleShipmentId===ship.id)source.retiredCycleShipmentId=target.id;});
      state.shipments=state.shipments.filter(function(row){return row!==ship;});
    });
    state.sources.forEach(function(source){projectSourceBindings(state,source);});
    return target;
  }
  function normalizedPlatformView(input) {
    if(!input||input.version!==1||['transit','arrived','signed','unknown','returning','returned'].indexOf(input.status)<0||['doorstep','station','locker','unknown'].indexOf(input.deliveryMode)<0||typeof input.requiresReceiptConfirmation!=='boolean'||!input.station||!input.quality||!text(input.evidenceKey,300))fail('平台规范结果格式无效');
    var station=input.station,quality={};
    ['arrivalTime','shippedTime','station','courier'].forEach(function(key){var value=input.quality[key];if(!value||['known','unknown','ambiguous'].indexOf(value.state)<0)fail('平台字段质量格式无效');quality[key]={state:value.state,reasonCode:text(value.reasonCode,100)};});
    return {version:1,status:input.status,deliveryMode:input.deliveryMode,requiresReceiptConfirmation:input.requiresReceiptConfirmation,awaitingShipment:input.awaitingShipment===true,station:{rawName:text(station.rawName===undefined?station.displayName:station.rawName,300),id:text(station.id,200),name:text(station.name,200),subLocation:text(station.subLocation,100),displayName:text(station.displayName,300),conflict:station.conflict===true},courierPhones:(Array.isArray(input.courierPhones)?input.courierPhones:[]).slice(0,20).filter(function(value){return value&&/^\+?[\d -]{5,30}$/.test(value.phone);}).map(function(value){return {phone:text(value.phone,30),text:text(value.text,300)};}),quality:quality,evidenceKey:text(input.evidenceKey,300)};
  }
  function detailBinding(state) {return feedbackBinding(state)+'|'+(state.online.bindingEpoch||0);}
  function detailTarget(state,id) {
    var ship=byId(state.shipments,id),order=ship&&byId(state.orders,ship.orderId);
    if(!ship||!ship.platformView||!boundShipment(state,ship)||packageHidden(state,ship))fail('包裹物流详情不可用，请刷新');
    return {id:ship.id,remoteId:ship.remoteCanonicalId||ship.remoteId,orderId:order.remoteId,evidenceKey:ship.platformView.evidenceKey,bindingKey:detailBinding(state)};
  }
  function importMetadata(state,p) {
    var meta=p.meta||p;
    if(!meta||!Array.isArray(meta.accounts)||typeof meta.serverRevision!=='number'||!isFinite(meta.serverRevision)||meta.serverRevision<0)fail('线上元数据格式不兼容');
    if(meta.metadataOnly&&(!state.online.dataVersion||meta.dataVersion!==state.online.dataVersion||p.dataVersion!==undefined&&p.dataVersion!==state.online.dataVersion))fail('同步数据版本不匹配，请重新获取完整快照');
    if(meta.serverRevision<Math.max(state.online.revision,state.online.metadataRevision||0))return;
    if(meta.stationRules!==undefined){
      if(typeof meta.stationRulesVersion!=='number'||!isFinite(meta.stationRulesVersion)||meta.stationRulesVersion<0||Math.floor(meta.stationRulesVersion)!==meta.stationRulesVersion)fail('站点规则版本无效');
      state.stationRules=stationRules(meta.stationRules);state.stationRulesVersion=meta.stationRulesVersion;stationRecognitionCache={};
    }
    if(meta.serverLogisticsRules!==undefined){
      if(typeof meta.serverLogisticsRulesVersion!=='number'||!isFinite(meta.serverLogisticsRulesVersion)||meta.serverLogisticsRulesVersion<0||Math.floor(meta.serverLogisticsRulesVersion)!==meta.serverLogisticsRulesVersion)fail('后台物流规则版本无效');
      state.serverLogisticsRules=serverLogisticsRules(meta.serverLogisticsRules);state.serverLogisticsRulesVersion=meta.serverLogisticsRulesVersion;
    }
    var scope=authorizationScope(meta);
    state.online.accounts=publicAccounts(meta.accounts);state.online.families=publicFamilies(meta.families);state.online.familyIds=scope.familyIds;state.online.legacyAccountIds=scope.legacyAccountIds;state.online.hasFamilyScope=scope.hasFamilyScope;
    state.online.metadataRevision=meta.serverRevision;
    if(meta.serverVersion!==undefined)state.online.serverVersion=text(meta.serverVersion,40);
    if(meta.capabilities!==undefined)state.online.capabilities=(Array.isArray(meta.capabilities)?meta.capabilities:[]).filter(function(value){return typeof value==='string'&&value.length<=100;});
    if(meta.pickupCompletion!==undefined)state.online.pickupCompletion=clone(meta.pickupCompletion);
    importMatchingFeedback(state,meta.matchingFeedback,false);importRecognitionIssues(state,meta.recognitionIssues,false);mergeSnapshotJobs(state,meta);
    state.online.lastSuccessAt=timestamp(p.syncedAt)||Date.now();state.online.error='';state.online.errorCode='';
    if(p.dataVersion!==undefined)state.online.dataVersion=text(p.dataVersion,200);
  }
  function importOnline(state,p) {
    var snap=p.snapshot;
    if(!snap||snap.schemaVersion!==1||!Array.isArray(snap.orders)||!Array.isArray(snap.shipments)||!Array.isArray(snap.accounts)||typeof snap.serverRevision!=='number'||!isFinite(snap.serverRevision)||snap.serverRevision<0)fail('线上数据格式不兼容');
    var importVersion=Number(p.importVersion)||0,serverChanged=!!(snap.serverVersion&&text(snap.serverVersion,40)!==state.online.serverVersion),rulesChanged=snap.stationRulesVersion!==undefined&&snap.stationRulesVersion!==state.stationRulesVersion||snap.serverLogisticsRulesVersion!==undefined&&snap.serverLogisticsRulesVersion!==state.serverLogisticsRulesVersion;
    if(snap.serverRevision<Math.max(state.online.revision,state.online.metadataRevision||0))return;
    importMatchingFeedback(state,snap.matchingFeedback,false);
    importRecognitionIssues(state,snap.recognitionIssues,false);
    if(snap.serverRevision===state.online.revision&&(!snap.dataVersion||snap.dataVersion===state.online.dataVersion)&&importVersion<=(state.online.importVersion||0)&&!serverChanged&&!rulesChanged&&!state.online.needsPickupSync){mergeSnapshotJobs(state,snap);return;}
    if(snap.stationRules!==undefined||snap.stationRulesVersion!==undefined){
      if(typeof snap.stationRulesVersion!=='number'||!isFinite(snap.stationRulesVersion)||snap.stationRulesVersion<0||Math.floor(snap.stationRulesVersion)!==snap.stationRulesVersion)fail('站点规则版本无效');
      state.stationRules=stationRules(snap.stationRules);state.stationRulesVersion=snap.stationRulesVersion;stationRecognitionCache={};
    }
    if(snap.serverLogisticsRules!==undefined||snap.serverLogisticsRulesVersion!==undefined){
      if(typeof snap.serverLogisticsRulesVersion!=='number'||!isFinite(snap.serverLogisticsRulesVersion)||snap.serverLogisticsRulesVersion<0||Math.floor(snap.serverLogisticsRulesVersion)!==snap.serverLogisticsRulesVersion)fail('后台物流规则版本无效');
      state.serverLogisticsRules=serverLogisticsRules(snap.serverLogisticsRules);state.serverLogisticsRulesVersion=snap.serverLogisticsRulesVersion;
    }
    var serviceKey=state.online.serviceKey||'local-fixture',prefix='remote-'+serviceKey+'-';
    var scope=authorizationScope(snap);
    snap.orders.forEach(function(input){
      var id=prefix+text(input.id,200),o=byId(state.orders,id);
      if(!input.id||!text(input.accountId,200).trim()||!canReadRecord(scope,{accountId:text(input.accountId,200),familyId:o&&o.familyId||familyId(input.familyId)})||(o&&o.accountId!==input.accountId))fail('线上订单账号无效');
      if(!o){o={id:id,source:'online',remoteId:text(input.id,200),serviceKey:serviceKey,accountId:text(input.accountId,200)};state.orders.push(o);}
      retainFamily(o,input);
      o.platform=text(input.platform,40)||o.platform||'其他';if(input.platformOrderId!==undefined)o.platformOrderId=text(input.platformOrderId,200);o.title=text(input.title,200)||o.title||'线上包裹';
      o.imageUrl=productImageUrl(input.imageUrl)||productImageUrl(o.imageUrl);
      o.amount=typeof input.amount==='number'&&isFinite(input.amount)&&input.amount>=0?input.amount:null;
      var inputDate=timestamp(input.orderDate);
      if(input.orderDatePrecision!==undefined||(snap.capabilities||[]).indexOf('pickup_confirmed_at_v1')>=0)o.orderDatePrecision=['second','minute','day'].indexOf(input.orderDatePrecision)>=0?input.orderDatePrecision:'unknown';
      var detailCorrection=input.orderDateSource==='platform'&&input.orderDateOrigin==='detail'&&(o.orderDateOrigin!=='detail'||timestamp(input.dateCheckedAt)>=(o.dateCheckedAt||0));
      if(o.orderDateSource!=='platform'||(inputDate&&detailCorrection)){
        o.orderDate=inputDate||o.orderDate||0;
        o.orderDateSource=inputDate&&input.orderDateSource==='platform'?'platform':input.orderDateSource==='unknown'?'unknown':o.orderDate?'legacy':'unknown';
        o.orderDateOrigin=o.orderDateSource==='platform'?(input.orderDateOrigin==='detail'?'detail':'list'):'';
      }
      o.dateCheckedAt=Math.max(o.dateCheckedAt||0,timestamp(input.dateCheckedAt));
      o.dateState=text(input.dateState,30);o.dateError=detailNotice('date',o.dateState,input.dateError);
      var pendingDate=state.operations.some(function(op){return op.action==='setOrderDate'&&op.orderId===o.remoteId&&op.serviceKey===o.serviceKey&&op.deviceId===state.online.deviceId;});
      if(!pendingDate&&timestamp(input.dateOverrideAt)>=(o.dateOverrideAt||0)){
        o.dateOverride=dateOnly(input.dateOverride)?input.dateOverride:null;o.dateOverrideAt=timestamp(input.dateOverrideAt);
      }
      var remoteFirstSeen=timestamp(input.firstSeenAt);
      o.firstSeenAt=o.firstSeenAt&&remoteFirstSeen?Math.min(o.firstSeenAt,remoteFirstSeen):o.firstSeenAt||remoteFirstSeen||timestamp(p.syncedAt)||Date.now();
      var pendingRestore=state.operations.some(function(op){return op.action==='restoreExpiredOrder'&&op.orderId===o.remoteId&&op.serviceKey===o.serviceKey&&op.deviceId===state.online.deviceId;});
      var retention=input.retention,hasRetention=!!(retention&&retention.version===1&&dateOnly(retention.anchorDate)&&(retention.restoredAt===0||timestamp(retention.restoredAt)>0));
      var restoreAt=hasRetention?retention.restoredAt:input.archiveRestoredAt,restoreAnchor=hasRetention?(restoreAt?retention.anchorDate:''):input.archiveRestoredAnchor;
      if(!pendingRestore&&timestamp(restoreAt)>=(o.archiveRestoredAt||0)&&dateOnly(restoreAnchor)){
        o.archiveRestoredAnchor=restoreAnchor;o.archiveRestoredAt=timestamp(restoreAt);
      }
      else if(!pendingRestore&&restoreAnchor===''&&restoreAt===0){o.archiveRestoredAnchor='';o.archiveRestoredAt=0;}
      o.tradeStatus=text(input.tradeStatus,80);o.orderStatus=text(input.orderStatus,80);o.refundStatus=text(input.refundStatus,80);
    });
    snap.shipments.forEach(function(input){
      if(typeof input.pickupPicked==='boolean'){input=clone(input);input.picked=input.pickupPicked;}
      var order=byId(state.orders,prefix+input.orderId);if(!order||order.accountId!==input.accountId)fail('线上运单关联无效');
      var id=prefix+text(input.id,200),s=byId(state.shipments,id),updated=timestamp(input.updatedAt)||(s&&s.updatedAt)||0;
      var aliasRecords=(Array.isArray(snap.shipmentAliases)?snap.shipmentAliases:[]).filter(function(a){return a&&a.targetShipmentId===input.id&&a.accountId===input.accountId&&(!a.platform||a.platform===order.platform);});
      var aliases=aliasRecords.map(function(a){return text(a.oldShipmentId,200);});
      var existing=state.shipments.filter(function(ship){return ship.serviceKey===serviceKey&&ship.accountId===input.accountId&&ship.orderId===order.id&&(ship.remoteId===input.id||aliases.indexOf(ship.remoteId)>=0||(ship.remoteAliases||[]).indexOf(input.id)>=0);});
      if(existing.length>1)s=coalesceShipmentAliases(state,existing,input,aliasRecords);
      if(!s&&existing.length===1)s=existing[0];
      var identityRemap=!!(s&&s.remoteCanonicalId!==input.id&&s.remoteId!==input.id&&aliases.indexOf(s.remoteId)>=0);
      if(!input.id||!input.orderId||!canReadRecord(scope,{accountId:text(input.accountId,200),familyId:s&&s.familyId||familyId(input.familyId)||order.familyId})||(s&&(s.accountId!==input.accountId||s.orderId!==order.id)))fail('线上运单账号无效');
      if(!s){s={id:id,remoteId:text(input.id,200),serviceKey:serviceKey,accountId:input.accountId,orderId:order.id,picked:false,hidden:false};state.shipments.push(s);}
      if(updated<s.updatedAt){importCompletion(state,s,input,Array.isArray(snap.capabilities)&&snap.capabilities.indexOf('pickup_completion_v1')>=0);return;}
      var platformView=input.platformView!==undefined?normalizedPlatformView(input.platformView):s.platformView;
      s.remoteAliases=unique((s.remoteAliases||[]).concat(aliases,input.id));
      s.remoteCanonicalId=text(input.id,200);
      aliasRecords.forEach(function(alias){
        if(!alias.sourceCycleId||!alias.targetCycleId)return;
        var bridge={sourceShipmentId:text(alias.oldShipmentId,200),targetShipmentId:text(input.id,200),sourceCycleId:text(alias.sourceCycleId,128),targetCycleId:text(alias.targetCycleId,128)};
        s.remoteCycleBridges=(s.remoteCycleBridges||[]).filter(function(previous){return previous.sourceShipmentId!==bridge.sourceShipmentId;});s.remoteCycleBridges.push(bridge);
      });
      var remoteCycle=input.pickupCycle;
      if(remoteCycle&&(!/^[A-Za-z0-9_-]{1,128}$/.test(remoteCycle.id)||!timestamp(remoteCycle.startedAt)))fail('取件周期格式无效');
      var wasAutoPicked=!!(s.pickupCompletion&&s.pickupCompletion.autoPicked);
      var previousCompletion=clone(s.pickupCompletion||{picked:!!s.picked,manualPicked:s.manualPicked}),cycleBefore=ensurePickupCycle(state,s).id;
      var completionImported=importCompletion(state,s,input,Array.isArray(snap.capabilities)&&snap.capabilities.indexOf('pickup_completion_v1')>=0);
      var checkedAt=timestamp(input.logisticsCheckedAt);
      var newerEvent=logisticsEvents(input.logisticsEvents).some(function(event){return event.time>Math.max(s.logisticsUpdatedAt||0,s.logisticsCheckedAt||0);});
      if(!platformView&&s.logisticsCheckedAt&&(checkedAt&&checkedAt<s.logisticsCheckedAt||!checkedAt&&!newerEvent)){
        if(!completionImported&&s.manualPicked===undefined&&typeof input.picked==='boolean')s.picked=input.picked;
        if(s.manualHidden===undefined&&typeof input.hidden==='boolean')s.hidden=input.hidden;
        return;
      }
      restorePlatformLogistics(s);
      var preserveCompletedPickup=completionImported&&(wasAutoPicked||s.pickupCompletion.autoPicked||s.completionPickupRetained);
      var preservePickup=!!(s.arrivalAt||s.smsArrivalAt||groupForShipment(state,s.id));
      if(!platformView&&(s.arrivalAt||s.smsArrivalAt)){
        var cycle=ensurePickupCycle(state,s),resets=logisticsEvents(input.logisticsEvents).filter(function(event){return timestamp(event.time)>Math.max(s.arrivalAt||s.smsArrivalAt||0,cycle.startedAt||0)&&actualPickupCycleReset(event);});
        if(resets.length){preserveCompletedPickup=false;preservePickup=false;s.completionPickupRetained=false;clearPickupCycle(state,s,resets[0],previousCompletion);s.arrivalAt=0;s.pickupCode='';s.station='';}
      }
      if(remoteCycle){var localCycle=ensurePickupCycle(state,s);if(!identityRemap&&localCycle.remoteId&&localCycle.remoteId!==remoteCycle.id&&remoteCycle.startedAt>localCycle.startedAt){clearPickupCycle(state,s,{time:remoteCycle.startedAt,description:'后台确认取件周期变更'},previousCompletion);preservePickup=false;s.arrivalAt=0;s.pickupCode='';s.station='';}s.pickupCycle.remoteId=remoteCycle.id;}
      if(cycleBefore!==s.pickupCycle.id)completionImported=importCompletion(state,s,input,Array.isArray(snap.capabilities)&&snap.capabilities.indexOf('pickup_completion_v1')>=0);
      if(preserveCompletedPickup)s.completionPickupRetained=true;
      retainFamily(s,input);if(!s.familyId)retainFamily(s,order);
      if(input.waybillNo!==undefined)s.waybillNo=text(input.waybillNo,60);if(input.carrier!==undefined)s.carrier=text(input.carrier,60);if(input.status!==undefined)s.status=['transit','arrived','signed','unknown'].indexOf(input.status)>=0?input.status:'unknown';
      if(input.shippedAt!==undefined||(snap.capabilities||[]).indexOf('pickup_confirmed_at_v1')>=0){s.shippedAt=timestamp(input.shippedAt);s.shippedAtSource=input.shippedAtSource==='platform_event'?'platform_event':'unknown';s.shippedAtPrecision=['second','minute'].indexOf(input.shippedAtPrecision)>=0?input.shippedAtPrecision:'unknown';}
      s.station=text(input.station,200)||s.station||'';s.arrivalAt=s.arrivalAt||timestamp(input.arrivalAt);
      if(input.arrivalAtSource!==undefined&&(!preservePickup||timestamp(input.arrivalAt))){s.arrivalAt=timestamp(input.arrivalAt);s.arrivalAtSource=['platform_event','locker_arrival','locker_created','unknown'].indexOf(input.arrivalAtSource)>=0?input.arrivalAtSource:'unknown';}
      if(input.arrivalAtPrecision!==undefined&&(!preservePickup||timestamp(input.arrivalAt)))s.arrivalAtPrecision=['second','minute','unknown'].indexOf(input.arrivalAtPrecision)>=0?input.arrivalAtPrecision:'unknown';
      if(input.stationSource!==undefined&&(!preservePickup||text(input.station,200))){s.station=text(input.station,200);s.stationSource=['platform_event','locker','unknown'].indexOf(input.stationSource)>=0?input.stationSource:'unknown';}
      var code=normalize(text(input.pickupCode,40));
      var unresolvedStationCode=s.status==='arrived'&&s.stationSource==='platform_event'&&s.station&&undatedPickupTransition(logisticsEvents(input.logisticsEvents))==='arrival';
      if((s.arrivalAt>0||unresolvedStationCode)&&validCode(code)&&code!==s.pickupCode){s.pickupCode=code;s.codeUpdatedAt=updated;}
      else if(input.arrivalAtSource!==undefined&&input.pickupCode===''&&!preservePickup)s.pickupCode='';
      else s.pickupCode=s.pickupCode||'';
      if(platformView){
        s.platformView=platformView;s.status=platformView.status;
        if(input.platformView&&input.platformView.station.rawName===undefined&&input.station!==undefined)platformView.station.rawName=text(input.station,300);
        s.station=platformView.station.rawName;
        ['arrivalAt','shippedAt'].forEach(function(key){if(input[key]!==undefined)s[key]=timestamp(input[key]);});
        ['arrivalAtSource','arrivalAtPrecision','shippedAtSource','shippedAtPrecision','stationSource'].forEach(function(key){if(input[key]!==undefined)s[key]=text(input[key],60);});
        if(input.pickupCode!==undefined)s.pickupCode=validCode(code)?code:'';
        s.logisticsEvents=[];
      }
      s.updatedAt=updated;
      if(platformView||!checkedAt||checkedAt>=(s.logisticsCheckedAt||0)){
        if(!platformView){var suppliedEvents=logisticsEvents(input.logisticsEvents),oldEvents=s.logisticsEvents||[];s.logisticsEvents=logisticsEvents(suppliedEvents.concat(oldEvents));}
        if(['ok','empty','error','unavailable'].indexOf(input.logisticsState)>=0)s.logisticsState=input.logisticsState;
        s.logisticsError=detailNotice('logistics',s.logisticsState,input.logisticsError);
        s.logisticsCheckedAt=Math.max(s.logisticsCheckedAt||0,checkedAt);
        s.logisticsUpdatedAt=Math.max(s.logisticsUpdatedAt||0,timestamp(input.logisticsUpdatedAt));
        s.logisticsTruncated=platformView?!!input.logisticsTruncated:!!(s.logisticsTruncated||input.logisticsTruncated||(Array.isArray(input.logisticsEvents)&&input.logisticsEvents.length>100));
      }
      if(!completionImported&&cycleBefore===s.pickupCycle.id&&s.manualPicked===undefined&&typeof input.picked==='boolean')s.picked=input.picked;
      if(s.manualHidden===undefined&&typeof input.hidden==='boolean')s.hidden=input.hidden;
      rememberPlatformLogistics(s);
    });
    (snap.deletedIds||[]).forEach(function(id){var o=byId(state.orders,prefix+id),s=byId(state.shipments,prefix+id);if(o)o.deleted=true;if(s)s.deleted=true;});
    (snap.hiddenIds||[]).forEach(function(id){var o=byId(state.orders,prefix+id),s=byId(state.shipments,prefix+id);if(o&&o.manualHidden===undefined)o.hidden=true;if(s&&s.manualHidden===undefined)s.hidden=true;});
    state.online.accounts=publicAccounts(snap.accounts);state.online.families=publicFamilies(snap.families);state.online.familyIds=scope.familyIds;state.online.legacyAccountIds=scope.legacyAccountIds;state.online.hasFamilyScope=scope.hasFamilyScope;state.online.revision=snap.serverRevision;state.online.importVersion=importVersion;state.online.serverVersion=text(snap.serverVersion,40);state.online.capabilities=(Array.isArray(snap.capabilities)?snap.capabilities:[]).filter(function(c){return ['syncJobs','conditionalSync','orderRefresh','orderDateOverride','station_aliases_v1','pickup_completion_v1','pickup_confirmed_at_v1','matching_feedback_v1','station_rule_receipts_v1','recognition_workflow_v1','pickup_cycles_v1','order_retention_v1','normalized_shipments_v1','compact_snapshot_v1','shipment_details_v1'].indexOf(c)>=0;});state.online.lastSuccessAt=timestamp(p.syncedAt)||Date.now();state.online.error='';state.online.errorCode='';
    if(capability(state,'pickup_completion_v1')&&snap.pickupCompletion&&snap.pickupCompletion.version===1){
      state.online.pickupCompletion={version:1,enabled:snap.pickupCompletion.enabled===true,aiEnabled:snap.pickupCompletion.aiEnabled===true,aiState:text(snap.pickupCompletion.aiState,80),message:text(snap.pickupCompletion.message,300)};
    } else delete state.online.pickupCompletion;
    delete state.online.needsPickupSync;
    mergeSnapshotJobs(state,snap);
    if(snap.dataVersion!==undefined)state.online.dataVersion=text(snap.dataVersion,200);
    state.online.metadataRevision=snap.serverRevision;
  }
  function savePackage(state,input) {
    var o=input.id?byId(state.orders,input.id):null;
    if(input.id&&!o)fail('包裹记录已变化，请刷新');
    if(o&&o.source!=='manual')fail('线上订单原始字段不能编辑');
    var title=text(input.title,200).trim(),platform=text(input.platform,40).trim(),date=timestamp(input.orderDate);
     if(!title||!platform||!date)fail('请填写商品、平台和日期');
     var waybillNo=text(input.waybillNo,60).trim();
     if(waybillNo&&!/^[A-Za-z0-9-]{6,32}$/.test(waybillNo))fail('快递单号格式无效');
     if(!o&&input.requireWaybill===true&&!waybillNo)fail('请填写快递单号');
    var amount=input.amount===null||input.amount===''||input.amount===undefined?null:Number(input.amount);
    if(amount!==null&&(!isFinite(amount)||amount<0))fail('金额无效');
    if(!o){o={id:newId(state,'package-'),source:'manual',checked:false};state.orders.push(o);}
     o.title=title;o.platform=platform;o.amount=amount;o.orderDate=date;if(input.checked!==undefined)o.checked=!!input.checked;
     if(waybillNo)o.waybillNo=waybillNo;else if(!o.waybillNo)o.waybillNo='';
  }
  function publicSnapshot(state) {
    // Projection is read-only; discard indexes before the next command can mutate state.
    var previousIndex=snapshotIndex;snapshotIndex=snapshotLookups(state);
    try {
    var ignored = {}, reminders = [], ignoredList = [];
    state.sources.forEach(function (s) {
      if (s.ignored) { ignored[s.id] = true; ignoredList.push({ sourceId: s.id, body: s.body, date: s.date, sender: s.sender, reason: s.reason }); }
      else if (!s.deleted && s.kind && s.kind !== 'pickup') reminders.push({ sourceId: s.id, body: s.body, date: s.date, kind: s.kind });
    });
    var codes=state.items.filter(function(i){return groupVisible(state,i);}).map(function(i){return publicCode(state,i);}).sort(function(a,b){return b.date-a.date;});
    var operations=currentOperations(state),online=clone(state.online);online.pendingCount=operations.length;online.serverRevision=state.online.revision;online.recognitionIssues=recognitionIssueSummary(state);delete online.serviceKey;delete online.revision;delete online.hasFamilyScope;
    return { codes: codes, packages:publicPackages(state,codes), families:clone(online.families),familyIds:clone(online.familyIds),packagesMigrated:!!state.packagesMigrated, online:online,operations:operations,stationRulesVersion:state.stationRulesVersion,stationRules:clone(state.stationRules),stationChoices:stationChoices(state),matchingFeedback:matchingFeedbackSummary(state),stationEnhancement:{enabled:state.settings.stationEnhancement,pendingCount:state.stationEnhancement.pending.filter(function(candidate){return candidateActive(state,candidate);}).length,lastUploadAt:state.stationEnhancement.lastUploadAt||0,lastError:state.stationEnhancement.lastError||''},reminders: reminders.sort(function (a,b) { return b.date-a.date; }), ignored: ignoredList.sort(function (a,b) { return b.date-a.date; }), rules: state.rules, logisticsRules:clone(state.logisticsRules), settings: state.settings, lastScanAt: state.lastScanAt, summary: state.summary, migrated: state.migrated };
    } finally { snapshotIndex=previousIndex; }
  }
  function newId(state, prefix) { state.sequence++; return prefix + state.sequence; }
  function sourceFor(state, id) { return state.sources.filter(function (s) { return s.id === id; })[0]; }
  function itemFor(state, id) { var found = state.items.filter(function (i) { return i.id === id && !i.deleted; })[0]; if (!found) fail('记录已变化，请刷新后重试'); return found; }
  function fromParsed(state, source, result) {
    source.kind = result.kind;
    if (result.kind !== 'pickup') return;
    var i={ id: newId(state, 'item-'), sourceId: source.id,sourceIds:[source.id],members:[],history:[], code: result.code, date: source.date, sendDate: time(source.date), company: result.express || '未知快递', address: result.address || '未知地址', isPicked: false, isManual: false, tags: [], remark: '', protected: false };
    addMembers(state,i,result.packageCount);recordCode(i,result.code,'短信',source.date,source.id);state.items.push(i);
  }
  function unlinkPickupSource(state,source,shipmentId) {
    var links=sourceLinks(state,source),remove=shipmentId?[shipmentId]:links.slice(),item=sourceItem(state,source),parsed=sourceParsed(state,source);
    if(shipmentId&&links.indexOf(shipmentId)<0)fail('该包裹没有关联此短信');
    feedbackRows(state).forEach(function(row){if(row.payload.kind==='manual_match'&&row.local.sourceId===source.id&&remove.indexOf(row.local.shipmentId)>=0)withdrawFeedback(row);});
    var kept=links.filter(function(id){return remove.indexOf(id)<0;});
    function claimed(id){return state.sources.some(function(other){return other!==source&&!other.ignored&&!other.deleted&&sourceLinks(state,other).indexOf(id)>=0;});}
    if(item&&links.length){
      if(kept.length){
        item.members.forEach(function(member){if(remove.indexOf(member.shipmentId)>=0&&!claimed(member.shipmentId)){var oldId=member.shipmentId;member.shipmentId='';item.history=item.history.filter(function(h){return h.sourceId!==oldId;});}});
      }else{
        var affected=item.members.filter(function(m){return links.indexOf(m.shipmentId)>=0||!m.shipmentId;}),count=Math.max(1,Math.min(50,Number(parsed.packageCount)||1));
        var picked=Math.min(count,affected.filter(function(m){return m.picked;}).length+(item.unassignedPickedCount||0));
        var oldPicked=affected.filter(function(m){return m.picked;}).map(function(m){var ship=byId(state.shipments,m.shipmentId);return recordedPickup(m.independentPicked!==undefined?m:ship||m);});
        item.sourceIds=item.sourceIds.filter(function(id){return id!==source.id;});item.sourceId=item.sourceIds[0]||'';
        var restored=source.originalItemId&&byId(state.items,source.originalItemId);
        if(restored&&restored!==item){restored.mergedInto='';restored.deleted=false;restored.sourceIds=[source.id];restored.sourceId=source.id;restored.members=[];addMembers(state,restored,count);}
        else {fromParsed(state,source,parsed);restored=state.items[state.items.length-1];}
        restored.members.forEach(function(m,index){m.shipmentId='';m.picked=index<picked;if(m.picked)savePickupTime(m,oldPicked[index]||item.unassignedPickupTime||{at:0,source:'unknown',precision:'unknown'});else clearPickupTime(m);});restored.unassignedPickedCount=0;delete restored.unassignedPickupTime;source.originalItemId=restored.id;
        if(item.protected){['remark','address','company','code','codeOverride','protected','tags'].forEach(function(k){if(item[k]!==undefined)restored[k]=clone(item[k]);});}
        item.members=item.members.filter(function(m){var ship=byId(state.shipments,m.shipmentId);return remove.indexOf(m.shipmentId)<0||claimed(m.shipmentId)||(ship&&validCode(ship.pickupCode));});
      }
    }
    state.pickupBindings.filter(function(b){return b.sourceId===source.id&&remove.indexOf(b.shipmentId)>=0&&(b.status==='confirmed'||b.status==='review_required');}).forEach(function(b){bindingStatus(b,'user_unlinked','user_unlinked');});projectSourceBindings(state,source);source.manualUnlinked=!kept.length;source.manualLinked=!!kept.length;source.matchNeedsReview=false;source.matchBasis=kept.length?'人工匹配':'';source.candidateShipmentIds=[];
  }
  function linkPickupSource(state,source,payload) {
    if(!source||source.ignored||source.deleted||sourceParsed(state,source).kind!=='pickup')fail('短信来源已变化');
    var ids=unique(Array.isArray(payload.shipmentIds)?payload.shipmentIds:[payload.shipmentId]),old=sourceLinks(state,source),parsed=sourceParsed(state,source),before=sourceItem(state,source);
    var priorCount=before?before.members.filter(function(m){return m.picked&&(!m.shipmentId||old.indexOf(m.shipmentId)>=0);}).length+(before.unassignedPickedCount||0):0;
    var priorTime=before?commonPickupTime(before.members.filter(function(m){return !m.shipmentId||old.indexOf(m.shipmentId)>=0;})):{at:0,source:'unknown',precision:'unknown'};
    if(!ids.length||ids.length>Math.max(1,Math.min(50,Number(parsed.packageCount)||1)))fail('请选择不超过短信件数的具体包裹');
    if(old.length&&!payload.replace&&JSON.stringify(old.slice().sort())!==JSON.stringify(ids.slice().sort()))fail('请先解除原关联，或明确重新匹配');
    ids.forEach(function(id){var ship=byId(state.shipments,id);if(!ship)fail('来源或包裹已变化');var reason=matchLinkReason(state,ship,source,false);if(reason)fail(reason);var conflict=matchConflict(state,source,ship);if(conflict&&!payload.allowConflict)fail(conflict+'，请核对后确认');});
    if(!source.lastMatchCorrectionId||!source.manualLinked||JSON.stringify(old.slice().sort())!==JSON.stringify(ids.slice().sort())){source.lastMatchCorrectionId=newId(state,'correction-');correctionEvent(state,source.lastMatchCorrectionId,'manual_match',rawSourceStation(state,source),'已关联 '+ids.length+' 个包裹',{sourceIds:[source.id],shipmentIds:ids});}
    if(old.length&&JSON.stringify(old.slice().sort())!==JSON.stringify(ids.slice().sort()))unlinkPickupSource(state,source);
    ids.forEach(function(id){mergeSource(state,source,byId(state.shipments,id),true);});
    projectSourceBindings(state,source);source.manualUnlinked=false;source.manualLinked=true;source.matchBasis='人工匹配';source.matchNeedsReview=false;
    var group=sourceItem(state,source),remaining=Math.max(0,(Number(parsed.packageCount)||1)-ids.length),anonymous=group.members.filter(function(m){return !m.shipmentId;}).length;
    if(remaining>anonymous)addMembers(state,group,group.members.length+remaining-anonymous);
    group.members.forEach(function(member){if(ids.indexOf(member.shipmentId)>=0){delete member.independentPicked;member.picked=!!byId(state.shipments,member.shipmentId).picked;}});
    if(priorCount>=(Number(parsed.packageCount)||1)){
      var pickedAnonymous=remaining;
      group.members.forEach(function(member){if(!member.shipmentId&&pickedAnonymous>0){member.picked=true;savePickupTime(member,priorTime);pickedAnonymous--;}else if(ids.indexOf(member.shipmentId)>=0&&!member.picked)setMemberPicked(state,member,true,false,priorTime);});
    }
    queueManualMatch(state,source);
  }
  function dispatch(stateJson, requestJson) {
    var state = stateJson ? JSON.parse(stateJson) : initial();
    if (state.version !== 1) fail('数据版本不兼容，请保留备份');
    extendState(state);
    stationRecognitionCache={};
    restoreStationProjection(state);refreshLocalLogistics(state);applyStationCorrections(state);
    var request = JSON.parse(requestJson), action = request.action, p = request.payload || {}, now = Date.now(), item, source, rule;
    if(action==='testLogisticsRule')return JSON.stringify({state:state,result:logistics.test(p.rule,p.sample)});
    if(action==='syncMeta') {
      if(p.bound===false||(p.baseUrl&&p.deviceId&&(p.baseUrl!==state.online.baseUrl||p.deviceId!==state.online.deviceId))){state.online.bindingEpoch=(state.online.bindingEpoch||0)+1;delete state.online.metadataRevision;delete state.online.dataVersion;}
      if(p.bound===false||(p.baseUrl&&p.deviceId&&(p.baseUrl!==state.online.baseUrl||p.deviceId!==state.online.deviceId))){state.recognitionIssues={items:[],lastError:''};delete state.matchingFeedback.configured;delete state.matchingFeedback.enabled;delete state.matchingFeedback.autoApply;state.matchingFeedback.lastError='';state.matchingFeedback.lastUploadAt=0;}
      if(p.bound===false||(p.baseUrl&&p.deviceId&&(p.baseUrl!==state.online.baseUrl||p.deviceId!==state.online.deviceId))){state.online.revision=-1;state.online.importVersion=0;state.online.jobs=[];state.online.capabilities=[];delete state.online.pickupCompletion;delete state.online.ruleReceipt;delete state.online.needsPickupSync;state.online.serverVersion='';state.online.families=[];state.online.familyIds=[];state.online.legacyAccountIds=[];state.online.hasFamilyScope=false;state.stationRules=[];state.stationRulesVersion=0;state.serverLogisticsRules=[];state.serverLogisticsRulesVersion=0;state.stationEnhancement.pending=[];state.stationEnhancement.sentIds=[];state.stationEnhancement.lastUploadAt=0;state.stationEnhancement.lastError='';}
      ['bound','baseUrl','deviceId','accounts','lastSuccessAt','errorCode','error'].forEach(function(k){if(p[k]!==undefined)state.online[k]=clone(p[k]);});
      if(p.accounts!==undefined)state.online.accounts=publicAccounts(p.accounts);
      if(p.families!==undefined)state.online.families=publicFamilies(p.families);
      if(p.familyIds!==undefined){var metaScope=authorizationScope(p);state.online.familyIds=metaScope.familyIds;state.online.legacyAccountIds=metaScope.legacyAccountIds;state.online.hasFamilyScope=true;}
      else if(p.legacyAccountIds!==undefined)state.online.legacyAccountIds=publicIds(p.legacyAccountIds);
      else if(!state.online.hasFamilyScope&&(p.accounts!==undefined||p.accountIds!==undefined))state.online.legacyAccountIds=authorizationScope(p).legacyAccountIds;
      if(p.jobs!==undefined)state.online.jobs=publicJobs(p.jobs);
      if(p.baseUrl)state.online.serviceKey=hash(p.baseUrl.replace(/\/+$/,''));
    } else if(action==='syncMetadata') {importMetadata(state,p);
    } else if(action==='shipmentDetailTarget') {return JSON.stringify({state:state,result:detailTarget(state,p.id)});
    } else if(action==='importShipmentDetails') {
      var target=detailTarget(state,p.id);
      if(p.bindingKey!==target.bindingKey||p.shipmentId!==target.remoteId||p.orderId!==target.orderId||p.evidenceKey!==target.evidenceKey)fail('物流详情已过期，请重新加载');
      if(!Array.isArray(p.logisticsEvents)||['ok','empty','error','unavailable'].indexOf(p.logisticsState)<0)fail('物流详情格式无效');
      byId(state.shipments,p.id).shipmentDetails={bindingKey:target.bindingKey,evidenceKey:target.evidenceKey,logisticsEvents:logisticsEvents(p.logisticsEvents),logisticsState:p.logisticsState,logisticsTruncated:!!p.logisticsTruncated||p.logisticsEvents.length>100};
    } else if(action==='syncImport') {restoreStationProjection(state);importOnline(state,p);
    } else if(action==='refreshStations') {state.shipments.forEach(function(s){if(!s.picked&&!s.hidden&&!s.deleted&&!shipmentArchived(state,s)&&(!trustedArrival(s)||!recognizeStation(state,s.station).id&&!activeCorrection(state,s)))delete s.localStationRulesVersion;});
    } else if(action==='setStation'||action==='resetStation') {changeStation(state,p,action==='resetStation');
    } else if(action==='matchingFeedbackBatch') {return JSON.stringify({state:state,result:matchingFeedbackBatch(state)});
    } else if(action==='matchingFeedbackAck') {importMatchingFeedback(state,p,true);
    } else if(action==='recognitionIssueBatch') {return JSON.stringify({state:state,result:recognitionIssueBatch(state)});
    } else if(action==='recognitionIssueAck') {importRecognitionIssues(state,p,true);
    } else if(action==='recognitionIssueFailed') {state.recognitionIssues.lastError='识别问题上传未完成，将在下次同步重试';
    } else if(action==='matchingFeedbackAttempt') {feedbackRows(state).forEach(function(row){if((p.items||[]).some(function(sent){return sent.id===row.id&&sent.revision===row.revision;})){row.attempts=(row.attempts||0)+1;row.lastAttemptAt=Date.now();}});
    } else if(action==='stationRuleReceiptBatch') {var receipt=state.online.ruleReceipt;return JSON.stringify({state:state,result:{pending:!!(state.online.bound&&capability(state,'station_rule_receipts_v1')&&(!receipt||receipt.stationRulesVersion!==state.stationRulesVersion||receipt.serverLogisticsRulesVersion!==state.serverLogisticsRulesVersion)),stationRulesVersion:state.stationRulesVersion,serverLogisticsRulesVersion:state.serverLogisticsRulesVersion}});
    } else if(action==='stationRuleReceiptAck') {if(capability(state,'station_rule_receipts_v1')&&p.stationRulesVersion===state.stationRulesVersion&&p.serverLogisticsRulesVersion===state.serverLogisticsRulesVersion)state.online.ruleReceipt={stationRulesVersion:p.stationRulesVersion,serverLogisticsRulesVersion:p.serverLogisticsRulesVersion,acknowledgedAt:Date.now()};
    } else if(action==='matchingFeedbackFailed') {state.matchingFeedback.lastError='人工学习样本上传未完成，将在下次同步重试';
    } else if(action==='syncAck') {
      state.operations=state.operations.filter(function(op){
        var accepted=(p.appliedIds||[]).indexOf(op.id)>=0&&op.serviceKey===state.online.serviceKey&&op.deviceId===state.online.deviceId;
        if(accepted&&op.status==='cycle_closed'){op.acknowledgedAt=Date.now();return true;}
        if(accepted&&capability(state,'pickup_completion_v1')&&['pick','restore','resumeAutoPickup'].indexOf(op.action)>=0)state.online.needsPickupSync=true;
        return !accepted;
      });
    } else if(action==='stationCandidateBatch') {return JSON.stringify({state:state,result:stationCandidateBatch(state)});
    } else if(action==='stationCandidateAck') {
      var accepted=state.stationEnhancement.pending.filter(function(candidate){return (p.acceptedIds||[]).indexOf(candidate.id)>=0;}).map(function(candidate){return candidate.id;});
      state.stationEnhancement.pending=state.stationEnhancement.pending.filter(function(candidate){return accepted.indexOf(candidate.id)<0;});
      state.stationEnhancement.sentIds=unique(state.stationEnhancement.sentIds.concat(accepted)).slice(-1000);
      if(accepted.length){state.stationEnhancement.lastUploadAt=timestamp(p.uploadedAt)||now;state.stationEnhancement.lastError='';}
    } else if(action==='stationCandidateFailed') {if(state.settings.stationEnhancement)state.stationEnhancement.lastError='站点片段上传未完成，将在下次同步重试';
    } else if(action==='migratePackages') {
      if(!state.packagesMigrated){
        if(!Array.isArray(p.legacyPackages))fail('原包裹数据无效，已保留备份');
        p.legacyPackages.forEach(function(group){(group.list||[]).forEach(function(old){savePackage(state,{title:old.name||old.title,platform:old.platform||'其他',amount:old.price,orderDate:timestamp(old.date)||timestamp(group.date)||now,checked:!!old.checked});});});
        state.packagesMigrated=true;
      }
    } else if(action==='onlineOrderTarget') {
      var target=byId(state.orders,p.id);if(!boundOrder(state,target)||target.hidden||target.deleted)fail('订单不属于当前绑定账号，请重新绑定或刷新');
      return JSON.stringify({state:state,result:{orderId:target.remoteId}});
    } else if(action==='setOrderDate') {
      var dated=byId(state.orders,p.id);if(!boundOrder(state,dated)||dated.hidden||dated.deleted)fail('订单不属于当前绑定账号');
      if(!capability(state,'orderDateOverride'))fail('请先将后台升级到3.1.5或以上版本');
      if(p.date!==null&&!dateOnly(p.date))fail('请输入有效日期（YYYY-MM-DD）');
      dated.dateOverride=p.date;dated.dateOverrideAt=Math.max(now,(dated.dateOverrideAt||0)+1);
      state.operations.push({id:state.clientId+'-'+newId(state,'op-'),orderId:dated.remoteId,action:'setOrderDate',date:p.date,occurredAt:dated.dateOverrideAt,serviceKey:dated.serviceKey,deviceId:state.online.deviceId});
    } else if(action==='restoreExpiredOrder') {
      var expiredOrder=byId(state.orders,p.id);if(!expiredOrder||expiredOrder.source==='online'&&!boundOrder(state,expiredOrder))fail('订单不在当前授权范围');
      var expiredState=orderRetention(expiredOrder,now);if(!expiredState.archived)fail('订单未过期或已恢复');
      expiredOrder.archiveRestoredAnchor=expiredState.anchorDate;expiredOrder.archiveRestoredAt=Math.max(now,(expiredOrder.archiveRestoredAt||0)+1);
      if(boundOrder(state,expiredOrder)&&capability(state,'order_retention_v1'))state.operations.push({id:state.clientId+'-'+newId(state,'op-'),orderId:expiredOrder.remoteId,action:'restoreExpiredOrder',anchorDate:expiredState.anchorDate,occurredAt:expiredOrder.archiveRestoredAt,serviceKey:expiredOrder.serviceKey,deviceId:state.online.deviceId});
    } else if(action==='pickShipments'||action==='resumeAutoPickup') {
      if(action==='resumeAutoPickup'&&!capability(state,'pickup_completion_v1'))fail('请先升级支持自动完成的后台');
      var pickedOrder=byId(state.orders,p.orderId),selected=unique(p.shipmentIds||[]);
      if(!pickedOrder||!Array.isArray(p.shipmentIds)||!selected.length)fail('请选择本次领取的运单');
      if(!boundOrder(state,pickedOrder))fail('订单不属于当前绑定账号，请重新绑定后操作');
      var selectedShips=selected.map(function(id){return byId(state.shipments,id);});
      if(selectedShips.some(function(s){return !s||s.orderId!==pickedOrder.id||packageHidden(state,s)||!boundShipment(state,s);}))fail('运单已变化，请刷新后重试');
      if(selectedShips.some(function(s){var g=groupForShipment(state,s.id);return g&&g.unassignedPickedCount;}))fail('请先在取件详情确认此前已取包裹');
      selectedShips.forEach(function(s){
        if(action==='resumeAutoPickup'){
          if(!s.pickupCompletion)fail('请先同步包裹的自动完成状态');
          s.pickupCompletion.manualOverride='';delete s.manualPicked;clearPickupTime(s);savePickupTime(s,{at:0,source:'unknown',precision:'unknown'});s.pickupConfirmedAt=0;queueOperation(state,s,'resumeAutoPickup');
        } else setShipmentPicked(state,s,p.picked!==false,s.picked?recordedPickup(s):{at:now,source:'user_confirmed',precision:'second'});
      });
    } else if(action==='savePackage') {savePackage(state,p.order||{});
    } else if(action==='removePackage'||action==='restorePackage') {
      var order=byId(state.orders,p.id);if(!order)fail('未找到包裹记录');
      var hide=action==='removePackage';order.hidden=hide;order.manualHidden=hide;if(!hide)order.deleted=false;
      state.shipments.filter(function(s){return s.orderId===order.id;}).forEach(function(s){s.hidden=hide;s.manualHidden=hide;if(!hide)s.deleted=false;queueOperation(state,s,hide?'hide':'unhide');
        if(!hide){var g=groupForShipment(state,s.id);if(g)g.deleted=false;}
      });
    } else if(action==='pickMembers') {
      item=itemFor(state,p.id);if(!Array.isArray(p.memberIds)||!p.memberIds.length)fail('请选择本次领取的包裹');
      if(item.unassignedPickedCount)fail('请先确认此前已取包裹，或明确全部领取');
      var pickable=activeMembers(state,item);
      if(p.memberIds.some(function(id){return !byId(pickable,id);}))fail('包裹已变化，请重新选择');
      pickable.forEach(function(m){if(p.memberIds.indexOf(m.id)>=0)setMemberPicked(state,m,p.picked!==false,groupNeedsMatchReview(state,item),m.picked?recordedPickup(m):{at:now,source:'user_confirmed',precision:'second'});});
    } else if(action==='assignPickedMembers') {
      item=itemFor(state,p.id);var pickedIds=unique(p.memberIds||[]),assignable=activeMembers(state,item).filter(function(m){return !m.picked;});
      if(!item.unassignedPickedCount||pickedIds.length!==item.unassignedPickedCount||pickedIds.some(function(id){return !byId(assignable,id);}))fail('请选择此前已取的对应包裹');
      assignable.forEach(function(m){if(pickedIds.indexOf(m.id)>=0)setMemberPicked(state,m,true,false,item.unassignedPickupTime||{at:0,source:'unknown',precision:'unknown'});});item.unassignedPickedCount=0;delete item.unassignedPickupTime;
    } else if(action==='linkSource') {
      linkPickupSource(state,sourceFor(state,p.sourceId),p);
    } else if(action==='unlinkSource') {
      source=sourceFor(state,p.sourceId);if(!source)fail('未找到短信来源');
      unlinkPickupSource(state,source,p.shipmentId);
    } else if(action==='resolveCode') {
      item=itemFor(state,p.id);var chosen=text(p.code,40);
      if(!validCode(chosen)||!item.history.some(function(h){return h.code===chosen;}))fail('请选择已有来源中的取件码');
      item.code=chosen;item.codeOverride=true;item.protected=true;item.resolvedCodes=unique(item.history.map(function(h){return h.code;}));
    } else if (action === 'migrate' && !state.migrated) {
      (p.legacyCodes || []).forEach(function (old) {
        if (!old || !text(old.code)) return;
        var date = timestamp(old.date) || timestamp(old.sendDate) || now;
        state.items.push({ id: newId(state,'legacy-'), sourceId: '', code: text(old.code,40), date: date, sendDate: old.sendDate || time(date), company: text(old.company,100), address: text(old.address,200), isPicked: !!old.isPicked, isManual: !!old.isManual, tags: (old.tags || []).slice(0,10), remark: text(old.remark,500), protected: true, legacy: true });
      });
      (p.legacyRules || []).forEach(function (old) { try { var r = validateRule(old); r.id = newId(state,'rule-'); state.rules.push(r); } catch (_) { /* Original storage is retained for invalid legacy rule recovery. */ } });
      state.migrated = true;
    } else if (action === 'ingest') {
      var summary = { added: 0, reminders: 0, ignored: 0 };
      if (!Array.isArray(p.messages)) fail('短信数据无效');
      p.messages.forEach(function (message) {
        var body = text(message.body), date = Number(message.date), sender = text(message.address,100);
        if (!body || !isFinite(date) || date <= 0) return;
        var fingerprint = JSON.stringify([String(message.id || ''),sender,date,body]);
        var existing = state.sources.filter(function (s) { return s.fingerprint === fingerprint; })[0];
        if (existing) { existing.receivedAt=timestamp(message.receivedAt)||existing.receivedAt||date;if(timestamp(message.sentAt))existing.sentAt=timestamp(message.sentAt);if (existing.ignored) summary.ignored++; return; }
        var result = parse(body,state.rules);
        if (!result) {queueStationCandidate(state,body,'','',date);return;} // Unknown pickup SMS retains only a public place fragment after explicit opt-in.
        var s = { id: 'sms-' + hash(fingerprint), fingerprint: fingerprint, sender: sender, body: body, date: date, receivedAt:timestamp(message.receivedAt)||date,sentAt:timestamp(message.sentAt),kind: result.kind, parsed:result, ignored: false, reason: '', deleted: false };
        if (sourceFor(state,s.id)) s.id = newId(state,'sms-collision-');
        state.sources.push(s);
        // Attach only an unambiguous timestamp+code legacy item, never dedupe globally by code.
        var legacy = state.items.filter(function (i) { return i.legacy && !i.sourceId && !i.isManual && i.code === result.code && Math.abs(i.date-date)<1000; });
        if (legacy.length===1) legacy[0].sourceId=s.id;
        else { fromParsed(state,s,result); if(result.kind==='pickup') summary.added++; else summary.reminders++; }
      });
      state.lastScanAt = Number(p.scannedAt) || now; state.summary = summary;
    } else if (action === 'add') {
      var input = p.item || {}, code = normalize(text(input.code)).replace(/\s/g,'');
      if (!validCode(code)) fail('请输入有效的取件码');
      state.items.push({ id:newId(state,'manual-'), sourceId:'', code:code, date:now, sendDate:time(now), company:text(input.company,100)||'手动添加', address:text(input.address,200)||'手动添加', isPicked:false, isManual:true, tags:[], remark:'', protected:true });
    } else if (action === 'update') {
      item = itemFor(state,p.id); var patch = p.patch || {};
      if(patch.address!==undefined&&activeCorrection(state,item))changeStation(state,{pickupId:item.id},true);
      if (patch.code !== undefined) { var nextCode=normalize(text(patch.code)).replace(/\s/g,''); if(!validCode(nextCode)) fail('请输入有效的取件码'); item.code=nextCode; item.protected=true; item.codeOverride=true; }
      ['company','address','remark'].forEach(function(k){if(patch[k]!==undefined){item[k]=text(patch[k],k==='remark'?500:200);item.protected=true;}});
      if (Array.isArray(patch.tags)) item.tags=patch.tags.slice(0,10).map(function(t){return text(t,30);});
      if (patch.isPicked !== undefined) {item.unassignedPickedCount=0;delete item.unassignedPickupTime;item.isPicked=!!patch.isPicked;activeMembers(state,item).forEach(function(m){setMemberPicked(state,m,!!patch.isPicked,groupNeedsMatchReview(state,item),m.picked?recordedPickup(m):{at:now,source:'user_confirmed',precision:'second'});});}
    } else if (action === 'remove') {
      state.items.forEach(function(i){if((p.ids||[]).indexOf(i.id)>=0){i.deleted=true;i.sourceIds.forEach(function(id){var s=sourceFor(state,id);if(s)s.deleted=true;});i.members.forEach(function(m){var s=byId(state.shipments,m.shipmentId);if(s){s.hidden=true;s.manualHidden=true;queueOperation(state,s,'hide');}});}});
    } else if (action === 'ignore') {
      if (p.itemId) item=itemFor(state,p.itemId);
      source=sourceFor(state,p.sourceId||(item&&item.sourceId));
      if(!source) fail('这条记录没有关联短信，无法自动忽略；可删除记录');
      source.ignored=true; source.reason=text(p.reason,200).trim();
    } else if (action === 'restore') {
      source=sourceFor(state,p.sourceId);if(!source)fail('未找到忽略记录');
      source.ignored=false; source.reason='';
      var restored=parse(source.body,state.rules);
      source.parsed=restored;
      var linked=state.items.filter(function(i){return i.sourceId===source.id&&!i.deleted;});
      if(!linked.some(function(i){return i.protected;})){
        if(restored&&restored.kind==='pickup'){
          if(linked.length){linked[0].code=restored.code;linked[0].company=restored.express||'未知快递';linked[0].address=restored.address||'未知地址';}
          else fromParsed(state,source,restored);
        } else linked.forEach(function(i){i.deleted=true;});
        source.kind=restored?restored.kind:'';
      }
    } else if (action === 'saveLogisticsRule') {
      var logisticsInput=clone(p.rule||{});if(!logisticsInput.id)logisticsInput.id=newId(state,'logistics-');
      rule=logistics.validateRule(logisticsInput);
      var logisticsExists=!!byId(state.logisticsRules,rule.id);
      var nextLogistics=state.logisticsRules.map(function(r){return r.id===rule.id?rule:r;});if(!logisticsExists)nextLogistics.unshift(rule);
      state.logisticsRules=logistics.validateRules(nextLogistics);state.logisticsRulesRevision++;
    } else if (action === 'toggleLogisticsRule') {
      if(typeof p.enabled!=='boolean'||!byId(state.logisticsRules,p.id))fail('物流规则不存在或状态无效');
      state.logisticsRules=logistics.validateRules(state.logisticsRules.map(function(r){var next=clone(r);if(next.id===p.id)next.enabled=p.enabled;return next;}));state.logisticsRulesRevision++;
    } else if (action === 'deleteLogisticsRule') {
      if(!byId(state.logisticsRules,p.id))fail('物流规则不存在');
      state.logisticsRules=state.logisticsRules.filter(function(r){return r.id!==p.id;});state.logisticsRulesRevision++;
    } else if (action === 'resetLogisticsRules') {
      state.logisticsRules=logistics.defaults();state.logisticsRulesRevision++;
    } else if (action === 'saveRule') {
      rule=validateRule(p.rule);
      if(state.rules.some(function(r){return r.name===rule.name&&r.id!==rule.id;}))fail('规则名称已存在');
      if(rule.smsContent){var preview=clone(rule);preview.enabled=true;var result=parse(rule.smsContent,[preview],false);if(!result||(rule.kind==='pickup'&&rule.expectedCode&&result.code!==rule.expectedCode))fail('样例未通过验证，请检查规则');}
      if(!rule.id)rule.id=newId(state,'rule-');
      rule.createTime=rule.createTime||time(now);
      var ri=-1;state.rules.forEach(function(r,i){if(r.id===rule.id)ri=i;});
      if(ri>=0)state.rules[ri]=rule;else state.rules.push(rule);
    } else if (action === 'deleteRule') { state.rules=state.rules.filter(function(r){return r.id!==p.id;});
    } else if (action === 'toggleRule') { state.rules.forEach(function(r){if(r.id===p.id)r.enabled=!!p.enabled;});
    } else if (action === 'settings') { ['autoScan','widgetPrivacy','stationEnhancement','manualLearning'].forEach(function(k){if(p[k]!==undefined)state.settings[k]=!!p[k];});if(p.stationEnhancement===false){state.stationEnhancement.pending=[];state.stationEnhancement.lastError='';}
    } else if (action === 'clearTag') {state.items.forEach(function(i){i.tags=i.tags.filter(function(t){return t!==p.tag;});});
    } else if (action !== 'snapshot' && action !== 'migrate') fail('不支持的操作');
    extendState(state);restoreStationProjection(state);refreshLocalLogistics(state);applyStationCorrections(state);reconcileOnline(state);applyStationCorrections(state);refreshStationCandidates(state);refreshMatchingFeedback(state);
    if(['snapshot','migrate','recognitionIssueAck','recognitionIssueFailed','matchingFeedbackAck','matchingFeedbackAttempt','matchingFeedbackFailed','stationCandidateAck','stationCandidateFailed','stationRuleReceiptAck'].indexOf(action)<0)refreshRecognitionIssues(state);
    return JSON.stringify({ state:state, result:publicSnapshot(state) });
  }
  return { dispatch:dispatch, parse:parse, builtins:builtins, validateRule:validateRule, validateCandidate:validateCandidate, validCode:validCode };
})();
if (typeof globalThis !== 'undefined') globalThis.PickCodeCore = PickCodeCore;
