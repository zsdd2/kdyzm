// Card numbers identify the shop; retain them in the original station/alias evidence.
export function stationSubLocation(value = '') {
  return String(value ?? '').replace(/[0-9０-９零〇一二两三四五六七八九十]+\s*卡\s*/g, '').trim();
}
