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
