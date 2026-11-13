import test from 'node:test';
import assert from 'node:assert/strict';
import '../app-source/pickcode/core/load-core.mjs';

const t=1794490000000;
const account={id:'a',platform:'jd',status:'ok'};
const order={id:'o',accountId:'a',platform:'jd',platformOrderId:'order-number',title:'包裹',orderDate:t,firstSeenAt:t};
const quality=Object.fromEntries(['arrivalTime','shippedTime','station','courier'].map(key=>[key,{state:'unknown',reasonCode:'UPSTREAM_MISSING'}]));
const view={version:1,status:'arrived',deliveryMode:'station',requiresReceiptConfirmation:false,station:{id:'s',name:'示例小区4卡店',subLocation:'5号柜',displayName:'示例小区4卡店5号柜',conflict:false},courierPhones:[{phone:'13800138000',text:'派送员'}],quality,evidenceKey:'e1'};
const ship={id:'s',orderId:'o',accountId:'a',waybillNo:'JD1234567890123',carrier:'京东',status:'arrived',arrivalAt:0,arrivalAtSource:'unknown',arrivalAtPrecision:'unknown',shippedAt:t-1000,shippedAtSource:'platform_event',shippedAtPrecision:'second',updatedAt:t,logisticsState:'ok',platformView:view};
function store(){
  let state='';
  const run=(action='snapshot',payload={})=>{const next=JSON.parse(globalThis.PickCodeCore.dispatch(state,JSON.stringify({action,payload})));state=JSON.stringify(next.state);return next.result;};
  run.state=()=>JSON.parse(state);
  run('syncMeta',{bound:true,baseUrl:'https://example.test',deviceId:'device',accounts:[account]});
  return run;
}
function sync(run,shipment=ship,revision=1,extra={}){
  return run('syncImport',{snapshot:{schemaVersion:1,serverRevision:revision,accounts:[account],orders:[order],shipments:[shipment],capabilities:['pickup_completion_v1'],dataVersion:`v${revision}`,...extra},syncedAt:t});
}
const resultShip=snapshot=>snapshot.packages[0].shipments[0];
function details(run,id,extra={}){
  const target=run('shipmentDetailTarget',{id});
  return {id,bindingKey:target.bindingKey,shipmentId:target.remoteId,orderId:target.orderId,evidenceKey:target.evidenceKey,logisticsState:'ok',logisticsTruncated:false,logisticsEvents:[{time:t,description:'已送到家门口，请注意查收'}],...extra};
}

test('平台结果与字段质量权威，详情不重新推导状态、站点或时间',()=>{
  const run=store();let current=resultShip(sync(run,{...ship,logisticsEvents:[{time:t,description:'已经送到家门口'}]}));
  assert.equal(current.arrivalAt,0);assert.equal(current.isHomeDelivery,false);
  assert.equal(current.stationCanonical,'示例小区4卡店');assert.equal(current.stationSubLocation,'5号柜');
  assert.deepEqual(current.courierPhones,view.courierPhones);assert.deepEqual(current.fieldQuality,quality);
  assert.equal(current.detailState,'not_loaded');assert.deepEqual(current.logisticsEvents,[]);
  assert.equal(current.logisticsState,'ok');
  current=resultShip(run('importShipmentDetails',details(run,current.id)));
  assert.equal(current.detailState,'loaded');assert.equal(current.logisticsEvents.length,1);
  assert.equal(current.status,'arrived');assert.equal(current.arrivalAt,0);assert.equal(current.isHomeDelivery,false);
  current=resultShip(sync(run,{...ship,updatedAt:t+1,platformView:{...view,evidenceKey:'e2'}},2));
  assert.equal(current.detailState,'stale');assert.deepEqual(current.logisticsEvents,[]);
});

