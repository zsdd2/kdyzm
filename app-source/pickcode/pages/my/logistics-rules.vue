<template>
  <view class="logistics-rules sf-page">
    <view class="scope-note sf-surface">
      <text class="scope-title">历史缓存规则</text>
      <text>新版平台订单由后台统一识别。这里的规则仅处理尚未同步升级的旧缓存；平台识别规则请在后台调整。</text>
      <text>预计、未到达、退回、中转和催取提醒不会被当作新的到站事件。</text>
    </view>

    <view v-if="loadError" class="inline-error" @click="loadRules">{{ loadError }} · 点击重试</view>
    <view v-if="loading" class="loading-hint">正在加载规则...</view>
    <view v-else-if="!rules.length && !editing" class="empty-state"><text>暂无物流规则</text></view>

    <view v-if="rules.length && !editing" class="rules-list">
      <view class="rule-card sf-surface" v-for="rule in rules" :key="rule.id">
        <view class="rule-header">
          <view class="rule-info" @click="openEdit(rule)">
            <text class="rule-name">{{ rule.name }}</text>
            <text class="rule-meta">{{ rule.kind === 'arrival' ? '到站事件' : '站点位置' }} · {{ rule.origin === 'builtin' ? '内置规则' : '手动添加' }}</text>
          </view>
          <switch :checked="rule.enabled" :disabled="!!busyId" color="#0867ff" @change="toggleRule(rule, $event)" />
        </view>
        <view class="rule-actions">
          <button type="default" class="action-btn edit" :aria-label="'编辑规则 ' + rule.name" @click="openEdit(rule)"><uni-icons type="compose" size="18" color="#0867ff" /><text>编辑</text></button>
          <button type="default" class="action-btn delete" :aria-label="'删除规则 ' + rule.name" @click="deleteRule(rule)"><uni-icons type="trash" size="18" color="#ff4d4f" /><text>删除</text></button>
        </view>
      </view>
    </view>

    <view v-if="editing" class="editor-card sf-surface">
      <view class="editor-heading"><text class="section-title">{{ draft.id ? '编辑物流规则' : '添加物流规则' }}</text><text class="cancel" @click="cancelEdit">取消</text></view>
      <label for="logistics-rule-name" class="field-label">规则名称</label>
      <input id="logistics-rule-name" v-model="draft.name" class="text-input" placeholder="请输入规则名称" maxlength="60" :disabled="saving || testing" />

      <text class="field-label">规则类型</text>
      <picker :range="kindOptions" range-key="label" :value="kindIndex" @change="draft.kind = kindOptions[$event.detail.value].value">
        <view class="picker-input">{{ kindOptions[kindIndex].label }}<uni-icons type="right" size="16" color="#999" /></view>
      </picker>

      <text class="field-label">起始文字（每行一种）</text>
      <textarea v-model="startsText" class="textarea" placeholder="例如：已暂存至\n包裹已到" maxlength="1000" :disabled="saving || testing" />
      <text class="field-label">全部包含关键词（每行一种，可选）</text>
      <textarea v-model="keywordsText" class="textarea short" placeholder="例如：取件\n站点" maxlength="600" :disabled="saving || testing" />
      <text class="field-label">结束文字（可留空）</text>
      <input v-model="draft.end" class="text-input" placeholder="例如：，请及时取件" maxlength="80" :disabled="saving || testing" />

      <view class="sample-section">
        <text class="field-label">样例测试</text>
      <textarea v-model="draft.sample" class="textarea" placeholder="粘贴一条物流文本" maxlength="600" :disabled="saving || testing" />
        <label for="expected-station" class="field-label">预期站名</label><input id="expected-station" v-model="draft.expectedStation" class="text-input" placeholder="预期站名（用于核对）" maxlength="120" :disabled="saving || testing" />
        <button class="test-btn" :disabled="testing || saving || !canTest" :loading="testing" @click="testDraft">{{ testing ? '正在测试' : '测试当前规则' }}</button>
        <view v-if="testMessage" class="test-result" :class="testPassed ? 'success' : 'error'">{{ testMessage }}</view>
      </view>

      <button class="save-btn" :disabled="!canSave" :loading="saving" @click="saveDraft">{{ saving ? '正在保存' : '保存规则' }}</button>
    </view>

    <button class="add-btn" :disabled="!!busyId || editing" @click="openAdd"><uni-icons type="plusempty" size="18" color="#fff" /><text>添加规则</text></button>
    <button class="reset-btn" :disabled="!!busyId || saving" @click="resetRules">恢复默认规则</button>
  </view>
</template>

