# Block Overlay UI Redesign - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Theme the native Android block overlay, PIN entry, and duration picker to match PearGuard's dark UI (Nunito font, Phosphor icons, themed colors/spacing).

**Architecture:** All changes in `AppBlockerModule.java` plus new font assets. Extract a `OverlayTheme` inner class for shared constants and a `PhosphorIcon` helper that draws SVG paths onto Bitmaps. Refactor three overlay methods to use themed layouts with grouped-card style.

**Tech Stack:** Android native (Java), WindowManager overlays, android.graphics.Path/Canvas for icon rendering, Nunito TTF font files.

**Spec:** `docs/superpowers/specs/2026-04-04-block-overlay-ui-design.md`

---

### Task 1: Add Nunito font assets

**Files:**
- Create: `android/app/src/main/assets/fonts/Nunito-Regular.ttf`
- Create: `android/app/src/main/assets/fonts/Nunito-SemiBold.ttf`

- [ ] **Step 1: Download Nunito font files**

```bash
mkdir -p android/app/src/main/assets/fonts
curl -L -o android/app/src/main/assets/fonts/Nunito-Regular.ttf \
  "https://github.com/googlefonts/nunito/raw/main/fonts/ttf/Nunito-Regular.ttf"
curl -L -o android/app/src/main/assets/fonts/Nunito-SemiBold.ttf \
  "https://github.com/googlefonts/nunito/raw/main/fonts/ttf/Nunito-SemiBold.ttf"
```

- [ ] **Step 2: Verify files downloaded**

```bash
ls -la android/app/src/main/assets/fonts/
```

Expected: Two TTF files, each ~100-200KB.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/assets/fonts/
git commit -m "chore: add Nunito font assets for native overlays"
```

---

### Task 2: Add OverlayTheme and PhosphorIcon helpers

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/AppBlockerModule.java`

Add two inner helper constructs to AppBlockerModule: `OverlayTheme` (shared color/dimension/typeface constants) and `PhosphorIcon` (draws Phosphor SVG paths onto Bitmaps using android.graphics.Path).

- [ ] **Step 1: Add graphics imports**

At the top of `AppBlockerModule.java`, after the existing imports (line 27, after `import android.widget.Toast;`), add:

```java
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.widget.ImageView;
```

- [ ] **Step 2: Add OverlayTheme inner class**

Inside AppBlockerModule, after the `PHONE_PACKAGES` static block (after line 63), add:

```java
    // --- Overlay Theme ---
    // Matches dark palette in src/ui/theme.js
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

        // Dimensions in dp — call dp() to convert at runtime
        static final int CARD_RADIUS   = 16;
        static final int KEY_RADIUS    = 12;
        static final int BTN_RADIUS    = 12;
        static final int ICON_CIRCLE   = 72;
        static final int ICON_CIRCLE_SM = 64;
    }

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
```

- [ ] **Step 3: Add PhosphorIcon helper**

Directly after the font helpers, add:

```java
    // --- Phosphor Icon Rendering ---
    // Draws Phosphor SVG path data (256x256 viewBox) onto a Bitmap at a given dp size and color.

    private static final String ICON_SHIELD = "M208,40H48A16,16,0,0,0,32,56v56c0,52.72,25.52,84.67,46.93,102.19,23.06,18.86,46,25.27,47,25.53a8,8,0,0,0,4.2,0c1-.26,23.91-6.67,47-25.53C198.48,196.67,224,164.72,224,112V56A16,16,0,0,0,208,40Zm0,72c0,37.07-13.66,67.16-40.6,89.42A129.3,129.3,0,0,1,128,223.62a128.25,128.25,0,0,1-38.92-21.81C61.82,179.51,48,149.3,48,112l0-56,160,0Z";
    private static final String ICON_CLOCK = "M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z";
    private static final String ICON_LOCK = "M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z";
    private static final String ICON_BACKSPACE = "M216,40H68.53a16.12,16.12,0,0,0-13.72,7.77L9.14,123.88a8,8,0,0,0,0,8.24l45.67,76.11A16.11,16.11,0,0,0,68.53,216H216a16,16,0,0,0,16-16V56A16,16,0,0,0,216,40Zm0,160H68.53l-43.2-72,43.2-72H216ZM106.34,146.34,124.69,128l-18.35-18.34a8,8,0,0,1,11.32-11.32L136,116.69l18.34-18.35a8,8,0,0,1,11.32,11.32L147.31,128l18.35,18.34a8,8,0,0,1-11.32,11.32L136,139.31l-18.34,18.35a8,8,0,0,1-11.32-11.32Z";
    private static final String ICON_CARET_RIGHT = "M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z";

    private Bitmap renderIcon(String svgPath, int sizeDp, int color) {
        int sizePx = dp(sizeDp);
        Bitmap bmp = Bitmap.createBitmap(sizePx, sizePx, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(bmp);

        Path path = android.util.PathParser.createPathFromPathData(svgPath);

        // Scale from 256x256 viewBox to target size
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

    /** Creates a circle with a tinted background containing an icon. */
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
```

