package local.pickcode.assistant;

import org.json.JSONObject;
import org.json.JSONTokener;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Small authenticated transport. TLS trust and hostname verification remain platform defaults. */
public final class OnlineClient {
    static final int MAX_RESPONSE_BYTES = 4_000_000;
    private static final int MAX_REQUEST_BYTES = 2_000_000;
    private String baseUrl;
    private final String token, fallbackBaseUrl;
    private final Runnable onFallback;
    private final int connectTimeout, readTimeout;
    public OnlineClient(String baseUrl, String token, boolean development) {
        this(baseUrl, token, development, null, null, 10_000, 15_000);
    }
    OnlineClient(String baseUrl, String token, boolean development, String fallback, Runnable onFallback,
                 int connectTimeout, int readTimeout) {
        this.baseUrl = OnlineEndpoint.normalize(baseUrl, development);
        if (token != null && !OnlineEndpoint.validToken(token)) throw new IllegalArgumentException("设备凭证格式无效，请重新绑定");
        this.token = token;
        this.fallbackBaseUrl = fallback == null ? null : OnlineEndpoint.normalize(fallback, development);
        this.onFallback = onFallback;
        this.connectTimeout = connectTimeout; this.readTimeout = readTimeout;
    }
    public static final class Failure extends Exception {
        public final String code;
        public Failure(String code, String message) { super(message); this.code = code; }
    }
    public static final class Response {
        public final JSONObject body;
        public final String etag;
        public final boolean notModified;
        Response(JSONObject body, String etag, boolean notModified) { this.body = body; this.etag = etag; this.notModified = notModified; }
    }
    public Response request(String method, String path, JSONObject data, String etag) throws Exception {
        if (!allowedRequest(method, path))
            throw new IllegalArgumentException("不支持此同步端点");
        try { return requestAt(baseUrl, method, path, data, etag); }
        catch (Exception failure) {
            // Reads may be repeated after transport failure. A timed-out write may already have committed.
            boolean unavailable = failure instanceof IOException || failure instanceof Failure && "server_error".equals(((Failure) failure).code);
            if (fallbackBaseUrl == null || baseUrl.equals(fallbackBaseUrl) || !"GET".equals(method) || !unavailable) throw failure;
            if (onFallback != null) onFallback.run();
            baseUrl = fallbackBaseUrl;
            return requestAt(baseUrl, method, path, data, etag);
        }
    }
    private Response requestAt(String origin, String method, String path, JSONObject data, String etag) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(origin + path).openConnection();
        connection.setInstanceFollowRedirects(false); // Never forward a device token through a redirect, even within the origin.
        boolean local = fallbackBaseUrl != null && !origin.equals(fallbackBaseUrl);
        connection.setConnectTimeout(local ? 1_500 : connectTimeout);
        connection.setReadTimeout("/v1/ai/template-proposals".equals(path) ? Math.max(15_000, readTimeout) : local ? 4_000 : readTimeout);
        connection.setRequestMethod(method);
        connection.setRequestProperty("Accept", "application/json");
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setUseCaches(false);
        if (token != null) connection.setRequestProperty("Authorization", "Bearer " + token);
        if (OnlineEndpoint.validEtag(etag) && !etag.isEmpty()) connection.setRequestProperty("If-None-Match", etag);
        try {
            if (data != null) {
                byte[] bytes = data.toString().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_REQUEST_BYTES) throw new Failure("payload_too_large", "本次同步数据过多，请稍后重试");
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream stream = connection.getOutputStream()) { stream.write(bytes); }
            }
            int status = connection.getResponseCode();
            if (status == 304 && "GET".equals(method) && snapshotPath(path) && etag != null && !etag.isEmpty())
                return new Response(null, etag, true);
            if (status >= 300 && status < 400) throw new Failure("redirect_blocked", "同步地址发生跳转，请使用后台提供的 HTTPS 原始地址");
            if (status == 401) throw new Failure(token == null ? "binding_invalid" : "device_unauthorized",
                    token == null ? "绑定码无效或已过期，请从后台重新生成" : "设备授权已失效，请重新绑定；本地历史已保留");
            if (status == 403) throw new Failure("forbidden", "当前设备没有此操作权限，请检查后台授权范围");
            if (path.startsWith("/v1/ai/") && (status < 200 || status >= 300)) {
                if (status == 404) throw new Failure("feature_unavailable", "后台暂不支持统一AI渠道，请升级后台后重试");
                String code = "";
                if (connection.getContentLength() <= 8192) try (InputStream error = connection.getErrorStream()) {
                    if (error != null) {
                        ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[1024]; int count;
                        while ((count = error.read(buffer)) != -1 && bytes.size() + count <= 8192) bytes.write(buffer, 0, count);
                        JSONObject value = parse(bytes.toString(StandardCharsets.UTF_8.name())).optJSONObject("error");
                        if (value != null) code = value.optString("code");
                    }
                } catch (Exception ignored) { /* Provider/error text is never shown or persisted. */ }
                throw aiFailure(status, code);
            }
            if ("/v1/pairing-codes/preview".equals(path) && status == 404)
                throw new Failure("feature_unavailable", "后台暂不支持授权范围核验，请升级后台后重试");
            if ("/v1/pairing-codes/preview".equals(path) && (status == 400 || status == 409 || status == 410))
                throw new Failure("binding_invalid", "授权码无效、已使用或已过期，请从后台重新生成");
            if (status == 404 && path.startsWith("/v1/sync-jobs/"))
                throw new Failure("job_missing", "后台任务状态已失效，请重新刷新；本地记录已保留");
            if (status == 404 && path.startsWith("/v1/orders/"))
                throw new Failure("feature_unavailable", "后台暂不支持此订单刷新，请升级后台并重新同步");
            if (status == 429) throw new Failure("rate_limited", "请求过于频繁，请稍后重试");
            if (status < 200 || status >= 300) throw new Failure("server_error", "同步服务暂不可用，请稍后重试");
            if (connection.getContentLength() > MAX_RESPONSE_BYTES) throw new Failure("response_too_large", "同步数据超过本机安全限制");
            String contentType = connection.getContentType();
            if (contentType == null || !contentType.toLowerCase(java.util.Locale.ROOT).matches("application/json(?:\\s*;.*)?"))
                throw new Failure("invalid_response", "同步服务返回了无效数据");
            JSONObject body;
            try (InputStream stream = connection.getInputStream()) { body = parse(readBounded(stream)); }
            String receivedEtag = connection.getHeaderField("ETag");
            return new Response(body, OnlineEndpoint.validEtag(receivedEtag) ? receivedEtag : "", false);
        } finally { connection.disconnect(); }
    }
    static boolean allowedRequest(String method, String path) {
        if (path == null || method == null) return false;
        if ("GET".equals(method)) return "/v1/ai/channels".equals(path) || "/v1/connection".equals(path) || snapshotPath(path)
                || path.matches("/v1/shipments/[a-f0-9]{32}/logistics") || path.matches("/v1/sync-jobs/[A-Za-z0-9_-]{1,100}");
        if ("POST".equals(method)) return "/v1/devices".equals(path) || "/v1/pairing-codes/preview".equals(path) || "/v1/accounts/sync".equals(path)
                || "/v1/ai/template-proposals".equals(path) || "/v1/operations".equals(path) || "/v1/station-candidates".equals(path) || "/v1/station-proposals".equals(path)
                || "/v1/matching-feedback".equals(path) || "/v1/recognition-issues".equals(path) || "/v1/station-rule-receipts".equals(path)
                || path.matches("/v1/orders/[0-9a-f]{32}/refresh");
        return "DELETE".equals(method) && "/v1/devices/current".equals(path);
    }
    private static boolean snapshotPath(String path) {
        return path != null && path.matches("/v1/snapshot(?:\\?view=compact(?:&dataVersion=[a-f0-9]{64})?)?");
    }
    static Failure aiFailure(int status, String code) {
        switch (code) {
            case "AI_NOT_CONFIGURED": return new Failure("ai_not_configured", "请在后台配置统一AI服务");
            case "AI_DEFAULT_MISSING": return new Failure("ai_default_missing", "后台尚未选择有效的默认AI服务，请联系管理员");
            case "AI_CHANNEL_DISABLED": return new Failure("ai_channel_disabled", "后台默认AI服务已暂停，请联系管理员启用");
            case "AI_CHANNEL_INCOMPLETE": return new Failure("ai_channel_incomplete", "后台默认AI服务配置不完整，请联系管理员补全");
            case "AI_CHANNEL_UNAVAILABLE": return new Failure("ai_channel_unavailable", "后台默认AI服务已暂停或未配置，请联系管理员");
            case "AI_CONFIG_CHANGED": return new Failure("ai_config_changed", "AI渠道设置已变化，请重新准备建议");
            case "AI_DAILY_LIMIT": return new Failure("ai_daily_limit", "今日AI调用已达共享上限，请明天重试或联系管理员");
            case "AI_SAMPLE_UNSAFE": return new Failure("ai_sample_unsafe", "样例未通过脱敏检查，请手动设置模板");
            case "AI_INVALID_RESULT": return new Failure("ai_invalid_result", "AI建议未通过校验，请重试或手动设置模板");
            case "AI_TIMEOUT": return new Failure("ai_timeout", "AI请求超时，请稍后重试");
            case "AI_BUSY": return new Failure("ai_busy", "AI正在准备建议，请稍后重试");
            default: return status == 429 ? new Failure("rate_limited", "请求过于频繁，请稍后重试") : new Failure("ai_unavailable", "AI服务暂不可用，请检查渠道后重试");
        }
    }
    static String readBounded(InputStream stream) throws Exception {
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        byte[] bytes = new byte[8192];
        int count;
        while ((count = stream.read(bytes)) != -1) {
            if (result.size() + count > MAX_RESPONSE_BYTES) throw new Failure("response_too_large", "同步数据超过本机安全限制");
            result.write(bytes, 0, count);
        }
        return result.toString(StandardCharsets.UTF_8.name());
    }
    static JSONObject parse(String raw) throws Exception {
        try {
            JSONTokener parser = new JSONTokener(raw);
            Object value = parser.nextValue();
            if (!(value instanceof JSONObject) || parser.nextClean() != 0) throw new IllegalArgumentException();
            return (JSONObject) value;
        } catch (Exception malformed) { throw new Failure("invalid_response", "同步服务返回了无效数据"); }
    }
}
