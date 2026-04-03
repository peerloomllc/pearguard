package com.pearguard;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

import com.facebook.react.bridge.ReactContext;
import com.facebook.react.modules.core.DeviceEventManagerModule;

import java.util.Map;

/**
 * Foreground service for the parent device.
 *
 * Keeps the React Native (and Bare worklet) process alive while the parent
 * app is backgrounded. Without this, Android suspends the process and drops
 * all Hyperswarm TCP connections, so child messages (time requests, app installs,
 * bypass alerts) don't arrive until the parent reopens the app.
 *
 * Every RECONNECT_INTERVAL_MS it emits onParentReconnectNeeded via
 * DeviceEventEmitter so index.tsx can call swarm:reconnect on the Bare worklet,
 * quickly re-establishing any connections that dropped while backgrounded.
 */
public class ParentConnectionService extends Service {

    private static final String CHANNEL_ID          = "pearguard_parent";
    private static final String CHANNEL_OFFLINE_ID  = "pearguard_offline";
    private static final int    NOTIF_ID             = 1001;
    private static final long   RECONNECT_INTERVAL_MS  = 30_000; // 30 s
    private static final long   HEARTBEAT_STALE_MS     = 3 * 60_000; // 3 min (3 missed heartbeats)

    private final Handler handler = new Handler(Looper.getMainLooper());
    private int loopTick = 0; // counts 30s ticks; heartbeat check runs every 2nd tick (60 s)
    private long serviceStartedAt = 0;

    // --- Lifecycle ---

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIF_ID, buildNotification());
        serviceStartedAt = System.currentTimeMillis();
        handler.postDelayed(reconnectLoop, RECONNECT_INTERVAL_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(reconnectLoop);
        super.onDestroy();
    }

    // --- Reconnect loop ---

    private final Runnable reconnectLoop = new Runnable() {
        @Override
        public void run() {
            try {
                emitReconnectNeeded();
                loopTick++;
                if (loopTick % 2 == 0) checkStaleHeartbeats();
            } catch (Exception ignored) {
            } finally {
                handler.postDelayed(this, RECONNECT_INTERVAL_MS);
            }
        }
    };

    private void emitReconnectNeeded() {
        ReactContext ctx = PearGuardReactHost.get();
        if (ctx == null || !ctx.hasActiveReactInstance()) return;
        ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
           .emit("onParentReconnectNeeded", null);
    }

    /**
     * Scans SharedPreferences for child heartbeat entries that are older than
     * HEARTBEAT_STALE_MS. Fires an "enforcement offline" notification once per
     * stale period; clears the flag when a fresh heartbeat arrives (via
     * UsageStatsModule.updateChildHeartbeat which writes heartbeat_notified_=false).
     */
    private void checkStaleHeartbeats() {
        // Grace period: don't flag stale heartbeats until the service has been
        // running long enough for the P2P connection to re-establish and the
        // child to send at least one heartbeat. Prevents false "enforcement may
        // be off" notifications after app reinstalls or device restarts.
        long now = System.currentTimeMillis();
        if (now - serviceStartedAt < HEARTBEAT_STALE_MS) return;

        SharedPreferences prefs = getSharedPreferences("PearGuardPrefs", MODE_PRIVATE);
        Map<String, ?> all = prefs.getAll();
        SharedPreferences.Editor editor = null;

        for (Map.Entry<String, ?> entry : all.entrySet()) {
            String key = entry.getKey();
            if (!key.startsWith("heartbeat_last_")) continue;
            String childPublicKey = key.substring("heartbeat_last_".length());

            Object val = entry.getValue();
            if (!(val instanceof Long)) continue;
            long lastHeartbeat = (Long) val;
            if (lastHeartbeat <= 0) continue;

            // Ignore heartbeat timestamps from before this service session —
            // they are leftover from a previous run and don't indicate the
            // child went offline during this session.
            if (lastHeartbeat < serviceStartedAt) continue;

            boolean alreadyNotified = prefs.getBoolean("heartbeat_notified_" + childPublicKey, false);
            if (now - lastHeartbeat > HEARTBEAT_STALE_MS && !alreadyNotified) {
                String childName = prefs.getString("heartbeat_name_" + childPublicKey, "Your child");
                showOfflineNotification(childName, childPublicKey);
                if (editor == null) editor = prefs.edit();
                editor.putBoolean("heartbeat_notified_" + childPublicKey, true);
            }
        }

        if (editor != null) editor.apply();
    }

    private void showOfflineNotification(String childName, String childPublicKey) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_OFFLINE_ID, "PearGuard Offline Alerts",
                NotificationManager.IMPORTANCE_HIGH);
            ch.setShowBadge(true);
            nm.createNotificationChannel(ch);
        }

        String url = "pear://pearguard/alerts?childPublicKey=" + Uri.encode(childPublicKey);
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.setPackage(getPackageName());
        intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            this, 8000 + Math.abs(childPublicKey.hashCode() % 500), intent,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        Notification notif = new NotificationCompat.Builder(this, CHANNEL_OFFLINE_ID)
            .setContentTitle("PearGuard enforcement may be off")
            .setContentText(childName + "'s device has not checked in — PearGuard may have been force-closed or app data cleared.")
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build();

        nm.notify(9000 + Math.abs(childPublicKey.hashCode() % 500), notif);
    }

    // --- Notification ---

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "PearGuard Parent Service",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Keeps PearGuard connected to your child's device");
            channel.setShowBadge(false);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    private Notification buildNotification() {
        Intent openApp = new Intent(this, MainActivity.class);
        openApp.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(
            this, 0, openApp,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("PearGuard")
            .setContentText("Monitoring your child's device")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(pi)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }
}
