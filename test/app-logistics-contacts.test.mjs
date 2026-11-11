import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, phoneSegments, courierPhones } from '../app-source/pickcode/services/logistics-contacts.js';

test('完整手机号保留原文格式并提供规范拨号值', () => {
  for (const [input, expected] of [['13800000001','13800000001'],['138 0000 0001','13800000001'],['138-0000-0001','13800000001'],['+86 138-0000-0001','+8613800000001'],['0086-13800000001','+8613800000001']]) {
    assert.equal(normalizePhone(input), expected);
    assert.deepEqual(phoneSegments('联系电话：' + input + '，请留意来电'), [{text:'联系电话：'},{text:input,phone:expected},{text:'，请留意来电'}]);
  }
});

test('掩码、单号、取件码、URL和长数字保持纯文本且不能注入拨号参数', () => {
  for (const input of ['138****0001','138000000010','A13800000001','13800000001A','123-13800000001','13800000001-1234','运单号：13800000001','运单：13800000001','订单编号为13800000001','取件码：13800000001','https://fixture.invalid/13800000001','*13800000001#','+8613800000001;123','tel:13800000001']) {
    if (!input.startsWith('+86') && !input.startsWith('tel:')) assert.equal(phoneSegments(input).filter(part=>part.phone).length,0,input);
    assert.equal(normalizePhone(input),'',input);
  }
  const html = '<img src=x onerror=alert(1)> 电话13800000001';
  assert.equal(phoneSegments(html).map(part=>part.text).join(''),html);
  assert.equal(phoneSegments(html).filter(part=>part.phone).length,1);
});

test('一条轨迹中的多个手机号独立显示，普通数字和日期不链接', () => {
  const text='11-11 09:25，派送员13800000001，收件人13900000002；客服95538；运单号13800000003';
  const parts=phoneSegments(text);
  assert.equal(parts.map(part=>part.text).join(''),text);
  assert.deepEqual(parts.filter(part=>part.phone).map(part=>part.phone),['13800000001','13900000002']);
});

test('基本信息只提取当前运单的最新派送角色号码，不把客服收件人或揽收员当派送员', () => {
  const events = [
    {time:200,description:'快递员已送达家门口，如有问题请联系快递员（13800000001），客服电话13900000002，收件人13700000003'},
    {time:100,description:'配送员13600000004正在配送'},
    {time:300,description:'如有疑问请联系客服13900000005'},
  ];
  assert.deepEqual(courierPhones({logisticsEvents:events}),[{phone:'13800000001',text:'13800000001'}]);
  assert.equal(events[0].time,200,'不会对来源数组就地排序');
  for(const description of ['快递员已揽收，电话13800000001','揽件员13800000001已揽收','联系电话13800000001','收件人13800000001']) {
    assert.deepEqual(courierPhones({logisticsEvents:[{time:100,description}]}),[],description);
  }
});

test('换派人员、掩码或无日期冲突不会沿用旧派送电话', () => {
  const old={time:100,description:'派送员13800000001正在派件'};
  assert.deepEqual(courierPhones({logisticsEvents:[old,{time:200,description:'已改派，配送员13900000002为您配送'}]}),[{phone:'13900000002',text:'13900000002'}]);
  for(const update of [{time:200,description:'已改派，配送员电话139****0002'}, {time:200,description:'配送员已更换，请稍后查询'}, {time:200,description:'已改派重新派送'}, {time:0,description:'派送员13900000002正在派送'}]) {
    assert.deepEqual(courierPhones({logisticsEvents:[old,update]}),[]);
  }
});

test('拼多多姓名括号号码后接派件动作，号段说明和网点电话不归入派送员', () => {
  const description = '【测试网点】的测试员（13800000001）正在为您派件（95161和18521号段的上海号码为圆通快递员专属号码，请放心接听。如遇物流问题，请联系快递员为您解决，或联系网点电话:13900000002，或致电专属客服95554）';
  assert.deepEqual(courierPhones({ platform: 'pdd', logisticsEvents: [{ time: 100, description }] }).map(p => p.phone), ['13800000001']);
});

