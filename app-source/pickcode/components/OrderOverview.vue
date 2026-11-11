<template>
  <view class="order-overview">
    <view class="product-heading">
      <button class="product-name" :class="{ expanded: fullTitle }" role="button" tabindex="0" :aria-expanded="fullTitle" :aria-label="fullTitle ? '收起商品名称' : '展开商品名称'" @click="fullTitle = !fullTitle">{{ displayTitle }}</button>
      <text class="product-state" :class="{ completed: shipment.picked }">{{ status }}</text>
    </view>
    <view class="product-meta"><text>{{ platform }}<template v-if="order.amount != null"> · ¥{{ Number(order.amount).toFixed(2) }}</template></text><text class="family">{{ order.familyId ? order.familyName || '家人' : '待归属' }}</text></view>

    <view class="section-heading"><text>{{ sources.length ? '取件短信' : '取件信息' }}</text><button v-if="sources.length" role="button" tabindex="0" :aria-expanded="smsOpen" @click="smsOpen = !smsOpen">{{ smsOpen ? '收起原文' : '短信原文' }} <uni-icons :type="smsOpen ? 'top' : 'right'" size="15" color="#1874d4" /></button></view>
    <view v-if="smsOpen" class="sms-original">
      <view v-for="(source, index) in sources" :key="source.sourceId || index"><text class="source-meta">{{ source.sender || '短信' }} {{ time(source.date) }}</text><text class="sms-body" selectable>{{ source.body || '此来源未保存短信正文' }}</text></view>
    </view>
    <view class="pickup-boxes" :class="{ 'no-cabinet': !cabinet, 'wide-code': code.length > 14 }">
      <button class="code-box" role="button" tabindex="0" :disabled="!code" :aria-label="code ? '复制取件码 ' + code : '暂无取件码'" @click="copy(code)"><view class="box-label"><text>取件码</text><svg v-if="code" class="box-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="8" y="7" width="12" height="15" rx="2" /><path d="M16 3H6a2 2 0 0 0-2 2v13" /></svg></view><text class="code-value" :class="[codeSize, { unknown: !code }]">{{ code || '待获取' }}</text></button>
      <view v-if="cabinet" class="cabinet-column">
        <button v-if="cabinet" class="cabinet-box" role="button" tabindex="0" :aria-label="'复制柜号 ' + cabinet" @click="copy(cabinet)"><view class="box-label"><text>柜号</text><svg class="box-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="4" y="2" width="16" height="20" rx="3" /><path d="M12 2v20M4 12h16M8 6v3m8 6v3" /></svg></view><text class="cabinet-number"><template v-if="cabinetNumber"><text class="cabinet-digit">{{ cabinetNumber }}</text>号柜</template><template v-else>{{ cabinet }}</template></text></button>
      </view>
    </view>
    <view class="station-row"><uni-icons class="station-icon" type="location" size="21" color="#008d80" /><text class="station-name">{{ stationDisplayName(pickup || shipment, '站点待获取') }}</text><view v-if="$slots['station-action']" class="station-action"><slot name="station-action" /></view></view>
    <view class="journey-section"><text class="section-title">订单信息</text><ParcelJourney :key="shipment.id || order.id || pickup?.id" :journey="journey" /></view>

    <view class="fold-card">
      <button class="fold-heading" role="button" tabindex="0" :aria-expanded="logisticsOpen" @click="logisticsOpen = !logisticsOpen"><svg class="section-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 5h12v13H2zM14 10h5l3 4v4h-8" /><circle cx="6" cy="18" r="2" fill="#f7faff" /><circle cx="18" cy="18" r="2" fill="#f7faff" /></svg><text>物流详情</text><view class="fold-action">{{ (shipment.logisticsEvents || []).length }}条轨迹 <uni-icons :type="logisticsOpen ? 'top' : 'bottom'" size="15" color="#1874d4" /></view></button>
      <view class="latest-row"><text class="carrier-state">{{ shipment.carrier || '快递' }} · {{ logisticsStatus }}</text><text class="latest-time">{{ time(latest?.time) }}</text></view>
      <PhoneText class="latest-copy" :text="latest?.description || latest?.message || latest?.location || (shipment.waybillNo ? '物流轨迹待同步' : '暂无运单信息')" />
      <LogisticsTimeline v-if="logisticsOpen" :shipment="shipment" expanded-only />
    </view>
    <view class="fold-card basic-card">
      <button class="fold-heading" role="button" tabindex="0" :aria-expanded="basicOpen" @click="basicOpen = !basicOpen"><uni-icons type="list" size="22" color="#587189" /><text>订单基本信息</text><uni-icons class="fold-chevron" :type="basicOpen ? 'top' : 'bottom'" size="17" color="#587189" /></button>
      <view v-if="basicOpen" class="basic-content">
        <view v-for="field in basicFields" :key="field.label" class="basic-row"><text class="basic-label">{{ field.label }}</text><PhoneText v-if="field.phone" class="basic-value" :text="field.value" /><text v-else class="basic-value" selectable>{{ field.value }}</text></view>
      </view>
    </view>
  </view>
