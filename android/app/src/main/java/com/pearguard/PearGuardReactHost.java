package com.pearguard;

import com.facebook.react.bridge.ReactContext;

/**
 * Singleton that holds the latest ReactContext so that non-module Android
 * components (BroadcastReceivers, Services, AccessibilityService) can send
 * events to the RN JS layer via DeviceEventEmitter.
 *
 * Set in UsageStatsModule during initialization. Cleared on destroy.
 */
public class PearGuardReactHost {
    private static volatile ReactContext sReactContext;

    public static void set(ReactContext ctx) {
        sReactContext = ctx;
    }

    public static ReactContext get() {
        return sReactContext;
    }
}
