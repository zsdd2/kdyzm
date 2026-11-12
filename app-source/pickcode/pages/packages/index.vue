<template>
  <view class="records-page">
    <view class="records-container" :inert="stationChooserOpen ? true : null">
      <view class="topline">
        <text class="page-title">包裹记录</text>
        <button role="button" tabindex="0" class="round-btn" aria-label="添加快递" @click="showAddPackage"><uni-icons type="plusempty" size="20" color="#54647c" /></button>
      </view>
      <view class="scope-row">
        <button role="button" tabindex="0" class="scope-button" aria-label="筛选角色、时间和隐藏记录" @click="openFilters"><text class="role-dot"></text><text>{{ selectedFamilyName }}</text><uni-icons type="bottom" size="13" color="#647186" /></button>
        <text class="period">{{ showExpired ? '过期订单' : showHistory ? '全部时间' : '最近 30 天' }}{{ showHidden ? ' · 含已隐藏' : '' }}</text>
      </view>

      <view v-if="!hydrated && !error" class="loading-state" aria-label="正在读取本地记录" aria-busy="true"><view class="skeleton hero-skeleton"></view><view class="skeleton"></view></view>
      <template v-else>
        <view class="dashboard">
          <view class="dashboard-total">
            <text class="total-caption">未收到</text>
            <view class="count"><text class="total-number">{{ totals.total }}</text><text class="count-unit">个包裹</text></view>
          </view>
          <view class="platform-grid" role="group" aria-label="按平台筛选">
            <button role="button" tabindex="0" class="platform-card" :class="{ selected: selectedPlatform === 'all' }" :aria-pressed="selectedPlatform === 'all'" @click="setQuickFilter('platform', 'all')">全部平台</button>
            <button role="button" tabindex="0" v-for="platform in mainPlatforms" :key="platform.key" class="platform-card" :class="{ selected: selectedPlatform === platform.key }" :aria-pressed="selectedPlatform === platform.key" :aria-label="platform.label + '，' + platformStats(platform.key).total + '个包裹'" @click="setQuickFilter('platform', platform.key)">
              <text>{{ platform.label }}</text><text class="platform-amount">{{ platformStats(platform.key).total }}</text>
            </button>
          </view>
          <view class="platform-toolbar">
            <button role="button" tabindex="0" :class="{ selected: selectedPlatform === 'manual' }" :aria-pressed="selectedPlatform === 'manual'" @click="setQuickFilter('platform', 'manual')">手动 {{ totals.manual }}</button>
            <button role="button" tabindex="0" :class="{ selected: selectedPlatform === 'other' }" :aria-pressed="selectedPlatform === 'other'" @click="setQuickFilter('platform', 'other')">其他平台</button>
            <button role="button" tabindex="0" :class="{ selected: selectedProgress === 'other' }" :aria-pressed="selectedProgress === 'other'" @click="setQuickFilter('progress', 'other')">其他记录</button>
          </view>
          <view class="status-filter" role="group" aria-label="按包裹进度筛选">
            <button role="button" tabindex="0" v-for="stage in progressOptions.slice(0, 3)" :key="stage.key" :class="{ selected: selectedProgress === stage.key }" :aria-pressed="selectedProgress === stage.key" :aria-label="stage.label + '，' + progressCount(stage.key) + progressUnit(stage.key)" @click="setQuickFilter('progress', stage.key)"><text class="status-name">{{ stage.label }}</text><text class="status-number">{{ progressCount(stage.key) }}<text>{{ progressUnit(stage.key) }}</text></text></button>
          </view>
        </view>

        <view class="sync-line" :class="{ offline: !!error }" role="status">
          <text class="sync-dot" :class="{ syncing: refreshing || backgroundSyncing }"></text><text class="sync-copy">{{ syncText }}</text>
          <button role="button" :tabindex="(refreshing || backgroundSyncing) ? -1 : 0" :disabled="refreshing || backgroundSyncing" :aria-disabled="refreshing || backgroundSyncing" aria-label="更新包裹记录" @click="retrySync">{{ error ? '重试' : '更新' }}</button>
        </view>
        <view class="records-heading">
          <view><text class="section-title">{{ resultTitle }}</text><text class="result-count">{{ resultSummary }}</text></view>
          <view class="record-actions"><button role="button" tabindex="0" v-if="!showExpired" @click="openExpired">过期订单 {{ archivedCount }}</button><button role="button" tabindex="0" v-if="selectedPlatform === 'all' && selectedProgress === 'all' && !showHistory && !showExpired" @click="openHistory">历史记录</button><button role="button" tabindex="0" v-else @click="clearQuickFilters">{{ showHistory || showExpired ? '返回未收到' : '清除筛选' }}</button></view>
        </view>

        <view ref="recordList" class="record-list" tabindex="-1" aria-label="包裹列表">
          <view v-if="!filteredGroups.length" class="empty-state"><image class="empty-icon" src="/static/images/parcel-outline.svg" mode="aspectFit" /><text class="empty-title">{{ packages.length ? '没有符合条件的记录' : '还没有包裹记录' }}</text><text class="empty-copy">{{ emptyNotice() }}</text><button role="button" tabindex="0" v-if="packages.length" @click="openFilters">调整筛选</button><button role="button" tabindex="0" v-else @click="showAddPackage">添加快递</button></view>
          <view v-for="group in filteredGroups" :key="group.date" class="day-section">
            <view class="day-head"><text>{{ formatDate(group.date) }}</text><text v-if="selectedProgress === 'done' && !showExpired" class="date-basis">按取件时间</text><button role="button" tabindex="0" :aria-label="'隐藏' + formatDate(group.date) + '当前筛选的订单'" @click="confirmDeleteDateGroup(group)">管理</button></view>
            <view v-for="list in group.list" :key="list.id" class="order-card" :class="{ completed: journeyCard(list).collected, 'hidden-order': list.hidden }" :style="{ 'view-transition-name': transitionName(list.id) }" :aria-label="familyLabel(list) + '的' + list.title + '，' + cardStatus(list)">
              <template v-for="card in [journeyCard(list)]" :key="card.id">
              <button role="button" tabindex="0" class="order-open" :aria-label="'查看' + familyLabel(list) + '的' + list.title + '详情'" @click="openDetails(list)">
                <view class="order-top"><view class="order-identity"><text class="order-platform">{{ platformLabel(card) }}</text><view class="family-ticket" :style="familyStyle(card.familyId)" :title="familyLabel(card)"><text class="family-ticket-name">{{ familyLabel(card) }}</text></view></view><text class="status-label" :class="cardProgress(card)"><text class="status-dot"></text>{{ cardStatus(card) }}</text></view>
                <view class="order-main" :class="{ 'history-main': card.collected }">
                  <view v-if="!card.collected" class="goods-glyph"><img v-if="card.imageUrl && !failedProductImages[card.imageUrl]" :key="card.imageUrl" class="goods-image" :src="card.imageUrl" :data-image-url="card.imageUrl" width="46" height="48" alt="商品图" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="productImageFailed" /><image v-else class="goods-icon" src="/static/images/parcel-outline.svg" mode="aspectFit" aria-hidden="true" /></view>
                  <view class="goods-info"><text class="goods-name" :title="card.title">{{ shortTitle(card.title || '未命名订单') }}</text><text v-if="!card.collected" class="order-sub"><template v-if="card.amount != null">{{ money(card.amount) }}</template></text></view>
                  <uni-icons v-if="!card.collected" type="right" size="17" color="#536073" />
                </view>
                <view v-if="!card.collected" class="order-status"><text v-if="completionSummary(card) && !isExpiredOrder(card)" class="completion-chip">{{ completionSummary(card) }}</text><text class="order-count">{{ recordCountLabel(card) }}</text></view>
                <text v-if="!card.collected && summaryLogistics(card)" class="order-summary">{{ summaryLogistics(card) }}</text>
              </button>
              <view v-if="!isExpiredOrder(card) && summaryShipment(card) && displayPickupCode(summaryShipment(card)) && !summaryShipment(card).picked" class="pickup-row">
                <view class="pickup-copy"><view class="pickup-line"><text v-if="pickupCabinet(summaryShipment(card))" class="cabinet-badge">{{ pickupCabinet(summaryShipment(card)) }}</text><button role="button" tabindex="0" class="pickup-code" :class="{ 'long-code': displayPickupCode(summaryShipment(card)).length > 8 }" @click="copyValue(displayPickupCode(summaryShipment(card)), '取件码')">{{ displayPickupCode(summaryShipment(card)) }}</button></view><text class="station">{{ stationDisplayName(summaryShipment(card), '站点未知') }}</text></view>
                <button v-if="journeyCardShipment(list).picked" role="button" tabindex="-1" class="small-primary" disabled aria-disabled="true">已取</button>
                <button role="button" :tabindex="shipmentBusy(journeyCardShipment(list)) ? -1 : 0" v-else-if="canPickShipment(list, journeyCardShipment(list))" class="small-primary" :disabled="shipmentBusy(journeyCardShipment(list))" :aria-disabled="shipmentBusy(journeyCardShipment(list))" :aria-label="'领取' + list.title" @click="requestPickup(list, journeyCardShipment(list))">{{ claimingShipmentIds[journeyCardShipment(list).id] ? '确认中' : '取件' }}</button>
                <button role="button" :tabindex="(!!syncingOrderId || list.hidden) ? -1 : 0" v-else-if="journeyCardShipment(list).needsPickupAssignment" class="small-primary" :disabled="!!syncingOrderId || list.hidden" :aria-disabled="!!syncingOrderId || list.hidden" @click="claimShipment(list, journeyCardShipment(list))">确认归属</button>
              </view>
              <view v-else-if="!isExpiredOrder(card) && summaryShipment(card)?.needsReceiptConfirmation && !summaryShipment(card).picked" class="receipt-row"><text>物流送达后，请确认已收到</text><button role="button" :tabindex="(shipmentBusy(journeyCardShipment(list)) || !canPickShipment(list, journeyCardShipment(list))) ? -1 : 0" class="small-primary receipt-confirm" :disabled="shipmentBusy(journeyCardShipment(list)) || !canPickShipment(list, journeyCardShipment(list))" :aria-disabled="shipmentBusy(journeyCardShipment(list)) || !canPickShipment(list, journeyCardShipment(list))" @click.stop="confirmReceipt(list, journeyCardShipment(list))">{{ journeyCardShipment(list).picked ? '已收到' : claimingShipmentIds[journeyCardShipment(list).id] ? '确认中' : '确认收到' }}</button></view>
              </template>
              <view v-if="list.collected || !isExpiredOrder(list)" class="order-journeys" @click="openDetails(list)"><view v-for="(entry, journeyIndex) in journeysByOrder[list.id]" :key="entry.id" class="order-journey"><text v-if="journeysByOrder[list.id].length > 1" class="journey-parcel-label">包裹 {{ journeyIndex + 1 }}</text><ParcelJourney :journey="entry.journey" /></view></view>
            </view>
          </view>
        </view>
      </template>
    </view>

    <uni-popup ref="filterPopup" type="bottom" :safe-area="false" :animation="!reducedMotion" @change="popupChanged('filterPopup', $event)">
      <view class="sheet filter-sheet" role="dialog" aria-modal="true" aria-label="筛选包裹">
        <view class="sheet-handle"></view><view class="sheet-inner">
          <view class="sheet-header"><text>筛选包裹</text><button role="button" tabindex="0" class="round-btn" aria-label="关闭筛选" @click="closePopup('filterPopup')"><uni-icons type="closeempty" size="18" color="#647186" /></button></view>
          <text class="field-label">角色</text><view class="choice-grid"><button role="button" tabindex="0" v-for="family in familyOptions" :key="family.id" :class="{ selected: filterDraft.family === family.id }" :aria-pressed="filterDraft.family === family.id" @click="filterDraft.family = family.id">{{ family.name }}</button></view>
          <text class="field-label">时间范围</text><view class="choice-grid period-grid"><button role="button" tabindex="0" :class="{ selected: !filterDraft.history }" :aria-pressed="!filterDraft.history" @click="filterDraft.history = false">当前订单</button><button role="button" tabindex="0" :class="{ selected: filterDraft.history }" :aria-pressed="filterDraft.history" @click="filterDraft.history = true">含过期历史</button></view>
          <view class="switch-row"><text>显示已隐藏记录</text><button class="toggle-switch" role="switch" tabindex="0" :aria-checked="filterDraft.hidden" aria-label="显示已隐藏记录" @click="filterDraft.hidden = !filterDraft.hidden"><view class="switch-track" :class="{ checked: filterDraft.hidden }"><view class="switch-thumb"></view></view></button></view>
          <button role="button" tabindex="0" class="primary-button" @click="applyFilters">应用筛选</button>
        </view>
      </view>
    </uni-popup>

    <uni-popup ref="detailPopup" type="bottom" :safe-area="false" :animation="!reducedMotion" @change="popupChanged('detailPopup', $event)">
      <view v-if="selectedOrder && !dateEditing" class="sheet detail-sheet" role="dialog" aria-modal="true" aria-label="订单详情" :inert="stationChooserOpen ? true : null">
        <view class="sheet-handle"></view>
        <view class="sheet-header detail-header"><text>订单详情</text><button role="button" tabindex="0" class="round-btn" aria-label="关闭详情" @click="closePopup('detailPopup')"><uni-icons type="closeempty" size="21" color="#647186" /></button></view>
        <view class="sheet-inner detail-body">
          <view v-if="selectedOrder.shipments.length > 1" class="shipment-picker" role="group" aria-label="选择包裹"><button v-for="(shipment, index) in selectedOrder.shipments" :key="shipment.id" role="button" tabindex="0" :aria-pressed="shipment.id === detailShipment.id" @click="detailShipmentId = shipment.id">包裹 {{ index + 1 }} · {{ shipment.picked ? '已取' : '未取' }}</button></view>
          <OrderOverview :order="selectedOrder" :shipment="detailShipment" :pickup="detailPickup" :sources="detailSources" :status="detailShipment.id ? (detailShipment.picked ? (isReceiptShipment(detailShipment) ? '已收货' : '已取件') : detailShipment.needsPickupAssignment ? '待确认归属' : displayPickupCode(detailShipment) ? '待取件' : shipmentText(detailShipment)) : statusText(selectedOrder)">
            <template #station-action>
              <button v-if="detailShipment.id" type="button" role="button" tabindex="0" class="station-action-button" :data-shipment-station="detailShipment.id" :disabled="!!syncingOrderId" @click="changeShipmentStation(detailShipment, $event)">更换站点</button>
            </template>
          </OrderOverview>
          <text v-if="refreshProgressText || error || notice" class="muted-inline" role="status">{{ refreshProgressText || error || notice }}</text>
          <view v-if="detailMore" class="detail-more" ref="detailMorePanel">
          <view v-if="isExpiredOrder(selectedOrder)" class="archive-meta"><text class="field-label">过期订单</text><text class="muted-inline">{{ archiveReceiptText(selectedOrder) }}</text><text class="muted-inline">{{ archiveSourceText(selectedOrder) }}</text><button role="button" :tabindex="syncingOrderId ? -1 : 0" class="secondary-button" :disabled="!!syncingOrderId" :aria-disabled="!!syncingOrderId" @click="restoreExpiredOrder(selectedOrder)">恢复到当前订单</button></view>
          <view v-if="detailShipment.id" class="shipment-management">
            <template v-for="shipment in [detailShipment]" :key="shipment.id">
              <button v-if="shipment.waybillNo" role="button" tabindex="0" class="tracking-number" @click="copyValue(shipment.waybillNo, '快递单号')">运单 {{ shipment.waybillNo }} · 复制</button>
            <view v-if="hasPickupCompletion(shipment)" class="completion-meta" :class="{ revoked: isCompletionRevoked(shipment) }">
              <view class="completion-meta-heading"><text class="completion-label">{{ completionStatusText(shipment) }}</text><text v-if="completionTimeText(shipment)" class="completion-time">{{ completionTimeText(shipment) }}</text></view>
              <text v-if="completionEvidenceText(shipment)" class="completion-evidence">依据：{{ completionEvidenceText(shipment) }}</text>
            </view>
            <button role="button" :tabindex="(!!syncingOrderId || !canResumeAutoCompletion(selectedOrder, shipment)) ? -1 : 0" v-if="!isExpiredOrder(selectedOrder) && isCompletionRevoked(shipment) && !selectedOrder.hidden && !shipment.hidden" class="secondary-button completion-action" :disabled="!!syncingOrderId || !canResumeAutoCompletion(selectedOrder, shipment)" :aria-disabled="!!syncingOrderId || !canResumeAutoCompletion(selectedOrder, shipment)" @click="resumeAutoCompletion(selectedOrder, shipment)">恢复自动判断</button>

            <button role="button" :tabindex="(shipmentBusy(shipment) || !canUndoAutoCompletion(selectedOrder, shipment)) ? -1 : 0" v-if="!isExpiredOrder(selectedOrder) && isAutoCompleted(shipment) && !selectedOrder.hidden && !shipment.hidden" class="secondary-button completion-action" :disabled="shipmentBusy(shipment) || !canUndoAutoCompletion(selectedOrder, shipment)" :aria-disabled="shipmentBusy(shipment) || !canUndoAutoCompletion(selectedOrder, shipment)" @click="claimShipment(selectedOrder, shipment)">{{ isCompletionRevoked(shipment) ? '已撤销自动完成' : '撤销自动完成' }}</button>
              <text v-if="shipment.pickupConflict" class="pickup-warning">取件码有冲突，请先确认归属</text>
            </template>
          </view>
          <view class="order-tools">
            <button role="button" :tabindex="(!!syncingOrderId) ? -1 : 0" v-if="selectedOrder.canRefresh" :disabled="!!syncingOrderId" :aria-disabled="!!syncingOrderId" @click="refreshOrderDate(selectedOrder)">{{ syncingOrderId === selectedOrder.id ? '更新中' : '更新订单' }}</button>
            <button role="button" tabindex="0" v-if="selectedOrder.source === 'online'" @click="goToApp(selectedOrder.platform)">打开购物 App</button>
            <button role="button" tabindex="0" v-if="selectedOrder.source === 'online' && selectedOrder.canEditDate" @click="openDateEditor(selectedOrder)">修改日期</button>
            <button role="button" tabindex="0" v-if="selectedOrder.source === 'online' && selectedOrder.dateOverride && selectedOrder.canEditDate" @click="restoreDate(selectedOrder)">恢复平台日期</button>
            <button role="button" tabindex="0" v-if="selectedOrder.source === 'manual'" @click="showEditPackage(selectedOrder)">修改记录</button>
            <button role="button" tabindex="0" v-if="!isExpiredOrder(selectedOrder) && selectedOrder.source === 'manual' && (!selectedOrder.waybillNo || selectedOrder.checked)" @click="toggleCheck(selectedOrder)">{{ selectedOrder.checked ? '取消旧手工签收' : '标记旧手工签收' }}</button>
            <button role="button" tabindex="0" class="danger" @click="deletePackage(selectedOrder)">{{ selectedOrder.hidden ? '恢复显示' : '隐藏订单' }}</button>
          </view>

          </view>
        </view>
        <view class="detail-footer">
          <button role="button" tabindex="0" class="detail-more-button" :aria-expanded="detailMore" @click="toggleDetailMore">••• 更多</button>
          <button role="button" tabindex="0" v-if="canPickShipment(selectedOrder, detailShipment)" class="primary-button" :disabled="shipmentBusy(detailShipment)" @click="detailShipment.needsReceiptConfirmation ? confirmReceipt(selectedOrder, detailShipment) : requestPickup(selectedOrder, detailShipment)">{{ claimingShipmentIds[detailShipment.id] ? '确认中' : detailShipment.needsReceiptConfirmation ? '确认收到' : '确认取件' }}</button>
          <button role="button" tabindex="0" v-else-if="!isExpiredOrder(selectedOrder) && detailShipment.needsPickupAssignment && detailShipment.pickupId && !selectedOrder.hidden && !detailShipment.hidden" class="primary-button" :disabled="!!syncingOrderId" @click="claimShipment(selectedOrder, detailShipment)">确认取件归属</button>
          <button role="button" tabindex="0" v-else-if="!isExpiredOrder(selectedOrder) && detailShipment.picked && detailShipment.canPick !== false && !selectedOrder.hidden && !detailShipment.hidden" class="secondary-button" :disabled="shipmentBusy(detailShipment)" @click="claimShipment(selectedOrder, detailShipment)">撤销已取</button>
          <button role="button" tabindex="0" v-else class="primary-button" @click="closePopup('detailPopup')">完成</button>
        </view>
      </view>
      <view v-else-if="selectedOrder && dateEditing" class="sheet date-sheet" role="dialog" aria-modal="true" aria-label="修改下单日期"><view class="sheet-handle"></view><view class="sheet-inner"><text class="dialog-title">修改下单日期</text><input v-model="dateDraft" type="text" maxlength="10" placeholder="YYYY-MM-DD" aria-label="下单日期 YYYY-MM-DD" /><view class="dialog-actions"><button role="button" tabindex="0" @click="dateEditing = false">取消</button><button role="button" :tabindex="(!!syncingOrderId) ? -1 : 0" class="primary-button" :disabled="!!syncingOrderId" :aria-disabled="!!syncingOrderId" @click="saveDate">保存</button></view></view></view>
    </uni-popup>
    <StationChooser ref="stationChooser" :rules="stationRules" :recent="stationChoices" @changed="applySnapshot" @open-change="stationChooserOpen = $event" />
  </view>
