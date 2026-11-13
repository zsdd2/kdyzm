package local.pickcode.assistant;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/** Pure projection and size policy shared by rendering and stale-action validation. */
public final class WidgetModel {
    public static final String COPY_ACTION = "local.pickcode.assistant.WIDGET_COPY";
    public static final String COPY_COMPONENT = "local.pickcode.assistant.WidgetCopyActivity";
    public static final String DETAIL_ACTION = "local.pickcode.assistant.WIDGET_DETAIL";
    public static final String DETAIL_COMPONENT = "local.pickcode.assistant.WidgetDetailActivity";
    public static final String PACKAGES_ACTION = "local.pickcode.assistant.WIDGET_PACKAGES";
    public static final long UNDO_WINDOW_MS = 7000;
    public enum Size {
        SMALL(1, 150, 160), LIST(2, 280, 180), LARGE(4, 350, 250);
        final int maxRows, width, height;
        Size(int rows, int width, int height) { this.maxRows = rows; this.width = width; this.height = height; }
    }
    private WidgetModel() {}

    public static List<JSONObject> pending(JSONObject snapshot) {
        Set<String> ignored = new HashSet<>();
        JSONArray ignoredItems = snapshot.optJSONArray("ignored");
        if (ignoredItems != null) for (int i = 0; i < ignoredItems.length(); i++) {
            JSONObject entry = ignoredItems.optJSONObject(i);
            if (entry != null && !entry.optString("sourceId").isEmpty()) ignored.add(entry.optString("sourceId"));
        }
        List<JSONObject> result = new ArrayList<>();
        JSONArray codes = snapshot.optJSONArray("codes");
        if (codes != null) for (int i = 0; i < codes.length(); i++) {
            JSONObject item = codes.optJSONObject(i);
            if (item != null && !item.optBoolean("isPicked") && !item.optBoolean("deleted") && !item.optBoolean("ignored")
                    && (!ignored.contains(item.optString("sourceId")) || hasOnlineMember(item)) && pendingCount(item) > 0 && !item.optString("id").isEmpty()
                    && !item.optString("code").trim().isEmpty()) result.add(item);
        }
        Collections.sort(result, (a, b) -> Long.compare(b.optLong("date"), a.optLong("date")));
        return result;
    }
    public static JSONObject pendingItem(JSONObject snapshot, String id) {
        if (id == null || id.isEmpty() || id.length() > 200) return null;
        for (JSONObject item : pending(snapshot)) if (id.equals(item.optString("id"))) return item;
        return null;
    }
    public static String codeToCopy(JSONObject snapshot, String id) {
        JSONObject item = pendingItem(snapshot, id);
        return item == null ? null : item.optString("code");
    }
    public static String pickupStation(JSONObject item, boolean privacy) {
        if (privacy) return "站点信息已隐藏";
        String station = item.optString("stationDisplayName").trim();
        if (station.isEmpty()) station = item.optString("address").trim();
        return station.isEmpty() ? item.optString("company").trim() : station;
    }
    public static String pickupCabinet(JSONObject item, boolean privacy) {
        return privacy || item.optBoolean("pickupCabinetConflict") ? "" : item.optString("pickupCabinet").trim();
    }
    public static String stationKey(JSONObject item) {
        for (String field : new String[]{"stationDisplayName", "stationCanonical", "address", "station"}) {
            String station = item.optString(field).trim();
            if (!station.isEmpty()) return station;
        }
        return "站点待补充";
    }
    public static List<String> stations(List<JSONObject> pending, String selected) {
        List<String> result = new ArrayList<>();
        result.add("");
        for (JSONObject item : pending) if (!result.contains(stationKey(item))) result.add(stationKey(item));
        return result;
    }
    public static String activeStation(List<JSONObject> pending, String selected) {
        return selected == null || stationPending(pending, selected).isEmpty() ? "" : selected;
    }
    public static List<JSONObject> stationPending(List<JSONObject> pending, String station) {
        List<JSONObject> result = new ArrayList<>();
        for (JSONObject item : pending) if (station == null || station.isEmpty() || station.equals(stationKey(item))) result.add(item);
        return result;
    }
    public static int pickupTotal(List<JSONObject> pending) {
        int result = 0;
        for (JSONObject item : pending) result += pendingCount(item);
        return result;
    }
    public static String pickupTitle(JSONObject item, boolean privacy) {
        if (privacy) return "";
        String title = item.optString("shortName").trim();
        JSONArray members = item.optJSONArray("members");
        if (title.isEmpty() && members != null) for (int i = 0; i < members.length(); i++) {
            JSONObject member = members.optJSONObject(i);
            if (member == null || member.optBoolean("picked")) continue;
            title = member.optString("shortName").trim();
            if (title.isEmpty()) title = member.optString("title").trim();
            // The shared snapshot uses this label for SMS-only members, not a product name.
            if ("待取包裹".equals(title)) title = "";
            if (!title.isEmpty()) break;
        }
        for (String field : new String[]{"productName", "parcelName", "name", "title"})
            if (title.isEmpty()) title = item.optString(field).trim();
        return title.substring(0, title.offsetByCodePoints(0, Math.min(6, title.codePointCount(0, title.length()))));
    }
    public static JSONObject pickPayload(JSONObject snapshot, String id) throws Exception {
        JSONObject item = pendingItem(snapshot, id);
        if (item == null || requiresDetail(item)) return null;
        return new JSONObject().put("id", id).put("patch", new JSONObject().put("isPicked", true));
    }
    public static int pendingCount(JSONObject item) {
        JSONArray members = item.optJSONArray("members");
        int membersPending = 0;
        if (members != null) for (int i = 0; i < members.length(); i++) {
            JSONObject member = members.optJSONObject(i);
            if (member != null && !member.optBoolean("picked")) membersPending++;
        }
        int unassignedPicked = Math.max(0, item.optInt("unassignedPickedCount"));
        return Math.max(Math.max(0, membersPending - unassignedPicked),
                item.optInt("pendingCount", item.optBoolean("isPicked") ? 0 : 1));
    }
    public static boolean requiresDetail(JSONObject item) {
        return item.optBoolean("needsPickupAssignment") || item.optInt("unassignedPickedCount") > 0 || pendingCount(item) > 1;
    }
    private static boolean hasOnlineMember(JSONObject item) {
        JSONArray members = item.optJSONArray("members");
        if (members != null) for (int i = 0; i < members.length(); i++) {
            JSONObject member = members.optJSONObject(i);
            if (member != null && !member.optString("shipmentId").isEmpty()) return true;
        }
        return false;
    }
    public static boolean acceptsCopy(String action, String component, String id) {
        return COPY_ACTION.equals(action) && COPY_COMPONENT.equals(component) && id != null && !id.isEmpty() && id.length() <= 200;
    }
    public static boolean acceptsDetail(String action, String component, String id) {
        return DETAIL_ACTION.equals(action) && DETAIL_COMPONENT.equals(component) && id != null && !id.isEmpty() && id.length() <= 200;
    }
    public static boolean acceptsPackages(String action, String component) {
        return PACKAGES_ACTION.equals(action) && DETAIL_COMPONENT.equals(component);
    }

