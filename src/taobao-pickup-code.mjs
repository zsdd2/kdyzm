const DASHES = /[－—–−﹘﹣]/g;

function normalizeWidth(value) {
  return String(value ?? '')
    .replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ')
    .replace(DASHES, '-');
}

function validCode(code) {
  return /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(code)
    && /\d/.test(code)
    && code.length >= 3
    && code.length <= 12
    && !/^\d{9,}$/.test(code)
    && !/^(?:JT|YT|SF|JD|ZTO|STO|YTO)\d{8,}$/i.test(code);
}

function cabinetLabels(value) {
  const text = normalizeWidth(value);
  return new Set((text.match(/[A-Za-z0-9]+(?:\s*-\s*[A-Za-z0-9]+)?\s*号\s*柜/g) || [])
    .map(label => label.replace(/\s+/g, '')));
}

function structuredCode(value) {
  const text = normalizeWidth(value).trim();
  const match = /^([A-Za-z0-9]+(?:\s*-\s*[A-Za-z0-9]+)?\s*号\s*柜)\s*[-:]?\s*([A-Za-z0-9]+(?:\s*[-]\s*[A-Za-z0-9]+)*)$/.exec(text);
  if (!match) return null;
  const cabinet = match[1].replace(/\s+/g, '');
  const code = match[2].replace(/\s+/g, '').replace(DASHES, '-');
  return validCode(code) ? { cabinet, code } : null;
}

export function normalizeTaobaoPickupCode(parcel) {
  if (!parcel || typeof parcel !== 'object' || Array.isArray(parcel)) return parcel;
  const parsed = structuredCode(parcel.pickupCode);
  if (!parsed) return { ...parcel };
  const labels = cabinetLabels(parcel.station);
  if (labels.size && (labels.size !== 1 || !labels.has(parsed.cabinet))) return { ...parcel };
  const station = String(parcel.station ?? '').trim();
  return { ...parcel, pickupCode: parsed.code, station: labels.has(parsed.cabinet) ? station : station ? `${station} ${parsed.cabinet}` : parsed.cabinet };
}
