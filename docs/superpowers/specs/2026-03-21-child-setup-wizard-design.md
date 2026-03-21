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

**State:**
- `step: 1 | 2` — initialised from query param, defaults to 1
- `polling: boolean` — true while waiting for the current permission to be granted

**Layout (both steps share the same template):**
- Large icon (♿ for step 1, 📊 for step 2)
- Title and description explaining why the permission is needed
- Numbered instructions (4 steps: tap button → find PearGuard → toggle ON → return)
- "Open [Settings Screen] →" button that deep-links to the relevant Android settings
- "Waiting…" status line below the button while polling

**Step 1 — Accessibility Service:**
- Button deep-links to `android.settings.ACCESSIBILITY_SETTINGS`
- Polls `checkChildPermissions().accessibility` every 1.5 s
- On detection: clears poll, advances to step 2

**Step 2 — Usage Access:**
- Button deep-links to `android.settings.USAGE_ACCESS_SETTINGS`
- Polls `checkChildPermissions().usageStats` every 1.5 s
- On detection: clears poll, calls `router.replace('/')`

**Polling implementation:** `useEffect` that sets a 1.5 s interval on mount and clears it on unmount. Calls `NativeModules.UsageStatsModule.checkChildPermissions()` on each tick.

---

## Native Changes

### `UsageStatsModule.java` — new method

```java
@ReactMethod
public void checkChildPermissions(Promise promise)
```

Returns a `WritableMap` with two boolean fields:
- `accessibility` — whether `AppBlockerModule` is in the enabled accessibility services list (reuses the logic from `EnforcementService.isAccessibilityServiceEnabled()`, extracted to a package-level helper or duplicated)
- `usageStats` — whether the app has been granted `OPSTR_GET_USAGE_STATS` via `AppOpsManager.checkOpNoThrow`

---

## Navigation Wiring

### First-launch flow

`app/setup.tsx`: after `setMode('child')` resolves, navigate to `/child-setup` instead of `/`.

```
setup.tsx  →  /child-setup (step 1)  →  /child-setup (step 2)  →  /
```

### Re-appear flow

`app/index.tsx` AppState `active` listener (already present for Hyperswarm reconnect) gains an additional check when `mode === 'child'`:

1. Call `UsageStatsModule.checkChildPermissions()`
2. If `!accessibility` → `router.push('/child-setup?step=1')`
3. Else if `!usageStats` → `router.push('/child-setup?step=2')`

This check only runs after `dbReady` is true (mode is available).

```
app foregrounded  →  checkChildPermissions()  →  push /child-setup?step=N  →  back to main on grant
```

On completion of the re-appear wizard, `router.replace('/')` navigates back to the main screen (same as first-launch).

---

## Error Handling

- If `checkChildPermissions()` rejects (native error), log a warning and do not advance — the user can retry by toggling the permission manually.
- If the app is killed while the wizard is showing, on next launch the AppState check will re-trigger the wizard at the correct step.

---

## Out of Scope

- Guiding the user to grant `PACKAGE_USAGE_STATS` via ADB (enterprise scenario)
- Explaining what happens if permissions are denied at the OS level (not applicable on Android — these are manual toggles, not grant/deny dialogs)
- Any UI change to the parent device setup flow
