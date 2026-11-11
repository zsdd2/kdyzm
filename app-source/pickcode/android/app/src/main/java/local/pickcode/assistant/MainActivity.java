package local.pickcode.assistant;

import android.Manifest;
import android.app.Activity;
import android.app.ActivityManager;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.PersistableBundle;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import androidx.webkit.WebViewAssetLoader;
import org.json.JSONObject;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.util.Arrays;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private static final String START = "https://appassets.androidplatform.net/assets/app/index.html";
    private static final int SMS_PERMISSION = 410;
    private static final int PAIRING_SCAN = 543;
    private static final int PICKUP_SAVE = 544;
    private static final Set<String> CORE_ACTIONS = new HashSet<>(Arrays.asList("snapshot", "migrate", "add", "update", "remove",
            "ignore", "restore", "saveRule", "deleteRule", "toggleRule", "settings", "clearTag", "migratePackages", "savePackage",
            "removePackage", "restorePackage", "pickMembers", "assignPickedMembers", "pickShipments", "resumeAutoPickup", "setOrderDate", "linkSource", "unlinkSource", "resolveCode", "setStation", "resetStation", "refreshStations",
            "saveLogisticsRule", "toggleLogisticsRule", "deleteLogisticsRule", "resetLogisticsRules", "testLogisticsRule"));
    private static final Set<String> ONLINE_ACTIONS = new HashSet<>(Arrays.asList("bindOnline", "syncOnline", "refreshOrder", "unbindOnline", "previewPairing", "stationProposal"));
    private static final Set<String> UPDATE_ACTIONS = new HashSet<>(Arrays.asList("appUpdateStatus", "checkAppUpdate",
            "downloadAppUpdate", "cancelAppUpdate", "installAppUpdate"));
    private WebView webView;
    private volatile boolean trustedPage;
    private String permissionRequestId;
    private String pairingScanRequestId;
    private PickupExport pickupExport;
    private int nextPickupSaveRequestCode = PICKUP_SAVE;
    private static final class PickupExport {
        final String id;
        final int requestCode;
        File file;
        boolean awaitingDocument;
        PickupExport(String id, int requestCode) { this.id = id; this.requestCode = requestCode; }
    }
    private String pendingWidgetCopyId;
    private String pendingPickupId;
    private boolean pendingPackages;
    private int pendingWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
    private boolean resumed, widgetCopyInFlight, pageReady, onlineSyncInFlight, localSnapshotShown, foregroundStarted;
    private boolean displayRefreshInFlight;
    private final Object passiveRequests = new Object();
    private PassiveSync passiveSync;
    private int passiveBatches;
    private static final class PassiveSync { final ArrayList<String> replies = new ArrayList<>(); }
    private long lastOnlineAttempt;
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final ExecutorService onlineNetwork = Executors.newSingleThreadExecutor();
    private final ExecutorService pickupImages = Executors.newSingleThreadExecutor();
    private final Handler foreground = new Handler(Looper.getMainLooper());
    private final Runnable pickupSaveTimeout = () -> {
        if (pickupExport != null) {
            finishActivity(pickupExport.requestCode);
            finishPickupExport(pickupExport, null, "保存等待超时，请重新选择保存位置", false);
        }
    };
    private final Runnable onlinePoll = new Runnable() {
        @Override public void run() {
            if (!resumed || !localSnapshotShown || isDestroyed()) return;
            if (!onlineSyncInFlight && SecretStore.online(MainActivity.this).configured()) {
                onlineSyncInFlight = true;
                lastOnlineAttempt = android.os.SystemClock.elapsedRealtime();
                notifySyncStatus();
                syncPassive(null);
            }
            foreground.postDelayed(this, 60_000);
        }
    };

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState == null) consumeWidgetIntent(getIntent());
        else {
            pendingWidgetCopyId = savedInstanceState.getString("pendingWidgetCopyId");
            pendingWidgetId = savedInstanceState.getInt("pendingWidgetId", AppWidgetManager.INVALID_APPWIDGET_ID);
            pendingPickupId = savedInstanceState.getString("pendingPickupId");
            pendingPackages = savedInstanceState.getBoolean("pendingPackages");
            nextPickupSaveRequestCode = Math.max(PICKUP_SAVE, savedInstanceState.getInt("nextPickupSaveRequestCode", PICKUP_SAVE));
        }
        webView = new WebView(this);
        FrameLayout container = new FrameLayout(this);
        container.addView(webView, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(container);
        webView.setBackgroundColor(0xffe8edf3);
        if (Build.VERSION.SDK_INT >= 35) container.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return insets;
        });
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // Keeps the original uni-app records for one-time additive migration.
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return !request.isForMainFrame() || !trustedDocument(request.getUrl());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return !trustedDocument(Uri.parse(url)); }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (pickupExport != null) {
                    finishActivity(pickupExport.requestCode);
                    finishPickupExport(pickupExport, imageResult("cancelled"), null, false);
                }
                pageReady = false;
                localSnapshotShown = false;
                foregroundStarted = false;
                trustedPage = trustedDocument(Uri.parse(url));
                if (!trustedPage) view.stopLoading();
            }
            @Override public void onPageFinished(WebView view, String url) {
                pageReady = trustedDocument(Uri.parse(url));
                openPendingPickup();
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // CSP confines these browser requests to images and checks redirect destinations.
                if (trustedPage && !request.isForMainFrame() && "GET".equals(request.getMethod()) && TrustedOrigin.productImage(uri.toString())) return null;
                if (!trustedAsset(uri) || (request.isForMainFrame() && !trustedDocument(uri))) return blocked();
                WebResourceResponse response = assets.shouldInterceptRequest(uri);
                if (response == null) return blocked();
                HashMap<String, String> headers = new HashMap<>();
                headers.put("Content-Security-Policy", "default-src 'self' data: blob:; img-src 'self' data: blob: " + TrustedOrigin.PRODUCT_IMAGE_SOURCES + "; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'");
                headers.put("Referrer-Policy", "no-referrer");
                headers.put("X-Content-Type-Options", "nosniff");
                response.setResponseHeaders(headers);
                return response;
            }
        });
        webView.addJavascriptInterface(new Bridge(), "PickCodeNative");
        webView.loadUrl(pendingPackages ? START + "#/pages/packages/index" : pendingPickupId == null ? START
                : START + "#/pages/index/index?pickupId=" + Uri.encode(pendingPickupId));
    }

    static boolean trustedAsset(Uri uri) {
        return TrustedOrigin.asset(uri.toString());
    }
    static boolean trustedDocument(Uri uri) { return TrustedOrigin.document(uri.toString()); }
    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }

    private final class Bridge {
        @JavascriptInterface public void request(String requestId, String raw) {
            if (!trustedPage || requestId == null || requestId.length() > 100 || raw == null || raw.length() > 2_000_000) return;
            try {
                JSONObject request = new JSONObject(raw);
                String action = request.getString("action");
                JSONObject payload = request.optJSONObject("payload");
                JSONObject data = payload == null ? new JSONObject() : payload;
                if (UPDATE_ACTIONS.contains(action)) {
                    if ((request.has("payload") && payload == null && !request.isNull("payload")) || data.length() != 0)
                        throw new IllegalArgumentException("更新操作不接受地址或文件参数");
                    AppUpdateManager updates = AppUpdateManager.get(MainActivity.this);
                    JSONObject result;
                    switch (action) {
                        case "checkAppUpdate": result = updates.check(); break;
                        case "downloadAppUpdate": result = updates.download(); break;
                        case "cancelAppUpdate": result = updates.cancel(); break;
                        case "installAppUpdate": result = updates.install(MainActivity.this); break;
                        default: result = updates.status();
                    }
                    reply(requestId, result, null);
                    return;
                }
                if ("requestSmsPermission".equals(action)) { runOnUiThread(() -> askSms(requestId)); return; }
                if ("snapshotVisible".equals(action)) { runOnUiThread(() -> { localSnapshotDelivered(); reply(requestId, new JSONObject(), null); }); return; }
                if ("scanPairing".equals(action)) { runOnUiThread(() -> scanPairing(requestId, data)); return; }
                if ("cancelPairingScan".equals(action)) { runOnUiThread(() -> { finishActivity(PAIRING_SCAN); reply(requestId, new JSONObject(), null); }); return; }
                if ("openSystemSettings".equals(action)) { runOnUiThread(() -> openSettings(requestId, data)); return; }
                if ("pinWidget".equals(action)) { runOnUiThread(() -> pinWidget(requestId, data)); return; }
                if ("openShoppingApp".equals(action)) { runOnUiThread(() -> openShoppingApp(requestId, data)); return; }
                if ("dialPhone".equals(action)) { runOnUiThread(() -> dialPhone(requestId, data)); return; }
                if ("savePickupImage".equals(action) || "sharePickupImage".equals(action)) {
                    runOnUiThread(() -> exportPickupImage(requestId, data, "savePickupImage".equals(action))); return;
                }
                if (("snapshot".equals(action) || "overview".equals(action) || "onlineStatus".equals(action))
                        && AssistantStore.get(MainActivity.this).hasDisplaySnapshot()) {
                    try { reply(requestId, execute(action, data), null); }
                    catch (Exception failure) { reply(requestId, null, safeError(action, failure)); }
                    if (data.optBoolean("refresh", true)) runOnUiThread(MainActivity.this::refreshDisplayedData);
                    return;
                }
                if ("syncOnline".equals(action) && !data.optBoolean("force")) { syncPassive(requestId); return; }
                if (ONLINE_ACTIONS.contains(action)) {
                    synchronized (passiveRequests) {
                        // A binding or explicit action is a queue boundary; later reads must not join an older session.
                        passiveSync = null;
                        onlineNetwork.execute(() -> {
                            try { reply(requestId, execute(action, data), null); }
                            catch (Exception failure) { reply(requestId, null, safeError(action, failure)); }
                        });
                    }
                    return;
                }
                ("generateTemplate".equals(action) || "aiChannels".equals(action) || "configureAiOptimization".equals(action) || "approveAiProposal".equals(action) ? network : PickCodeApplication.IO).execute(() -> {
                    try { reply(requestId, execute(action, data), null); }
                    catch (Exception failure) { reply(requestId, null, safeError(action, failure)); }
                });
            } catch (Exception malformed) { reply(requestId, null, "请求格式不正确"); }
        }
    }

    private void syncPassive(String requestId) {
        synchronized (passiveRequests) {
            if (passiveSync != null) {
                if (requestId != null) passiveSync.replies.add(requestId);
                return;
            }
            PassiveSync batch = new PassiveSync();
            if (requestId != null) batch.replies.add(requestId);
            passiveSync = batch;
            passiveBatches++;
            runOnUiThread(() -> { onlineSyncInFlight = true; notifySyncStatus(); });
            onlineNetwork.execute(() -> {
                JSONObject result = null; String error = null;
                try { result = OnlineSyncManager.get(this).sync(false); }
                catch (Exception failure) { error = safeError("syncOnline", failure); }
                synchronized (passiveRequests) {
                    for (String id : batch.replies) reply(id, result, error);
                    if (passiveSync == batch) passiveSync = null;
                    boolean syncing = --passiveBatches > 0;
                    runOnUiThread(() -> { onlineSyncInFlight = syncing; notifySyncStatus(); notifyRefresh(); });
                }
            });
        }
    }

    private void refreshDisplayedData() {
        if (!resumed || !localSnapshotShown || displayRefreshInFlight || isDestroyed()
                || !AssistantStore.get(this).displayNeedsRefresh()) return;
        displayRefreshInFlight = true;
        PickCodeApplication.IO.execute(() -> {
            boolean refreshed = false;
            try { AssistantStore.get(this).snapshot(); refreshed = true; }
            catch (Exception ignored) { /* A failed refresh keeps the last committed display. */ }
            boolean changed = refreshed;
            runOnUiThread(() -> { displayRefreshInFlight = false; if (changed) notifyRefresh(); });
        });
    }

    private JSONObject execute(String action, JSONObject payload) throws Exception {
        if ("snapshot".equals(action)) return AssistantStore.get(this).displaySnapshot();
        if ("overview".equals(action)) return AssistantStore.get(this).overview();
        if ("status".equals(action)) return status();
        if ("onlineStatus".equals(action)) return OnlineSyncManager.get(this).status();
        if ("aiChannels".equals(action)) {
            OnlineSyncManager online = OnlineSyncManager.get(this); String session = online.aiSessionKey();
            JSONObject result = online.aiChannels();
            SmsAiManager.get(this).observeService(result.getJSONObject("service"), session);
            return result;
        }
        if ("aiOptimizationStatus".equals(action)) return SmsAiManager.get(this).status();
        if ("configureAiOptimization".equals(action)) return SmsAiManager.get(this).configure(payload);
        if ("ignoreAiProposal".equals(action)) return SmsAiManager.get(this).ignore(payload.optString("id"));
        if ("analyzeAiProposals".equals(action)) return SmsAiManager.get(this).analyzeNow();
        if ("approveAiProposal".equals(action)) {
            JSONObject result = SmsAiManager.get(this).approve(payload.optString("id"));
            WidgetRenderer.updateAll(this); runOnUiThread(this::notifyRefresh); return result;
        }
        if ("previewPairing".equals(action)) {
            String baseUrl = OnlineEndpoint.normalize(payload.optString("baseUrl"), BuildConfig.DEBUG);
            String code = payload.optString("code").trim();
            if (!OnlineEndpoint.validCode(code)) throw new IllegalArgumentException("请填写后台生成的一次性授权码");
            return new OnlineClient(baseUrl, null, BuildConfig.DEBUG).request("POST", "/v1/pairing-codes/preview", new JSONObject().put("code", code), null).body;
        }
        if ("bindOnline".equals(action)) return OnlineSyncManager.get(this).bind(payload.optString("baseUrl"), payload.optString("code"));
        if ("syncOnline".equals(action)) return OnlineSyncManager.get(this).sync(payload.optBoolean("force"));
        if ("refreshOrder".equals(action)) return OnlineSyncManager.get(this).refreshOrder(payload.optString("id"));
        if ("stationProposal".equals(action)) return OnlineSyncManager.get(this).proposeStation(payload);
        if ("unbindOnline".equals(action)) return OnlineSyncManager.get(this).unbind();
        if ("scan".equals(action)) return SmsScanner.scan(this);
        if ("setAiKey".equals(action)) {
            throw new OnlineClient.Failure("ai_legacy_disabled", "请在后台配置默认AI服务；手机不再保存或使用本机AI密钥");
        }
        if ("generateTemplate".equals(action)) {
            String channel = payload.optString("channelId"), sample = payload.optString("sample"), expected = payload.optString("expectedCode");
            if ("legacy-deepseek".equals(channel)) throw new OnlineClient.Failure("ai_legacy_disabled", "请统一使用后台默认AI服务；手机原有密钥不会上传或使用");
            if (!channel.isEmpty() && !channel.matches("[A-Za-z0-9_-]{1,128}")) throw new IllegalArgumentException("请使用后台默认AI服务");
            AiTemplatePrivacy.Prepared prepared = AiTemplatePrivacy.prepare(sample, expected);
            OnlineSyncManager online = OnlineSyncManager.get(this); String session = online.aiSessionKey();
            JSONObject generated = online.generateAiTemplate(prepared.request(channel));
            JSONObject result = SmsAiManager.get(this).validate(generated.getJSONObject("candidate"), sample, prepared.actualCode).put("origin", "ai");
            if (!session.equals(online.aiSessionKey())) throw new OnlineClient.Failure("ai_session_changed", "后台绑定已变化，请重新准备建议");
            return result;
        }
        if (!CORE_ACTIONS.contains(action)) throw new IllegalArgumentException("不支持此操作");
        JSONObject result = AssistantStore.get(this).dispatch(action, payload);
        if ("settings".equals(action)) {
            ScanScheduler.configure(this, result.getJSONObject("settings").optBoolean("autoScan"));
        }
        if ("settings".equals(action) || "linkSource".equals(action) || "unlinkSource".equals(action)
                || "setStation".equals(action) || "resetStation".equals(action) || "remove".equals(action) || "ignore".equals(action))
            OnlineSyncScheduler.maybeEnhance(this, result);
        if (!"snapshot".equals(action)) WidgetRenderer.updateAll(this);
        if ("update".equals(action) || "pickMembers".equals(action) || "assignPickedMembers".equals(action)
                || "pickShipments".equals(action) || "resumeAutoPickup".equals(action) || "setOrderDate".equals(action)
                || "removePackage".equals(action) || "restorePackage".equals(action))
            OnlineSyncScheduler.refresh(this, false);
        return result;
    }

    private JSONObject status() throws Exception {
        JSONObject snapshot = AssistantStore.get(this).snapshot();
        PowerManager power = (PowerManager) getSystemService(POWER_SERVICE);
        ActivityManager activity = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        boolean restricted = (Build.VERSION.SDK_INT >= 28 && activity.isBackgroundRestricted())
                || !power.isIgnoringBatteryOptimizations(getPackageName());
        JSONObject ai = SmsAiManager.get(this).status();
        JSONObject service = ai.optJSONObject("service");
        return new JSONObject().put("native", true).put("smsPermission", SmsScanner.allowed(this))
                .put("autoScan", snapshot.getJSONObject("settings").optBoolean("autoScan"))
                .put("lastScanAt", snapshot.optLong("lastScanAt")).put("batteryRestricted", restricted)
                .put("widgetSupported", Build.VERSION.SDK_INT >= 26 && AppWidgetManager.getInstance(this).isRequestPinAppWidgetSupported())
                // This is the last known backend configuration, not a live connectivity check.
                .put("aiConfigured", service != null && service.optBoolean("available")).put("aiModel", service == null ? "" : service.optString("model"))
                .put("aiMode", "backend_default").put("aiServiceCached", service != null).put("aiServiceCheckedAt", ai.optLong("serviceCheckedAt"));
    }

    private void askSms(String id) {
        if (SmsScanner.allowed(this)) { asyncStatus(id); return; }
        if (permissionRequestId != null) { reply(id, null, "已有权限请求，请先完成系统提示"); return; }
        permissionRequestId = id;
        requestPermissions(new String[]{Manifest.permission.READ_SMS}, SMS_PERMISSION);
    }
    private void scanPairing(String id, JSONObject payload) {
        String source = payload.optString("source");
        if (!("camera".equals(source) || "image".equals(source))) { reply(id, null, "不支持这种识别来源"); return; }
        if (pairingScanRequestId != null) { reply(id, null, "已有识别正在进行，请先完成或取消"); return; }
        try {
            pairingScanRequestId = id;
            startActivityForResult(new Intent(this, PairingScanActivity.class).putExtra("source", source), PAIRING_SCAN);
        } catch (RuntimeException unavailable) { pairingScanRequestId = null; reply(id, null, "识别界面暂不可用，请使用粘贴或手动输入"); }
    }
    @Override protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode >= PICKUP_SAVE) {
            savePickupImageResult(requestCode, resultCode, data);
            return;
        }
        if (requestCode != PAIRING_SCAN || pairingScanRequestId == null) return;
        String id = pairingScanRequestId; pairingScanRequestId = null;
        if (resultCode != RESULT_OK || data == null) { reply(id, null, "已取消识别"); return; }
        try {
            String raw = data.getStringExtra("recognition");
            if (raw == null || raw.length() > 70000) throw new IllegalArgumentException();
            JSONObject result = new JSONObject(raw);
            if (result.optJSONArray("texts") == null || result.getJSONArray("texts").length() > 8) throw new IllegalArgumentException();
            reply(id, result, null);
        } catch (Exception invalid) { reply(id, null, "未取得有效识别结果，请重试"); }
    }

    private void exportPickupImage(String id, JSONObject payload, boolean save) {
        if (isFinishing() || isDestroyed() || !trustedPage) { reply(id, null, "页面已关闭，请重新生成取件长图"); return; }
        if (pickupExport != null) { reply(id, null, "已有图片操作正在进行，请先完成或取消"); return; }
        if (save && nextPickupSaveRequestCode > 65535) { reply(id, null, "请重新打开应用后保存图片"); return; }
        PickupExport current = new PickupExport(id, save ? nextPickupSaveRequestCode++ : 0); pickupExport = current;
        pickupImages.execute(() -> {
            try {
                File file = PickupShareImage.cache(getApplicationContext(), PickupShareImage.decode(payload));
                runOnUiThread(() -> {
                    if (pickupExport != current || isFinishing() || isDestroyed() || !trustedPage) {
                        file.delete(); finishPickupExport(current, null, "页面已关闭，请重新生成取件长图", false); return;
                    }
                    current.file = file;
                    try {
                        if (save) {
                            current.awaitingDocument = true;
                            startActivityForResult(PickupShareImage.saveIntent(), current.requestCode);
                            foreground.postDelayed(pickupSaveTimeout, 9 * 60_000);
                        } else {
                            Intent send = PickupShareImage.share(this, file);
                            if (getPackageManager().queryIntentActivities(send, android.content.pm.PackageManager.MATCH_DEFAULT_ONLY).isEmpty())
                                throw new android.content.ActivityNotFoundException();
                            startActivity(Intent.createChooser(send, "分享取件清单"));
                            finishPickupExport(current, imageResult("shared"), null, true);
                        }
                    } catch (Exception unavailable) {
                        finishPickupExport(current, null, save ? "无法打开系统保存界面，请稍后重试" : "未找到可分享图片的应用，请先保存图片后手动发送", false);
                    }
                });
            } catch (Exception | OutOfMemoryError invalid) {
                String error = invalid instanceof IllegalArgumentException ? invalid.getMessage() : "无法生成取件长图，请减少勾选后重试";
                runOnUiThread(() -> finishPickupExport(current, null, error, false));
            }
        });
    }

    private void savePickupImageResult(int requestCode, int resultCode, Intent data) {
        PickupExport current = pickupExport;
        if (current == null || current.requestCode != requestCode || !current.awaitingDocument) return;
        current.awaitingDocument = false;
        if (resultCode != RESULT_OK) { finishPickupExport(current, imageResult("cancelled"), null, false); return; }
        Uri destination = data == null ? null : data.getData();
        pickupImages.execute(() -> {
            try {
                PickupShareImage.save(getApplicationContext(), current.file, destination);
                runOnUiThread(() -> finishPickupExport(current, imageResult("saved"), null, false));
            } catch (Exception failure) {
                runOnUiThread(() -> finishPickupExport(current, null, "图片未保存，请重新选择可写入的位置", false));
            }
        });
    }

    private static JSONObject imageResult(String key) {
        JSONObject value = new JSONObject();
        try { value.put(key, true); } catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
        return value;
    }

    private void finishPickupExport(PickupExport current, JSONObject result, String error, boolean keepFile) {
        if (pickupExport != current) return;
        pickupExport = null;
        foreground.removeCallbacks(pickupSaveTimeout);
        if (!keepFile && current.file != null) current.file.delete();
        reply(current.id, result, error);
    }
    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code == SMS_PERMISSION && permissionRequestId != null) {
            String id = permissionRequestId;
            permissionRequestId = null;
            asyncStatus(id);
        }
    }
    private void asyncStatus(String id) {
        PickCodeApplication.IO.execute(() -> {
            try { reply(id, status(), null); } catch (Exception failure) { reply(id, null, "无法读取本地状态"); }
        });
    }
    private void openSettings(String id, JSONObject payload) {
        try {
            Intent intent = "battery".equals(payload.optString("page"))
                    ? new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName()));
            startActivity(intent);
            reply(id, new JSONObject().put("opened", true), null);
        } catch (Exception failure) { reply(id, null, "无法打开此系统设置，请手动前往应用设置"); }
    }
    private void pinWidget(String id, JSONObject payload) {
        try {
            AppWidgetManager manager = AppWidgetManager.getInstance(this);
            if (Build.VERSION.SDK_INT < 26 || !manager.isRequestPinAppWidgetSupported()) {
                reply(id, null, "请长按桌面，在小组件中添加取件码助手"); return;
            }
            String size = payload.optString("size");
            Class<?> type = "large".equals(size) ? LargeWidgetProvider.class
                    : "list".equals(size) ? ListWidgetProvider.class : SmallWidgetProvider.class;
            boolean requested = manager.requestPinAppWidget(new ComponentName(this, type), null, null);
            reply(id, new JSONObject().put("requested", requested), requested ? null : "桌面暂不支持添加此组件");
        } catch (Exception failure) { reply(id, null, "无法添加组件，请从桌面的小组件列表添加"); }
    }

    private void openShoppingApp(String id, JSONObject payload) {
        String url;
        switch (payload.optString("platform")) {
            case "淘宝": url = "taobao://taobao.com"; break;
            case "京东": url = "openApp.jdMobile://"; break;
            case "拼多多": url = "pinduoduo://"; break;
            case "抖音": url = "snssdk1128://"; break;
            case "唯品会": url = "vipshop://"; break;
            case "小红书": url = "https://xiaohongshu.com/"; break;
            case "1688": url = "https://m.1688.com/"; break;
            default: reply(id, null, "暂不支持此购物平台"); return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
            reply(id, new JSONObject().put("opened", true), null);
        } catch (Exception unavailable) { reply(id, null, "未找到此购物应用，请先安装后重试"); }
    }

    private void dialPhone(String id, JSONObject payload) {
        if (!trustedPage || isDestroyed()) return;
        Object phone = payload.opt("phone");
        if (payload.length() != 1 || !(phone instanceof String) || !((String) phone).matches("\\A\\+?[0-9]{5,15}\\z")) {
            reply(id, null, "电话号码格式无效"); return;
        }
        try {
            startActivity(new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", (String) phone, null)));
            reply(id, new JSONObject().put("opened", true), null);
        } catch (Exception unavailable) { reply(id, null, "无法打开拨号应用，请手动拨打"); }
    }

    private void reply(String id, JSONObject value, String error) {
        try {
            JSONObject detail = new JSONObject().put("id", id).put("ok", error == null);
            if (error == null) detail.put("data", value); else detail.put("error", error);
            // JSON is serialized as a quoted string and parsed, avoiding executable callback interpolation.
            String encoded = JSONObject.quote(detail.toString()).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
            runOnUiThread(() -> {
                if (!isDestroyed() && trustedPage) webView.evaluateJavascript(
                        "window.dispatchEvent(new CustomEvent('pickcode-native',{detail:JSON.parse(" + encoded + ")}));", null);
            });
        } catch (Exception ignored) { /* No secrets or SMS content in logs. */ }
    }
    private static String safeError(String action, Exception failure) {
        if ("aiChannels".equals(action) || action.contains("AiProposal") || action.contains("AiOptimization") || "aiOptimizationStatus".equals(action) || "generateTemplate".equals(action)) {
            if (failure instanceof OnlineClient.Failure) return failure.getMessage();
            return "AI操作未完成，请检查所选渠道、样例与预期取件码后重试；已有模板未改变";
        }
        if ("previewPairing".equals(action)) {
            if (failure instanceof OnlineClient.Failure) return failure.getMessage();
            return "授权核验未完成，请检查 HTTPS 服务地址、授权码及网络后重试";
        }
        if (UPDATE_ACTIONS.contains(action)) return "更新操作未完成，请稍后重试；原有数据已保留";
        if (ONLINE_ACTIONS.contains(action) || "onlineStatus".equals(action))
            return "线上操作未完成，请检查 HTTPS 服务地址与后台一次性绑定码后重试；本地历史已保留";
        if (failure instanceof SecurityException) return "请在系统设置中允许读取短信，再重试";
        if ("setAiKey".equals(action)) return "请在后台配置默认AI服务；手机不再保存或使用本机AI密钥";
        return "操作未完成，请检查输入后重试；原有数据已保留";
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        foreground.removeCallbacks(onlinePoll);
        copyWidgetWhenFocused();
        foregroundStarted = false;
        if (localSnapshotShown) notifyRefresh();
    }
    private void localSnapshotDelivered() {
        localSnapshotShown = true;
        if (!resumed || foregroundStarted || isDestroyed()) return;
        foregroundStarted = true;
        notifySyncStatus();
        long elapsed = android.os.SystemClock.elapsedRealtime() - lastOnlineAttempt;
        foreground.postDelayed(onlinePoll, lastOnlineAttempt == 0 ? 0 : Math.max(0, 60_000 - elapsed));
        displayRefreshInFlight = true;
        PickCodeApplication.IO.execute(() -> {
            try {
                JSONObject snapshot = AssistantStore.get(this).snapshot();
                ScanScheduler.configure(this, snapshot.getJSONObject("settings").optBoolean("autoScan"));
                OnlineSyncScheduler.configure(this, SecretStore.online(this).configured());
                OnlineSyncScheduler.maybeEnhance(this, snapshot);
                if (snapshot.getJSONObject("settings").optBoolean("autoScan") && SmsScanner.allowed(this)
                        && ScanWindow.due(snapshot.optLong("lastScanAt"), System.currentTimeMillis())) {
                    SmsScanner.scan(this);
                }
            } catch (Exception ignored) { /* Failed scans never advance lastScanAt. Manual scan can retry. */ }
            finally {
                // Widget mutations may happen while this activity is paused, even when no scan is due.
                runOnUiThread(() -> { displayRefreshInFlight = false; notifyRefresh(); });
            }
        });
    }
    @Override protected void onPause() { resumed = false; foreground.removeCallbacks(onlinePoll); super.onPause(); }
    boolean canPresentUpdateInstaller() { return trustedPage && resumed && !isFinishing() && !isDestroyed(); }
    private void notifyRefresh() {
        if (trustedPage && !isDestroyed()) webView.evaluateJavascript("window.dispatchEvent(new Event('pickcode-resume'));", null);
    }
    private void notifySyncStatus() {
        if (trustedPage && !isDestroyed()) webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('pickcode-sync-status',{detail:{syncing:" + onlineSyncInFlight + "}}));", null);
    }
    @Override public void onWindowFocusChanged(boolean focused) {
        super.onWindowFocusChanged(focused);
        if (focused) copyWidgetWhenFocused();
    }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        consumeWidgetIntent(intent);
        copyWidgetWhenFocused();
        openPendingPickup();
    }
    @Override protected void onSaveInstanceState(Bundle outState) {
        if (pendingWidgetCopyId != null) {
            outState.putString("pendingWidgetCopyId", pendingWidgetCopyId);
            outState.putInt("pendingWidgetId", pendingWidgetId);
        }
        if (pendingPickupId != null) outState.putString("pendingPickupId", pendingPickupId);
        outState.putBoolean("pendingPackages", pendingPackages);
        outState.putInt("nextPickupSaveRequestCode", nextPickupSaveRequestCode);
        super.onSaveInstanceState(outState);
    }
    private void consumeWidgetIntent(Intent intent) {
        if (intent == null) return;
        ComponentName component = intent.getComponent();
        String id = intent.getStringExtra("itemId");
        int widgetId = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID);
        // The exported launcher activity must not accept a forged COPY action from another app.
        if (component != null && getPackageName().equals(component.getPackageName())
                && WidgetModel.acceptsCopy(intent.getAction(), component.getClassName(), id)) {
            pendingWidgetCopyId = id;
            pendingWidgetId = widgetId;
            setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN));
        } else if (component != null && getPackageName().equals(component.getPackageName())
                && WidgetModel.acceptsDetail(intent.getAction(), component.getClassName(), id)
                && WidgetRenderer.isActiveWidget(this, widgetId, null)) {
            pendingPickupId = id;
            pendingPackages = false;
            setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN));
        } else if (component != null && getPackageName().equals(component.getPackageName())
                && WidgetModel.acceptsPackages(intent.getAction(), component.getClassName())
                && WidgetRenderer.isActiveWidget(this, widgetId, LargeWidgetProvider.class)) {
            pendingPickupId = null;
            pendingWidgetCopyId = null;
            pendingPackages = true;
            setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN));
        }
    }
    private void openPendingPickup() {
        if (!pageReady || !trustedPage || isDestroyed()) return;
        if (pendingPackages) {
            pendingPackages = false;
            String target = START + "#/pages/packages/index";
            if (!target.equals(webView.getUrl())) webView.loadUrl(target);
            return;
        }
        if (pendingPickupId == null) return;
        String id = JSONObject.quote(pendingPickupId).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029");
        pendingPickupId = null;
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent('pickcode-open-pickup',{detail:{id:" + id + "}}));", null);
    }
    private void copyWidgetWhenFocused() {
        if (!resumed || !hasWindowFocus() || pendingWidgetCopyId == null || widgetCopyInFlight || isDestroyed()) return;
        final String id = pendingWidgetCopyId;
        final int widgetId = pendingWidgetId;
        widgetCopyInFlight = true;
        PickCodeApplication.IO.execute(() -> {
            String currentCode = null;
            boolean failed = false;
            try {
                if (WidgetRenderer.isActiveWidget(this, widgetId, null))
                    currentCode = WidgetModel.codeToCopy(AssistantStore.get(this).snapshot(), id);
            }
            catch (Exception unavailable) { failed = true; }
            final String code = currentCode;
            final boolean readFailed = failed;
            runOnUiThread(() -> {
                widgetCopyInFlight = false;
                if (isDestroyed()) return;
                if (!id.equals(pendingWidgetCopyId) || widgetId != pendingWidgetId) { copyWidgetWhenFocused(); return; }
                // If focus was lost while SQLite was read, retain only the ID and read fresh on return.
                if (!resumed || !hasWindowFocus()) return;
                pendingWidgetCopyId = null;
                pendingWidgetId = AppWidgetManager.INVALID_APPWIDGET_ID;
                if (code == null || !WidgetRenderer.isActiveWidget(this, widgetId, null)) {
                    Toast.makeText(this, readFailed ? "暂时无法读取取件码，请重试" : "这条记录已变化，请从列表重新选择", Toast.LENGTH_SHORT).show();
                } else {
                    try {
                        ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                        ClipData clip = ClipData.newPlainText("取件码", code);
                        if (Build.VERSION.SDK_INT >= 24) {
                            PersistableBundle extras = new PersistableBundle();
                            extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
                            clip.getDescription().setExtras(extras);
                        }
                        clipboard.setPrimaryClip(clip);
                        if (Build.VERSION.SDK_INT < 33) Toast.makeText(this, "取件码已复制", Toast.LENGTH_SHORT).show();
                    } catch (RuntimeException denied) { Toast.makeText(this, "复制未完成，请在列表中重试", Toast.LENGTH_SHORT).show(); }
                }
                PickCodeApplication.IO.execute(() -> WidgetRenderer.updateAll(this));
            });
        });
    }
    @Override public void onBackPressed() { if (webView.canGoBack()) webView.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy() {
        pickupImages.shutdownNow();
        if (pickupExport != null) {
            finishActivity(pickupExport.requestCode);
            finishPickupExport(pickupExport, imageResult("cancelled"), null, false);
        }
        trustedPage = false;
        foreground.removeCallbacksAndMessages(null);
        webView.removeJavascriptInterface("PickCodeNative");
        webView.destroy();
        network.shutdownNow();
        onlineNetwork.shutdownNow();
        super.onDestroy();
    }
}
