import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorTaobaoEventTimes } from '../src/collector-enrichment.mjs';
const time = value => Date.parse(`${value}+08:00`);
const event = timeText => ({ provider: 'taobao', providerStatusTag: '运输中', description: '快件已到达合成转运中心', timeText, time: 0, timePrecision: 'unknown' });
const full = value => ({ ...event(value.replace('T', ' ')), time: time(value), timePrecision: 'minute' });
const order = value => ({ orderDate: time(value), orderDatePrecision: 'minute', orderDateOrigin: 'list' });

test('Taobao missing years default to the order year, including list dates and delayed historical reads', () => {
  for (const origin of ['detail', 'list']) {
    const result = anchorTaobaoEventTimes([event('11-10 10:35')], { ...order('2024-11-06T12:00'), orderDateOrigin: origin }, time('2026-11-13T12:00'));
    assert.equal(result[0].time, time('2024-11-10T10:35'));
  }
});

test('Taobao missing order dates use this parcel full dates, then the saved observation year', () => {
  const dated = full('2025-11-12T09:00');
  assert.equal(anchorTaobaoEventTimes([event('11-13 11:28'), dated], {}, time('2026-11-13T12:00'))[0].time, time('2025-11-13T11:28'));
  assert.equal(anchorTaobaoEventTimes([event('11-13 11:28')], {}, time('2026-11-13T12:00'))[0].time, time('2026-11-13T11:28'));
  assert.equal(anchorTaobaoEventTimes([event('11-13 11:28')], {}, 0)[0].time, 0);
});

test('Taobao late December order rolls into January, January observation can retain previous December', () => {
  const result = anchorTaobaoEventTimes([event('12-31 23:59'), event('01-01 00:05')], order('2025-12-30T12:00'), time('2026-01-02T12:00'));
  assert.deepEqual(result.map(row => row.time), [time('2026-01-01T00:05'), time('2025-12-31T23:59')]);
  assert.equal(anchorTaobaoEventTimes([event('12-31 23:59')], {}, time('2026-01-02T12:00'))[0].time, time('2025-12-31T23:59'));
  assert.equal(anchorTaobaoEventTimes([event('01-01 00:05')], order('2025-12-30T12:00'), time('2025-12-31T23:59'))[0].time, 0);
});

test('Taobao same-year default preserves full timestamps and does not repair conflicts or choose a different leap year', () => {
  const explicit = full('2025-11-12T09:00');
  const result = anchorTaobaoEventTimes([explicit, event('11-13 11:28')], order('2026-11-06T12:00'), time('2026-11-13T12:00'));
  assert.deepEqual(result.find(row => row.timeText === explicit.timeText), explicit);
  assert.equal(result.find(row => row.timeText === '11-13 11:28').time, 0);
  assert.equal(anchorTaobaoEventTimes([event('02-29 12:00')], order('2023-03-01T12:00'), time('2026-03-01T12:00'))[0].time, 0);
  assert.equal(anchorTaobaoEventTimes([event('11-06 11:59')], order('2026-11-06T12:00'), time('2026-11-13T12:00'))[0].time, 0);
});
