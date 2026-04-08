package com.pearguard;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.KeyguardManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.accessibility.AccessibilityEvent;
import android.util.TypedValue;
import android.widget.ImageView;
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

import java.util.Arrays;
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

    // --- Overlay Theme (matches dark palette in src/ui/theme.js) ---
    private static final class OT {
        static final int SURFACE_BASE   = Color.argb(240, 13, 13, 13);
        static final int SURFACE_CARD   = Color.parseColor("#1A1A1A");
        static final int SURFACE_ELEV   = Color.parseColor("#252525");
        static final int TEXT_PRIMARY   = Color.parseColor("#F0F0F0");
        static final int TEXT_SECONDARY = Color.parseColor("#A0A0A0");
        static final int TEXT_MUTED     = Color.parseColor("#666666");
        static final int BORDER         = Color.parseColor("#333333");
        static final int DIVIDER        = Color.parseColor("#2A2A2A");
        static final int PRIMARY        = Color.parseColor("#4CAF50");
        static final int PRIMARY_BG     = Color.argb(38, 76, 175, 80); // 15% opacity
        static final int ERROR          = Color.parseColor("#EF5350");
        static final int CARD_RADIUS    = 16;
        static final int KEY_RADIUS     = 12;
        static final int BTN_RADIUS     = 12;
        static final int ICON_CIRCLE    = 72;
        static final int ICON_CIRCLE_SM = 64;
    }

    // --- Phosphor Icon SVG paths (256x256 viewBox) ---
    private static final String ICON_SHIELD = "M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,25.27,47,25.53a8,8,0,0,0,4.2,0c1-.26,23.91-6.67,47-25.53C198.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,67.16-40.6,89.42A129.3,129.3,0,0,1,128,223.62a128.25,128.25,0,0,1-38.92-21.81C61.82,179.51,48,149.3,48,112l0-56,160,0Z";
    private static final String ICON_CLOCK = "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z";
    private static final String ICON_LOCK = "M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z";
    private static final String ICON_BACKSPACE = "M216,40H68.53a16.12,16.12,0,0,0-13.72,7.77L9.14,123.88a8,8,0,0,0,0,8.24l45.67,76.11A16.11,16.11,0,0,0,68.53,216H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,160H68.53l-43.2-72,43.2-72H216ZM106.34,146.34,124.69,128l-18.35-18.34a8,8,0,0,1,11.32-11.32L136,116.69l18.34-18.35a8,8,0,0,1,11.32,11.32L147.31,128l18.35,18.34a8,8,0,0,1-11.32,11.32L136,139.31l-18.34,18.35a8,8,0,0,1-11.32-11.32Z";
    private static final String ICON_CARET_RIGHT = "M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z";

    private Typeface nunitoRegular;
    private Typeface nunitoSemiBold;

    private Typeface getNunitoRegular() {
        if (nunitoRegular == null) {
            try { nunitoRegular = Typeface.createFromAsset(getAssets(), "fonts/Nunito-Regular.ttf"); }
            catch (Exception e) { nunitoRegular = Typeface.SANS_SERIF; }
        }
        return nunitoRegular;
    }

    private Typeface getNunitoSemiBold() {
        if (nunitoSemiBold == null) {
            try { nunitoSemiBold = Typeface.createFromAsset(getAssets(), "fonts/Nunito-SemiBold.ttf"); }
            catch (Exception e) { nunitoSemiBold = Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD); }
        }
        return nunitoSemiBold;
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
                TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    private Bitmap renderIcon(String svgPath, int sizeDp, int color) {
        int sizePx = dp(sizeDp);
        Bitmap bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);
        android.graphics.Path path = androidx.core.graphics.PathParser.createPathFromPathData(svgPath);
        android.graphics.Matrix matrix = new android.graphics.Matrix();
        matrix.setScale(sizePx / 256f, sizePx / 256f);
        path.transform(matrix);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setColor(color);
        paint.setStyle(Paint.Style.FILL);
        canvas.drawPath(path, paint);
        return bmp;
    }

    private ImageView iconView(String svgPath, int sizeDp, int color) {
        ImageView iv = new ImageView(this);
        iv.setImageBitmap(renderIcon(svgPath, sizeDp, color));
        iv.setScaleType(ImageView.ScaleType.FIT_CENTER);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp));
        iv.setLayoutParams(p);
        return iv;
    }

    private LinearLayout iconCircle(int circleDp, String svgPath, int iconDp, int iconColor, int bgColor) {
        LinearLayout circle = new LinearLayout(this);
        circle.setGravity(Gravity.CENTER);
        int px = dp(circleDp);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(px, px);
        circle.setLayoutParams(cp);
        android.graphics.drawable.GradientDrawable bg = new android.graphics.drawable.GradientDrawable();
        bg.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        bg.setColor(bgColor);
        circle.setBackground(bg);
        circle.addView(iconView(svgPath, iconDp, iconColor));
        return circle;
    }

    private android.graphics.drawable.GradientDrawable roundedRect(int color, int radiusDp) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(radiusDp));
        return d;
    }

    private android.graphics.drawable.GradientDrawable roundedRectWithBorder(int fillColor, int borderColor, int radiusDp) {
        android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
        d.setColor(fillColor);
        d.setCornerRadius(dp(radiusDp));
        d.setStroke(dp(1), borderColor);
        return d;
    }

    private WindowManager windowManager;
    private View overlayView;
    private boolean overlayPending = false; // true between Handler.post() and addView() completing
    private String currentOverlayPackage;
    private String currentOverlayBlockCategory; // 'blocked', 'pending', 'schedule', 'daily_limit'
    private View pinDialogView;
    // Last non-system-overlay package seen in onAccessibilityEvent. Used by the
    // EnforcementService polling loop to enforce time limits / schedule blocks on
    // apps that are already in the foreground when a block condition activates (#66).
    private volatile String lastForegroundPackage = null;
    // Suppresses the polling-loop overlay until this timestamp. Set when the user
    // taps "Request More Time" so the extra-time picker dialog is not overwritten
    // by the next polling tick showing the overlay again (#66).
    private long enforcementSuppressedUntil = 0;

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

    /** Returns the package currently in the foreground, or null. */
    public static String getLastForegroundPackage() {
        AppBlockerModule inst = sInstance;
        return inst != null ? inst.lastForegroundPackage : null;
    }

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

    /**
     * Dismisses the overlay unconditionally regardless of which package it is showing for.
     * Called from UsageStatsModule.dismissAllOverlays() on child:reset (unpair) to clear
     * any active overlay before the policy is wiped and the child navigates back to setup.
     */
    public static void dismissAll() {
        AppBlockerModule inst = sInstance;
        if (inst == null) return;
        new Handler(Looper.getMainLooper()).post(inst::dismissOverlay);
    }

    /**
     * Clears all in-memory override state and pending-request tracking.
     * Called from UsageStatsModule.clearChildState() on child:reset (unpair) so that
     * stale overrides and pending-request suppression from the previous pairing session
     * do not bleed into a fresh pairing after Remove + Re-pair cycles.
     */
    public static void clearAllOverrides() {
        AppBlockerModule inst = sInstance;
        if (inst == null) return;
        new Handler(Looper.getMainLooper()).post(() -> {
            inst.overrides.clear();
            pendingRequestPackages.clear();
        });
    }

    /**
     * Called from EnforcementService polling loop to catch the case where a time limit or
     * schedule block kicks in while the app is already in the foreground (#66). Since
     * TYPE_WINDOW_STATE_CHANGED only fires on app transitions, blocks on already-open apps
     * are not detected by onAccessibilityEvent alone.
     *
     * Uses lastForegroundPackage (set in onAccessibilityEvent) rather than querying
     * UsageStatsManager — this is reliable regardless of how long the app has been open.
     * No-ops if the overlay is already showing for the current foreground package.
     */
    public static void checkAndShowOverlayIfNeeded() {
        AppBlockerModule inst = sInstance;
        if (inst == null || inst.lastForegroundPackage == null) return;
        final String pkg = inst.lastForegroundPackage;
        new Handler(Looper.getMainLooper()).post(() -> {
            // Dismiss overlay while device is locked (#112).
            if (inst.isDeviceLocked()) {
                if (inst.overlayView != null || inst.overlayPending) inst.dismissOverlay();
                return;
            }
            if ((inst.overlayView != null || inst.overlayPending)
                    && pkg.equals(inst.currentOverlayPackage)) {
                // Overlay is showing — re-check whether the block still applies.
                // Handles policy changes (e.g. daily limit removed) while overlay is up.
                String reason = inst.getBlockReason(pkg);
                if (reason == null) inst.dismissOverlay();
                return;
            }
            // Suppressed while an interaction dialog (e.g. extra-time picker) is showing.
            if (System.currentTimeMillis() < inst.enforcementSuppressedUntil) return;
            String reason = inst.getBlockReason(pkg);
            if (reason != null) inst.showOverlay(pkg, reason);
        });
    }

    // Cooldown: after dismissing an overlay, ignore TYPE_WINDOW_STATE_CHANGED events for the
    // same package for DISMISS_COOLDOWN_MS. This prevents the blocked app's background
    // activity-destruction event from re-triggering the overlay over the home screen.
    // 800ms is enough to cover the destruction event (~100-300ms) without preventing the
    // user from re-opening the blocked app and seeing the overlay again.
    private String recentlyDismissedPackage = null;
    private long dismissedAt = 0;
    private static final long DISMISS_COOLDOWN_MS = 800;

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

        // Don't show or maintain overlay while device is locked (#112).
        if (isDeviceLocked()) {
            if (overlayView != null) dismissOverlay();
            return;
        }

        // Track the last real foreground package for the EnforcementService polling loop (#66).
        // Always update for the home launcher (even though it is a system app with no launch
        // intent on some devices) so that lastForegroundPackage is cleared when the user
        // navigates home, preventing the polling loop from re-showing the overlay over the
        // Home screen (#72). Skip pure system overlay packages (e.g. com.android.systemui).
        if (!isSystemOverlayPackage(packageName) || isCurrentHomeLauncher(packageName)) {
            lastForegroundPackage = packageName;
        }

        String blockReason = getBlockReason(packageName);

        if (blockReason != null) {
            showOverlay(packageName, blockReason);
        } else {
            // Gesture navigation fires TYPE_WINDOW_STATE_CHANGED for system overlay
            // packages (e.g. com.android.systemui) mid-gesture while the blocked app
            // is still in the foreground. Skip dismissal for those to prevent the
            // back-gesture bypass: overlay would disappear but blocked app stays open.
            // Exception: always dismiss when the Home screen launcher comes to the
            // foreground — on some devices it is a system app with no launch intent,
            // so isSystemOverlayPackage() would incorrectly skip it, leaving the
            // overlay stuck over the Home screen (bug #57).
            if (overlayView != null && isSystemOverlayPackage(packageName)
                    && !isCurrentHomeLauncher(packageName)) {
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

    /**
     * Returns true if the given package is the currently active Home screen launcher.
     * Used to ensure the overlay is always dismissed when the user navigates Home,
     * even on devices where the launcher is a system app with no separate launch intent
     * (which would otherwise make isSystemOverlayPackage() return true and skip dismissal).
     */
    private boolean isCurrentHomeLauncher(String packageName) {
        try {
            Intent homeIntent = new Intent(Intent.ACTION_MAIN);
            homeIntent.addCategory(Intent.CATEGORY_HOME);
            android.content.pm.ResolveInfo ri = getPackageManager().resolveActivity(
                    homeIntent, PackageManager.MATCH_DEFAULT_ONLY);
            return ri != null && packageName.equals(ri.activityInfo.packageName);
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
     * Returns a human-readable reason string if the app should be blocked, or null if allowed.
     *
     * Precedence (highest to lowest):
     *   1. System / phone exemptions         — always allow, skip all checks
     *   2. Active override (PIN / P2P grant) — always allow; beats schedule and daily limits
     *   3. Scheduled blackout                — block
     *   4. Policy status (blocked / pending) — block
     *   5. Daily limit exceeded              — block
     *   6. Default                           — allow
     *
     * Rationale: PIN entry and parent-approved time requests represent an explicit decision
     * to grant access right now. Requiring the parent to also update their schedule rules
     * to allow a one-off exception is worse UX than letting the override win.
     */
    private String getBlockReason(String packageName) {
        // Exemptions: system services and phone/messaging are never blocked.
        if (isSystemOverlayPackage(packageName)) return null;
        if (isPhoneOrMessagingApp(packageName)) return null;

        JSONObject policy = loadPolicy();
        if (policy == null) return null; // no policy yet, allow everything

        try {
            // Step 0: Device-wide lock — parent toggled quick-lock, block everything.
            boolean locked = policy.optBoolean("locked", false);
            if (locked) return "Device is locked by your parent.";

            // Step 1: Active override — PIN success (in-memory) or parent P2P grant (SharedPrefs).
            // Overrides win over schedule, daily limits, and policy status.
            Long overrideExpiry = overrides.get(packageName);
            if (overrideExpiry != null && System.currentTimeMillis() < overrideExpiry) {
                return null;
            }
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            long sharedPrefOverride = prefs.getLong("pearguard_override_" + packageName, 0L);
            if (sharedPrefOverride > System.currentTimeMillis()) {
                return null;
            }

            // Step 2: Scheduled blackout (respects per-rule exempt apps).
            String scheduleReason = getScheduleBlockReason(policy, packageName);
            if (scheduleReason != null) return scheduleReason;

            // Step 3: Permanently blocked or pending (parent's explicit policy decision).
            JSONObject apps = policy.optJSONObject("apps");
            if (apps != null && apps.has(packageName)) {
                JSONObject appPolicy = apps.getJSONObject(packageName);
                String status = appPolicy.optString("status", "allowed");
                if ("blocked".equals(status)) {
                    return "Not approved by your parent.";
                }
                if ("pending".equals(status)) {
                    return "Needs parent approval.";
                }

                // Step 4: Daily limit exceeded.
                int limitSeconds = appPolicy.optInt("dailyLimitSeconds", -1);
                if (limitSeconds > 0) {
                    int usedSeconds = getDailyUsageSeconds(packageName);
                    if (usedSeconds >= limitSeconds) {
                        int minutes = limitSeconds / 60;
                        return "Daily limit reached (" + minutes + " min/day).";
                    }
                }
            }

        } catch (Exception e) {
            // Parse error — fail open (allow)
        }

        return null; // allow
    }

    private boolean isPhoneOrMessagingApp(String packageName) {
        if (PHONE_PACKAGES.contains(packageName)) return true;
        return packageName.contains("dialer")
                || packageName.contains("sms")
                || packageName.contains("messaging");
    }

    private String getScheduleBlockReason(JSONObject policy, String packageName) {
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

                // Skip if this app is exempt from this rule (#49)
                JSONArray exemptApps = schedule.optJSONArray("exemptApps");
                if (exemptApps != null) {
                    boolean exempt = false;
                    for (int e = 0; e < exemptApps.length(); e++) {
                        if (packageName.equals(exemptApps.optString(e))) { exempt = true; break; }
                    }
                    if (exempt) continue;
                }

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
                    return "Blocked during \"" + schedule.optString("label", "scheduled time") + "\".";
                }
            }
        } catch (Exception ignored) {}
        return null;
    }

    /**
     * Returns the total foreground usage in seconds for packageName today.
     *
     * Uses queryEvents rather than queryAndAggregateUsageStats because
     * getTotalTimeInForeground() does not include the current live session —
     * stats only commit when the app transitions to background. Computing from
     * raw MOVE_TO_FOREGROUND / MOVE_TO_BACKGROUND events lets us add the
     * elapsed time of the ongoing session, which is required to detect a time
     * limit being hit while the app is still open (#66).
     */
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
            // App is still in the foreground — add elapsed time since session start.
            if (sessionStart >= 0) {
                totalMs += now - sessionStart;
            }
            return (int)(totalMs / 1000);
        } catch (Exception e) {
            // Fall back to aggregate stats if event query fails.
            Map<String, android.app.usage.UsageStats> stats =
                    usm.queryAndAggregateUsageStats(startOfDay, now);
            if (stats != null && stats.containsKey(packageName)) {
                return (int)(stats.get(packageName).getTotalTimeInForeground() / 1000);
            }
            return 0;
        }
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

    /**
     * Derives a stable category token from the human-readable block reason string.
     * Used to determine what kind of request to send when the child taps "Send Request".
     *
     * Returns one of: "blocked", "pending", "schedule", "daily_limit"
     */
    private String getBlockCategory(String reason) {
        if (reason == null) return "blocked";
        if (reason.contains("parent approval")) return "pending";
        if (reason.contains("Daily limit")) return "daily_limit";
        if (reason.contains("Blocked during")) return "schedule";
        return "blocked";
    }

    /**
     * Returns true when the device is locked (keyguard active). Used to suppress the
     * block overlay while the lock screen is showing (#112).
     */
    private boolean isDeviceLocked() {
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    private void showOverlay(String packageName, String reason) {
        // Don't show overlay on the lock screen (#112).
        if (isDeviceLocked()) return;

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
        currentOverlayBlockCategory = getBlockCategory(reason);
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

        // --- Themed overlay layout ---
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(OT.SURFACE_BASE);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(dp(24), dp(24), dp(24), dp(24));

        // Icon circle
        LinearLayout icon = iconCircle(OT.ICON_CIRCLE, ICON_SHIELD, 36, OT.ERROR, OT.PRIMARY_BG);
        LinearLayout.LayoutParams iconP = new LinearLayout.LayoutParams(dp(OT.ICON_CIRCLE), dp(OT.ICON_CIRCLE));
        iconP.setMargins(0, 0, 0, dp(20));
        iconP.gravity = Gravity.CENTER_HORIZONTAL;
        icon.setLayoutParams(iconP);
        layout.addView(icon);

        // Title
        String titleText;
        switch (currentOverlayBlockCategory) {
            case "pending":     titleText = appName + " needs approval"; break;
            case "daily_limit": titleText = appName + ": daily limit reached"; break;
            case "schedule":    titleText = appName + ": scheduled block"; break;
            default:            titleText = appName + " is blocked"; break;
        }
        TextView title = new TextView(this);
        title.setText(titleText);
        title.setTextColor(OT.TEXT_PRIMARY);
        title.setTextSize(22);
        title.setTypeface(getNunitoRegular());
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        titleP.setMargins(0, 0, 0, dp(8));
        title.setLayoutParams(titleP);
        layout.addView(title);

        // Subtitle (reason)
        TextView reasonView = new TextView(this);
        reasonView.setText(reason);
        reasonView.setTextColor(OT.TEXT_SECONDARY);
        reasonView.setTextSize(14);
        reasonView.setTypeface(getNunitoRegular());
        reasonView.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams reasonP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        reasonP.setMargins(0, 0, 0, dp(40));
        reasonView.setLayoutParams(reasonP);
        layout.addView(reasonView);

        // Action card
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(roundedRectWithBorder(OT.SURFACE_CARD, OT.BORDER, OT.CARD_RADIUS));
        card.setPadding(dp(4), dp(4), dp(4), dp(4));
        LinearLayout.LayoutParams cardP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cardP.setMargins(dp(16), 0, dp(16), 0);
        card.setLayoutParams(cardP);

        boolean requestAlreadySent = pendingRequestPackages.contains(packageName);
        final String blockCategory = currentOverlayBlockCategory;
        boolean isExtraTime = "schedule".equals(blockCategory) || "daily_limit".equals(blockCategory);

        // Row 1: Request Approval / Request More Time
        String requestLabel = requestAlreadySent
                ? (isExtraTime ? "Resend Time Request" : "Resend Approval Request")
                : (isExtraTime ? "Request More Time" : "Request Approval");
        String requestIcon = isExtraTime ? ICON_CLOCK : ICON_SHIELD;
        card.addView(makeActionRow(requestIcon, requestLabel, OT.PRIMARY,
                () -> { vibrate(PATTERN_BUTTON); onSendRequest(packageName, blockCategory); }));

        // Divider
        View div1 = new View(this);
        div1.setBackgroundColor(OT.DIVIDER);
        div1.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(1)));
        card.addView(div1);

        // Row 2: Enter PIN
        card.addView(makeActionRow(ICON_LOCK, "Enter PIN", OT.TEXT_PRIMARY,
                () -> { vibrate(PATTERN_BUTTON); onEnterPin(packageName); }));

        layout.addView(card);

        final View pendingOverlay = layout;

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
            currentOverlayBlockCategory = null;
        }
    }

    /** Creates a single row for the grouped action card. */
    private LinearLayout makeActionRow(String iconPath, String label, int textColor, Runnable onClick) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(16), dp(16), dp(16));
        row.setClickable(true);
        row.setOnClickListener(v -> onClick.run());

        row.addView(iconView(iconPath, 20, textColor == OT.PRIMARY ? OT.PRIMARY : OT.TEXT_SECONDARY));

        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(dp(12), 0));
        row.addView(spacer);

        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextColor(textColor);
        tv.setTextSize(15);
        tv.setTypeface(getNunitoSemiBold());
        tv.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(tv);

        return row;
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

    private void onSendRequest(String packageName, String blockCategory) {
        boolean isExtraTime = "schedule".equals(blockCategory) || "daily_limit".equals(blockCategory);
        if (isExtraTime) {
            // Suppress the polling-loop overlay for 2 minutes so the duration picker
            // dialog is not immediately overwritten by the next EnforcementService tick (#66).
            enforcementSuppressedUntil = System.currentTimeMillis() + 120_000;
            // Show duration picker; the picker fires onTimeRequest with requestType=extra_time
            // after the child selects how much extra time they want.
            dismissOverlay();
            showExtraTimePicker(packageName);
            return;
        }

        // Approval request — fire immediately
        ReactContext reactContext = PearGuardReactHost.get();
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
            WritableMap params = Arguments.createMap();
            params.putString("packageName", packageName);
            params.putString("appName", getAppName(packageName));
            params.putString("requestType", "approval");
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

    private int[] getTimeRequestOptions() {
        int[] defaults = { 15, 30, 60, 120 };
        try {
            JSONObject policy = loadPolicy();
            if (policy != null) {
                JSONObject settings = policy.optJSONObject("settings");
                if (settings != null) {
                    org.json.JSONArray arr = settings.optJSONArray("timeRequestMinutes");
                    if (arr != null && arr.length() > 0) {
                        int[] result = new int[arr.length()];
                        for (int i = 0; i < arr.length(); i++) result[i] = arr.getInt(i);
                        return result;
                    }
                }
            }
        } catch (Exception ignored) {}
        return defaults;
    }

    private static String formatMinutes(int min) {
        if (min < 60) return min + " min";
        int h = min / 60;
        int m = min % 60;
        if (m == 0) return h + (h == 1 ? " hour" : " hours");
        return h + "h " + m + "m";
    }

    /**
     * Shows a duration picker for extra-time requests (schedule/daily-limit blocks).
     * On selection, fires onTimeRequest with requestType='extra_time' and extraSeconds.
     */
    private LinearLayout makeDurationLayout(String titleText, String[] labels, int[] seconds,
                                            java.util.function.IntConsumer onSelect,
                                            boolean showCancel, Runnable onCancel) {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setBackgroundColor(OT.SURFACE_BASE);
        layout.setGravity(Gravity.CENTER_HORIZONTAL);
        layout.setPadding(dp(24), dp(48), dp(24), dp(48));

        // Icon circle
        LinearLayout icon = iconCircle(OT.ICON_CIRCLE_SM, ICON_CLOCK, 32, OT.PRIMARY, OT.PRIMARY_BG);
        LinearLayout.LayoutParams iconP = new LinearLayout.LayoutParams(dp(OT.ICON_CIRCLE_SM), dp(OT.ICON_CIRCLE_SM));
        iconP.setMargins(0, 0, 0, dp(16));
        iconP.gravity = Gravity.CENTER_HORIZONTAL;
        icon.setLayoutParams(iconP);
        layout.addView(icon);

        TextView title = new TextView(this);
        title.setText(titleText);
        title.setTextColor(OT.TEXT_PRIMARY);
        title.setTextSize(18);
        title.setTypeface(getNunitoRegular());
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        titleP.setMargins(0, 0, 0, dp(24));
        title.setLayoutParams(titleP);
        layout.addView(title);

        // Duration card
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(roundedRectWithBorder(OT.SURFACE_CARD, OT.BORDER, OT.CARD_RADIUS));
        card.setPadding(dp(4), dp(4), dp(4), dp(4));
        LinearLayout.LayoutParams cardP = new LinearLayout.LayoutParams(dp(280), LinearLayout.LayoutParams.WRAP_CONTENT);
        cardP.gravity = Gravity.CENTER_HORIZONTAL;
        card.setLayoutParams(cardP);

        for (int i = 0; i < labels.length; i++) {
            final int secs = seconds[i];
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(16), dp(16), dp(16), dp(16));
            row.setClickable(true);
            row.setOnClickListener(v -> { vibrate(PATTERN_BUTTON); onSelect.accept(secs); });

            TextView label = new TextView(this);
            label.setText(labels[i]);
            label.setTextColor(OT.TEXT_PRIMARY);
            label.setTextSize(16);
            label.setTypeface(getNunitoRegular());
            label.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            row.addView(label);

            row.addView(iconView(ICON_CARET_RIGHT, 16, OT.TEXT_MUTED));
            card.addView(row);

            if (i < labels.length - 1) {
                View div = new View(this);
                div.setBackgroundColor(OT.DIVIDER);
                div.setLayoutParams(new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, dp(1)));
                card.addView(div);
            }
        }
        layout.addView(card);

        if (showCancel && onCancel != null) {
            TextView cancelBtn = new TextView(this);
            cancelBtn.setText("Cancel");
            cancelBtn.setTextColor(OT.TEXT_SECONDARY);
            cancelBtn.setTextSize(14);
            cancelBtn.setTypeface(getNunitoSemiBold());
            cancelBtn.setGravity(Gravity.CENTER);
            cancelBtn.setBackground(roundedRectWithBorder(Color.TRANSPARENT, OT.BORDER, OT.BTN_RADIUS));
            cancelBtn.setPadding(dp(32), dp(12), dp(32), dp(12));
            LinearLayout.LayoutParams cancelP = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            cancelP.setMargins(0, dp(20), 0, 0);
            cancelP.gravity = Gravity.CENTER_HORIZONTAL;
            cancelBtn.setLayoutParams(cancelP);
            cancelBtn.setClickable(true);
            cancelBtn.setOnClickListener(v -> onCancel.run());
            layout.addView(cancelBtn);
        }

        return layout;
    }

    private void showExtraTimePicker(String packageName) {
        int[] optionMinutes = getTimeRequestOptions();
        String[] labels = new String[optionMinutes.length];
        int[] seconds = new int[optionMinutes.length];
        for (int i = 0; i < optionMinutes.length; i++) {
            labels[i] = formatMinutes(optionMinutes[i]);
            seconds[i] = optionMinutes[i] * 60;
        }

        final LinearLayout[] holder = { null };
        holder[0] = makeDurationLayout("How much extra time?", labels, seconds,
                (durationSeconds) -> {
                    try { windowManager.removeView(holder[0]); } catch (Exception ignored) {}
                    pinDialogView = null;

                    ReactContext rc = PearGuardReactHost.get();
                    if (rc != null && rc.hasActiveReactInstance()) {
                        WritableMap params = Arguments.createMap();
                        params.putString("packageName", packageName);
                        params.putString("appName", getAppName(packageName));
                        params.putString("requestType", "extra_time");
                        params.putInt("extraSeconds", durationSeconds);
                        rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                                .emit("onTimeRequest", params);
                        Toast.makeText(this, "Request sent to parent", Toast.LENGTH_SHORT).show();
                    } else {
                        Toast.makeText(this, "Open PearGuard to send a request", Toast.LENGTH_LONG).show();
                    }
                    pendingRequestPackages.add(packageName);

                    Intent homeIntent = new Intent(Intent.ACTION_MAIN);
                    homeIntent.addCategory(Intent.CATEGORY_HOME);
                    homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(homeIntent);
                },
                true,
                () -> {
                    try { windowManager.removeView(holder[0]); } catch (Exception ignored) {}
                    pinDialogView = null;
                });

        WindowManager.LayoutParams wlp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                        : WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT
        );
        windowManager.addView(holder[0], wlp);
        pinDialogView = holder[0];
    }

    private void onEnterPin(String packageName) {
        final String[] enteredPin = { "" };

        LinearLayout dialogLayout = new LinearLayout(this);
        dialogLayout.setOrientation(LinearLayout.VERTICAL);
        dialogLayout.setBackgroundColor(OT.SURFACE_BASE);
        dialogLayout.setGravity(Gravity.CENTER_HORIZONTAL);
        dialogLayout.setPadding(dp(24), dp(48), dp(24), dp(48));

        // Icon circle
        LinearLayout icon = iconCircle(OT.ICON_CIRCLE_SM, ICON_LOCK, 32, OT.PRIMARY, OT.PRIMARY_BG);
        LinearLayout.LayoutParams iconP = new LinearLayout.LayoutParams(dp(OT.ICON_CIRCLE_SM), dp(OT.ICON_CIRCLE_SM));
        iconP.setMargins(0, 0, 0, dp(16));
        iconP.gravity = Gravity.CENTER_HORIZONTAL;
        icon.setLayoutParams(iconP);
        dialogLayout.addView(icon);

        // Title
        final TextView pinTitle = new TextView(this);
        pinTitle.setText("Enter parent PIN");
        pinTitle.setTextColor(OT.TEXT_PRIMARY);
        pinTitle.setTextSize(18);
        pinTitle.setTypeface(getNunitoRegular());
        pinTitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        titleP.setMargins(0, 0, 0, dp(24));
        pinTitle.setLayoutParams(titleP);
        dialogLayout.addView(pinTitle);

        // PIN dots
        LinearLayout dotsRow = new LinearLayout(this);
        dotsRow.setOrientation(LinearLayout.HORIZONTAL);
        dotsRow.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams dotsP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        dotsP.setMargins(0, 0, 0, dp(32));
        dotsP.gravity = Gravity.CENTER_HORIZONTAL;
        dotsRow.setLayoutParams(dotsP);

        final View[] dots = new View[4];
        for (int i = 0; i < 4; i++) {
            View dot = new View(this);
            int dotSize = dp(14);
            LinearLayout.LayoutParams dotP = new LinearLayout.LayoutParams(dotSize, dotSize);
            if (i > 0) dotP.setMargins(dp(16), 0, 0, 0);
            dot.setLayoutParams(dotP);
            android.graphics.drawable.GradientDrawable emptyDot = new android.graphics.drawable.GradientDrawable();
            emptyDot.setShape(android.graphics.drawable.GradientDrawable.OVAL);
            emptyDot.setStroke(dp(2), OT.BORDER);
            emptyDot.setColor(Color.TRANSPARENT);
            dot.setBackground(emptyDot);
            dots[i] = dot;
            dotsRow.addView(dot);
        }
        dialogLayout.addView(dotsRow);

        Runnable updateDots = () -> {
            int len = enteredPin[0].length();
            for (int i = 0; i < 4; i++) {
                android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
                d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
                if (i < len) {
                    d.setColor(OT.PRIMARY);
                } else {
                    d.setStroke(dp(2), OT.BORDER);
                    d.setColor(Color.TRANSPARENT);
                }
                dots[i].setBackground(d);
            }
        };

        Runnable showError = () -> {
            for (View dot : dots) {
                android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
                d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
                d.setColor(OT.ERROR);
                dot.setBackground(d);
            }
            pinTitle.setTextColor(OT.ERROR);
            pinTitle.setText("Incorrect PIN");
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                pinTitle.setTextColor(OT.TEXT_PRIMARY);
                pinTitle.setText("Enter parent PIN");
                updateDots.run();
            }, 1500);
        };

        // Number pad card
        LinearLayout padCard = new LinearLayout(this);
        padCard.setOrientation(LinearLayout.VERTICAL);
        padCard.setBackground(roundedRectWithBorder(OT.SURFACE_CARD, OT.BORDER, OT.CARD_RADIUS));
        padCard.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams padCardP = new LinearLayout.LayoutParams(dp(260), LinearLayout.LayoutParams.WRAP_CONTENT);
        padCardP.gravity = Gravity.CENTER_HORIZONTAL;
        padCard.setLayoutParams(padCardP);

        String[][] rows = { {"1","2","3"}, {"4","5","6"}, {"7","8","9"}, {"⌫","0",""} };
        boolean firstRow = true;
        for (String[] row : rows) {
            LinearLayout rowLayout = new LinearLayout(this);
            rowLayout.setOrientation(LinearLayout.HORIZONTAL);
            rowLayout.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            if (!firstRow) rowParams.setMargins(0, dp(8), 0, 0);
            firstRow = false;
            rowLayout.setLayoutParams(rowParams);

            for (String digit : row) {
                if ("\u232B".equals(digit)) {
                    // Backspace icon button
                    LinearLayout bsBtn = new LinearLayout(this);
                    bsBtn.setGravity(Gravity.CENTER);
                    LinearLayout.LayoutParams bsP = new LinearLayout.LayoutParams(0, dp(52), 1f);
                    bsP.setMargins(dp(4), 0, dp(4), 0);
                    bsBtn.setLayoutParams(bsP);
                    bsBtn.setBackground(roundedRect(Color.TRANSPARENT, OT.KEY_RADIUS));
                    bsBtn.addView(iconView(ICON_BACKSPACE, 24, OT.TEXT_SECONDARY));
                    bsBtn.setClickable(true);
                    bsBtn.setOnClickListener(v -> {
                        if (!enteredPin[0].isEmpty()) {
                            vibrate(PATTERN_TAP);
                            enteredPin[0] = enteredPin[0].substring(0, enteredPin[0].length() - 1);
                            updateDots.run();
                        }
                    });
                    rowLayout.addView(bsBtn);
                } else if ("".equals(digit)) {
                    View empty = new View(this);
                    LinearLayout.LayoutParams emptyP = new LinearLayout.LayoutParams(0, dp(52), 1f);
                    emptyP.setMargins(dp(4), 0, dp(4), 0);
                    empty.setLayoutParams(emptyP);
                    rowLayout.addView(empty);
                } else {
                    TextView btn = new TextView(this);
                    btn.setText(digit);
                    btn.setTextColor(OT.TEXT_PRIMARY);
                    btn.setTextSize(22);
                    btn.setTypeface(getNunitoRegular());
                    btn.setGravity(Gravity.CENTER);
                    LinearLayout.LayoutParams btnP = new LinearLayout.LayoutParams(0, dp(52), 1f);
                    btnP.setMargins(dp(4), 0, dp(4), 0);
                    btn.setLayoutParams(btnP);
                    btn.setBackground(roundedRect(OT.SURFACE_ELEV, OT.KEY_RADIUS));
                    btn.setClickable(true);
                    final String d = digit;
                    btn.setOnClickListener(v -> {
                        if (enteredPin[0].length() < 4) {
                            vibrate(PATTERN_TAP);
                            enteredPin[0] = enteredPin[0] + d;
                            updateDots.run();

                            if (enteredPin[0].length() == 4) {
                                if (verifyPin(enteredPin[0])) {
                                    vibrate(PATTERN_SUCCESS);
                                    try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
                                    pinDialogView = null;
                                    showDurationPicker(packageName);
                                } else {
                                    vibrate(PATTERN_ERROR);
                                    enteredPin[0] = "";
                                    showError.run();
                                }
                            }
                        }
                    });
                    rowLayout.addView(btn);
                }
            }
            padCard.addView(rowLayout);
        }
        dialogLayout.addView(padCard);

        // Cancel button (ghost)
        TextView cancelBtn = new TextView(this);
        cancelBtn.setText("Cancel");
        cancelBtn.setTextColor(OT.TEXT_SECONDARY);
        cancelBtn.setTextSize(14);
        cancelBtn.setTypeface(getNunitoSemiBold());
        cancelBtn.setGravity(Gravity.CENTER);
        cancelBtn.setBackground(roundedRectWithBorder(Color.TRANSPARENT, OT.BORDER, OT.BTN_RADIUS));
        cancelBtn.setPadding(dp(32), dp(12), dp(32), dp(12));
        LinearLayout.LayoutParams cancelP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cancelP.setMargins(0, dp(20), 0, 0);
        cancelP.gravity = Gravity.CENTER_HORIZONTAL;
        cancelBtn.setLayoutParams(cancelP);
        cancelBtn.setClickable(true);
        cancelBtn.setOnClickListener(v -> {
            try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
            pinDialogView = null;
        });
        dialogLayout.addView(cancelBtn);

        WindowManager.LayoutParams dialogParams = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                        : WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT
        );

        windowManager.addView(dialogLayout, dialogParams);
        pinDialogView = dialogLayout;
    }

    private void showDurationPicker(String packageName) {
        String[] labels = { "15 minutes", "30 minutes", "1 hour", "2 hours" };
        int[] seconds = { 900, 1800, 3600, 7200 };

        final LinearLayout[] holder = { null };
        holder[0] = makeDurationLayout("How long?", labels, seconds,
                (durationSeconds) -> {
                    try { windowManager.removeView(holder[0]); } catch (Exception ignored) {}
                    pinDialogView = null;
                    grantOverride(packageName, durationSeconds);
                },
                false, null);

        WindowManager.LayoutParams wlp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        ? WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY
                        : WindowManager.LayoutParams.TYPE_SYSTEM_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT
        );
        windowManager.addView(holder[0], wlp);
        pinDialogView = holder[0];
    }

    private void grantOverride(String packageName, int durationSeconds) {
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
        dismissOverlay();
    }

    /**
     * Verifies the entered PIN against the BLAKE2b hex hash stored by bare-dispatch.js pin:set.
     * pin:set uses crypto_generichash (BLAKE2b) and stores the result as a lowercase hex string.
     */
    private boolean verifyPin(String enteredPin) {
        JSONObject policy = loadPolicy();
        if (policy == null) return false;
        String pinHash = policy.optString("pinHash", null);
        if (pinHash == null || pinHash.isEmpty()) return false;

        try {
            byte[] storedHash = hexToBytes(pinHash);
            byte[] passwordBytes = enteredPin.getBytes(java.nio.charset.StandardCharsets.UTF_8);

            final int HASH_BYTES = 32; // crypto_generichash_BYTES
            byte[] computedHash = new byte[HASH_BYTES];
            // Mirrors: sodium.crypto_generichash(out, in) with no key
            lazySodium.getSodium().crypto_generichash(
                    computedHash, HASH_BYTES, passwordBytes, passwordBytes.length, null, 0);

            return Arrays.equals(computedHash, storedHash);
        } catch (Exception e) {
            return false;
        }
    }

    private static byte[] hexToBytes(String hex) {
        int len = hex.length();
        byte[] data = new byte[len / 2];
        for (int i = 0; i < len; i += 2) {
            data[i / 2] = (byte) ((Character.digit(hex.charAt(i), 16) << 4)
                    + Character.digit(hex.charAt(i + 1), 16));
        }
        return data;
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