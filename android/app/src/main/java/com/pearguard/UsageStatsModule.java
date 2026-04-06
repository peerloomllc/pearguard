package com.pearguard;

import android.app.AppOpsManager;
import android.app.NotificationChannel;
import android.provider.Settings;
import android.text.TextUtils;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Process;
import android.os.VibrationEffect;
import android.os.Vibrator;

import androidx.core.app.NotificationCompat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.Promise;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.ReactContextBaseJavaModule;
import com.facebook.react.bridge.ReactMethod;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;

import java.util.Calendar;
import java.util.List;
import java.util.Map;

public class UsageStatsModule extends ReactContextBaseJavaModule {

    private final ReactApplicationContext reactContext;

    public UsageStatsModule(ReactApplicationContext reactContext) {
        super(reactContext);
        this.reactContext = reactContext;
        // Populate singleton so non-module components can emit events
        PearGuardReactHost.set(reactContext);
    }

    @Override
    public String getName() {
        // This is the name used in JS: NativeModules.UsageStatsModule
        return "UsageStatsModule";
    }

    @Override
    public void onCatalystInstanceDestroy() {
        PearGuardReactHost.set(null);
    }

    private boolean hasUsageStatsPermission() {
        AppOpsManager appOps = (AppOpsManager) reactContext.getSystemService(Context.APP_OPS_SERVICE);
        int mode = appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                reactContext.getPackageName()
        );
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    private boolean isAccessibilityEnabled() {
        String prefString;
        try {
            prefString = Settings.Secure.getString(
                    reactContext.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            );
        } catch (Exception e) {
            return false;
        }
        if (TextUtils.isEmpty(prefString)) return false;
        // AppBlockerModule is in the same package; .class.getName() produces the FQCN
        String ourService = reactContext.getPackageName() + "/" + AppBlockerModule.class.getName();
        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(prefString);
        while (splitter.hasNext()) {
            if (splitter.next().equalsIgnoreCase(ourService)) return true;
        }
        return false;
    }

    /**
     * Returns whether the app has been granted PACKAGE_USAGE_STATS permission.
     * Call this before getUsage() to check if the permission wizard needs to run.
     */
    @ReactMethod
    public void hasUsagePermission(Promise promise) {
        promise.resolve(hasUsageStatsPermission());
    }

