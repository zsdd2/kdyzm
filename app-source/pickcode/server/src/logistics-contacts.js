const mobilePattern = /(?:(?:\+|00)?86[ -]?)?1[3-9]\d(?:[ -]?\d{4}){2}/g;
const courierRole = /派件员|派送员|配送员|投递员|派件人|快递员|快递小哥|配送小哥|送货员|送货师傅/g;
const otherRole = /客服(?:电话)?|收件人|发件人|寄件人|收件电话|寄件电话|揽件员|揽收员|业务员|服务电话|投诉电话|公司电话|网点电话|驿站电话|代收点电话|营业部电话|站点电话/g;

export function normalizePhone(value) {
  if (typeof value !== 'string' || !/^(?:(?:\+|00)?86[ -]?)?1[3-9]\d(?:[ -]?\d{4}){2}$/.test(value)) return '';
  const digits = value.replace(/[ +\-]/g, '').replace(/^0086/, '86');
  return digits.length === 13 ? '+' + digits : digits;
}

export function phoneSegments(value) {
  const text = typeof value === 'string' ? value : '', parts = [];
  let cursor = 0;
  for (const match of text.matchAll(mobilePattern)) {
    const start = match.index, end = start + match[0].length, before = text.slice(0, start), after = text.slice(end);
    if (/[A-Za-z0-9_+#*]$/.test(before) || /^[A-Za-z0-9_#*]/.test(after)
      || /\d[ -]$/.test(before) || /^[ -]\d/.test(after)
      || /(?:(?:订单|运单)(?:编号|号|号码)?|(?:物流|快递|包裹|交易|商品)(?:编号|单号|号|号码))\s*(?:为|是)?\s*[:：]?\s*$/.test(before)
      || /(?:取件码|取货码|提货码|验证码|手机尾号)\s*(?:为|是)?\s*[:：]?\s*$/.test(before)
      || /(?:https?:\/\/|www\.)[^\s，。；;]*$/.test(before)) continue;
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: match[0], phone: normalizePhone(match[0]) });
    cursor = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

function courierContext(text, offset, length, roles, blocked) {
  const preceding = roles.filter(role => role.index < offset).at(-1);
  const other = blocked.filter(role => role.index < offset).at(-1);
  const before = text.slice(Math.max(0, offset - 60), offset), after = text.slice(offset + length);
  const roleBefore = preceding && offset - preceding.index <= 60 && !/[。；;\n]/.test(text.slice(preceding.index, offset));
  const actionAfter = /^[\s)）\]】]*(?:正在|正)?(?:为您|为你)?(?:派件|派送|配送|投递|送货)/.test(after);
  const handoff = /快件(?:已)?(?:交给|交由)[【\[][^】\]。；;\n]{0,50}$/.test(before)
    && /^[\s】\],，]*(?:正在|正)(?:为您|为你)?(?:派送|派件|配送)/.test(after);
  const otherBefore = other && (!preceding || other.index > preceding.index) && !/[。；;\n]/.test(text.slice(other.index, offset));
  return Boolean((roleBefore || actionAfter || handoff) && !otherBefore && !/预计|即将|申请|未能|尚未|取消/.test(before));
}

function eventCouriers(event) {
  const text = [event.description, event.location].filter(value => typeof value === 'string').join('，');
  if (/(?:退回|退货|退件|返件)件|(?:已|正在)(?:退回|退货|退件|返件|拒收)/.test(text)) return [];
  const roles = [...text.matchAll(courierRole)];
  const changed = /已(?:经)?(?:改派|改投|转派)|重新派送|(?:派件员|派送员|配送员|快递员)已更换/.test(text) && !/预计|即将|申请|未能|尚未|取消/.test(text);
  if (/揽收|揽件|收寄|取件上门/.test(text) && !/派送|派件|配送|投递|送货|送达/.test(text)) return null;
  const blocked = [...text.matchAll(otherRole)], phones = [];
  let offset = 0;
  for (const part of phoneSegments(text)) {
    if (part.phone) {
      if (courierContext(text, offset, part.text.length, roles, blocked)) {
        if (!phones.some(phone => phone.phone === part.phone)) phones.push({ phone: part.phone, text: part.text });
      }
    }
    offset += part.text.length;
  }
  // A service reminder is not a courier change; a new masked assignment is.
  const maskedAssignment = [...text.matchAll(/1[3-9]\d\d*[*＊xX•·]+[\d*＊xX•·]*/g)]
    .some(match => courierContext(text, match.index, match[0].length, roles, blocked));
  return maskedAssignment ? [] : phones.length || changed ? phones : null;
}

export function extractCourierContacts(shipment = {}) {
  const events = (Array.isArray(shipment.logisticsEvents) ? shipment.logisticsEvents : [])
    .filter(event => event && typeof event === 'object').map(event => ({ event, phones: eventCouriers(event) }))
    .filter(row => row.phones !== null).sort((a, b) => (Number(b.event.time) || 0) - (Number(a.event.time) || 0));
  if (!events.length) return { phones: [], state: 'unknown', reasonCode: 'COURIER_NOT_PROVIDED' };
  const latest = events[0].phones;
  const samePhones = phones => JSON.stringify(phones.map(phone => phone.phone).sort()) === JSON.stringify(latest.map(phone => phone.phone).sort());
  if (events.some(row => Number(row.event.time) === Number(events[0].event.time) && !samePhones(row.phones)))
    return { phones: [], state: 'ambiguous', reasonCode: 'COURIER_CONFLICT' };
  // Undated courier changes cannot be ordered safely against an older named courier.
  if (events.some(row => !(Number(row.event.time) > 0) && !samePhones(row.phones)))
    return { phones: [], state: 'ambiguous', reasonCode: 'COURIER_UNDATED_CHANGE' };
  return { phones: latest, state: latest.length ? 'known' : 'unknown', reasonCode: latest.length ? 'PLATFORM_EVIDENCE' : 'COURIER_NOT_PROVIDED' };
}

export function courierPhones(shipment = {}) {
  if (shipment.platformView?.version === 1 && Array.isArray(shipment.platformView.courierPhones)) return shipment.platformView.courierPhones;
  return extractCourierContacts(shipment).phones;
}
