package com.pearguard;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class PearGuardPackage implements ReactPackage {

    @Override
    public List<NativeModule> createNativeModules(ReactApplicationContext reactContext) {
        List<NativeModule> modules = new ArrayList<>();
        modules.add(new UsageStatsModule(reactContext));
        modules.add(new ContactsModule(reactContext));
        modules.add(new DownloadsModule(reactContext));
        // AppBlockerModule, DeviceAdminModule, PackageMonitorModule, and
        // BootReceiverModule are Android components (AccessibilityService,
        // BroadcastReceiver) — they are not ReactContextBaseJavaModules.
        // They communicate back to RN by obtaining the ReactContext from
        // PearGuardReactHost and emitting DeviceEventEmitter events.
        // EnforcementService itself is started via Intent, not via the bridge.
        return modules;
    }

    @Override
    public List<ViewManager> createViewManagers(ReactApplicationContext reactContext) {
        return Collections.emptyList();
    }
}
