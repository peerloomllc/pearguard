package com.pearguard;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.facebook.react.bridge.ReactContext;

import org.json.JSONArray;

/**
 * WorkManager Worker that runs every 15 minutes.
 *
 * Two queues are drained on each tick:
 *   - usage reports (collected natively, queued by UsageQueueHelper)
 *   - time/approval requests (queued by AppBlockerModule when the kid taps
 *     a duration on the block overlay while the RN bridge is detached)
 *
 * Bridge alive → emits onUsageFlush / onTimeRequestDrain so JS sends the
 * payloads to bare. Bridge dead → MainActivity is launched (no animation,
 * moveTaskToBack 10 s later) to restart the RN lifecycle. A pending time
 * request bypasses the 30-min usage staleness gate so the kid's request
 * does not sit on disk for half an hour.
 */
public class UsageFlushWorker extends Worker {

    private static final long STALENESS_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

    public UsageFlushWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();

        // Collect usage natively and queue it (regardless of bridge state)
        JSONArray usage = UsageStatsModule.collectDailyUsageNative(ctx);
        if (usage.length() > 0) {
            UsageQueueHelper.enqueue(ctx, usage);
        }

        boolean hasUsage = UsageQueueHelper.hasQueued(ctx);
        boolean hasTimeReq = TimeRequestQueueHelper.hasQueued(ctx);
        if (!hasUsage && !hasTimeReq) {
            return Result.success();
        }

        ReactContext reactContext = PearGuardReactHost.get();
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
            // Bridge is alive — emit drain events directly.
            if (hasUsage) {
                com.facebook.react.bridge.WritableMap params =
                        com.facebook.react.bridge.Arguments.createMap();
                params.putDouble("timestamp", System.currentTimeMillis());
                reactContext
                    .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit("onUsageFlush", params);
            }
            if (hasTimeReq) {
                reactContext
                    .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit("onTimeRequestDrain", null);
            }
            return Result.success();
        }

        // Bridge is dead. Pending time requests bypass the usage staleness
        // gate — the kid is waiting on the parent and a 30-min delay is too
        // long. Usage on its own still respects the gate so we don't wake the
        // app every 15 min for fresh data.
        if (!hasTimeReq) {
            SharedPreferences prefs = ctx.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE);
            long lastFlush = prefs.getLong("last_usage_flush_ms", 0);
            if (System.currentTimeMillis() - lastFlush < STALENESS_THRESHOLD_MS) {
                return Result.success();
            }
        }

        // Launch MainActivity to restart full RN lifecycle.
        // FLAG_ACTIVITY_NO_ANIMATION minimizes visual disruption to the child.
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_NO_ANIMATION);
        intent.putExtra("usage_flush_wake", true);
        ctx.startActivity(intent);

        return Result.success();
    }
}
