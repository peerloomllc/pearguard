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
            android.content.pm.PackageManager pm = context.getPackageManager();
            try {
                android.content.pm.ApplicationInfo ai =
                        pm.getApplicationInfo(packageName, 0);
                params.putString("appName", pm.getApplicationLabel(ai).toString());
            } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {
                params.putString("appName", packageName);
            }
            try {
                android.graphics.drawable.Drawable drawable = pm.getApplicationIcon(packageName);
                android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(144, 144, android.graphics.Bitmap.Config.ARGB_8888);
                android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
                drawable.setBounds(0, 0, 144, 144);
                drawable.draw(canvas);
                java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, baos);
                params.putString("iconBase64", android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP));
            } catch (Exception ignored) {}
        }

        String eventName = isAdded ? "onAppInstalled" : "onAppUninstalled";
        reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit(eventName, params);
    }
}