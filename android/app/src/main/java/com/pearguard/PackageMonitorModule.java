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
        if (!Intent.ACTION_PACKAGE_ADDED.equals(intent.getAction())) return;

        String packageName = intent.getData() != null
            ? intent.getData().getSchemeSpecificPart()
            : null;

        if (packageName == null) return;

        // Do not report self-updates
        if (packageName.equals(context.getPackageName())) return;

        ReactContext reactContext = PearGuardReactHost.get();
        if (reactContext == null || !reactContext.hasActiveReactInstance()) return;

        WritableMap params = Arguments.createMap();
        params.putString("packageName", packageName);

        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit("onAppInstalled", params);
    }
}
