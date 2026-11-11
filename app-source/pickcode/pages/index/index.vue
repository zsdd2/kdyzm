<template>
  <view class="page-wrapper sf-page" @click="handlePageClick">

    <view class="container" :inert="notificationsOpen || stationChooserOpen || sourceOpen || shareOpen ? true : null">
      <view class="title-wrapper">
        <text class="title">取件列表</text>
        <button ref="shareButton" class="notification-bell pickup-share-button" role="button" tabindex="0" aria-label="分享取件码" aria-haspopup="dialog" :aria-expanded="shareOpen" @click.stop="$refs.pickupShare.open($refs.shareButton)" @keydown.enter.prevent.stop="!$event.repeat && $refs.pickupShare.open($refs.shareButton)" @keydown.space.prevent.stop="$event.preventDefault()" @keyup.space.prevent.stop="$refs.pickupShare.open($refs.shareButton)"><image :src="shareIcon" class="pickup-share-icon" mode="aspectFit" aria-hidden="true" /></button>
        <button ref="notificationBell" class="notification-bell" role="button" tabindex="0" data-notification-control aria-haspopup="dialog" :aria-expanded="notificationsOpen" :aria-label="'通知中心，' + notificationCount + '项待处理'" @click.stop="openNotifications">
          <uni-icons type="notification" size="24" color="#2469ed" />
          <text v-if="notificationCount" class="notification-badge">{{ notificationCount > 99 ? '99+' : notificationCount }}</text>
        </button>
      </view>
      
      <!-- 输入区域 -->
      <view class="card input-card sf-surface">
        <view class="input-area">
          <view class="input-wrapper">
            <input
              ref="codeInput"
              class="code-input"
              v-model="newCode"
              type="text"
              placeholder="请输入取件码"
              aria-label="取件码"
            />
            <view 
              class="clear-btn" 
              v-if="newCode" 
              @click="clearInput"
            >
              <uni-icons type="clear" size="14" color="#999" />
            </view>
          </view>
          <button class="add-btn" role="button" :tabindex="addingCode ? -1 : 0" :disabled="addingCode" :aria-disabled="addingCode" :aria-busy="addingCode" @click="addCode">
            <uni-icons type="plusempty" size="18" color="#fff" />
            <text>{{ addingCode ? '添加中' : '添加' }}</text>
          </button>
          <button class="read-sms-btn" role="button" :tabindex="scanning ? -1 : 0" :disabled="scanning" :aria-disabled="scanning" :aria-busy="scanning" :aria-label="scanning ? '正在更新取件记录' : '一键更新取件记录'" @click="readSms">
            <uni-icons type="refreshempty" size="22" color="#0867ff" />
          </button>
        </view>
      </view>

      <view class="pickup-grouping sf-surface" role="group" aria-label="取件列表显示方式">
        <button role="button" tabindex="0" :aria-pressed="pickupGrouping === 'station'" @click.stop="setPickupGrouping('station')" @keydown.enter.prevent.stop="!$event.repeat && setPickupGrouping('station')" @keydown.space.prevent.stop="$event.preventDefault()" @keyup.space.prevent.stop="setPickupGrouping('station')">按站点</button>
        <button role="button" tabindex="0" :aria-pressed="pickupGrouping === 'time'" @click.stop="setPickupGrouping('time')" @keydown.enter.prevent.stop="!$event.repeat && setPickupGrouping('time')" @keydown.space.prevent.stop="$event.preventDefault()" @keyup.space.prevent.stop="setPickupGrouping('time')">按时间</button>
      </view>
      <view v-if="receiptDeliveries.length" class="card code-card">
        <view class="card-header sf-surface">
          <h2 class="card-title receipt-heading">送达待确认</h2>
          <text class="card-extra"><text class="pending-count">{{ receiptDeliveries.length }}</text> 件待确认</text>
        </view>
        <view role="list">
          <view v-for="(entry, index) in receiptDeliveries" :key="entry.shipment.id" class="code-item receipt-card sf-surface" role="listitem">
            <view class="pickup-card-head">
              <text class="family-badge" :class="{ unassigned: !entry.order.familyId }" :style="pickupFamilyStyle(entry.order.familyId)">{{ entry.order.familyName || '待归属' }}</text>
              <text class="pickup-platform">{{ platformName(entry.order.platform) }}<template v-if="entry.shipment.carrier"> · {{ entry.shipment.carrier }}</template></text>
            </view>
            <view class="receipt-copy"><text class="receipt-title">{{ entry.order.title || '包裹' }}</text><text class="receipt-status">已送达·待确认</text></view>
            <button class="picked-btn receipt-confirm" role="button" :tabindex="canConfirmReceipt(entry) ? 0 : -1" data-notification-control :data-receipt-confirm="entry.shipment.id" :aria-label="'确认收到 ' + (entry.order.title || '包裹') + ' 包裹' + (index + 1)" :disabled="!canConfirmReceipt(entry)" :aria-busy="confirmingReceiptId === entry.shipment.id" @click.stop="confirmReceipt(entry)">确认收到</button>
            <view class="pickup-journeys"><ParcelJourney :journey="entry.journey" /></view>
          </view>
        </view>
      </view>
      <view v-if="hydrated && !pickupSections.length && !receiptDeliveries.length" class="pickup-empty">暂无待取记录</view>
      <template v-for="section in pickupSections" :key="pickupGrouping + ':' + section.key">
        <view class="card code-card">
          <view class="card-header sf-surface" @click="toggleCompletedSection(section)">
            <view class="card-title"><uni-icons v-if="pickupGrouping === 'station'" type="location" size="16" color="#2469ed" /><text>{{ section.label }}</text></view>
            <view class="header-right">
              <text v-if="getPendingCount(section.addresses) || hasJourneyCompletion(section.addresses)" class="card-extra">
                <text class="pending-count">{{ getPendingCount(section.addresses) }}</text>
                <text>件待取</text>
              </text>
              <button v-else class="completed-toggle" @click.stop="toggleSectionHistory(section.key)">{{ expandedGroups[section.key] ? '收起已取' : '全部已取 · 展开' }}</button>
              
              <!-- 添加日期卡片的更多操作按钮 -->
              <view v-if="pickupGrouping === 'time'" class="date-more-actions">
                <view class="more-btn" @click.stop="toggleDateActions(section.key)">
                  <view class="dots">
                    <view class="dot"></view>
                    <view class="dot"></view>
                    <view class="dot"></view>
                  </view>
                </view>
                
                <!-- 日期卡片的操作菜单 -->
                <view class="action-menu sf-surface" 
                  v-if="dateShowActions[section.key]"
                  :class="{ 'menu-up': section === pickupSections[pickupSections.length - 1] }"
                >
                  <view class="action-item delete" @click.stop="deleteDate(section.key, section.addresses)">
                    <uni-icons type="trash" size="16" />
                    <text>删除</text>
                  </view>
                </view>
              </view>
            </view>
          </view>
          <view class="code-list" v-if="getPendingCount(section.addresses) || expandedGroups[section.key] || hasJourneyCompletion(section.addresses)">
            <!-- 按地址分组显示 -->
            <view 
              v-for="(items, address) in visibleAddresses(section.addresses, expandedGroups[section.key])"
              :key="address" 
              class="address-group"
            >
              <view v-if="pickupGrouping === 'time'" class="address-header">
                <image class="address-icon" :src="yizhanIcon" mode="aspectFit" />
                <text class="address-text">{{ address }}</text>
              </view>
              
              <view 
                class="code-item sf-surface" 
                :class="{ 'code-collected': item.isPicked && !item.needsPickupAssignment, 'menu-open': item.showActions }"
                v-for="(item, index) in items" 
                :key="item.id"
              >
                <view class="code-content" :class="{ picked: item.isPicked }">
                  <view class="pickup-card-head">
                    <view class="code-families"><text v-for="family in (item.families?.length ? item.families : [{id:'',name:'待归属'}])" :key="family.id" class="family-badge" :class="{ unassigned: !family.id }" :style="pickupFamilyStyle(family.id)">{{ family.name }}</text></view>
                    <text v-if="pickupPlatform(item) !== '未关联订单'" class="pickup-platform">{{ pickupPlatform(item) }}</text>
                    <text v-if="item.totalCount > 1" class="pickup-progress">共 {{ item.totalCount }} 件 · 已取 {{ item.totalCount-item.pendingCount }} 件</text>
                  </view>
                  <view class="code-main">
                    <view class="cabinet-slot">
                      <view v-if="pickupCabinet(item)" class="cabinet-panel">
                        <text class="cabinet-label">柜号</text>
                        <text class="cabinet-value">{{ pickupCabinet(item) }}</text>
                      </view>
                    </view>
                    <view class="code-info">
                      <view class="pickup-line" :class="{ 'long-code': item.code.length > 8 }">
                        <view class="code-text" role="button" tabindex="0" :aria-label="'查看取件码 '+item.code+' 的短信与关联详情'" @click.stop="showSource(item)" @keydown.enter.prevent.stop="!$event.repeat && showSource(item)" @keydown.space.prevent.stop="$event.preventDefault()" @keyup.space.prevent.stop="showSource(item)">{{ formatCode(item.code) }}</view>
                      </view>
                      <button class="pickup-product" :class="{ expanded: expandedTitles[item.id] }" role="button" tabindex="0" :aria-expanded="!!expandedTitles[item.id]" aria-label="展开或收起商品名称" @click.stop="expandedTitles[item.id] = !expandedTitles[item.id]">{{ pickupTitle(item) }}</button>
                      <view class="code-desc" :class="{ picked: item.isPicked }">
                        <text v-if="pickupArrivalText(item)">{{ pickupArrivalText(item) }} {{ item.isManual ? '添加' : '进站' }}</text>
                      </view>
                      <!-- 标签展示 -->
                      <view class="code-source"><text v-if="!['线上订单', '订单'].includes(item.sourceLabel)">{{ item.sourceLabel || (item.isManual ? '手动' : '短信') }}</text><text v-if="item.conflicts?.length" class="conflict-label">取件码待确认</text></view>
                    </view>
                  </view>
                </view>

                <view class="right-actions">
                  <!-- 已取按钮 -->
                  <button
                    class="picked-btn"
                    role="button" tabindex="0"
                    :class="{ 'is-picked': item.isPicked }"
                    @click.stop="togglePicked(item)"
                    @keydown.enter.prevent.stop="!$event.repeat && togglePicked(item)"
                    @keydown.space.prevent.stop="$event.preventDefault()"
                    @keyup.space.prevent.stop="togglePicked(item)"
                  >
                    <text>{{ item.isPicked ? '已取' : item.totalCount > 1 || item.needsPickupAssignment ? '查看' : '取件' }}</text>
                    <text v-if="item.isPicked" class="picked-icon">✓</text>
                  </button>

                  <!-- 更多操作按钮 -->
                  <view class="more-actions">
                    <button
                      class="more-btn" type="button" role="button" tabindex="0" :data-pickup-menu="item.id" aria-haspopup="menu" :aria-expanded="item.showActions" :aria-label="'取件码 ' + item.code + ' 更多操作'"
                      @click.stop="toggleMoreActions(item, $event)" @keydown.stop="pickupMenuKey($event, item)" @keyup.stop="pickupMenuKey($event, item)"
                    >
                      <view class="dots">
                        <view class="dot"></view>
                        <view class="dot"></view>
                        <view class="dot"></view>
                      </view>
                    </button>

                    <!-- 操作菜单 -->
                    <view class="action-menu sf-surface" 
                      v-if="item.showActions"
                      :class="{ 'menu-up': isLastItem(item) }"
                      role="menu" aria-label="取件记录操作" @keydown.stop="pickupMenuKey($event, item)" @keyup.stop="pickupMenuKey($event, item)"
                    >
                      <button class="action-item" role="menuitem" tabindex="0" @click.stop="editCode(item)">
                        <uni-icons type="compose" size="16" />
                        <text>修改</text>
                      </button>
                      <button class="action-item" role="menuitem" tabindex="0" @click.stop="changeStation(item)"><uni-icons type="location" size="16" /><text>更换站点</text></button>
                      <button v-if="item.sourceId" class="action-item" role="menuitem" tabindex="0" @click.stop="openIgnore(item)">
                        <uni-icons type="eye-slash" size="16" />
                        <text>忽略短信</text>
                      </button>
                      <button
                        class="action-item delete" role="menuitem" tabindex="0"
                        @click.stop="deleteCode(item)"
                      >
                        <uni-icons type="trash" size="16" color="#ff0000" />
                        <text>删除</text>
                      </button>
                    </view>
                  </view>
                </view>
                <view v-if="pickupJourneys[item.id]?.length" class="pickup-journeys" @click.stop="showSource(item)">
                  <view v-for="(entry, journeyIndex) in pickupJourneys[item.id]" :key="entry.id" class="pickup-journey">
                    <text v-if="pickupJourneys[item.id].length > 1" class="journey-parcel-label">包裹 {{ journeyIndex + 1 }} · {{ entry.title }}</text>
                    <ParcelJourney :journey="entry.journey" />
                  </view>
                </view>
                <view class="pickup-detail-block">
                  <view v-if="matchSummary(item).available" class="match-entry"><text v-if="matchSummary(item).needsReview" class="conflict-label">关联待核对</text><text v-else-if="matchSummary(item).candidateCount" class="match-status">待匹配 · {{ matchSummary(item).candidateCount }}个候选</text><button class="match-entry-button" @click.stop="showSource(item,true)">匹配订单</button></view>
                  <view v-if="item.tags && item.tags.length" class="code-tags"><view v-for="tag in item.tags" :key="tag" class="code-tag">{{ tag }}</view></view>
                  <view v-if="item.remark" class="code-remark">备注：{{ item.remark }}</view>
                </view>
              </view>
            </view>
          </view>
          <button v-if="getPendingCount(section.addresses) && getPickedCount(section.addresses)" class="history-toggle" @click.stop="toggleSectionHistory(section.key)">已取 {{ getPickedCount(section.addresses) }} 件 · {{ expandedGroups[section.key] ? '收起' : '展开' }}</button>
        </view>
      </template>
    </view>

    <PickupShare ref="pickupShare" :snapshot="snapshot" @open-change="shareOpen = $event" />
    <uni-popup ref="sourcePopup" @change="sourceOpen = $event.show" type="bottom" :safe-area="false" :animation="!reducedMotion">
      <PickupDetail :inert="stationChooserOpen ? true : null" :key="detailRevision" :item="sourceItem" :packages="snapshot.packages || []" :match-on-open="matchingOnOpen" @close="$refs.sourcePopup.close()" @changed="applySnapshot" @ignore="openIgnore" @station-change="changeStation" />
    </uni-popup>
    <StationChooser ref="stationChooser" :rules="snapshot.stationRules || []" :recent="snapshot.stationChoices || []" @changed="applySnapshot" @open-change="stationChooserOpen = $event" />
    <uni-popup ref="notificationsPopup" class="notifications-popup" type="bottom" :animation="!reducedMotion" :safe-area="false" mask-background-color="rgba(10,34,70,.22)" @change="notificationPopupChange">
      <view v-if="notificationsOpen" ref="notificationSheet" class="notification-sheet sf-surface" role="dialog" aria-modal="true" aria-labelledby="notification-title" @click.stop>
        <view class="notification-handle" aria-hidden="true"></view>
        <view class="notification-heading">
          <view class="notification-title-row"><text id="notification-title" class="notification-title" role="heading" aria-level="2">通知中心</text><text class="notification-total">{{ notificationCount ? notificationCount + ' 项待处理' : '暂无待处理事项' }}</text></view>
          <button ref="notificationClose" class="notification-close" role="button" tabindex="0" data-notification-control aria-label="关闭通知中心" @click="closeNotifications()"><uni-icons type="closeempty" size="18" color="#8493a8" /></button>
        </view>
        <view class="notification-tabs sf-surface" role="group" aria-label="通知类别">
          <button v-for="tab in notificationTabs" :key="tab.key" role="button" tabindex="0" data-notification-control :class="{ selected: notificationCategory === tab.key }" :aria-pressed="notificationCategory === tab.key" @click="notificationCategory = tab.key">{{ tab.label }}<text v-if="tab.count">{{ tab.count }}</text></button>
        </view>
        <view class="notification-list" role="list">
          <view v-if="!visibleNotifications.length" class="notification-empty">{{ notificationCategory === 'error' ? '目前没有异常' : '目前没有待确认事项' }}</view>
          <view v-for="notice in visibleNotifications" :key="notice.id" class="notification-item sf-surface" :class="'notification-' + notice.kind" role="listitem" :data-notification-id="notice.id">
            <view class="notification-icon" aria-hidden="true"><image v-if="notice.kind === 'review'" :src="reviewNoticeIcon" mode="aspectFit" /><uni-icons v-else :type="notice.kind === 'error' ? 'info' : 'refreshempty'" size="20" :color="notice.kind === 'error' ? '#eb6167' : '#1673f7'" /></view>
            <view class="notification-content">
              <view class="notification-item-heading"><text class="notification-item-title">{{ notice.title }}</text><text v-if="notice.time" class="notification-time">{{ notificationTime(notice.time) }}</text></view>
              <text class="notification-body">{{ notice.body }}</text>
              <template v-if="notice.receipt">
                <text class="notification-detail">{{ receiptLogistics(notice.receipt.shipment) }}</text>
                <button class="notification-action" role="button" :tabindex="canConfirmReceipt(notice.receipt) ? 0 : -1" data-notification-control :disabled="!canConfirmReceipt(notice.receipt)" :aria-busy="confirmingReceiptId === notice.receipt.shipment.id" @click="confirmReceipt(notice.receipt)">确认收到</button>
              </template>
              <template v-else-if="notice.reminder">
                <button class="notification-action" role="button" tabindex="0" data-notification-control :aria-expanded="expandedReminderId === notice.reminder.sourceId" @click="expandedReminderId = expandedReminderId === notice.reminder.sourceId ? '' : notice.reminder.sourceId">{{ expandedReminderId === notice.reminder.sourceId ? '收起短信' : '查看短信' }}</button>
                <view v-if="expandedReminderId === notice.reminder.sourceId" class="notification-reminder-detail"><text class="sms-body">{{ notice.reminder.body }}</text><view class="notification-actions"><button class="notification-action" role="button" tabindex="0" data-notification-control @click="handleNotificationAction(notice, 'ignore')">忽略这条短信</button><button class="notification-action" role="button" tabindex="0" data-notification-control @click="handleNotificationAction(notice, 'rules')">短信识别规则</button></view></view>
              </template>
              <button v-else-if="notice.action" class="notification-action" role="button" :tabindex="notice.disabled ? -1 : 0" data-notification-control :disabled="notice.disabled" @click="handleNotificationAction(notice)">{{ notice.actionLabel }}<text aria-hidden="true"> ↗</text></button>
            </view>
            <button class="notification-dismiss" role="button" tabindex="0" data-notification-control :aria-label="'关闭通知：' + notice.title + '，' + notice.body" @click="dismissNotification(notice)"><uni-icons type="closeempty" size="16" color="#8493a8" /></button>
          </view>
        </view>
        <view class="notification-footer"><text>事项有新进展时会再次提醒</text><button role="button" tabindex="0" data-notification-control @click="closeNotifications()">收起</button></view>
      </view>
    </uni-popup>
    <uni-popup ref="ignorePopup" type="center" :is-mask-click="false">
      <view class="ignore-dialog sf-surface" @click.stop>
        <text class="dialog-title">忽略这条短信？</text>
        <text class="dialog-description">本条短信不再自动识别，可在「我的 → 已忽略短信」恢复。</text>
        <text v-if="ignoring" class="source-preview">{{ ignoring.sourceBody || ignoring.body || ignoring.code }}</text>
        <label class="ignore-label" for="ignore-reason">原因（可选）</label>
        <input id="ignore-reason" class="ignore-input" v-model="ignoreReason" maxlength="200" placeholder="最多 200 字" />
        <view class="dialog-actions"><button @click="$refs.ignorePopup.close()">取消</button><button class="confirm-ignore" :disabled="savingIgnore" @click="confirmIgnore">确认忽略</button></view>
      </view>
    </uni-popup>
  </view>
