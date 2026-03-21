# Child Setup Wizard — Design Spec
**Date:** 2026-03-21
**TODO:** #6 (Accessibility Service setup) + #11 (Usage Stats permission)

---

## Overview

After a user selects "I'm a Child" during first-launch setup, a mandatory two-step wizard guides them through enabling the two permissions PearGuard requires:

1. **Accessibility Service** — required for app blocking/overlay
2. **Usage Stats (Usage Access)** — required for daily screen time limits

The wizard also re-appears automatically if either permission is found missing when the app is foregrounded.

---

## Screens

### `app/child-setup.tsx` (new)

A full-screen sequential wizard. No back button, no skip — both permissions are required before the main app is accessible.

**Route:** `/child-setup`
**Query param:** `step=1` (default) or `step=2`

**`app/_layout.tsx` change:** Register the new screen explicitly in the Stack navigator with `gestureEnabled: false` and `headerShown: false` to prevent back-swipe bypass:

```tsx
<Stack.Screen name="child-setup" options={{ headerShown: false, gestureEnabled: false }} />
```

**State:**
- `step: 1 | 2` — initialised from query param, defaults to 1
- `polling: boolean` — true while waiting for the current permission to be granted

**Regression guard on mount:** When `child-setup.tsx` mounts with `step=2` (re-appear jump), it must call `checkChildPermissions()` immediately and revert to `step=1` if `accessibility` is missing. Step 1's permission must always be satisfied before step 2 is shown.

**Layout (both steps share the same template):**
- Large icon (step 1: accessibility icon, step 2: usage stats icon — use a styled `View` placeholder component, not emoji, for consistent rendering across Android versions; PNG assets may be substituted later)
- Title and description explaining why the permission is needed
- Numbered instructions (4 steps: tap button → find PearGuard → toggle ON → return)
- "Open [Settings Screen] →" button that deep-links to the relevant Android settings
- "Waiting…" status line below the button while polling

**Step 1 — Accessibility Service:**
- Button deep-links to `android.settings.ACCESSIBILITY_SETTINGS`
- Polls `checkChildPermissions().accessibility` every 1.5 s
- On detection: clears poll, runs regression guard for step 2, advances to step 2

**Step 2 — Usage Access:**
- Button deep-links to `android.settings.USAGE_ACCESS_SETTINGS`
- Polls `checkChildPermissions().usageStats` every 1.5 s
- On detection: clears poll, calls `router.replace('/')`

**Polling implementation:** `useEffect` sets a 1.5 s interval and stores the interval ID. The cleanup function clears the interval by ID (`clearInterval(timerId)`) to prevent bridge calls after unmount. Calls `NativeModules.UsageStatsModule?.checkChildPermissions()` on each tick; if the call rejects, log a warning and do not advance.

---

## Native Changes

### `UsageStatsModule.java` — new method

```java
@ReactMethod
public void checkChildPermissions(Promise promise)
```

Returns a `WritableMap` with two boolean fields:
- `accessibility` — whether `AppBlockerModule` is in the enabled accessibility services list. Implement using the same logic as `EnforcementService.isAccessibilityServiceEnabled()`, inline within `UsageStatsModule` using `reactContext` (available via `ReactContextBaseJavaModule`) as the `Context` argument. Do not use a static utility — `getContentResolver()` requires a `Context` instance, available from `reactContext`.
- `usageStats` — whether the app has been granted usage access. Reuse the existing private helper logic from `hasUsagePermission()` (already in `UsageStatsModule` at line ~60) rather than duplicating the `AppOpsManager.checkOpNoThrow` call. Extract it to a private `hasUsageStatsPermission()` instance method that both `hasUsagePermission()` and `checkChildPermissions()` call.

---

## Navigation Wiring

### First-launch flow

`app/setup.tsx`: after `setMode('child')` resolves, navigate to `/child-setup` using `router.replace` (consistent with existing pattern) instead of `/`.

```
setup.tsx  →  replace /child-setup (step 1)  →  step 2  →  replace /
```

### Re-appear flow

`app/index.tsx` AppState `active` listener (already present for Hyperswarm reconnect) gains an additional check when `mode === 'child'` and `dbReady` is true:

1. Call `NativeModules.UsageStatsModule?.checkChildPermissions()`
2. If `!accessibility` → `router.replace('/child-setup?step=1')`
3. Else if `!usageStats` → `router.replace('/child-setup?step=2')`

Use `router.replace` (not `router.push`) to prevent multiple wizard instances accumulating on the back stack if the user backgrounds and foregrounds repeatedly before granting a permission.

**Responsibility boundary:** Once the wizard screen is active, `child-setup.tsx`'s own polling loop handles detecting permissions and advancing — including handling a foreground return from Android Settings mid-wizard. The `index.tsx` AppState check is only the re-entry gate from the main screen; it does not fire while `child-setup.tsx` is the active route (since `index.tsx` is not mounted at that point).

```
app foregrounded (main screen active)  →  checkChildPermissions()  →  replace /child-setup?step=N
child-setup.tsx polling loop  →  detects grant  →  advance or replace /
```

### `dbReady` guard

The re-appear check must only run after `dbReady` is true (mode is read from Hyperbee after the bare worklet initialises). Add a `dbReady` guard to the AppState handler to prevent calling `checkChildPermissions` before the mode is known.

---

## Error Handling

- If `checkChildPermissions()` rejects (native error), log a warning and do not advance or redirect — the user can retry by tapping the settings button and toggling the permission again.
- If the app is killed while the wizard is showing, on next launch the AppState check in `index.tsx` will re-trigger the wizard at the correct step.
- Brief black screen after `router.replace('/')` while `index.tsx` re-mounts and `dbReady` resolves is acceptable — the existing loading state in `index.tsx` already covers this.

---

## Out of Scope

- Guiding the user to grant `PACKAGE_USAGE_STATS` via ADB (enterprise scenario)
- Explaining what happens if permissions are denied at the OS level (not applicable on Android — these are manual toggles, not grant/deny dialogs)
- Any UI change to the parent device setup flow
