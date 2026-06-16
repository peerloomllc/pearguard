package com.pearguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

/**
 * Listens for BOOT_COMPLETED (and QUICKBOOT_POWERON for some OEMs).
 * Starts the foreground service matching this device's role so monitoring
 * (parent) or enforcement (child) resumes immediately after the device
 * reboots — without requiring the user to open the app.
 *
 * The role is read from the "pearguard_mode" SharedPreferences entry, which
 * is persisted by UsageStatsModule.startParentService() (parent) and
 * AppBlockerModule.onServiceConnected() (child). A parent device must NOT
 * start EnforcementService, otherwise it shows the child's "Parental controls
 * are running" notification with nothing to enforce.
 */
public class BootReceiverModule extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) &&
            !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }

        SharedPreferences prefs =
            context.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE);
        String mode = prefs.getString("pearguard_mode", null);

        Class<?> serviceClass;
        if ("parent".equals(mode)) {
            serviceClass = ParentConnectionService.class;
        } else if ("child".equals(mode)) {
            serviceClass = EnforcementService.class;
        } else {
            // Mode not yet persisted (e.g. fresh install rebooted before first
            // launch). Do nothing: a child's Accessibility Service auto-reconnects
            // on boot and starts EnforcementService itself, and a parent resumes
            // monitoring the next time the app is opened.
            return;
        }

        Intent serviceIntent = new Intent(context, serviceClass);
        serviceIntent.putExtra("source", "boot");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent);
        } else {
            context.startService(serviceIntent);
        }
    }
}
