<template>
  <text class="phone-text"><template v-for="(part, index) in parts" :key="index"><button v-if="part.phone" class="phone-number" role="button" :tabindex="dialing ? -1 : 0" :disabled="dialing" :aria-label="'拨打电话 ' + part.text" @click.stop="call(part.phone)" @keydown.enter.prevent.stop="$event.preventDefault()" @keyup.enter.prevent.stop="call(part.phone)" @keydown.space.prevent.stop="$event.preventDefault()" @keyup.space.prevent.stop="call(part.phone)">{{ part.text }}</button><text v-else>{{ part.text }}</text></template></text>
</template>
<script>
import { phoneSegments } from '@/services/logistics-contacts.js';
import { dialPhone } from '@/services/assistant.js';
export default {
  props: { text: { type: String, default: '' } },
  data: () => ({ dialing: false }),
  computed: { parts() { return phoneSegments(this.text); } },
  methods: {
    async call(phone) {
      if (this.dialing) return;
      this.dialing = true;
      try { await dialPhone(phone); }
      catch (error) { uni.showToast({ title: error?.message || '无法打开拨号界面', icon: 'none' }); }
      finally { this.dialing = false; }
    }
  }
};
</script>
<style scoped>
.phone-text{white-space:pre-wrap;overflow-wrap:anywhere;}
.phone-number{display:inline-flex;align-items:center;min-height:24px;margin:0;padding:2px 1px;background:transparent;border:0;border-radius:3px;color:var(--sf-blue,#1673ff);font:inherit;line-height:inherit;text-align:inherit;text-decoration:underline;text-underline-offset:3px;white-space:nowrap;vertical-align:baseline;}
.phone-number::after{border:0;}.phone-number:focus-visible{outline:3px solid var(--sf-blue,#1673ff);outline-offset:2px;}.phone-number[disabled]{opacity:.6;}
</style>
