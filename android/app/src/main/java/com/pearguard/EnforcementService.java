package com.pearguard;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;

import androidx.core.app.NotificationCompat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.HashSet;
import java.util.Set;

public class EnforcementService extends Service {

    private static final String CHANNEL_ID = "pearguard_enforcement";
    private static final int NOTIFICATION_ID = 1000;
    private static final long POLL_INTERVAL_MS = 5_000;       // 5 seconds
    private static final long USAGE_FLUSH_INTERVAL_MS = 60_000; // 1 minute
    private static final String WARNING_CHANNEL_ID = "pearguard_upcoming_warning";
    private static final int[] DEFAULT_WARNING_THRESHOLDS_MIN = {10, 5, 1};

    private final Handler handler = new Handler(Looper.getMainLooper());
    private long lastUsageFlushTime = 0;
    private boolean lastAccessibilityState = true;
    private final Set<String> shownWarnings = new HashSet<>();
    private int lastWarningDayOfYear = -1;

    // --- Lifecycle ---

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        createWarningNotificationChannel();
        startForeground(NOTIFICATION_ID, buildNotification());
        lastAccessibilityState = isAccessibilityServiceEnabled();
        handler.post(enforcementLoop);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // START_STICKY: if the service is killed, the OS restarts it
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(enforcementLoop);
        super.onDestroy();
    }

    // --- Enforcement loop ---

    private final Runnable enforcementLoop = new Runnable() {
        @Override
        public void run() {
            try {
                writeEnforcementHeartbeat();
                checkAccessibilityService();
                checkForegroundEnforcement();
                checkWarningNotifications();
                maybeFlushUsageStats();
            } catch (Exception ignored) {
            } finally {
                handler.postDelayed(this, POLL_INTERVAL_MS);
            }
        }
    };

    /**
     * Writes the current timestamp to SharedPreferences on every loop tick.
     * When PearGuard is force-stopped, onDestroy() is never called so this
     * timestamp goes stale, allowing startup detection of a force-stop event.
     */
    private void writeEnforcementHeartbeat() {
        getSharedPreferences("PearGuardPrefs", MODE_PRIVATE)
            .edit()
            .putLong("enforcement_heartbeat_ms", System.currentTimeMillis())
            .apply();
    }

    /**
     * Checks whether the PearGuard Accessibility Service is enabled.
     * If it transitions from enabled → disabled, fires onBypassDetected to RN
     * and shows the bypass warning notification.
     */
    private void checkAccessibilityService() {
        boolean isEnabled = isAccessibilityServiceEnabled();

        if (lastAccessibilityState && !isEnabled) {
            // Just became disabled — persist to SharedPreferences so the next app launch
            // can detect and relay this even if the RN JS thread was suspended right now.
            getSharedPreferences("PearGuardPrefs", MODE_PRIVATE)
                .edit()
                .putString("bypass_detected_reason", "accessibility_disabled")
                .putLong("bypass_detected_at", System.currentTimeMillis())
                .apply();

            AppBlockerModule.showBypassNotification(this);

            ReactContext reactContext = PearGuardReactHost.get();
            if (reactContext != null && reactContext.hasActiveReactInstance()) {
                reactContext
                    .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit("onBypassDetected", "accessibility_disabled");
            }
        }

        lastAccessibilityState = isEnabled;
    }

    /**
     * Every 5 minutes: emit onUsageFlush to RN so the bare worklet can
     * gather usage stats (via UsageStatsModule.getDailyUsageAll()) and
     * send a usage:report to the parent.
     */
    private void maybeFlushUsageStats() {
        long now = System.currentTimeMillis();
        if (now - lastUsageFlushTime < USAGE_FLUSH_INTERVAL_MS) return;
        lastUsageFlushTime = now;

        ReactContext reactContext = PearGuardReactHost.get();
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
            WritableMap params = Arguments.createMap();
            params.putDouble("timestamp", now);
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("onUsageFlush", params);
        } else {
            // RN bridge is not active (app backgrounded/killed) — reset so we
            // retry on the next loop iteration rather than waiting a full 5 minutes
            lastUsageFlushTime = 0;
        }
    }

    /**
     * Checks whether the current foreground app is blocked and shows the overlay if so.
     * AppBlockerModule tracks the last foreground package via onAccessibilityEvent, so
     * this works regardless of how long the app has been open (#66).
     */
    private void checkForegroundEnforcement() {
        AppBlockerModule.checkAndShowOverlayIfNeeded();
    }

    private boolean isAccessibilityServiceEnabled() {
        String prefString;
        try {
            prefString = Settings.Secure.getString(
                getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            );
        } catch (Exception e) {
            return false;
        }

        if (TextUtils.isEmpty(prefString)) return false;

        // Check if our accessibility service is in the enabled list
        String ourService = getPackageName() + "/" + AppBlockerModule.class.getName();
        TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
        splitter.setString(prefString);
        while (splitter.hasNext()) {
            if (splitter.next().equalsIgnoreCase(ourService)) return true;
        }
        return false;
    }

    // --- Upcoming warning notifications ---

    private void checkWarningNotifications() {
        int today = Calendar.getInstance().get(Calendar.DAY_OF_YEAR);
        if (today != lastWarningDayOfYear) {
            shownWarnings.clear();
            lastWarningDayOfYear = today;
        }

        JSONObject policy = loadPolicyFromPrefs();
        if (policy == null) return;

        checkScheduleWarnings(policy);
        checkTimeLimitWarnings(policy);
    }

    private int[] getWarningThresholds(JSONObject policy) {
        try {
            JSONObject settings = policy.optJSONObject("settings");
            if (settings != null) {
                org.json.JSONArray arr = settings.optJSONArray("warningMinutes");
                if (arr != null && arr.length() > 0) {
                    int[] thresholds = new int[arr.length()];
                    for (int i = 0; i < arr.length(); i++) thresholds[i] = arr.getInt(i);
                    return thresholds;
                }
            }
        } catch (Exception ignored) {}
        return DEFAULT_WARNING_THRESHOLDS_MIN;
    }

    private JSONObject loadPolicyFromPrefs() {
        try {
            String json = getSharedPreferences("PearGuardPrefs", MODE_PRIVATE)
                .getString("pearguard_policy", null);
            return json != null ? new JSONObject(json) : null;
        } catch (Exception e) {
            return null;
        }
    }

    private void checkScheduleWarnings(JSONObject policy) {
        try {
            JSONArray schedules = policy.optJSONArray("schedules");
            if (schedules == null) return;

            Calendar now = Calendar.getInstance();
            int dayOfWeek = now.get(Calendar.DAY_OF_WEEK) - 1; // 0=Sunday
            int nowSeconds = (now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)) * 60
                    + now.get(Calendar.SECOND);

            for (int i = 0; i < schedules.length(); i++) {
                JSONObject schedule = schedules.getJSONObject(i);
                JSONArray days = schedule.getJSONArray("days");

                boolean dayMatches = false;
                for (int d = 0; d < days.length(); d++) {
                    if (days.getInt(d) == dayOfWeek) { dayMatches = true; break; }
                }
                if (!dayMatches) continue;

                String[] startParts = schedule.getString("start").split(":");
                int startSeconds = (Integer.parseInt(startParts[0]) * 60
                        + Integer.parseInt(startParts[1])) * 60;

                int secondsUntil = startSeconds - nowSeconds;
                if (secondsUntil < 0) secondsUntil += 24 * 3600;

                if (secondsUntil <= 0) continue;

                String label = schedule.optString("label", "Scheduled block");

                int[] thresholds = getWarningThresholds(policy);
                // Skip if we're further out than the largest threshold + 1 min
                if (thresholds.length > 0 && secondsUntil > (thresholds[0] + 1) * 60) continue;
                for (int t = 0; t < thresholds.length; t++) {
                    int threshMin = thresholds[t];
                    int threshSec = threshMin * 60;
                    if (secondsUntil <= threshSec && secondsUntil > threshSec - 6) {
                        String dedupKey = "sched:" + i + ":" + threshMin;
                        if (shownWarnings.add(dedupKey)) {
                            int notifId = 2000 + i * 10 + t;
                            showWarningNotification(notifId,
                                label + " starts in " + threshMin
                                    + " minute" + (threshMin > 1 ? "s" : ""),
                                "Apps will be restricted when \""
                                    + label + "\" begins.");
                        }
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private void checkTimeLimitWarnings(JSONObject policy) {
        try {
            String foregroundPkg = AppBlockerModule.getLastForegroundPackage();
            if (foregroundPkg == null) return;

            JSONObject apps = policy.optJSONObject("apps");
            if (apps == null || !apps.has(foregroundPkg)) return;

            JSONObject appPolicy = apps.getJSONObject(foregroundPkg);
            int limitSeconds = appPolicy.optInt("dailyLimitSeconds", -1);
            if (limitSeconds <= 0) return;

            int usedSeconds = getDailyUsageSeconds(foregroundPkg);
            int remainingSeconds = limitSeconds - usedSeconds;
            if (remainingSeconds <= 0) return;

            String appName = appPolicy.optString("appName", foregroundPkg);

            int[] thresholds = getWarningThresholds(policy);
            for (int t = 0; t < thresholds.length; t++) {
                int threshMin = thresholds[t];
                int threshSec = threshMin * 60;
                if (remainingSeconds <= threshSec && remainingSeconds > threshSec - 6) {
                    String dedupKey = "limit:" + foregroundPkg + ":" + threshMin;
                    if (shownWarnings.add(dedupKey)) {
                        int notifId = 3000
                                + (foregroundPkg.hashCode() & 0x7FFFFFFF) % 900 + t;
                        showWarningNotification(notifId,
                            appName + ": " + threshMin
                                + " minute" + (threshMin > 1 ? "s" : "")
                                + " remaining",
                            "Your daily limit for " + appName + " is almost up.");
                    }
                }
            }
        } catch (Exception ignored) {}
    }

    private int getDailyUsageSeconds(String packageName) {
        UsageStatsManager usm = (UsageStatsManager) getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return 0;
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long startOfDay = cal.getTimeInMillis();
        long now = System.currentTimeMillis();
        try {
            UsageEvents events = usm.queryEvents(startOfDay, now);
            if (events == null) return 0;
            UsageEvents.Event event = new UsageEvents.Event();
            long totalMs = 0;
            long sessionStart = -1;
            while (events.hasNextEvent()) {
                events.getNextEvent(event);
                if (!packageName.equals(event.getPackageName())) continue;
                if (event.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                    sessionStart = event.getTimeStamp();
                } else if (event.getEventType() == UsageEvents.Event.MOVE_TO_BACKGROUND
                        && sessionStart >= 0) {
                    totalMs += event.getTimeStamp() - sessionStart;
                    sessionStart = -1;
                }
            }
            if (sessionStart >= 0) totalMs += now - sessionStart;
            return (int) (totalMs / 1000);
        } catch (Exception e) {
            return 0;
        }
    }

    private void showWarningNotification(int notificationId, String title, String body) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        PendingIntent pi = null;
        try {
            Intent openApp = new Intent(this, Class.forName("com.pearguard.MainActivity"));
            pi = PendingIntent.getActivity(this, notificationId, openApp,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        } catch (ClassNotFoundException ignored) {}

        NotificationCompat.Builder builder =
                new NotificationCompat.Builder(this, WARNING_CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle(title)
                    .setContentText(body)
                    .setPriority(NotificationCompat.PRIORITY_HIGH)
                    .setAutoCancel(true)
                    .setTimeoutAfter(5 * 60 * 1000);

        if (pi != null) builder.setContentIntent(pi);
        nm.notify(notificationId, builder.build());
    }

    private void createWarningNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                WARNING_CHANNEL_ID,
                "Upcoming Limit Warnings",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Warnings before schedule blocks or time limits");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    // --- Foreground notification ---

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "PearGuard Active",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("PearGuard parental controls are running");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        PendingIntent pi = null;
        try {
            Intent openApp = new Intent(this, Class.forName("com.pearguard.MainActivity"));
            pi = PendingIntent.getActivity(
                this, 0, openApp,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        } catch (ClassNotFoundException e) {
            // Notification will have no tap action — not a crash condition
        }

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("PearGuard is active")
            .setContentText("Parental controls are running")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true);

        if (pi != null) builder.setContentIntent(pi);
        return builder.build();
    }
}
