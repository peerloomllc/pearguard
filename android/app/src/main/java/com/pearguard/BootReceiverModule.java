package com.pearguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Listens for BOOT_COMPLETED (and QUICKBOOT_POWERON for some OEMs).
 * Starts EnforcementService as a foreground service so enforcement
 * resumes immediately after the device reboots — without requiring
 * the user to open the app.
 */
public class BootReceiverModule extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action) &&
            !"android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            return;
        }

        Intent serviceIntent = new Intent(context, EnforcementService.class);
        serviceIntent.putExtra("source", "boot");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent);
        } else {
            context.startService(serviceIntent);
        }
    }
}
