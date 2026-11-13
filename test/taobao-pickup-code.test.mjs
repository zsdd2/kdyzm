import test from 'node:test';
import assert from 'node:assert/strict';
import { taobaoParcels } from '../src/collectors.mjs';
import { normalizeTaobaoPickupCode } from '../src/taobao-pickup-code.mjs';

const NOW = Date.parse('2026-11-13T10:00:00+08:00');
const stage = (code, station = '合成兔喜驿站') => ({
  title: '待取件', subtitle: '2026-11-13 09:00:00',
  labelDesc: { text: `包裹已到${station}，请及时取件` },
  cardDesc: { title: station, custom: { expressCode: { code } } },
});

test('structured cabinet code is normalized while preserving cabinet in station', () => {
  const parcel = { waybillNo: 'SYNTHETIC-TAOBAO-1', station: '合成兔喜驿站', pickupCode: '８号柜 ２４６８１０' };
  assert.deepEqual(normalizeTaobaoPickupCode(parcel), {
    ...parcel, pickupCode: '246810', station: '合成兔喜驿站 8号柜',
  });
  assert.deepEqual(normalizeTaobaoPickupCode({ station: '合成兔喜驿站', pickupCode: '8号柜 A1－23' }), {
    station: '合成兔喜驿站 8号柜', pickupCode: 'A1-23',
  });
  assert.deepEqual(normalizeTaobaoPickupCode({ station: '合成兔喜驿站', pickupCode: '7-6-7042' }), {
    station: '合成兔喜驿站', pickupCode: '7-6-7042',
  });
});

test('a conflicting station cabinet leaves the raw structured code untouched', () => {
  const parcel = { waybillNo: 'SYNTHETIC-TAOBAO-2', station: '合成兔喜驿站 5号柜', pickupCode: '3号柜246810' };
  assert.deepEqual(normalizeTaobaoPickupCode(parcel), parcel);
});

test('an existing matching cabinet is preserved once across repeated normalization', () => {
  const parcel = { station: '合成兔喜驿站 3号柜', pickupCode: '3号柜246810' };
  const result = normalizeTaobaoPickupCode(parcel);
  assert.equal(result.station, parcel.station);
  assert.equal(result.pickupCode, '246810');
  assert.deepEqual(normalizeTaobaoPickupCode(result), result);
  assert.equal(parcel.pickupCode, '3号柜246810');
});

test('multiple candidates, explanations, and waybills are never treated as pickup codes', () => {
  for (const pickupCode of [
    '3号柜246810，5号柜135790',
    '请到3号柜246810取件',
    '3号柜773450794980198',
  ]) {
    const parcel = { station: '合成兔喜驿站', pickupCode };
    assert.deepEqual(normalizeTaobaoPickupCode(parcel), parcel, pickupCode);
  }
});

test('Taobao structured card reaches the collector as a valid core pickup code', () => {
  const result = taobaoParcels({ mailNo: 'SYNTHETIC-TAOBAO-3', multiStage: [stage('3号柜246810')] }, 'SYNTHETIC-ORDER', '', undefined, NOW)[0];
  assert.equal(result.pickupCode, '246810');
  assert.match(result.station, /合成兔喜驿站/);
  assert.match(result.station, /3号柜/);
  assert.match(result.logisticsEvents[0].description, /请及时取件/);
});