    public static String pickupOwners(JSONObject item, boolean privacy) {
        if (privacy) return "家人信息已隐藏";
        List<String> names = new ArrayList<>();
        JSONArray members = item.optJSONArray("members");
        if (members != null) for (int i = 0; i < members.length(); i++) {
            JSONObject member = members.optJSONObject(i);
            if (member == null || member.optBoolean("picked")) continue;
            String name = member.optString("familyName").trim();
            if (name.isEmpty()) name = member.optString("familyId").isEmpty() ? "待归属" : "家人";
            if (!names.contains(name)) names.add(name);
        }
        StringBuilder owners = new StringBuilder();
        for (String name : names) { if (owners.length() > 0) owners.append('、'); owners.append(name); }
        return owners.length() == 0 ? "待归属" : owners.toString();
    }
    public static String pickupSummary(JSONObject item, boolean privacy) {
        String title = "待取包裹";
        JSONArray members = item.optJSONArray("members");
        if (!privacy && members != null) for (int i = 0; i < members.length(); i++) {
            JSONObject member = members.optJSONObject(i);
            if (member != null && !member.optBoolean("picked") && !member.optString("title").trim().isEmpty()) {
                title = member.optString("title").trim(); break;
            }
        }
        return pendingCount(item) + " 件 · " + (privacy ? "信息已隐藏" : title + (pendingCount(item) > 1 ? "等" : ""));
    }

