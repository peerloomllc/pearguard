package com.pearguard;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.KeyguardManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
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
import android.os.PowerManager;
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

    // Mirrors MIN_PIN_LENGTH / MAX_PIN_LENGTH in src/pin-rules.js. The keypad can't
    // know the expected length — policy.pinHashes is keyed per parent and co-parents
    // may hold PINs of different lengths — so entry ends with an explicit submit key
    // rather than auto-submitting at a fixed digit count.
    private static final int PIN_MIN_LENGTH = 4;
    private static final int PIN_MAX_LENGTH = 10;

    // --- PIN brute-force lockout ---
    // The child controls this device, so lockout state has to survive overlay
    // dismissal, force-stop and reboot; it lives in SharedPreferences, not memory.
    private static final String PIN_FAIL_COUNT_KEY = "pearguard_pin_fail_count";
    private static final String PIN_LOCKED_UNTIL_KEY = "pearguard_pin_locked_until";
    private static final String PIN_LOCKED_AT_KEY = "pearguard_pin_locked_at";
    private static final int PIN_FREE_ATTEMPTS = 5;
    // Escalation is driven by the persisted failure count rather than by elapsed
    // time. A child who moves the system clock forward clears the current wait,
    // but the count survives, so the next wrong guess costs strictly more.
    private static final long[] PIN_LOCKOUT_LADDER_MS = { 30_000L, 120_000L, 600_000L, 3_600_000L };

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
    private static final String ICON_CHECK = "M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z";

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
    private String currentOverlayBlockCategory; // 'blocked', 'pending', 'schedule', 'daily_limit', 'category_limit'
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

    // --- Screen / lock state gating (#112 follow-up) ---
    // The block overlay must never be drawn while the screen is off or the lock
    // screen is up — otherwise it can get stuck over the keyguard with no way to
    // dismiss it (e.g. a Bedtime schedule block firing while the screen sleeps,
    // accepting a PIN but the overlay never clearing). KeyguardManager alone is
    // unreliable: it reports false on non-secure locks and during the delay
    // before the keyguard engages after sleep, and nothing re-checks it when the
    // screen turns off. We additionally track screen-interactive state via a
    // receiver and tear the overlay down immediately on SCREEN_OFF.
    private volatile boolean screenInteractive = true;
    // Set on SCREEN_OFF, cleared on USER_PRESENT (secure unlock) or on SCREEN_ON
    // when no keyguard is present (non-secure devices, which never fire
    // USER_PRESENT). While true the overlay is suppressed so it cannot flash
    // over the lock screen before the user unlocks.
    private volatile boolean awaitingUserPresent = false;
    private BroadcastReceiver screenStateReceiver;

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
     * True when the accessibility service is actually bound and connected — i.e.
     * it can enforce right now. Distinct from the Settings.Secure "enabled" flag,
     * which stays set even after the OS kills the service process. Used by
     * EnforcementService to catch the enabled-but-not-connected blind spot where
     * blocking silently no-ops but the child never disabled anything.
     */
    public static boolean isServiceConnected() {
        return sInstance != null;
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
        if (inst == null) return;
        inst.enforceCurrentForeground();
    }

    /**
     * Re-evaluates the real foreground app and shows/dismisses the overlay accordingly.
     * Called both from the EnforcementService 5s poll (#66) and from the fast re-check
     * burst after a dismissal (recents-return bypass mitigation).
     */
    private void enforceCurrentForeground() {
        // Query the actual foreground app. This catches cases where lastForegroundPackage
        // is stale - e.g. after the user enters recents (which sets lastForegroundPackage
        // to the launcher) and then returns to a blocked app without a
        // TYPE_WINDOW_STATE_CHANGED firing (#113).
        //
        // Do NOT early-return when lastForegroundPackage is null: a freshly
        // (re)connected accessibility service starts with lastForegroundPackage
        // null, and an app that was already in the foreground at reconnect fires
        // no window-state event, so bailing here left an already-open blocked app
        // usable until the next app switch. Querying the live foreground re-blocks
        // it on the very next poll instead.
        String realFg = queryForegroundPackage();
        final String pkg = (realFg != null) ? realFg : lastForegroundPackage;
        if (pkg == null) return;
        // Keep lastForegroundPackage in sync so onAccessibilityEvent doesn't
        // immediately dismiss the overlay we're about to show (#113).
        if (realFg != null && !realFg.equals(lastForegroundPackage)) {
            lastForegroundPackage = realFg;
        }
        new Handler(Looper.getMainLooper()).post(() -> {
            // Dismiss overlay while device is locked (#112).
            if (isDeviceLocked()) {
                if (overlayView != null || overlayPending) dismissOverlay();
                return;
            }
            if ((overlayView != null || overlayPending)
                    && pkg.equals(currentOverlayPackage)) {
                // Overlay is showing — re-check whether the block still applies.
                // Handles policy changes (e.g. daily limit removed) while overlay is up.
                String reason = getBlockReason(pkg);
                if (reason == null) {
                    dismissOverlay();
                } else {
                    // Blocked app is (still) the foreground — cancel any pending deferred
                    // teardown from a recents transition so the overlay stays put.
                    cancelDeferredDismiss();
                }
                return;
            }
            // Suppressed while an interaction dialog (e.g. extra-time picker) is showing.
            if (System.currentTimeMillis() < enforcementSuppressedUntil) return;
            String reason = getBlockReason(pkg);
            if (reason != null) showOverlay(pkg, reason);
        });
    }

    // --- Fast re-check burst (recents-return bypass mitigation) ---
    // After the overlay is dismissed because the foreground changed to home/recents/system
    // UI, the child can swipe straight back into the blocked app. Android frequently does
    // NOT fire a TYPE_WINDOW_STATE_CHANGED for that return, so onAccessibilityEvent never
    // runs and the only safety net is the EnforcementService 5s poll — a multi-second window
    // in which the blocked app is fully usable. Run a short high-frequency burst of
    // foreground re-checks so the overlay snaps back within a few hundred ms instead.
    private static final long RECHECK_BURST_INTERVAL_MS = 250;
    private static final long RECHECK_BURST_DURATION_MS = 3000;
    private final Handler burstHandler = new Handler(Looper.getMainLooper());
    private long burstUntil = 0;
    private boolean burstScheduled = false;

    private final Runnable recheckBurst = new Runnable() {
        @Override
        public void run() {
            enforceCurrentForeground();
            if (System.currentTimeMillis() < burstUntil) {
                burstHandler.postDelayed(this, RECHECK_BURST_INTERVAL_MS);
            } else {
                burstScheduled = false;
            }
        }
    };

    /** Starts (or extends) the fast re-check burst. Idempotent — won't stack runnables. */
    private void startRecheckBurst() {
        burstUntil = System.currentTimeMillis() + RECHECK_BURST_DURATION_MS;
        if (burstScheduled) return;
        burstScheduled = true;
        burstHandler.postDelayed(recheckBurst, RECHECK_BURST_INTERVAL_MS);
    }

    // --- Deferred dismissal (overlay flash elimination) ---
    // When the foreground moves to home/recents while a block is active, removing the
    // overlay immediately and re-adding it on the swipe-back produces a visible flash.
    // Instead, defer the teardown by DISMISS_DEFER_MS. If the blocked app returns to the
    // foreground within that window (the fast swipe-and-back), the deferred removal is
    // cancelled and the overlay is never taken down — no flash. If the child genuinely
    // leaves, the deferred removal fires and the overlay comes down.
    private static final long DISMISS_DEFER_MS = 450;
    private boolean deferredDismissScheduled = false;

    private final Runnable deferredDismiss = new Runnable() {
        @Override
        public void run() {
            deferredDismissScheduled = false;
            if (overlayView == null && !overlayPending) return;
            // Keep the overlay if the blocked app is back in the foreground.
            String realFg = queryForegroundPackage();
            if (currentOverlayPackage != null && currentOverlayPackage.equals(realFg)) return;
            dismissOverlay();
        }
    };

    private void scheduleDeferredDismiss() {
        if (deferredDismissScheduled) return;
        deferredDismissScheduled = true;
        burstHandler.postDelayed(deferredDismiss, DISMISS_DEFER_MS);
    }

    private void cancelDeferredDismiss() {
        if (!deferredDismissScheduled) return;
        deferredDismissScheduled = false;
        burstHandler.removeCallbacks(deferredDismiss);
    }

    /**
     * Uses the accessibility service's own window API to find the actual foreground
     * package. More reliable than UsageStatsManager during recents transitions,
     * since MOVE_TO_FOREGROUND may not fire when returning from the overview screen.
     */
    private String queryForegroundPackage() {
        try {
            android.view.accessibility.AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) {
                CharSequence pkg = root.getPackageName();
                root.recycle();
                if (pkg != null) return pkg.toString();
            }
        } catch (Exception ignored) {}
        return null;
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

        registerScreenStateReceiver();
        createBypassNotificationChannel();

        // Persist the role so BootReceiverModule restarts EnforcementService
        // (and NOT the parent's ParentConnectionService) after a reboot.
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            .edit()
            .putString("pearguard_mode", "child")
            .apply();

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
        if (screenStateReceiver != null) {
            try { unregisterReceiver(screenStateReceiver); } catch (Exception ignored) {}
            screenStateReceiver = null;
        }
        if (sInstance == this) sInstance = null;
    }

    /**
     * Registers a receiver for screen-power and unlock transitions. SCREEN_ON/OFF
     * cannot be declared in the manifest (Android implicit-broadcast limits), so
     * they must be registered at runtime while the service is alive. On SCREEN_OFF
     * we tear the overlay down immediately so it can never persist into sleep or
     * over the lock screen (#112).
     */
    private void registerScreenStateReceiver() {
        screenStateReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                switch (action) {
                    case Intent.ACTION_SCREEN_OFF:
                        screenInteractive = false;
                        awaitingUserPresent = true;
                        new Handler(Looper.getMainLooper()).post(() -> dismissOverlay());
                        break;
                    case Intent.ACTION_SCREEN_ON:
                        screenInteractive = true;
                        // Non-secure devices wake straight past the keyguard and
                        // never fire USER_PRESENT — clear the gate so enforcement
                        // resumes. Secure devices keep waiting for USER_PRESENT.
                        if (!isKeyguardLocked()) awaitingUserPresent = false;
                        break;
                    case Intent.ACTION_USER_PRESENT:
                        screenInteractive = true;
                        awaitingUserPresent = false;
                        break;
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        registerReceiver(screenStateReceiver, filter);
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
            boolean wasShowing = (overlayView != null || overlayPending);
            if (wasShowing) {
                // Defer the teardown instead of removing the overlay now. A fast swipe
                // through recents and straight back into the blocked app cancels the
                // deferred removal (see deferredDismiss), so the overlay is never taken
                // down and there is no disappear/reappear flash. The burst catches the
                // return when it fires no accessibility event of its own.
                scheduleDeferredDismiss();
                startRecheckBurst();
            } else {
                dismissOverlay();
            }
        }
    }

    /**
     * Returns true for system packages that have no launcher activity — these are
     * pure system/nav overlays (e.g. SystemUI) that fire spurious events during
     * gesture navigation. User-visible system apps (Chrome, YouTube) have a launch
     * intent and return false, so the overlay is correctly dismissed for them.
     */
    private boolean isSystemOverlayPackage(String packageName) {
        return isSystemOverlayPackage(this, packageName);
    }

    static boolean isSystemOverlayPackage(Context ctx, String packageName) {
        try {
            PackageManager pm = ctx.getPackageManager();
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
        // Exemptions: system services, phone/messaging, and PearGuard itself
        // are never blocked — otherwise global lock would lock the child out
        // of the app they need to see the block reason / request overrides.
        if (packageName == null) return null;
        if (packageName.equals(getPackageName())) return null;
        if (isSystemOverlayPackage(packageName)) return null;
        if (PhoneAppHelper.isPhoneOrMessagingApp(this, packageName)) return null;

        JSONObject policy = loadPolicy();
        if (policy == null) return null; // no policy yet, allow everything

        try {
            // Step 0: Device-wide lock — parent toggled quick-lock, block everything.
            boolean locked = policy.optBoolean("locked", false);
            if (locked) {
                String lockMessage = policy.optString("lockMessage", "");
                if (lockMessage != null && !lockMessage.isEmpty()) return lockMessage;
                return "Device is locked by your parent.";
            }

            // Step 0.5: Free-time / holiday pause — parent temporarily suspended ALL
            // enforcement until pauseUntil. Wins over schedules, limits and blocks
            // (mutually exclusive with a lock, which is handled above).
            long pauseUntil = policy.optLong("pauseUntil", 0L);
            if (pauseUntil > System.currentTimeMillis()) {
                return null;
            }

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

            // Step 1.5: Device-wide cumulative screen-time cap. Applies to every
            // non-exempt app (built-in exemptions were filtered above). An active
            // override returned null already, so a parent-granted time extension
            // still wins. Parent-chosen exempt apps (#178) skip the cap but fall
            // through to their own per-app/category limit below — unlike the
            // built-in exemptions, which return null and skip every check.
            // effectiveScreenTimeLimitSeconds folds in any general-time grant (#179).
            int screenLimit = effectiveScreenTimeLimitSeconds(this, policy);
            if (screenLimit > 0 && !isScreenTimeExempt(policy, packageName)) {
                int totalUsed = getTotalDailyUsageSeconds(policy);
                if (totalUsed >= screenLimit) {
                    int minutes = screenLimit / 60;
                    return "Screen time limit reached (" + minutes + " min/day).";
                }
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

                // Step 3.5: Per-app time-of-day window (allow-only or block-during).
                String windowReason = getAppWindowBlockReason(appPolicy);
                if (windowReason != null) return windowReason;

                // Step 4: Daily limit exceeded. Per-app limit wins; category
                // limit is the fallback only when no per-app limit is set.
                int limitSeconds = appPolicy.optInt("dailyLimitSeconds", -1);
                if (limitSeconds > 0) {
                    int usedSeconds = getDailyUsageSeconds(packageName);
                    if (usedSeconds >= limitSeconds) {
                        int minutes = limitSeconds / 60;
                        return "Daily limit reached (" + minutes + " min/day).";
                    }
                } else {
                    String categoryReason = getCategoryLimitBlockReason(policy, apps, appPolicy);
                    if (categoryReason != null) return categoryReason;
                }
            } else if (apps != null && isUnapprovedUserApp(packageName)) {
                // Step 5: Unknown app. A launchable, non-system app that is absent
                // from the parent's policy was installed after the last apps:sync
                // and has never been approved. Fail CLOSED (pending) rather than
                // allowing it: the install broadcast (PackageMonitorModule) is
                // dropped whenever the RN bridge is down — which is most of the
                // time in normal backgrounded operation — so enforcement cannot
                // rely on a pending entry ever being written. Without this a fresh
                // install is fully usable until a parent happens to connect and
                // apps:sync records it (hours or days). Exempt/system/background
                // packages returned earlier or are filtered by isUnapprovedUserApp.
                return "Needs parent approval.";
            }

        } catch (Exception e) {
            // Parse error — fail open (allow)
        }

        return null; // allow
    }

    // A launchable, non-system app that is not in the parent's policy is treated
    // as a newly installed, unapproved app (pending). This mirrors the
    // launcher-visible enumeration that builds the policy
    // (UsageStatsModule.getInstalledPackages), so only user-facing third-party
    // installs are caught here; system and background packages are never blocked.
    // Results are cached — launcher/system status is immutable for an installed
    // package, and once the parent approves an app it lands in the policy map and
    // is handled by the apps.has(...) branch before this check is reached.
    private final java.util.Map<String, Boolean> unapprovedAppCache = new java.util.concurrent.ConcurrentHashMap<>();

    private boolean isUnapprovedUserApp(String packageName) {
        Boolean cached = unapprovedAppCache.get(packageName);
        if (cached != null) return cached;
        boolean result = false;
        try {
            PackageManager pm = getPackageManager();
            if (pm.getLaunchIntentForPackage(packageName) != null) {
                ApplicationInfo info = pm.getApplicationInfo(packageName, 0);
                boolean isSystem = (info.flags
                        & (ApplicationInfo.FLAG_SYSTEM | ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0;
                result = !isSystem;
            }
        } catch (Exception e) {
            result = false; // unknown / just-removed package — do not block
        }
        unapprovedAppCache.put(packageName, result);
        return result;
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
     * Per-app time-of-day window. appPolicy.window = { mode:'allow'|'block',
     * days:[0-6], start:'HH:MM', end:'HH:MM' }. 'allow' → usable only inside the
     * window; 'block' → blocked during it. Returns a block reason or null.
     * Mirrors isBlockedByAppWindow in src/policy.js.
     */
    private String getAppWindowBlockReason(JSONObject appPolicy) {
        try {
            JSONObject w = appPolicy.optJSONObject("window");
            if (w == null) return null;
            String mode = w.optString("mode", "");
            if (!"allow".equals(mode) && !"block".equals(mode)) return null;
            JSONArray days = w.optJSONArray("days");
            String start = w.optString("start", "");
            String end = w.optString("end", "");
            if (days == null || days.length() == 0 || start.isEmpty() || end.isEmpty()) return null;

            Calendar now = Calendar.getInstance();
            int dayOfWeek = now.get(Calendar.DAY_OF_WEEK) - 1; // 0=Sunday
            int nowMinutes = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
            boolean dayMatches = false;
            for (int d = 0; d < days.length(); d++) {
                if (days.getInt(d) == dayOfWeek) { dayMatches = true; break; }
            }

            String[] sp = start.split(":");
            String[] ep = end.split(":");
            int startMin = Integer.parseInt(sp[0]) * 60 + Integer.parseInt(sp[1]);
            int endMin = Integer.parseInt(ep[0]) * 60 + Integer.parseInt(ep[1]);
            boolean inWindow;
            if (startMin <= endMin) {
                inWindow = dayMatches && nowMinutes >= startMin && nowMinutes < endMin;
            } else {
                inWindow = dayMatches && (nowMinutes >= startMin || nowMinutes < endMin);
            }

            if ("block".equals(mode)) {
                return inWindow ? "Blocked from " + fmt12(start) + " to " + fmt12(end) + "." : null;
            }
            // allow: blocked whenever we're outside the window.
            return inWindow ? null : "Allowed only " + fmt12(start) + " to " + fmt12(end) + ".";
        } catch (Exception ignored) {}
        return null;
    }

    /** Format "HH:MM" (24h) as a 12-hour clock time, e.g. "16:00" -> "4:00 PM". */
    private String fmt12(String hhmm) {
        try {
            String[] p = hhmm.split(":");
            int h = Integer.parseInt(p[0]);
            int m = Integer.parseInt(p[1]);
            String ap = h < 12 ? "AM" : "PM";
            int h12 = h % 12;
            if (h12 == 0) h12 = 12;
            return h12 + ":" + String.format("%02d", m) + " " + ap;
        } catch (Exception e) {
            return hhmm;
        }
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
        return getDailyUsageSeconds(this, packageName);
    }

    static int getDailyUsageSeconds(Context ctx, String packageName) {
        UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
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
            // App is still in the foreground — add elapsed time since session
            // start, but only if it is genuinely on screen right now. A session
            // left open by a missing MOVE_TO_BACKGROUND (or one running under a
            // screen-off media app) would otherwise accrue idle hours and block
            // the child far below their real usage.
            if (sessionStart >= 0
                    && UsageSessionUtil.shouldAccrueOpenSession(
                            UsageSessionUtil.isScreenInteractive(ctx), packageName, getLastForegroundPackage())) {
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

    /** Local calendar date as YYYY-MM-DD, matching localDateStr in bare-dispatch.js. */
    static String localDateKey() {
        Calendar c = Calendar.getInstance();
        return String.format(java.util.Locale.US, "%04d-%02d-%02d",
                c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    /**
     * Parent-granted screen-time top-up for today (#179), or 0 if none was granted
     * or the grant is stamped with a different date. Comparing dates rather than
     * storing an expiry means the grant lapses at midnight, and rolling the clock
     * back discards it instead of extending it.
     */
    static int getScreenTimeBonusSeconds(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        String date = prefs.getString("screentime_bonus_date", null);
        if (date == null || !date.equals(localDateKey())) return 0;
        int seconds = prefs.getInt("screentime_bonus_seconds", 0);
        return Math.max(seconds, 0);
    }

    /**
     * The cap actually enforced right now: the parent's daily budget plus any
     * general-time grant for today. Returns 0 when no cap is configured.
     */
    static int effectiveScreenTimeLimitSeconds(Context ctx, JSONObject policy) {
        if (policy == null) return 0;
        int limit = policy.optInt("dailyScreenTimeLimitSeconds", 0);
        if (limit <= 0) return 0;
        return limit + getScreenTimeBonusSeconds(ctx);
    }

    /**
     * True if the parent marked this package exempt from the device-wide
     * screen-time cap (#178). Exempt apps neither spend the shared budget nor
     * get blocked once it's gone, but their own per-app limit still applies.
     */
    static boolean isScreenTimeExempt(JSONObject policy, String packageName) {
        if (policy == null || packageName == null) return false;
        JSONArray exempt = policy.optJSONArray("screenTimeExemptApps");
        if (exempt == null) return false;
        for (int i = 0; i < exempt.length(); i++) {
            if (packageName.equals(exempt.optString(i))) return true;
        }
        return false;
    }

    /**
     * Total foreground screen time in seconds across all non-exempt packages
     * today, computed in a single event scan. Backs the device-wide
     * cumulative screen-time cap. Exempt packages (PearGuard itself,
     * phone/messaging, system overlays, plus the parent's screenTimeExemptApps)
     * are skipped so a call or the PearGuard app never counts against the
     * budget — mirroring the exemptions in getBlockReason.
     */
    private int getTotalDailyUsageSeconds(JSONObject policy) {
        return getTotalDailyUsageSeconds(this, policy);
    }

    static int getTotalDailyUsageSeconds(Context ctx, JSONObject policy) {
        UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
        if (usm == null) return 0;
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long startOfDay = cal.getTimeInMillis();
        long now = System.currentTimeMillis();
        // Hoisted out of the event loop — the scan can see thousands of events.
        Set<String> screenTimeExempt = new java.util.HashSet<>();
        if (policy != null) {
            JSONArray arr = policy.optJSONArray("screenTimeExemptApps");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) screenTimeExempt.add(arr.optString(i));
            }
        }
        try {
            UsageEvents events = usm.queryEvents(startOfDay, now);
            if (events == null) return 0;
            UsageEvents.Event event = new UsageEvents.Event();
            // Track an open session per package so interleaved app switches sum correctly.
            Map<String, Long> sessionStart = new java.util.HashMap<>();
            long totalMs = 0;
            while (events.hasNextEvent()) {
                events.getNextEvent(event);
                String pkg = event.getPackageName();
                if (pkg == null) continue;
                if (pkg.equals(ctx.getPackageName())) continue;
                if (isSystemOverlayPackage(ctx, pkg)) continue;
                if (PhoneAppHelper.isPhoneOrMessagingApp(ctx, pkg)) continue;
                if (screenTimeExempt.contains(pkg)) continue;
                if (event.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                    sessionStart.put(pkg, event.getTimeStamp());
                } else if (event.getEventType() == UsageEvents.Event.MOVE_TO_BACKGROUND) {
                    Long start = sessionStart.remove(pkg);
                    if (start != null) totalMs += event.getTimeStamp() - start;
                }
            }
            // Any package still in the foreground — add elapsed time since its
            // start, but only for the app actually on screen right now. Extending
            // every open session to `now` (stale never-closed sessions, or a
            // screen-off media app) inflated the device-wide total by hours and
            // tripped the cumulative cap prematurely.
            boolean screenInteractive = UsageSessionUtil.isScreenInteractive(ctx);
            String currentForeground = getLastForegroundPackage();
            for (Map.Entry<String, Long> e : sessionStart.entrySet()) {
                Long start = e.getValue();
                if (start == null) continue;
                if (!UsageSessionUtil.shouldAccrueOpenSession(screenInteractive, e.getKey(), currentForeground)) continue;
                totalMs += now - start;
            }
            return (int)(totalMs / 1000);
        } catch (Exception e) {
            return 0;
        }
    }

    /**
     * Category-limit fallback. Only called when the app has no per-app
     * dailyLimitSeconds of its own. Sums foreground seconds across every app
     * in the same category and compares to the category's daily budget.
     */
    private String getCategoryLimitBlockReason(JSONObject policy, JSONObject apps, JSONObject appPolicy) {
        try {
            String category = appPolicy.optString("category", null);
            if (category == null || category.isEmpty()) return null;
            JSONObject categories = policy.optJSONObject("categories");
            if (categories == null) return null;
            JSONObject categoryPolicy = categories.optJSONObject(category);
            if (categoryPolicy == null) return null;
            int limitSeconds = categoryPolicy.optInt("dailyLimitSeconds", -1);
            if (limitSeconds <= 0) return null;

            int totalUsed = 0;
            java.util.Iterator<String> it = apps.keys();
            while (it.hasNext()) {
                String pkg = it.next();
                JSONObject other = apps.optJSONObject(pkg);
                if (other == null) continue;
                if (!category.equals(other.optString("category", ""))) continue;
                totalUsed += getDailyUsageSeconds(pkg);
                if (totalUsed >= limitSeconds) break;
            }
            if (totalUsed >= limitSeconds) {
                int minutes = limitSeconds / 60;
                return category + " limit reached (" + minutes + " min/day).";
            }
        } catch (Exception e) {
            // Fail open
        }
        return null;
    }

    private JSONObject loadPolicy() {
        return loadPolicy(this);
    }

    static JSONObject loadPolicy(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
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
     * Returns one of: "blocked", "pending", "schedule", "daily_limit", "category_limit"
     */
    private String getBlockCategory(String reason) {
        if (reason == null) return "blocked";
        if (reason.contains("parent approval")) return "pending";
        if (reason.contains("Daily limit")) return "daily_limit";
        if (reason.contains("Screen time limit")) return "screen_time";
        if (reason.contains("Blocked during")) return "schedule";
        // Per-app time-of-day window reasons are time-based like a schedule.
        if (reason.startsWith("Allowed only") || reason.startsWith("Blocked from")) return "schedule";
        // Category-limit reasons are formatted as "<category> limit reached (<n> min/day).";
        // matching this last so it doesn't shadow the per-app "Daily limit" check above.
        if (reason.contains("limit reached")) return "category_limit";
        return "blocked";
    }

    /** Raw keyguard check — true when the lock screen is active. */
    private boolean isKeyguardLocked() {
        KeyguardManager km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
        return km != null && km.isKeyguardLocked();
    }

    /** True when the screen is on (interactive). Defaults to true if unavailable. */
    @SuppressWarnings("deprecation")
    private boolean isScreenInteractive() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm == null) return true;
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT_WATCH
                ? pm.isInteractive() : pm.isScreenOn();
    }

    /**
     * Returns true when the block overlay must be suppressed: the screen is off,
     * the keyguard is up, or we are still waiting for the user to unlock after
     * sleep. Gating on all three (rather than the keyguard alone) prevents the
     * overlay from getting stuck over the lock screen with no way to dismiss it,
     * including the case where a schedule block fires while the screen is off and
     * isKeyguardLocked() has not yet engaged (#112).
     */
    private boolean isDeviceLocked() {
        return !screenInteractive
                || !isScreenInteractive()
                || isKeyguardLocked()
                || awaitingUserPresent;
    }

    private void showOverlay(String packageName, String reason) {
        // Don't show overlay on the lock screen (#112).
        if (isDeviceLocked()) return;

        // Skip during cooldown window after the overlay was just dismissed for this package.
        // The blocked app fires a final TYPE_WINDOW_STATE_CHANGED as its activity destructs
        // (e.g. after back gesture or Send Request). Without this guard that event would
        // re-trigger the overlay over the home screen.
        // Exception: if the blocked app is genuinely the real foreground again (child swiped
        // back from recents), bypass the cooldown so the overlay snaps back instead of
        // waiting it out. The destruction-event case is distinguished because the real
        // foreground there is the launcher, not the blocked package.
        if (packageName.equals(recentlyDismissedPackage)
                && System.currentTimeMillis() - dismissedAt < DISMISS_COOLDOWN_MS
                && !packageName.equals(queryForegroundPackage())) {
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
            case "pending":        titleText = appName + " needs approval"; break;
            case "daily_limit":    titleText = appName + ": daily limit reached"; break;
            case "category_limit": titleText = appName + ": category limit reached"; break;
            case "screen_time":    titleText = "Screen time's up"; break;
            case "schedule":       titleText = appName + ": scheduled block"; break;
            default:               titleText = appName + " is blocked"; break;
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
        final String blockReason = reason;
        boolean isExtraTime = "schedule".equals(blockCategory)
                || "daily_limit".equals(blockCategory)
                || "category_limit".equals(blockCategory)
                || "screen_time".equals(blockCategory);

        // Row 1: Request Approval / Request More Time
        String requestLabel = requestAlreadySent
                ? (isExtraTime ? "Resend Time Request" : "Resend Approval Request")
                : (isExtraTime ? "Request More Time" : "Request Approval");
        String requestIcon = isExtraTime ? ICON_CLOCK : ICON_SHIELD;
        card.addView(makeActionRow(requestIcon, requestLabel, OT.PRIMARY,
                () -> { vibrate(PATTERN_BUTTON); onSendRequest(packageName, blockCategory, blockReason); }));

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

        // Explicit way off the block screen. The back gesture / home button work but
        // aren't obvious and lag on some devices, so give an on-screen exit that
        // sends the child home (see goToHomeScreen — a bare dismiss would bounce
        // straight back into the block).
        layout.addView(makeGhostButton("Close", this::goToHomeScreen));

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

    /**
     * Dismiss the overlay and send the child to the launcher. Navigating home is
     * required rather than merely removing the view: the blocked app sits behind
     * the overlay, so a bare dismiss would let it re-trigger the block immediately.
     */
    private void goToHomeScreen() {
        dismissOverlay();
        Intent homeIntent = new Intent(Intent.ACTION_MAIN);
        homeIntent.addCategory(Intent.CATEGORY_HOME);
        homeIntent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(homeIntent);
    }

    private void dismissOverlay() {
        cancelDeferredDismiss();
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

    /**
     * Ghost (outlined, transparent) button used for Cancel/Close actions at the
     * bottom of every overlay screen. Centred horizontally with a top margin.
     */
    private TextView makeGhostButton(String label, Runnable onClick) {
        TextView btn = new TextView(this);
        btn.setText(label);
        btn.setTextColor(OT.TEXT_SECONDARY);
        btn.setTextSize(14);
        btn.setTypeface(getNunitoSemiBold());
        btn.setGravity(Gravity.CENTER);
        btn.setBackground(roundedRectWithBorder(Color.TRANSPARENT, OT.BORDER, OT.BTN_RADIUS));
        btn.setPadding(dp(32), dp(12), dp(32), dp(12));
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        p.setMargins(0, dp(20), 0, 0);
        p.gravity = Gravity.CENTER_HORIZONTAL;
        btn.setLayoutParams(p);
        btn.setClickable(true);
        btn.setOnClickListener(v -> onClick.run());
        return btn;
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

    private void onSendRequest(String packageName, String blockCategory, String reason) {
        // A screen-time block means the shared daily budget is spent, not that this
        // one app is restricted — so ask for general time, which tops the budget up
        // rather than granting a per-app override (#179).
        boolean isScreenTime = "screen_time".equals(blockCategory);
        boolean isExtraTime = "schedule".equals(blockCategory)
                || "daily_limit".equals(blockCategory)
                || "category_limit".equals(blockCategory)
                || isScreenTime;
        if (isExtraTime) {
            // Suppress the polling-loop overlay for 2 minutes so the duration picker
            // dialog is not immediately overwritten by the next EnforcementService tick (#66).
            enforcementSuppressedUntil = System.currentTimeMillis() + 120_000;
            // Layer the picker on top of the block overlay rather than dismissing it
            // first. Keeping the block screen attached underneath means Cancel just
            // removes the picker to reveal it (no rebuild), and neither transition
            // flashes the blocked app through a gap. Mirrors the PIN keypad flow.
            showExtraTimePicker(packageName, reason, isScreenTime ? "general_time" : "extra_time");
            return;
        }

        // Approval request — fire immediately if the RN bridge is alive,
        // otherwise queue to disk so UsageFlushWorker can deliver it later.
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
            TimeRequestQueueHelper.enqueue(this, packageName, getAppName(packageName), "approval", 0);
            Toast.makeText(this, "Request queued — will sync to parent shortly", Toast.LENGTH_LONG).show();
        }
        // Track that a request was sent — suppresses the overlay from re-appearing
        // over the home screen while waiting for the parent's response.
        pendingRequestPackages.add(packageName);

        // Go to the home screen so the blocked app cannot immediately re-trigger
        // the overlay by coming back to foreground.
        goToHomeScreen();
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
        layout.setGravity(Gravity.CENTER);
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
            layout.addView(makeGhostButton("Cancel", onCancel));
        }

        return layout;
    }

    private void showExtraTimePicker(String packageName, String reason, String requestType) {
        int[] optionMinutes = getTimeRequestOptions();
        String[] labels = new String[optionMinutes.length];
        int[] seconds = new int[optionMinutes.length];
        for (int i = 0; i < optionMinutes.length; i++) {
            labels[i] = formatMinutes(optionMinutes[i]);
            seconds[i] = optionMinutes[i] * 60;
        }

        boolean isGeneral = "general_time".equals(requestType);
        String title = isGeneral ? "How much more screen time?" : "How much extra time?";

        final LinearLayout[] holder = { null };
        holder[0] = makeDurationLayout(title, labels, seconds,
                (durationSeconds) -> {
                    try { windowManager.removeView(holder[0]); } catch (Exception ignored) {}
                    pinDialogView = null;

                    ReactContext rc = PearGuardReactHost.get();
                    if (rc != null && rc.hasActiveReactInstance()) {
                        WritableMap params = Arguments.createMap();
                        params.putString("packageName", packageName);
                        params.putString("appName", getAppName(packageName));
                        params.putString("requestType", requestType);
                        params.putInt("extraSeconds", durationSeconds);
                        rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                                .emit("onTimeRequest", params);
                        Toast.makeText(this, "Request sent to parent", Toast.LENGTH_SHORT).show();
                    } else {
                        TimeRequestQueueHelper.enqueue(this, packageName, getAppName(packageName),
                                requestType, durationSeconds);
                        Toast.makeText(this, "Request queued — will sync to parent shortly", Toast.LENGTH_LONG).show();
                    }
                    pendingRequestPackages.add(packageName);

                    // The block overlay is still attached beneath the picker, so
                    // dismiss it and go home rather than leaving it floating over
                    // the launcher.
                    goToHomeScreen();
                },
                true,
                () -> {
                    // Just remove the picker; the block overlay is still attached
                    // underneath, so the child lands back on the first screen with no
                    // rebuild and no flash. Resume enforcement, which was suppressed
                    // for 2 minutes when "Request More Time" was tapped.
                    try { windowManager.removeView(holder[0]); } catch (Exception ignored) {}
                    pinDialogView = null;
                    enforcementSuppressedUntil = 0;
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
        long lockRemaining = pinLockRemainingMs();
        if (lockRemaining > 0L) {
            showPinLockout(packageName, lockRemaining);
            return;
        }

        final String[] enteredPin = { "" };

        LinearLayout dialogLayout = new LinearLayout(this);
        dialogLayout.setOrientation(LinearLayout.VERTICAL);
        dialogLayout.setBackgroundColor(OT.SURFACE_BASE);
        dialogLayout.setGravity(Gravity.CENTER);
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

        dialogLayout.addView(dotsRow);

        // The submit key lives in the pad below; it needs to enable/disable as the
        // entry crosses PIN_MIN_LENGTH, so the pad hands its view back through here.
        final View[] submitBtn = { null };
        final boolean[] showingError = { false };

        // Dots grow with the entry: always at least PIN_MIN_LENGTH placeholders, one
        // more for each digit past that, up to PIN_MAX_LENGTH.
        Runnable renderDots = () -> {
            int len = enteredPin[0].length();
            int count = Math.max(PIN_MIN_LENGTH, len);
            dotsRow.removeAllViews();
            for (int i = 0; i < count; i++) {
                View dot = new View(this);
                int dotSize = dp(14);
                LinearLayout.LayoutParams dotP = new LinearLayout.LayoutParams(dotSize, dotSize);
                if (i > 0) dotP.setMargins(dp(12), 0, 0, 0);
                dot.setLayoutParams(dotP);
                android.graphics.drawable.GradientDrawable d = new android.graphics.drawable.GradientDrawable();
                d.setShape(android.graphics.drawable.GradientDrawable.OVAL);
                if (showingError[0]) {
                    d.setColor(OT.ERROR);
                } else if (i < len) {
                    d.setColor(OT.PRIMARY);
                } else {
                    d.setStroke(dp(2), OT.BORDER);
                    d.setColor(Color.TRANSPARENT);
                }
                dot.setBackground(d);
                dotsRow.addView(dot);
            }
            if (submitBtn[0] != null) {
                boolean canSubmit = len >= PIN_MIN_LENGTH;
                submitBtn[0].setEnabled(canSubmit);
                submitBtn[0].setClickable(canSubmit);
                submitBtn[0].setAlpha(canSubmit ? 1f : 0.35f);
            }
        };

        Runnable updateDots = () -> {
            showingError[0] = false;
            renderDots.run();
        };

        Runnable showError = () -> {
            showingError[0] = true;
            renderDots.run();
            int left = pinAttemptsRemaining();
            pinTitle.setTextColor(OT.ERROR);
            pinTitle.setText(left == 1
                    ? "Incorrect PIN - 1 try left"
                    : "Incorrect PIN - " + left + " tries left");
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                pinTitle.setTextColor(OT.TEXT_PRIMARY);
                pinTitle.setText("Enter parent PIN");
                updateDots.run();
            }, 1500);
        };

        // Submitting is explicit: each attempt costs a strike, so verifying on every
        // keystroke would let a child brute-force by typing without ever "submitting".
        Runnable onSubmit = () -> {
            if (enteredPin[0].length() < PIN_MIN_LENGTH) return;
            if (verifyPin(enteredPin[0])) {
                vibrate(PATTERN_SUCCESS);
                clearPinFailures();
                // Add the next screen on top before removing the keypad, so the
                // block overlay underneath never flashes through the gap. Each
                // show* sets pinDialogView to its own window.
                showDurationPicker(packageName);
                try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
            } else {
                vibrate(PATTERN_ERROR);
                enteredPin[0] = "";
                long lockMs = recordPinFailure();
                if (lockMs > 0L) {
                    // A lockout was just triggered. The keypad is hidden while locked,
                    // so this only fires on a fresh lockout, never per attempt-while-
                    // locked — tell the parent the child is guessing.
                    notifyParentPinFailure(packageName, lockMs);
                    showPinLockout(packageName, lockMs);
                    try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
                } else {
                    showError.run();
                }
            }
        };

        // Number pad card
        LinearLayout padCard = new LinearLayout(this);
        padCard.setOrientation(LinearLayout.VERTICAL);
        padCard.setBackground(roundedRectWithBorder(OT.SURFACE_CARD, OT.BORDER, OT.CARD_RADIUS));
        padCard.setPadding(dp(12), dp(12), dp(12), dp(12));
        LinearLayout.LayoutParams padCardP = new LinearLayout.LayoutParams(dp(260), LinearLayout.LayoutParams.WRAP_CONTENT);
        padCardP.gravity = Gravity.CENTER_HORIZONTAL;
        padCard.setLayoutParams(padCardP);

        String[][] rows = { {"1","2","3"}, {"4","5","6"}, {"7","8","9"}, {"⌫","0","✓"} };
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
                } else if ("✓".equals(digit)) {
                    // Submit key — occupies the slot the old fixed-length pad left empty.
                    LinearLayout okBtn = new LinearLayout(this);
                    okBtn.setGravity(Gravity.CENTER);
                    LinearLayout.LayoutParams okP = new LinearLayout.LayoutParams(0, dp(52), 1f);
                    okP.setMargins(dp(4), 0, dp(4), 0);
                    okBtn.setLayoutParams(okP);
                    okBtn.setBackground(roundedRect(OT.PRIMARY_BG, OT.KEY_RADIUS));
                    okBtn.addView(iconView(ICON_CHECK, 24, OT.PRIMARY));
                    okBtn.setContentDescription("Submit PIN");
                    okBtn.setOnClickListener(v -> onSubmit.run());
                    submitBtn[0] = okBtn;
                    rowLayout.addView(okBtn);
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
                        if (enteredPin[0].length() < PIN_MAX_LENGTH) {
                            vibrate(PATTERN_TAP);
                            enteredPin[0] = enteredPin[0] + d;
                            updateDots.run();
                        }
                    });
                    rowLayout.addView(btn);
                }
            }
            padCard.addView(rowLayout);
        }
        dialogLayout.addView(padCard);

        // First paint: draws the placeholder dots and disables submit until
        // PIN_MIN_LENGTH digits are entered. Must run after the pad builds submitBtn.
        updateDots.run();

        // Cancel returns to the block screen, which is still attached underneath.
        dialogLayout.addView(makeGhostButton("Cancel", () -> {
            try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
            pinDialogView = null;
        }));

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

    /**
     * Replaces the keypad while a lockout is in force. Counts down once a second
     * and reopens the keypad on its own when the wait elapses.
     */
    private void showPinLockout(String packageName, long remainingMs) {
        LinearLayout dialogLayout = new LinearLayout(this);
        dialogLayout.setOrientation(LinearLayout.VERTICAL);
        dialogLayout.setBackgroundColor(OT.SURFACE_BASE);
        dialogLayout.setGravity(Gravity.CENTER);
        dialogLayout.setPadding(dp(24), dp(48), dp(24), dp(48));

        LinearLayout icon = iconCircle(OT.ICON_CIRCLE_SM, ICON_LOCK, 32, OT.ERROR, OT.PRIMARY_BG);
        LinearLayout.LayoutParams iconP = new LinearLayout.LayoutParams(dp(OT.ICON_CIRCLE_SM), dp(OT.ICON_CIRCLE_SM));
        iconP.setMargins(0, 0, 0, dp(16));
        iconP.gravity = Gravity.CENTER_HORIZONTAL;
        icon.setLayoutParams(iconP);
        dialogLayout.addView(icon);

        TextView title = new TextView(this);
        title.setText("Too many attempts");
        title.setTextColor(OT.TEXT_PRIMARY);
        title.setTextSize(20);
        title.setTypeface(getNunitoSemiBold());
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams titleP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        titleP.setMargins(0, 0, 0, dp(8));
        titleP.gravity = Gravity.CENTER_HORIZONTAL;
        title.setLayoutParams(titleP);
        dialogLayout.addView(title);

        final TextView countdown = new TextView(this);
        countdown.setText("Try again in " + formatLockRemaining(remainingMs));
        countdown.setTextColor(OT.TEXT_SECONDARY);
        countdown.setTextSize(15);
        countdown.setTypeface(getNunitoRegular());
        countdown.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams cdP = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cdP.setMargins(0, 0, 0, dp(32));
        cdP.gravity = Gravity.CENTER_HORIZONTAL;
        countdown.setLayoutParams(cdP);
        dialogLayout.addView(countdown);

        // Guards the ticker against firing after the view is gone, which would
        // otherwise reopen the keypad over whatever the child navigated to.
        final boolean[] dismissed = { false };

        // Cancel returns to the block screen, still attached underneath.
        dialogLayout.addView(makeGhostButton("Cancel", () -> {
            dismissed[0] = true;
            try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
            pinDialogView = null;
        }));

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

        final Handler handler = new Handler(Looper.getMainLooper());

        final Runnable[] tick = { null };
        tick[0] = () -> {
            // pinDialogView changing out from under us means something else (a
            // dismiss, a new overlay) already tore this view down.
            if (dismissed[0] || pinDialogView != dialogLayout) return;
            long left = pinLockRemainingMs();
            if (left <= 0L) {
                dismissed[0] = true;
                // Re-open the keypad on top before removing the lockout screen so
                // the block overlay underneath never flashes through the gap.
                onEnterPin(packageName);
                try { windowManager.removeView(dialogLayout); } catch (Exception ignored) {}
                return;
            }
            countdown.setText("Try again in " + formatLockRemaining(left));
            handler.postDelayed(tick[0], 1000L);
        };
        handler.postDelayed(tick[0], 1000L);
    }

    private void showDurationPicker(String packageName) {
        String[] labels = { "15 minutes", "30 minutes", "1 hour", "2 hours" };
        int[] seconds = { 900, 1800, 3600, 7200 };

        final LinearLayout[] holder = { null };
        holder[0] = makeDurationLayout("How long?", labels, seconds,
                (durationSeconds) -> {
                    // grantOverride -> dismissOverlay removes this picker (pinDialogView)
                    // and the block overlay together, so the app is revealed without a
                    // flash. Removing the picker here first would expose the block for a
                    // frame.
                    grantOverride(packageName, durationSeconds);
                },
                // Cancel just removes this picker; the block overlay is still
                // attached underneath (the PIN flow never dismissed it), so the
                // child lands back on the block screen.
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
     * Verifies the entered PIN against BLAKE2b hex hashes stored by bare-dispatch.js pin:set.
     * Checks all parent PIN hashes in the pinHashes map (per-parent PINs).
     * Falls back to legacy single pinHash field for migration support.
     */
    private boolean verifyPin(String enteredPin) {
        JSONObject policy = loadPolicy();
        if (policy == null) return false;

        try {
            byte[] passwordBytes = enteredPin.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            final int HASH_BYTES = 32; // crypto_generichash_BYTES
            byte[] computedHash = new byte[HASH_BYTES];
            lazySodium.getSodium().crypto_generichash(
                    computedHash, HASH_BYTES, passwordBytes, passwordBytes.length, null, 0);

            // Check per-parent pinHashes map
            JSONObject pinHashes = policy.optJSONObject("pinHashes");
            if (pinHashes != null && pinHashes.length() > 0) {
                java.util.Iterator<String> keys = pinHashes.keys();
                while (keys.hasNext()) {
                    String parentKey = keys.next();
                    String hashHex = pinHashes.optString(parentKey, null);
                    if (hashHex != null && !hashHex.isEmpty()) {
                        byte[] storedHash = hexToBytes(hashHex);
                        if (Arrays.equals(computedHash, storedHash)) return true;
                    }
                }
                return false;
            }

            // Fallback: legacy single pinHash field (migration support)
            String pinHash = policy.optString("pinHash", null);
            if (pinHash == null || pinHash.isEmpty()) return false;
            byte[] storedHash = hexToBytes(pinHash);
            return Arrays.equals(computedHash, storedHash);
        } catch (Exception e) {
            return false;
        }
    }

    /** Milliseconds to wait after `fails` consecutive wrong PINs; 0 while attempts remain. */
    private static long lockoutDelayForFailCount(int fails) {
        if (fails <= PIN_FREE_ATTEMPTS) return 0L;
        int idx = fails - PIN_FREE_ATTEMPTS - 1;
        if (idx >= PIN_LOCKOUT_LADDER_MS.length) idx = PIN_LOCKOUT_LADDER_MS.length - 1;
        return PIN_LOCKOUT_LADDER_MS[idx];
    }

    /** Remaining lockout in ms, or 0 if the keypad is currently usable. */
    private long pinLockRemainingMs() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long until = prefs.getLong(PIN_LOCKED_UNTIL_KEY, 0L);
        if (until <= 0L) return 0L;
        long lockedAt = prefs.getLong(PIN_LOCKED_AT_KEY, 0L);
        long now = System.currentTimeMillis();
        // Clock rolled back to before the lock was applied: serve the full remaining
        // duration rather than letting a backwards jump look like an expired lock.
        if (now < lockedAt) return until - lockedAt;
        if (now >= until) return 0L;
        return until - now;
    }

    /** Records a wrong PIN. Returns the lockout in ms now owed, or 0 if attempts remain. */
    private long recordPinFailure() {
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        int fails = prefs.getInt(PIN_FAIL_COUNT_KEY, 0) + 1;
        long delay = lockoutDelayForFailCount(fails);
        SharedPreferences.Editor editor = prefs.edit().putInt(PIN_FAIL_COUNT_KEY, fails);
        if (delay > 0L) {
            long now = System.currentTimeMillis();
            editor.putLong(PIN_LOCKED_AT_KEY, now).putLong(PIN_LOCKED_UNTIL_KEY, now + delay);
        }
        editor.apply();
        return delay;
    }

    /** Attempts remaining before the next lockout. Only meaningful while under the free limit. */
    private int pinAttemptsRemaining() {
        int fails = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getInt(PIN_FAIL_COUNT_KEY, 0);
        return Math.max(0, PIN_FREE_ATTEMPTS - fails);
    }

    /**
     * Emits an onPinFailure RN event so the worklet can relay a "child is guessing
     * the PIN" alert to the parent. Best-effort, mirroring grantOverride's
     * onPinSuccess: only delivered when the RN bridge is alive.
     */
    private void notifyParentPinFailure(String packageName, long lockoutMs) {
        ReactContext rc = PearGuardReactHost.get();
        if (rc == null || !rc.hasActiveReactInstance()) return;
        int failCount = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).getInt(PIN_FAIL_COUNT_KEY, 0);
        WritableMap evt = Arguments.createMap();
        evt.putString("packageName", packageName);
        evt.putDouble("timestamp", System.currentTimeMillis());
        evt.putInt("failCount", failCount);
        evt.putDouble("lockoutMs", (double) lockoutMs);
        rc.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("onPinFailure", evt);
    }

    private void clearPinFailures() {
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                .remove(PIN_FAIL_COUNT_KEY)
                .remove(PIN_LOCKED_UNTIL_KEY)
                .remove(PIN_LOCKED_AT_KEY)
                .apply();
    }

    /** "1h 04m", "9m 30s" or "45s". */
    private static String formatLockRemaining(long ms) {
        long totalSeconds = (ms + 999L) / 1000L; // round up so we never display "0s"
        long hours = totalSeconds / 3600L;
        long minutes = (totalSeconds % 3600L) / 60L;
        long seconds = totalSeconds % 60L;
        if (hours > 0) return String.format(java.util.Locale.US, "%dh %02dm", hours, minutes);
        if (minutes > 0) return String.format(java.util.Locale.US, "%dm %02ds", minutes, seconds);
        return seconds + "s";
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