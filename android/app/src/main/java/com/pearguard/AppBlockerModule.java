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
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.widget.Button;
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
    private boolean overlayPending = false; // true between Handler.post() and addView() completing
    private String currentOverlayPackage;
    private View pinDialogView;

    // In-memory override: packageName -> expiry time in ms
    private final HashMap<String, Long> overrides = new HashMap<>();

    // Packages that have an in-flight time request — used to change button label in overlay.
    // Cleared via clearPendingRequest() when a parent decision arrives via setPolicy().
    private static final Set<String> pendingRequestPackages = new HashSet<>();

    /** Called from UsageStatsModule.setPolicy() when a parent decision arrives. */
    public static void clearPendingRequest(String packageName) {
        pendingRequestPackages.remove(packageName);
    }

    // Singleton reference — set in onServiceConnected, cleared in onDestroy.
    private static AppBlockerModule sInstance = null;

    /**
     * Called from UsageStatsModule when a policy update or P2P override arrives that
     * makes a previously-blocked package now allowed.  If the overlay is currently
     * showing for that package it is dismissed immediately so the child doesn't have
     * to tap anything — the app just becomes accessible.
     */
    public static void dismissIfShowing(String packageName) {
        AppBlockerModule inst = sInstance;
        if (inst == null || packageName == null) return;
        new Handler(Looper.getMainLooper()).post(() -> {
            if (packageName.equals(inst.currentOverlayPackage)) {
                inst.dismissOverlay();
            }
        });
    }

    // Cooldown: after dismissing an overlay, ignore TYPE_WINDOW_STATE_CHANGED events for the
    // same package for DISMISS_COOLDOWN_MS. This prevents the blocked app's background
    // activity-destruction event from re-triggering the overlay over the home screen.
    private String recentlyDismissedPackage = null;
    private long dismissedAt = 0;
    private static final long DISMISS_COOLDOWN_MS = 2000;

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

        // Start the enforcement polling service. BootReceiverModule handles post-reboot
        // startup, but the service must also start when the Accessibility Service connects
        // (i.e. on first enable and on any app restart that re-connects the service).
        Intent enforcementIntent = new Intent(this, EnforcementService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            startForegroundService(enforcementIntent);
        } else {
            startService(enforcementIntent);
        }

        sInstance = this;
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (sInstance == this) sInstance = null;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event.getEventType() != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return;

        CharSequence pkg = event.getPackageName();
        if (pkg == null) return;
        String packageName = pkg.toString();

        // Never block PearGuard itself.
        // Do NOT call dismissOverlay() here — adding our own overlay fires
        // TYPE_WINDOW_STATE_CHANGED with our package name, and dismissing
        // would remove the overlay we just added (flash loop). The overlay
        // is only dismissed by explicit button actions or when another app
        // takes the foreground.
        if (packageName.equals(getPackageName())) {
            return;
        }

        String blockReason = getBlockReason(packageName);

        if (blockReason != null) {
            showOverlay(packageName, blockReason);
        } else {
            // Gesture navigation fires TYPE_WINDOW_STATE_CHANGED for system overlay
            // packages (e.g. com.android.systemui) mid-gesture while the blocked app
            // is still in the foreground. Skip dismissal for those to prevent the
            // back-gesture bypass: overlay would disappear but blocked app stays open.
            if (overlayView != null && isSystemOverlayPackage(packageName)) {
                return;
            }
            dismissOverlay();
        }
    }

    /**
     * Returns true for system packages that have no launcher activity — these are
     * pure system/nav overlays (e.g. SystemUI) that fire spurious events during
     * gesture navigation. User-visible system apps (Chrome, YouTube) have a launch
     * intent and return false, so the overlay is correctly dismissed for them.
     */
    private boolean isSystemOverlayPackage(String packageName) {
        try {
            PackageManager pm = getPackageManager();
            ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
            boolean isSystem = (info.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
            if (!isSystem) return false;
            return pm.getLaunchIntentForPackage(packageName) == null;
        } catch (Exception e) {
            return false;
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
        // Check for active override (PIN was entered successfully — in-memory)
        Long overrideExpiry = overrides.get(packageName);
        if (overrideExpiry != null && System.currentTimeMillis() < overrideExpiry) {
            return null; // override is active, allow
        }

        // Check SharedPreferences for P2P-granted overrides (from parent via bare worklet)
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long sharedPrefOverride = prefs.getLong("pearguard_override_" + packageName, 0L);
        if (sharedPrefOverride > System.currentTimeMillis()) {
            return null; // P2P override is active, allow
        }

        // System services with no launcher icon (e.g. Google Play Services, SystemUI) must
        // never be blocked — they are invisible to the user and required for device operation.
        if (isSystemOverlayPackage(packageName)) {
            return null;
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

    // --- Haptics ---

    private static final long[] PATTERN_TAP     = { 0, 30 };  // digit key press
    private static final long[] PATTERN_BUTTON  = { 0, 60 };  // main action buttons
    private static final long[] PATTERN_ERROR   = { 0, 80, 60, 80 };
    private static final long[] PATTERN_SUCCESS = { 0, 150 };

    @SuppressWarnings("deprecation")
    private void vibrate(long[] pattern) {
        Vibrator v = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
        if (v == null || !v.hasVibrator()) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            v.vibrate(VibrationEffect.createWaveform(pattern, -1));
        } else {
            v.vibrate(pattern, -1);
        }
    }

    // --- Overlay UI ---

    private void showOverlay(String packageName, String reason) {
        // Skip during cooldown window after the overlay was just dismissed for this package.
        // The blocked app fires a final TYPE_WINDOW_STATE_CHANGED as its activity destructs
        // (e.g. after back gesture or Send Request). Without this guard that event would
        // re-trigger the overlay over the home screen.
        if (packageName.equals(recentlyDismissedPackage)
                && System.currentTimeMillis() - dismissedAt < DISMISS_COOLDOWN_MS) {
            return;
        }

        // Skip if overlay is already showing or pending for this package.
        // overlayPending covers the window between Handler.post() and addView() executing,
        // during which overlayView is still null but we've already committed to showing.
        if ((overlayView != null || overlayPending) && packageName.equals(currentOverlayPackage)) return;

        dismissOverlay();
        currentOverlayPackage = packageName;
        overlayPending = true;

        // Notify RN that a block occurred — WebView ChildRequests listens for this
        ReactContext rc = PearGuardReactHost.get();
        if (rc != null && rc.hasActiveReactInstance()) {
            WritableMap evt = Arguments.createMap();
            evt.putString("packageName", packageName);
            rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                    .emit("onBlockOccurred", evt);
        }

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
        boolean requestAlreadySent = pendingRequestPackages.contains(packageName);
        requestButton.setText(requestAlreadySent ? "Resend Request" : "Send Request");
        requestButton.setOnClickListener(v -> { vibrate(PATTERN_BUTTON); onSendRequest(packageName); });
        layout.addView(requestButton);

        Button pinButton = new Button(this);
        pinButton.setText("Enter PIN");
        pinButton.setPadding(0, 24, 0, 0);
        pinButton.setOnClickListener(v -> { vibrate(PATTERN_BUTTON); onEnterPin(packageName); });
        layout.addView(pinButton);

        final View pendingOverlay = layout;

        // FLAG_NOT_FOCUSABLE prevents the overlay from stealing keyboard focus.
        // Without it, adding the overlay fires TYPE_WINDOW_STATE_CHANGED with
        // PearGuard's own package name, triggering dismissOverlay() and causing
        // the flash loop. Touch events (button clicks) are unaffected by this flag.
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                        : WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY,
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT
        );

        new Handler(Looper.getMainLooper()).post(() -> {
            try {
                windowManager.addView(pendingOverlay, params);
                overlayView = pendingOverlay;
            } catch (Exception e) {
                // addView failed — reset pending flag so next event can retry
                overlayView = null;
            }
            overlayPending = false;
        });
    }

    private void dismissOverlay() {
        overlayPending = false;
        if (pinDialogView != null) {
            try { windowManager.removeView(pinDialogView); } catch (Exception ignored) {}
            pinDialogView = null;
        }
        if (overlayView != null) {
            // Record cooldown so the dismissed package's background destruction events
            // don't immediately re-trigger the overlay over the home screen.
            recentlyDismissedPackage = currentOverlayPackage;
            dismissedAt = System.currentTimeMillis();
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
            Toast.makeText(this, "Request sent to parent", Toast.LENGTH_SHORT).show();
        } else {
            Toast.makeText(this, "Open PearGuard to send a request", Toast.LENGTH_LONG).show();
        }
        // Track that a request was sent — suppresses the overlay from re-appearing
        // over the home screen while waiting for the parent's response.
        pendingRequestPackages.add(packageName);

        // Dismiss the overlay and go to the home screen so the blocked app
        // cannot immediately re-trigger the overlay by coming back to foreground.
        dismissOverlay();
        Intent homeIntent = new Intent(Intent.ACTION_MAIN);
        homeIntent.addCategory(Intent.CATEGORY_HOME);
        homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(homeIntent);
    }

    private void onEnterPin(String packageName) {
        // TYPE_ACCESSIBILITY_OVERLAY cannot receive IME (keyboard) on Android 11+.
        // Use a numeric keypad UI instead of EditText.

        final String[] enteredPin = { "" };

        LinearLayout dialogLayout = new LinearLayout(this);
        dialogLayout.setOrientation(LinearLayout.VERTICAL);
        dialogLayout.setBackgroundColor(Color.argb(255, 30, 30, 30));
        dialogLayout.setPadding(48, 48, 48, 48);
        dialogLayout.setGravity(Gravity.CENTER);

        // PIN prompt / dots display
        final TextView pinDisplay = new TextView(this);
        pinDisplay.setText("Enter parent PIN");
        pinDisplay.setTextColor(Color.WHITE);
        pinDisplay.setTextSize(20);
        pinDisplay.setGravity(Gravity.CENTER);
        dialogLayout.addView(pinDisplay);

        Runnable updateDisplay = () -> {
            if (enteredPin[0].isEmpty()) {
                pinDisplay.setText("Enter parent PIN");
            } else {
                StringBuilder dots = new StringBuilder();
                for (int i = 0; i < enteredPin[0].length(); i++) {
                    if (i > 0) dots.append("  ");
                    dots.append("●");
                }
                pinDisplay.setText(dots.toString());
            }
        };

        // Number pad  1-2-3 / 4-5-6 / 7-8-9 / ⌫-0  (auto-submits at 4 digits)
        String[][] rows = { {"1","2","3"}, {"4","5","6"}, {"7","8","9"}, {"⌫","0",""} };
        for (String[] row : rows) {
            LinearLayout rowLayout = new LinearLayout(this);
            rowLayout.setOrientation(LinearLayout.HORIZONTAL);
            rowLayout.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            rowParams.setMargins(0, 8, 0, 0);
            rowLayout.setLayoutParams(rowParams);

            for (String digit : row) {
                Button btn = new Button(this);
                btn.setText(digit);
                btn.setTextColor(Color.WHITE);
                btn.setTextSize(20);
                LinearLayout.LayoutParams btnParams = new LinearLayout.LayoutParams(
                        0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
                btnParams.setMargins(6, 0, 6, 0);
                btn.setLayoutParams(btnParams);
                btn.setBackgroundColor(Color.argb(200, 60, 60, 60));

                btn.setOnClickListener(v -> {
                    if ("⌫".equals(digit)) {
                        if (!enteredPin[0].isEmpty()) {
                            vibrate(PATTERN_TAP);
                            enteredPin[0] = enteredPin[0].substring(0, enteredPin[0].length() - 1);
                            updateDisplay.run();
                        }
                    } else if ("".equals(digit)) {
                        // placeholder cell — no action
                    } else {
                        if (enteredPin[0].length() < 4) {
                            vibrate(PATTERN_TAP);
                            enteredPin[0] = enteredPin[0] + digit;
                            updateDisplay.run();

                            // Auto-submit when 4 digits entered
                            if (enteredPin[0].length() == 4) {
                                if (verifyPin(enteredPin[0])) {
                                    vibrate(PATTERN_SUCCESS);
                                    JSONObject policy = loadPolicy();
                                    int durationSeconds = 3600;
                                    if (policy != null) {
                                        durationSeconds = policy.optInt("overrideDurationSeconds", 3600);
                                    }
                                    long expiryMs = System.currentTimeMillis() + (durationSeconds * 1000L);
                                    overrides.put(packageName, expiryMs);

                                    ReactContext rc = PearGuardReactHost.get();
                                    if (rc != null && rc.hasActiveReactInstance()) {
                                        WritableMap evt = Arguments.createMap();
                                        evt.putString("packageName", packageName);
                                        evt.putDouble("timestamp", System.currentTimeMillis());
                                        evt.putInt("durationSeconds", durationSeconds);
                                        rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                                                .emit("onPinSuccess", evt);
                                    }

                                    try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
                                    pinDialogView = null;
                                    dismissOverlay();
                                } else {
                                    vibrate(PATTERN_ERROR);
                                    enteredPin[0] = "";
                                    pinDisplay.setTextColor(Color.RED);
                                    pinDisplay.setText("Incorrect PIN");
                                    new Handler(Looper.getMainLooper()).postDelayed(() -> {
                                        pinDisplay.setTextColor(Color.WHITE);
                                        pinDisplay.setText("Enter parent PIN");
                                    }, 1500);
                                }
                            }
                        }
                    }
                });

                rowLayout.addView(btn);
            }
            dialogLayout.addView(rowLayout);
        }

        // Cancel button
        Button cancelBtn = new Button(this);
        cancelBtn.setText("Cancel");
        cancelBtn.setTextColor(Color.WHITE);
        cancelBtn.setBackgroundColor(Color.argb(200, 100, 30, 30));
        LinearLayout.LayoutParams cancelParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cancelParams.setMargins(0, 24, 0, 0);
        cancelBtn.setLayoutParams(cancelParams);
        cancelBtn.setOnClickListener(v -> {
            try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
            pinDialogView = null;
        });
        dialogLayout.addView(cancelBtn);

        WindowManager.LayoutParams dialogParams = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                        : WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, // no IME needed — using button pad
                PixelFormat.TRANSLUCENT
        );
        dialogParams.gravity = Gravity.CENTER;

        windowManager.addView(dialogLayout, dialogParams);
        pinDialogView = dialogLayout;
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
            // LazySodiumAndroid is constructed with HexMessageEncoder as its default
            // messageEncoder. The String overload of cryptoPwHashStrVerify calls
            // messageEncoder.decode(hash), which tries to interpret the argon2id string
            // "$argon2id$v=19$..." as hex — producing garbage bytes and a wrong result.
            //
            // Use the byte[] overload directly to bypass the encoder, mirroring what the
            // bare worklet does in pin:verify:
            //   const storedHash = Buffer.alloc(crypto_pwhash_STRBYTES) // zero-filled
            //   Buffer.from(policy.pinHash).copy(storedHash)
            //   crypto_pwhash_str_verify(storedHash, pinBuffer)
            final int STRBYTES = 128; // crypto_pwhash_STRBYTES
            byte[] hashBytes = new byte[STRBYTES]; // zero-filled — null padding included
            byte[] rawHash = pinHash.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            System.arraycopy(rawHash, 0, hashBytes, 0, Math.min(rawHash.length, STRBYTES));

            byte[] passwordBytes = enteredPin.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            return lazySodium.cryptoPwHashStrVerify(hashBytes, passwordBytes, passwordBytes.length);
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
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("PearGuard enforcement disabled")
                .setContentText("Tap to re-enable parental controls in Accessibility settings.")
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setOngoing(true)
                .setContentIntent(pi)
                .setAutoCancel(false);

        nm.notify(1001, builder.build());
    }

} // end class AppBlockerModule