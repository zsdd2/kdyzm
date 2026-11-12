import test from 'node:test';
import assert from 'node:assert/strict';
import '../app-source/pickcode/core/load-core.mjs';

function harness() {
  let state = '';
  return (action, payload) => {
    const response = JSON.parse(PickCodeCore.dispatch(state, JSON.stringify({ action, payload })));
    state = JSON.stringify(response.state);
    return response.result;
  };
}

test('门店卡位不作为子位置，未确认与已保存旧规则均保留实际柜号', () => {
  for (const legacy of [false, true]) for (const [address, detail, expected] of [
    ['合成花园4卡5号柜兔喜快递柜', '4卡 5号柜', '5号柜'],
    ['合成花园四卡5号柜兔喜快递柜', '四卡5号柜', '5号柜'],
    ['合成花园4卡店', '4卡', ''],
  ]) {
    const call = harness();
    if (legacy) {
      call('syncMeta', { bound: true, baseUrl: 'https://fixture.example', deviceId: 'synthetic-device' });
      call('syncImport', { snapshot: { schemaVersion: 1, serverRevision: 1, stationRulesVersion: 1,
        stationRules: [{ id: 'synthetic-station', name: '合成花园4卡店', enabled: true, aliases: [{ name: address, subLocation: detail }] }],
        accounts: [], orders: [], shipments: [] } });
    }
    const code = call('add', { item: { code: '123456', address } }).codes[0];
    assert.equal(code.stationSubLocation, expected);
    assert.equal(code.address, address);
    assert.equal(code.pickupCabinet, expected);
  }
});
