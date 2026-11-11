<template>
  <view class="logistics" @click.stop>
    <view v-if="latest && !expanded && !expandedOnly" class="latest">
      <PhoneText class="description" :text="'最新物流：' + (latest.description || latest.location)" />
      <PhoneText class="muted" :text="eventTime(latest) + (latest.location && latest.description ? ' · '+latest.location : '')" />
    </view>
    <text v-if="notice" class="notice" :class="{ warning: shipment.logisticsState === 'error' || shipment.logisticsError }">{{ notice }}</text>
    <text v-if="updatedTime" class="muted">轨迹更新 {{ updatedTime }}</text>
    <text v-if="checkedTime && checkedTime !== updatedTime" class="muted">最近查询 {{ checkedTime }}</text>
    <button v-if="events.length && !expandedOnly" class="toggle" :aria-expanded="expanded ? 'true' : 'false'" @click.stop="expanded = !expanded">{{ expanded ? '收起物流轨迹' : '查看物流轨迹' }} · {{ events.length }} 条 {{ expanded ? '⌃' : '⌄' }}</button>
    <view v-if="expanded || expandedOnly" class="events">
      <view v-for="(event, index) in events" :key="index" class="event" :class="{ current: index === 0 }">
        <text class="muted">{{ eventTime(event) }}</text>
        <PhoneText class="description" :text="event.description || event.location" />
        <PhoneText v-if="event.location && event.description" class="muted" :text="event.location" />
      </view>
      <text v-if="shipment.logisticsTruncated" class="muted">仅保留最近 {{ events.length }} 条轨迹</text>
      <text class="muted cache-note">以上为已同步记录，更新后会自动显示。</text>
    </view>
  </view>
</template>
<script>
import PhoneText from '@/components/PhoneText.vue';
export default {
  components: { PhoneText },
  props:{shipment:{type:Object,default:()=>({})},expandedOnly:Boolean},
  data:()=>({expanded:false}),
  watch:{'shipment.id'(){this.expanded=false;}},
  computed:{
    events(){return (Array.isArray(this.shipment.logisticsEvents)?this.shipment.logisticsEvents:[]).filter(event=>event&&(event.description||event.location)).slice().sort((a,b)=>(this.validTime(b.time)||0)-(this.validTime(a.time)||0));},
    latest(){return this.events[0];},
    updatedTime(){return this.time(this.shipment.logisticsUpdatedAt);},
    checkedTime(){return this.time(this.shipment.logisticsCheckedAt);},
    notice(){if(this.shipment.logisticsError)return this.shipment.logisticsError;const state=this.shipment.logisticsState;if(this.events.length){return {error:'最近查询失败，显示上次保存的轨迹',empty:'最近查询未返回轨迹，保留上次记录',unavailable:'平台暂未提供新轨迹，显示上次保存的记录'}[state]||'';}if(!this.shipment.waybillNo)return '暂无运单号，暂无法查看物流';return {error:'最近查询失败，暂未保存物流轨迹',unavailable:'平台暂未提供物流轨迹',empty:'暂无物流轨迹',ok:'暂无物流轨迹'}[state]||'物流轨迹待同步';}
  },
  methods:{
    validTime(value){const number=Number(value);return Number.isFinite(number)&&number>0&&!Number.isNaN(new Date(number).getTime())?number:0;},
    time(value){const timestamp=this.validTime(value);return timestamp?new Date(timestamp).toLocaleString('zh-CN',{hour12:false}):'';},
    eventTime(event){return this.time(event.time)||event.timeText||'时间未知';}
  }
};
</script>
<style scoped lang="scss">
.logistics{width:100%;min-width:0;margin-top:14px;font-size:14px;line-height:1.7;color:var(--sf-text);word-break:break-word;overflow-wrap:anywhere;}
.description,.muted,.notice{display:block;white-space:pre-wrap;}.latest{margin-bottom:8px;}.description{line-height:1.7;}.muted,.notice{color:var(--sf-muted);font-size:12px;line-height:1.75;}.warning{color:#80591f;background:#fff3da75;border:1px solid #dac9ad;border-radius:11px;padding:9px 11px;margin:8px 0;font-size:13px;}
.toggle{display:block;width:auto;min-height:44px;padding:8px 0;margin:4px 0 0;background:transparent;text-align:left;font-size:14px;line-height:1.7;color:var(--sf-blue);border-radius:0;}.toggle::after{border:0;}.toggle:focus-visible{outline:3px solid var(--sf-blue);outline-offset:3px;}
.events{margin-top:10px;padding-left:7px;}.event{position:relative;padding:0 0 21px 20px;border-left:1px solid #b5c4d7;}.event::before{content:'';position:absolute;left:-4px;top:6px;width:7px;height:7px;border-radius:50%;background:#8f9fb5;box-shadow:0 0 0 4px #eef3f8;}.event.current::before{background:var(--sf-blue);}.event.current .description{font-weight:600;}.event .description{margin-top:4px;}.event:last-of-type{border-color:transparent;padding-bottom:8px;}.cache-note{margin-top:8px;}
@media(forced-colors:active){.event::before{background:CanvasText;}.event.current::before{background:Highlight;}}
</style>