<script>
import { getSnapshot, mutate, testLogisticsRule } from '@/services/assistant.js';

const blankRule = () => ({ id: '', name: '', enabled: true, kind: 'arrival', starts: [], end: '', keywords: [], sample: '', expectedStation: '', origin: 'manual' });

export default {
  data() {
    return {
      rules: [], loading: false, loadError: '', busyId: '', editing: false, saving: false, testing: false,
      draft: blankRule(), startsText: '', keywordsText: '', testMessage: '', testPassed: false,
      kindOptions: [{ value: 'arrival', label: '到站事件' }, { value: 'location', label: '仅站点位置' }]
    };
  },
  computed: {
    kindIndex() { return Math.max(0, this.kindOptions.findIndex(item => item.value === this.draft.kind)); },
    canTest() { return this.draft.sample.trim() && this.draft.name.trim() && this.startsText.trim(); },
    canSave() { return this.draft.name.trim() && this.startsText.trim() && !this.saving && !this.testing && !this.loadError; }
  },
  onLoad() { uni.$on('assistant-changed', this.loadRules); },
  onShow() { this.loadRules(); },
  onUnload() { uni.$off('assistant-changed', this.loadRules); },
  methods: {
    async loadRules() {
      this.loading = true; this.loadError = '';
      try { this.rules = (await getSnapshot()).logisticsRules || []; }
      catch (error) { this.loadError = error.message || '物流规则加载失败'; }
      finally { this.loading = false; }
    },
    openAdd() { this.draft = blankRule(); this.startsText = ''; this.keywordsText = ''; this.testMessage = ''; this.testPassed = false; this.editing = true; },
    openEdit(rule) {
      this.draft = { ...blankRule(), ...JSON.parse(JSON.stringify(rule)), starts: [...(rule.starts || [])], keywords: [...(rule.keywords || [])] };
      this.startsText = this.draft.starts.join('\n'); this.keywordsText = this.draft.keywords.join('\n'); this.testMessage = ''; this.testPassed = false; this.editing = true;
    },
    cancelEdit() { if (this.saving || this.testing) return; this.editing = false; this.testMessage = ''; },
    normalizedDraft() { return { ...this.draft, name: this.draft.name.trim(), starts: this.startsText.split(/\r?\n/).map(item => item.trim()).filter(Boolean), keywords: this.keywordsText.split(/\r?\n/).map(item => item.trim()).filter(Boolean) }; },
    async testDraft() {
      if (!this.canTest || this.testing) return;
      this.testing = true; this.testMessage = '';
      try {
        const result = await testLogisticsRule(this.normalizedDraft(), this.draft.sample);
        if (!result || (this.draft.id && result.ruleId !== this.draft.id)) throw new Error(result?.reason || '样例未通过当前规则');
        if (!result.station) throw new Error('样例未识别站点');
        if (Boolean(result.arrival) !== (this.draft.kind === 'arrival')) throw new Error(this.draft.kind === 'arrival' ? '样例未识别为到站事件' : '样例被识别为到站事件，请调整规则类型');
        const expected = this.draft.expectedStation.trim();
        if (expected && result.station !== expected) throw new Error(`识别为“${result.station || '未识别'}”，与预期站名不一致`);
        this.testPassed = true; this.testMessage = `测试通过：${result.station || '未识别'}${result.arrival ? ' · 到站事件' : ''}`;
      } catch (error) { this.testPassed = false; this.testMessage = error.message || '样例测试失败'; }
      finally { this.testing = false; }
    },
    async saveDraft() {
      if (!this.canSave) return;
      this.saving = true;
      try {
        const rule = this.normalizedDraft();
        if (this.rules.some(item => item.name === rule.name && item.id !== rule.id)) throw new Error('规则名称已存在');
        await mutate('saveLogisticsRule', { rule });
        await this.loadRules(); this.editing = false; uni.showToast({ title: '规则已保存', icon: 'success' });
      } catch (error) { uni.showToast({ title: error.message || '保存失败，请重试', icon: 'none' }); }
      finally { this.saving = false; }
    },
    async toggleRule(rule, event) {
      if (this.busyId) return;
      this.busyId = rule.id;
      try { const snapshot = await mutate('toggleLogisticsRule', { id: rule.id, enabled: event.detail.value }); this.rules = snapshot.logisticsRules || this.rules; }
      catch (error) { await this.loadRules(); uni.showToast({ title: error.message || '修改失败', icon: 'none' }); }
      finally { this.busyId = ''; }
    },
    deleteRule(rule) {
      if (this.busyId) return;
      uni.showModal({ title: '删除规则？', content: `删除后本机不再使用“${rule.name}”识别物流。`, success: async result => {
        if (!result.confirm) return;
        this.busyId = rule.id;
        try { const snapshot = await mutate('deleteLogisticsRule', { id: rule.id }); this.rules = snapshot.logisticsRules || []; uni.showToast({ title: '已删除', icon: 'success' }); }
        catch (error) { uni.showToast({ title: error.message || '删除失败', icon: 'none' }); }
        finally { this.busyId = ''; }
      } });
    },
    resetRules() {
      uni.showModal({ title: '恢复默认规则？', content: '本机手动添加的物流规则将被删除。', success: async result => {
        if (!result.confirm || this.busyId || this.saving) return;
        this.busyId = 'reset';
        try { const snapshot = await mutate('resetLogisticsRules'); this.rules = snapshot.logisticsRules || []; this.editing = false; uni.showToast({ title: '已恢复默认', icon: 'success' }); }
        catch (error) { uni.showToast({ title: error.message || '恢复失败', icon: 'none' }); }
        finally { this.busyId = ''; }
      } });
    }
  },
  watch: {
    draft: { deep: true, handler() { if (!this.testing) { this.testMessage = ''; this.testPassed = false; } } },
    startsText() { if (!this.testing) { this.testMessage = ''; this.testPassed = false; } },
    keywordsText() { if (!this.testing) { this.testMessage = ''; this.testPassed = false; } }
  }
};
</script>

