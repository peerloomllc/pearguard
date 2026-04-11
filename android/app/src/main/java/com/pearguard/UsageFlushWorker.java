package com.pearguard;

import android.content.Context;
import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.facebook.react.bridge.ReactContext;

/**
 * WorkManager Worker that runs every 15 minutes.
 * If the RN bridge is alive, emits onUsageFlush directly.
 * If the RN bridge is dead, launches UsageFlushActivity to restart
 * the RN lifecycle so queued reports can be flushed.
 */
public class UsageFlushWorker extends Worker {

    public UsageFlushWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        // Only act if there are queued reports to flush
        if (!UsageQueueHelper.hasQueued(getApplicationContext())) {
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
            // Bridge is dead - launch transparent Activity to restart RN
            Intent intent = new Intent(getApplicationContext(), UsageFlushActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getApplicationContext().startActivity(intent);
        }

        return Result.success();
    }
}