    public static final class ReceiptShipment {
        public final String id, orderId, title, owner, platformLabel;
        public final boolean canPick;
        private ReceiptShipment(JSONObject order, JSONObject ship, boolean privacy) {
            RoadOrder display = new RoadOrder(order, "已送达", privacy);
            id = ship.optString("id"); orderId = order.optString("id");
            title = display.title; platformLabel = display.platformLabel;
            owner = privacy || ship.optString("familyName").trim().isEmpty() ? display.owner : ship.optString("familyName").trim();
            canPick = ship.optBoolean("canPick");
        }
    }
    public static List<ReceiptShipment> receiptShipments(JSONObject snapshot, boolean privacy) {
        List<ReceiptShipment> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        JSONArray orders = snapshot.optJSONArray("packages");
        if (orders != null) for (int i = 0; i < orders.length(); i++) {
            JSONObject order = orders.optJSONObject(i);
            if (roadUnavailable(order) || order.optString("id").isEmpty() || "picked".equals(order.optString("status"))
                    || archiveFromPackageDate(order, System.currentTimeMillis())) continue;
            JSONArray shipments = order.optJSONArray("shipments");
            if (shipments != null) for (int j = 0; j < shipments.length(); j++) {
                JSONObject ship = shipments.optJSONObject(j);
                if (!roadUnavailable(ship) && ship.optBoolean("needsReceiptConfirmation") && "signed".equals(ship.optString("status"))
                        && !ship.optString("id").isEmpty() && seen.add(ship.optString("id")))
                    result.add(new ReceiptShipment(order, ship, privacy));
            }
        }
        return result;
    }
    public static JSONObject receiptPayload(JSONObject snapshot, String id) throws Exception {
        if (id == null || id.isEmpty() || id.length() > 200) return null;
        for (ReceiptShipment item : receiptShipments(snapshot, false)) if (id.equals(item.id) && item.canPick)
            return new JSONObject().put("orderId", item.orderId).put("shipmentIds", new JSONArray().put(id)).put("picked", true);
        return null;
    }
    private static JSONObject shipment(JSONObject snapshot, String orderId, String id) {
        JSONArray orders = snapshot.optJSONArray("packages");
        if (orders != null) for (int i = 0; i < orders.length(); i++) {
            JSONObject order = orders.optJSONObject(i);
            if (order == null || !orderId.equals(order.optString("id")) || roadUnavailable(order)
                    || archiveFromPackageDate(order, System.currentTimeMillis())) continue;
            JSONArray ships = order.optJSONArray("shipments");
            if (ships != null) for (int j = 0; j < ships.length(); j++) {
                JSONObject ship = ships.optJSONObject(j);
                if (ship != null && id.equals(ship.optString("id"))) return ship;
            }
        }
        return null;
    }
    public static JSONObject receiptUndoRecord(JSONObject before, JSONObject after, String id, long now) throws Exception {
        JSONObject payload = receiptPayload(before, id);
        if (payload == null) return null;
        JSONObject ship = shipment(after, payload.optString("orderId"), id);
        if (ship == null || !ship.optBoolean("picked") || !ship.optBoolean("canPick") || ship.optBoolean("hidden")) return null;
        return new JSONObject().put("kind", "receipt").put("id", id).put("orderId", payload.optString("orderId"))
                .put("at", now).put("fingerprint", ship.toString());
    }

