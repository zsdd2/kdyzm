package local.pickcode.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.net.ConnectivityManager;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.FutureTask;

/** Serializes device sessions, not the SQLite store; every network request occurs outside store transactions. */
public final class OnlineSyncManager {
    static final int IMPORT_VERSION = 328;
    private static final int MAX_JOBS = 100;
    private static final ExecutorService STATION_UPLOADS = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "pickcode-station-fragments");
        thread.setDaemon(true);
        return thread;
    });
    private static OnlineSyncManager instance;
    private final Context context;
    private final SecretStore secrets;
    private final SharedPreferences metadata;
    private final AssistantStore store;
    private final BackendRoutes routes = new BackendRoutes(BuildConfig.DEBUG);
    private final InteractionDiagnostics diagnostics = new InteractionDiagnostics();
    // A 304 keeps this coverage; omitted jobs and a restarted process still use the legacy status endpoint.
    private final Set<String> snapshotJobIds = new HashSet<>();
    private long connectionCheckedAt;
    private volatile long sessionGeneration;
    private final Object syncRequests = new Object();
    private FutureTask<String> passiveSync;
    private long passiveSyncGeneration;
    private boolean stationUploadRunning;
    private boolean matchingFeedbackUploadRunning;
    private boolean recognitionUploadRunning;
    private OnlineSyncManager(Context context) {
        this.context = context.getApplicationContext();
        secrets = SecretStore.online(this.context);
        metadata = this.context.getSharedPreferences("online_metadata", Context.MODE_PRIVATE);
        store = AssistantStore.get(this.context);
        if (secrets.configured()) {
            diagnostics.resumeSession();
            aiSessionKey();
        }
    }
    public static synchronized OnlineSyncManager get(Context context) {
        if (instance == null) instance = new OnlineSyncManager(context);
        return instance;
    }
    /** Stable across process restarts; a new binding attempt retires every earlier AI proposal. */
    public synchronized String aiSessionKey() {
        if (!secrets.configured()) return "";
        String base = appUpdateOrigin(), device = metadata.getString("deviceId", "");
        if (base == null || device.isEmpty()) return "";
        String epoch = metadata.getString("aiSessionEpoch", "");
        if (epoch.isEmpty()) {
            epoch = UUID.randomUUID().toString();
            if (!metadata.edit().putString("aiSessionEpoch", epoch).commit()) throw new IllegalStateException("无法保存AI会话");
        }
        return sessionKey(base, device, epoch);
    }
    /** Scheduling reads one persisted metadata snapshot instead of waiting for an in-flight HTTP sync monitor. */
    String scheduledSessionKey() {
        if (!secrets.configured()) return "";
        Map<String, ?> values = metadata.getAll();
        Object base = values.get("baseUrl"), device = values.get("deviceId"), epoch = values.get("aiSessionEpoch");
        if (!(base instanceof String) || !(device instanceof String) || !(epoch instanceof String)
                || ((String) device).isEmpty() || ((String) epoch).isEmpty()) return "";
        try { return sessionKey(OnlineEndpoint.normalize((String) base, BuildConfig.DEBUG), (String) device, (String) epoch); }
        catch (IllegalArgumentException invalid) { return ""; }
    }
    private static String sessionKey(String base, String device, String epoch) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest((base + "\n" + device + "\n" + epoch).getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (byte value : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255));
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException unavailable) { throw new IllegalStateException("无法校验AI会话"); }
    }
    private void rotateAiSession() {
        sessionGeneration++;
        snapshotJobIds.clear();
        diagnostics.retireSession();
        try { OnlineSyncScheduler.cancelEnhancement(context); }
        catch (IllegalStateException unavailable) { /* Session validation still retires old work if the scheduler is unavailable. */ }
        if (!metadata.edit().putString("aiSessionEpoch", UUID.randomUUID().toString()).commit()) throw new IllegalStateException("无法保存AI会话");
    }
    public JSONObject aiChannels() throws Exception { return safeAiChannels(aiRequest("GET", "/v1/ai/channels", null)); }
    public JSONObject generateAiTemplate(JSONObject request) throws Exception {
        JSONObject safe = safeAiTemplateRequest(request);
        JSONObject service = aiChannels().getJSONObject("service");
        if (!service.getBoolean("available")) throw OnlineClient.aiFailure(409, service.getString("code"));
        String selected = service.getString("channelId"), requested = safe.optString("channelId");
        if (!requested.isEmpty() && !requested.equals(selected)) throw OnlineClient.aiFailure(409, "AI_CONFIG_CHANGED");
        // Older configured backends still require an explicit ID; it always comes from their default.
        safe.put("channelId", selected);
        JSONObject result = aiRequest("POST", "/v1/ai/template-proposals", safe);
        JSONObject currentService = aiChannels().getJSONObject("service");
        if (!currentService.optBoolean("available") || !selected.equals(currentService.optString("channelId"))
                || !service.getString("revision").equals(currentService.optString("revision"))) throw OnlineClient.aiFailure(409, "AI_CONFIG_CHANGED");
        JSONObject validation = result.optJSONObject("validation"), candidate = result.optJSONObject("candidate");
        if (validation == null || candidate == null || !Boolean.TRUE.equals(validation.opt("ok"))
                || !Boolean.TRUE.equals(validation.opt("requiresConfirmation")) || !AiTemplatePrivacy.DUMMY_CODE.equals(validation.optString("code"))) throw invalidResponse();
        AiTemplatePrivacy.checkCandidate(candidate, AiTemplatePrivacy.prepare(safe.getString("sample"), AiTemplatePrivacy.DUMMY_CODE));
        return new JSONObject().put("candidate", candidate).put("validation", new JSONObject().put("ok", true).put("code", AiTemplatePrivacy.DUMMY_CODE).put("requiresConfirmation", true));
    }
    private JSONObject aiRequest(String method, String path, JSONObject body) throws Exception {
        final String session, base, lan, service, token;
        synchronized (this) {
            session = aiSessionKey();
            if (session.isEmpty()) throw new OnlineClient.Failure("not_bound", "请先绑定后台并选择AI渠道");
            base = metadata.getString("baseUrl", ""); lan = metadata.getString("lanBaseUrl", ""); service = metadata.getString("serviceId", "");
            try { token = secrets.read(); }
            catch (Exception unavailable) { throw new OnlineClient.Failure("credentials_unavailable", "设备凭证无法读取，请重新绑定"); }
        }
        try {
            // Route probing and HTTP both happen outside the session/store monitors.
            JSONObject result = bindingWriteClient(base, lan, service, token).request(method, path, body, null).body;
            synchronized (this) { if (!session.equals(aiSessionKey())) throw new OnlineClient.Failure("ai_session_changed", "后台绑定已变化，请重新准备建议"); }
            return result;
        } catch (Exception failure) {
            synchronized (this) {
                if (!session.equals(aiSessionKey())) throw new OnlineClient.Failure("ai_session_changed", "后台绑定已变化，请重新准备建议");
                if (failure instanceof OnlineClient.Failure && "device_unauthorized".equals(((OnlineClient.Failure) failure).code)) recordFailure(failure);
            }
            throw failure;
        }
    }
    static JSONObject safeAiTemplateRequest(JSONObject input) throws Exception {
        if (input == null || input.length() != (input.has("channelId") ? 3 : 2) || input.has("channelId") && !(input.opt("channelId") instanceof String)
                || !(input.opt("sample") instanceof String) || !AiTemplatePrivacy.DUMMY_CODE.equals(input.opt("expectedCode"))
                || !input.optString("channelId").isEmpty() && !input.optString("channelId").matches("[A-Za-z0-9_-]{1,128}")
                || "legacy-deepseek".equals(input.optString("channelId")))
            throw new IllegalArgumentException("请使用后台默认AI服务并先在本机脱敏样例");
        AiTemplatePrivacy.Prepared prepared = AiTemplatePrivacy.prepare(input.getString("sample"), AiTemplatePrivacy.DUMMY_CODE);
        if (!prepared.sample.equals(input.getString("sample"))) throw new IllegalArgumentException("仅允许本机生成的合成片段");
        return prepared.request(input.optString("channelId"));
    }
    static JSONObject safeAiChannels(JSONObject input) throws Exception {
        JSONArray raw = input == null ? null : input.optJSONArray("channels"), channels = new JSONArray();
        if (raw == null || raw.length() > 10 || !(input.opt("defaultChannelId") instanceof String)) throw invalidResponse();
        String selected = input.getString("defaultChannelId"); Set<String> ids = new HashSet<>();
        for (int i = 0; i < raw.length(); i++) {
            JSONObject channel = raw.optJSONObject(i); if (channel == null) throw invalidResponse();
            String id = boundedText(channel, "id", 128, true), name = boundedText(channel, "name", 80, true), model = boundedText(channel, "model", 120, true);
            if (!id.matches("[A-Za-z0-9_-]{1,128}") || !ids.add(id)) throw invalidResponse();
            JSONArray capabilities = channel.optJSONArray("capabilities"), safe = new JSONArray();
            if (capabilities == null || capabilities.length() > 3) throw invalidResponse();
            Set<String> unique = new HashSet<>();
            for (int j = 0; j < capabilities.length(); j++) {
                Object value = capabilities.opt(j);
                if (!(value instanceof String) || !((String) value).matches("station_alias|sms_template|logistics_rule") || !unique.add((String) value)) throw invalidResponse();
                safe.put(value);
            }
            channels.put(new JSONObject().put("id", id).put("name", name).put("model", model).put("capabilities", safe));
        }
        if (!selected.isEmpty() && !ids.contains(selected)) throw invalidResponse();
        JSONObject chosen = null;
        for (int i = 0; i < channels.length(); i++) if (selected.equals(channels.getJSONObject(i).getString("id"))) chosen = channels.getJSONObject(i);
        JSONObject service = input.optJSONObject("service"), safeService;
        if (service == null) {
            if (input.has("service")) throw invalidResponse();
            String code = chosen != null ? "AI_READY" : channels.length() == 0 ? "AI_NOT_CONFIGURED" : "AI_DEFAULT_MISSING";
            safeService = new JSONObject().put("mode", "backend_default").put("available", chosen != null).put("code", code)
                    .put("message", chosen != null ? "使用后台默认AI服务" : code.equals("AI_DEFAULT_MISSING") ? "请在后台选择默认AI服务" : "请在后台配置AI服务")
                    .put("channelId", selected).put("channelName", chosen == null ? "" : chosen.getString("name"))
                    .put("model", chosen == null ? "" : chosen.getString("model"))
                    .put("revision", chosen == null ? "legacy-unavailable" : "legacy-" + selected + ":" + chosen.getString("model"));
        } else {
            if (!"backend_default".equals(service.optString("mode")) || !(service.opt("available") instanceof Boolean)) throw invalidResponse();
            String code = boundedText(service, "code", 40, true), id = boundedText(service, "channelId", 128, false);
            String name = boundedText(service, "channelName", 80, false), model = boundedText(service, "model", 120, false);
            if (!code.matches("AI_READY|AI_NOT_CONFIGURED|AI_DEFAULT_MISSING|AI_CHANNEL_DISABLED|AI_CHANNEL_INCOMPLETE")
                    || !id.isEmpty() && !id.matches("[A-Za-z0-9_-]{1,128}")) throw invalidResponse();
            boolean available = service.getBoolean("available");
            if (available ? !"AI_READY".equals(code) || chosen == null || channels.length() != 1 || !id.equals(selected)
                    || !name.equals(chosen.getString("name")) || !model.equals(chosen.getString("model"))
                    : "AI_READY".equals(code) || !selected.isEmpty() || channels.length() != 0) throw invalidResponse();
            safeService = new JSONObject().put("mode", "backend_default").put("available", available).put("code", code)
                    .put("message", boundedText(service, "message", 200, true)).put("channelId", id).put("channelName", name).put("model", model)
                    .put("revision", boundedText(service, "revision", 128, true));
        }
        // Do not expose an alternate choice when an older backend has no usable default.
        return new JSONObject().put("channels", chosen == null ? new JSONArray() : new JSONArray().put(chosen))
                .put("defaultChannelId", selected).put("service", safeService);
    }
    synchronized String appUpdateOrigin() {
        if (!secrets.configured()) return null;
        try { return OnlineEndpoint.normalize(metadata.getString("baseUrl", ""), BuildConfig.DEBUG); }
        catch (IllegalArgumentException invalid) { return null; }
    }
    synchronized String[] appUpdateOrigins() {
        String primary = appUpdateOrigin();
        if (primary == null) return new String[0];
        routes.configure(primary, metadata.getString("lanBaseUrl", ""), metadata.getString("serviceId", ""));
        return routes.select(networkKey());
    }
    private String networkKey() {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        return manager == null ? "unknown" : String.valueOf(manager.getActiveNetwork());
    }
    private OnlineClient routedClient(String token) throws Exception {
        String primary = metadata.getString("baseUrl", "");
        long now = android.os.SystemClock.elapsedRealtime();
        if (connectionCheckedAt == 0 || now - connectionCheckedAt >= 300_000) {
            connectionCheckedAt = now;
            try {
                // Optional route configuration is learned only from the original trusted binding.
                JSONObject config = new OnlineClient(primary, token, BuildConfig.DEBUG, null, null, 1_500, 1_500)
                        .request("GET", "/v1/connection", null, null).body;
                if (config.optInt("schemaVersion") != 1 || !config.optString("serviceId").matches("[a-f0-9]{32}")
                        || !(config.opt("lanBaseUrl") instanceof String)) throw invalidResponse();
                String candidate = config.getString("lanBaseUrl");
                if (!candidate.isEmpty()) candidate = OnlineEndpoint.normalize(candidate, BuildConfig.DEBUG);
                if (!metadata.edit().putString("serviceId", config.getString("serviceId")).putString("lanBaseUrl", candidate).commit())
                    throw new IllegalStateException("无法保存后台连接信息");
            } catch (OnlineClient.Failure failure) {
                if ("device_unauthorized".equals(failure.code) || "forbidden".equals(failure.code)) throw failure;
                // Old servers and temporary failures retain the last trusted configuration.
            } catch (Exception unavailable) { /* Cached LAN routes remain useful when the public route is offline. */ }
        }
        routes.configure(primary, metadata.getString("lanBaseUrl", ""), metadata.getString("serviceId", ""));
        String[] selected = routes.select(networkKey());
        String preferred = selected[0], fallback = selected.length > 1 ? primary : null;
        return new OnlineClient(preferred, token, BuildConfig.DEBUG, fallback, () -> routes.failed(preferred), 10_000, 15_000);
    }
    private void scheduleDiagnosticsUpload(JSONObject snapshot, String expectedSession) {
        try {
            JSONObject online = snapshot == null ? null : snapshot.optJSONObject("online");
            if (!hasCapability(online, InteractionDiagnostics.CAPABILITY)) return;
            String base = metadata.getString("baseUrl", "");
            String token = secrets.read();
            diagnostics.scheduleUpload(expectedSession, base, token, BuildConfig.DEBUG);
        } catch (Exception ignored) {
            // Diagnostics are best effort and never change the originating operation.
        }
    }
    InteractionDiagnostics diagnosticsForTests() { return diagnostics; }
    public JSONObject status() throws Exception {
        JSONObject online = store.overview().optJSONObject("online");
        if (online == null) online = new JSONObject();
        // This is an allowlist: neither Keystore ciphertext nor server credentials enter the bridge.
        return copyFamilyScope(new JSONObject().put("bound", secrets.configured()).put("baseUrl", metadata.getString("baseUrl", ""))
                .put("deviceId", metadata.getString("deviceId", ""))
                .put("accounts", safeAccounts(online.optJSONArray("accounts")))
                .put("families", safeFamilies(online.optJSONArray("families")))
                .put("jobs", safeJobs(online.optJSONArray("jobs"))).put("capabilities", online.optJSONArray("capabilities") == null ? new JSONArray() : online.getJSONArray("capabilities"))
                .put("serverVersion", online.optString("serverVersion"))
                .put("lastSuccessAt", online.optLong("lastSuccessAt")).put("errorCode", online.optString("errorCode"))
                .put("error", online.optString("error")).put("notice", online.optString("notice")).put("pendingCount", online.optInt("pendingCount")), online);
    }
    public synchronized JSONObject bind(String input, String code) throws Exception {
        String baseUrl = OnlineEndpoint.normalize(input, BuildConfig.DEBUG);
        String bindingCode = code == null ? "" : code.trim();
        if (!OnlineEndpoint.validCode(bindingCode)) throw new IllegalArgumentException("请填写后台生成的一次性绑定码");
        rotateAiSession();
        try {
            JSONObject response = new OnlineClient(baseUrl, null, BuildConfig.DEBUG).request("POST", "/v1/devices",
                    new JSONObject().put("code", bindingCode).put("deviceName", "Android " + Build.MODEL), null).body;
            String token = response.optString("token"), deviceId = response.optString("deviceId");
            if (!OnlineEndpoint.validToken(token) || deviceId.isEmpty() || deviceId.length() > 200
                    || response.optJSONArray("accounts") == null) throw invalidResponse();
            secrets.save(token, SecretStore.DEFAULT_MODEL);
            String aiEpoch = metadata.getString("aiSessionEpoch", "");
            if (!metadata.edit().clear().putString("baseUrl", baseUrl).putString("deviceId", deviceId).putString("aiSessionEpoch", aiEpoch).commit()) {
                secrets.clear();
                throw new IllegalStateException("无法保存绑定信息");
            }
            diagnostics.startSession();
            connectionCheckedAt = 0;
            store.dispatch("syncMeta", copyFamilyScope(new JSONObject().put("bound", true).put("baseUrl", baseUrl).put("deviceId", deviceId)
                    .put("accounts", safeAccounts(response.getJSONArray("accounts"))).put("families", safeFamilies(response.optJSONArray("families"))).put("jobs", new JSONArray()).put("lastSuccessAt", 0).put("errorCode", "").put("error", ""), response));
            OnlineSyncScheduler.configure(context, true);
            return synchronize(false, null);
        } catch (Exception failure) {
            JSONObject result = recordFailure(failure);
            if (secrets.configured()) diagnostics.resumeSession();
            return result;
        }
    }
    public JSONObject sync(boolean force) throws Exception {
        if (force) { synchronized (this) { return synchronize(true, null); } }
        FutureTask<String> request;
        synchronized (syncRequests) {
            long generation = sessionGeneration;
            if (passiveSync == null || passiveSync.isDone() || passiveSyncGeneration != generation) {
                passiveSyncGeneration = generation;
                passiveSync = new FutureTask<>(() -> {
                    synchronized (this) {
                        // A request queued before re-binding must not act on the replacement session.
                        return (generation == sessionGeneration ? synchronize(false, null) : store.snapshot()).toString();
                    }
                });
            }
            request = passiveSync;
        }
        request.run();
        try { return new JSONObject(request.get()); }
        catch (ExecutionException failure) {
            Throwable cause = failure.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            if (cause instanceof Error) throw (Error) cause;
            throw failure;
        } finally {
            synchronized (syncRequests) { if (request.isDone() && passiveSync == request) passiveSync = null; }
        }
    }
    synchronized JSONObject syncStationEnhancement(String session) throws Exception {
        JSONObject snapshot = store.snapshot();
        if (session == null || session.isEmpty() || !session.equals(aiSessionKey()) || !enhancementEnabled(snapshot)) return snapshot;
        return synchronize(false, null, false, "enhancement");
    }
    public synchronized JSONObject refreshOrder(String id) throws Exception {
        if (id == null || id.isEmpty() || id.length() > 200)
            return recordFailure(new OnlineClient.Failure("order_unavailable", "此订单无法刷新，请重新同步后选择订单"));
        return synchronize(false, id);
    }
    public JSONObject shipmentDetails(String id) throws Exception {
        final long generation = sessionGeneration;
        final String session = scheduledSessionKey();
        final String diagnosticsSession = diagnostics.currentSession();
        if (session.isEmpty()) throw new OnlineClient.Failure("not_bound", "请先绑定后台再查看物流详情");
        JSONObject target = store.dispatch("shipmentDetailTarget", new JSONObject().put("id", id));
        String remoteId = target.optString("remoteId");
        if (!remoteId.matches("[0-9a-f]{32}")) throw invalidResponse();
        String base = metadata.getString("baseUrl", ""), lan = metadata.getString("lanBaseUrl", ""), identity = metadata.getString("serviceId", "");
        String token;
        try { token = secrets.read(); }
        catch (Exception unavailable) { throw new OnlineClient.Failure("credentials_unavailable", "设备凭证无法读取，请重新绑定"); }
        // Details do not queue behind collection, and never hold a store transaction during HTTP.
        long startedAt = android.os.SystemClock.elapsedRealtime();
        JSONObject result;
        try {
            OnlineClient.Response response = bindingWriteClient(base, lan, identity, token)
                    .request("GET", "/v1/shipments/" + remoteId + "/logistics", null, null);
            result = response.body;
            diagnostics.recordShipmentDetail(diagnosticsSession, "success", response.status,
                    android.os.SystemClock.elapsedRealtime() - startedAt, "request");
        } catch (Exception failure) {
            diagnostics.recordShipmentDetail(diagnosticsSession, "error", 0, android.os.SystemClock.elapsedRealtime() - startedAt, "request");
            throw failure;
        }
        if (generation != sessionGeneration || !session.equals(scheduledSessionKey()))
            throw new OnlineClient.Failure("session_changed", "后台绑定已变化，请重新展开详情");
        if (result == null || !(result.opt("shipmentId") instanceof String) || !(result.opt("orderId") instanceof String)
                || !result.optString("evidenceKey").matches("[a-f0-9]{64}") || result.optJSONArray("logisticsEvents") == null)
            throw invalidResponse();
        long detailImportStartedAt = android.os.SystemClock.elapsedRealtime();
        try {
            JSONObject imported = store.dispatch("importShipmentDetails", result.put("id", id).put("bindingKey", target.getString("bindingKey")));
            diagnostics.recordShipmentDetail(diagnosticsSession, "success", 0, android.os.SystemClock.elapsedRealtime() - detailImportStartedAt, "import");
            scheduleDiagnosticsUpload(store.snapshot(), diagnosticsSession);
            return imported;
        } catch (Exception failure) {
            diagnostics.recordShipmentDetail(diagnosticsSession, "error", 0, android.os.SystemClock.elapsedRealtime() - detailImportStartedAt, "import");
            throw failure;
        }
    }
    public synchronized JSONObject proposeStation(JSONObject payload) throws Exception {
        if (!secrets.configured()) throw new OnlineClient.Failure("not_bound", "请先绑定线上服务，再提交站点关系");
        if (!hasCapability(store.snapshot().optJSONObject("online"), "station_aliases_v1"))
            throw new OnlineClient.Failure("feature_unavailable", "请先升级后台并同步，再提交站点关系");
        JSONObject request = new JSONObject().put("stationName", boundedText(payload, "stationName", 120, true))
                .put("otherStationName", boundedText(payload, "otherStationName", 120, true));
        if (payload.has("subLocation")) request.put("subLocation", boundedText(payload, "subLocation", 120, false));
        try {
            String token;
            try { token = secrets.read(); }
            catch (Exception unavailable) { throw new OnlineClient.Failure("credentials_unavailable", "设备凭证无法读取，请重新绑定"); }
            return routedClient(token)
                    .request("POST", "/v1/station-proposals", request, null).body;
        } catch (OnlineClient.Failure failure) {
            if ("device_unauthorized".equals(failure.code) || "credentials_unavailable".equals(failure.code)) recordFailure(failure);
            throw failure;
        }
    }
    private JSONObject synchronize(boolean force, String localOrderId) throws Exception {
        return synchronize(force, localOrderId, true, localOrderId == null ? (force ? "manual" : "passive") : "order");
    }
    private JSONObject synchronize(boolean force, String localOrderId, boolean allowCollection) throws Exception {
        return synchronize(force, localOrderId, allowCollection, localOrderId == null ? (force ? "manual" : "passive") : "order");
    }
    private JSONObject synchronize(boolean force, String localOrderId, boolean allowCollection, String reason) throws Exception {
        long startedAt = android.os.SystemClock.elapsedRealtime();
        String diagnosticsSession = diagnostics.currentSession();
        JSONObject result = synchronizeCore(force, localOrderId, allowCollection, diagnosticsSession);
        JSONObject online = result == null ? null : result.optJSONObject("online");
        diagnostics.recordSync(diagnosticsSession, reason, online != null && online.optString("errorCode").isEmpty() ? "success" : "error",
                0, android.os.SystemClock.elapsedRealtime() - startedAt, 1);
        scheduleDiagnosticsUpload(result, diagnosticsSession);
        return result;
    }
    private JSONObject synchronizeCore(boolean force, String localOrderId, boolean allowCollection, String diagnosticsSession) throws Exception {
        if (!secrets.configured()) return localOrderId == null ? store.snapshot()
                : recordFailure(new OnlineClient.Failure("not_bound", "请先绑定线上账号，再刷新此订单"));
        try {
            String token;
            try { token = secrets.read(); }
            catch (Exception unavailable) { throw new OnlineClient.Failure("credentials_unavailable", "设备凭证无法解密，请重新绑定；本地历史已保留"); }
            OnlineClient client = routedClient(token);
            // Recover a binding saved just before a process stop, without resetting an existing cursor.
            JSONObject binding = store.snapshot().getJSONObject("online");
            String baseUrl = metadata.getString("baseUrl", ""), deviceId = metadata.getString("deviceId", "");
            if (!binding.optBoolean("bound") || !baseUrl.equals(binding.optString("baseUrl")) || !deviceId.equals(binding.optString("deviceId")))
                store.dispatch("syncMeta", new JSONObject().put("bound", true).put("baseUrl", baseUrl).put("deviceId", deviceId));
            boolean start = force || localOrderId != null;
            // Refresh authorization before reading queued operations or jobs; revoked family work must not block other families.
            JSONObject latest = pullSnapshot(client, metadata.getInt("importVersion", 0) < IMPORT_VERSION || start, diagnosticsSession);
            JSONArray queued = store.snapshot().optJSONArray("operations");
            if (queued != null) for (int offset = 0; offset < queued.length(); offset += 100) {
                JSONArray batch = operationBatch(queued, offset);
                long operationStartedAt = android.os.SystemClock.elapsedRealtime();
                OnlineClient.Response operationResponse;
                try {
                    operationResponse = client.request("POST", "/v1/operations", new JSONObject().put("operations", batch), null);
                } catch (Exception failure) {
                    diagnostics.recordOperations(diagnosticsSession, "error", 0,
                            android.os.SystemClock.elapsedRealtime() - operationStartedAt, batch.length(), 0, "error");
                    throw failure;
                }
                JSONArray applied = operationResponse.body.optJSONArray("appliedIds");
                JSONArray accepted = acknowledged(batch, applied);
                if (accepted.length() > 0) store.dispatch("syncAck", new JSONObject().put("appliedIds", accepted));
                diagnostics.recordOperations(diagnosticsSession, accepted.length() == batch.length() ? "success" : "error", operationResponse.status,
                        android.os.SystemClock.elapsedRealtime() - operationStartedAt, batch.length(), accepted.length(),
                        accepted.length() == batch.length() ? "applied" : "rejected");
                if (accepted.length() != batch.length()) throw new OnlineClient.Failure("operations_pending", "部分离线操作尚未获后台确认，请检查授权后重试");
            }
            JSONObject online = store.snapshot().optJSONObject("online");
            JSONArray jobs = authorizedJobs(safeJobs(online == null ? null : online.optJSONArray("jobs")), latest == null ? online : latest);
            boolean conditional = allowCollection && !start && needsConditionalSync(online, jobs, System.currentTimeMillis());
            boolean poll = !start && needsJobPolling(jobs, snapshotJobIds);
            if (start || conditional) {
                if (!hasCapability(online, "syncJobs") || (localOrderId != null && !hasCapability(online, "orderRefresh")))
                    throw new OnlineClient.Failure("feature_unavailable", "请先将后台升级到 3.1.5 或更高版本，再主动刷新；已有数据仍可同步");
                String path = "/v1/accounts/sync";
                if (localOrderId != null) {
                    JSONObject target;
                    try { target = store.dispatch("onlineOrderTarget", new JSONObject().put("id", localOrderId)); }
                    catch (Exception unavailable) { throw new OnlineClient.Failure("order_unavailable", "此订单不属于当前绑定范围，请重新同步后选择订单"); }
                    String orderId = target.optString("orderId");
                    if (!orderId.matches("[0-9a-f]{32}")) throw new OnlineClient.Failure("order_unavailable", "此订单无法刷新，请重新同步后选择订单");
                    path = "/v1/orders/" + orderId + "/refresh";
                }
                JSONObject result = client.request("POST", path, conditional ? new JSONObject().put("onlyIfStale", true) : new JSONObject(), null).body;
                if (!Boolean.TRUE.equals(result.opt("accepted")) || result.optJSONArray("jobs") == null) throw invalidResponse();
                JSONArray started = safeJobs(result.getJSONArray("jobs"));
                if (started.length() == 0 && !conditional) throw new OnlineClient.Failure("no_accounts", "没有可刷新的线上账号，请检查后台账号与设备授权");
                jobs = authorizedJobs(mergeStartedJobs(jobs, started), latest == null ? online : latest);
                start = start || started.length() > 0;
            }
            if (!start && poll) {
                // One status request per pending task; collection itself is never waited on in this thread.
                jobs = pollJobs(client, jobs, snapshotJobIds);
            }
            // Save new task progress before the next request so a failed pull can resume it.
            if (start || poll) store.dispatch("syncMeta", new JSONObject().put("jobs", jobs));
            if (start || poll || queued != null && queued.length() > 0) latest = pullSnapshot(client, false, diagnosticsSession);
            acknowledgeStationRules(client);
            long now = System.currentTimeMillis();
            // Snapshot import may have retired an old cooldown after a newer account success.
            JSONObject refreshed = store.snapshot().getJSONObject("online");
            jobs = authorizedJobs(safeJobs(refreshed.optJSONArray("jobs")), latest == null ? refreshed : latest);
            String jobError = jobsError(jobs);
            JSONObject snapshot = store.dispatch("syncMeta", new JSONObject().put("bound", true)
                    .put("jobs", jobs).put("lastSuccessAt", now).put("errorCode", jobError.isEmpty() ? "" : "collection_incomplete").put("error", jobError));
            WidgetRenderer.updateAll(context);
            OnlineSyncScheduler.configureEnhancement(context, snapshot);
            scheduleStationCandidates();
            scheduleMatchingFeedback();
            scheduleRecognitionIssues();
            return snapshot;
        } catch (Exception failure) { return recordFailure(failure); }
    }
    static boolean needsConditionalSync(JSONObject online, JSONArray jobs, long now) throws Exception {
        if (!hasCapability(online, "conditionalSync")) return false;
        JSONArray accounts = online.optJSONArray("accounts");
        if (accounts == null) return false;
        for (int i = 0; i < accounts.length(); i++) {
            JSONObject account = accounts.getJSONObject(i);
            String id = account.optString("id");
            if (id.isEmpty() || Boolean.FALSE.equals(account.opt("enabled")) || "expired".equals(account.optString("status"))) continue;
            boolean pending = false;
            for (int j = 0; j < jobs.length(); j++) {
                JSONObject job = jobs.getJSONObject(j);
                if (id.equals(job.optString("accountId")) && pendingJob(job)) { pending = true; break; }
            }
            Object value = account.opt("lastFullSuccessAt");
            double completedAt = value instanceof Number ? ((Number) value).doubleValue() : 0;
            if (!pending && (Double.isNaN(completedAt) || Double.isInfinite(completedAt) || completedAt <= 0 || completedAt != Math.floor(completedAt)
                    || completedAt > now || now - completedAt > 30 * 60_000L)) return true;
        }
        return false;
    }
    private JSONObject pullSnapshot(OnlineClient client, boolean full, String diagnosticsSession) throws Exception {
        JSONObject current = store.snapshot().getJSONObject("online");
        if (current.optBoolean("needsPickupSync")) full = true;
        if (metadata.getInt("importVersion", 0) < IMPORT_VERSION) {
            if (!metadata.edit().remove("etag").commit()) throw new IllegalStateException("无法重置同步游标");
            full = true;
        }
        String version = full ? "" : current.optString("dataVersion");
        String path = "/v1/snapshot?view=compact" + (version.matches("[a-f0-9]{64}") ? "&dataVersion=" + version : "");
        long snapshotStartedAt = android.os.SystemClock.elapsedRealtime();
        OnlineClient.Response response;
        try {
            response = client.request("GET", path, null, full ? "" : metadata.getString("etag", ""));
        } catch (Exception failure) {
            diagnostics.recordSnapshotFailure(diagnosticsSession, full, android.os.SystemClock.elapsedRealtime() - snapshotStartedAt);
            throw failure;
        }
        diagnostics.recordSnapshot(diagnosticsSession, response.body != null && response.body.optBoolean("metadataOnly"), response.notModified,
                full, response.status, android.os.SystemClock.elapsedRealtime() - snapshotStartedAt);
        if (response.notModified) return null;
        validateSnapshot(response.body);
        if (response.body.optBoolean("metadataOnly") && !version.equals(response.body.optString("dataVersion")))
            throw invalidResponse();
        if (response.body.getLong("serverRevision") < Math.max(current.optLong("serverRevision", -1), current.optLong("metadataRevision", -1)))
            throw new OnlineClient.Failure("stale_snapshot", "后台数据版本较旧，已保留本地记录，请稍后重试");
        response.body.put("accounts", safeAccounts(response.body.getJSONArray("accounts")));
        if (response.body.has("syncJobs")) response.body.put("syncJobs", safeJobs(response.body.getJSONArray("syncJobs")));
        if (response.body.has("families")) response.body.put("families", safeFamilies(response.body.optJSONArray("families")));
        if (response.body.has("stationRules")) response.body.put("stationRules", safeStationRules(response.body.optJSONArray("stationRules")));
        if (response.body.has("serverLogisticsRules")) response.body.put("serverLogisticsRules", safeServerLogisticsRules(response.body.optJSONArray("serverLogisticsRules")));
        if (response.body.has("matchingFeedback")) response.body.put("matchingFeedback", safeMatchingFeedbackSummary(response.body.optJSONObject("matchingFeedback")));
        long importStartedAt = android.os.SystemClock.elapsedRealtime();
        try {
            if (response.body.optBoolean("metadataOnly"))
                store.dispatch("syncMetadata", new JSONObject().put("meta", response.body).put("dataVersion", version).put("syncedAt", System.currentTimeMillis()));
            else store.dispatch("syncImport", new JSONObject().put("snapshot", response.body).put("syncedAt", System.currentTimeMillis()).put("importVersion", IMPORT_VERSION));
            diagnostics.recordImport(diagnosticsSession, "success", android.os.SystemClock.elapsedRealtime() - importStartedAt,
                    response.body.optJSONArray("accounts") == null ? 0 : response.body.getJSONArray("accounts").length());
        } catch (Exception failure) {
            diagnostics.recordImport(diagnosticsSession, "error", android.os.SystemClock.elapsedRealtime() - importStartedAt, 0);
            diagnostics.recordSnapshotFailure(diagnosticsSession, full, android.os.SystemClock.elapsedRealtime() - snapshotStartedAt);
            throw failure;
        }
        // Neither an old server revision nor an unsuccessful import may advance the conditional cursor.
        if (!metadata.edit().putString("etag", response.etag).putInt("importVersion", IMPORT_VERSION).commit())
            throw new IllegalStateException("无法保存同步游标");
        snapshotJobIds.clear();
        JSONArray includedJobs = response.body.optJSONArray("syncJobs");
        if (includedJobs != null) for (int i = 0; i < includedJobs.length(); i++) snapshotJobIds.add(includedJobs.getJSONObject(i).getString("id"));
        return response.body;
    }
    private void acknowledgeStationRules(OnlineClient client) {
        try {
            JSONObject receipt = store.dispatch("stationRuleReceiptBatch", new JSONObject());
            if (!receipt.optBoolean("pending")) return;
            JSONObject body = new JSONObject().put("stationRulesVersion", receipt.getLong("stationRulesVersion"))
                    .put("serverLogisticsRulesVersion", receipt.getLong("serverLogisticsRulesVersion"));
            JSONObject response = client.request("POST", "/v1/station-rule-receipts", body, null).body;
            if (Boolean.TRUE.equals(response.opt("accepted"))) store.dispatch("stationRuleReceiptAck", body);
        } catch (Exception unavailable) { /* A saved import stays valid; retry the receipt on the next sync. */ }
    }
    static JSONArray pollJobs(OnlineClient client, JSONArray previous) throws Exception {
        return pollJobs(client, previous, java.util.Collections.emptySet());
    }
    static boolean needsJobPolling(JSONArray jobs, Set<String> snapshotJobIds) throws Exception {
        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.getJSONObject(i);
            if (pendingJob(job) && !snapshotJobIds.contains(job.getString("id"))) return true;
        }
        return false;
    }
    static JSONArray pollJobs(OnlineClient client, JSONArray previous, Set<String> snapshotJobIds) throws Exception {
        JSONArray result = new JSONArray();
        int requests = 0;
        long startedAt = android.os.SystemClock.elapsedRealtime();
        for (int i = 0; i < previous.length(); i++) {
            JSONObject job = previous.getJSONObject(i);
            if (pendingJob(job) && !snapshotJobIds.contains(job.getString("id"))
                    && requests < 3 && android.os.SystemClock.elapsedRealtime() - startedAt < 5_000) {
                requests++;
                try {
                    JSONObject response = client.request("GET", "/v1/sync-jobs/" + job.getString("id"), null, null).body;
                    if (response.optJSONObject("job") == null) throw invalidResponse();
                    JSONObject updated = safeJobs(new JSONArray().put(response.getJSONObject("job"))).getJSONObject(0);
                    if (!job.getString("id").equals(updated.getString("id")) || !job.getString("accountId").equals(updated.getString("accountId"))
                            || !job.getString("orderId").equals(updated.getString("orderId"))) throw invalidResponse();
                    job = updated;
                } catch (OnlineClient.Failure failure) {
                    if ("forbidden".equals(failure.code)) continue; // Scope can change between the snapshot and this status request.
                    if (!"job_missing".equals(failure.code)) throw failure;
                    job.put("state", "error").put("error", "后台任务状态已失效，请重新刷新");
                }
            }
            result.put(job);
        }
        return result;
    }
    static JSONArray authorizedJobs(JSONArray previous, JSONObject snapshot) throws Exception {
        if (snapshot == null) return previous;
        Set<String> accountIds = new HashSet<>(), familyIds = new HashSet<>(), legacyIds = new HashSet<>();
        JSONArray accounts = snapshot.optJSONArray("accounts");
        if (accounts != null) for (int i = 0; i < accounts.length(); i++) accountIds.add(accounts.getJSONObject(i).optString("id"));
        boolean familyScope = snapshot.has("hasFamilyScope") ? snapshot.optBoolean("hasFamilyScope") : snapshot.has("familyIds");
        JSONArray family = snapshot.optJSONArray("familyIds"), legacy = snapshot.optJSONArray("legacyAccountIds");
        if (family != null) for (int i = 0; i < family.length(); i++) familyIds.add(family.optString(i));
        if (familyScope) { if (legacy != null) for (int i = 0; i < legacy.length(); i++) legacyIds.add(legacy.optString(i)); }
        else legacyIds.addAll(accountIds);
        JSONArray orders = snapshot.optJSONArray("orders"), safe = new JSONArray();
        for (int i = 0; i < previous.length(); i++) {
            JSONObject job = previous.getJSONObject(i); String orderId = job.optString("orderId"), accountId = job.optString("accountId");
            boolean allowed = accountIds.contains(accountId);
            if (!orderId.isEmpty()) {
                // A 304 has no order records; retain historical jobs for the server's per-record authorization check.
                allowed = orders == null;
                if (orders != null) for (int j = 0; j < orders.length(); j++) {
                    JSONObject order = orders.getJSONObject(j);
                    if (orderId.equals(order.optString("id")) && accountId.equals(order.optString("accountId"))) {
                        allowed = legacyIds.contains(accountId) || !order.optString("familyId").isEmpty() && familyIds.contains(order.optString("familyId")); break;
                    }
                }
            }
            if (allowed) safe.put(job);
        }
        return safe;
    }
    public synchronized JSONObject unbind() throws Exception {
        rotateAiSession();
        String token = null, baseUrl = metadata.getString("baseUrl", "");
        String lan = metadata.getString("lanBaseUrl", ""), identity = metadata.getString("serviceId", "");
        boolean hadCredential = secrets.configured();
        try { if (hadCredential) token = secrets.read(); } catch (Exception unavailable) { /* Local unlink still succeeds. */ }
        // Local unlink is durable before any revocation network call. Historical data is never removed.
        secrets.clear();
        metadata.edit().clear().commit();
        connectionCheckedAt = 0;
        OnlineSyncScheduler.configure(context, false);
        store.dispatch("syncMeta", new JSONObject().put("bound", false).put("baseUrl", "").put("deviceId", "")
                .put("accounts", new JSONArray()).put("jobs", new JSONArray()).put("errorCode", "").put("error", ""));
        boolean revoked = !hadCredential;
        if (token != null) {
            try { revoked = bindingWriteClient(baseUrl, lan, identity, token).request("DELETE", "/v1/devices/current", null, null).body.optBoolean("revoked"); }
            catch (OnlineClient.Failure failure) { revoked = "device_unauthorized".equals(failure.code); }
            catch (Exception unavailable) { /* Local credential already cleared. */ }
        }
        if (!revoked) store.dispatch("syncMeta", new JSONObject().put("errorCode", "revoke_failed")
                .put("error", "本机已解绑；未能确认后台撤销，请到后台撤销此设备授权"));
        WidgetRenderer.updateAll(context);
        return store.snapshot();
    }
    private JSONObject recordFailure(Exception error) throws Exception {
        String code = "network_error", message = "无法连接同步服务，请检查网络后重试；本地数据已保留";
        if (error instanceof OnlineClient.Failure) { code = ((OnlineClient.Failure) error).code; message = error.getMessage(); }
        JSONObject patch = new JSONObject().put("errorCode", code).put("error", message);
        if ("device_unauthorized".equals(code) || "credentials_unavailable".equals(code)) {
            rotateAiSession();
            secrets.clear();
            metadata.edit().remove("etag").commit();
            patch.put("bound", false);
            patch.put("jobs", new JSONArray());
            OnlineSyncScheduler.configure(context, false);
        }
        return store.dispatch("syncMeta", patch);
    }
    static JSONArray operationBatch(JSONArray operations, int offset) throws Exception {
        JSONArray result = new JSONArray();
        for (int i = offset; i < Math.min(offset + 100, operations.length()); i++) {
            JSONObject operation = operations.getJSONObject(i);
            String action = operation.optString("action"), id = operation.optString("id");
            if (id.isEmpty() || id.length() > 200 || operation.optLong("occurredAt") <= 0)
                throw new OnlineClient.Failure("invalid_operation", "离线操作格式无效，已保留本地记录");
            JSONObject value = new JSONObject().put("id", id).put("action", action).put("occurredAt", operation.getLong("occurredAt"));
            if ("setOrderDate".equals(action)) {
                String order = operation.optString("orderId");
                Object date = operation.opt("date");
                if (!order.matches("[0-9a-f]{32}") || !operation.has("date")
                        || !(date == JSONObject.NULL || date instanceof String && validDate((String) date)))
                    throw new OnlineClient.Failure("invalid_operation", "离线日期修改格式无效，已保留本地记录");
                value.put("orderId", order).put("date", date);
            } else {
                String shipment = operation.optString("shipmentId");
                if (!("pick".equals(action) || "restore".equals(action) || "resumeAutoPickup".equals(action) || "hide".equals(action) || "unhide".equals(action))
                        || shipment.isEmpty() || shipment.length() > 200)
                    throw new OnlineClient.Failure("invalid_operation", "离线操作格式无效，已保留本地记录");
                value.put("shipmentId", shipment);
                if (operation.has("pickedAt")) {
                    Object raw = operation.get("pickedAt");
                    double confirmedAt = raw instanceof Number ? ((Number) raw).doubleValue() : Double.NaN;
                    if (!"pick".equals(action) || Double.isNaN(confirmedAt) || Double.isInfinite(confirmedAt)
                            || confirmedAt < 0 || confirmedAt > 9007199254740991D || confirmedAt != Math.floor(confirmedAt)
                            || confirmedAt > operation.getLong("occurredAt"))
                        throw new OnlineClient.Failure("invalid_operation", "离线领取时间无效，已保留本地记录");
                    value.put("pickedAt", ((Number) raw).longValue());
                }
                if (operation.has("pickupCycleId")) {
                    String cycle = operation.optString("pickupCycleId");
                    if (!cycle.matches("[A-Za-z0-9_-]{1,128}")) throw invalidResponse();
                    value.put("pickupCycleId", cycle);
                }
            }
            result.put(value);
        }
        return result;
    }
    static JSONArray acknowledged(JSONArray sent, JSONArray returned) throws Exception {
        if (returned == null) throw invalidResponse();
        Set<String> allowed = new HashSet<>(), consumed = new HashSet<>();
        for (int i = 0; i < sent.length(); i++) allowed.add(sent.getJSONObject(i).getString("id"));
        JSONArray accepted = new JSONArray();
        for (int i = 0; i < returned.length(); i++) {
            String id = returned.optString(i);
            if (allowed.contains(id) && consumed.add(id)) accepted.put(id);
        }
        return accepted;
    }
    static void validateSnapshot(JSONObject data) throws Exception {
        if (data == null || data.optInt("schemaVersion") != 1 || !(data.opt("serverRevision") instanceof Number)
                || data.optLong("serverRevision", -1) < 0 || data.optDouble("serverRevision") != data.optLong("serverRevision"))
            throw invalidResponse();
        boolean metadataOnly = Boolean.TRUE.equals(data.opt("metadataOnly"));
        if (data.has("metadataOnly") && !(data.opt("metadataOnly") instanceof Boolean)) throw invalidResponse();
        if (metadataOnly && (data.optInt("projectionVersion") != 2 || !data.optString("dataVersion").matches("[a-f0-9]{64}")))
            throw invalidResponse();
        for (String key : metadataOnly ? new String[]{"accounts"} : new String[]{"accounts", "orders", "shipments", "hiddenIds", "deletedIds"})
            if (data.optJSONArray(key) == null) throw invalidResponse();
        if (metadataOnly) for (String key : new String[]{"orders", "shipments", "hiddenIds", "deletedIds", "shipmentAliases", "shipmentIdentifiers", "events"})
            if (data.has(key)) throw invalidResponse();
        if (data.has("syncJobs")) { if (data.optJSONArray("syncJobs") == null) throw invalidResponse(); safeJobs(data.getJSONArray("syncJobs")); }
        for (String key : new String[]{"familyIds", "legacyAccountIds"}) if (data.has(key)) safeScopeIds(data.optJSONArray(key));
        if (data.has("families")) { if (data.optJSONArray("families") == null) throw invalidResponse(); safeFamilies(data.getJSONArray("families")); }
        if (data.has("serverVersion") && (!(data.opt("serverVersion") instanceof String) || data.getString("serverVersion").length() > 100)) throw invalidResponse();
        if (data.has("capabilities")) {
            JSONArray capabilities = data.optJSONArray("capabilities");
            if (capabilities == null || capabilities.length() > 50) throw invalidResponse();
            for (int i = 0; i < capabilities.length(); i++)
                if (!(capabilities.opt(i) instanceof String) || capabilities.getString(i).length() > 100) throw invalidResponse();
        }
        if (data.has("stationRules") || data.has("stationRulesVersion")) {
            if (!(data.opt("stationRulesVersion") instanceof Number) || data.optLong("stationRulesVersion", -1) < 0
                    || data.optDouble("stationRulesVersion") != data.optLong("stationRulesVersion")) throw invalidResponse();
            safeStationRules(data.optJSONArray("stationRules"));
        }
        if (data.has("serverLogisticsRules") || data.has("serverLogisticsRulesVersion")) {
            if (!(data.opt("serverLogisticsRulesVersion") instanceof Number) || data.optLong("serverLogisticsRulesVersion", -1) < 0
                    || data.optDouble("serverLogisticsRulesVersion") != data.optLong("serverLogisticsRulesVersion")) throw invalidResponse();
            safeServerLogisticsRules(data.optJSONArray("serverLogisticsRules"));
        }
        if (data.has("matchingFeedback")) safeMatchingFeedbackSummary(data.optJSONObject("matchingFeedback"));
        if (data.has("recognitionIssues")) safeRecognitionIssues(data.optJSONArray("recognitionIssues"));
    }
    static boolean matchingFeedbackEnabled(JSONObject snapshot) {
        JSONObject settings = snapshot == null ? null : snapshot.optJSONObject("settings"), online = snapshot == null ? null : snapshot.optJSONObject("online");
        JSONObject feedback = snapshot == null ? null : snapshot.optJSONObject("matchingFeedback");
        boolean enabled = settings != null && (!settings.has("manualLearning") || Boolean.TRUE.equals(settings.opt("manualLearning")));
        return online != null && online.optBoolean("bound") && hasCapability(online, "matching_feedback_v1")
                && (enabled || feedback != null && feedback.optInt("pendingWithdrawalCount") > 0);
    }
    static boolean enhancementEnabled(JSONObject snapshot) { return stationCandidatesEnabled(snapshot) || matchingFeedbackEnabled(snapshot) || recognitionEnabled(snapshot); }
    static boolean recognitionEnabled(JSONObject snapshot) {
        JSONObject online = snapshot == null ? null : snapshot.optJSONObject("online");
        return online != null && online.optBoolean("bound") && hasCapability(online, "recognition_workflow_v1");
    }
    private void scheduleRecognitionIssues() {
        try {
            if (recognitionUploadRunning || !secrets.configured() || !recognitionEnabled(store.snapshot())) return;
            final long generation = sessionGeneration;
            final String base = metadata.getString("baseUrl", ""), device = metadata.getString("deviceId", ""), token = secrets.read();
            final String lan = metadata.getString("lanBaseUrl", ""), identity = metadata.getString("serviceId", "");
            recognitionUploadRunning = true;
            STATION_UPLOADS.execute(() -> uploadRecognitionIssues(generation, base, device, token, lan, identity));
        } catch (Exception unavailable) { recognitionUploadRunning = false; }
    }
    private boolean sameRecognitionSession(long generation, String base, String device, String token) throws Exception {
        return generation == sessionGeneration && secrets.configured() && base.equals(metadata.getString("baseUrl", ""))
                && device.equals(metadata.getString("deviceId", "")) && token.equals(secrets.read()) && recognitionEnabled(store.snapshot());
    }
    private void uploadRecognitionIssues(long generation, String base, String device, String token, String lan, String identity) {
        try {
            JSONArray batch;
            synchronized (this) {
                if (!sameRecognitionSession(generation, base, device, token)) return;
                batch = recognitionIssueBatch(store.dispatch("recognitionIssueBatch", new JSONObject()).optJSONArray("items"));
                if (batch.length() == 0) return;
            }
            JSONObject response = bindingWriteClient(base, lan, identity, token).request("POST", "/v1/recognition-issues",
                    new JSONObject().put("schemaVersion", 1).put("items", batch), null).body;
            synchronized (this) {
                if (!sameRecognitionSession(generation, base, device, token)) return;
                JSONObject acknowledgement = recognitionIssueAcknowledgement(batch, response);
                store.dispatch("recognitionIssueAck", acknowledgement);
                if (acknowledgement.getJSONArray("accepted").length() > 0)
                    OnlineSyncScheduler.followupEnhancement(context, aiSessionKey());
            }
        } catch (Exception unavailable) {
            try {
                synchronized (this) {
                    if (sameRecognitionSession(generation, base, device, token)) store.dispatch("recognitionIssueFailed", new JSONObject());
                }
            } catch (Exception ignored) { /* Keep the same report revision for the next ordinary synchronization. */ }
        } finally {
            synchronized (this) { recognitionUploadRunning = false; }
        }
    }
    private static boolean recognitionTime(JSONObject input, String key) {
        return input != null && input.opt(key) instanceof Number && input.optDouble(key) == input.optLong(key)
                && input.optLong(key) >= 0 && input.optLong(key) <= 9007199254740991L;
    }
    static JSONArray recognitionIssueBatch(JSONArray items) throws Exception {
        JSONArray safe = new JSONArray();
        if (items == null) return safe;
        for (int index = 0; index < Math.min(items.length(), 20); index++) {
            JSONObject item = items.optJSONObject(index), source = item == null ? null : item.optJSONObject("source");
            if (!feedbackRevision(item) || !recognitionTime(item, "observedAt") || source == null || !source.has("occurredAt") || !source.isNull("occurredAt") && !recognitionTime(source, "occurredAt")) throw invalidResponse();
            String id = boundedText(item, "id", 128, true), sourceId = boundedText(item, "sourceId", 128, true), state = boundedText(item, "state", 20, true);
            if (!id.matches("[A-Za-z0-9_-]{1,128}") || !sourceId.matches("[A-Za-z0-9_-]{1,128}") || !state.matches("unresolved|resolved|withdrawn") || !"unmatched_pickup".equals(item.optString("kind"))) throw invalidResponse();
            JSONObject safeSource = new JSONObject().put("occurredAt", source.isNull("occurredAt") ? JSONObject.NULL : source.getLong("occurredAt"));
            for (String key : new String[]{"station", "carrier", "fragment"}) {
                String value = boundedText(source, key, "carrier".equals(key) ? 40 : 120, false);
                if (value.matches("(?is).*(?:https?://|www\\.|[0-9]{6,}|验证码|密码|取件码|取货码|手机号|运单号|订单号|先生|女士|收件人).*")) throw invalidResponse();
                safeSource.put(key, value);
            }
            String waybill = boundedText(source, "waybillNo", 32, false), code = boundedText(source, "pickupCode", 12, false);
            if (!waybill.isEmpty() && !waybill.matches("[A-Za-z0-9-]{6,32}") || !code.isEmpty() && (!code.matches("[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*") || !code.matches(".*[0-9].*") || code.length() < 3 || code.matches("[0-9]{9,}"))) throw invalidResponse();
            safeSource.put("waybillNo", "").put("pickupCode", "");
            JSONObject value = new JSONObject().put("id", id).put("revision", item.getLong("revision")).put("kind", "unmatched_pickup")
                    .put("state", state).put("sourceId", sourceId).put("observedAt", item.getLong("observedAt")).put("source", safeSource);
            for (String key : new String[]{"candidateShipmentIds", "reasonCodes"}) {
                JSONArray input = item.optJSONArray(key), values = new JSONArray();
                if (input == null || input.length() > 20 || "candidateShipmentIds".equals(key) && !"withdrawn".equals(state) && input.length() == 0) throw invalidResponse();
                Set<String> seen = new HashSet<>();
                for (int i = 0; i < input.length(); i++) {
                    Object raw = input.opt(i);
                    if (!(raw instanceof String) || !((String) raw).matches("reasonCodes".equals(key) ? "[a-z_]{1,80}" : "[A-Za-z0-9_-]{1,128}")) throw invalidResponse();
                    if (seen.add((String) raw)) values.put(raw);
                }
                value.put(key, values);
            }
            safe.put(value);
        }
        return safe;
    }
    static JSONArray safeRecognitionIssues(JSONArray input) throws Exception {
        if (input == null || input.length() > 500) throw invalidResponse();
        JSONArray safe = new JSONArray();
        for (int index = 0; index < input.length(); index++) {
            JSONObject item = input.optJSONObject(index);
            if (!feedbackRevision(item) || !recognitionTime(item, "retryCount") || item.optLong("retryCount") > 1000 || !recognitionTime(item, "nextRetryAt")) throw invalidResponse();
            String id = boundedText(item, "id", 128, true), status = boundedText(item, "status", 30, true), reason = boundedText(item, "reasonCode", 80, false);
            if (!id.matches("[A-Za-z0-9_-]{1,128}") || !status.matches("pending|retrying|ai_pending|ai_running|review|resolved|failed|ignored|blocked") || !reason.matches("[A-Za-z0-9_]{0,80}")) throw invalidResponse();
            safe.put(new JSONObject().put("id", id).put("revision", item.getLong("revision")).put("status", status)
                    .put("retryCount", item.getLong("retryCount")).put("reasonCode", reason).put("nextRetryAt", item.getLong("nextRetryAt")));
        }
        return safe;
    }
    static JSONObject recognitionIssueAcknowledgement(JSONArray batch, JSONObject response) throws Exception {
        if (response == null || response.optJSONArray("accepted") == null) throw invalidResponse();
        Set<String> sent = new HashSet<>(), used = new HashSet<>();
        for (int index = 0; index < batch.length(); index++) {
            JSONObject item = batch.getJSONObject(index);sent.add(item.getString("id") + ":" + item.getLong("revision"));
        }
        JSONArray accepted = new JSONArray(), issues = new JSONArray(), returned = safeRecognitionIssues(response.optJSONArray("issues"));
        for (int index = 0; index < response.getJSONArray("accepted").length(); index++) {
            JSONObject item = response.getJSONArray("accepted").optJSONObject(index);
            if (!feedbackRevision(item)) continue;
            String key = item.optString("id") + ":" + item.getLong("revision");
            if (sent.contains(key) && used.add(key)) accepted.put(new JSONObject().put("id", item.getString("id")).put("revision", item.getLong("revision")));
        }
        for (int index = 0; index < returned.length(); index++) {
            JSONObject item = returned.getJSONObject(index);
            if (sent.contains(item.getString("id") + ":" + item.getLong("revision"))) issues.put(item);
        }
        return new JSONObject().put("accepted", accepted).put("issues", issues);
    }
    private void scheduleMatchingFeedback() {
        try {
            if (matchingFeedbackUploadRunning || !secrets.configured() || !matchingFeedbackEnabled(store.snapshot())) return;
            final long generation = sessionGeneration;
            final String base = metadata.getString("baseUrl", ""), device = metadata.getString("deviceId", ""), token = secrets.read();
            final String lan = metadata.getString("lanBaseUrl", ""), identity = metadata.getString("serviceId", "");
            matchingFeedbackUploadRunning = true;
            STATION_UPLOADS.execute(() -> uploadMatchingFeedback(generation, base, device, token, lan, identity));
        } catch (Exception unavailable) { matchingFeedbackUploadRunning = false; }
    }
    private boolean sameMatchingSession(long generation, String base, String device, String token) throws Exception {
        return generation == sessionGeneration && secrets.configured() && base.equals(metadata.getString("baseUrl", ""))
                && device.equals(metadata.getString("deviceId", "")) && token.equals(secrets.read()) && matchingFeedbackEnabled(store.snapshot());
    }
    private void uploadMatchingFeedback(long generation, String base, String device, String token, String lan, String identity) {
        try {
            JSONArray batch;
            synchronized (this) {
                if (!sameMatchingSession(generation, base, device, token)) return;
                batch = matchingFeedbackBatch(store.dispatch("matchingFeedbackBatch", new JSONObject()).optJSONArray("items"));
                if (batch.length() == 0) return;
                store.dispatch("matchingFeedbackAttempt", new JSONObject().put("items", batch));
            }
            // User edits and binding changes remain available during route probing and the POST.
            JSONObject response = bindingWriteClient(base, lan, identity, token).request("POST", "/v1/matching-feedback",
                    new JSONObject().put("items", batch), null).body;
            synchronized (this) {
                if (!sameMatchingSession(generation, base, device, token)) return;
                JSONObject acknowledgement = matchingFeedbackAcknowledgement(batch, response);
                store.dispatch("matchingFeedbackAck", acknowledgement);
                if (acknowledgement.getJSONArray("accepted").length() > 0)
                    OnlineSyncScheduler.followupEnhancement(context, aiSessionKey());
            }
        } catch (Exception unavailable) {
            try {
                synchronized (this) {
                    if (sameMatchingSession(generation, base, device, token)) store.dispatch("matchingFeedbackFailed", new JSONObject());
                }
            } catch (Exception ignored) { /* The durable queue is retried by normal and periodic synchronization. */ }
        } finally {
            synchronized (this) { matchingFeedbackUploadRunning = false; }
        }
    }
    private static boolean feedbackRevision(JSONObject item) {
        Object value = item == null ? null : item.opt("revision");
        return value instanceof Number && item.optDouble("revision") == item.optLong("revision")
                && item.optLong("revision") >= 1 && item.optLong("revision") <= 9007199254740991L;
    }
    static JSONArray matchingFeedbackBatch(JSONArray items) throws Exception {
        JSONArray safe = new JSONArray();
        if (items == null) return safe;
        for (int index = 0; index < Math.min(20, items.length()); index++) {
            JSONObject item = items.optJSONObject(index);
            if (item == null || !feedbackRevision(item)) throw invalidResponse();
            String id = boundedText(item, "id", 128, true), action = boundedText(item, "action", 20, true);
            if (!id.matches("[A-Za-z0-9_-]{1,128}") || !action.matches("upsert|withdraw")) throw invalidResponse();
            JSONObject value = new JSONObject().put("id", id).put("revision", item.getLong("revision")).put("action", action);
            if ("upsert".equals(action)) {
                String kind = boundedText(item, "kind", 30, true), reason = boundedText(item, "reason", 30, false);
                if (!kind.matches("station_correction|manual_match") || !reason.matches("|station_correction|manual_match|user_confirmed")) throw invalidResponse();
                value.put("kind", kind).put("reason", reason);
                for (String key : new String[]{"shipmentId", "targetStationId"}) {
                    String field = boundedText(item, key, 128, false);
                    if (!field.isEmpty() && !field.matches("[A-Za-z0-9_-]{1,128}")) throw invalidResponse();
                    value.put(key, field);
                }
                for (String key : new String[]{"stationName", "otherStationName", "subLocation"}) {
                    String field = boundedText(item, key, "subLocation".equals(key) ? 60 : 120, false);
                    if (field.matches("(?is).*(?:https?://|www\\.|[0-9]{6,}|验证码|取件码|取货码|提货码|手机号|运单号|订单号).*")) throw invalidResponse();
                    value.put(key, field);
                }
                if ("manual_match".equals(kind) && value.getString("shipmentId").isEmpty()
                        || "station_correction".equals(kind) && value.getString("targetStationId").isEmpty()) throw invalidResponse();
            }
            safe.put(value);
        }
        return safe;
    }
    static JSONObject safeMatchingFeedbackSummary(JSONObject input) throws Exception {
        if (input == null || input.optJSONArray("items") == null || input.getJSONArray("items").length() > 500) throw invalidResponse();
        JSONObject safe = new JSONObject();
        for (String flag : new String[]{"configured", "enabled", "autoApply"}) {
            if (!(input.opt(flag) instanceof Boolean)) throw invalidResponse();
            safe.put(flag, input.getBoolean(flag));
        }
        JSONArray items = new JSONArray();
        for (int index = 0; index < input.getJSONArray("items").length(); index++) {
            JSONObject item = input.getJSONArray("items").optJSONObject(index);
            if (item == null || !feedbackRevision(item)) throw invalidResponse();
            String id = boundedText(item, "id", 128, true), status = boundedText(item, "status", 30, true);
            if (!id.matches("[A-Za-z0-9_-]{1,128}") || !status.matches("pending|applied|review|failed|withdrawn|rejected")) throw invalidResponse();
            items.put(new JSONObject().put("id", id).put("revision", item.getLong("revision")).put("status", status)
                    .put("candidateId", boundedText(item, "candidateId", 128, false)).put("error", boundedText(item, "error", 300, false))
                    .put("reasonCode", boundedText(item, "reasonCode", 80, false)).put("message", boundedText(item, "message", 300, false))
                    .put("ruleVersion", Math.max(0, item.optLong("ruleVersion")))
                    .put("updatedAt", Math.max(0, item.optLong("updatedAt"))));
        }
        return safe.put("items", items);
    }
    static JSONObject matchingFeedbackAcknowledgement(JSONArray batch, JSONObject response) throws Exception {
        if (response == null || response.optJSONArray("accepted") == null) throw invalidResponse();
        Set<String> sent = new HashSet<>(), used = new HashSet<>();
        for (int index = 0; index < batch.length(); index++) {
            JSONObject item = batch.getJSONObject(index);
            sent.add(item.getString("id") + ":" + item.getLong("revision"));
        }
        JSONObject safe = safeMatchingFeedbackSummary(response);
        JSONArray accepted = new JSONArray(), items = new JSONArray();
        for (int index = 0; index < response.getJSONArray("accepted").length(); index++) {
            JSONObject item = response.getJSONArray("accepted").optJSONObject(index);
            if (!feedbackRevision(item)) continue;
            String key = item.optString("id") + ":" + item.getLong("revision");
            if (sent.contains(key) && used.add(key)) accepted.put(new JSONObject().put("id", item.getString("id")).put("revision", item.getLong("revision")));
        }
        for (int index = 0; index < safe.getJSONArray("items").length(); index++) {
            JSONObject item = safe.getJSONArray("items").getJSONObject(index);
            if (sent.contains(item.getString("id") + ":" + item.getLong("revision"))) items.put(item);
        }
        return safe.put("accepted", accepted).put("items", items);
    }
    private void scheduleStationCandidates() {
        try {
            if (stationUploadRunning || !secrets.configured() || !stationCandidatesEnabled(store.snapshot())) return;
            final long generation = sessionGeneration;
            final String baseUrl = metadata.getString("baseUrl", ""), deviceId = metadata.getString("deviceId", "");
            stationUploadRunning = true;
            STATION_UPLOADS.execute(() -> uploadStationCandidates(generation, baseUrl, deviceId));
        } catch (Exception ignored) { stationUploadRunning = false; }
    }
    private boolean sameStationSession(long generation, String baseUrl, String deviceId) throws Exception {
        return generation == sessionGeneration && secrets.configured() && baseUrl.equals(metadata.getString("baseUrl", ""))
                && deviceId.equals(metadata.getString("deviceId", "")) && stationCandidatesEnabled(store.snapshot());
    }
    private void uploadStationCandidates(long generation, String baseUrl, String deviceId) {
        try {
            JSONArray batch;
            String token, lan, identity;
            synchronized (this) {
                if (!sameStationSession(generation, baseUrl, deviceId)) return;
                batch = stationCandidateBatch(store.dispatch("stationCandidateBatch", new JSONObject()).optJSONArray("items"));
                if (batch.length() == 0) return;
                token = secrets.read();
                lan = metadata.getString("lanBaseUrl", ""); identity = metadata.getString("serviceId", "");
            }
            // Optional enrichment never holds the session monitor or a SQLite transaction during network I/O.
            JSONArray returned = bindingWriteClient(baseUrl, lan, identity, token).request("POST", "/v1/station-candidates",
                    new JSONObject().put("items", batch), null).body.optJSONArray("acceptedIds");
            synchronized (this) {
                completeStationUpload(generation, baseUrl, deviceId, batch, returned);
            }
        } catch (Exception ignored) {
            try {
                synchronized (this) {
                    if (sameStationSession(generation, baseUrl, deviceId)) store.dispatch("stationCandidateFailed", new JSONObject());
                }
            } catch (Exception unavailable) { /* Order synchronization and the retained queue remain independent. */ }
        } finally {
            synchronized (this) { stationUploadRunning = false; }
        }
    }
    private synchronized void completeStationUpload(long generation, String baseUrl, String deviceId, JSONArray batch, JSONArray returned) throws Exception {
        JSONArray accepted = acknowledged(batch, returned);
        if (!sameStationSession(generation, baseUrl, deviceId) || accepted.length() == 0) return;
        store.dispatch("stationCandidateAck", new JSONObject().put("acceptedIds", accepted).put("uploadedAt", System.currentTimeMillis()));
        // One delayed return imports any new rules and drains the next batch. No progress means no immediate retry loop.
        OnlineSyncScheduler.followupEnhancement(context, aiSessionKey());
    }
    private OnlineClient bindingWriteClient(String baseUrl, String lan, String identity, String token) {
        // The captured binding owns both the candidate and token. Probe outside the store/session transaction,
        // including after durable local unlink, and never replay a potentially committed write.
        BackendRoutes captured = new BackendRoutes(BuildConfig.DEBUG);
        captured.configure(baseUrl, lan, identity);
        return new OnlineClient(captured.select(networkKey())[0], token, BuildConfig.DEBUG);
    }
    static boolean stationCandidatesEnabled(JSONObject snapshot) {
        JSONObject settings = snapshot == null ? null : snapshot.optJSONObject("settings"), online = snapshot == null ? null : snapshot.optJSONObject("online");
        return settings != null && Boolean.TRUE.equals(settings.opt("stationEnhancement")) && online != null
                && online.optBoolean("bound") && hasCapability(online, "station_aliases_v1");
    }
    static JSONArray stationCandidateBatch(JSONArray items) throws Exception {
        JSONArray safe = new JSONArray();
        if (items == null) return safe;
        for (int i = 0; i < Math.min(items.length(), 20); i++) {
            JSONObject item = items.optJSONObject(i);
            if (item == null) throw invalidResponse();
            String id = boundedText(item, "id", 100, true), name = boundedText(item, "stationName", 120, true);
            String fragment = boundedText(item, "fragment", 400, true);
            if (!id.matches("[A-Za-z0-9_-]{1,100}") || !"sms".equals(item.optString("source"))
                    || (name + fragment).matches("(?is).*(?:https?://|www\\.|[0-9]{6,}|验证码|取件码|取货码|提货码|手机号|运单号|订单号).*") ) throw invalidResponse();
            JSONObject value = new JSONObject().put("id", id).put("stationName", name).put("fragment", fragment).put("source", "sms");
            if (item.has("region")) value.put("region", boundedText(item, "region", 120, false));
            safe.put(value);
        }
        return safe;
    }
    static JSONArray safeStationRules(JSONArray rules) throws Exception {
        if (rules == null || rules.length() > 1000) throw invalidResponse();
        JSONArray safe = new JSONArray(); Set<String> ids = new HashSet<>();
        for (int i = 0; i < rules.length(); i++) {
            JSONObject rule = rules.optJSONObject(i);
            if (rule == null) throw invalidResponse();
            String id = boundedText(rule, "id", 100, true), name = boundedText(rule, "name", 120, true);
            if (!ids.add(id) || rule.has("enabled") && !(rule.opt("enabled") instanceof Boolean)) throw invalidResponse();
            JSONArray aliases = rule.optJSONArray("aliases");
            if (aliases == null || aliases.length() > 200) throw invalidResponse();
            JSONArray safeAliases = new JSONArray();
            for (int j = 0; j < aliases.length(); j++) {
                JSONObject alias = aliases.optJSONObject(j);
                if (alias == null) throw invalidResponse();
                safeAliases.put(new JSONObject().put("id", boundedText(alias, "id", 100, false))
                        .put("name", boundedText(alias, "name", 120, true)).put("source", boundedText(alias, "source", 40, false))
                        .put("subLocation", boundedText(alias, "subLocation", 120, false)));
            }
            Object revision = rule.opt("revision");
            if (rule.has("revision") && (!(revision instanceof Number) || rule.optLong("revision", -1) < 0
                    || rule.optDouble("revision") != rule.optLong("revision"))) throw invalidResponse();
            safe.put(new JSONObject().put("id", id).put("name", name).put("region", boundedText(rule, "region", 120, false))
                    .put("enabled", rule.optBoolean("enabled", true)).put("aliases", safeAliases).put("revision", rule.optLong("revision")));
        }
        return safe;
    }
    static JSONArray safeServerLogisticsRules(JSONArray rules) throws Exception {
        if (rules == null || rules.length() > 100 || rules.toString().length() > 60000) throw invalidResponse();
        JSONArray safe = new JSONArray(); Set<String> ids = new HashSet<>();
        for (int i = 0; i < rules.length(); i++) {
            JSONObject rule = rules.optJSONObject(i); if (rule == null) throw invalidResponse();
            String id = boundedText(rule, "id", 80, true), kind = boundedText(rule, "kind", 20, true), origin = boundedText(rule, "origin", 20, true);
            if (!id.matches("[A-Za-z0-9_-]+") || !ids.add(id) || !(rule.opt("enabled") instanceof Boolean)
                    || !kind.matches("arrival|location") || !origin.matches("builtin|manual")) throw invalidResponse();
            JSONObject value = new JSONObject().put("id", id).put("name", boundedText(rule, "name", 80, true))
                    .put("enabled", rule.getBoolean("enabled")).put("kind", kind).put("origin", origin).put("end", boundedText(rule, "end", 80, false));
            for (String field : new String[]{"starts", "keywords"}) {
                JSONArray phrases = rule.optJSONArray(field), cleaned = new JSONArray();
                if (phrases == null || phrases.length() > (field.equals("starts") ? 20 : 10) || field.equals("starts") && phrases.length() == 0) throw invalidResponse();
                for (int j = 0; j < phrases.length(); j++) {
                    if (!(phrases.opt(j) instanceof String)) throw invalidResponse();
                    String phrase = phrases.getString(j);
                    if (phrase.trim().isEmpty() || phrase.length() > 80 || phrase.matches("(?s).*[\\x00-\\x1f\\x7f，,。；;！？!?].*")) throw invalidResponse();
                    cleaned.put(phrase);
                }
                value.put(field, cleaned);
            }
            safe.put(value);
        }
        return safe;
    }
    private static String boundedText(JSONObject object, String key, int max, boolean required) throws Exception {
        Object raw = object.opt(key);
        if (raw == null && !required) return "";
        if (!(raw instanceof String)) throw invalidResponse();
        String value = ((String) raw).trim();
        if (value.length() > max || required && value.isEmpty() || value.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw invalidResponse();
        return value;
    }
    static JSONArray safeAccounts(JSONArray accounts) throws Exception {
        JSONArray safe = new JSONArray();
        if (accounts == null) return safe;
        for (int i = 0; i < Math.min(accounts.length(), 100); i++) {
            JSONObject account = accounts.getJSONObject(i), value = new JSONObject();
            for (String key : new String[]{"id", "platform", "label", "status", "familyId", "familyName"}) {
                value.put(key, safeText(account, key, 200));
            }
            String status = account.optString("status");
            value.put("enabled", !Boolean.FALSE.equals(account.opt("enabled")));
            value.put("lastSuccessAt", Math.max(0, account.optLong("lastSuccessAt")));
            Object fullSuccess = account.opt("lastFullSuccessAt");
            double completedAt = fullSuccess instanceof Number ? ((Number) fullSuccess).doubleValue() : 0;
            value.put("lastFullSuccessAt", !Double.isNaN(completedAt) && !Double.isInfinite(completedAt) && completedAt > 0 && completedAt <= 9007199254740991D
                    && completedAt == Math.floor(completedAt) ? ((Number) fullSuccess).longValue() : 0);
            value.put("lastAttemptAt", Math.max(0, account.optLong("lastAttemptAt")));
            value.put("warnings", safeWarnings(account.optJSONArray("warnings")));
            value.put("error", "expired".equals(status) ? "后台账号登录已失效，请在后台更新登录信息"
                    : account.optString("error").isEmpty() ? "" : "后台采集未完成，请到后台查看账号状态");
            safe.put(value);
        }
        return safe;
    }
    static JSONArray safeFamilies(JSONArray families) throws Exception {
        JSONArray safe = new JSONArray();
        if (families == null) return safe;
        if (families.length() > 100) throw invalidResponse();
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < families.length(); i++) {
            JSONObject family = families.optJSONObject(i);
            if (family == null) throw invalidResponse();
            String id = safeText(family, "id", 101), name = safeText(family, "name", 201);
            if (!id.matches("[A-Za-z0-9_-]{1,100}") || !seen.add(id) || name.trim().isEmpty() || name.length() > 200 || name.matches("(?s).*[\\x00-\\x1f\\x7f].*")) throw invalidResponse();
            safe.put(new JSONObject().put("id", id).put("name", name));
        }
        return safe;
    }
    static JSONObject copyFamilyScope(JSONObject target, JSONObject source) throws Exception {
        // Absence identifies old servers; never manufacture an empty family scope for legacy snapshots.
        for (String key : new String[]{"familyIds", "legacyAccountIds"}) if (source.has(key)) target.put(key, safeScopeIds(source.optJSONArray(key)));
        return target;
    }
    static JSONArray safeScopeIds(JSONArray ids) throws Exception {
        if (ids == null || ids.length() > 200) throw invalidResponse();
        Set<String> seen = new HashSet<>(); JSONArray safe = new JSONArray();
        for (int i = 0; i < ids.length(); i++) {
            Object value = ids.opt(i);
            if (!(value instanceof String) || !((String) value).matches("[A-Za-z0-9_-]{1,100}") || !seen.add((String) value)) throw invalidResponse();
            safe.put(value);
        }
        return safe;
    }
    static boolean hasCapability(JSONObject online, String capability) {
        JSONArray capabilities = online == null ? null : online.optJSONArray("capabilities");
        if (capabilities != null) for (int i = 0; i < capabilities.length(); i++)
            if (capability.equals(capabilities.opt(i))) return true;
        return false;
    }
    static JSONArray safeWarnings(JSONArray warnings) {
        JSONArray safe = new JSONArray();
        Set<String> seen = new HashSet<>();
        if (warnings == null) return safe;
        for (int i = 0; i < Math.min(20, warnings.length()); i++) {
            Object raw = warnings.opt(i);
            if (!(raw instanceof String) || ((String) raw).isEmpty()) continue;
            String warning = (String) raw, message;
            if (warning.matches("订单筛选：本轮保留[0-9]{1,6}笔，跳过[0-9]{1,6}笔已结束或非待收货订单")) message = warning;
            else if (warning.contains("日期")) message = "部分下单日期暂未取得，已有日期已保留";
            else if (warning.contains("物流") || warning.contains("轨迹")) message = "部分物流暂不可用，已有轨迹已保留";
            else if (warning.contains("取件码") || warning.contains("驿站")) message = "部分取件信息暂不可用，已有记录已保留";
            else if (warning.contains("分页") || warning.contains("筛选")) message = "平台订单列表可能不完整，已有记录已保留";
            else message = "部分同步信息暂不可用，请在后台查看";
            if (seen.add(message)) safe.put(message);
        }
        return safe;
    }
    static JSONArray safeJobs(JSONArray jobs) throws Exception {
        JSONArray safe = new JSONArray();
        if (jobs == null) return safe;
        if (jobs.length() > MAX_JOBS) throw invalidResponse();
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.optJSONObject(i);
            if (job == null) throw invalidResponse();
            for (String field : new String[]{"id", "accountId", "orderId", "state"})
                if (!(job.opt(field) instanceof String)) throw invalidResponse();
            String id = safeText(job, "id", 101), accountId = safeText(job, "accountId", 101), orderId = safeText(job, "orderId", 33);
            String state = safeText(job, "state", 40);
            if (!id.matches("[A-Za-z0-9_-]{1,100}") || !ids.add(id) || !accountId.matches("[A-Za-z0-9_-]{1,100}")
                    || !(orderId.isEmpty() || orderId.matches("[0-9a-f]{32}"))
                    || !state.matches("queued|running|completed|error|cooldown|disabled|expired")) throw invalidResponse();
            boolean pending = "queued".equals(state) || "running".equals(state);
            JSONObject value = new JSONObject().put("id", id).put("accountId", accountId).put("orderId", orderId).put("state", state)
                    .put("retryAt", Math.max(0, job.optLong("retryAt")));
            JSONObject progress = job.optJSONObject("logisticsProgress");
            if (progress != null) {
                JSONObject counts = new JSONObject();
                for (String field : new String[]{"total", "completed", "active", "attempts", "durationMs"}) counts.put(field, progressCount(progress.opt(field)));
                counts.put("completed", Math.min(counts.getInt("total"), counts.getInt("completed")));
                counts.put("active", Math.min(counts.getInt("total") - counts.getInt("completed"), counts.getInt("active")));
                value.put("logisticsProgress", counts);
            }
            if (job.has("retryCount")) value.put("retryCount", progressCount(job.opt("retryCount")));
            for (String field : new String[]{"continuation", "throttled"}) if (job.has(field)) value.put(field, Boolean.TRUE.equals(job.opt(field)));
            if (job.has("familyId")) {
                String family = safeText(job, "familyId", 101);
                if (!family.isEmpty() && !family.matches("[A-Za-z0-9_-]{1,100}")) throw invalidResponse();
                value.put("familyId", family);
            }
            for (String time : new String[]{"createdAt", "updatedAt", "startedAt", "finishedAt"}) if (job.has(time)) {
                if (!(job.opt(time) instanceof Number) || job.optLong(time, -1) < 0 || job.optDouble(time) != job.optLong(time)) throw invalidResponse();
                value.put(time, job.getLong(time));
            }
            String error = "error".equals(state) ? "后台采集未完成，请稍后重试" : "expired".equals(state) ? "后台账号登录已失效，请更新登录信息"
                    : "disabled".equals(state) ? "后台账号已停用，请在后台启用" : "cooldown".equals(state)
                    ? value.getLong("retryAt") > System.currentTimeMillis() ? "后台处于采集冷却期，请稍后重新获取" : "本次采集未执行，现可重新获取订单" : "";
            for (String kind : new String[]{"date", "logistics"}) {
                String detailState = safeText(job, kind + "State", 40);
                if (!detailState.isEmpty()) {
                    if (!detailState.matches("ok|empty|error|unavailable|unknown")) throw invalidResponse();
                    value.put(kind + "State", detailState);
                    String label = kind.equals("date") ? "下单日期" : "物流";
                    String detailError = pending ? "" : detailState.equals("error") ? label + "读取失败，已有信息已保留"
                            : detailState.equals("unavailable") || detailState.equals("empty") || detailState.equals("unknown") ? "平台暂未提供可用" + label : "";
                    if (!pending && !job.optString(kind + "Error").isEmpty() && detailError.isEmpty()) detailError = label + "补查未完成，请稍后重试";
                    value.put(kind + "Error", detailError);
                }
            }
            boolean partial = !value.optString("dateError").isEmpty() || !value.optString("logisticsError").isEmpty();
            if (!pending && error.isEmpty() && !job.optString("error").isEmpty() && !("completed".equals(state) && partial))
                error = "后台部分采集未完成，请稍后重试";
            value.put("error", error);
            safe.put(value);
        }
        return safe;
    }
    private static int progressCount(Object value) {
        if (!(value instanceof Number)) return 0;
        double number = ((Number) value).doubleValue();
        return Double.isFinite(number) ? (int) Math.max(0, Math.min(100000, number)) : 0;
    }
    static JSONArray mergeStartedJobs(JSONArray previous, JSONArray started) throws Exception {
        Map<String, JSONObject> result = new LinkedHashMap<>();
        for (int i = 0; i < previous.length(); i++) {
            JSONObject job = previous.getJSONObject(i);
            boolean superseded = false;
            for (int j = 0; j < started.length(); j++) {
                JSONObject next = started.getJSONObject(j);
                if (job.getString("accountId").equals(next.getString("accountId"))
                        && (next.getString("orderId").isEmpty() || job.getString("orderId").equals(next.getString("orderId")))) superseded = true;
            }
            if (pendingJob(job) || !superseded) result.put(job.getString("id"), job);
        }
        for (int i = 0; i < started.length(); i++) {
            JSONObject job = started.getJSONObject(i);
            result.put(job.getString("id"), job);
        }
        JSONArray jobs = new JSONArray();
        for (JSONObject job : result.values()) jobs.put(job);
        return safeJobs(jobs);
    }
    static boolean pendingJob(JSONObject job) { return "queued".equals(job.optString("state")) || "running".equals(job.optString("state")); }
    static String jobsError(JSONArray jobs) {
        String cooldownError = "";
        for (int i = 0; i < jobs.length(); i++) {
            JSONObject job = jobs.optJSONObject(i);
            if (job != null && !pendingJob(job) && !job.optString("error").isEmpty()) {
                if ("cooldown".equals(job.optString("state"))) cooldownError = job.optString("error");
                else return job.optString("error");
            }
        }
        return cooldownError;
    }
    static boolean validDate(String date) {
        if (date == null || !date.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) return false;
        int year = Integer.parseInt(date.substring(0, 4)), month = Integer.parseInt(date.substring(5, 7)), day = Integer.parseInt(date.substring(8, 10));
        if (year == 0 || month < 1 || month > 12 || day < 1) return false;
        int[] days = {31, year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
        return day <= days[month - 1];
    }
    private static String safeText(JSONObject object, String key, int max) {
        Object value = object.opt(key);
        if (!(value instanceof String)) return "";
        String text = (String) value;
        return text.length() > max ? text.substring(0, max) : text;
    }
    private static OnlineClient.Failure invalidResponse() { return new OnlineClient.Failure("invalid_response", "同步服务返回了无效数据"); }
}
