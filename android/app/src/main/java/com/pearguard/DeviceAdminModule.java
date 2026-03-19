package com.pearguard;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

/**
 * DeviceAdminReceiver — the Android system calls these callbacks when the
 * device admin status changes. While enrolled, the OS prevents the app from
 * being uninstalled without first removing device admin status (which requires
 * the user to go through a separate confirmation flow).
 *
 * To enroll:
 *   Intent intent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
 *   intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, new ComponentName(ctx, DeviceAdminModule.class));
 *   intent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION, "Required for parental controls");
 *   startActivity(intent);
 *
 * The setup wizard (Plan 3) calls this intent during child setup.
 */
public class DeviceAdminModule extends DeviceAdminReceiver {

    @Override
    public void onEnabled(Context context, Intent intent) {
        Toast.makeText(context, "PearGuard: device admin enabled", Toast.LENGTH_SHORT).show();
    }

    @Override
    public CharSequence onDisableRequested(Context context, Intent intent) {
        // This string is shown in the confirmation dialog when the user tries to
        // remove device admin status. Make it clear that parental controls will stop.
        return "Removing device admin will disable all PearGuard enforcement. " +
            "A parent PIN is required to confirm.";
    }

    @Override
    public void onDisabled(Context context, Intent intent) {
        // Device admin was removed. Notify the RN layer so it can send alert:bypass.
        com.facebook.react.bridge.ReactContext reactContext = PearGuardReactHost.get();
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
            reactContext
                .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule
                    .RCTDeviceEventEmitter.class)
                .emit("onBypassDetected", "device_admin_disabled");
        }
    }
}
