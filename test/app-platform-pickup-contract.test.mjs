import test from 'node:test';
import assert from 'node:assert/strict';
import '../app-source/pickcode/core/load-core.mjs';
import { Store } from '../src/store.mjs';
import { clientSnapshot } from '../src/client-snapshot.mjs';
import { taobaoParcels, pddParcels, jdParcels } from '../src/collectors.mjs';

const now = Date.parse('2026-11-13T12:00:00+08:00'), arrival = now - 60000;
const time = '2026-11-13 11:59:00', station = '合成小区兔喜快递柜';
const codes = ['246810', '135790'];
const waybill = index => `SYNTHETIC-PACKAGE-${index}`;
const stage = index => ({ time, title: '待取件', labelDesc: { text: `已存入【${station}${index + 3}号柜】，请取件` },
  cardDesc: { title: station, custom: { expressCode: { code: `${index + 3}号柜${codes[index]}` } } } });
const adapters = {
  taobao: () => taobaoParcels({ multiPackages: { packages: codes.map((code, index) => ({
    mailNo: waybill(index), cpCode: 'ZTO', multiStage: [stage(index)]
  })) } }, 'order', 'PARENT-UNSAFE', undefined, now),
  pdd: () => {
    const order = { order_sn: 'order', shipping_list: codes.map((code, index) => ({
      tracking_number: waybill(index), shipping_name: '中通', shipping_status_text: '待取件'
    })) };
    return codes.map((code, index) => pddParcels(order, { order_sn: 'order', tracking_number: waybill(index),
      code, address: `${station}${index + 3}号柜`, arrival_time: time }).find(parcel => parcel.waybillNo === waybill(index)));
  },
  jd: () => jdParcels({ multiPackageTrackInfoList: codes.map((code, index) => ({
    carriageInfo: { carriageId: waybill(index), carrier: '京东物流' },
    trackGroupInfo: { checkCode: code, orderTrackShowList: [{ CreationTime: time,
      Content: `您的快件已存入【${station}${index + 3}号柜】，请及时取件` }] }
  })) }, 'order', now)
};

for (const [platform, collect] of Object.entries(adapters)) {
  test(`${platform} own structured parcel codes survive server compact projection and client import independently`, t => {
    const store = new Store({ key: Buffer.alloc(32, 1), now: () => now });
    t.after(() => store.close());
    store.saveAccount({ platform, label: '合成账号', cookie: 'SYNTHETIC' }, 'account', true);
    store.importResult('account', { orders: [{ platformOrderId: 'order', title: '合成分包', orderDate: now - 86400000 }],
      shipments: collect().map(parcel => ({ ...parcel, logisticsCheckedAt: now })) });
    const snapshot = clientSnapshot({ ...store.snapshot(['account']), serverLogisticsRulesVersion: 0 });
    const result = JSON.parse(globalThis.PickCodeCore.dispatch('', JSON.stringify({
      action: 'syncImport', payload: { snapshot, syncedAt: now }
    }))).result;
    const parcels = result.packages.flatMap(order => order.shipments);
    assert.equal(parcels.length, 2);
    for (let index = 0; index < codes.length; index++) {
      const parcel = parcels.find(value => value.waybillNo === waybill(index));
      assert.equal(parcel.pickupCode, codes[index]);
      assert.equal(parcel.arrivalAt, arrival);
    }
    assert.deepEqual(result.codes.map(value => value.code).sort(), codes.slice().sort());
  });
}