test('门口结果服从后台确认标志并保留本机离线人工确认',()=>{
  const run=store();let snapshot=sync(run,{...ship,status:'signed',platformView:{...view,status:'signed',deliveryMode:'doorstep',requiresReceiptConfirmation:true}});
  const current=resultShip(snapshot);assert.equal(current.isHomeDelivery,true);assert.equal(current.needsReceiptConfirmation,true);
  snapshot=run('pickShipments',{orderId:snapshot.packages[0].id,shipmentIds:[current.id],picked:true});
  assert.equal(resultShip(snapshot).picked,true);assert.equal(resultShip(snapshot).needsReceiptConfirmation,false);
  assert.equal(snapshot.operations.length,1);
});

test('详情拒绝旧证据、撤权、改绑及相同设备重新绑定的迟到响应',()=>{
  for(const mode of ['evidence','revoke','rebind','same-binding']){
    const run=store();const current=resultShip(sync(run)),payload=details(run,current.id);
    if(mode==='evidence')sync(run,{...ship,updatedAt:t+1,platformView:{...view,evidenceKey:'e2'}},2);
    if(mode==='revoke')run('syncMetadata',{meta:{serverRevision:2,accounts:[],familyIds:[],legacyAccountIds:[]}});
    if(mode==='rebind')run('syncMeta',{bound:true,baseUrl:'https://other.test',deviceId:'device',accounts:[account]});
    if(mode==='same-binding'){run('syncMeta',{bound:false});run('syncMeta',{bound:true,baseUrl:'https://example.test',deviceId:'device',accounts:[account]});}
    assert.throws(()=>run('importShipmentDetails',payload),/不可用|过期/,mode);
    assert.equal(run.state().shipments[0].shipmentDetails,undefined);
  }
});

test('元数据同步更新账号、规则、任务且不覆盖实体或推进实体版本',()=>{
  const run=store();sync(run);
  const before=run.state().shipments;
  run('syncMetadata',{dataVersion:'v1',syncedAt:t+5,meta:{serverRevision:2,accounts:[{...account,label:'新名称'}],stationRules:[],stationRulesVersion:2,syncJobs:[{id:'job',accountId:'a',state:'completed',updatedAt:t+5}],capabilities:['pickup_completion_v1']}});
  const state=run.state();assert.deepEqual(state.shipments,before);assert.equal(state.online.accounts[0].label,'新名称');assert.equal(state.stationRulesVersion,2);assert.equal(state.online.jobs[0].state,'completed');assert.equal(state.online.revision,1);assert.equal(state.online.dataVersion,'v1');
  const next=resultShip(sync(run,{...ship,updatedAt:t+1,waybillNo:'NEW'},2));assert.equal(next.waybillNo,'NEW');
});

test('较新快照的领取决定独立于物流updatedAt，身份字段省略不清空',()=>{
  const run=store();const pending={version:1,autoPicked:false,manualOverride:'',completedAt:0,evidence:null};
  sync(run,{...ship,pickupCompletion:pending});
  let current=resultShip(sync(run,{...ship,updatedAt:t-1,pickupCompletion:{...pending,autoPicked:true,completedAt:t}},2));
  assert.equal(current.picked,true);assert.equal(current.pickupCompletion.autoPicked,true);
  current=resultShip(sync(run,{id:'s',accountId:'a',orderId:'o',updatedAt:t+1},3,{orders:[{id:'o',accountId:'a'}]}));
  assert.equal(current.waybillNo,ship.waybillNo);assert.equal(current.carrier,ship.carrier);
  assert.equal(run().packages[0].platformOrderId,order.platformOrderId);
  assert.equal(run.state().shipments[0].updatedAt,t+1);
});

