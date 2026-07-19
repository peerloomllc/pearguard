package com.pearguard;

import android.content.Context;
import android.os.Build;
import android.provider.Telephony;
import android.telecom.TelecomManager;

import java.util.HashSet;
import java.util.Set;

/**
 * Decides whether a package is the device's phone or SMS app, which enforcement
 * always exempts so a locked child can still place calls and texts (including
 * emergencies).
 *
 * This resolves the *actual* default dialer and default SMS packages from the
 * platform. The previous check matched substrings of the package name
 * (contains "dialer" | "sms" | "messaging"), which exempted any app whose id
 * merely contained one of those strings — e.g. Signal (org.thoughtcrime.securesms)
 * or any sideloaded com.*sms* app — making it unblockable by every control
 * including the device-wide lock. A small curated set of common OEM defaults is
 * kept as a fallback for when platform resolution returns nothing.
 */
final class PhoneAppHelper {
    private PhoneAppHelper() {}

    private static final Set<String> CURATED = new HashSet<>();
    static {
        CURATED.add("com.android.dialer");
        CURATED.add("com.google.android.dialer");
        CURATED.add("com.android.phone");
        CURATED.add("com.android.server.telecom");
        CURATED.add("com.android.mms");
        CURATED.add("com.google.android.apps.messaging");
    }

    // Resolved platform defaults, refreshed lazily. They change rarely, so we
    // cache them rather than hitting the platform on the per-window hot path
    // (getBlockReason runs on every foreground change and during recheck bursts).
    private static volatile String defaultDialer = null;
    private static volatile String defaultSms = null;
    private static volatile long resolvedAt = 0L;
    private static final long TTL_MS = 60_000L;

    static boolean isPhoneOrMessagingApp(Context ctx, String packageName) {
        if (packageName == null) return false;
        if (CURATED.contains(packageName)) return true;
        refresh(ctx);
        return packageName.equals(defaultDialer) || packageName.equals(defaultSms);
    }

    private static void refresh(Context ctx) {
        long now = System.currentTimeMillis();
        if (resolvedAt != 0L && now - resolvedAt < TTL_MS) return;
        if (ctx == null) return;
        String dialer = null;
        String sms = null;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                TelecomManager tm = (TelecomManager) ctx.getSystemService(Context.TELECOM_SERVICE);
                if (tm != null) dialer = tm.getDefaultDialerPackage();
            }
        } catch (Exception ignored) {}
        try {
            sms = Telephony.Sms.getDefaultSmsPackage(ctx);
        } catch (Exception ignored) {}
        defaultDialer = dialer;
        defaultSms = sms;
        resolvedAt = now;
    }
}
