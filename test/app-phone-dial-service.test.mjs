import test from 'node:test';
import assert from 'node:assert/strict';

let serial = 0;
async function harness(native, run) {
  const events = new Map(), calls = [];
  const previousWindow = globalThis.window, previousUni = globalThis.uni;
  globalThis.window = { addEventListener: (name, listener) => events.set(name, listener) };
  globalThis.uni = { makePhoneCall: options => { calls.push(options.phoneNumber); options.success(); } };
  if (native) window.PickCodeNative = { request(id, raw) {
    const request = JSON.parse(raw); calls.push(request);
    queueMicrotask(() => events.get('pickcode-native')({ detail: { id, ok: true, data: { opened: true } } }));
  } };
  try { await run(await import('../app-source/pickcode/services/assistant.js?phone=' + (++serial)), calls, events); }
  finally { globalThis.window = previousWindow; globalThis.uni = previousUni; }
}

test('Android opens the dialer through the existing bridge without loading or changing parcels', async () => {
  await harness(true, async (api, calls) => {
    assert.deepEqual(await api.dialPhone('+8613800138000'), { opened: true });
    assert.deepEqual(calls, [{ action: 'dialPhone', payload: { phone: '+8613800138000' } }]);
    assert.equal(api.getCachedSnapshot(), undefined);
  });
});

test('phone actions reject malformed numbers before native or browser calls', async () => {
  for (const native of [false, true]) await harness(native, async (api, calls) => {
    for (const value of [null, 13800138000, {}, [], '', '1234', '1'.repeat(16), 'tel:13800138000', '13800138000;123',
      '*#06#', '13800138000,123', '13800138000\n', ' 13800138000', '138-0013-8000', '＋8613800138000']) {
      await assert.rejects(api.dialPhone(value), /电话号码/);
    }
    assert.deepEqual(calls, []);
  });
});

test('H5 uses the installed platform dial API with the same validated number', async () => {
  await harness(false, async (api, calls) => {
    assert.deepEqual(await api.dialPhone('95338'), { opened: true });
    assert.deepEqual(calls, ['95338']);
    uni.makePhoneCall = options => options.fail({ errMsg: 'platform detail' });
    await assert.rejects(api.dialPhone('13800138000'), /无法打开拨号界面/);
    delete uni.makePhoneCall;
    await assert.rejects(api.dialPhone('13800138000'), /无法打开拨号界面/);
  });
});

test('native failure is reported to the phone control instead of claiming the dialer opened', async () => {
  await harness(true, async (api, calls, events) => {
    window.PickCodeNative.request = (id, raw) => {
      calls.push(JSON.parse(raw));
      queueMicrotask(() => events.get('pickcode-native')({ detail: { id, ok: false, error: '未找到拨号应用，请手动拨打' } }));
    };
    await assert.rejects(api.dialPhone('13800138000'), /未找到拨号应用/);
    assert.equal(calls.length, 1);
  });
});
