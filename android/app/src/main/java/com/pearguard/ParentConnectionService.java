package com.pearguard;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
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
    private static final long   NOTIFY_COOLDOWN_MS     = 30 * 60_000; // 30 min between notifications per child
    // After the service (re)starts, wait this long before flagging stale heartbeats
    // so a freshly-woken worklet has time to rejoin Hyperswarm and the child can
    // send a heartbeat. Longer than HEARTBEAT_STALE_MS because a cold boot
    // (BootReceiver / START_STICKY restart) reconnects slower than a foregrounded app.
    private static final long   STARTUP_GRACE_MS       = 5 * 60_000; // 5 min

    private static final long WAKE_THROTTLE_MS = 2 * 60_000; // min gap between RN wake attempts
    private static long lastWakeAt = 0; // static: survives service teardown/restart

    private final Handler handler = new Handler(Looper.getMainLooper());
    private int loopTick = 0; // counts 30s ticks; heartbeat check runs every 2nd tick (60 s)
    private long serviceStartedAt = 0;
    private ConnectivityManager connectivityManager;
    private ConnectivityManager.NetworkCallback networkCallback;

    // --- Lifecycle ---

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIF_ID, buildNotification());
        serviceStartedAt = System.currentTimeMillis();
        registerNetworkCallback();
        handler.postDelayed(reconnectLoop, RECONNECT_INTERVAL_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // The RN/Bare process may not be running when this service starts:
        //   - cold-started by BootReceiverModule after a reboot ("source"=="boot")
        //   - restarted by the OS via START_STICKY after a low-memory / battery-saver
        //     kill (intent is null)
        // In both cases the service can show its notification but cannot actually
        // reconnect Hyperswarm — emitReconnectNeeded() bails when there is no active
        // React instance. Wake the RN host so index.tsx restarts the worklet;
        // MainActivity backgrounds itself shortly after (parent_boot_wake).
        // When RN itself called startParentService() the instance is already active,
        // so this is a no-op on the normal foregrounded path.
        ReactContext ctx = PearGuardReactHost.get();
        if (ctx == null || !ctx.hasActiveReactInstance()) {
            maybeWakeReactHost();
        }
        return START_STICKY;
    }

    /**
     * Launches MainActivity to bring the RN bridge (and Bare worklet) back up.
     * Throttled so a flapping service / repeated OS restarts cannot spin the
     * activity. MainActivity moves itself to the background ~10s after waking.
     */
    private void maybeWakeReactHost() {
        long now = System.currentTimeMillis();
        if (now - lastWakeAt < WAKE_THROTTLE_MS) return;
        lastWakeAt = now;
        try {
            Intent wake = new Intent(this, MainActivity.class);
            wake.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_NO_ANIMATION);
            wake.putExtra("parent_boot_wake", true);
            startActivity(wake);
        } catch (Exception ignored) {
        }
    }

    /**
     * The user swiped the app away from recents. On stock Android a foreground
     * service survives this, but many OEMs (and low-memory situations right
     * after) kill the whole process, taking the Hyperswarm connection with it
     * and silently stopping the parent from receiving child messages.
     *
     * Schedule a near-future restart via AlarmManager -> ServiceRestartReceiver
     * so the service comes back and onStartCommand re-wakes the RN/Bare worklet.
     * An inexact alarm (set, not setExact) avoids the SCHEDULE_EXACT_ALARM
     * permission; the parent is Doze-exempt so it still fires promptly.
     *
     * A true force-stop or reinstall cannot be revived this way — Android blocks
     * all auto-start until the user reopens the app or reboots.
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        try {
            Intent restart = new Intent(getApplicationContext(), ServiceRestartReceiver.class);
            PendingIntent pi = PendingIntent.getBroadcast(
                    getApplicationContext(), 1, restart,
                    PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE);
            android.app.AlarmManager am =
                    (android.app.AlarmManager) getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                am.set(android.app.AlarmManager.RTC_WAKEUP,
                        System.currentTimeMillis() + 2000, pi);
            }
        } catch (Exception ignored) {
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(reconnectLoop);
        unregisterNetworkCallback();
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
     * Re-announce to Hyperswarm immediately when the default network changes
     * (WiFi -> cellular, network regained after loss). The 30s reconnect loop
     * is a safety net; this is the fast path.
     */
    private void registerNetworkCallback() {
        try {
            connectivityManager = (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (connectivityManager == null) return;
            networkCallback = new ConnectivityManager.NetworkCallback() {
                @Override
                public void onAvailable(Network network) {
                    emitReconnectNeeded();
                }
            };
            connectivityManager.registerDefaultNetworkCallback(networkCallback);
        } catch (Exception ignored) {
        }
    }

    private void unregisterNetworkCallback() {
        try {
            if (connectivityManager != null && networkCallback != null) {
                connectivityManager.unregisterNetworkCallback(networkCallback);
            }
        } catch (Exception ignored) {
        } finally {
            networkCallback = null;
        }
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
        if (now - serviceStartedAt < STARTUP_GRACE_MS) return;

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

            // NOTE: we deliberately evaluate heartbeats from before this service
            // session too. A child that went offline (uninstalled / wiped / force-
            // stopped) right around when this service (re)started has a last-
            // heartbeat predating serviceStartedAt; skipping those left such a child
            // permanently un-flagged across a parent reboot — the silent-failure the
            // dead-man's-switch exists to prevent. The STARTUP_GRACE_MS window above
            // prevents false positives while the connection re-establishes, and the
            // persistent heartbeat_notified_ flag (reset on the next fresh heartbeat)
            // prevents duplicate alerts across restarts.

            boolean alreadyNotified = prefs.getBoolean("heartbeat_notified_" + childPublicKey, false);
            long lastNotifiedAt = prefs.getLong("heartbeat_notified_at_" + childPublicKey, 0);
            boolean inCooldown = (now - lastNotifiedAt) < NOTIFY_COOLDOWN_MS;
            if (now - lastHeartbeat > HEARTBEAT_STALE_MS && !alreadyNotified && !inCooldown) {
                String childName = prefs.getString("heartbeat_name_" + childPublicKey, "Your child");
                showOfflineNotification(childName, childPublicKey);
                if (editor == null) editor = prefs.edit();
                editor.putBoolean("heartbeat_notified_" + childPublicKey, true);
                editor.putLong("heartbeat_notified_at_" + childPublicKey, now);
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