</template>

<script>
import yizhanIcon from '@/static/yizhan.png';
import PickupDetail from '@/components/PickupDetail.vue';
import PickupShare from '@/components/PickupShare.vue';
import ParcelJourney from '@/components/ParcelJourney.vue';
import { parcelJourney, JOURNEY_COMPLETION_MS } from '@/services/parcel-journey.js';
import StationChooser from '@/components/StationChooser.vue';
import { getSnapshot, getSyncStatus, mutate, refreshAll, refreshOnline as refreshOnlineOrders, syncOnline } from '@/services/assistant.js';
import { pendingCount, reconcileExpandedDates } from '@/services/pickup-groups.js';
import { groupCodesByStation, pickupCabinet, pickupSections, reconcileExpandedStations } from '@/services/station-presentation.js';
import { shouldArchivePackage } from '@/core/package-presentation.js';
import { pickupMatchSummary } from '@/services/pickup-matching-view.js';
import { notificationScope, readNotificationDismissals, visibleNotificationItems, dismissNotificationItem } from '@/services/notification-dismissals.js';

const emptySnapshot = () => ({ codes: [], packages: [], reminders: [], ignored: [], lastScanAt: 0, summary: { added: 0 } });
const notificationHistoryKey = '__pickcodeNotificationSheet';
const shareIcon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#2469ed" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4m-6.8 7 6.8 4"/></svg>');
// The approved preview's source SVG avoids the cropped Figma export viewport.
const reviewNoticeIcon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#cf8b22" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 2 10 10-10 10L2 12Z"/><path d="M12 7v6m0 3h.01"/></svg>');
export default {
  components: { ParcelJourney, PickupDetail, StationChooser, PickupShare },
  data() {
    return { sourceOpen: false, expandedTitles: {}, newCode: '', addingCode: false, packageCodes: [], snapshot: emptySnapshot(), dateShowActions: {}, expandedDates: {}, expandedStations: {}, pickupGrouping: 'station', sourceItem: null, detailRevision: 0, matchingOnOpen: false, journeyCompletions: {}, yizhanIcon,
      hydrated: false, backgroundSyncing: false, scanning: false, syncing: false, confirmingReceiptId: '', refreshProgressText: '更新中', syncMessage: '', syncErrors: { sms: '', online: '' }, pendingPickupId: '', ignoring: null, ignoreReason: '', savingIgnore: false, loadError: '',
      notificationsOpen: false, stationChooserOpen: false, shareOpen: false, shareIcon, notificationCategory: 'all', expandedReminderId: '', reviewNoticeIcon, notificationDismissals: readNotificationDismissals(),
      reducedMotion: typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches };
  },
  computed: {
    lastSyncText() { return this.snapshot.online?.lastSuccessAt ? new Date(this.snapshot.online.lastSuccessAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''; },
    onlineText() { const online=this.snapshot.online || {}; if(!this.hydrated)return '正在读取本地记录…'; if(this.scanning || this.syncing || this.backgroundSyncing)return this.refreshProgressText === '更新中' ? '正在更新包裹…' : this.refreshProgressText; if(!online.bound)return '线上账号未绑定 · 短信和手动取件可继续使用'; if(online.jobs?.some(job=>['queued','running'].includes(job.state)))return '订单仍在后台处理中，稍后刷新查看'; return (online.lastSuccessAt ? this.lastSyncText+' 已同步记录' : '线上账号已绑定 · 尚未同步')+(online.pendingCount ? ' · '+online.pendingCount+' 个操作待同步' : ''); },
    notificationItems() {
      const items = [], online = this.snapshot.online || {}, busy = this.scanning || this.syncing || this.backgroundSyncing;
      if (this.loadError) items.push({ id: 'load', kind: 'error', title: '本地记录读取失败', body: this.loadError, action: 'load', actionLabel: '重试' });
      const expired = (online.accounts || []).filter(account => account.status === 'expired');
      const onlineProblems = [...new Set([online.error, this.syncErrors.online, expired.length ? expired.map(account => this.platformName(account.platform)).join('、') + '账号登录已失效，请前往后台更新' : ''].filter(Boolean))];
      if (onlineProblems.length) {
        const accountAction = !online.bound || expired.length || ['token_expired', 'unauthorized', 'preview_session_expired'].includes(online.errorCode);
        items.push({ id: 'online-error', kind: 'error', title: accountAction ? '线上账号需要处理' : '线上更新未完成', body: onlineProblems.join('；'), progress: [online.errorCode, (online.jobs || []).map(job => [job.id, job.state, job.updatedAt, job.error])], action: accountAction ? 'accounts' : 'online', actionLabel: accountAction ? '管理账号' : '重试更新', disabled: !accountAction && busy });
      }
      if (this.syncErrors.sms) items.push({ id: 'sms-error', kind: 'error', title: '短信更新未完成', body: this.syncErrors.sms, action: 'scan', actionLabel: '重试更新', disabled: busy });
      for (const entry of this.receiptDeliveries) items.push({ id: 'receipt-' + entry.order.id + '-' + entry.shipment.id, kind: 'review', title: '已送达·待确认', body: (entry.order.familyId ? entry.order.familyName || '家人' : '待归属') + ' · ' + this.platformName(entry.order.platform) + ' · ' + (entry.order.title || '包裹'), receipt: entry });
      for (const item of this.packageCodes) {
        const match = this.matchSummary(item);
        if (item.isPicked && !item.needsPickupAssignment && !match.needsReview) continue;
        const reasons = [item.conflicts?.length ? '取件码存在差异' : '', item.needsPickupAssignment ? '已取件数待归属' : '', match.needsReview ? '关联待核对' : match.candidateCount ? match.candidateCount + ' 个匹配候选' : ''].filter(Boolean);
        if (reasons.length) items.push({ id: 'pickup-' + item.id, kind: 'review', title: '取件信息待核对', body: item.code + ' · ' + reasons.join(' · '), time: item.date, item, action: 'source', actionLabel: match.available ? '查看匹配' : '核对取件信息', matching: match.available });
      }
      for (const reminder of this.snapshot.reminders || []) items.push({ id: 'reminder-' + reminder.sourceId, kind: 'review', title: reminder.kind === 'reminder' ? '催取提醒' : '到站通知', body: '尚未识别到取件码，请查看原文。', time: reminder.date, reminder });
      const recentCompletions = this.recentAutoCompletions;
      const syncDetails = [this.onlineText, this.syncMessage, online.notice, this.snapshot.lastScanAt ? '已更新 ' + (this.snapshot.summary?.added || 0) + ' 个取件码 · 另有 ' + (this.snapshot.reminders?.length || 0) + ' 条提醒' : '', online.lastSuccessAt && (busy || onlineProblems.length) ? '上次成功同步 ' + this.lastSyncText : ''].filter(Boolean);
      items.push({ id: 'sync', kind: 'sync', title: busy ? '正在更新' : '同步与更新', body: [...new Set(syncDetails)].join('\n'), progress: [online.lastSuccessAt, this.snapshot.lastScanAt, (online.jobs || []).map(job => [job.id, job.state])], action: online.bound ? 'online' : 'accounts', actionLabel: busy ? this.refreshProgressText : online.bound ? '立即更新' : '绑定账号', disabled: !this.hydrated || busy });
      if (recentCompletions.length) items.push({ id: 'pickup-completion', kind: 'sync', title: '最近自动完成', body: recentCompletions.map(entry => this.completionOutcomeText(entry)).join('\n'), completions: recentCompletions, action: 'completed', actionLabel: '查看已完成' });
      return visibleNotificationItems(items, this.notificationDismissals, notificationScope(this.snapshot));
    },
    notificationCount() { return this.notificationItems.filter(item => item.kind !== 'sync').length; },
    notificationTabs() { return [{ key: 'all', label: '全部' }, { key: 'review', label: '待确认', count: this.notificationItems.filter(item => item.kind === 'review').length }, { key: 'error', label: '异常', count: this.notificationItems.filter(item => item.kind === 'error').length }, { key: 'sync', label: '同步' }]; },
    visibleNotifications() { return this.notificationItems.filter(item => this.notificationCategory === 'all' || item.kind === this.notificationCategory); },
    recentAutoCompletions() {
      if (!this.snapshot.online?.bound) return [];
      return (this.snapshot.packages || []).filter(order => order?.source === 'online' && !order.hidden).flatMap(order => (order.shipments || []).filter(shipment => {
        const completion = shipment?.pickupCompletion;
        return !shipment.hidden && shipment.canPick === true && completion?.version === 1 && completion.autoPicked === true && !completion.manualOverride && Number(completion.completedAt) > 0;
      }).map(shipment => ({ orderId: order.id, shipmentId: shipment.id, order, shipment }))).sort((a, b) => Number(b.shipment.pickupCompletion.completedAt) - Number(a.shipment.pickupCompletion.completedAt)).slice(0, 3);
    },
    pickupJourneys() {
      const byShipment = new Map();
      for (const order of this.snapshot.packages || []) for (const shipment of order.shipments || []) if (!shipment.hidden) byShipment.set(shipment.id, { id: shipment.id, title: Array.from(order.title || '包裹').slice(0, 15).join(''), journey: parcelJourney(shipment, order) });
      const result = Object.create(null);
      for (const item of this.packageCodes) result[item.id] = (item.members || []).filter(member => member.shipmentId && byShipment.has(member.shipmentId)).map(member => item.needsMatchReview || typeof member.independentPicked === 'boolean' ? { id: member.id, title: '关联待核对', journey: parcelJourney(member) } : byShipment.get(member.shipmentId));
      return result;
    },
    groupedCodes() {
      return groupCodesByStation(this.packageCodes);
    },
    pickupSections() {
      const live = new Map(this.packageCodes.map(item => [item.id, item]));
      const placement = this.packageCodes.map(item => this.journeyCompletions[item.id]?.until > Date.now() ? this.journeyCompletions[item.id].card : item);
      return pickupSections(placement, this.pickupGrouping).map(section => ({ ...section, addresses: Object.fromEntries(Object.entries(section.addresses).map(([address, items]) => [address, items.map(item => live.get(item.id))])) }));
    },
    expandedGroups() { return Object.assign(Object.create(null), this.pickupGrouping === 'station' ? this.expandedStations : this.expandedDates); },
    receiptDeliveries() {
      return (this.snapshot.packages || []).filter(order => order.source === 'online' && !order.hidden && !shouldArchivePackage(order)).flatMap(order => (order.shipments || []).filter(shipment => shipment.needsReceiptConfirmation && !shipment.picked && !shipment.hidden).map(shipment => ({ order, shipment, journey: parcelJourney(shipment, order) })));
    }
  },
  onLoad(options) { this.pendingPickupId=options?.pickupId || ''; uni.$on('assistant-changed', this.applySnapshot); uni.$on('assistant-sync-status', this.applySyncStatus); if(typeof window!=='undefined')window.addEventListener('pickcode-open-pickup',this.openPickupIntent); },
  onShow() { this.applySyncStatus(getSyncStatus()); const pending = uni.getStorageSync('pendingPickupId'); if (pending) { this.pendingPickupId = pending; uni.removeStorageSync('pendingPickupId'); } this.loadData(); },
  onUnload() { this.clearJourneyCompletions(); this.$refs.pickupShare?.close(false); uni.$off('assistant-changed', this.applySnapshot); uni.$off('assistant-sync-status', this.applySyncStatus); if(typeof window!=='undefined')window.removeEventListener('pickcode-open-pickup',this.openPickupIntent); },
  onHide() { this.clearJourneyCompletions(); this.closeNotifications(false); this.$refs.stationChooser?.close(); if(typeof document==='undefined'||document.visibilityState!=='hidden')this.$refs.pickupShare?.close(false); },
  deactivated() { this.$refs.pickupShare?.close(false); },
  onBackPress() { if (this.shareOpen) { this.$refs.pickupShare.close(); return true; } if (this.stationChooserOpen) { this.$refs.stationChooser.close(); return true; } if(this.sourceOpen){this.$refs.sourcePopup.close();return true;} if (this.notificationsOpen) { this.closeNotifications(); return true; } },
  mounted() {
    this.labelCodeInput();
    this.$el?.addEventListener?.('keydown', this.inputActionKey);
    this.$el?.addEventListener?.('keyup', this.inputActionKey);
    this.$el?.addEventListener?.('keydown', this.notificationKeyboard);
    this.$el?.addEventListener?.('keyup', this.notificationKeyboard);
    if (typeof window !== 'undefined') window.addEventListener('popstate', this.notificationPopState);
  },
  beforeUnmount() {
    this.clearJourneyCompletions();
    this.$el?.removeEventListener?.('keydown', this.inputActionKey);
    this.$el?.removeEventListener?.('keyup', this.inputActionKey);
    this.$el?.removeEventListener?.('keydown', this.notificationKeyboard);
    this.$el?.removeEventListener?.('keyup', this.notificationKeyboard);
    if (typeof window !== 'undefined') window.removeEventListener('popstate', this.notificationPopState);
    this.releaseNotificationBackground();
    this.clearNotificationHistoryMarker();
    this._notificationBackResolve?.();
  },
  methods: {
    labelCodeInput() {
      const root = this.$refs.codeInput?.$el || this.$refs.codeInput;
      // uni-input places fallthrough attributes on its wrapper instead of its native input.
      const input = root?.tagName === 'INPUT' ? root : root?.querySelector?.('input');
      input?.setAttribute?.('aria-label', '取件码');
    },
    inputActionKey(event) {
      // uni-app's template event wrapper drops the DOM target and KeyboardEvent.repeat.
      const target = event.target?.closest?.('.add-btn, .read-sms-btn');
      if (target?.tagName !== 'UNI-BUTTON' || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      if (event.repeat || target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true') return;
      if (event.type === (event.key === 'Enter' ? 'keydown' : 'keyup')) target.click();
    },
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
      if (this.onlineBindingKey(snapshot) !== this.onlineBindingKey()) { this.clearJourneyCompletions(); return; }
      const now = Date.now(), next = new Map((snapshot.codes || []).map(item => [item.id, item])), retained = {};
      for (const [id, value] of Object.entries(this.journeyCompletions)) if (value.until > now && next.get(id)?.isPicked) retained[id] = value;
      for (const section of this.pickupSections) for (const previous of Object.values(this.visibleAddresses(section.addresses, this.expandedGroups[section.key])).flat()) {
        const item = next.get(previous.id);
        if (!previous.isPicked && item?.isPicked) retained[item.id] = { until: now + JOURNEY_COMPLETION_MS, card: previous };
      }
      this.journeyCompletions = retained; this.scheduleJourneyCompletions();
    },
    hasJourneyCompletion(group) { return Object.values(group).flat().some(item => this.journeyCompletions[item.id]?.until > Date.now()); },
    notificationTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); },
    completionOutcomeText(entry) {
      const completion = entry.shipment?.pickupCompletion || {};
      const when = this.notificationTime(completion.completedAt);
      const title = entry.order?.title || entry.shipment?.waybillNo || '包裹';
      const evidence = completion.evidence?.description || completion.evidence?.kind || '明确领取证据';
      return [title, when, evidence].filter(Boolean).join(' · ');
    },
    onlineBindingKey(snapshot = this.snapshot) { const online = snapshot.online || {}; return JSON.stringify([!!online.bound, online.baseUrl || '', online.deviceId || '']); },
    notificationElement(ref) { return ref?.$el || ref; },
    dismissNotification(notice) {
      const index = this.visibleNotifications.findIndex(item => item.id === notice.id);
      try { this.notificationDismissals = dismissNotificationItem(this.notificationDismissals, notice, notificationScope(this.snapshot)); }
      catch (error) { this.showError(error); return; }
      this.$nextTick(() => {
        const sheet = this.notificationElement(this.$refs.notificationSheet);
        const controls = sheet?.querySelectorAll?.('.notification-dismiss');
        (controls?.[Math.min(index, controls.length - 1)] || this.notificationElement(this.$refs.notificationClose))?.focus?.();
      });
    },
    openNotifications() {
      if (this.notificationsOpen || this._notificationClosing) return;
      this.handlePageClick(); this.notificationCategory = 'all'; this.notificationsOpen = true;
      if (typeof document !== 'undefined') {
        document.activeElement?.blur?.();
        const tabbar = document.querySelector?.('uni-tabbar');
        if (tabbar) { this._notificationTabbar = { element: tabbar, inert: tabbar.inert }; tabbar.inert = true; }
      }
      uni.hideKeyboard?.();
      if (typeof window !== 'undefined' && window.history?.pushState) {
        const marker = { id: 'notifications-' + Date.now() + '-' + Math.random().toString(36).slice(2), url: window.location.href };
        window.history.pushState({ ...window.history.state, [notificationHistoryKey]: marker.id }, '', marker.url);
        this._notificationHistory = marker;
      }
      this.$refs.notificationsPopup?.open?.();
      this.$nextTick(() => this.notificationElement(this.$refs.notificationClose)?.focus?.());
    },
    clearNotificationHistoryMarker() {
      const marker = this._notificationHistory;
      if (typeof window === 'undefined' || !marker || window.location.href !== marker.url || window.history.state?.[notificationHistoryKey] !== marker.id) return false;
      const state = { ...window.history.state }; delete state[notificationHistoryKey];
      window.history.replaceState(state, '', window.location.href);
      return true;
    },
    async closeNotifications(restoreFocus = true) {
      if (!this.notificationsOpen) return;
      this.notificationsOpen = false; this._notificationClosing = true;
      this.$refs.notificationsPopup?.close?.();
      this.releaseNotificationBackground();
      // Only consume the same-URL history entry that this sheet created.
      if (this.clearNotificationHistoryMarker()) await new Promise(resolve => { this._notificationBackResolve = resolve; window.history.back(); });
      this._notificationHistory = null;
      if (typeof window !== 'undefined') await new Promise(resolve => setTimeout(resolve, 310));
      this._notificationClosing = false;
      if (restoreFocus) this.notificationElement(this.$refs.notificationBell)?.focus?.();
    },
    releaseNotificationBackground() {
      if (this._notificationTabbar) { this._notificationTabbar.element.inert = this._notificationTabbar.inert; this._notificationTabbar = null; }
    },
    notificationPopState() {
      if (this._notificationBackResolve) { const resolve = this._notificationBackResolve; this._notificationBackResolve = null; resolve(); }
      if (this._notificationHistory && window.history.state?.[notificationHistoryKey] !== this._notificationHistory.id) {
        this._notificationHistory = null;
        this.closeNotifications();
      }
    },
    notificationPopupChange(event) { if (!event.show && this.notificationsOpen) this.closeNotifications(); },
    notificationKeyboard(event) {
      if (this.notificationsOpen && event.key === 'Tab' && event.type === 'keydown') {
        const sheet = this.notificationElement(this.$refs.notificationSheet), controls = [...(sheet?.querySelectorAll?.('[data-notification-control]:not([disabled])') || [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (first && (event.shiftKey && event.target === first || !event.shiftKey && event.target === last || !sheet.contains(event.target))) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
        return;
      }
      if (this.notificationsOpen && ['Escape', 'Esc'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (event.type === 'keyup') this.closeNotifications(); return; }
      if (!['Enter', ' '].includes(event.key)) return;
      const control = event.target?.closest?.('[data-notification-control]');
      if (!control || ['BUTTON', 'INPUT'].includes(control.tagName)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.type === 'keyup' && !control.hasAttribute('disabled')) control.click();
    },
    async handleNotificationAction(notice, action = notice.action) {
      if (notice.disabled) return;
      if (action === 'load') { await this.loadData(); return; }
      if (action === 'online') { await this.refreshOnline(); return; }
      if (action === 'scan') { await this.readSms(); return; }
      await this.closeNotifications(false);
      if (action === 'accounts') uni.navigateTo({ url: '/pages/my/online-accounts' });
      else if (action === 'rules') uni.navigateTo({ url: '/pages/my/match-rules' });
      else if (action === 'source') { const item = this.packageCodes.find(item => item.id === notice.item.id); if (item) this.showSource(item, notice.matching); }
      else if (action === 'ignore') { const item = this.snapshot.reminders.find(item => item.sourceId === notice.reminder.sourceId); if (item) this.openIgnore(item); }
      else if (action === 'completed') {
        const entry = notice.completions?.[0];
        uni.setStorageSync('pickcode.pickup-completion', JSON.stringify({ orderId: entry?.orderId || '', shipmentId: entry?.shipmentId || '', showHistory: true }));
        uni.switchTab({ url: '/pages/packages/index' });
      }
    },
    pickupCabinet,
    openPickupIntent(event) { this.pendingPickupId=event.detail?.id || ''; uni.switchTab({url:'/pages/index/index',success:()=>this.loadData()}); },
    applySyncStatus(status) { this.backgroundSyncing = status.syncing; },
    async refreshOnline() {
      if (!this.hydrated || this.scanning || this.syncing || this.backgroundSyncing) return;
      if (!this.snapshot.online?.bound) { uni.navigateTo({ url: '/pages/my/online-accounts' }); return; }
      const binding = this.onlineBindingKey();
      this.syncing = true; this.syncMessage = ''; this.syncErrors.online = '';
      try {
        const result = await refreshOnlineOrders(progress => { this.refreshProgressText = progress.label; });
        if (binding !== this.onlineBindingKey()) return;
        this.applySnapshot(result.snapshot);
        this.syncErrors.online = result.onlineError || '';
        this.syncMessage = [result.onlineNotice, result.pending ? result.pendingNotice || '订单仍在后台处理中，稍后刷新查看' : ''].filter(Boolean).join('；');
      } catch (error) { if (binding === this.onlineBindingKey()) { this.syncErrors.online = error.message || '线上更新失败'; this.showError(error); } }
      finally { this.syncing = false; this.refreshProgressText = '更新中'; }
    },
    applySnapshot(snapshot) {
      this.retainCompletedJourneys(snapshot);
      this.expandedDates = reconcileExpandedDates(this.packageCodes, snapshot.codes, this.expandedDates);
      this.expandedStations = reconcileExpandedStations(this.packageCodes, snapshot.codes, this.expandedStations);
      if (this.onlineBindingKey(snapshot) !== this.onlineBindingKey()) { this.syncErrors.online = ''; this.syncMessage = ''; }
      if (snapshot.online?.lastSuccessAt > (this.snapshot.online?.lastSuccessAt || 0) && !snapshot.online?.error) this.syncErrors.online = '';
      if (snapshot.lastScanAt > (this.snapshot.lastScanAt || 0)) this.syncErrors.sms = '';
      this.snapshot = snapshot;
      this.hydrated = true;
      this.packageCodes = snapshot.codes.map(item => ({ ...item, showActions: false }));
      if(this.sourceItem){this.sourceItem=snapshot.codes.find(item=>item.id===this.sourceItem.id)||null;if(!this.sourceItem)this.$refs.sourcePopup?.close();}
      if(this.pendingPickupId){const item=this.packageCodes.find(item=>item.id===this.pendingPickupId);if(item){this.pendingPickupId='';this.$nextTick(()=>this.showSource(item));}}
      this.loadError = '';
    },
    async loadData() { try { this.applySnapshot(await getSnapshot()); } catch(error) { this.loadError = error.message; } },
    showError(error) { uni.showToast({ title: error.message || '操作失败', icon: 'none' }); },
    platformName(platform) { return ({ taobao: '淘宝', jd: '京东', pdd: '拼多多', douyin: '抖音' })[platform] || platform || '线上'; },
    pickupPlatform(item) {
      const platforms = [...new Set((item?.members || []).map(member => member?.platform).filter(platform => platform && platform !== '短信'))];
      return platforms.length ? platforms.map(platform => this.platformName(platform)).join('、') : '未关联订单';
    },
    pickupTitle(item) {
      const title = (item?.members || []).filter(member => member.title && member.platform !== '短信').map(member => member.title.trim()).join(' / ');
      const characters = Array.from(title);
      return !this.expandedTitles[item.id] && characters.length > 15 ? characters.slice(0, 15).join('') + '…' : title;
    },
    receiptLogistics(shipment) { const latest = shipment.logisticsEvents?.[0]; return latest?.message || latest?.description || (shipment.waybillNo ? '运单 ' + shipment.waybillNo : ''); },
    canConfirmReceipt(entry) { return !this.syncing && !this.scanning && !this.confirmingReceiptId && !!entry.shipment.id && entry.shipment.canPick !== false; },
    async confirmReceipt(entry) {
      const current = this.receiptDeliveries.find(item => item.order.id === entry.order.id && item.shipment.id === entry.shipment.id);
      if (!current || !this.canConfirmReceipt(current)) return;
      this.confirmingReceiptId = current.shipment.id;
      try { this.applySnapshot(await mutate('pickShipments', { orderId: current.order.id, shipmentIds: [current.shipment.id], picked: true })); }
      catch(error) { this.showError(error); }
      finally { this.confirmingReceiptId = ''; }
    },
    async addCode() {
      if (this.addingCode) return;
      const code = this.newCode.trim();
      if (!code) { uni.showToast({ title: '请输入取件码', icon: 'none' }); return; }
      this.addingCode = true;
      try { this.applySnapshot(await mutate('add', { item: { code } })); if (this.newCode.trim() === code) this.newCode = ''; }
      catch(error) { this.showError(error); }
      finally { this.addingCode = false; }
    },
    editCode(item) { item.showActions = false; uni.navigateTo({ url: '/pages/index/edit-code?id='+encodeURIComponent(item.id) }); },
    deleteCode(item) {
      item.showActions = false;
      uni.showModal({ title: '删除取件码', content: '删除后不会从同一条短信重复添加。', success: async result => {
        if (!result.confirm) return;
        try { this.applySnapshot(await mutate('remove',{ids:[item.id]})); } catch(error) { this.showError(error); }
      }});
    },
    async togglePicked(item) {
      if(item.totalCount>1 || item.needsPickupAssignment){this.showSource(item);return;}
      try { this.applySnapshot(await mutate('update', { id: item.id, patch: { isPicked: !item.isPicked } })); }
      catch(error) { this.showError(error); }
    },
    async readSms() {
      if (this.scanning) return;
      const binding = this.onlineBindingKey();
      this.scanning = true; this.syncMessage = ''; this.syncErrors = { sms: '', online: '' };
      try {
        const result = await refreshAll(progress => { this.refreshProgressText = progress?.label || '更新中'; });
        const sameBinding = binding === this.onlineBindingKey(), nextSnapshot = result.snapshot || result;
        if (sameBinding || this.onlineBindingKey(nextSnapshot) === this.onlineBindingKey()) this.applySnapshot(nextSnapshot);
        const onlineError = sameBinding ? result.onlineError : '', pending = sameBinding && result.pending;
        const errors = [result.smsError, onlineError].filter(Boolean).map(error => error.message || error);
        this.syncErrors = { sms: result.smsError?.message || result.smsError || '', online: onlineError?.message || onlineError || '' };
        const pendingNotice = result.pendingNotice || '订单仍在后台处理中，稍后刷新查看';
        if (pending) errors.push(pendingNotice);
        this.syncMessage = pending ? pendingNotice : sameBinding && result.onlineNotice ? '匹配完成 · '+result.onlineNotice : errors.length ? '' : '匹配完成';
        uni.showToast({title: pending ? '后台仍在处理' : errors.length ? '部分完成' : '匹配完成',icon:'none'});
      } catch(error) { this.syncErrors.sms = error.message || '更新失败，请重试'; this.showError(error); }
      finally { this.scanning = false; this.refreshProgressText = '更新中'; }
    },
    openIgnore(item) {
      item.showActions = false; this.ignoring = item; this.ignoreReason = '';
      this.$refs.ignorePopup.open();
    },
    async confirmIgnore() {
      if (!this.ignoring || this.savingIgnore) return;
      this.savingIgnore = true;
      try {
        this.applySnapshot(await mutate('ignore', { sourceId: this.ignoring.sourceId, reason: this.ignoreReason }));
        this.$refs.ignorePopup.close(); this.ignoring = null;
        uni.showToast({title:'已忽略，可在我的中恢复',icon:'none'});
      } catch(error) { this.showError(error); }
      finally { this.savingIgnore = false; }
    },
    getPendingCount: pendingCount,
    visibleAddresses(group, showPicked = false) {
      return Object.fromEntries(Object.entries(group).map(([address, items]) => [address, items.filter(item => showPicked || (item.pendingCount ?? (item.isPicked ? 0 : 1)) > 0 || this.journeyCompletions[item.id]?.until > Date.now())]).filter(([, items]) => items.length));
    },
    getPickedCount(group) { return Object.values(group).flat().reduce((n,item)=>n+(item.totalCount || 1)-(item.pendingCount ?? (item.isPicked?0:1)),0); },
    toggleDateHistory(date) { this.handlePageClick(); this.expandedDates[date] = !this.expandedDates[date]; },
    toggleCompletedDate(date, group) { if (!pendingCount(group)) this.toggleDateHistory(date); },
    setPickupGrouping(mode) { if (!['station', 'time'].includes(mode)) return; this.clearJourneyCompletions(); this.handlePageClick(); this.pickupGrouping = mode; },
    toggleSectionHistory(key) { this.handlePageClick(); const name = this.pickupGrouping === 'station' ? 'expandedStations' : 'expandedDates'; this[name] = { ...this[name], [key]: !Object.hasOwn(this[name], key) || !this[name][key] }; },
    toggleCompletedSection(section) { if (!pendingCount(section.addresses)) this.toggleSectionHistory(section.key); },
    pickupArrivalText(item) {
      const pad = value => String(value).padStart(2, '0');
      const date = new Date(item.date);
      const original = item.sendDate || (item.date && !Number.isNaN(date.getTime()) ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}` : '');
      const parts = /^(\d{4})-(\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(original);
      if (!parts) return original;
      const olderYear = Number(parts[1]) !== new Date().getFullYear();
      return `${olderYear ? parts[1] + '-' + parts[2] + ' ' : this.pickupGrouping === 'station' ? parts[2] + ' ' : ''}${parts[3]}`;
    },
    pickupFamilyStyle(id) {
      if (!id) return {};
      let hash = 0; for (const char of String(id)) hash = (Math.imul(hash, 31) + char.codePointAt(0)) >>> 0;
      const hue = ((hash * 137.508) % 360).toFixed(2);
      return { color: 'hsl(' + hue + ',48%,30%)', background: 'hsl(' + hue + ',60%,95%)' };
    },
    matchSummary(item) { return pickupMatchSummary(item); },
    showSource(item, matching = false) { this.handlePageClick(); this.sourceItem = item; this.matchingOnOpen = matching; this.detailRevision++; this.$refs.sourcePopup.open(); },
    formatCode(code) { return /^\d{8}$/.test(code) ? code.slice(0,4)+' '+code.slice(4) : code; },
    changeStation(item, event) { this.handlePageClick(); this.$refs.stationChooser.open({ pickupId: item.id }, item, () => (this.sourceOpen ? [...(this.$el?.querySelectorAll?.('[data-pickup-station]') || [])].find(element => element.getAttribute('data-pickup-station') === String(item.id)) : null) || event?.currentTarget || [...(this.$el?.querySelectorAll?.('[data-pickup-menu]') || [])].find(element => element.getAttribute('data-pickup-menu') === String(item.id)) || this._pickupMenuTrigger); },
    toggleMoreActions(item, event) {
      const open = !item.showActions; this.handlePageClick(); item.showActions = open;
      if (open) { this._pickupMenuTrigger = [...(this.$el?.querySelectorAll?.('[data-pickup-menu]') || [])].find(element => element.getAttribute('data-pickup-menu') === String(item.id)) || event?.currentTarget; this.$nextTick(() => this._pickupMenuTrigger?.parentElement?.querySelector('[role="menuitem"]')?.focus?.()); }
    },
    pickupMenuKey(event, item) {
      const target = event.target?.tagName ? event.target : (typeof document !== 'undefined' && document.activeElement) || event.target;
      if (['Escape', 'Esc'].includes(event.key)) { event.preventDefault(); if (event.type === 'keydown') { this.handlePageClick(); this._pickupMenuTrigger?.focus?.(); } return; }
      if (event.key === 'Tab') { if (event.type === 'keydown') { this.handlePageClick(); this._pickupMenuTrigger?.focus?.(); } return; }
      if (event.type === 'keydown' && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        if (!item.showActions) { this.toggleMoreActions(item, event); return; }
        const controls = [...(this._pickupMenuTrigger?.parentElement?.querySelectorAll('[role="menuitem"]') || [])], index = controls.indexOf(target);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus?.(); return;
      }
      if (target?.tagName === 'UNI-BUTTON' && ['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!event.repeat && event.type === (event.key === 'Enter' ? 'keydown' : 'keyup')) target.click(); }
    },
    toggleDateActions(date) {
      const open = !this.dateShowActions[date]; this.handlePageClick(); this.dateShowActions[date] = open;
    },
    deleteDate(date, group) {
      this.dateShowActions[date] = false;
      uni.showModal({title:'删除本组取件记录？',content:'删除 '+date+' 分组的取件记录，手机短信保留，记录不会自动重建。',success:async result=>{
        if(!result.confirm)return;
        try {this.applySnapshot(await mutate('remove',{ids:Object.values(group).flat().map(i=>i.id)}));}
        catch(error){this.showError(error);}
      }});
    },
    isLastItem(item) {
      return this.pickupSections.some(section=>Object.values(this.visibleAddresses(section.addresses, this.expandedGroups[section.key])).some(items=>items[items.length-1]===item));
    },
    clearInput() { this.newCode=''; },
    handlePageClick() { this.packageCodes.forEach(i=>{i.showActions=false;}); this.dateShowActions={}; }
  }
};
</script>

<style lang="scss" scoped>
.page-wrapper { min-height:calc(100vh - var(--window-bottom, 64px)); color:var(--sf-text); }
.container { position:relative; padding:22px 16px 24px; min-height:inherit; box-sizing:border-box; }
.title-wrapper { position:relative; min-height:44px; display:flex; align-items:center; padding-right:104px; margin-bottom:18px; }
.pickup-share-button { right:52px !important; }
.pickup-share-icon { width:24px; height:24px; }
.title { font-size:clamp(1.75rem, 1.25rem + 2vw, 1.875rem); font-weight:750; line-height:1.2; letter-spacing:-.035em; }
.notification-bell { position:absolute; right:0; display:flex; align-items:center; justify-content:center; width:44px; height:44px; padding:0; margin:0; border:1px solid var(--sf-edge); border-radius:50%; overflow:visible; background:var(--sf-glass); box-shadow:var(--sf-shadow); backdrop-filter:var(--sf-filter); -webkit-backdrop-filter:var(--sf-filter); }
.notification-badge { position:absolute; top:-3px; right:-2px; min-width:19px; min-height:19px; padding:1px 4px; box-sizing:border-box; border:2px solid #edf2f8; border-radius:12px; background:#df4b44; color:white; font-size:.625rem; line-height:1.3; font-weight:650; }
button::after { border:0; }
button:focus-visible, .add-btn:focus-visible, .read-sms-btn:focus-visible, .code-text:focus-visible { outline:3px solid var(--sf-blue); outline-offset:3px; }
button[disabled] { opacity:.55; }
.input-card { padding:8px; margin-bottom:14px; border-radius:20px; }
.input-area { display:flex; align-items:center; gap:7px; }
.input-wrapper { flex:1; min-width:0; position:relative; display:flex; align-items:center; }
.code-input { width:100%; min-width:0; min-height:44px; padding:0 32px 0 11px; box-sizing:border-box; border:1px solid var(--sf-edge); border-radius:12px; background:rgba(250,252,255,.48); font-size:.875rem; color:var(--sf-text); }
.clear-btn { position:absolute; right:0; top:0; width:36px; min-height:44px; display:flex; align-items:center; justify-content:center; }
.add-btn, .read-sms-btn { flex:none; min-height:44px; margin:0; padding:10px; display:flex; align-items:center; justify-content:center; gap:4px; border-radius:12px; font-size:.875rem; line-height:1.5; }
.add-btn { min-width:64px; background:var(--sf-blue); color:#fff; box-shadow:inset 0 1px 1px #ffffff3b, 0 4px 10px #0867ff14; }
.read-sms-btn { width:44px; border:1px solid #95b6e5; background:rgba(255,255,255,.28); color:var(--sf-blue); }
.pickup-grouping { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:4px; padding:4px; margin-bottom:16px; border-radius:18px; }
.pickup-grouping button { margin:0; padding:8px; min-width:0; min-height:44px; border:1px solid transparent; border-radius:14px; background:transparent; color:var(--sf-muted); font-size:.9375rem; line-height:1.5; }
.pickup-grouping button[aria-pressed=true] { background:rgba(255,255,255,.55); border-color:var(--sf-edge); color:var(--sf-blue); font-weight:650; box-shadow:0 2px 8px #33496308; }
.code-card { margin-bottom:18px; }
.card-header { position:relative; display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:48px; padding:10px 13px; box-sizing:border-box; border-radius:18px; margin-bottom:10px; z-index:1; }
.card-title { display:flex; align-items:center; gap:7px; min-width:0; font-size:1rem; font-weight:650; line-height:1.5; overflow-wrap:anywhere; }
.header-right { display:flex; align-items:center; gap:4px; flex:none; }
.card-extra { color:var(--sf-muted); font-size:.75rem; white-space:nowrap; line-height:1.5; }
.pending-count { margin-right:4px; color:var(--sf-blue); font-size:1.125rem; font-weight:750; font-variant-numeric:tabular-nums; }
.code-list { padding:0; }
.address-group + .address-group { margin-top:16px; }
.address-header { display:flex; align-items:center; gap:7px; padding:7px 4px 11px; color:var(--sf-muted); font-size:.875rem; line-height:1.5; }
.address-icon { width:18px; height:18px; flex:none; }
.address-text { min-width:0; overflow-wrap:anywhere; }
.code-item { --cabinet-width:72px; --action-width:76px; position:relative; display:grid; grid-template-columns:var(--cabinet-width) minmax(0,1fr) var(--action-width); column-gap:12px; row-gap:2px; margin-bottom:12px; padding:10px 14px 14px; border-radius:24px; }
.code-item.menu-open { z-index:5; }
.receipt-heading { margin:0; }
.receipt-card { grid-template-columns:minmax(0,1fr) auto; }
.receipt-card .pickup-card-head { padding-right:0; }
.receipt-copy { grid-column:1; grid-row:2; min-width:0; align-self:center; }
.receipt-title { display:block; color:var(--sf-text); font-size:.9375rem; line-height:1.5; overflow-wrap:anywhere; }
.receipt-status { display:block; margin-top:5px; color:var(--sf-muted); font-size:.75rem; line-height:1.5; }
.receipt-card .receipt-confirm { grid-column:2; grid-row:2; align-self:center; width:auto; min-width:88px; padding-inline:10px; font-size:.875rem; }
.receipt-confirm[disabled] { opacity:.55; }
.code-content, .code-main, .code-info, .right-actions { display:contents; }
.pickup-card-head { grid-column:1 / -1; grid-row:1; display:flex; align-items:center; flex-wrap:wrap; gap:5px 9px; min-width:0; min-height:34px; padding-right:34px; margin-bottom:4px; }
.code-families { display:flex; flex-wrap:wrap; gap:5px; min-width:0; }
.family-badge { padding:3px 9px; border-radius:9px; background:#e5eefc; color:#245dae; font-size:.75rem; line-height:1.5; font-weight:550; overflow-wrap:anywhere; }
.family-badge.unassigned { background:#dfe5ed; color:var(--sf-muted); }
.pickup-platform { color:var(--sf-muted); font-size:.8125rem; line-height:1.5; overflow-wrap:anywhere; }
.pickup-progress { color:var(--sf-teal); font-size:.6875rem; line-height:1.5; padding:3px 7px; background:#dff1ec; border-radius:8px; }
.cabinet-slot { grid-column:1; grid-row:2 / 6; display:flex; min-width:0; min-height:118px; }
.cabinet-panel { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:7px; min-width:0; padding:12px 4px; border:1px solid #effffc; border-radius:15px; background:linear-gradient(135deg,#d9f0ed,#e3f4f0); color:var(--sf-teal); }
.cabinet-label { font-size:.75rem; line-height:1.5; color:#48666d; }
.cabinet-value { max-width:100%; font-size:1.25rem; line-height:1.25; font-weight:700; letter-spacing:-.04em; text-align:center; overflow-wrap:anywhere; }
.pickup-line { grid-column:2 / -1; grid-row:2; display:flex; align-items:center; min-width:0; min-height:39px; }
.code-text { min-width:0; width:100%; color:var(--sf-text); font-size:clamp(1.5625rem, 1rem + 2.3vw, 1.875rem); line-height:1.2; letter-spacing:-.025em; font-weight:750; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; cursor:pointer; }
.long-code .code-text { font-size:clamp(1.3125rem, .9rem + 1.9vw, 1.625rem); }
.pickup-product { grid-column:2 / -1; grid-row:3; min-width:0; min-height:1.5em; color:var(--sf-text); font-size:.9375rem; font-weight:550; line-height:1.5; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.code-desc { grid-column:2; grid-row:4; min-width:0; min-height:1.5em; color:var(--sf-muted); font-size:.75rem; line-height:1.5; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
.code-source { grid-column:2; grid-row:5; display:flex; flex-wrap:wrap; align-items:flex-start; gap:2px 7px; min-width:0; min-height:1.5em; color:var(--sf-muted); font-size:.75rem; line-height:1.5; }
.picked-btn { grid-column:3; grid-row:4 / 6; align-self:end; min-height:48px; width:100%; margin:0; padding:11px 5px; display:flex; align-items:center; justify-content:center; gap:3px; border:1px solid #0764ee; border-radius:14px; background:var(--sf-blue); box-shadow:inset 0 1px 1px #ffffff3b, 0 5px 12px #0867ff15; color:white; font-size:1.0625rem; font-weight:650; line-height:1.4; }
.picked-btn.is-picked { border-color:#d5dde7; background:#e1e8f1; box-shadow:none; color:#526477; font-size:.8125rem; }
.picked-icon { font-size:.75rem; }
.code-collected .code-text { color:#63748a; }
.code-collected .cabinet-panel { background:#e8eef3; color:#55787d; border-color:#f6faff; }
.more-actions { position:absolute; top:6px; right:4px; }
.more-btn { min-width:44px; min-height:44px; margin:0; padding:10px; border:0; background:transparent; display:flex; align-items:center; justify-content:center; }
.dots { display:flex; flex-direction:column; gap:3px; }
.dot { width:3px; height:3px; border-radius:50%; background:var(--sf-muted); }
.date-more-actions { position:relative; margin:-10px -8px -10px 0; }
.action-menu { position:absolute; right:3px; top:calc(100% + 2px); z-index:20; min-width:160px; padding:5px; border-radius:17px; background:var(--sf-sheet); }
.action-menu.menu-up { top:auto; bottom:calc(100% + 2px); }
.action-item { width:100%; min-height:44px; margin:0; padding:10px 12px; display:flex; align-items:center; justify-content:flex-start; gap:10px; border:0; border-radius:11px; background:transparent; color:var(--sf-text); font-size:.9375rem; line-height:1.5; white-space:nowrap; }
.action-item:active { background:#e3eaf366; }
.action-item.delete { color:#b13e39; }
.pickup-detail-block { grid-column:1 / -1; min-width:0; }
.match-entry { display:flex; flex-wrap:wrap; align-items:center; gap:6px 9px; margin-top:7px; font-size:.75rem; line-height:1.5; }
.match-status, .conflict-label { color:#78591e; }
.match-entry-button { margin:0 0 0 auto; min-height:36px; padding:7px 10px; border:1px solid #9bb9e1; border-radius:10px; background:rgba(249,252,255,.42); color:var(--sf-blue); font-size:.75rem; line-height:1.5; }
.code-tags { display:flex; flex-wrap:wrap; gap:5px; margin-top:7px; }
.code-tag { padding:3px 8px; border-radius:7px; background:#e5edf9; color:#245dae; font-size:.6875rem; line-height:1.5; }
.code-remark { margin-top:5px; color:var(--sf-muted); font-size:.75rem; line-height:1.6; overflow-wrap:anywhere; }
.completed-toggle, .history-toggle { margin:0; padding:8px 0; min-height:44px; border:0; background:transparent; color:var(--sf-muted); font-size:.8125rem; line-height:1.5; }
.history-toggle { width:100%; }
.pickup-empty { padding:48px 16px; color:var(--sf-muted); font-size:.9375rem; line-height:1.6; text-align:center; }
.notification-sheet { background:var(--sf-sheet); box-sizing:border-box; display:flex; flex-direction:column; width:100%; max-width:640px; max-height:88vh; max-height:min(88dvh,760px); margin:0 auto; padding:0 16px calc(18px + env(safe-area-inset-bottom)); border-radius:28px 28px 0 0; color:var(--sf-text); text-align:left; }
.notification-sheet button { box-sizing:border-box; margin:0; cursor:pointer; }
.notification-handle { flex:none; width:34px; height:4px; margin:11px auto 0; border-radius:3px; background:#aab7c666; }
.notification-heading { flex:none; display:flex; justify-content:space-between; align-items:center; gap:10px; padding:13px 0; }
.notification-title-row { display:flex; flex-wrap:wrap; align-items:baseline; gap:5px 10px; }
.notification-title { font-size:1.25rem; line-height:1.5; font-weight:700; }
.notification-total { color:var(--sf-muted); font-size:.75rem; line-height:1.5; }
.notification-sheet .notification-close { flex:none; display:flex; align-items:center; justify-content:center; width:44px; height:44px; padding:0; border-radius:50%; background:rgba(255,255,255,.32); }
.notification-tabs { flex:none; display:flex; gap:3px; padding:4px; margin-bottom:12px; border-radius:16px; }
.notification-tabs button { flex:1; min-width:0; min-height:44px; padding:8px 2px; border-radius:12px; background:transparent; color:var(--sf-muted); font-size:.8125rem; line-height:1.5; }
.notification-tabs button text { margin-left:4px; font-size:.6875rem; }
.notification-tabs .selected { background:#ffffff88; color:var(--sf-blue); box-shadow:0 2px 8px #25477509; }
.notification-list { min-height:0; overflow-y:auto; overscroll-behavior:contain; padding:1px 0 4px; }
.notification-item { display:flex; align-items:flex-start; gap:9px; margin-bottom:10px; padding:14px 9px 14px 13px; border-radius:20px; }
.notification-sheet .notification-dismiss { flex:none; display:flex; align-items:center; justify-content:center; width:44px; height:44px; margin:-7px -4px 0 -5px; padding:0; border-radius:50%; background:transparent; }
.notification-icon { flex:none; display:flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:9px; background:#e0ecfa; }
.notification-icon image { width:19px; height:19px; }
.notification-review .notification-icon { background:#f7ebd5; }
.notification-error .notification-icon { background:#f8e6e5; }
.notification-content { flex:1; min-width:0; }
.notification-item-heading { display:flex; align-items:baseline; flex-wrap:wrap; gap:3px 9px; }
.notification-item-title { font-size:.9375rem; font-weight:650; line-height:1.5; overflow-wrap:anywhere; }
.notification-time { color:var(--sf-muted); font-size:.6875rem; line-height:1.5; }
.notification-body, .notification-detail { display:block; margin-top:5px; color:var(--sf-muted); font-size:.8125rem; line-height:1.7; overflow-wrap:anywhere; white-space:pre-line; }
.notification-sheet .notification-action { display:inline-flex; align-items:center; min-height:44px; padding:8px 0; background:transparent; color:var(--sf-blue); font-size:.8125rem; line-height:1.5; text-align:left; }
.notification-actions { display:flex; flex-wrap:wrap; gap:4px 14px; }
.notification-reminder-detail { margin-top:6px; padding:11px; border-radius:12px; background:#ffffff44; }
.sms-body { display:block; color:var(--sf-muted); font-size:.8125rem; line-height:1.7; overflow-wrap:anywhere; white-space:pre-wrap; }
.notification-footer { flex:none; display:flex; align-items:center; justify-content:space-between; gap:12px; padding-top:10px; }
.notification-footer>text { color:var(--sf-muted); font-size:.75rem; line-height:1.5; }
.notification-footer button { flex:none; min-height:44px; padding:10px 15px; border-radius:12px; background:#ffffff66; color:var(--sf-blue); font-size:.8125rem; line-height:1.5; }
.notification-empty { padding:36px 12px; color:var(--sf-muted); font-size:.9375rem; text-align:center; }
.ignore-dialog { width:calc(100vw - 32px); max-width:420px; padding:22px; box-sizing:border-box; border-radius:26px; color:var(--sf-text); }
.dialog-title { display:block; font-size:1.25rem; font-weight:700; line-height:1.4; }
.dialog-description { display:block; margin:14px 0; color:var(--sf-muted); font-size:.9375rem; line-height:1.65; }
.source-preview { display:block; max-height:170px; overflow:auto; padding:12px; border-radius:14px; background:#ffffff55; color:var(--sf-muted); font-size:.8125rem; line-height:1.7; overflow-wrap:anywhere; }
.ignore-label { display:block; margin:16px 0 7px; font-size:.875rem; }
.ignore-input { height:46px; padding:0 12px; border:1px solid #bac8d9; border-radius:12px; background:#ffffff55; font-size:.9375rem; }
.dialog-actions { display:flex; gap:10px; margin-top:20px; }
.dialog-actions button { flex:1; min-height:46px; margin:0; padding:11px 5px; border-radius:13px; background:#ffffff66; color:var(--sf-muted); font-size:.9375rem; line-height:1.5; }
.dialog-actions .confirm-ignore { color:#fff; background:var(--sf-blue); }
@media(max-width:374px) { .code-item { --cabinet-width:64px; --action-width:72px; padding:9px 12px 13px; column-gap:10px; border-radius:22px; }.cabinet-value { font-size:1.125rem; }.pickup-product { font-size:.875rem; }.picked-btn { min-height:46px; }.card-title { font-size:.9375rem; } }
@media(min-width:420px) { .container { padding-inline:20px; }.code-item { --cabinet-width:72px; --action-width:80px; } }
@media(prefers-reduced-motion:reduce) { .notifications-popup :deep(*) { animation-duration:0s !important; transition-duration:0s !important; } }
@media(forced-colors:active) { .picked-btn, .code-input, .match-entry-button, .family-badge { border:1px solid ButtonText; } }
.pickup-product{margin:0;padding:0;border:0;border-radius:0;background:transparent;text-align:left;}.pickup-product::after{border:0;}.pickup-product.expanded{white-space:normal;overflow-wrap:anywhere;}
.pickup-journeys{grid-column:1 / -1;min-width:0;border-top:1px solid #c5d5e7;margin-top:8px;padding-top:12px;}.pickup-journey+.pickup-journey{margin-top:15px;border-top:1px solid #c5d5e7;padding-top:12px;}.journey-parcel-label{display:block;font-size:12px;color:var(--sf-muted);margin-bottom:8px;}
.container{max-width:680px;margin-inline:auto;box-sizing:border-box;}
</style>