test('仅元数据包要求已导入相同数据版本，并拒绝旧元数据倒退',()=>{
  const run=store();sync(run);
  assert.throws(()=>run('syncMetadata',{dataVersion:'other',meta:{metadataOnly:true,dataVersion:'other',serverRevision:2,accounts:[]}}),/数据版本不匹配/);
  run('syncMetadata',{dataVersion:'v1',meta:{metadataOnly:true,dataVersion:'v1',serverRevision:3,accounts:[{...account,label:'最新'}]}});
  run('syncMetadata',{dataVersion:'v1',meta:{metadataOnly:true,dataVersion:'v1',serverRevision:2,accounts:[{...account,label:'过期'}]}});
  assert.equal(run.state().online.accounts[0].label,'最新');
  sync(run,{...ship,updatedAt:t+1,waybillNo:'OLD'},2);
  assert.equal(run.state().online.accounts[0].label,'最新');assert.equal(resultShip(run()).waybillNo,ship.waybillNo);
});

test('平台站点可人工覆盖和重置，未关联短信领取不会把平台包裹标成已取',()=>{
  const run=store();let current=resultShip(sync(run,ship,1,{stationRulesVersion:1,stationRules:[{id:'manual',name:'人工站点',aliases:[],enabled:true}]}));
  current=resultShip(run('setStation',{shipmentId:current.id,stationId:'manual'}));
  assert.equal(current.stationCanonical,'人工站点');assert.equal(current.stationCorrection.stationId,'manual');
  current=resultShip(run('resetStation',{shipmentId:current.id}));
  assert.equal(current.stationCanonical,view.station.name);assert.equal(current.stationSubLocation,'5号柜');
  let snapshot=run('ingest',{messages:[{id:'sms',address:'106900',body:'【菜鸟驿站】您有包裹在另一个小区，取件码7-6-7042',date:t}]});
  assert.equal(snapshot.codes.length,1);
  snapshot=run('update',{id:snapshot.codes[0].id,patch:{isPicked:true}});
  assert.equal(resultShip(snapshot).picked,false);assert.equal(snapshot.operations.length,0);
});

test('已完成平台包裹不领取未匹配短信，隐藏和新取件周期仍受保护',()=>{
  const run=store(),completion={version:1,autoPicked:true,manualOverride:'',completedAt:t,evidence:null};
  let snapshot=run('ingest',{messages:[{id:'sms',address:'106900',body:'【菜鸟驿站】您有包裹在另一个小区，取件码7-6-7042',date:t}]});
  snapshot=sync(run,{...ship,pickupCompletion:completion,pickupCycle:{id:'cycle1',startedAt:t-1000}});
  assert.equal(snapshot.codes[0].isPicked,false);assert.equal(resultShip(snapshot).picked,true);
  const id=resultShip(snapshot).id;
  snapshot=sync(run,{...ship,updatedAt:t+1,pickupCompletion:{...completion,autoPicked:false,completedAt:0},pickupCycle:{id:'cycle2',startedAt:t+1}},2);
  assert.equal(resultShip(snapshot).picked,false);assert.equal(resultShip(snapshot).pickupCycleHistory.length,1);
  run('removePackage',{id:snapshot.packages[0].id});
  assert.throws(()=>run('shipmentDetailTarget',{id}),/不可用/);
  snapshot=sync(run,{...ship,updatedAt:t+2},3);
  assert.equal(snapshot.packages[0].hidden,true);
});

test('详情使用规范运单ID，完整同步保留新版能力',()=>{
  const run=store();const current=resultShip(sync(run));
  sync(run,{...ship,id:'canonical',updatedAt:t+1},2,{shipmentAliases:[{oldShipmentId:'s',targetShipmentId:'canonical',accountId:'a',platform:'jd'}],capabilities:['normalized_shipments_v1','compact_snapshot_v1','shipment_details_v1']});
  const target=run('shipmentDetailTarget',{id:current.id});
  assert.equal(target.remoteId,'canonical');
  assert.deepEqual(run.state().online.capabilities,['normalized_shipments_v1','compact_snapshot_v1','shipment_details_v1']);
  assert.equal(resultShip(run('importShipmentDetails',details(run,current.id))).detailState,'loaded');
});