</template>
<script>
import ParcelJourney from '@/components/ParcelJourney.vue';
import LogisticsTimeline from '@/components/LogisticsTimeline.vue';
import PhoneText from '@/components/PhoneText.vue';
import { courierPhones } from '@/services/logistics-contacts.js';
import { parcelJourney } from '@/services/parcel-journey.js';
import { pickupCabinet, stationDisplayName } from '@/services/station-presentation.js';
export default {
  components: { ParcelJourney, LogisticsTimeline, PhoneText },
  props: { order: { type: Object, default: () => ({}) }, shipment: { type: Object, default: () => ({}) }, pickup: Object, status: { type: String, default: '待取件' }, sources: { type: Array, default: () => [] } },
  data: () => ({ fullTitle: false, smsOpen: false, logisticsOpen: false, basicOpen: false }),
  watch: { 'order.id'() { this.reset(); }, 'shipment.id'() { this.logisticsOpen = false; this.smsOpen = false; } },
  computed: {
    displayTitle() { const value = Array.from(this.order.title || '未关联订单'); return this.fullTitle || value.length <= 15 ? value.join('') : value.slice(0, 15).join('') + '…'; },
    platform() { return ({ taobao: '淘宝', pdd: '拼多多', jd: '京东', douyin: '抖音' })[this.order.platform] || this.order.platform || (this.order.source === 'manual' ? '手动记录' : '未关联订单'); },
    code() { return String(this.pickup?.code || this.shipment.displayPickupCode || ''); },
    codeSize() { return this.code.length > 12 ? 'extended' : this.code.length > 10 ? 'long' : this.code.length > 8 ? 'compact' : ''; },
    cabinet() { return pickupCabinet(this.pickup || this.shipment); },
    cabinetNumber() { return /^(\d+)号柜$/.exec(this.cabinet)?.[1] || ''; },
    journey() { return parcelJourney(this.shipment, this.order); },
    basicFields() {
      const value = input => String(input ?? '').trim() || '未知';
      return [{ label: '订单号', value: value(this.order.platformOrderId) },
        { label: '运单号', value: value(this.shipment.waybillNo || (!this.shipment.id ? this.order.waybillNo : '')) },
        { label: '平台名称', value: value(this.order.platform ? this.platform : '') },
        { label: '订单状态', value: value(this.order.orderStatus || this.order.tradeStatus) },
        { label: '快递名称', value: value(this.shipment.carrier) },
        { label: '派送员电话', value: courierPhones(this.shipment).map(contact => contact.text).join('、') || '未提供', phone: true }];
    },
    latest() { return (this.shipment.logisticsEvents || []).slice().sort((a, b) => Number(b.time || 0) - Number(a.time || 0))[0]; },
    logisticsStatus() { if (this.shipment.picked) return this.shipment.isHomeDelivery ? '已签收' : '已取件'; return ({ arrived: '已到站', awaiting_code: '已到站', transit: '运输中', signed: '已签收', returning: '退回中', returned: '已退回' })[this.shipment.status] || this.status; }
  },
  methods: {
    stationDisplayName,
    reset() { this.fullTitle = this.smsOpen = this.logisticsOpen = this.basicOpen = false; },
    copy(value) { if (value) uni.setClipboardData({ data: String(value) }); },
    time(value) { if (!Number(value)) return ''; const date = new Date(Number(value)); if (Number.isNaN(date.getTime())) return ''; return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); }
  }
};
</script>
<style scoped lang="scss">
.order-overview{color:var(--sf-text);min-width:0;}
button{margin:0;padding:0;background:transparent;border:0;color:inherit;font:inherit;line-height:1.5;border-radius:0;text-align:left;}button::after{border:0;}button:focus-visible{outline:3px solid var(--sf-blue);outline-offset:3px;}
.product-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}.product-name{flex:1;min-width:0;font-size:18px;font-weight:700;line-height:1.5;overflow-wrap:anywhere;}.product-state{flex:none;padding:3px 11px;border-radius:8px;background:#dff1ec;color:#088477;font-size:13px;font-weight:650;line-height:1.6;max-width:40%;overflow-wrap:anywhere;}
.product-meta{display:flex;align-items:center;gap:18px;margin-top:7px;color:#61758b;font-size:13px;line-height:1.6;}.family{padding:2px 8px;border-radius:7px;background:#e1efed;color:#28766b;font-weight:650;}
.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:20px 0 10px;font-size:17px;font-weight:650;}.section-heading button{display:flex;align-items:center;gap:3px;min-height:36px;font-size:13px;font-weight:400;color:#1874d4;}.sms-original{padding:12px;margin-bottom:12px;border-radius:14px;background:#ffffff80;}.sms-original>view+view{margin-top:12px;}.source-meta,.sms-body{display:block;overflow-wrap:anywhere;}.source-meta{font-size:11px;color:var(--sf-muted);}.sms-body{margin-top:5px;white-space:pre-wrap;font-size:14px;line-height:1.65;}
.pickup-boxes{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(0,1.05fr);align-items:start;gap:8px;}.pickup-boxes.no-cabinet{grid-template-columns:1fr;}.wide-code .code-box{grid-column:1 / -1;}.wide-code:not(.no-cabinet) .cabinet-column{grid-column:2;}
.code-box,.cabinet-box{display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box;inline-size:100%;min-width:0;min-height:95px;padding:12px;border:1px solid #cfdef0;border-radius:18px;background:#e5eefb90;}.cabinet-box{padding-inline:10px;border-color:#c7e4de;background:linear-gradient(130deg,#def3ec,#cfeee7);color:#10796e;}.cabinet-column{display:flex;flex-direction:column;gap:5px;min-width:0;}
.station-icon,.station-action{flex:none;}.station-name{flex:1;min-width:0;}.station-action{display:flex;align-items:center;justify-content:flex-end;min-height:32px;}.station-action :deep(button){display:inline-flex;align-items:center;justify-content:center;gap:4px;min-height:32px;max-inline-size:100%;margin:0;padding:4px 6px;font-size:12px;line-height:1.4;white-space:nowrap;}
.box-label{display:flex;align-items:center;justify-content:space-between;inline-size:100%;color:#586f85;font-size:13px;font-weight:650;line-height:1.4;}.cabinet-box .box-label{color:#328377;}.code-value{display:block;inline-size:100%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:clamp(1.625rem,1.1rem + 2.2vw,2rem);font-weight:750;line-height:1.4;letter-spacing:0;font-variant-numeric:tabular-nums;text-align:center;white-space:nowrap;overflow-wrap:normal;word-break:normal;}.code-value.compact{font-size:clamp(1.25rem,.7rem + 2.5vw,1.5rem);}.code-value.long{font-size:clamp(1.125rem,.65rem + 2.1vw,1.375rem);}.code-value.extended{font-size:clamp(1rem,.5rem + 2.5vw,1.25rem);}.code-value.unknown{font-family:inherit;font-size:1.25rem;line-height:1.6;color:#6e7f92;}.cabinet-number{display:flex;align-items:baseline;justify-content:center;gap:3px;inline-size:100%;font-size:1rem;font-weight:750;line-height:1.5;white-space:nowrap;}.cabinet-digit{font-size:clamp(1.75rem,1.25rem + 2.5vw,2.25rem);line-height:1.2;}.station-row{display:flex;align-items:center;gap:7px;margin:15px 3px 16px;font-size:15px;font-weight:650;line-height:1.5;overflow-wrap:anywhere;}
.journey-section{border-top:1px solid #cbd9e8;padding-top:13px;margin-bottom:15px;}.section-title{display:block;font-size:17px;font-weight:700;margin-bottom:14px;}
.fold-card{margin-top:12px;padding:13px 14px 17px;border:1px solid #d2dfed;border-radius:18px;background:#f7faffb3;}.fold-heading{display:flex;align-items:center;gap:10px;width:100%;min-height:30px;font-size:16px;font-weight:700;}.fold-action{margin-left:auto;color:#1874d4;font-size:12px;font-weight:400;white-space:nowrap;}.fold-chevron{margin-left:auto;}.latest-row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin:12px 0 5px;}.carrier-state{color:#087f72;font-size:14px;font-weight:650;}.latest-time{color:#657b91;font-size:12px;white-space:nowrap;}.latest-copy{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#637b91;font-size:13px;line-height:1.8;}.basic-content{display:grid;gap:8px;margin-top:14px;font-size:13px;line-height:1.75;}.basic-row{display:grid;grid-template-columns:5.5em minmax(0,1fr);align-items:baseline;gap:10px;}.basic-label{color:#647c93;}.basic-value{min-width:0;text-align:right;overflow-wrap:anywhere;}
@media(max-width:350px){.product-name{font-size:16px;}.code-box,.cabinet-box{padding:12px 10px;}.fold-card{padding-inline:11px;}.fold-heading{font-size:15px;gap:7px;}.fold-action{font-size:11px;}}
.product-name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.product-name.expanded{white-space:normal;}.box-icon{width:18px;height:18px;flex:none;}.section-icon{width:22px;height:22px;flex:none;color:#1874d4;}.fold-action{display:flex;align-items:center;gap:3px;}
.section-heading{margin-top:10px;}.station-row{margin-block:12px;}.section-title{margin-bottom:8px;}.journey-section{margin-bottom:6px;padding-top:11px;}.fold-card{padding-block:11px 13px;}.fold-heading{min-height:26px;}.latest-row{margin-top:8px;}
</style>
