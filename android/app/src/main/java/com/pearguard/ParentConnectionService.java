package com.pearguard;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import androidx.core.app.NotificationCompat;

import com.facebook.react.bridge.ReactContext;
import com.facebook.react.modules.core.DeviceEventManagerModule;

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

    private static final String CHANNEL_ID   = "pearguard_parent";
    private static final int    NOTIF_ID     = 1001;
    private static final long   RECONNECT_INTERVAL_MS = 30_000; // 30 seconds

    private final Handler handler = new Handler(Looper.getMainLooper());

    // --- Lifecycle ---

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        startForeground(NOTIF_ID, buildNotification());
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