    public static final class RoadOrder {
        public final String id, status, title, owner, platformLabel, platform;
        private RoadOrder(JSONObject order, String status, boolean privacy) {
            id = order.optString("id"); this.status = status;
            String product = order.optString("title").trim();
            if (product.isEmpty()) product = "线上包裹";
            title = privacy ? "包裹信息已隐藏" : product.substring(0, product.offsetByCodePoints(0, Math.min(10, product.codePointCount(0, product.length()))));
            platform = order.optString("platform");
            platformLabel = privacy ? "" : "taobao".equals(platform) ? "淘" : "pdd".equals(platform) ? "拼" : "jd".equals(platform) ? "京" : "";
            owner = privacy ? "••" : order.optString("familyName").trim().isEmpty() ? "待归属" : order.optString("familyName");
        }
    }
    public static String platformFilter(String value) {
        return "taobao".equals(value) || "jd".equals(value) || "pdd".equals(value) ? value : "";
    }
    public static List<RoadOrder> platformOrders(List<RoadOrder> road, String platform) {
        List<RoadOrder> result = new ArrayList<>();
        for (RoadOrder order : road) if (platform == null || platform.isEmpty() || platform.equals(order.platform)) result.add(order);
        return result;
    }
    /** One row per active order still awaiting shipment or with an uncoded parcel in transit. */
    public static List<RoadOrder> roadOrders(JSONObject snapshot, boolean privacy) {
        return roadOrders(snapshot, privacy, System.currentTimeMillis());
    }
    static List<RoadOrder> roadOrders(JSONObject snapshot, boolean privacy, long now) {
        List<RoadOrder> result = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        JSONArray orders = snapshot.optJSONArray("packages");
        if (orders != null) for (int i = 0; i < orders.length(); i++) {
            JSONObject order = orders.optJSONObject(i);
            if (roadUnavailable(order) || "manual".equals(order.optString("source"))
                    || "picked".equals(order.optString("status")) || order.optString("id").isEmpty()
                    || archiveFromPackageDate(order, now)) continue;
            String trade = (order.optString("tradeStatus") + " " + order.optString("orderStatus")).toLowerCase(java.util.Locale.ROOT);
            if (trade.matches(".*(cancel|closed|close|failed|failure|交易关闭|已关闭|已取消|已撤销|交易取消|退款成功|已退款).*")) continue;
            String refund = order.optString("refundStatus").toLowerCase(java.util.Locale.ROOT);
            if ((trade + " " + refund).matches(".*(refunded|refund_success|refund_completed|refund_finished|退款成功|退款完成|已退款).*")) continue;
            JSONArray shipments = order.optJSONArray("shipments");
            boolean transit = false, unknown = false, waiting = false;
            String warehouse = ".*(进入.{0,20}仓库|仓库处理中|准备出库|等待出库|正在出库|(?:等待|待)[^，,。；;]{0,12}揽收|正在打包|打包完成|打印完成).*";
            if (shipments != null) for (int j = 0; j < shipments.length(); j++) {
                JSONObject ship = shipments.optJSONObject(j);
                if (roadUnavailable(ship) || ship.optBoolean("needsReceiptConfirmation") || "signed".equals(ship.optString("status")) || "picked".equals(ship.optString("status"))) continue;
                // A resolved pickup lives in the upper zone; another parcel in the same order may still be on the road.
                if (!ship.optString("displayPickupCode").trim().isEmpty() || !ship.optString("pickupCode").trim().isEmpty()) continue;
                String status = ship.optString("status");
                if ("returning".equals(status) || "returned".equals(status)) continue;
                transit |= "transit".equals(status);
                boolean unknownShipment = (status.isEmpty() || "unknown".equals(status)) && ship.optLong("arrivalAt") <= 0 && ship.optLong("smsArrivalAt") <= 0;
                unknown |= unknownShipment;
                JSONObject view = ship.optJSONObject("platformView");
                if (view != null) {
                    waiting |= unknownShipment && view.optBoolean("awaitingShipment");
                    continue;
                }
                JSONArray events = ship.optJSONArray("logisticsEvents");
                if (unknownShipment && "jd".equals(order.optString("platform")) && events != null) for (int k = 0; k < events.length(); k++) {
                    JSONObject event = events.optJSONObject(k);
                    if (event != null && event.optString("description").matches(warehouse)) waiting = true;
                }
            }
            if (!transit && (unknown || shipments == null || shipments.length() == 0)) {
                waiting |= trade.matches(".*(wait_seller_send_goods|待发货|等待发货|等待卖家发货|卖家待发货|等待出库|正在出库).*")
                        || "jd".equals(order.optString("platform")) && trade.matches(warehouse);
                transit = !waiting && ("transit".equals(order.optString("status"))
                        || !"jd".equals(order.optString("platform")) && trade.matches(".*(wait_buyer_confirm_goods|待收货|等待收货|等待买家收货).*"));
            }
            if ((transit || waiting) && seen.add(order.optString("id"))) result.add(new RoadOrder(order, transit ? "运输中" : "待发货", privacy));
        }
        return result;
    }
    private static boolean roadUnavailable(JSONObject item) {
        return item == null || item.optBoolean("hidden") || item.optBoolean("deleted") || item.optBoolean("archived")
                || item.optBoolean("picked") || item.optBoolean("isPicked");
    }
    /** Mirrors the China calendar 30-day archive fallback used by package presentation. */
    private static boolean archiveFromPackageDate(JSONObject order, long now) {
        JSONObject retention = order.optJSONObject("retention");
        if (retention != null && retention.optInt("version") == 1 && retention.has("archived")) return retention.optBoolean("archived");
        Long day = dateOnlyDay(order.optString("dateOverride"));
        if (day == null && ("manual".equals(order.optString("source")) || "platform".equals(order.optString("orderDateSource"))
                || "manual".equals(order.optString("orderDateSource")))) day = packageDateDay(order.opt("orderDate"));
        if (day == null) day = packageDateDay(order.opt("firstSeenAt"));
        if (day == null) return false;
        Long restoredDay = dateOnlyDay(order.optString("archiveRestoredAnchor"));
        if (day.equals(restoredDay) && order.optLong("archiveRestoredAt") > 0) return false;
        return localDay(now) - day > 30;
    }
    private static Long packageDateDay(Object value) {
        if (value instanceof Number) {
            double timestamp = ((Number) value).doubleValue();
            if (Double.isNaN(timestamp) || Double.isInfinite(timestamp) || timestamp <= 0 || timestamp > 8640000000000000d) return null;
            return localDay(((Number) value).longValue());
        }
        return value instanceof String ? dateOnlyDay((String) value) : null;
    }
    private static Long dateOnlyDay(String value) {
        if (!value.matches("\\d{4}-\\d{2}-\\d{2}")) return null;
        int year = Integer.parseInt(value.substring(0, 4));
        if (year < 2000 || year > 2100) return null;
        try {
            return utcDay(year, Integer.parseInt(value.substring(5, 7)) - 1, Integer.parseInt(value.substring(8, 10)));
        } catch (IllegalArgumentException invalidDate) { return null; }
    }
    private static long localDay(long timestamp) {
        java.util.Calendar date = new java.util.GregorianCalendar(java.util.TimeZone.getTimeZone("GMT+08:00"));
        date.setTimeInMillis(timestamp);
        return utcDay(date.get(java.util.Calendar.YEAR), date.get(java.util.Calendar.MONTH), date.get(java.util.Calendar.DAY_OF_MONTH));
    }
    private static long utcDay(int year, int month, int day) {
        java.util.Calendar date = new java.util.GregorianCalendar(java.util.TimeZone.getTimeZone("UTC"));
        date.clear(); date.setLenient(false); date.set(year, month, day);
        return date.getTimeInMillis() / 86400000L;
    }