    /**
     * Returns whether both child-required permissions are granted, plus the last
     * EnforcementService heartbeat timestamp for force-stop detection and any
     * persisted bypass event for background-bypass detection.
     * Used by the child setup wizard to poll and auto-advance steps.
     */
    @ReactMethod
    public void checkChildPermissions(Promise promise) {
        SharedPreferences prefs = reactContext.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE);
        WritableMap result = Arguments.createMap();
        result.putBoolean("accessibility", isAccessibilityEnabled());
        result.putBoolean("usageStats", hasUsageStatsPermission());
        result.putDouble("enforcementHeartbeatMs", prefs.getLong("enforcement_heartbeat_ms", 0));
        String bypassReason = prefs.getString("bypass_detected_reason", null);
        result.putString("bypassDetectedReason", bypassReason != null ? bypassReason : "");
        result.putDouble("bypassDetectedAt", prefs.getLong("bypass_detected_at", 0));
        promise.resolve(result);
    }

    /**
     * Clears the persisted bypass event after it has been relayed to the worklet,
     * preventing it from re-firing on subsequent app launches.
     */
    @ReactMethod
    public void clearBypassDetected() {
        reactContext.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE)
            .edit()
            .remove("bypass_detected_reason")
            .remove("bypass_detected_at")
            .apply();
    }

    /**
     * Returns today's usage (in seconds) for a single package.
     * Resolves with an integer (seconds used today), or 0 if no data.
     */
    @ReactMethod
    public void getUsage(String packageName, Promise promise) {
        UsageStatsManager usm = (UsageStatsManager)
                reactContext.getSystemService(Context.USAGE_STATS_SERVICE);

        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long startOfDay = cal.getTimeInMillis();
        long now = System.currentTimeMillis();

        Map<String, UsageStats> statsMap = usm.queryAndAggregateUsageStats(startOfDay, now);
        if (statsMap != null && statsMap.containsKey(packageName)) {
            long ms = statsMap.get(packageName).getTotalTimeInForeground();
            promise.resolve((int)(ms / 1000));
        } else {
            promise.resolve(0);
        }
    }

    /**
     * Returns daily usage for all apps today as an array of
     * { packageName: string, appName: string, secondsToday: number }.
     * Only includes apps with > 0 seconds.
     */
    @ReactMethod
    public void getDailyUsageAll(Promise promise) {
        UsageStatsManager usm = (UsageStatsManager)
                reactContext.getSystemService(Context.USAGE_STATS_SERVICE);
        PackageManager pm = reactContext.getPackageManager();

        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long startOfDay = cal.getTimeInMillis();
        long now = System.currentTimeMillis();

        Map<String, UsageStats> statsMap = usm.queryAndAggregateUsageStats(startOfDay, now);

        // Build a set of launcher-visible packages so we only report user-facing apps.
        // System services (Google Play Services, SystemUI, etc.) have no launcher icon
        // and should never appear in the Usage report.
        java.util.Set<String> launcherPackages = new java.util.HashSet<>();
        Intent launcherIntent = new Intent(Intent.ACTION_MAIN, null);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolveInfos = pm.queryIntentActivities(launcherIntent, 0);
        if (resolveInfos != null) {
            for (ResolveInfo ri : resolveInfos) {
                launcherPackages.add(ri.activityInfo.packageName);
            }
        }

        WritableArray result = Arguments.createArray();
        if (statsMap != null) {
            for (Map.Entry<String, UsageStats> entry : statsMap.entrySet()) {
                long ms = entry.getValue().getTotalTimeInForeground();
                if (ms <= 0) continue;

                // Skip system services and non-launcher apps
                if (!launcherPackages.contains(entry.getKey())) continue;

                // Skip PearGuard itself
                if (entry.getKey().equals(reactContext.getPackageName())) continue;

                String label = entry.getKey();
                try {
                    ApplicationInfo info = pm.getApplicationInfo(entry.getKey(), 0);
                    label = pm.getApplicationLabel(info).toString();
                } catch (PackageManager.NameNotFoundException ignored) {}

                WritableMap item = Arguments.createMap();
                item.putString("packageName", entry.getKey());
                item.putString("appName", label);
                item.putInt("secondsToday", (int)(ms / 1000));
                result.pushMap(item);
            }
        }
        promise.resolve(result);
    }

    /**
     * Like getDailyUsageAll() but uses raw MOVE_TO_FOREGROUND / MOVE_TO_BACKGROUND
     * events instead of aggregate stats. This includes the current live session,
     * giving real-time accuracy (aggregate stats lag until the app backgrounds).
     * Falls back to getDailyUsageAll() if event query fails.
     */
    @ReactMethod
    public void getDailyUsageAllEvents(Promise promise) {
        try {
            UsageStatsManager usm = (UsageStatsManager)
                    reactContext.getSystemService(Context.USAGE_STATS_SERVICE);
            PackageManager pm = reactContext.getPackageManager();

            Calendar cal = Calendar.getInstance();
            cal.set(Calendar.HOUR_OF_DAY, 0);
            cal.set(Calendar.MINUTE, 0);
            cal.set(Calendar.SECOND, 0);
            cal.set(Calendar.MILLISECOND, 0);
            long startOfDay = cal.getTimeInMillis();
            long now = System.currentTimeMillis();

            // Build launcher-visible set
            java.util.Set<String> launcherPackages = new java.util.HashSet<>();
            Intent launcherIntent = new Intent(Intent.ACTION_MAIN, null);
            launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> resolveInfos = pm.queryIntentActivities(launcherIntent, 0);
            if (resolveInfos != null) {
                for (ResolveInfo ri : resolveInfos) {
                    launcherPackages.add(ri.activityInfo.packageName);
                }
            }

            // Track per-package foreground time from raw events
            java.util.Map<String, Long> totalMs = new java.util.HashMap<>();
            java.util.Map<String, Long> sessionStarts = new java.util.HashMap<>();

            UsageEvents events = usm.queryEvents(startOfDay, now);
            if (events != null) {
                UsageEvents.Event event = new UsageEvents.Event();
                while (events.hasNextEvent()) {
                    events.getNextEvent(event);
                    String pkg = event.getPackageName();
                    if (event.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                        sessionStarts.put(pkg, event.getTimeStamp());
                    } else if (event.getEventType() == UsageEvents.Event.MOVE_TO_BACKGROUND) {
                        Long start = sessionStarts.remove(pkg);
                        if (start != null) {
                            long prev = totalMs.containsKey(pkg) ? totalMs.get(pkg) : 0;
                            totalMs.put(pkg, prev + (event.getTimeStamp() - start));
                        }
                    }
                }
            }

            // Add elapsed time for apps still in foreground
            for (java.util.Map.Entry<String, Long> entry : sessionStarts.entrySet()) {
                String pkg = entry.getKey();
                long prev = totalMs.containsKey(pkg) ? totalMs.get(pkg) : 0;
                totalMs.put(pkg, prev + (now - entry.getValue()));
            }

            WritableArray result = Arguments.createArray();
            for (java.util.Map.Entry<String, Long> entry : totalMs.entrySet()) {
                long ms = entry.getValue();
                if (ms <= 0) continue;
                if (!launcherPackages.contains(entry.getKey())) continue;
                if (entry.getKey().equals(reactContext.getPackageName())) continue;

                String label = entry.getKey();
                try {
                    ApplicationInfo info = pm.getApplicationInfo(entry.getKey(), 0);
                    label = pm.getApplicationLabel(info).toString();
                } catch (PackageManager.NameNotFoundException ignored) {}

                WritableMap item = Arguments.createMap();
                item.putString("packageName", entry.getKey());
                item.putString("appName", label);
                item.putInt("secondsToday", (int)(ms / 1000));
                result.pushMap(item);
            }
            promise.resolve(result);
        } catch (Exception e) {
            // Fall back to aggregate-based method
            getDailyUsageAll(promise);
        }
    }

    /**
     * Returns session-level usage data since the last flush.
     * Each session is { packageName, displayName, startedAt, endedAt, durationSeconds }.
     * Open sessions (still in foreground) have endedAt = null.
     */
    @ReactMethod
    public void getSessionsSinceLastFlush(Promise promise) {
        try {
            Context ctx = getReactApplicationContext();
            UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            PackageManager pm = ctx.getPackageManager();
            SharedPreferences prefs = ctx.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE);

            long now = System.currentTimeMillis();
            Calendar cal = Calendar.getInstance();
            cal.set(Calendar.HOUR_OF_DAY, 0);
            cal.set(Calendar.MINUTE, 0);
            cal.set(Calendar.SECOND, 0);
            cal.set(Calendar.MILLISECOND, 0);
            long startOfToday = cal.getTimeInMillis();
            long lastFlush = prefs.getLong("pearguard_last_session_flush", startOfToday);

            UsageEvents events = usm.queryEvents(lastFlush, now);
            if (events == null) {
                promise.resolve(Arguments.createArray());
                return;
            }

            java.util.Map<String, Long> fgStarts = new java.util.HashMap<>();
            WritableArray sessions = Arguments.createArray();
            UsageEvents.Event event = new UsageEvents.Event();

            while (events.getNextEvent(event)) {
                String pkg = event.getPackageName();
                if (pkg.equals(ctx.getPackageName())) continue;

                if (event.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                    fgStarts.put(pkg, event.getTimeStamp());
                } else if (event.getEventType() == UsageEvents.Event.MOVE_TO_BACKGROUND) {
                    Long start = fgStarts.remove(pkg);
                    if (start != null) {
                        long durationSec = (event.getTimeStamp() - start) / 1000;
                        if (durationSec >= 1) {
                            WritableMap session = Arguments.createMap();
                            session.putString("packageName", pkg);
                            session.putString("displayName", getAppLabel(pm, pkg));
                            session.putDouble("startedAt", (double) start);
                            session.putDouble("endedAt", (double) event.getTimeStamp());
                            session.putInt("durationSeconds", (int) durationSec);
                            sessions.pushMap(session);
                        }
                    }
                }
            }

            // Open sessions (still in foreground)
            for (java.util.Map.Entry<String, Long> entry : fgStarts.entrySet()) {
                long start = entry.getValue();
                long durationSec = (now - start) / 1000;
                if (durationSec >= 1) {
                    WritableMap session = Arguments.createMap();
                    session.putString("packageName", entry.getKey());
                    session.putString("displayName", getAppLabel(pm, entry.getKey()));
                    session.putDouble("startedAt", (double) start);
                    session.putNull("endedAt");
                    session.putInt("durationSeconds", (int) durationSec);
                    sessions.pushMap(session);
                }
            }

            prefs.edit().putLong("pearguard_last_session_flush", now).apply();
            promise.resolve(sessions);
        } catch (Exception e) {
            promise.reject("SESSION_ERROR", e.getMessage());
        }
    }

    private String getAppLabel(PackageManager pm, String packageName) {
        try {
            ApplicationInfo ai = pm.getApplicationInfo(packageName, 0);
            return pm.getApplicationLabel(ai).toString();
        } catch (Exception e) {
            return packageName;
        }
    }

    /**
     * Returns weekly usage for all launcher-visible apps as an array of
     * { packageName: string, appName: string, secondsThisWeek: number }.
     * Only includes apps with > 0 seconds.
     */
    @ReactMethod
    public void getWeeklyUsageAll(Promise promise) {
        UsageStatsManager usm = (UsageStatsManager)
                reactContext.getSystemService(Context.USAGE_STATS_SERVICE);
        PackageManager pm = reactContext.getPackageManager();

        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.DAY_OF_WEEK, cal.getFirstDayOfWeek());
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long startOfWeek = cal.getTimeInMillis();
        long now = System.currentTimeMillis();

        Map<String, UsageStats> statsMap = usm.queryAndAggregateUsageStats(startOfWeek, now);

        java.util.Set<String> launcherPackages = new java.util.HashSet<>();
        Intent launcherIntent = new Intent(Intent.ACTION_MAIN, null);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolveInfos = pm.queryIntentActivities(launcherIntent, 0);
        if (resolveInfos != null) {
            for (ResolveInfo ri : resolveInfos) {
                launcherPackages.add(ri.activityInfo.packageName);
            }
        }

        WritableArray result = Arguments.createArray();
        if (statsMap != null) {
            for (Map.Entry<String, UsageStats> entry : statsMap.entrySet()) {
                long ms = entry.getValue().getTotalTimeInForeground();
                if (ms <= 0) continue;
                if (!launcherPackages.contains(entry.getKey())) continue;
                if (entry.getKey().equals(reactContext.getPackageName())) continue;

                String label = entry.getKey();
                try {
                    ApplicationInfo info = pm.getApplicationInfo(entry.getKey(), 0);
                    label = pm.getApplicationLabel(info).toString();
                } catch (PackageManager.NameNotFoundException ignored) {}

                WritableMap item = Arguments.createMap();
                item.putString("packageName", entry.getKey());
                item.putString("appName", label);
                item.putInt("secondsThisWeek", (int)(ms / 1000));
                result.pushMap(item);
            }
        }
        promise.resolve(result);
    }

    /**
     * Returns all apps that have a home-screen launcher icon as
     * { packageName: string, appName: string }.
     * Uses ACTION_MAIN + CATEGORY_LAUNCHER to include pre-installed apps like
     * Chrome and YouTube that have FLAG_SYSTEM but are still user-visible.
     */
    @ReactMethod
    public void getInstalledPackages(Promise promise) {
        PackageManager pm = reactContext.getPackageManager();

        // Determine the default home launcher package so it can be auto-approved
        Intent homeIntent = new Intent(Intent.ACTION_MAIN, null);
        homeIntent.addCategory(Intent.CATEGORY_HOME);
        ResolveInfo defaultHome = pm.resolveActivity(homeIntent, PackageManager.MATCH_DEFAULT_ONLY);
        String launcherPackage = defaultHome != null ? defaultHome.activityInfo.packageName : null;

        Intent launcherIntent = new Intent(Intent.ACTION_MAIN, null);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolveInfos = pm.queryIntentActivities(launcherIntent, 0);

        WritableArray result = Arguments.createArray();
        if (resolveInfos == null) {
            promise.resolve(result);
            return;
        }
        for (ResolveInfo info : resolveInfos) {
            ApplicationInfo ai = info.activityInfo.applicationInfo;
            // Skip PearGuard itself
            if (ai.packageName.equals(reactContext.getPackageName())) continue;

            String appName;
            try {
                appName = pm.getApplicationLabel(ai).toString();
            } catch (Exception e) {
                appName = ai.packageName;
            }

            WritableMap item = Arguments.createMap();
            item.putString("packageName", ai.packageName);
            item.putString("appName", appName);
            item.putBoolean("isLauncher", ai.packageName.equals(launcherPackage));
            item.putString("category", AppCategoryHelper.getCategory(ai));
            try {
                android.graphics.drawable.Drawable drawable = pm.getApplicationIcon(ai.packageName);
                android.graphics.Bitmap bitmap = android.graphics.Bitmap.createBitmap(144, 144, android.graphics.Bitmap.Config.ARGB_8888);
                android.graphics.Canvas canvas = new android.graphics.Canvas(bitmap);
                drawable.setBounds(0, 0, 144, 144);
                drawable.draw(canvas);
                java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, baos);
                item.putString("iconBase64", android.util.Base64.encodeToString(baos.toByteArray(), android.util.Base64.NO_WRAP));
            } catch (Exception ignored) {}
            result.pushMap(item);
        }
        promise.resolve(result);
    }

    /**
     * Returns weekly usage for a single package as
     * { packageName, secondsThisWeek }.
     */
    @ReactMethod
    public void getWeeklyUsage(String packageName, Promise promise) {
        UsageStatsManager usm = (UsageStatsManager)
                reactContext.getSystemService(Context.USAGE_STATS_SERVICE);

        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.DAY_OF_WEEK, cal.getFirstDayOfWeek());
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long startOfWeek = cal.getTimeInMillis();
        long now = System.currentTimeMillis();

        Map<String, UsageStats> statsMap = usm.queryAndAggregateUsageStats(startOfWeek, now);
        if (statsMap != null && statsMap.containsKey(packageName)) {
            long ms = statsMap.get(packageName).getTotalTimeInForeground();
            WritableMap result = Arguments.createMap();
            result.putString("packageName", packageName);
            result.putInt("secondsThisWeek", (int)(ms / 1000));
            promise.resolve(result);
        } else {
            WritableMap result = Arguments.createMap();
            result.putString("packageName", packageName);
            result.putInt("secondsThisWeek", 0);
            promise.resolve(result);
        }
    }

    /**
     * Writes policy JSON to SharedPreferences so native modules can read it.
     * Called from app/index.tsx when a policy:update message arrives from the bare worklet.
     */
    @ReactMethod
    public void setPolicy(String policyJson) {
        SharedPreferences prefs = reactContext.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE);
        prefs.edit().putString("pearguard_policy", policyJson).apply();

        // When the parent sends a definitive decision (allowed/blocked), clear the pending
        // request suppression in AppBlockerModule so the overlay can resume normal behavior.
        try {
            org.json.JSONObject policy = new org.json.JSONObject(policyJson);
            org.json.JSONObject apps = policy.optJSONObject("apps");
            if (apps != null) {
                java.util.Iterator<String> keys = apps.keys();
                while (keys.hasNext()) {
                    String pkg = keys.next();
                    String status = apps.getJSONObject(pkg).optString("status", "allowed");
                    if ("allowed".equals(status) || "blocked".equals(status)) {
                        AppBlockerModule.clearPendingRequest(pkg);
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    /**
     * Stores a P2P-granted override expiry timestamp in SharedPreferences so
     * AppBlockerModule can read it during blocking checks.
     * Called from app/index.tsx when bare.js sends native:grantOverride.
     */
    @ReactMethod
    public void grantOverride(String packageName, double expiresAt, Promise promise) {
        SharedPreferences prefs = reactContext.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE);
        prefs.edit().putLong("pearguard_override_" + packageName, (long) expiresAt).apply();
        promise.resolve(null);
    }

    /**
     * Dismisses the block overlay if it is currently showing for the given package.
     * Called from app/index.tsx after a P2P override or policy update makes a package accessible.
     * Delegates to AppBlockerModule.dismissIfShowing() which is a no-op if the service is not
     * running or the overlay is showing a different package.
     */
    @ReactMethod
    public void dismissOverlayForPackage(String packageName, Promise promise) {
        AppBlockerModule.dismissIfShowing(packageName);
        promise.resolve(null);
    }

    /**
     * Dismisses any active block overlay unconditionally.
     * Called from app/index.tsx on child:reset (unpair) so the overlay is cleared
     * before navigating back to setup and the policy is wiped from SharedPreferences.
     */
    @ReactMethod
    public void dismissAllOverlays(Promise promise) {
        AppBlockerModule.dismissAll();
        promise.resolve(null);
    }

    /**
     * Full child state reset for Remove + Re-pair cycles. Clears:
     *   - pearguard_policy (stored policy JSON)
     *   - all pearguard_override_* (P2P-granted override expiry timestamps)
     *   - in-memory overrides HashMap and pendingRequestPackages in AppBlockerModule
     *
     * Called from app/index.tsx on child:reset in place of the old setPolicy('') call.
     * Using remove() instead of putString("", "") stores a true null so getString()
     * returns the default null and loadPolicy() cleanly returns null.
     */
    @ReactMethod
    public void clearChildState(Promise promise) {
        SharedPreferences prefs = reactContext.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE);
        SharedPreferences.Editor editor = prefs.edit();
        editor.remove("pearguard_policy");
        for (Map.Entry<String, ?> entry : prefs.getAll().entrySet()) {
            if (entry.getKey().startsWith("pearguard_override_")) {
                editor.remove(entry.getKey());
            }
        }
        editor.apply();
        AppBlockerModule.clearAllOverrides();
        promise.resolve(null);
    }

    private static final String REQUEST_CHANNEL_ID = "pearguard_time_requests";
    private static int notificationId = 2000;

    /**
     * Shows an Android notification on the parent device when a child requests access.
     * Called from app/index.tsx when the bare worklet emits time:request:received.
     */
    @ReactMethod
    public void showTimeRequestNotification(String childName, String appName, String childPublicKey) {
        NotificationManager nm =
                (NotificationManager) reactContext.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    REQUEST_CHANNEL_ID,
                    "Child Time Requests",
                    NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Alerts when a child requests access to a blocked app");
            nm.createNotificationChannel(channel);
        }

        PendingIntent pi = buildRequestsPendingIntent(childPublicKey, notificationId);

        String title = childName + " is requesting access";
        String body  = childName + " wants to use " + appName;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(reactContext, REQUEST_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);

        nm.notify(notificationId++, builder.build());
    }

    /**
     * Shows a notification on the parent device when a child's Accessibility Service is disabled.
     * Called from app/index.tsx when the bare worklet emits alert:bypass.
     */
    @ReactMethod
    public void showBypassAlertNotification(String childName, String childPublicKey) {
        NotificationManager nm =
                (NotificationManager) reactContext.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    REQUEST_CHANNEL_ID,
                    "Child Time Requests",
                    NotificationManager.IMPORTANCE_HIGH
            );
            nm.createNotificationChannel(channel);
        }

        PendingIntent pi = buildAlertsPendingIntent(childPublicKey, notificationId);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(reactContext, REQUEST_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(childName + "'s parental controls disabled")
                .setContentText(childName + " turned off the PearGuard Accessibility Service")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);

        nm.notify(notificationId++, builder.build());
    }

    /**
     * Shows a notification on the parent device when a child uses the PIN to bypass a block.
     */
    @ReactMethod
    public void showPinOverrideNotification(String childName, String appName, String childPublicKey) {
        NotificationManager nm =
                (NotificationManager) reactContext.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    REQUEST_CHANNEL_ID,
                    "Child Time Requests",
                    NotificationManager.IMPORTANCE_HIGH
            );
            nm.createNotificationChannel(channel);
        }

        PendingIntent pi = buildAlertsPendingIntent(childPublicKey, notificationId);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(reactContext, REQUEST_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(childName + " used PIN override")
                .setContentText(childName + " bypassed " + appName + " using the PIN")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);

        nm.notify(notificationId++, builder.build());
    }

    @ReactMethod
    public void showDecisionNotification(String appName, String decision) {
        NotificationManager nm =
                (NotificationManager) reactContext.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    REQUEST_CHANNEL_ID,
                    "Child Time Requests",
                    NotificationManager.IMPORTANCE_HIGH
            );
            nm.createNotificationChannel(channel);
        }

        boolean approved = "approved".equals(decision);
        String title = approved ? "Request approved" : "Request denied";
        String text = approved
                ? "Your parent allowed more time on " + appName
                : "Your parent denied the request for " + appName;

        // Deep link to child's Requests tab so tapping the notification is actionable
        Intent intent = new Intent(Intent.ACTION_VIEW,
                Uri.parse("pear://pearguard/child-requests"));
        intent.setPackage(reactContext.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
                reactContext, notificationId, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(reactContext, REQUEST_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(text)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);

        nm.notify(notificationId++, builder.build());
    }

    /**
     * Shows an app-installed notification. Works for both child device ("You installed…")
     * and parent device ("Alice installed…") depending on the childName passed.
     * Called from app/index.tsx when bare emits the app:installed event.
     */
    @ReactMethod
    public void showAppInstalledNotification(String childName, String appName, String childPublicKey) {
        NotificationManager nm =
                (NotificationManager) reactContext.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    REQUEST_CHANNEL_ID, "Child Time Requests", NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(channel);
        }

        boolean isSelf = "You".equals(childName);
        String title = isSelf
                ? "You installed " + appName
                : childName + " installed " + appName;
        String body = isSelf
                ? appName + " has been installed on your device"
                : appName + " is pending your approval";

        PendingIntent pi = buildAppsTabPendingIntent(childPublicKey, notificationId);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(reactContext, REQUEST_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);

        nm.notify(notificationId++, builder.build());
    }

    /**
     * Shows an app-uninstalled notification. Works for both child and parent devices.
     * Called from app/index.tsx when bare emits the app:uninstalled event.
     */
    @ReactMethod
    public void showAppUninstalledNotification(String childName, String appName, String childPublicKey) {
        NotificationManager nm =
                (NotificationManager) reactContext.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    REQUEST_CHANNEL_ID, "Child Time Requests", NotificationManager.IMPORTANCE_HIGH);
            nm.createNotificationChannel(channel);
        }

        boolean isSelf = "You".equals(childName);
        String title = isSelf
                ? "You uninstalled " + appName
                : childName + " uninstalled " + appName;
        String body = isSelf
                ? appName + " has been removed from your device"
                : appName + " has been removed from " + childName + "'s device";

        PendingIntent pi = buildAlertsPendingIntent(childPublicKey, notificationId);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(reactContext, REQUEST_CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setAutoCancel(true)
                .setContentIntent(pi);

        nm.notify(notificationId++, builder.build());
    }

    /**
     * Called from index.tsx when a heartbeat:received event arrives from a child.
     * Saves the child's last-seen timestamp and display name to SharedPreferences so
     * ParentConnectionService can detect stale heartbeats (enforcement stopped).
     * Also clears the stale-notification flag so we re-notify if the child goes offline again.
     */
    @ReactMethod
    public void updateChildHeartbeat(String childPublicKey, String displayName, double timestamp) {
        reactContext.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE)
            .edit()
            .putLong("heartbeat_last_" + childPublicKey, (long) timestamp)
            .putString("heartbeat_name_" + childPublicKey, displayName)
            .putBoolean("heartbeat_notified_" + childPublicKey, false)
            .apply();
    }

    /**
     * Shows a high-priority notification when a child's heartbeat goes stale,
     * indicating PearGuard may have been force-closed on their device.
     */
    @ReactMethod
    public void showEnforcementOfflineNotification(String childName, String childPublicKey) {
        NotificationManager nm =
            (NotificationManager) reactContext.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                "pearguard_offline", "PearGuard Offline Alerts",
                NotificationManager.IMPORTANCE_HIGH);
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        }

        PendingIntent pi = buildAlertsPendingIntent(childPublicKey, 8000 + childPublicKey.hashCode());

        NotificationCompat.Builder builder = new NotificationCompat.Builder(reactContext, "pearguard_offline")
            .setContentTitle("PearGuard enforcement may be off")
            .setContentText(childName + "'s device has not checked in — PearGuard may have been force-closed or app data cleared.")
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH);

        nm.notify(9000 + Math.abs(childPublicKey.hashCode() % 500), builder.build());
    }

    /**
     * Clears the EnforcementService heartbeat timestamp after the child fires a
     * force_stopped bypass:detected. Prevents the detection from re-triggering on
     * subsequent Root remounts before EnforcementService writes a fresh heartbeat.
     */
    @ReactMethod
    public void clearEnforcementHeartbeat() {
        reactContext.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE)
            .edit()
            .putLong("enforcement_heartbeat_ms", 0)
            .apply();
    }

    /**
     * Starts ParentConnectionService, keeping Hyperswarm alive while the app is backgrounded.
     * Safe to call multiple times — Android deduplicates startForegroundService calls.
     */
    @ReactMethod
    public void startParentService() {
        Intent intent = new Intent(reactContext, ParentConnectionService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent);
        } else {
            reactContext.startService(intent);
        }
    }

    /**
     * Stops the ParentConnectionService. Called when the device is in child mode
     * or when the user logs out, to avoid a stale foreground notification.
     */
    @ReactMethod
    public void stopParentService() {
        Intent intent = new Intent(reactContext, ParentConnectionService.class);
        reactContext.stopService(intent);
    }

    /**
     * Returns and clears the pending notification navigation URL stored by
     * MainActivity.interceptNotificationDeepLink().  Called by index.tsx when
     * the app comes to the foreground so it can navigate the WebView.
     */
    @ReactMethod
    public void consumePendingNavigation(Promise promise) {
        SharedPreferences prefs = reactContext.getSharedPreferences("pearguard_nav", Context.MODE_PRIVATE);
        String url = prefs.getString("pendingNavUrl", null);
        if (url != null) {
            prefs.edit().remove("pendingNavUrl").apply();
            promise.resolve(url);
        } else {
            promise.resolve(null);
        }
    }

    @ReactMethod
    public void getLastForegroundPackage(Promise promise) {
        promise.resolve(AppBlockerModule.getLastForegroundPackage());
    }

    @SuppressWarnings("deprecation")
    @ReactMethod
    public void hapticTap() {
        Vibrator v = (Vibrator) reactContext.getSystemService(Context.VIBRATOR_SERVICE);
        if (v == null || !v.hasVibrator()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (v.hasAmplitudeControl()) {
                v.vibrate(VibrationEffect.createOneShot(20, 80));
            } else {
                v.vibrate(VibrationEffect.createOneShot(50, VibrationEffect.DEFAULT_AMPLITUDE));
            }
        } else {
            v.vibrate(50);
        }
    }

    /**
     * Builds a PendingIntent that deep-links to the child's Activity tab in PearGuard.
     * URL: pear://pearguard/alerts?childPublicKey=<key>
     */
    private PendingIntent buildAlertsPendingIntent(String childPublicKey, int reqCode) {
        String url = "pear://pearguard/alerts?childPublicKey=" +
                Uri.encode(childPublicKey != null ? childPublicKey : "");
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.setPackage(reactContext.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
                reactContext, reqCode, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_CANCEL_CURRENT
        );
    }

    /**
     * Builds a PendingIntent that deep-links to the child's Activity tab in PearGuard.
     * URL: pear://pearguard/alerts?childPublicKey=<key>&tab=activity
     */
    private PendingIntent buildRequestsPendingIntent(String childPublicKey, int reqCode) {
        String url = "pear://pearguard/alerts?childPublicKey=" +
                Uri.encode(childPublicKey != null ? childPublicKey : "") + "&tab=activity";
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.setPackage(reactContext.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
                reactContext, reqCode, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_CANCEL_CURRENT
        );
    }

    /**
     * Builds a PendingIntent that deep-links to the child's Apps tab in PearGuard.
     * URL: pear://pearguard/alerts?childPublicKey=<key>&tab=apps
     */
    private PendingIntent buildAppsTabPendingIntent(String childPublicKey, int reqCode) {
        String url = "pear://pearguard/alerts?childPublicKey=" +
                Uri.encode(childPublicKey != null ? childPublicKey : "") + "&tab=apps";
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.setPackage(reactContext.getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
                reactContext, reqCode, intent,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_CANCEL_CURRENT
        );
    }
}