test('签收及客服的泛称提示不清空同运单已知派送电话', () => {
  const old = { time: 100, description: '派送员13800000001正在派件' };
  for (const description of ['您的快件已签收，如有问题请联系快递员', '如有问题，请联系快递员或网点电话13900000002', '您的快件已签收，感谢快递员的辛勤工作']) {
    assert.deepEqual(courierPhones({ platform: 'pdd', logisticsEvents: [old, { time: 200, description }] }).map(p => p.phone), ['13800000001'], description);
  }
  assert.deepEqual(courierPhones({ logisticsEvents: [old, { time: 200, description: '您的快件已签收，如需退货请联系商家' }] }).map(p => p.phone), ['13800000001']);
});

test('前置号码的配送语义不借用收件、揽收、客服和网点号码', () => {
  for (const description of ['收件人（13800000001）正在为您派件', '网点电话13800000001正在派送', '客服13800000001正在为您派件', '快递员13800000001已揽收', '测试员（13800000001）预计为您派件', '测试员（13800000001）未能为您派件', '退回件由快递员13800000001派送给商家']) {
    assert.deepEqual(courierPhones({ platform: 'pdd', logisticsEvents: [{ time: 100, description }] }), [], description);
  }
});

test('同时间不同派送员号码不依赖轨迹输入顺序，改派无完整号码不回退旧号', () => {
  const events = [{ time: 100, description: '派送员13800000001正在派件' }, { time: 100, description: '派送员13900000002正在派件' }];
  assert.deepEqual(courierPhones({ logisticsEvents: events }), []);
  assert.deepEqual(courierPhones({ logisticsEvents: events.slice().reverse() }), []);
  for (const description of ['【测试网点】的测试员（139****0002）正在为您派件', '已改派给测试员，请稍后查询']) {
    assert.deepEqual(courierPhones({ platform: 'pdd', logisticsEvents: [events[0], { time: 200, description }] }), []);
  }
  assert.deepEqual(courierPhones({ logisticsEvents: [{ time: 200, description: '原快递员13800000001已改派给配送员139****0002' }] }), []);
});

test('淘宝顺丰交给姓名联系电话的配送句式按时间选择，摘要重复不制造冲突', () => {
  const old = { time: 100, description: '派送中：快件交给【测试甲，联系电话：13800000001】，正在派送中（可联系小哥处理）' };
  const latest = { time: 200, description: '快件交给【测试乙，联系电话：13900000002】，正在派送中' };
  assert.deepEqual(courierPhones({ platform: 'taobao', logisticsEvents: [old] }).map(p => p.phone), ['13800000001']);
  assert.deepEqual(courierPhones({ platform: 'taobao', logisticsEvents: [old, latest, { ...latest, time: 0, description: '派送中：' + latest.description }] }).map(p => p.phone), ['13900000002']);
  assert.deepEqual(courierPhones({ platform: 'taobao', logisticsEvents: [{ time: 100, description: '快件到达【测试网点，电话：13800000001】，正在派送中' }] }), []);
});

test('京东配送和家门口签收采用明确配送员，营业部电话不替换当前号码', () => {
  const delivery = { time: 100, description: '派送中：您的订单正在派送途中，请您准备签收（快递员：测试员，电话：13800000001）' };
  const signed = { time: 200, description: '已签收：您的订单已送达【家门口，有问题联系小哥】。如有疑问您可联系配送员【测试员，13800000001】处理。感谢您在京东购物。' };
  const depot = { time: 300, description: '运输中：您的订单已到达【测试营业部】，营业部电话：13900000002' };
  assert.deepEqual(courierPhones({ platform: 'jd', logisticsEvents: [delivery, signed, depot] }).map(p => p.phone), ['13800000001']);
  assert.deepEqual(courierPhones({ platform: 'jd', logisticsEvents: [depot] }), []);
  assert.deepEqual(courierPhones({ platform: 'jd', logisticsEvents: [{ time: 100, description: '快递员建议联系营业部电话13900000002' }] }), []);
});

test('拼多多到站文案分别识别代收点和快递员，不用号段或收件人脱敏号码更新派送员', () => {
  const delivery = { time: 100, description: '【代收点】您的快件已投递，如有疑问请联系代收点：13900000002，快递员：测试员(13800000001)，网点电话：13700000003，投诉电话：13600000004' };
  const reminder = { time: 200, description: '已签收，如有问题请联系快递员，收件人电话139****0002' };
  assert.deepEqual(courierPhones({ platform: 'pdd', logisticsEvents: [delivery, reminder] }).map(p => p.phone), ['13800000001']);
  assert.deepEqual(courierPhones({ platform: 'pdd', logisticsEvents: [{ time: 100, description: '95161和18521号段为圆通快递员专属号码，请放心接听' }] }), []);
});
