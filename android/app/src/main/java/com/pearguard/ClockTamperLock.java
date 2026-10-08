package com.pearguard;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.provider.Settings;

/**
 * Blocks apps after a manual clock or timezone change until the child turns
 * automatic time back on.
 *
 * Detection (EnforcementService's TIME_SET / TIMEZONE_CHANGED receiver) alerts
 * the parent, but every schedule, limit and override check reads the wall
 * clock, so a detected change still bought time until the parent reacted. With
 * this lock set, a moved clock gains nothing: apps stay blocked until "Set time
 * automatically" (or "Set time zone automatically" for a zone change) is on
 * again, at which point the clock is network-controlled and can be trusted.
 *
 * The lock clears itself lazily on the next block check after the setting is
 * back on, so no receiver is needed for the setting toggle.
 */
final class ClockTamperLock {
    private ClockTamperLock() {}

    private static final String PREFS_NAME = "PearGuardPrefs";
    private static final String KEY_CLOCK = "clock_tamper_lock";
    private static final String KEY_ZONE = "timezone_tamper_lock";

    static final String REASON =
        "The date or time was changed by hand. Turn on automatic date and time in Settings to keep using apps.";

    /** A manual clock change was detected. Lifts once AUTO_TIME is on. */
    static void lockClock(Context ctx) {
        prefs(ctx).edit().putBoolean(KEY_CLOCK, true).apply();
    }

    /** A manual timezone change was detected. Lifts once AUTO_TIME_ZONE is on. */
    static void lockZone(Context ctx) {
        prefs(ctx).edit().putBoolean(KEY_ZONE, true).apply();
    }

    /**
     * Returns REASON while a lock is in force, or null. Clears any lock whose
     * automatic setting has been turned back on. The Settings app is never
     * blocked here, since the child needs it to clear the lock; it still goes
     * through the normal rules afterwards.
     */
    static String blockReason(Context ctx, String packageName) {
        SharedPreferences prefs = prefs(ctx);
        boolean clock = prefs.getBoolean(KEY_CLOCK, false);
        boolean zone = prefs.getBoolean(KEY_ZONE, false);
        if (!clock && !zone) return null;

        SharedPreferences.Editor edit = null;
        if (clock && isAutoTimeEnabled(ctx)) {
            clock = false;
            edit = prefs.edit().remove(KEY_CLOCK);
        }
        if (zone && isAutoTimeZoneEnabled(ctx)) {
            zone = false;
            edit = (edit != null ? edit : prefs.edit()).remove(KEY_ZONE);
        }
        if (edit != null) edit.apply();
        if (!clock && !zone) return null;

        if (packageName != null && packageName.equals(dateSettingsPackage(ctx))) return null;
        return REASON;
    }

    /**
     * True when the system clock is set automatically (NITZ/NTP). Fails safe to
     * true (assume automatic) if the setting can't be read, to avoid falsely
     * accusing or locking out the child.
     */
    static boolean isAutoTimeEnabled(Context ctx) {
        try {
            return Settings.Global.getInt(ctx.getContentResolver(), Settings.Global.AUTO_TIME, 1) == 1;
        } catch (Exception e) {
            return true;
        }
    }

    /** Same idea as isAutoTimeEnabled but for the timezone (AUTO_TIME_ZONE). */
    static boolean isAutoTimeZoneEnabled(Context ctx) {
        try {
            return Settings.Global.getInt(ctx.getContentResolver(), Settings.Global.AUTO_TIME_ZONE, 1) == 1;
        } catch (Exception e) {
            return true;
        }
    }

    private static String dateSettingsPackage(Context ctx) {
        try {
            ResolveInfo ri = ctx.getPackageManager().resolveActivity(
                new Intent(Settings.ACTION_DATE_SETTINGS), PackageManager.MATCH_DEFAULT_ONLY);
            if (ri != null && ri.activityInfo != null) return ri.activityInfo.packageName;
        } catch (Exception ignored) {}
        return "com.android.settings";
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}
