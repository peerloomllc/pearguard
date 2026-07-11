package com.pearguard;

import android.content.Context;
import android.os.PowerManager;

/**
 * Shared guard for reconstructing "today" foreground time from raw UsageEvents.
 *
 * Every event-replay usage query (both the reporting path in UsageStatsModule
 * and the enforcement path in AppBlockerModule) ends the same way: for any
 * session it still considers "open" it adds `now - sessionStart`. That step is
 * only correct for the app that is *actually* on screen right now. Two failure
 * modes produced hours of phantom usage:
 *
 *   1. A never-closed session. Only one app can be foreground at a time, so if
 *      several packages are still in the open set, all but the most-recently
 *      resumed one never received their close event (some OEM streams drop the
 *      per-app PAUSE). Extending those stale sessions to `now` invented time.
 *
 *   2. Screen-off background audio. A media app (Spotify) resumes, then the
 *      screen turns off without a recognised SCREEN_NON_INTERACTIVE/PAUSE
 *      boundary. The session stays open and accrues the whole locked stretch,
 *      even though Android's own aggregate (getTotalTimeInForeground) correctly
 *      reports ~0 because screen-off audio is not foreground.
 *
 * The gate below lets an open session accrue live time only when the device is
 * interactive AND the package is the current foreground app. Everything else
 * stops at its last observed boundary instead of running to `now`.
 */
final class UsageSessionUtil {

    private UsageSessionUtil() {}

    /**
     * True when the screen is currently on/interactive. Fails open (true) if the
     * PowerManager can't be reached — the foreground-match check is the primary
     * protection, so a missing PowerManager can at worst let a single live
     * session through, never the multi-app inflation.
     */
    static boolean isScreenInteractive(Context ctx) {
        try {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            if (pm == null) return true;
            return pm.isInteractive();
        } catch (Exception e) {
            return true;
        }
    }

    /**
     * Decide whether a still-open session for `pkg` may add `now - start`.
     *
     * @param screenInteractive result of {@link #isScreenInteractive} (hoisted so
     *                          callers query PowerManager once per scan)
     * @param pkg               the package whose open session is being closed out
     * @param currentForeground the package of the last foreground/resume event
     *                          seen in the scan, i.e. the app actually on top
     */
    static boolean shouldAccrueOpenSession(boolean screenInteractive, String pkg, String currentForeground) {
        if (!screenInteractive) return false;
        if (pkg == null || currentForeground == null) return false;
        return pkg.equals(currentForeground);
    }
}