</template>

<script>
import { getSnapshot, getSyncStatus, mutate, openShoppingApp, refreshOrder, refreshOnline } from '@/services/assistant.js';
import LogisticsTimeline from '@/components/LogisticsTimeline.vue';
import ParcelJourney from '@/components/ParcelJourney.vue';
import OrderOverview from '@/components/OrderOverview.vue';
import { parcelJourney, packageCollectedDateKey, comparePackagesByCollectedAt, JOURNEY_COMPLETION_MS } from '@/services/parcel-journey.js';
import PickupStamp from '@/components/PickupStamp.vue';
import StationChooser from '@/components/StationChooser.vue';
import { packageDateKey, shouldArchivePackage, isPackageCollected, packagePlatform, shipmentProgress, packageProgressMatches, summarizePackages } from '@/core/package-presentation.js';
import { stationDisplayName, pickupCabinet } from '@/services/station-presentation.js';

export default {
  components: { ParcelJourney, OrderOverview, LogisticsTimeline, PickupStamp, StationChooser },
  data() { return {
    codes: [], detailShipmentId: '', detailMore: false, packages: [], families: [], stationRules: [], stationChoices: [], stationChooserOpen: false, tableData: [], archivedData: [], selectedFamily: 'all', selectedPlatform: 'all', selectedProgress: 'all',
    showHidden: false, showHistory: false, showExpired: false, hydrated: false, online: {}, refreshing: false, backgroundSyncing: false, error: '', notice: '', refreshProgressText: '',
    detailId: '', dateEditing: false, activePopup: '', filterDraft: { family: 'all', history: false, hidden: false }, dateDraft: '', dateTarget: null, syncingOrderId: '', claimingShipmentIds: {}, reducedMotion: false, journeyCompletions: {}, failedProductImages: {},
    mainPlatforms: [{ key: 'taobao', label: '淘宝', mark: '淘' }, { key: 'jd', label: '京东', mark: 'JD' }, { key: 'pdd', label: '拼多多', mark: '拼' }],
    progressOptions: [{ key: 'pickup', label: '待取' }, { key: 'transit', label: '运输中' }, { key: 'waiting', label: '待发货' }, { key: 'done', label: '已完成' }, { key: 'other', label: '其他' }, { key: 'all', label: '未收到' }]
  }; },
  computed: {
    archivedCount() { return this.archivedData.reduce((n, g) => n + g.list.length, 0); },
    allPackagesHidden() { return this.packages.length > 0 && this.packages.every(item => item && item.hidden); },
    hiddenRecoveryMode() { return this.allPackagesHidden && this.selectedProgress === 'all'; },
    scopedPackages() { return (this.showExpired ? this.archivedData : [...this.tableData, ...((this.showHistory || this.allPackagesHidden) ? this.archivedData : [])]).flatMap(g => g.list).filter(p => this.selectedFamily === 'all' || (p.familyId || '') === this.selectedFamily); },
    platformPackages() { return this.scopedPackages.filter(p => this.selectedPlatform === 'all' || packagePlatform(p) === this.selectedPlatform); },
    totals() { return summarizePackages(this.scopedPackages); },
    progressTotals() { return summarizePackages(this.platformPackages); },
    resultTotals() { return summarizePackages(this.platformPackages, this.selectedProgress); },
    journeyFilter() { return JSON.stringify([this.selectedFamily, this.selectedPlatform, this.selectedProgress, this.showHistory, this.showExpired, this.showHidden]); },
    filteredGroups() { return this.dateGroups(this.platformPackages.filter(p => this.showExpired || this.hiddenRecoveryMode || packageProgressMatches(p, this.selectedProgress) || this.journeyCompletion(p)), this.selectedProgress === 'done' && !this.showExpired, true); },
    journeysByOrder() { const result = Object.create(null); for (const order of this.packages) result[order.id] = (order.shipments?.length ? order.shipments.filter(s => !s.hidden) : [{}]).map(s => ({ id: s.id || order.id, journey: parcelJourney(s, order) })); return result; },
    detailShipment() { return this.selectedOrder?.shipments?.find(s => s.id === this.detailShipmentId) || this.summaryShipment(this.selectedOrder || {}) || {}; },
    detailPickup() { return this.codes.find(code => (code.members || []).some(member => member.shipmentId === this.detailShipment.id)) || null; },
    detailSources() { return this.detailPickup?.sources || []; },
    selectedOrder() { return [...this.tableData, ...this.archivedData].flatMap(g => g.list).find(p => p.id === this.detailId && (this.selectedFamily === 'all' || (p.familyId || '') === this.selectedFamily)) || null; },
    familyOptions() {
      const options = new Map([['all', { id: 'all', name: '全部角色' }]]);
      for (const family of this.families) if (family.id) options.set(family.id, { id: family.id, name: family.name || '家人' });
      for (const order of this.packages) if (!options.has(order.familyId || '')) options.set(order.familyId || '', { id: order.familyId || '', name: this.familyLabel(order) });
      return [...options.values()];
    },
    selectedFamilyName() { return this.familyOptions.find(f => f.id === this.selectedFamily)?.name || '家人'; },
    resultTitle() { if (this.showExpired) return '过期订单' + (this.selectedPlatform === 'all' ? '' : ' · ' + this.platformLabel({ source: this.selectedPlatform === 'manual' ? 'manual' : 'online', platform: this.selectedPlatform })); return (this.selectedPlatform === 'all' ? (this.showHistory ? '历史记录' : this.selectedProgress === 'all' ? '最近未收到' : '包裹记录') : this.platformLabel({ source: this.selectedPlatform === 'manual' ? 'manual' : 'online', platform: this.selectedPlatform })) + (this.selectedProgress === 'all' ? '' : ' · ' + this.progressOptions.find(p => p.key === this.selectedProgress).label); },
    resultSummary() { if (this.showExpired) return this.platformPackages.length + ' 笔过期订单'; const s = this.resultTotals; const count = this.selectedPlatform === 'manual' || this.selectedProgress === 'other' ? s.orders + ' 条记录' : s.total + ' 个包裹'; return (this.showHistory && this.selectedPlatform !== 'manual' ? s.onlineOrders + ' 笔订单 · ' : '') + count; },
    syncText() {
      if (this.refreshing || this.syncingOrderId || this.backgroundSyncing) return this.refreshProgressText || '正在更新，已有记录可继续查看';
      if (this.error) return this.error;
      if (this.notice) return this.notice;
      if (!this.online.bound) return '本地记录 · 可在「我的」绑定后台';
      return this.online.lastSuccessAt ? '上次更新 ' + new Date(this.online.lastSuccessAt).toLocaleString('zh-CN', { hour12: false }) : '已显示本地记录';
    }
  },
  watch: { journeyFilter() { this.clearJourneyCompletions(); } },
  onLoad() {
    uni.$on('assistant-changed', this.applySnapshot); uni.$on('assistant-sync-status', this.applySyncStatus);
    if (typeof window !== 'undefined' && window.matchMedia) {
      this._motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = this._motionQuery.matches;
      this._motionChanged = event => { this.reducedMotion = event.matches; };
      this._motionQuery.addEventListener?.('change', this._motionChanged);
    }
  },
  onShow() { this.revealSavedManualPackage(); this.revealSavedCompletion(); this.applySyncStatus(getSyncStatus()); this.loadData(); },
  mounted() { this.$el?.addEventListener?.('keydown', this.handleKeydown); },
  beforeUnmount() { this.clearJourneyCompletions(); this.$el?.removeEventListener?.('keydown', this.handleKeydown); },
  onHide() { this.clearJourneyCompletions(); this.$refs.stationChooser?.close(); if (this.activePopup) this.closePopup(this.activePopup); },
  onBackPress() { if (this.stationChooserOpen) { this.$refs.stationChooser.close(); return true; } if (!this.activePopup) return false; if (this.dateEditing) this.dateEditing = false; else this.closePopup(this.activePopup); return true; },
  onUnload() { this.clearJourneyCompletions(); uni.$off('assistant-changed', this.applySnapshot); uni.$off('assistant-sync-status', this.applySyncStatus); this._motionQuery?.removeEventListener?.('change', this._motionChanged); this._transition?.skipTransition(); },
  methods: {
    productImageFailed(event) { const url = event.currentTarget?.dataset?.imageUrl; if (url) this.failedProductImages[url] = true; },
    journeyCompletion(item) { const value = this.journeyCompletions[item.id]; return value?.filter === this.journeyFilter && value.until > Date.now() ? value : null; },
    journeyCard(item) { return this.journeyCompletion(item)?.card || item; },
    journeyCardShipment(item) { const id = this.summaryShipment(this.journeyCard(item))?.id; return (item.shipments || []).find(shipment => shipment.id === id) || {}; },
    clearJourneyCompletions() { clearTimeout(this._journeyCompletionTimer); this._journeyCompletionTimer = null; this.journeyCompletions = {}; },
    scheduleJourneyCompletions() {
      clearTimeout(this._journeyCompletionTimer); this._journeyCompletionTimer = null;
      const deadlines = Object.values(this.journeyCompletions).map(value => value.until);
      if (deadlines.length) this._journeyCompletionTimer = setTimeout(() => {
        this.journeyCompletions = Object.fromEntries(Object.entries(this.journeyCompletions).filter(([, value]) => value.until > Date.now()));
        this.scheduleJourneyCompletions();
      }, Math.max(0, Math.min(...deadlines) - Date.now()));
    },
    retainCompletedJourneys(snapshot) {
      const binding = online => JSON.stringify([!!online?.bound, online?.baseUrl || '', online?.deviceId || '']);
      if (binding(snapshot.online) !== binding(this.online) || this.showExpired) { this.clearJourneyCompletions(); return; }
      const now = Date.now(), next = new Map((snapshot.packages || []).map(item => [item.id, item])), retained = {};
      const eligible = item => item && !item.hidden && !this.isExpiredOrder(item);
      for (const [id, value] of Object.entries(this.journeyCompletions)) {
        const item = next.get(id);
        if (value.until > now && value.filter === this.journeyFilter && eligible(item) && item.accountId === value.accountId && value.shipmentIds.every(id => (item.shipments || []).some(shipment => shipment.id === id && !shipment.hidden && parcelJourney(shipment, item).completed))) retained[id] = value;
      }
      for (const group of this.filteredGroups) for (const previous of group.list) {
        const item = next.get(previous.id);
        if (!eligible(previous) || !eligible(item) || item.accountId !== previous.accountId) continue;
        const newIds = (item.shipments || []).filter(shipment => shipment.id && !shipment.hidden && parcelJourney(shipment, item).completed && (previous.shipments || []).some(old => old.id === shipment.id && !old.hidden && !parcelJourney(old, previous).completed)).map(shipment => shipment.id);
        if (newIds.length) retained[item.id] = { until: now + JOURNEY_COMPLETION_MS, filter: this.journeyFilter, date: group.date, accountId: item.accountId, card: retained[item.id]?.card || previous, shipmentIds: [...new Set([...(retained[item.id]?.shipmentIds || []), ...newIds])] };
      }
      this.journeyCompletions = retained; this.scheduleJourneyCompletions();
    },
    stationDisplayName, pickupCabinet,
    shortTitle(value) { const chars = Array.from(value); return chars.length > 15 ? chars.slice(0, 15).join('') + '…' : value; },
    toggleDetailMore() { this.detailMore = !this.detailMore; if (this.detailMore) this.$nextTick(() => { const el = this.$refs.detailMorePanel?.$el || this.$refs.detailMorePanel; el?.scrollIntoView?.({ block: 'nearest', behavior: this.reducedMotion ? 'instant' : 'smooth' }); }); },
    changeShipmentStation(shipment, event) { this.$refs.stationChooser.open({ shipmentId: shipment.id }, shipment, () => [...(this.$el?.querySelectorAll?.('[data-shipment-station]') || [])].find(element => element.getAttribute('data-shipment-station') === String(shipment.id)) || event?.currentTarget); },
    revealSavedManualPackage() {
      if (!uni.getStorageSync('pickcode.manual-package-saved')) return;
      uni.removeStorageSync('pickcode.manual-package-saved');
      this.selectedFamily = 'all'; this.selectedPlatform = 'manual'; this.selectedProgress = 'other';
      this.showHistory = true; this.showExpired = false;
    },
    revealSavedCompletion() {
      const raw = uni.getStorageSync('pickcode.pickup-completion');
      if (!raw) return;
      uni.removeStorageSync('pickcode.pickup-completion');
      try {
        const marker = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (!marker?.orderId) return;
        this.selectedFamily = 'all'; this.selectedPlatform = 'all'; this.selectedProgress = 'done'; this.showHistory = marker.showHistory !== false; this.showExpired = false;
        this._pendingCompletionNavigation = marker;
      } catch (_) { /* ignore an invalid navigation marker */ }
    },
    handleKeydown(event) {
      if (this.activePopup && event.key === 'Tab') {
        const root = this.$refs[this.activePopup]?.$el;
        const controls = [...(root?.querySelectorAll?.('[tabindex="0"],input') || [])].filter(el => !el.hasAttribute('disabled') && el.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (first && ((event.shiftKey && event.target === first) || (!event.shiftKey && event.target === last))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      }
      if (!['Enter', ' '].includes(event.key) || event.target?.tagName !== 'UNI-BUTTON') return;
      event.preventDefault(); event.target.click();
    },
    dateKey: packageDateKey,
    formatDate(date) { if (date === 'unknown') return this.selectedProgress === 'done' && !this.showExpired ? '取件时间待获取' : '下单日期待确认'; const parts = String(date).split('-').map(Number); return parts.length === 3 && parts.every(Number.isFinite) ? parts[0] + '年' + parts[1] + '月' + parts[2] + '日' : '下单日期待确认'; },
    money(amount) { return amount == null ? '—' : '¥' + Number(amount).toFixed(2); },
    familyLabel(item) { return item.familyId ? (item.familyName || '家人') : '待归属'; },
    familyStyle(id) {
      if (!id) return { '--family-color': '#66758a', '--family-soft': '#eef1f5', '--family-edge': '#d8dfe8' };
      let hash = 0; for (const char of String(id)) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
      const hue = ((hash * 137.508) % 360).toFixed(2);
      return { '--family-color': 'hsl(' + hue + ',48%,30%)', '--family-soft': 'hsl(' + hue + ',60%,95%)', '--family-edge': 'hsl(' + hue + ',45%,82%)' };
    },
    platformLabel(item) { if (item.source === 'manual') return '手动记录'; return ({ taobao: '淘宝', jd: '京东', pdd: '拼多多', douyin: '抖音', other: '其他平台' })[item.platform] || item.platform || '其他平台'; },
    recordSubtitle(item) { return item.source === 'manual' && item.amount == null ? '手动快递' : this.platformLabel(item) + ' · ' + this.money(item.amount); },
    platformStats(key) { return this.totals.platforms[key]; },
    progressCount(key) { return key === 'all' ? this.progressTotals.total : this.progressTotals[key]; },
    progressUnit(key) { return key === 'other' ? '条' : '个'; },
    recordCountLabel(item) {
      if (this.showExpired) return this.shipmentCount(item) ? this.shipmentCount(item) + ' 个包裹' : '查看详情';
      if (this.selectedProgress === 'other') return '查看详情';
      const current = summarizePackages([item], this.selectedProgress).total;
      const full = this.shipmentCount(item) || summarizePackages([item], 'all').total;
      if (!full && !current) return '查看详情';
      if (full === current) return full + ' 个包裹';
      return '全单 ' + full + ' 包 / 当前分类 ' + current + ' 包';
    },
    transitionName(id) { return 'parcel-' + Array.from(String(id), c => c.codePointAt(0).toString(16)).join('-'); },
    setQuickFilter(dimension, value) {
      const target = { ...(this._quickTarget || { platform: this.selectedPlatform, progress: this.selectedProgress }) };
      target[dimension] = target[dimension] === value ? 'all' : value;
      if (dimension === 'platform' && target.platform === 'manual' && target.progress === 'all') target.progress = 'other';
      this._quickTarget = target;
      this.animateList(() => { if (dimension === 'progress') this.showExpired = false; this.selectedPlatform = target.platform; this.selectedProgress = target.progress; this._quickTarget = null; });
    },
    clearQuickFilters() { this._quickTarget = null; this.animateList(() => { this.selectedPlatform = 'all'; this.selectedProgress = 'all'; this.showHistory = false; this.showExpired = false; }); },
    openHistory() { this._quickTarget = null; this.animateList(() => { this.selectedProgress = 'done'; this.showHistory = true; this.showExpired = false; }); },
    openExpired() { this._quickTarget = null; this.animateList(() => { this.selectedPlatform = 'all'; this.selectedProgress = 'all'; this.showHistory = false; this.showExpired = true; }); },
    isExpiredOrder: shouldArchivePackage,
    archiveReceiptText(item) { return (item.shipments || []).some(shipment => shipment.receiptState === 'expired_signed') ? '超期自动确认收到' : '已归档至过期订单'; },
    archiveSourceText(item) { const retention = item.retention; return (retention?.anchorSource === 'first_seen' ? '按首次记录时间' : '按下单日期') + (retention?.anchorDate ? ' ' + retention.anchorDate : '') + '计算，超过 30 天归档。物流未签收的包裹仅归档，未确认收到。'; },
    async restoreExpiredOrder(item) {
      if (this.syncingOrderId || !this.isExpiredOrder(item)) return;
      try { this.syncingOrderId = item.id; this.applySnapshot(await mutate('restoreExpiredOrder', { id: item.id })); this.showExpired = false; this.showHistory = false; this.selectedProgress = 'all'; this.selectedPlatform = 'all'; }
      catch (e) { uni.showToast({ title: e.message || '恢复失败', icon: 'none' }); }
      finally { this.syncingOrderId = ''; }
    },
    animateList(update) {
      this.clearJourneyCompletions();
      const revision = this._filterRevision = (this._filterRevision || 0) + 1;
      const apply = async () => { if (revision !== this._filterRevision) return; update(); await this.$nextTick?.(); };
      const list = this.$refs?.recordList?.$el || this.$refs?.recordList;
      if (!this.reducedMotion && typeof list?.startViewTransition === 'function') {
        this._transition?.skipTransition();
        this._transition = list.startViewTransition(apply); this._transition.ready.catch(() => {});
      } else { apply(); }
    },
    dateGroups(items, collected = false, retainJourneys = false) {
      const groups = new Map();
      const compare = collected ? comparePackagesByCollectedAt : (a, b) => Number(b.orderDate || 0) - Number(a.orderDate || 0);
      for (const item of items) { const date = retainJourneys && this.journeyCompletion(item)?.date || (collected ? packageCollectedDateKey(item) : this.dateKey(item)); if (!groups.has(date)) groups.set(date, []); groups.get(date).push(item); }
      return [...groups].sort(([a], [b]) => a === b ? 0 : a === 'unknown' ? 1 : b === 'unknown' ? -1 : b.localeCompare(a)).map(([date, list]) => ({
        date, list: [...list].sort((a, b) => compare(retainJourneys ? this.journeyCard(a) : a, retainJourneys ? this.journeyCard(b) : b))
      }));
    },
    regroup(now = new Date()) {
      const expanded = new Map([...this.tableData, ...this.archivedData].flatMap(g => g.list).map(p => [p.id, p.expanded]));
      const current = [], archived = [];
      const revealHidden = this.showHidden || this.allPackagesHidden;
      for (const p of this.packages) {
        if (p.hidden && !revealHidden) continue;
        (shouldArchivePackage(p, now) ? archived : current).push({ ...p, collected: isPackageCollected(p), expanded: expanded.get(p.id) || false });
      }
      this.tableData = this.dateGroups(current); this.archivedData = this.dateGroups(archived);
    },
    applySnapshot(snapshot) { this.retainCompletedJourneys(snapshot); this._snapshotRevision = (this._snapshotRevision || 0) + 1; this.packages = snapshot.packages || []; this.codes = snapshot.codes || []; this.families = snapshot.families || snapshot.online?.families || []; this.stationRules = snapshot.stationRules || []; this.stationChoices = snapshot.stationChoices || []; this.regroup(); this.online = snapshot.online || {}; this.error = this.online.error || ''; this.notice = this.online.notice || ''; this.hydrated = true; if (this.activePopup === 'detailPopup' && !this.selectedOrder) this.closePopup('detailPopup'); const marker = this._pendingCompletionNavigation; const target = marker && this.packages.find(order => order.id === marker.orderId); if (target) { this._pendingCompletionNavigation = null; this.detailId = target.id; this.$nextTick?.(() => { if (this.$refs?.detailPopup?.open) this.openDetails(target); }); } },
    applySyncStatus(status) { this.backgroundSyncing = status.syncing; },
    async loadData() {
      const revision = this._snapshotRevision || 0, request = this._loadRequest = (this._loadRequest || 0) + 1;
      const current = () => revision === (this._snapshotRevision || 0) && request === this._loadRequest;
      try { const snapshot = await getSnapshot(); if (current()) this.applySnapshot(snapshot); } catch (e) { if (current()) this.error = e.message; }
    },
    async retrySync() { if (this.refreshing || this.backgroundSyncing) return; this.refreshing = true; try { if (!this.hydrated) this.applySnapshot(await getSnapshot()); if (!this.online.bound) { await this.loadData(); return; } const result = await refreshOnline(progress => { this.refreshProgressText = progress.label; }); this.applySnapshot(result.snapshot); this.error = result.onlineError || ''; this.notice = [result.onlineNotice, result.pending ? result.pendingNotice || '后台仍在处理中，稍后刷新查看' : ''].filter(Boolean).join('；'); } catch (e) { this.error = e.message || '更新失败，已有记录已保留'; } finally { this.refreshing = false; this.refreshProgressText = ''; } },
    openFilters() { this.filterDraft = { family: this.selectedFamily, history: this.showHistory, hidden: this.showHidden }; this.openPopup('filterPopup'); },
    applyFilters() { this.animateList(() => { this.selectedFamily = this.filterDraft.family; this.showHistory = this.filterDraft.history; this.showExpired = false; this.showHidden = this.filterDraft.hidden; this.regroup(); }); this.closePopup('filterPopup'); },
    openDetails(item) { this.detailId = item.id; this.detailShipmentId = this.summaryShipment(item)?.id || ''; this.detailMore = false; this.dateEditing = false; this.openPopup('detailPopup'); },
    openPopup(name) { this._popupTrigger = typeof document !== 'undefined' ? document.activeElement : null; this.activePopup = name; this.$refs[name].open(); },
    closePopup(name) { this.$refs[name]?.close(); },
    popupChanged(name, event) {
      if (event.show) { this.activePopup = name; this.$nextTick(() => { const root = this.$refs[name]?.$el; root?.querySelector?.('[role="button"]')?.focus(); }); }
      else if (this.activePopup === name) { this.activePopup = ''; this._popupTrigger?.focus?.(); }
    },
    emptyNotice() { if (!this.packages.length) return '可手动添加，或在「我的」绑定后台。'; return '可清除平台或进度筛选，调整角色、时间范围，或显示已隐藏记录。'; },
    shipmentCount(item) { return (item.shipments || []).filter(s => s && !s.hidden).length; },
    summaryShipment(item) {
      const all = (item.shipments || []).filter(s => s && !s.hidden);
      const matching = all.filter(s => this.selectedProgress === 'all' ? ['pickup', 'transit', 'waiting'].includes(shipmentProgress(s, item)) : shipmentProgress(s, item) === this.selectedProgress);
      const shipments = matching.length ? matching : all;
      return shipments.find(s => !s.picked && this.displayPickupCode(s)) || shipments.find(s => !s.picked && s.needsReceiptConfirmation) || shipments.find(s => !s.picked) || shipments[0] || null;
    },
    summaryLogistics(item) { if (item.source === 'manual') return item.waybillNo ? '单号 ' + item.waybillNo : ''; const s = this.summaryShipment(item); if (!s) return ''; const event = (s.logisticsEvents || [])[0]; if (event?.message || event?.description) return event.message || event.description; if (item.status === 'transit' || ['transit', 'arrived', 'signed'].includes(s.status)) return [s.carrier, this.shipmentText(s)].filter(Boolean).join(' · '); return s.waybillNo ? '运单 ' + s.waybillNo : '物流待补全'; },
    cardProgress(item) { if (item.collected) return 'done'; return this.summaryShipment(item) ? shipmentProgress(this.summaryShipment(item), item) : ['pickup', 'transit', 'waiting', 'done'].find(key => packageProgressMatches(item, key)) || 'other'; },
    cardStatus(item) {
      if (this.isExpiredOrder(item)) return this.archiveReceiptText(item);
      if (item.hidden) return '已隐藏';
      if (this.selectedProgress === 'done' && !item.collected && this.shipmentCount(item)) return '部分已完成';
      if (this.selectedProgress === 'transit') return '运输中';
      if (this.selectedProgress === 'pickup' || this.selectedProgress === 'all') {
        const s = this.summaryShipment(item);
        if (s?.status === 'returned') return '已退货 / 退回';
        if (s?.status === 'returning') return '退货 / 退回中';
        if (s?.needsReceiptConfirmation) return '已送达·待确认';
        if (s?.needsPickupAssignment || s?.pickupConflict) return '待确认归属';
        if (s && shipmentProgress(s, item) === 'transit') return '运输中';
        if (s && this.displayPickupCode(s)) return '待取件';
        if (s?.status === 'signed') return '物流已签收 · 未标记领取';
        if (s?.status === 'arrived' || s?.status === 'awaiting_code') return '已到站 · 暂无取件码';
      }
      return this.statusText(item);
    },
    statusText(item) { if (this.isExpiredOrder(item)) return this.archiveReceiptText(item); if (item.hidden) return '已隐藏'; if (item.source === 'manual') return item.checked ? '旧手工签收' : item.waybillNo ? '仅记录 · 未查询物流' : '手动记录'; const summary = this.summaryShipment(item); if (summary?.status === 'returned') return '已退货 / 退回'; if (summary?.status === 'returning') return '退货 / 退回中'; if (summary?.needsReceiptConfirmation && !summary.picked) return '已送达·待确认'; if (item.collected || item.status === 'picked') return summary && this.isReceiptShipment(summary) ? '已收货' : '已取件'; if (item.status === 'pending') return '待取件'; if (item.status === 'awaiting_code') return '已到站 · 暂无取件码'; if (item.status === 'transit') return '运输中'; if (item.status === 'signed') return '物流已签收 · 未标记领取'; if (packageProgressMatches(item, 'waiting')) return '待发货'; if (!(item.shipments || []).length) return this.isTerminalStatus(item) ? item.orderStatus || item.tradeStatus || '交易已结束' : '暂无物流'; return '物流待更新'; },
    completionState(shipment) {
      const value = shipment?.pickupCompletion;
      if (!value || value.version !== 1) return null;
      return { version: 1, autoPicked: value.autoPicked === true, manualOverride: ['picked', 'pending'].includes(value.manualOverride) ? value.manualOverride : '', completedAt: Number(value.completedAt) || 0, evidence: value.evidence && typeof value.evidence === 'object' ? value.evidence : null };
    },
    hasPickupCompletion(shipment) { if (shipment?.receiptState === 'expired_signed') return true; const state = this.completionState(shipment); return !!state && (state.autoPicked || state.manualOverride === 'pending'); },
    isAutoCompleted(shipment) { const state = this.completionState(shipment); return !!state?.autoPicked && !state.manualOverride; },
    isCompletionRevoked(shipment) { return this.completionState(shipment)?.manualOverride === 'pending'; },
    completionSummary(item) {
      if ((item?.shipments || []).some(shipment => shipment.receiptState === 'expired_signed')) return '超期自动确认收到';
      const shipments = (item?.shipments || []).filter(shipment => shipment && !shipment.hidden && !shipment.deleted);
      const autoCount = shipments.filter(shipment => this.isAutoCompleted(shipment)).length;
      if (!autoCount) return '';
      return autoCount === shipments.length ? '自动完成' : '部分自动完成';
    },
    completionStatusText(shipment) { if (shipment?.receiptState === 'expired_signed') return '超期自动确认收到'; const state = this.completionState(shipment); if (state?.manualOverride === 'pending') return state.autoPicked ? '已撤销自动完成' : '已设为未取，自动判断暂停'; return this.isAutoCompleted(shipment) ? '自动完成' : ''; },
    completionTimeText(shipment) {
      const time = this.completionState(shipment)?.completedAt;
      if (!time) return '';
      const date = new Date(time);
      return Number.isNaN(date.getTime()) ? '' : '完成于 ' + date.toLocaleString('zh-CN', { hour12: false });
    },
    completionEvidenceText(shipment) {
      if (shipment?.receiptState === 'expired_signed') return '物流已签收，订单超过 30 天';
      const evidence = this.completionState(shipment)?.evidence;
      if (!evidence) return '';
      return evidence.description || evidence.kind || '';
    },
    completionSupported() { return !!this.online?.capabilities?.includes('pickup_completion_v1'); },
    canUndoAutoCompletion(item, shipment) { return !this.isExpiredOrder(item) && this.completionSupported() && item?.source === 'online' && shipment?.id && shipment.canPick !== false; },
    canResumeAutoCompletion(item, shipment) { return !this.isExpiredOrder(item) && this.completionSupported() && item?.source === 'online' && shipment?.id && shipment.canPick !== false && this.isCompletionRevoked(shipment); },
    async resumeAutoCompletion(item, shipment) {
      if (!this.canResumeAutoCompletion(item, shipment) || this.syncingOrderId) return;
      try { this.syncingOrderId = item.id; this.applySnapshot(await mutate('resumeAutoPickup', { orderId: item.id, shipmentIds: [shipment.id] })); }
      catch (e) { uni.showToast({ title: e.message || '恢复失败', icon: 'none' }); }
      finally { this.syncingOrderId = ''; }
    },
    isReceiptShipment(s) { return Boolean(s.needsReceiptConfirmation || s.isHomeDelivery); },
    shipmentText(s) { if (s.receiptState === 'expired_signed') return '超期自动确认收到'; if (this.isReceiptShipment(s)) return s.picked ? '已收货' : '已送达·待确认'; return ({ transit: '运输中', arrived: '已到站', signed: '物流已签收', unknown: '待更新' })[s.status] || s.status || '待更新'; },
    orderDateText(item) { if (this.dateKey(item) !== 'unknown') { if (item.source === 'manual' || item.dateOverride) return (item.source === 'manual' ? '记录日期：' : '人工修正日期：') + String(item.dateOverride || new Date(item.orderDate).toLocaleDateString('sv-SE')); const origin = item.orderDateOrigin === 'detail' ? ' · 平台订单详情' : item.orderDateOrigin === 'list' ? ' · 平台订单列表' : ''; return '下单时间：' + new Date(item.orderDate).toLocaleString('zh-CN', { hour12: false }) + origin; } const checked = new Date(item.dateCheckedAt); return item.dateCheckedAt && !Number.isNaN(checked.getTime()) ? '下单日期待确认 · 最近补查 ' + checked.toLocaleString('zh-CN', { hour12: false }) + '，仍未获得有效日期' : '下单日期待确认 · 等待平台补全'; },
    displayPickupCode(shipment) { return shipment.displayPickupCode || ''; },
    copyValue(value, label) { if (value) uni.setClipboardData({ data: String(value), success: () => uni.showToast({ title: '已复制' + label, icon: 'none' }) }); },
    canPickShipment(item, shipment) { return !this.isExpiredOrder(item) && !shipment.archived && item.source === 'online' && !item.hidden && shipment.canPick !== false && !shipment.hidden && !shipment.picked && !!shipment.id && !shipment.needsPickupAssignment; },
    shipmentBusy(shipment) { return !!this.syncingOrderId || !!this.claimingShipmentIds[shipment.id]; },
    requestPickup(item, shipment) { if (this.shipmentBusy(shipment) || !this.canPickShipment(item, shipment)) return; uni.showModal({ title: '确认已取到包裹？', content: item.title + (this.displayPickupCode(shipment) ? ' · ' + this.displayPickupCode(shipment) : ''), success: r => { if (r.confirm) { const latest = this.packages.find(p => p.id === item.id); const s = latest?.shipments?.find(s => s.id === shipment.id); if (latest && s && this.canPickShipment(latest, s)) this.claimShipment(latest, s); } } }); },
    async confirmReceipt(item, shipment) { const current = this.packages.find(p => p.id === item.id); const s = current?.shipments?.find(s => s.id === shipment.id); if (!s?.needsReceiptConfirmation || this.shipmentBusy(s) || !this.canPickShipment(current, s)) return; await this.claimShipment(current, s); },
    async claimShipment(item, shipment) { if (this.isExpiredOrder(item) || shipment.archived || this.shipmentBusy(shipment) || shipment.canPick === false || shipment.hidden || item.hidden) return; if (shipment.needsPickupAssignment) { if (shipment.pickupId) { if (this.activePopup) this.closePopup(this.activePopup); uni.setStorageSync('pendingPickupId', shipment.pickupId); uni.switchTab({ url: '/pages/index/index' }); } return; } if (item.source !== 'online' || !shipment.id) return; try { this.claimingShipmentIds[shipment.id] = true; this.applySnapshot(await mutate('pickShipments', { orderId: item.id, shipmentIds: [shipment.id], picked: !shipment.picked })); } catch (e) { uni.showToast({ title: e.message || '操作失败', icon: 'none' }); } finally { delete this.claimingShipmentIds[shipment.id]; } },
    openDateEditor(item) { this.dateTarget = item; this.dateDraft = item.dateOverride || ''; this.dateEditing = true; this.$nextTick(() => this.$refs.detailPopup?.$el?.querySelector?.('input')?.focus()); },
    async saveDate() { if (!this.dateTarget || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(this.dateDraft)) { uni.showToast({ title: '请输入YYYY-MM-DD', icon: 'none' }); return; } if (this.syncingOrderId) return; try { this.syncingOrderId = this.dateTarget.id; this.applySnapshot(await mutate('setOrderDate', { id: this.dateTarget.id, date: this.dateDraft })); this.dateEditing = false; } catch (e) { uni.showToast({ title: e.message || '保存失败', icon: 'none' }); } finally { this.syncingOrderId = ''; } },
    async restoreDate(item) { await this.action('setOrderDate', { id: item.id, date: null }); },
    async refreshOrderDate(item) { if (this.syncingOrderId) return; try { this.syncingOrderId = item.id; const result = await refreshOrder(item.id, progress => { this.refreshProgressText = progress.label; }); this.applySnapshot(result.snapshot || result); this.error = [result.smsError, result.onlineError].filter(Boolean).map(e => e.message || e).join('；'); this.notice = result.pending ? result.pendingNotice || '后台仍在处理中，稍后刷新查看' : result.onlineNotice || '订单已更新'; } catch (e) { this.error = e.message || '更新失败'; } finally { this.syncingOrderId = ''; this.refreshProgressText = ''; } },
    showAddPackage() { uni.navigateTo({ url: '/pages/packages/edit' }); },
    showEditPackage(item) { if (item.source === 'online') return; if (this.activePopup) this.closePopup(this.activePopup); uni.setStorageSync('editData', JSON.stringify({ item: { ...item, name: item.title, price: item.amount ?? '', date: new Date(item.orderDate).toLocaleDateString('sv-SE') } })); uni.navigateTo({ url: '/pages/packages/edit?type=edit' }); },
    getWaybillCount(list) { return list.filter(item => item.source !== 'manual').reduce((total, item) => total + (item.shipments || []).filter(s => s && !s.hidden && String(s.waybillNo || '').trim()).length, 0); },
    getCheckedCount(list) { return summarizePackages(list, 'done').total; },
    hasDetails(item) { return item.source === 'online' || !!(item.shipments?.length || item.orderStatus || item.tradeStatus || item.refundStatus); },
    isTerminalStatus(item) { const value = [item.tradeStatus, item.orderStatus].filter(Boolean).join(' '); return /TRADE_(?:CLOSED|FINISHED|SUCCESS)|(?:closed|close|failed|failure|completed|complete|finished|success)|交易(?:关闭|完成|成功)|已(?:关闭|完成|成功)|失败/i.test(value) && !/(?:待|未)完成/.test(value); },
    async action(action, payload) { try { this.applySnapshot(await mutate(action, payload)); } catch (e) { uni.showToast({ title: e.message || '操作失败', icon: 'none' }); } },
    toggleCheck(item) { if (this.isExpiredOrder(item)) return; this.action('savePackage', { order: { id: item.id, platform: item.platform, title: item.title, amount: item.amount, orderDate: item.orderDate, checked: !item.checked } }); },
    deletePackage(item) { if (item.hidden) { this.action('restorePackage', { id: item.id }); return; } uni.showModal({ title: '隐藏此订单？', content: '此订单及关联取件将隐藏，可打开“显示已隐藏记录”恢复。', success: r => { if (r.confirm) { this.closePopup('detailPopup'); this.action('removePackage', { id: item.id }); } } }); },
    confirmDeleteDateGroup(group) { const items = group.list.filter(p => !p.hidden); if (!items.length) return; uni.showModal({ title: '隐藏当前日期的筛选结果？', content: '仅隐藏当前显示的 ' + items.length + ' 笔订单，可在已隐藏记录中恢复。', success: async r => { if (r.confirm) for (const item of items) await this.action('removePackage', { id: item.id }); } }); },
    async goToApp(platform) { try { await openShoppingApp(platform); } catch (e) { uni.showToast({ title: e.message, icon: 'none' }); } }
  }
};
</script>

<style lang="scss" scoped>
.records-page{min-height:100vh;color:var(--sf-text);font-synthesis:none;-webkit-font-smoothing:antialiased;overflow-anchor:none;}
.records-container{box-sizing:border-box;max-width:680px;margin:0 auto;padding:calc(20px + env(safe-area-inset-top)) 16px calc(92px + env(safe-area-inset-bottom));}
button{box-sizing:border-box;margin:0;padding:0;border:0;background:none;color:inherit;font:inherit;line-height:1.5;border-radius:0;cursor:pointer;touch-action:manipulation;}
button::after{border:0;}button[disabled]{opacity:.48;cursor:default;}button:active:not([disabled]){transform:scale(.985);}button:focus-visible,input:focus-visible{outline:3px solid var(--sf-blue);outline-offset:3px;}
.topline,.scope-row,.dashboard-total,.count,.records-heading,.day-head,.order-top,.order-identity,.order-main,.order-status,.pickup-row,.receipt-row,.sheet-header,.detail-sub,.shipment-head,.shipment-code-head,.order-number,.switch-row,.dialog-actions{display:flex;align-items:center;justify-content:space-between;gap:10px;}
.topline{margin-bottom:16px;}.page-title{display:block;font-size:30px;line-height:36px;font-weight:750;letter-spacing:-.8px;}
.round-btn{display:flex;align-items:center;justify-content:center;flex:none;width:44px;height:44px;border-radius:50%;}
.round-btn,.scope-row,.dashboard,.order-card,.empty-state,.sheet{background:var(--sf-glass);border:1px solid var(--sf-edge);box-shadow:var(--sf-shadow);backdrop-filter:blur(var(--sf-blur)) saturate(104%);-webkit-backdrop-filter:blur(var(--sf-blur)) saturate(104%);}
.scope-row{margin-bottom:14px;border-radius:18px;padding:4px 12px;gap:6px;}.scope-button{display:flex;align-items:center;gap:7px;min-height:44px;text-align:left;font-size:14px;font-weight:600;max-width:63%;}.scope-button>text:not(.role-dot){overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}.role-dot,.sync-dot{flex:none;width:6px;height:6px;background:var(--sf-blue);border-radius:50%;}.period{font-size:12px;color:var(--sf-muted);text-align:right;line-height:1.5;}
.dashboard{padding:15px;border-radius:24px;}.dashboard-total{padding:0 2px 14px;}.total-caption{font-size:15px;font-weight:600;}.count{justify-content:flex-start;align-items:baseline;gap:6px;border-radius:12px;background:#0867ff0d;padding:5px 10px;}.total-number{font-size:25px;font-weight:700;line-height:1.2;color:var(--sf-blue);font-variant-numeric:tabular-nums;}.count-unit{font-size:12px;color:var(--sf-muted);}
.platform-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:3px;padding:4px;border-radius:15px;background:#cad5e72b;border:1px solid #ffffffa6;}.platform-card{display:flex;align-items:center;justify-content:center;gap:4px;min-width:0;min-height:44px;border-radius:11px;font-size:13px;white-space:nowrap;color:var(--sf-muted);}.platform-card.selected{background:#ffffff94;color:var(--sf-blue);box-shadow:0 3px 8px #3d4e6910,inset 0 1px 0 #fff;}.platform-amount{font-weight:650;font-variant-numeric:tabular-nums;}.platform-toolbar{display:flex;gap:14px;margin:3px 2px 0;}.platform-toolbar button{min-height:44px;color:var(--sf-muted);font-size:12px;padding:0 4px;}.platform-toolbar .selected{color:var(--sf-blue);font-weight:650;}
.status-filter{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;border-top:1px solid #a9b7ca38;padding-top:9px;}.status-filter button{display:flex;align-items:center;justify-content:center;gap:5px;padding:8px 2px;border-radius:12px;color:var(--sf-muted);min-height:44px;min-width:0;}.status-filter .selected{background:#0867ff0e;color:var(--sf-blue);}.status-name{font-size:13px;white-space:nowrap;}.status-number{font-size:14px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;}.status-number text{font-size:10px;font-weight:400;margin-left:2px;}
.sync-line{display:flex;align-items:center;gap:7px;min-height:48px;padding:2px 3px;font-size:12px;color:var(--sf-muted);}.sync-copy{flex:1;min-width:0;overflow-wrap:anywhere;}.sync-line button{flex:none;color:var(--sf-blue);font-size:13px;min-height:44px;min-width:44px;}.sync-line.offline{color:#835315;}.sync-dot.syncing{background:var(--sf-blue);}.records-heading{align-items:flex-start;margin:8px 2px 12px;}.section-title{display:block;font-size:16px;font-weight:650;line-height:1.5;}.result-count{display:block;font-size:12px;color:var(--sf-muted);margin-top:4px;}.record-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;column-gap:12px;max-width:56%;}.record-actions button{font-size:12px;min-height:44px;color:var(--sf-blue);white-space:nowrap;}
.record-list{view-transition-scope:all;position:relative;outline:none;}.day-section{position:relative;margin-bottom:20px;}.day-head{min-height:44px;margin:0 2px 5px;font-size:14px;font-weight:650;}.day-head button{min-height:44px;padding:0 4px;font-size:12px;color:var(--sf-muted);font-weight:400;}
.order-card{position:relative;border-radius:23px;margin-bottom:12px;overflow:hidden;}.order-open{width:100%;text-align:left;padding:14px;}.order-top{align-items:flex-start;margin-bottom:14px;}.order-identity{justify-content:flex-start;gap:8px;min-width:0;flex:1;}.order-platform{font-size:13px;color:var(--sf-muted);flex:none;}.family-ticket{min-width:0;max-width:110px;padding:3px 8px;border:1px solid var(--family-edge);border-radius:8px;background:var(--family-soft);color:var(--family-color);font-size:12px;font-weight:600;line-height:18px;overflow:hidden;}.family-ticket-name{display:block;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}
.order-main{gap:12px;}.goods-glyph{display:flex;align-items:center;justify-content:center;width:46px;height:48px;border-radius:14px;background:#d9e2ee80;flex:none;overflow:hidden;}.goods-image{display:block;width:46px;height:48px;object-fit:cover;}.goods-icon{width:25px;height:25px;filter:grayscale(1);opacity:.75;}.goods-info{flex:1;min-width:0;}.goods-name{display:block;width:100%;max-width:10em;font-size:15px;line-height:22px;min-height:22px;font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}.order-sub{display:block;min-height:19px;font-size:12px;line-height:19px;color:var(--sf-muted);margin-top:4px;}
.order-status{margin-top:12px;min-height:19px;justify-content:flex-end;flex-wrap:wrap;}.status-label{display:flex;align-items:center;gap:5px;font-size:12px;line-height:18px;color:var(--sf-muted);background:#c7d1df38;padding:3px 7px;border-radius:8px;flex:none;max-width:52%;overflow-wrap:anywhere;}.status-label.pickup{color:#145bb5;background:#0867ff12;}.status-label.done{color:var(--sf-teal);background:#08737012;}.status-dot{width:4px;height:4px;border-radius:50%;background:currentColor;flex:none;}.completion-chip{margin-right:auto;padding:2px 6px;border-radius:6px;background:#08737012;color:var(--sf-teal);font-size:11px;line-height:1.5;}.order-count{font-size:12px;color:var(--sf-muted);}.order-summary{display:block;font-size:13px;color:var(--sf-muted);line-height:20px;margin-top:7px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;}.hidden-order{opacity:.67;}
.pickup-row,.receipt-row{padding:9px 14px 12px;background:#ffffff24;border-top:1px solid #a9b7ca30;}.pickup-copy{min-width:0;flex:1;}.pickup-line{display:flex;align-items:center;gap:7px;flex-wrap:wrap;}.pickup-code{font-size:25px;letter-spacing:.01em;color:var(--sf-text);font-weight:750;text-align:left;min-height:44px;overflow-wrap:anywhere;max-width:100%;font-variant-numeric:tabular-nums;}.pickup-code.long-code{font-size:20px;}.cabinet-badge{font-size:13px;line-height:1.5;color:var(--sf-teal);background:#dcf2ef;border-radius:8px;padding:5px 7px;font-weight:650;overflow-wrap:anywhere;}.station{display:block;font-size:12px;color:var(--sf-muted);line-height:18px;margin-top:2px;overflow-wrap:anywhere;}.small-primary{font-size:16px;font-weight:650;min-height:46px;min-width:72px;padding:0 13px;border-radius:14px;background:var(--sf-blue);color:white;flex:none;box-shadow:0 6px 13px #0867ff18;}.small-primary[disabled],.primary-button[disabled]{box-shadow:none;}.receipt-row>text{font-size:13px;color:var(--sf-muted);line-height:1.6;}.receipt-confirm{font-size:14px;}
.empty-state{text-align:center;padding:36px 18px;border-radius:24px;}.empty-icon{width:42px;height:42px;opacity:.65;}.empty-title{display:block;font-size:18px;font-weight:650;margin:18px 0 10px;}.empty-copy{display:block;font-size:14px;color:var(--sf-muted);line-height:1.8;}.empty-state button{color:var(--sf-blue);min-height:44px;margin-top:15px;font-size:15px;}.skeleton{height:170px;border-radius:24px;background:linear-gradient(105deg,#dce4ed70,#ffffff8c 45%,#dce4ed70);border:1px solid var(--sf-edge);}.hero-skeleton{height:240px;margin-bottom:20px;}
.sheet{background:var(--sf-sheet);box-sizing:border-box;width:min(100vw,520px);max-height:90vh;max-height:90dvh;overflow-y:auto;overscroll-behavior:contain;border-radius:28px 28px 0 0;color:var(--sf-text);margin:auto;}.sheet-handle{width:34px;height:4px;background:#aab6c6;border-radius:6px;margin:11px auto 12px;}.sheet-inner{padding:0 18px max(26px,env(safe-area-inset-bottom));}.sheet-header{margin-bottom:20px;font-size:21px;font-weight:700;letter-spacing:-.5px;}.sheet-header .round-btn{box-shadow:none;background:#ffffff65;}.field-label{display:block;font-size:14px;font-weight:600;margin-bottom:10px;}.choice-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:22px;}.choice-grid button{min-height:48px;padding:9px;background:#ffffff50;border:1px solid #ffffffbb;border-radius:14px;font-size:14px;color:var(--sf-muted);overflow-wrap:anywhere;}.choice-grid .selected{border-color:#0867ff70;background:#0867ff0e;color:var(--sf-blue);font-weight:600;}.period-grid{grid-template-columns:1fr 1fr;}.switch-row{padding:14px 0;border-top:1px solid #a9b7ca38;font-size:15px;}.toggle-switch{min-width:48px;min-height:44px;display:flex;align-items:center;justify-content:center;}.switch-track{width:44px;height:26px;border-radius:20px;background:#acb8ca;padding:3px;box-sizing:border-box;}.switch-thumb{width:20px;height:20px;border-radius:50%;background:white;box-shadow:0 1px 3px #0002;}.switch-track.checked{background:var(--sf-blue);}.switch-track.checked .switch-thumb{transform:translateX(18px);}
.primary-button,.secondary-button{min-height:48px;width:100%;border-radius:14px;background:var(--sf-blue);color:white;font-size:15px;font-weight:600;margin-top:16px;padding:11px;}.secondary-button{border:1px solid #0867ff40;background:#ffffff55;color:var(--sf-blue);}.detail-product{position:relative;margin-bottom:16px;}.detail-title{display:block;font-size:18px;line-height:1.6;font-weight:650;}.detail-sub{font-size:13px;color:var(--sf-muted);margin-top:8px;}.detail-family{color:var(--family-color);background:var(--family-soft);padding:4px 9px;border-radius:8px;max-width:45%;overflow-wrap:anywhere;}.detail-stamp{margin:10px 0 12px;}.detail-status{display:block;font-size:14px;color:var(--sf-blue);margin-bottom:10px;}.date-row,.order-number,.order-metadata{font-size:13px;color:var(--sf-muted);line-height:1.75;overflow-wrap:anywhere;}.order-metadata text{display:block;}.order-number>text{min-width:0;}.text-button{color:var(--sf-blue);min-height:44px;min-width:44px;flex:none;}.archive-meta{padding:15px;background:#d5dfe857;border:1px solid #ffffffa6;border-radius:17px;margin:12px 0;}.archive-meta .field-label{margin-bottom:6px;}.archive-meta .secondary-button{margin-top:10px;}
.shipment-panel{border:1px solid var(--sf-edge);background:var(--sf-glass);border-radius:21px;padding:15px;margin:16px 0 13px;box-shadow:inset 0 1px 0 #ffffffd9;}.shipment-head{font-size:15px;font-weight:600;align-items:flex-start;}.shipment-head>text+text{font-size:12px;color:var(--sf-muted);text-align:right;line-height:1.6;font-weight:400;}.tracking-number{font-size:13px;color:var(--sf-blue);min-height:44px;overflow-wrap:anywhere;text-align:left;}.shipment-code{background:#ffffff45;border:1px solid #ffffffb3;border-radius:16px;padding:12px;margin:8px 0;}.shipment-code-head .field-label{margin:0;color:var(--sf-muted);font-size:12px;font-weight:500;}.copyable{font-size:28px;color:var(--sf-text);font-weight:750;line-height:1.35;min-height:48px;text-align:left;overflow-wrap:anywhere;width:100%;font-variant-numeric:tabular-nums;}.shipment-station,.arrival-time,.muted-inline{display:block;font-size:13px;color:var(--sf-muted);line-height:1.75;overflow-wrap:anywhere;}.shipment-station-tools{font-size:13px;}.completion-meta{margin-top:10px;padding:11px;border:1px solid #b7d9ce;border-radius:12px;background:#dff2eb6b;}.completion-meta.revoked{border-color:#dac9ad;background:#fff3da70;}.completion-meta-heading{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:4px 8px;}.completion-label{color:var(--sf-teal);font-size:13px;font-weight:600;}.completion-meta.revoked .completion-label{color:#80591f;}.completion-time,.completion-evidence{display:block;color:var(--sf-muted);font-size:12px;line-height:1.7;overflow-wrap:anywhere;}.completion-evidence{margin-top:4px;}.completion-action{margin-top:8px;}.pickup-warning{display:block;color:#875815;font-size:14px;line-height:1.6;margin-top:12px;}.order-tools{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:20px;}.order-tools button{font-size:14px;color:var(--sf-muted);min-height:48px;background:#ffffff4a;border:1px solid #ffffffa6;border-radius:13px;padding:9px;}.order-tools .danger{color:#a53532;}.dialog-title{display:block;font-size:21px;font-weight:700;margin-bottom:20px;}.date-sheet input{box-sizing:border-box;border:1px solid #8c9caf;border-radius:14px;padding:0 13px;height:48px;font-size:16px;background:#ffffff68;color:var(--sf-text);}.dialog-actions{margin-top:20px;}.dialog-actions button{flex:1;margin:0;min-height:48px;font-size:15px;}
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.round-btn,.scope-row,.dashboard,.order-card,.empty-state,.sheet,.shipment-panel{background:#f5f8fc;}.platform-grid,.shipment-code{background:#e9eff7;}}
@media(prefers-reduced-motion:no-preference){.order-card{animation:record-in .2s ease-out;}.platform-card{transition:background .18s,box-shadow .18s;}.skeleton{background-size:220% 100%;animation:shimmer 1.8s linear infinite;}.sync-dot.syncing{animation:sync-pulse 1.5s ease-in-out infinite;}}
@keyframes record-in{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}@keyframes shimmer{to{background-position:-220% 0;}}@keyframes sync-pulse{50%{opacity:.35;}}
@media(max-width:370px){.page-title{font-size:28px;line-height:34px;}.dashboard{padding:12px;}.platform-card{font-size:12px;gap:3px;}.order-open{padding:12px;}.order-top{gap:6px;}.order-identity{gap:6px;}.family-ticket{max-width:83px;}.status-label{font-size:11px;}.sheet-inner{padding-left:16px;padding-right:16px;}.pickup-code{font-size:23px;}.pickup-code.long-code{font-size:18px;}.goods-name{font-size:14px;}.status-filter button{gap:4px;}.status-name{font-size:12px;}}
@media(min-width:420px){.records-container{padding-left:20px;padding-right:20px;}}
@media(forced-colors:active){.round-btn,.scope-row,.dashboard,.order-card,.empty-state,.sheet,.shipment-panel,.choice-grid button,.platform-card.selected,.status-filter .selected{border:1px solid CanvasText;}.primary-button,.small-primary{border:1px solid ButtonText;}.status-label{border:1px solid CanvasText;}}
.date-basis{margin-left:auto;font-size:12px;font-weight:400;color:var(--sf-muted);}.day-head:has(.date-basis) button{font-size:11px;}.completed .order-identity{flex-direction:row-reverse;justify-content:flex-end;}.completed .order-top{margin-bottom:10px;}.completed .goods-name{max-width:none;}.completed .order-open{padding-bottom:16px;}.completed .status-label .status-dot{width:auto;height:auto;background:none;}.completed .status-dot::after{content:'✓';}.order-journeys{margin:0 13px 12px;padding-top:10px;border-top:1px solid #c5d5e7;min-width:0;}.order-journey+.order-journey{margin-top:15px;padding-top:12px;border-top:1px solid #c5d5e7;}.journey-parcel-label{display:block;color:var(--sf-muted);font-size:12px;margin-bottom:8px;}
.detail-sheet{display:flex;flex-direction:column;overflow:hidden;max-height:94vh;max-height:94dvh;}.detail-sheet>.sheet-handle{flex:none;margin-bottom:8px;}.detail-header{flex:none;margin:0 18px 18px;font-size:23px;}.detail-body{min-height:0;overflow-y:auto;padding-bottom:10px;overscroll-behavior:contain;}.detail-footer{flex:none;display:flex;gap:9px;padding:12px 16px max(16px,env(safe-area-inset-bottom));border-top:1px solid #fff;background:var(--sf-sheet);}.detail-footer .primary-button,.detail-footer .secondary-button{flex:1;min-width:0;margin:0;font-size:17px;min-height:46px;}.detail-more-button{flex:none;min-width:85px;min-height:46px;border:1px solid #c8d9eb;border-radius:14px;background:#f7fbffb3;color:#506b84;font-size:15px;font-weight:600;}.detail-more .order-tools{margin:15px 0 6px;}.shipment-picker{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:15px;}.shipment-picker button{padding:6px 10px;border:1px solid #cbd8e6;border-radius:10px;color:var(--sf-muted);font-size:12px;min-height:36px;}.shipment-picker button[aria-pressed=true]{color:var(--sf-blue);background:#e5eefb;}.history-main .goods-info{width:100%;}
.detail-sheet{background:linear-gradient(145deg,#f1f6fb,#e7eef7);}.detail-footer{background:#eaf1f8;}.completed .order-journeys{border-top:0;padding-top:0;}
.detail-header{margin-bottom:8px;}
.detail-footer>button,.detail-more .order-tools>button,.detail-more .secondary-button,.shipment-picker>button,.dialog-actions>button,.station-action-button{display:flex;align-items:center;justify-content:center;text-align:center;}
.detail-more-button{padding:0 12px;line-height:1.25;}.station-action-button{min-height:32px;padding:4px 8px;border-radius:9px;background:#e8f3f3;color:#177e76;font-size:12px;line-height:1.5;white-space:nowrap;}.shipment-management{margin-top:14px;}
.small-primary{display:flex;align-items:center;justify-content:center;text-align:center;}.tracking-number{display:flex;align-items:center;}
</style>
<style>
.record-list::view-transition-group(*){animation-duration:240ms;}
@media(prefers-reduced-motion:reduce){.record-list::view-transition-group(*),.record-list::view-transition-old(*),.record-list::view-transition-new(*){animation:none!important;}}
.detail-sheet{background:linear-gradient(145deg,#f1f6fb,#e7eef7);}.detail-footer{background:#eaf1f8;}.completed .order-journeys{border-top:0;padding-top:0;}
.detail-header{margin-bottom:8px;}
</style>