    public static JSONArray singlePendingMembers(JSONObject item) {
        JSONArray result = new JSONArray(), members = item.optJSONArray("members");
        if (members != null) for (int i = 0; i < members.length(); i++) {
            JSONObject member = members.optJSONObject(i);
            if (member != null && !member.optBoolean("picked") && !member.optString("id").isEmpty()) result.put(member.optString("id"));
        }
        return result;
    }
    public static boolean largeRequiresDetail(JSONObject item) {
        JSONArray members = item.optJSONArray("members");
        return requiresDetail(item) || item.optInt("totalCount") > 1 || (members != null && members.length() > 1);
    }
    public static JSONObject undoRecord(JSONObject before, JSONObject after, long now) throws Exception {
        if (before == null || after == null || largeRequiresDetail(before) || !after.optBoolean("isPicked")) return null;
        JSONArray members = singlePendingMembers(before);
        if (members.length() != 1) return null;
        return new JSONObject().put("id", before.optString("id")).put("memberIds", members).put("at", now)
                .put("fingerprint", after.toString());
    }
    public static JSONObject undoPayload(JSONObject snapshot, JSONObject record, long now) throws Exception {
        if (record == null || now < record.optLong("at") || now - record.optLong("at") >= UNDO_WINDOW_MS) return null;
        if ("receipt".equals(record.optString("kind"))) {
            JSONObject ship = shipment(snapshot, record.optString("orderId"), record.optString("id"));
            if (ship == null || !ship.optBoolean("picked") || !ship.optBoolean("canPick") || ship.optBoolean("hidden")
                    || ship.optBoolean("deleted") || ship.optBoolean("archived")
                    || !"signed".equals(ship.optString("status")) || !record.optString("fingerprint").equals(ship.toString())) return null;
            return new JSONObject().put("orderId", record.optString("orderId"))
                    .put("shipmentIds", new JSONArray().put(record.optString("id"))).put("picked", false);
        }
        JSONArray codes = snapshot.optJSONArray("codes");
        if (codes != null) for (int i = 0; i < codes.length(); i++) {
            JSONObject item = codes.optJSONObject(i);
            if (item != null && record.optString("id").equals(item.optString("id")) && !item.optBoolean("deleted")
                    && !item.optBoolean("hidden") && item.optBoolean("isPicked") && !item.optBoolean("needsPickupAssignment")
                    && record.optString("fingerprint").equals(item.toString()))
                return new JSONObject().put("id", record.optString("id")).put("memberIds", record.getJSONArray("memberIds")).put("picked", false);
        }
        return null;
    }

