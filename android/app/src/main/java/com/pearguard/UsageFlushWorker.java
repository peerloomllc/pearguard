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
 * If the RN bridge is alive, emits onUsageFlush directly.
 * If the RN bridge is dead AND the last successful flush was >30 min ago,
 * launches MainActivity (with no animation) to restart the RN lifecycle
 * so queued reports can be flushed over P2P.
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

        if (!UsageQueueHelper.hasQueued(ctx)) {
            return Result.success();
        }

        ReactContext reactContext = PearGuardReactHost.get();
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
            // Bridge is alive - emit flush event directly
            com.facebook.react.bridge.WritableMap params =
                    com.facebook.react.bridge.Arguments.createMap();
            params.putDouble("timestamp", System.currentTimeMillis());
            reactContext
                .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("onUsageFlush", params);
        } else {
            // Bridge is dead - only wake the app if data is stale enough
            SharedPreferences prefs = ctx.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE);
            long lastFlush = prefs.getLong("last_usage_flush_ms", 0);
            if (System.currentTimeMillis() - lastFlush < STALENESS_THRESHOLD_MS) {
                return Result.success();
            }

            // Launch MainActivity to restart full RN lifecycle.
            // FLAG_ACTIVITY_NO_ANIMATION minimizes visual disruption to the child.
            Intent intent = new Intent(ctx, MainActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            intent.putExtra("usage_flush_wake", true);
            ctx.startActivity(intent);
        }

        return Result.success();
    }
}
