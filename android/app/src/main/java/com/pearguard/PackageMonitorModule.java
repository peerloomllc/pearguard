package com.pearguard;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

public class PackageMonitorModule extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean isAdded   = Intent.ACTION_PACKAGE_ADDED.equals(action);
        boolean isRemoved = Intent.ACTION_PACKAGE_REMOVED.equals(action);

        if (!isAdded && !isRemoved) return;

        String packageName = intent.getData() != null
                ? intent.getData().getSchemeSpecificPart()
                : null;

        if (packageName == null) return;

        // Do not report self-updates / self-removal
        if (packageName.equals(context.getPackageName())) return;

        // ACTION_PACKAGE_REMOVED fires for both uninstalls and updates.
        // ACTION_PACKAGE_ADDED with EXTRA_REPLACING=true is the install-side of an update.
        // Skip update events on both sides so we only relay true installs/uninstalls.
        boolean isReplacing = intent.getBooleanExtra(Intent.EXTRA_REPLACING, false);
        if (isReplacing) return;

        ReactContext reactContext = PearGuardReactHost.get();
        if (reactContext == null || !reactContext.hasActiveReactInstance()) return;

        WritableMap params = Arguments.createMap();
        params.putString("packageName", packageName);

        if (isAdded) {
            // Resolve human-readable app name so the parent sees a real label, not a package string.
            try {
                android.content.pm.PackageManager pm = context.getPackageManager();
                android.content.pm.ApplicationInfo ai =
                        pm.getApplicationInfo(packageName, 0);
                params.putString("appName", pm.getApplicationLabel(ai).toString());
            } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {
                params.putString("appName", packageName);
            }
        }

        String eventName = isAdded ? "onAppInstalled" : "onAppUninstalled";
        reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(eventName, params);
    }
}