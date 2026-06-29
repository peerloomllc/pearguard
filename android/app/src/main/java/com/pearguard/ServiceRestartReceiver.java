package com.pearguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.core.content.ContextCompat;

/**
 * Restarts ParentConnectionService after the parent app is swiped from recents.
 *
 * ParentConnectionService.onTaskRemoved schedules an AlarmManager alarm
 * targeting this receiver. We use startForegroundService (not startService) so
 * the restart is allowed under Android 12+ background-start rules; the service
 * promotes itself to foreground in onCreate, and its onStartCommand re-wakes the
 * RN/Bare worklet so Hyperswarm reconnects.
 *
 * Only relevant on the parent: the service is never started in child mode, so
 * onTaskRemoved (and therefore this alarm) only fires for a configured parent.
 */
public class ServiceRestartReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            Intent svc = new Intent(context, ParentConnectionService.class);
            ContextCompat.startForegroundService(context, svc);
        } catch (Exception ignored) {
            // startForegroundService can throw if the app is fully force-stopped
            // (no background-start exemption) — nothing to do; the user must
            // reopen the app. Swallow so the receiver never crashes.
        }
    }
}
