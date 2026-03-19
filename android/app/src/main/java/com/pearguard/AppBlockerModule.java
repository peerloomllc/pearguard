package com.pearguard;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;

import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.ReactContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.goterl.lazysodium.LazySodiumAndroid;
import com.goterl.lazysodium.SodiumAndroid;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.Calendar;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

public class AppBlockerModule extends AccessibilityService {

    private static final String PREFS_NAME = "PearGuardPrefs";
    private static final String POLICY_KEY = "pearguard_policy";
    private static final String CHANNEL_ID = "pearguard_bypass_warning";

    // Phone/messaging package identifiers — these get contact-based exceptions
    private static final Set<String> PHONE_PACKAGES = new HashSet<>();
    static {
        PHONE_PACKAGES.add("com.android.dialer");
        PHONE_PACKAGES.add("com.google.android.dialer");
        PHONE_PACKAGES.add("com.android.mms");
        PHONE_PACKAGES.add("com.google.android.apps.messaging");
    }

    private WindowManager windowManager;
    private View overlayView;
    private String currentOverlayPackage;
    private View pinDialogView;

    // In-memory override: packageName -> expiry time in ms
    private final HashMap<String, Long> overrides = new HashMap<>();

    private LazySodiumAndroid lazySodium;

    // --- Lifecycle ---

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        AccessibilityServiceInfo info = new AccessibilityServiceInfo();
        info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED;
        info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
        info.notificationTimeout = 100;
        info.flags = AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
            | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
        setServiceInfo(info);

        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        lazySodium = new LazySodiumAndroid(new SodiumAndroid());

        createBypassNotificationChannel();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;

        CharSequence pkg = event.getPackageName();
        if (pkg == null) return;
        String packageName = pkg.toString();

        // Never block PearGuard itself
        if (packageName.equals(getPackageName())) {
            dismissOverlay();
            return;
        }

        String blockReason = getBlockReason(packageName);

