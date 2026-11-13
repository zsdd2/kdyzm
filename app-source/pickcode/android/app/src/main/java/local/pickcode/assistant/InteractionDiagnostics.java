package local.pickcode.assistant;

import android.os.SystemClock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** In-memory, allowlisted interaction telemetry. Raw user, shipment and transport data never enters this class. */
final class InteractionDiagnostics {
    static final String CAPABILITY = "interaction_diagnostics_v1";
    static final String PATH = "/v1/device/diagnostics";
    private static final int MAX_RING = 128;
    private static final int MAX_BATCH = 50;
    private static final long RETRY_DELAY_MS = 30_000L;
    private static final long MAX_AGE_MS = 604_800_000L;
    private static final ExecutorService UPLOADS = Executors.newSingleThreadExecutor(task -> {
        Thread thread = new Thread(task, "pickcode-interaction-diagnostics");
        thread.setDaemon(true);
        return thread;
    });

    private static final class Entry {
        final long sequence;
        final long createdAtElapsedMs;
        final JSONObject payload;
        final String reason;
        Entry(long sequence, long createdAtElapsedMs, JSONObject payload, String reason) {
            this.sequence = sequence;
            this.createdAtElapsedMs = createdAtElapsedMs;
            this.payload = payload;
            this.reason = reason;
        }
    }

    private final Object lock = new Object();
    private final ArrayDeque<Entry> ring = new ArrayDeque<>();
    private long nextSequence;
    private long droppedCount;
    private String session = "";
    private boolean uploadRunning;
    private long retryNotBefore;

    void resumeSession() {
        synchronized (lock) {
            if (session.isEmpty()) session = UUID.randomUUID().toString();
        }
    }

    void startSession() {
        synchronized (lock) {
            session = UUID.randomUUID().toString();
            ring.clear();
            droppedCount = 0;
            retryNotBefore = 0;
            addLocked(event("other_device", "success", null, null, 1, null, null, null, "session", null), "");
        }
    }

    void retireSession() {
        synchronized (lock) {
            session = "";
            ring.clear();
            droppedCount = 0;
            retryNotBefore = 0;
        }
    }

    String currentSession() {
        synchronized (lock) { return session; }
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
        final List<Entry> batch;
        final String capturedSession;
        synchronized (lock) {
            if (session.isEmpty() || expectedSession == null || !session.equals(expectedSession) || uploadRunning
                    || ring.isEmpty() || SystemClock.elapsedRealtime() < retryNotBefore
                    || baseUrl == null || baseUrl.isEmpty() || token == null || token.isEmpty()) return;
            capturedSession = session;
            batch = new ArrayList<>(MAX_BATCH);
            int count = 0;
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
                long now = SystemClock.elapsedRealtime();
                for (Entry entry : batch) {
                    JSONObject copy = new JSONObject(entry.payload.toString());
                    copy.put("ageMs", Math.max(0, Math.min(MAX_AGE_MS, now - entry.createdAtElapsedMs)));
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
        synchronized (lock) { return ring.size(); }
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
        ring.addLast(new Entry(++nextSequence, SystemClock.elapsedRealtime(), payload, reason == null ? "" : reason));
    }

    private void removeSequenceLocked(long sequence) {
        for (java.util.Iterator<Entry> iterator = ring.iterator(); iterator.hasNext();) {
            if (iterator.next().sequence == sequence) {
                iterator.remove();
                return;
            }
        }
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
            if (durationMs != null) event.put("durationMs", Math.max(0, Math.min(120_000, durationMs)));
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
