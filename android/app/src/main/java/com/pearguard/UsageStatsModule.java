package com.pearguard;

import android.app.AppOpsManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.os.Process;

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

    /**
     * Returns whether the app has been granted PACKAGE_USAGE_STATS permission.
     * Call this before getUsage() to check if the permission wizard needs to run.
     */
    @ReactMethod
    public void hasUsagePermission(Promise promise) {
        AppOpsManager appOps = (AppOpsManager) reactContext.getSystemService(Context.APP_OPS_SERVICE);
        int mode = appOps.checkOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            reactContext.getPackageName()
        );
        promise.resolve(mode == AppOpsManager.MODE_ALLOWED);
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

        WritableArray result = Arguments.createArray();
        if (statsMap != null) {
            for (Map.Entry<String, UsageStats> entry : statsMap.entrySet()) {
                long ms = entry.getValue().getTotalTimeInForeground();
                if (ms <= 0) continue;

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
        try {
            org.json.JSONObject p = new org.json.JSONObject(policyJson);
            boolean hasPinHash = p.has("pinHash") && !p.optString("pinHash", "").isEmpty();
            android.util.Log.d("PearGuard", "setPolicy: stored policy, hasPinHash=" + hasPinHash
                + " appCount=" + (p.has("apps") ? p.getJSONObject("apps").length() : 0));
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

    private static final String REQUEST_CHANNEL_ID = "pearguard_time_requests";
    private static int notificationId = 2000;

    /**
     * Shows an Android notification on the parent device when a child requests access.
     * Called from app/index.tsx when the bare worklet emits time:request:received.
     */
    @ReactMethod
    public void showTimeRequestNotification(String childName, String appName) {
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

        // Tapping the notification opens PearGuard
        Intent openApp = reactContext.getPackageManager()
            .getLaunchIntentForPackage(reactContext.getPackageName());
        PendingIntent pi = PendingIntent.getActivity(
            reactContext, 0,
            openApp != null ? openApp : new Intent(),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        String title = childName + " is requesting access";
        String body  = childName + " wants to use " + appName;

        NotificationCompat.Builder builder = new NotificationCompat.Builder(reactContext, REQUEST_CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(pi);

        nm.notify(notificationId++, builder.build());
    }
}