<style lang="scss" scoped>
.logistics-rules { padding: 16px 16px calc(32px + env(safe-area-inset-bottom)); box-sizing: border-box; }
.scope-note, .rule-card, .editor-card { border-radius: 24px; padding: 18px; margin-bottom: 14px; }
.scope-note text { display: block; color: var(--sf-muted); font-size: 13px; line-height: 1.75; }.scope-note .scope-title { color: var(--sf-teal); font-size: 15px; font-weight: 650; margin-bottom: 6px; }
.inline-error { color: #aa343b; background: #fff0ef; padding: 12px 14px; border-radius: 14px; margin-bottom: 12px; font-size: 14px; line-height: 1.7; }
.loading-hint, .empty-state { color: var(--sf-muted); text-align: center; padding: 48px 0; font-size: 15px; }
.rule-header, .editor-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.rule-info { flex: 1; min-width: 0; }.rule-name, .rule-meta { display: block; }.rule-name { color: var(--sf-text); font-size: 17px; line-height: 1.5; font-weight: 650; }.rule-meta { color: var(--sf-muted); font-size: 13px; margin-top: 6px; }
.rule-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }.action-btn { display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 44px; height: auto; padding: 10px 14px; margin: 0; border: 0; border-radius: 12px; line-height: 1.5; font-size: 14px; }.edit { background: rgba(8,103,255,.08); color: var(--sf-blue); }.delete { background: #ffeded; color: #aa343b; }
.section-title { color: var(--sf-text); font-size: 18px; font-weight: 650; }.cancel { display: flex; align-items: center; min-height: 44px; color: var(--sf-blue); font-size: 15px; }.field-label { display: block; color: var(--sf-text); font-size: 15px; margin: 20px 0 8px; }
.text-input, .textarea, .picker-input { width: 100%; box-sizing: border-box; border: 1px solid #8796ab; border-radius: 12px; background: rgba(255,255,255,.38); color: var(--sf-text); font-size: 16px; padding: 0 12px; }.text-input, .picker-input { height: 48px; line-height: 48px; }.picker-input { display: flex; justify-content: space-between; align-items: center; }.textarea { height: 112px; padding-block: 12px; line-height: 1.65; }.textarea.short { height: 96px; }
.sample-section { margin-top: 20px; padding-top: 2px; border-top: 1px solid rgba(98,118,145,.15); }.test-btn, .save-btn, .add-btn, .reset-btn { min-height: 48px; height: auto; padding: 11px 14px; font-size: 15px; line-height: 1.6; border: 0; border-radius: 14px; margin-top: 14px; }.test-btn { color: var(--sf-blue); background: rgba(8,103,255,.08); }.save-btn, .add-btn { color: #fff; background: var(--sf-blue); }.add-btn { display: flex; justify-content: center; align-items: center; gap: 8px; }.reset-btn { color: var(--sf-muted); background: rgba(255,255,255,.3); }.test-result { font-size: 14px; line-height: 1.7; margin-top: 12px; overflow-wrap: anywhere; }.success { color: var(--sf-teal); }.error { color: #aa343b; }button::after { border: 0; }button[disabled] { opacity: .5; }
</style>