    public static final class LargeLayout {
        public final int pickupRows, roadRows, pickupHeight, roadHeight, headerHeight, rowHeight, roadRowHeight, actionWidth, ownerWidth;
        public final float codeSp, textSp;
        public final boolean showOwners;
        private LargeLayout(int pickupRows, int roadRows, int pickupHeight, int roadHeight, int headerHeight,
                            int rowHeight, int roadRowHeight, int actionWidth, int ownerWidth, float codeSp, float textSp, boolean showOwners) {
            this.pickupRows = pickupRows; this.roadRows = roadRows; this.pickupHeight = pickupHeight; this.roadHeight = roadHeight;
            this.headerHeight = headerHeight; this.rowHeight = rowHeight; this.roadRowHeight = roadRowHeight;
            this.actionWidth = actionWidth; this.ownerWidth = ownerWidth; this.codeSp = codeSp; this.textSp = textSp; this.showOwners = showOwners;
        }
    }
    public static LargeLayout largeLayout(int availableWidth, int availableHeight, float fontScale) {
        int width = availableWidth > 0 ? availableWidth : Size.LARGE.width;
        int height = availableHeight > 0 ? availableHeight : Size.LARGE.height;
        float scale = Float.isNaN(fontScale) || Float.isInfinite(fontScale) || fontScale <= 0 ? 1 : Math.max(1, fontScale);
        // Match the XML weights and approved A design at every launcher-provided size.
        int road = Math.round(height * 94f / 250f);
        float text = Math.min(11 * scale, width < 320 ? 10 : 11);
        int header = 24;
        int roadRow = (int) Math.ceil(text * 1.4f) + 4;
        int pickup = Math.max(0, height - road);
        int action = Math.max(57, (int) Math.ceil(text * 2 + 25));
        boolean owners = width >= 240;
        int owner = owners ? width < 320 ? 60 : 76 : 0;
        int codeWidth = Math.max(1, width - 24 - action - owner - (owners ? 16 : 8) - 16);
        float code = Math.min(24 * scale, codeWidth / (12 * .58f));
        int row = 49;
        int rows = width < 240 || code < 12 ? 0 : Math.min(2, Math.max(0, pickup - 28 - header) / row);
        int roadRows = width < 220 ? 0 : Math.min(2, Math.max(0, road - 25 - (header - 4)) / roadRow);
        return new LargeLayout(rows, roadRows, pickup, road, header, row, roadRow, action, owner, Math.max(12, code), text, owners);
    }
    public static boolean ownedProvider(int widgetId, String providerPackage, String providerClass, String expectedProvider) {
        if (widgetId <= 0 || !"local.pickcode.assistant".equals(providerPackage)) return false;
        boolean known = "local.pickcode.assistant.SmallWidgetProvider".equals(providerClass)
                || "local.pickcode.assistant.ListWidgetProvider".equals(providerClass)
                || "local.pickcode.assistant.LargeWidgetProvider".equals(providerClass);
        return known && (expectedProvider == null || expectedProvider.equals(providerClass));
    }

