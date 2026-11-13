package local.pickcode.assistant;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/** One transaction owns read -> core mutation -> write; UI/worker/widget never replace snapshots. */
public final class AssistantStore extends SQLiteOpenHelper {
    private static AssistantStore instance;
    private static final String UPGRADE_BACKUP_PREFS = "assistant_upgrade_backup";
    private static final String UPGRADE_BACKUP_MARKER = "assistant_state_before_3.2.0_written";
    private static final String UPGRADE_BACKUP_DIR = "upgrade-backups";
    private static final String UPGRADE_BACKUP_NAME = "assistant-state-before-3.2.0.json";
    private final Context appContext;
    private final CoreEngine engine;
    private volatile String snapshotCache;
    private volatile long snapshotCachedAt;
    private volatile DisplayCache displayCache;

    private static final class DisplayCache {
        final String snapshot, overview;
        DisplayCache(String snapshot, String overview) { this.snapshot = snapshot; this.overview = overview; }
    }

    public static synchronized AssistantStore get(Context context) {
        if (instance == null) instance = new AssistantStore(context.getApplicationContext());
        return instance;
    }

    private AssistantStore(Context context) {
        super(context, "assistant.db", null, 2);
        appContext = context.getApplicationContext();
        setWriteAheadLoggingEnabled(true);
        try (InputStream stream = appContext.getAssets().open("pickcode-core.js")) {
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = stream.read(buffer)) != -1) bytes.write(buffer, 0, count);
            engine = new CoreEngine(bytes.toString(StandardCharsets.UTF_8.name()));
        } catch (Exception ex) { throw new IllegalStateException("本地解析引擎不可用，请重新安装应用", ex); }
    }

    @Override public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE assistant_state (id INTEGER PRIMARY KEY CHECK (id=1), payload TEXT NOT NULL)");
        createDisplayCache(db);
    }
    @Override public void onUpgrade(SQLiteDatabase db, int from, int to) {
        if (from == 1 && to == 2) createDisplayCache(db);
        else throw new IllegalStateException("Unsupported database version");
    }
    private static void createDisplayCache(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE assistant_display (id INTEGER PRIMARY KEY CHECK (id=1), snapshot TEXT NOT NULL, overview TEXT NOT NULL, revision INTEGER NOT NULL)");
    }

    // Display reads may use the last committed result while a mutation is still computing.
    public JSONObject displaySnapshot() throws Exception {
        try { return new JSONObject(display().snapshot); }
        catch (org.json.JSONException invalid) { return refreshSnapshot(); }
    }
    public JSONObject overview() throws Exception { return new JSONObject(display().overview); }
    boolean hasDisplaySnapshot() { return displayCache != null; }
    boolean displayNeedsRefresh() { return snapshotCache == null || android.os.SystemClock.elapsedRealtime() - snapshotCachedAt >= 1_000; }

    private DisplayCache display() throws Exception {
        DisplayCache saved = displayCache;
        if (saved != null) return saved;
        synchronized (this) {
            if (displayCache != null) return displayCache;
            try (Cursor row = getReadableDatabase().rawQuery("SELECT snapshot,overview FROM assistant_display WHERE id=1", null)) {
                if (row.moveToFirst()) {
                    try {
                        JSONObject summary = new JSONObject(row.getString(1));
                        if (summary.has("stats") && summary.has("online")) {
                            displayCache = new DisplayCache(row.getString(0), row.getString(1));
                        }
                    } catch (org.json.JSONException invalid) { /* Rebuild a damaged derived cache from the original state. */ }
                }
            }
            if (displayCache == null) snapshot();
            return displayCache;
        }
    }

    private static DisplayCache displayValue(JSONObject result, long revision) throws Exception {
        if (!result.has("codes") || !result.has("packages") || !result.has("settings")) return null;
        // Local and network queues can deliver replies in a different order than their commits.
        result.put("localRevision", revision);
        long total = 0, picked = 0;
        JSONArray codes = result.getJSONArray("codes");
        for (int i = 0; i < codes.length(); i++) {
            JSONObject item = codes.getJSONObject(i);
            long count = item.optLong("totalCount", 1);
            if (count == 0) count = 1;
            total += count;
            picked += count - (item.isNull("pendingCount") ? item.optBoolean("isPicked") ? 0 : 1 : item.getLong("pendingCount"));
        }
        JSONObject overview = new JSONObject().put("localRevision", revision).put("stats", new JSONObject().put("total", total).put("picked", picked))
                .put("online", result.getJSONObject("online"));
        return new DisplayCache(result.toString(), overview.toString());
    }

    public synchronized JSONObject snapshot() throws Exception { return dispatch("snapshot", new JSONObject()); }

    /** The visibility check and mutation share this monitor with every other store operation. */
    public synchronized boolean markPendingPicked(String id) throws Exception {
        JSONObject payload = WidgetModel.pickPayload(snapshot(), id);
        if (payload == null) return false;
        dispatch("update", payload);
        return true;
    }

    public synchronized JSONObject dispatch(String action, JSONObject payload) throws Exception {
        if ("snapshot".equals(action) && snapshotCache != null
                && android.os.SystemClock.elapsedRealtime() - snapshotCachedAt < 1_000) return new JSONObject(snapshotCache);
        return commitCommand(action, payload, null);
    }

    /** Confirmation commits the rule and its original SMS together, so a failed ingest is retryable. */
    public synchronized JSONObject saveRuleAndIngest(JSONObject rule, JSONObject sourceMessage) throws Exception {
        return commitCommand("saveRule", new JSONObject().put("rule", rule), sourceMessage);
    }

    private JSONObject commitCommand(String action, JSONObject payload, JSONObject sourceMessage) throws Exception {
        snapshotCache = null;
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        JSONObject result;
        DisplayCache nextDisplay;
        try {
            String state = "";
            try (Cursor row = db.rawQuery("SELECT payload FROM assistant_state WHERE id=1", null)) {
                if (row.moveToFirst()) state = row.getString(0);
            }
            backupBeforeUpgrade(state);
            JSONObject request = new JSONObject().put("action", action).put("payload", payload);
            JSONObject output = new JSONObject(engine.dispatch(state, request.toString()));
            if (sourceMessage != null) {
                JSONObject nextState = output.getJSONObject("state");
                JSONObject ingest = new JSONObject().put("action", "ingest").put("payload", new JSONObject()
                        .put("messages", new JSONArray().put(sourceMessage)).put("scannedAt", nextState.optLong("lastScanAt")));
                output = new JSONObject(engine.dispatch(nextState.toString(), ingest.toString()));
            }
            result = output.getJSONObject("result");
            if (state.isEmpty() || !"snapshot".equals(action)) {
                ContentValues values = new ContentValues();
                values.put("id", 1);
                values.put("payload", output.getJSONObject("state").toString());
                db.replaceOrThrow("assistant_state", null, values);
            }
            long revision = 1;
            try (Cursor previous = db.rawQuery("SELECT revision FROM assistant_display WHERE id=1", null)) {
                if (previous.moveToFirst()) revision = previous.getLong(0) + 1;
            }
            nextDisplay = displayValue(result, revision);
            if (nextDisplay != null) {
                ContentValues cached = new ContentValues();
                cached.put("id", 1); cached.put("snapshot", nextDisplay.snapshot); cached.put("overview", nextDisplay.overview); cached.put("revision", revision);
                db.replaceOrThrow("assistant_display", null, cached);
            }
            db.setTransactionSuccessful();
        } finally { db.endTransaction(); }
        // Publish only committed state, and never expose a mutable shared JSONObject to callers.
        if (nextDisplay != null) {
            displayCache = nextDisplay;
            snapshotCache = nextDisplay.snapshot;
            snapshotCachedAt = android.os.SystemClock.elapsedRealtime();
        }
        return result;
    }

    /**
     * Preserve the pre-upgrade state once, before any command can ask the core to mutate it.
     * The temporary file lives beside the destination so rename is atomic on the same volume.
     */
    private void backupBeforeUpgrade(String state) throws IOException {
        if (state == null || state.isEmpty()) return;
        SharedPreferences preferences = appContext.getSharedPreferences(UPGRADE_BACKUP_PREFS, Context.MODE_PRIVATE);
        if (preferences.getBoolean(UPGRADE_BACKUP_MARKER, false)) return;

        File directory = new File(appContext.getFilesDir(), UPGRADE_BACKUP_DIR);
        if (!directory.isDirectory() && !directory.mkdirs() && !directory.isDirectory()) {
            throw new IOException("无法创建升级备份目录");
        }
        File destination = new File(directory, UPGRADE_BACKUP_NAME);
        if (destination.exists()) {
            validateBackup(destination, state);
            markUpgradeBackupWritten(preferences);
            return;
        }

        File temporary = File.createTempFile(UPGRADE_BACKUP_NAME, ".tmp", directory);
        boolean renamed = false;
        try {
            byte[] bytes = state.getBytes(StandardCharsets.UTF_8);
            try (FileOutputStream output = new FileOutputStream(temporary)) {
                output.write(bytes);
                output.flush();
                output.getFD().sync();
            }
            if (!temporary.renameTo(destination)) throw new IOException("无法提交升级备份");
            validateBackup(destination, state);
            renamed = true;
            markUpgradeBackupWritten(preferences);
        } finally {
            if (!renamed && temporary.exists() && !temporary.delete()) {
                // A failed command must leave the original database state untouched; a stale
                // temporary file is harmless and will never be used as the backup.
            }
        }
    }

    private static void validateBackup(File file, String original) throws IOException {
        if (!file.isFile() || file.length() == 0) throw new IOException("已有升级备份无效，请保留原数据后检查存储空间");
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[8192]; int count;
            while ((count = input.read(buffer)) != -1) bytes.write(buffer, 0, count);
        }
        String saved = new String(bytes.toByteArray(), StandardCharsets.UTF_8);
        // A malformed original is recoverable byte-for-byte; later restarts may have a newer state.
        if (saved.equals(original)) return;
        try {
            JSONObject data = new JSONObject(saved);
            if (data.optJSONArray("orders") == null || data.optJSONArray("operations") == null)
                throw new org.json.JSONException("incomplete state");
        } catch (org.json.JSONException invalid) { throw new IOException("已有升级备份不完整，已停止修改原数据"); }
    }

    private static void markUpgradeBackupWritten(SharedPreferences preferences) throws IOException {
        if (!preferences.edit().putBoolean(UPGRADE_BACKUP_MARKER, true).commit()) {
            throw new IOException("无法记录升级备份状态");
        }
    }

    public synchronized JSONObject refreshSnapshot() throws Exception {
        snapshotCache = null;
        return snapshot();
    }

    public JSONObject validateCandidate(JSONObject candidate, String sample, String expected) throws Exception {
        return new JSONObject(engine.validateCandidate(candidate.toString(), sample, expected));
    }
}