- [ ] **Step 4: Add rounded-rect background helper**

After the icon helpers:

```java
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
```

- [ ] **Step 5: Build and verify compilation**

```bash
cd android && ./gradlew assembleDebug 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/pearguard/AppBlockerModule.java
git commit -m "feat: add OverlayTheme constants and PhosphorIcon helpers"
```

---

### Task 3: Refactor block overlay (showOverlay)

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/AppBlockerModule.java:543-648`

Replace the body of `showOverlay()` (lines 574-647, everything after `String appName = getAppName(packageName);` through end of method) with the themed grouped-card layout.

- [ ] **Step 1: Replace showOverlay layout code**

Replace the layout-building code inside `showOverlay()` (from `LinearLayout layout = new LinearLayout(this);` on line 574 through the end of the handler post block ending at line 648) with:

```java
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
        int requestColor = OT.PRIMARY;
        card.addView(makeActionRow(requestIcon, requestLabel, requestColor, true,
                () -> { vibrate(PATTERN_BUTTON); onSendRequest(packageName, blockCategory); }));

        // Divider
        View div1 = new View(this);
        div1.setBackgroundColor(OT.DIVIDER);
        div1.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(1)));
        card.addView(div1);

        // Row 2: Enter PIN
        card.addView(makeActionRow(ICON_LOCK, "Enter PIN", OT.TEXT_PRIMARY, false,
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
```

- [ ] **Step 2: Add makeActionRow helper**

Add this helper method after `showOverlay()`:

```java
    /** Creates a single row for the grouped action card. */
    private LinearLayout makeActionRow(String iconPath, String label, int textColor, boolean hasBottomPad, Runnable onClick) {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(16), dp(16), dp(16), dp(16));
        row.setClickable(true);
        row.setOnClickListener(v -> onClick.run());

        // Icon
        row.addView(iconView(iconPath, 20, textColor == OT.PRIMARY ? OT.PRIMARY : OT.TEXT_SECONDARY));

        // Spacer
        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(dp(12), 0));
        row.addView(spacer);

        // Label
        TextView tv = new TextView(this);
        tv.setText(label);
        tv.setTextColor(textColor);
        tv.setTextSize(15);
        tv.setTypeface(getNunitoSemiBold());
        tv.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        row.addView(tv);

        return row;
    }
```

- [ ] **Step 3: Build and verify**

```bash
cd android && ./gradlew assembleDebug 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 4: Install on child device and test block overlay**

```bash
adb -s 4H65K7MFZXSCSWPR install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Open a blocked app on the child device. Verify: icon circle with shield, Nunito font, grouped card with "Request Approval" and "Enter PIN" rows, correct colors.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/pearguard/AppBlockerModule.java
git commit -m "feat: themed block overlay with grouped-card layout"
```

---