        if (blockReason != null) {
            showOverlay(packageName, blockReason);
        } else {
            dismissOverlay();
        }
    }

    @Override
    public void onInterrupt() {
        dismissOverlay();
    }

    // --- Enforcement logic ---

    /**
     * Returns a human-readable reason string if the app should be blocked,
     * or null if the app is allowed.
     */
    private String getBlockReason(String packageName) {
        // Check for active override (PIN was entered successfully)
        Long overrideExpiry = overrides.get(packageName);
        if (overrideExpiry != null && System.currentTimeMillis() < overrideExpiry) {
            return null; // override is active, allow
        }

        // Phone/messaging apps with contact exceptions: skip all block checks
        if (isPhoneOrMessagingApp(packageName)) {
            return null;
        }

        JSONObject policy = loadPolicy();
        if (policy == null) return null; // no policy yet, allow

        try {
            // Step 1: Permanently blocked or pending?
            JSONObject apps = policy.optJSONObject("apps");
            if (apps != null && apps.has(packageName)) {
                JSONObject appPolicy = apps.getJSONObject(packageName);
                String status = appPolicy.optString("status", "allowed");
                if ("blocked".equals(status)) {
                    return "This app is blocked by your parent.";
                }
                if ("pending".equals(status)) {
                    return "This app is waiting for parent approval.";
                }
            }

            // Step 2: Scheduled blackout?
            String scheduleReason = getScheduleBlockReason(policy);
            if (scheduleReason != null) return scheduleReason;

            // Step 3: Daily limit exceeded?
            if (apps != null && apps.has(packageName)) {
                JSONObject appPolicy = apps.getJSONObject(packageName);
                int limitSeconds = appPolicy.optInt("dailyLimitSeconds", -1);
                if (limitSeconds > 0) {
                    int usedSeconds = getDailyUsageSeconds(packageName);
                    if (usedSeconds >= limitSeconds) {
                        int minutes = limitSeconds / 60;
                        return "You've reached your " + minutes + " minute daily limit for this app.";
                    }
                }
            }

        } catch (Exception e) {
            // Parse error — fail open (allow)
        }

        return null; // Step 5: allow
    }

    private boolean isPhoneOrMessagingApp(String packageName) {
        if (PHONE_PACKAGES.contains(packageName)) return true;
        return packageName.contains("dialer")
            || packageName.contains("sms")
            || packageName.contains("messaging");
    }

    private String getScheduleBlockReason(JSONObject policy) {
        try {
            JSONArray schedules = policy.optJSONArray("schedules");
            if (schedules == null) return null;

            Calendar now = Calendar.getInstance();
            int dayOfWeek = now.get(Calendar.DAY_OF_WEEK) - 1; // 0=Sunday
            int hour = now.get(Calendar.HOUR_OF_DAY);
            int minute = now.get(Calendar.MINUTE);
            int nowMinutes = hour * 60 + minute;

            for (int i = 0; i < schedules.length(); i++) {
                JSONObject schedule = schedules.getJSONObject(i);
                JSONArray days = schedule.getJSONArray("days");
                boolean dayMatches = false;
                for (int d = 0; d < days.length(); d++) {
                    if (days.getInt(d) == dayOfWeek) { dayMatches = true; break; }
                }
                if (!dayMatches) continue;

                String[] startParts = schedule.getString("start").split(":");
                String[] endParts = schedule.getString("end").split(":");
                int startMinutes = Integer.parseInt(startParts[0]) * 60 + Integer.parseInt(startParts[1]);
                int endMinutes = Integer.parseInt(endParts[0]) * 60 + Integer.parseInt(endParts[1]);

                boolean inBlackout;
                if (startMinutes <= endMinutes) {
                    // Same-day range (e.g., 08:00–15:00)
                    inBlackout = nowMinutes >= startMinutes && nowMinutes < endMinutes;
                } else {
                    // Overnight range (e.g., 21:00–07:00)
                    inBlackout = nowMinutes >= startMinutes || nowMinutes < endMinutes;
                }

                if (inBlackout) {
                    return "Apps are blocked during \"" + schedule.optString("label", "scheduled time") + "\".";
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    private int getDailyUsageSeconds(String packageName) {
        android.app.usage.UsageStatsManager usm = (android.app.usage.UsageStatsManager)
            getSystemService(Context.USAGE_STATS_SERVICE);
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long startOfDay = cal.getTimeInMillis();
        Map<String, android.app.usage.UsageStats> stats =
            usm.queryAndAggregateUsageStats(startOfDay, System.currentTimeMillis());
        if (stats != null && stats.containsKey(packageName)) {
            return (int)(stats.get(packageName).getTotalTimeInForeground() / 1000);
        }
        return 0;
    }

    private JSONObject loadPolicy() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String json = prefs.getString(POLICY_KEY, null);
        if (json == null) return null;
        try {
            return new JSONObject(json);
        } catch (Exception e) {
            return null;
        }
    }

    // --- Overlay UI ---

    private void showOverlay(String packageName, String reason) {
        // If already showing overlay for this package, skip
        if (overlayView != null && packageName.equals(currentOverlayPackage)) return;

        dismissOverlay();
        currentOverlayPackage = packageName;

        String appName = getAppName(packageName);

        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(Color.argb(240, 20, 20, 20));
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(64, 64, 64, 64);

        TextView title = new TextView(this);
        title.setText(appName + " is blocked");
        title.setTextColor(Color.WHITE);
        title.setTextSize(22);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, 0, 0, 24);
        layout.addView(title);

        TextView reasonView = new TextView(this);
        reasonView.setText(reason);
        reasonView.setTextColor(Color.LTGRAY);
        reasonView.setTextSize(16);
        reasonView.setGravity(Gravity.CENTER);
        reasonView.setPadding(0, 0, 0, 48);
        layout.addView(reasonView);

        Button requestButton = new Button(this);
        requestButton.setText("Send Request");
        requestButton.setOnClickListener(v -> onSendRequest(packageName));
        layout.addView(requestButton);

        Button pinButton = new Button(this);
        pinButton.setText("Enter PIN");
        pinButton.setPadding(0, 24, 0, 0);
        pinButton.setOnClickListener(v -> onEnterPin(packageName));
        layout.addView(pinButton);

        final View pendingOverlay = layout;

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                : WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY,
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        );

        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                windowManager.addView(pendingOverlay, params);
                overlayView = pendingOverlay;
            } catch (Exception e) {
                // addView failed — overlayView remains null, overlay is not shown
            }
        });
    }

    private void dismissOverlay() {
        if (pinDialogView != null) {
            try { windowManager.removeView(pinDialogView); } catch (Exception ignored) {}
            pinDialogView = null;
        }
        if (overlayView != null) {
            try {
                windowManager.removeView(overlayView);
            } catch (Exception ignored) {}
            overlayView = null;
            currentOverlayPackage = null;
        }
    }

    private String getAppName(String packageName) {
        try {
            PackageManager pm = getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
            return pm.getApplicationLabel(info).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return packageName;
        }
    }

    // --- Button handlers ---

    private void onSendRequest(String packageName) {
        ReactContext reactContext = PearGuardReactHost.get();
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
            WritableMap params = Arguments.createMap();
            params.putString("packageName", packageName);
            params.putString("appName", getAppName(packageName));
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("onTimeRequest", params);
        }
        Toast.makeText(this, "Request sent to parent", Toast.LENGTH_SHORT).show();
    }

    private void onEnterPin(String packageName) {
        LinearLayout dialogLayout = new LinearLayout(this);
        dialogLayout.setOrientation(LinearLayout.VERTICAL);
        dialogLayout.setBackgroundColor(Color.argb(255, 30, 30, 30));
        dialogLayout.setPadding(48, 48, 48, 48);
        dialogLayout.setGravity(Gravity.CENTER);

        TextView prompt = new TextView(this);
        prompt.setText("Enter parent PIN:");
        prompt.setTextColor(Color.WHITE);
        prompt.setTextSize(18);
        dialogLayout.addView(prompt);

        EditText pinInput = new EditText(this);
        pinInput.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        pinInput.setHint("PIN");
        pinInput.setTextColor(Color.WHITE);
        pinInput.setHintTextColor(Color.GRAY);
        dialogLayout.addView(pinInput);

        Button confirmBtn = new Button(this);
        confirmBtn.setText("Unlock");
        dialogLayout.addView(confirmBtn);

        WindowManager.LayoutParams dialogParams = new WindowManager.LayoutParams(
            900,
            WindowManager.LayoutParams.WRAP_CONTENT,
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                : WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY,
            0, // no FLAG_NOT_FOCUSABLE — allows keyboard
            PixelFormat.TRANSLUCENT
        );
        dialogParams.gravity = Gravity.CENTER;

        windowManager.addView(dialogLayout, dialogParams);
        pinDialogView = dialogLayout;

        Button cancelBtn = new Button(this);
        cancelBtn.setText("Cancel");
        dialogLayout.addView(cancelBtn);
        cancelBtn.setOnClickListener(v -> {
            try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
            pinDialogView = null;
        });

        confirmBtn.setOnClickListener(v -> {
            String enteredPin = pinInput.getText().toString();
            if (verifyPin(enteredPin)) {
                // Grant timed override
                JSONObject policy = loadPolicy();
                int durationSeconds = 3600;
                if (policy != null) {
                    durationSeconds = policy.optInt("overrideDurationSeconds", 3600);
                }
                long expiryMs = System.currentTimeMillis() + (durationSeconds * 1000L);
                overrides.put(packageName, expiryMs);

                // Log PIN use — emit event to RN for inclusion in next usage:report
                ReactContext rc = PearGuardReactHost.get();
                if (rc != null && rc.hasActiveReactInstance()) {
                    WritableMap evt = Arguments.createMap();
                    evt.putString("packageName", packageName);
                    evt.putDouble("timestamp", System.currentTimeMillis());
                    evt.putInt("durationSeconds", durationSeconds);
                    rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                        .emit("onPinSuccess", evt);
                }

                // Remove dialog and overlay
                try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
                pinDialogView = null;
                dismissOverlay();
            } else {
                Toast.makeText(AppBlockerModule.this, "Incorrect PIN", Toast.LENGTH_SHORT).show();
            }
        });
    }

    /**
     * Verifies the entered PIN against the stored Argon2id hash using lazysodium.
     */
    private boolean verifyPin(String enteredPin) {
        JSONObject policy = loadPolicy();
        if (policy == null) return false;
        String pinHash = policy.optString("pinHash", null);
        if (pinHash == null || pinHash.isEmpty()) return false;

        try {
            return lazySodium.cryptoPwHashStrVerify(pinHash, enteredPin);
        } catch (Exception e) {
            return false;
        }
    }

    // --- Bypass detection notification ---

    private void createBypassNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "PearGuard Enforcement Warning",
                NotificationManager.IMPORTANCE_HIGH
            );
            channel.setDescription("Alerts when enforcement is disabled");
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.createNotificationChannel(channel);
        }
    }

    /**
     * Called by EnforcementService when it detects the Accessibility Service
     * is disabled. Shows a persistent high-priority notification to the child.
     */
    public static void showBypassNotification(Context context) {
        NotificationManager nm =
            (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;

        Intent openSettings = new Intent(
            android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
        PendingIntent pi = PendingIntent.getActivity(
            context, 0, openSettings,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_alert)
            .setContentTitle("PearGuard enforcement disabled")
            .setContentText("Tap to re-enable parental controls in Accessibility settings.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOngoing(true)
            .setContentIntent(pi)
            .setAutoCancel(false);

        nm.notify(1001, builder.build());
    }

} // end class AppBlockerModule