    public static final class Layout {
        public final boolean compact, showDetails;
        public final int capacity, rowHeight, headerHeight, footerHeight, chromeHeight, actionWidth, codeLines;
        public final float codeSp;
        private Layout(boolean compact, boolean details, int capacity, int row, int header, int footer,
                       int chrome, int actionWidth, int lines, float codeSp) {
            this.compact = compact; this.showDetails = details; this.capacity = capacity; this.rowHeight = row;
            this.headerHeight = header; this.footerHeight = footer; this.chromeHeight = chrome;
            this.actionWidth = actionWidth; this.codeLines = lines; this.codeSp = codeSp;
        }
    }
    public static Layout layout(Size size, int availableWidth, int availableHeight, float fontScale) {
        return layout(size, availableWidth, availableHeight, fontScale, false);
    }
    public static Layout layout(Size size, int availableWidth, int availableHeight, float fontScale, boolean hasCabinet) {
        int width = availableWidth > 0 ? availableWidth : size.width;
        int height = availableHeight > 0 ? availableHeight : size.height;
        float scale = Float.isNaN(fontScale) || Float.isInfinite(fontScale) || fontScale <= 0 ? 1f : Math.max(1f, fontScale);
        boolean compact = width < 220;
        int header = (int) Math.ceil(14 * scale * 1.35f) + 4;
        int footer = Math.max(28, (int) Math.ceil(12 * scale * 1.35f) + 8);
        int chrome = 16 + header + footer + 8; // Padding plus safety slack, not available for rows.
        int actionWidth = Math.max(44, (int) Math.ceil(24 * scale) + 14);
        int codeWidth = Math.max(24, width - 16 - (compact ? 0 : actionWidth + 8) - (hasCabinet ? 70 : 0));
        float codeSp = Math.max(hasCabinet ? 12f / scale : 12f,
                Math.min(compact ? 15f : 17f, codeWidth / (12 * .68f * scale)));
        int lines = 12 * codeSp * scale * .68f > codeWidth + .5f ? 2 : 1;
        int codeHeight = (int) Math.ceil(codeSp * scale * 1.35f) * lines;
        int buttonHeight = Math.max(30, (int) Math.ceil(12 * scale * 1.35f) + 8);
        int primaryHeight = compact ? codeHeight + buttonHeight : Math.max(codeHeight + 4, buttonHeight);
        int detailHeight = (int) Math.ceil(11 * scale * 1.35f);
        int row = primaryHeight + (compact && hasCabinet ? 0 : detailHeight) + 7;
        int space = Math.max(0, height - chrome);
        boolean details = !(compact && hasCabinet);
        if (space < row) { row = primaryHeight + 7; details = false; }
        int capacity = Math.min(size.maxRows, space / row);
        return new Layout(compact, details, capacity, row, header, footer, chrome, actionWidth, lines, codeSp);
    }
}
