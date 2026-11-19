package local.pickcode.assistant;

import org.mozilla.javascript.Context;
import org.mozilla.javascript.ContextFactory;
import org.mozilla.javascript.Function;
import org.mozilla.javascript.Scriptable;
import org.mozilla.javascript.ScriptableObject;

/** Executes only the bundled ES5 engine. User rules are JSON, never JavaScript. */
public final class CoreEngine {
    private final String source;
    public interface PhaseObserver { void record(String phase, long durationMs, boolean success); }

    static void phase(PhaseObserver observer, String phase, long startedAt, boolean success) {
        if (observer == null) return;
        try { observer.record(phase, Math.max(0, (System.nanoTime() - startedAt) / 1_000_000), success); }
        catch (RuntimeException ignored) { /* Diagnostics cannot prevent a local commit. */ }
    }

    public CoreEngine(String source) { this.source = source; }

    public String dispatch(String state, String request) {
        return invoke("dispatch", state, request);
    }

    public String dispatch(String state, String request, String committedProjection, PhaseObserver observer) {
        return run((cx, scope, core) -> Context.toString(((Function)
                ScriptableObject.getProperty(core, "dispatch")).call(cx, scope, core,
                new Object[]{state, request, committedProjection})), observer);
    }

    public String validateCandidate(String candidate, String sample, String expected) {
        return run((cx, scope, core) -> {
            Object parsed = ((Function) ScriptableObject.getProperty(
                    (Scriptable) ScriptableObject.getProperty(scope, "JSON"), "parse"))
                    .call(cx, scope, scope, new Object[]{candidate});
            Object result = ((Function) ScriptableObject.getProperty(core, "validateCandidate"))
                    .call(cx, scope, core, new Object[]{parsed, sample, expected});
            Scriptable json = (Scriptable) ScriptableObject.getProperty(scope, "JSON");
            return Context.toString(((Function) ScriptableObject.getProperty(json, "stringify"))
                    .call(cx, scope, json, new Object[]{result}));
        });
    }

    public String parse(String sample) {
        return run((cx, scope, core) -> {
            Object result = ((Function) ScriptableObject.getProperty(core, "parse"))
                    .call(cx, scope, core, new Object[]{sample});
            Scriptable json = (Scriptable) ScriptableObject.getProperty(scope, "JSON");
            return Context.toString(((Function) ScriptableObject.getProperty(json, "stringify"))
                    .call(cx, scope, json, new Object[]{result}));
        });
    }

    private String invoke(String name, String... values) {
        return run((cx, scope, core) -> Context.toString(((Function)
                ScriptableObject.getProperty(core, name)).call(cx, scope, core, values)));
    }

    private interface Operation { String apply(Context cx, Scriptable scope, Scriptable core); }

    private String run(Operation operation) {
        return run(operation, null);
    }

    private String run(Operation operation, PhaseObserver observer) {
        final long deadline = System.nanoTime() + 20_000_000_000L;
        ContextFactory factory = new ContextFactory() {
            @Override protected Context makeContext() {
                Context cx = super.makeContext();
                cx.setOptimizationLevel(-1);
                cx.setLanguageVersion(Context.VERSION_ES6);
                cx.setInstructionObserverThreshold(10_000);
                cx.setClassShutter(name -> false);
                return cx;
            }
            @Override protected void observeInstructionCount(Context cx, int count) {
                if (Thread.currentThread().isInterrupted() || System.nanoTime() > deadline)
                    throw new IllegalStateException("处理超时，请减少本次数据量");
            }
        };
        return factory.call(cx -> {
            long startedAt = System.nanoTime();
            boolean success = false;
            Scriptable scope, core;
            try {
                scope = cx.initSafeStandardObjects();
                cx.evaluateString(scope, source, "pickcode-core.js", 1, null);
                core = (Scriptable) ScriptableObject.getProperty(scope, "PickCodeCore");
                success = true;
            } finally { phase(observer, "core_init", startedAt, success); }
            startedAt = System.nanoTime(); success = false;
            try {
                String result = operation.apply(cx, scope, core);
                success = true;
                return result;
            } finally { phase(observer, "core_execute", startedAt, success); }
        });
    }
}