### Task 4: Refactor PIN entry (onEnterPin)

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/AppBlockerModule.java:845-970`

Replace `onEnterPin()` body with themed PIN pad using icon circle, dot indicators, rounded keypad in a card, and ghost cancel button.

- [ ] **Step 1: Replace onEnterPin layout code**

Replace everything inside `onEnterPin()` from `final String[] enteredPin = { "" };` through the end of the method (before the closing `}`) with:

```java
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
        for (String[] row : rows) {
            LinearLayout rowLayout = new LinearLayout(this);
            rowLayout.setOrientation(LinearLayout.HORIZONTAL);
            rowLayout.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams rowParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            if (row != rows[0]) rowParams.setMargins(0, dp(8), 0, 0);
            rowLayout.setLayoutParams(rowParams);

            for (String digit : row) {
                if ("⌫".equals(digit)) {
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
                    // Empty placeholder
                    View empty = new View(this);
                    LinearLayout.LayoutParams emptyP = new LinearLayout.LayoutParams(0, dp(52), 1f);
                    emptyP.setMargins(dp(4), 0, dp(4), 0);
                    empty.setLayoutParams(emptyP);
                    rowLayout.addView(empty);
                } else {
                    // Digit button
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
```

- [ ] **Step 2: Build and verify**

```bash
cd android && ./gradlew assembleDebug 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Install and test PIN entry**

```bash
adb -s 4H65K7MFZXSCSWPR install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Open a blocked app, tap "Enter PIN". Verify: lock icon circle, dot indicators fill green, number pad in rounded card, backspace icon, ghost cancel button. Test wrong PIN (dots flash red, title shows error). Test correct PIN (transitions to duration picker).

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/pearguard/AppBlockerModule.java
git commit -m "feat: themed PIN entry overlay with dot indicators and rounded keypad"
```

---

### Task 5: Refactor duration pickers (showExtraTimePicker + showDurationPicker)

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/AppBlockerModule.java:753-843,972-1027`

Replace both duration picker methods with themed grouped-card layouts matching the approved mockup.

- [ ] **Step 1: Add makeDurationCard helper**

Add this helper after `makeActionRow()`:

```java
    /**
     * Builds a themed duration-picker overlay layout.
     * @param titleText  Title shown below the icon
     * @param labels     Duration labels (e.g. "15 minutes", "1 hour")
     * @param seconds    Corresponding seconds for each label
     * @param onSelect   Callback receiving the selected seconds value
     * @param showCancel Whether to show the Cancel button
     * @param onCancel   Called when Cancel is tapped (may be null if showCancel is false)
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
        icon.setLayoutParams(iconP);
        layout.addView(icon);

        // Title
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
            row.setOnClickListener(v -> {
                vibrate(PATTERN_BUTTON);
                onSelect.accept(secs);
            });

            TextView label = new TextView(this);
            label.setText(labels[i]);
            label.setTextColor(OT.TEXT_PRIMARY);
            label.setTextSize(16);
            label.setTypeface(getNunitoRegular(), Typeface.NORMAL);
            label.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            row.addView(label);

            row.addView(iconView(ICON_CARET_RIGHT, 16, OT.TEXT_MUTED));
            card.addView(row);

            // Divider (not after last item)
            if (i < labels.length - 1) {
                View div = new View(this);
                div.setBackgroundColor(OT.DIVIDER);
                div.setLayoutParams(new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, dp(1)));
                card.addView(div);
            }
        }
        layout.addView(card);

        // Cancel button (ghost)
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
```

- [ ] **Step 2: Replace showExtraTimePicker**

Replace the body of `showExtraTimePicker()` (lines 754-843) with:

```java
    private void showExtraTimePicker(String packageName) {
        int[] optionMinutes = getTimeRequestOptions();
        String[] labels = new String[optionMinutes.length];
        int[] seconds = new int[optionMinutes.length];
        for (int i = 0; i < optionMinutes.length; i++) {
            labels[i] = formatMinutes(optionMinutes[i]);
            seconds[i] = optionMinutes[i] * 60;
        }

        LinearLayout layout = makeDurationLayout("How much extra time?", labels, seconds,
                (durationSeconds) -> {
                    try { windowManager.removeView(layout); } catch (Exception ignored) {}
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
                true, // showCancel
                () -> {
                    try { windowManager.removeView(layout); } catch (Exception ignored) {}
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
        windowManager.addView(layout, wlp);
        pinDialogView = layout;
    }
```

Note: The `layout` variable reference in the lambda captures the local variable. Since `makeDurationLayout` returns it synchronously before the lambdas execute, this works. However, if the compiler complains about "variable might not have been initialized", wrap with a final array:

```java
        final LinearLayout[] holder = { null };
        holder[0] = makeDurationLayout(..., (durationSeconds) -> {
            try { windowManager.removeView(holder[0]); } ...
        }, true, () -> {
            try { windowManager.removeView(holder[0]); } ...
        });
        LinearLayout layout = holder[0];
```

- [ ] **Step 3: Replace showDurationPicker**

Replace the body of `showDurationPicker()` (lines 972-1027) with:

```java
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
                false, null); // no cancel button

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
```

- [ ] **Step 4: Build and verify**

```bash
cd android && ./gradlew assembleDebug 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 5: Install and test both pickers**

```bash
adb -s 4H65K7MFZXSCSWPR install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Test on child device:
1. Open blocked app with schedule/daily_limit block, tap "Request More Time" - verify themed duration picker with clock icon, grouped card, chevrons, cancel button
2. Open blocked app, tap "Enter PIN", enter correct PIN - verify post-PIN duration picker (no cancel, "How long?" title)
3. Verify cancel button works on time request picker

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/pearguard/AppBlockerModule.java
git commit -m "feat: themed duration picker overlays with grouped-card layout"
```

---

### Task 6: Final cleanup and install on both devices

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/AppBlockerModule.java` (remove unused Button import if no longer needed)

- [ ] **Step 1: Check for unused imports**

The old overlays used `android.widget.Button`. After refactoring, check if `Button` is still used anywhere in the file. If not, remove the import.

```bash
grep -n "Button" android/app/src/main/java/com/pearguard/AppBlockerModule.java | grep -v "//\|import"
```

If no non-import references to `Button` remain, remove `import android.widget.Button;`.

- [ ] **Step 2: Build final APK**

```bash
cd android && ./gradlew assembleDebug 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Install on both devices**

```bash
adb -s 53071FDAP00038 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 4H65K7MFZXSCSWPR install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 4: Commit if any cleanup was done**

```bash
git add android/app/src/main/java/com/pearguard/AppBlockerModule.java
git commit -m "chore: remove unused Button import after overlay refactor"
```
