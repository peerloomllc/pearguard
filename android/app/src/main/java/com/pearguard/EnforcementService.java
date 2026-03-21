package com.pearguard;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
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

public class EnforcementService extends Service {

    private static final String CHANNEL_ID = "pearguard_enforcement";
    private static final int NOTIFICATION_ID = 1000;
    private static final long POLL_INTERVAL_MS = 5_000;       // 5 seconds
    private static final long USAGE_FLUSH_INTERVAL_MS = 300_000; // 5 minutes

    private final Handler handler = new Handler(Looper.getMainLooper());
    private long lastUsageFlushTime = 0;
    private boolean lastAccessibilityState = true;

    // --- Lifecycle ---

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
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
                checkAccessibilityService();
                maybeFlushUsageStats();
            } catch (Exception ignored) {
            } finally {
                handler.postDelayed(this, POLL_INTERVAL_MS);
            }
        }
    };

    /**
     * Checks whether the PearGuard Accessibility Service is enabled.
     * If it transitions from enabled → disabled, fires onBypassDetected to RN
     * and shows the bypass warning notification.
     */
    private void checkAccessibilityService() {
        boolean isEnabled = isAccessibilityServiceEnabled();

        if (lastAccessibilityState && !isEnabled) {
            // Just became disabled — fire alert
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
        }
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
