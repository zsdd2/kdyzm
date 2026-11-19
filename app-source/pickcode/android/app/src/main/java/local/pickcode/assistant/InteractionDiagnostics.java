package local.pickcode.assistant;

import android.os.SystemClock;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Allowlisted telemetry with a bounded, binding-scoped queue of failure summaries. */
final class InteractionDiagnostics {
    static final String CAPABILITY = "interaction_diagnostics_v1";
    static final String CORRELATION_CAPABILITY = "interaction_diagnostics_v2";
    static final String PATH = "/v1/device/diagnostics";
    private static final int MAX_RING = 128;
    private static final int MAX_BATCH = 50;
    static final int MAX_FAILURES = 16;
    private static final String STAGES = "sync|request|validation|import|store_lock|database_read|upgrade_backup|core_init|core_execute|json|projection|persistence|cursor_commit|ack";
    private static final String ERRORS = "none|network|unauthorized|invalid_response|stale_snapshot|stage_failed|cursor_failed|ack_rejected|collection_failed|credentials_unavailable|unavailable";
    private static final String[] V2_FIELDS = {"operationId", "appBuild", "dataVersion", "stage", "errorCode", "durationCapped", "failureSummary", "failureCapacity", "failureRetained", "failureDropped"};
    private static final long RETRY_DELAY_MS = 30_000L;
    private static final long MAX_AGE_MS = 604_800_000L;
    private static final ExecutorService UPLOADS = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "pickcode-interaction-diagnostics");
        thread.setDaemon(true);
        return thread;
    });

    private static final class Entry {
        final long sequence;
        final long createdAtMs;
        final JSONObject payload;
        final String reason;
        Entry(long sequence, long createdAtMs, JSONObject payload, String reason) {
            this.sequence = sequence;
            this.createdAtMs = createdAtMs;
            this.payload = payload;
            this.reason = reason;
        }
    }

    private final Object lock = new Object();
    private final ArrayDeque<Entry> ring = new ArrayDeque<>();
    private final ArrayDeque<Entry> failures = new ArrayDeque<>();
    private final SharedPreferences preferences;
    private long failureDropped;
    private long nextSequence;
    private long droppedCount;
    private String session = "";
    private String bindingEpoch = "";
    private boolean uploadRunning;
    private long retryNotBefore;

    InteractionDiagnostics() { this(null); }
    InteractionDiagnostics(SharedPreferences preferences) { this.preferences = preferences; }

    void resumeSession() { resumeSession(""); }

    void resumeSession(String epoch) {
        synchronized (lock) {
            if (session.isEmpty()) {
                bindingEpoch = safeEpoch(epoch);
                session = UUID.randomUUID().toString();
                restoreFailuresLocked();
            }
        }
    }

    void startSession() { startSession(""); }

    void startSession(String epoch) {
        synchronized (lock) {
            bindingEpoch = safeEpoch(epoch);
            session = UUID.randomUUID().toString();
            ring.clear();
            failures.clear();
            failureDropped = 0;
            persistFailuresLocked();
            droppedCount = 0;
            retryNotBefore = 0;
            addLocked(event("other_device", "success", null, null, 1, null, null, null, "session", null), "");
        }
    }

    void retireSession() {
        synchronized (lock) {
            session = "";
            bindingEpoch = "";
            ring.clear();
            failures.clear();
            failureDropped = 0;
            persistFailuresLocked();
            droppedCount = 0;
            retryNotBefore = 0;
        }
    }

    String currentSession() {
        synchronized (lock) { return session; }
    }

    private static String safeEpoch(String epoch) {
        return epoch != null && epoch.matches("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}") ? epoch : "";
    }

    Operation begin(String trigger) { return new Operation(currentSession(), trigger); }

    final class Operation implements CoreEngine.PhaseObserver {
        final String session;
        final String id = UUID.randomUUID().toString().replace("-", "");
        final String trigger;
        private final long startedAt = SystemClock.elapsedRealtime();
        private String dataVersion = "", failedStage = "", errorCode = "none";
        private boolean finished;

        private Operation(String session, String trigger) {
            this.session = session;
            this.trigger = trigger != null && trigger.matches("manual|passive|order|enhancement") ? trigger : "passive";
        }
        void version(String version) { if (version != null && version.matches("[a-f0-9]{64}")) dataVersion = version; }
        void fail(String stage, Throwable failure) {
            if (!failedStage.isEmpty()) return;
            failedStage = stage != null && stage.matches(STAGES) ? stage : "sync";
            errorCode = classify(failure, failedStage);
        }
        @Override public void record(String stage, long durationMs, boolean success) {
            if (stage == null || !stage.matches(STAGES)) return;
            if (!success) fail(stage, null);
            emit("accounts", "import", stage, success ? "success" : "error", 0, durationMs, 0, 0, null, null);
        }
        void emit(String kind, String phase, String stage, String result, int status, long durationMs,
                  int count, int ackCount, String ackResult, Boolean metadataOnly) {
            JSONObject value = event(kind, result, status, durationMs, count, ackCount,
                    "snapshot".equals(kind) ? "compact" : null, metadataOnly, phase, trigger, ackResult);
            decorate(value, stage, false);
            add(session, value, "");
        }
        private void decorate(JSONObject value, String stage, boolean summary) {
            try {
                value.put("operationId", id).put("appBuild", BuildConfig.VERSION_CODE).put("stage", stage)
                        .put("errorCode", "error".equals(value.optString("result")) ? errorCode : "none")
                        .put("failureSummary", summary);
                if (!dataVersion.isEmpty()) value.put("dataVersion", dataVersion);
            } catch (Exception impossible) { /* Only fixed fields enter this object. */ }
        }
        void finish() {
            if (finished) return;
            finished = true;
            boolean failed = !failedStage.isEmpty();
            JSONObject value = event("sync_job", failed ? "error" : "success", null,
                    SystemClock.elapsedRealtime() - startedAt, 1, null, null, null, "sync", trigger);
            decorate(value, failed ? failedStage : "sync", failed);
            synchronized (lock) {
                if (session.isEmpty() || !session.equals(InteractionDiagnostics.this.session)) return;
                if (!failed) { addLocked(value, trigger); return; }
                if (failures.size() == MAX_FAILURES) { failures.removeFirst(); failureDropped++; }
                failures.addLast(new Entry(++nextSequence, System.currentTimeMillis(), value, ""));
                persistFailuresLocked();
            }
        }
    }

    private static String classify(Throwable failure, String stage) {
        if (failure instanceof OnlineClient.Failure) {
            String code = ((OnlineClient.Failure) failure).code;
            if ("device_unauthorized".equals(code) || "forbidden".equals(code)) return "unauthorized";
            if ("invalid_response".equals(code) || "stale_snapshot".equals(code) || "credentials_unavailable".equals(code)) return code;
            if ("operations_pending".equals(code)) return "ack_rejected";
            if ("collection_incomplete".equals(code)) return "collection_failed";
            return "request".equals(stage) ? "network" : "unavailable";
        }
        if ("request".equals(stage)) return "network";
        if ("validation".equals(stage)) return "invalid_response";
        if ("cursor_commit".equals(stage)) return "cursor_failed";
        return "stage_failed";
    }

    void recordSnapshot(boolean metadataOnly, boolean notModified, boolean full, int status, long durationMs) {
        recordSnapshot(currentSession(), metadataOnly, notModified, full, status, durationMs);
    }

    void recordSnapshot(String expectedSession, boolean metadataOnly, boolean notModified, boolean full, int status, long durationMs) {
        String result = notModified ? "not_modified" : metadataOnly ? "metadata_only" : "success";
        // "full" forces entity refresh but is not a wire mode; all snapshot requests are compact.
        add(expectedSession, event("snapshot", result, status, durationMs, null, null, "compact", metadataOnly, "request", null), "");
    }

    void recordSnapshotFailure(boolean full, long durationMs) {
        recordSnapshotFailure(currentSession(), full, durationMs);
    }

    void recordSnapshotFailure(String expectedSession, boolean full, long durationMs) {
        add(expectedSession, event("snapshot", "error", null, durationMs, null, null, "compact", null, "request", null), "");
    }

    void recordImport(String result, long durationMs, int count) {
        recordImport(currentSession(), result, durationMs, count);
    }

    void recordImport(String expectedSession, String result, long durationMs, int count) {
        add(expectedSession, event("accounts", result, null, durationMs, count, null, null, null, "import", null), "");
    }

    void recordShipmentDetail(String result, int status, long durationMs) {
        recordShipmentDetail(currentSession(), result, status, durationMs, "request");
    }

    void recordShipmentDetail(String expectedSession, String result, int status, long durationMs, String phase) {
        add(expectedSession, event("shipment_detail", result, status, durationMs, null, null, null, null, phase, null), "");
    }

    void recordOperations(String result, int status, long durationMs, int count, int ackCount, String ackResult) {
        recordOperations(currentSession(), result, status, durationMs, count, ackCount, ackResult);
    }

    void recordOperations(String expectedSession, String result, int status, long durationMs, int count, int ackCount, String ackResult) {
        add(expectedSession, event("operations", result, status, durationMs, count, ackCount, null, null, "request", null, ackResult), "");
    }

    void recordSync(String reason, String result, int status, long durationMs, int count) {
        recordSync(currentSession(), reason, result, status, durationMs, count);
    }

    void recordSync(String expectedSession, String trigger, String result, int status, long durationMs, int count) {
        add(expectedSession, event("sync_job", result, status, durationMs, count, null, null, null, "sync", trigger), trigger);
    }

    void scheduleUpload(String baseUrl, String token, boolean development) {
        scheduleUpload(currentSession(), baseUrl, token, development);
    }

    void scheduleUpload(String expectedSession, String baseUrl, String token, boolean development) {
        scheduleUpload(expectedSession, baseUrl, token, development, false);
    }

    void scheduleUpload(String expectedSession, String baseUrl, String token, boolean development, boolean correlationSupported) {
        final List<Entry> batch;
        final String capturedSession;
        synchronized (lock) {
            if (session.isEmpty() || expectedSession == null || !session.equals(expectedSession) || uploadRunning
                    || (ring.isEmpty() && (!correlationSupported || failures.isEmpty())) || SystemClock.elapsedRealtime() < retryNotBefore
                    || baseUrl == null || baseUrl.isEmpty() || token == null || token.isEmpty()) return;
            capturedSession = session;
            batch = new ArrayList<>(MAX_BATCH);
            int count = 0;
            if (correlationSupported) for (Entry entry : failures) { batch.add(entry); count++; }
            for (Entry entry : ring) {
                batch.add(entry);
                if (++count == MAX_BATCH) break;
            }
            uploadRunning = true;
        }
        UPLOADS.execute(() -> {
            boolean success = false;
            int accepted = 0;
            try {
                synchronized (lock) {
                    if (!capturedSession.equals(session)) return;
                }
                JSONArray events = new JSONArray();
                long now = System.currentTimeMillis();
                for (Entry entry : batch) {
                    JSONObject copy = new JSONObject(entry.payload.toString());
                    if (!correlationSupported) for (String key : V2_FIELDS) copy.remove(key);
                    else if (copy.optBoolean("failureSummary")) synchronized (lock) {
                        copy.put("failureCapacity", MAX_FAILURES).put("failureRetained", failures.size())
                                .put("failureDropped", Math.min(10_000, failureDropped));
                    }
                    copy.put("ageMs", Math.max(0, Math.min(MAX_AGE_MS, now - entry.createdAtMs)));
                    events.put(copy);
                }
                JSONObject body = new JSONObject().put("events", events);
                OnlineClient.Response response = new OnlineClient(baseUrl, token, development, null, null, 1_500, 3_000)
                        .request("POST", PATH, body, null);
                JSONObject result = response.body;
                accepted = result == null ? -1 : result.optInt("accepted", -1);
                if (response.status != 202 || accepted < 0 || accepted > batch.size()) throw new IllegalStateException("invalid diagnostics response");
                success = true;
            } catch (Exception ignored) {
                // Diagnostics are best effort and must never affect the originating UI or sync operation.
            } finally {
                synchronized (lock) {
                    if (capturedSession.equals(session)) {
                        if (success) {
                            for (int i = 0; i < accepted; i++) removeSequenceLocked(batch.get(i).sequence);
                            persistFailuresLocked();
                        }
                        // Every attempt, including successful ones, has a 30s cadence.
                        retryNotBefore = SystemClock.elapsedRealtime() + RETRY_DELAY_MS;
                    }
                    uploadRunning = false;
                }
            }
        });
    }

    int pendingCount() {
        synchronized (lock) { return ring.size() + failures.size(); }
    }

    long droppedCount() {
        synchronized (lock) { return droppedCount; }
    }

    boolean uploadRunningForTests() {
        synchronized (lock) { return uploadRunning; }
    }

    JSONArray debugSnapshot() {
        synchronized (lock) {
            JSONArray result = new JSONArray();
            for (Entry entry : ring) {
                try {
                    JSONObject copy = new JSONObject(entry.payload.toString());
                    if (!entry.reason.isEmpty()) copy.put("reason", entry.reason);
                    result.put(copy);
                } catch (Exception ignored) {
                    // Entries are created from fixed fields and cannot fail to copy.
                }
            }
            for (Entry entry : failures) {
                try { result.put(new JSONObject(entry.payload.toString())); }
                catch (Exception ignored) { }
            }
            return result;
        }
    }

    private void add(String expectedSession, JSONObject payload, String reason) {
        synchronized (lock) {
            if (session.isEmpty() || expectedSession == null || !session.equals(expectedSession)) return;
            addLocked(payload, reason);
        }
    }

    private void addLocked(JSONObject payload, String reason) {
        while (ring.size() >= MAX_RING) {
            ring.removeFirst();
            droppedCount++;
        }
        ring.addLast(new Entry(++nextSequence, System.currentTimeMillis(), payload, reason == null ? "" : reason));
    }

    private void removeSequenceLocked(long sequence) {
        for (java.util.Iterator<Entry> iterator = failures.iterator(); iterator.hasNext();) {
            if (iterator.next().sequence == sequence) { iterator.remove(); return; }
        }
        for (java.util.Iterator<Entry> iterator = ring.iterator(); iterator.hasNext();) {
            if (iterator.next().sequence == sequence) {
                iterator.remove();
                return;
            }
        }
    }

    private void persistFailuresLocked() {
        if (preferences == null) return;
        try {
            JSONArray saved = new JSONArray();
            for (Entry entry : failures) saved.put(new JSONObject().put("createdAt", entry.createdAtMs).put("event", entry.payload));
            preferences.edit().putString("bindingEpoch", bindingEpoch).putString("failures", saved.toString())
                    .putLong("dropped", Math.min(10_000, failureDropped)).commit();
        } catch (Exception ignored) { /* Failure reporting must not replace the originating failure. */ }
    }

    private void restoreFailuresLocked() {
        if (preferences == null) return;
        try {
            if (!bindingEpoch.equals(preferences.getString("bindingEpoch", ""))) { persistFailuresLocked(); return; }
            failureDropped = Math.max(0, Math.min(10_000, preferences.getLong("dropped", 0)));
            JSONArray saved = new JSONArray(preferences.getString("failures", "[]"));
            for (int i = Math.max(0, saved.length() - MAX_FAILURES); i < saved.length(); i++) {
                JSONObject wrapper = saved.optJSONObject(i), value = wrapper == null ? null : wrapper.optJSONObject("event");
                if (value == null || !value.optBoolean("failureSummary") || !value.optString("operationId").matches("[a-f0-9]{32}")
                        || !value.optString("stage").matches(STAGES) || !value.optString("errorCode").matches(ERRORS)
                        || "none".equals(value.optString("errorCode")) || !value.optString("trigger").matches("manual|passive|order|enhancement")
                        || value.optInt("appBuild") <= 0 || value.optLong("durationMs", -1) < 0 || value.optLong("durationMs") > 120_000) continue;
                // Rebuild fixed summary fields instead of trusting JSON loaded from disk.
                JSONObject safe = event("sync_job", "error", null, value.optLong("durationMs"), 1, null, null, null, "sync", value.getString("trigger"));
                safe.put("operationId", value.getString("operationId")).put("appBuild", value.getInt("appBuild"))
                        .put("stage", value.getString("stage")).put("errorCode", value.getString("errorCode")).put("failureSummary", true)
                        .put("durationCapped", value.optLong("durationMs") == 120_000);
                if (value.optString("dataVersion").matches("[a-f0-9]{64}")) safe.put("dataVersion", value.getString("dataVersion"));
                failures.addLast(new Entry(++nextSequence, Math.max(0, Math.min(System.currentTimeMillis(), wrapper.optLong("createdAt"))), safe, ""));
            }
            persistFailuresLocked();
        } catch (Exception ignored) { /* A damaged diagnostic queue cannot prevent startup. */ }
    }

    private static JSONObject event(String kind, String result, Integer status, Long durationMs, Integer count,
                                    Integer ackCount, String mode, Boolean metadataOnly, String phase, String trigger) {
        return event(kind, result, status, durationMs, count, ackCount, mode, metadataOnly, phase, trigger, null);
    }

    private static JSONObject event(String kind, String result, Integer status, Long durationMs, Integer count,
                                    Integer ackCount, String mode, Boolean metadataOnly, String phase, String trigger,
                                    String ackResult) {
        try {
            JSONObject event = new JSONObject().put("kind", kind);
            if (result != null) event.put("result", result);
            if (status != null && status >= 100 && status <= 599) event.put("status", status);
            if (durationMs != null) event.put("durationMs", Math.max(0, Math.min(120_000, durationMs))).put("durationCapped", durationMs >= 120_000);
            if (count != null) event.put("count", Math.max(0, Math.min(10_000, count)));
            if (ackCount != null) event.put("ackCount", Math.max(0, Math.min(10_000, ackCount)));
            if (mode != null) event.put("mode", mode);
            if (metadataOnly != null) event.put("metadataOnly", metadataOnly);
            if (phase != null) event.put("phase", phase);
            if (trigger != null) event.put("trigger", trigger);
            if (ackResult != null) event.put("ackResult", ackResult);
            return event;
        } catch (Exception impossible) {
            throw new IllegalStateException("无法构造诊断事件", impossible);
        }
    }
}
