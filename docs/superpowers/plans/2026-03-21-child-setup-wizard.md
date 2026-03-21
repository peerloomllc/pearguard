# Child Setup Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a mandatory two-step wizard that guides child device users through enabling Accessibility Service and Usage Stats permission on first launch and whenever either permission is missing.

**Architecture:** A new `app/child-setup.tsx` screen polls `UsageStatsModule.checkChildPermissions()` (new native method) every 1.5 s and auto-advances through steps. `setup.tsx` routes to it after "I'm a Child" is selected. `index.tsx` re-triggers it on app foreground if permissions drop.

**Tech Stack:** React Native (Expo Router), Java (Android), `android.provider.Settings`, `AppOpsManager`, `TextUtils`

---

## File Map

| File | Change |
|------|--------|
| `android/app/src/main/java/com/pearguard/UsageStatsModule.java` | Add `checkChildPermissions()` ReactMethod + two private helpers |
| `app/_layout.tsx` | Register `child-setup` screen with `gestureEnabled: false` |
| `app/setup.tsx` | Route `selectMode('child')` to `/child-setup` instead of `/` |
| `app/child-setup.tsx` | **New file** — two-step permission wizard screen |
| `app/index.tsx` | Add `_mode` module-level var; extend AppState listener with re-appear check |

---

## Task 1: Native `checkChildPermissions` method

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/UsageStatsModule.java`

Note: This is a native Android method. Verification is by device test in Task 6, not a unit test.

- [ ] **Step 1: Add missing imports to `UsageStatsModule.java`**

  At the top of the imports block, add (if not already present):

  ```java
  import android.provider.Settings;
  import android.text.TextUtils;
  ```

- [ ] **Step 2: Extract `hasUsagePermission` logic into a private helper**

  Immediately before `hasUsagePermission`, add:

  ```java
  private boolean hasUsageStatsPermission() {
      AppOpsManager appOps = (AppOpsManager) reactContext.getSystemService(Context.APP_OPS_SERVICE);
      int mode = appOps.checkOpNoThrow(
          AppOpsManager.OPSTR_GET_USAGE_STATS,
          Process.myUid(),
          reactContext.getPackageName()
      );
      return mode == AppOpsManager.MODE_ALLOWED;
  }
  ```

  Update `hasUsagePermission` to call the helper:

  ```java
  @ReactMethod
  public void hasUsagePermission(Promise promise) {
      promise.resolve(hasUsageStatsPermission());
  }
  ```

- [ ] **Step 3: Add private accessibility helper**

  `AppBlockerModule` is in the same `com.pearguard` package as `UsageStatsModule`, so no import is needed — same-package classes are visible automatically in Java.

  Immediately after `hasUsageStatsPermission()`, add:

  ```java
  private boolean isAccessibilityEnabled() {
      String prefString;
      try {
          prefString = Settings.Secure.getString(
              reactContext.getContentResolver(),
              Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
          );
      } catch (Exception e) {
          return false;
      }
      if (TextUtils.isEmpty(prefString)) return false;
      // AppBlockerModule is in the same package; .class.getName() produces the FQCN
      String ourService = reactContext.getPackageName() + "/" + AppBlockerModule.class.getName();
      TextUtils.SimpleStringSplitter splitter = new TextUtils.SimpleStringSplitter(':');
      splitter.setString(prefString);
      while (splitter.hasNext()) {
          if (splitter.next().equalsIgnoreCase(ourService)) return true;
      }
      return false;
  }
  ```

- [ ] **Step 4: Add the `checkChildPermissions` ReactMethod**

  After `hasUsagePermission`, add:

  ```java
  /**
   * Returns whether both child-required permissions are granted.
   * Used by the child setup wizard to poll and auto-advance steps.
   */
  @ReactMethod
  public void checkChildPermissions(Promise promise) {
      WritableMap result = Arguments.createMap();
      result.putBoolean("accessibility", isAccessibilityEnabled());
      result.putBoolean("usageStats", hasUsageStatsPermission());
      promise.resolve(result);
  }
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add android/app/src/main/java/com/pearguard/UsageStatsModule.java
  git commit -m "feat: add checkChildPermissions native method to UsageStatsModule"
  ```

---

## Task 2: Register `child-setup` route in `_layout.tsx`

**Files:**
- Modify: `app/_layout.tsx`

- [ ] **Step 1: Add the `child-setup` Stack.Screen entry**

  Current file:
  ```tsx
  <Stack screenOptions={{ headerShown: false }}>
    <Stack.Screen name="index" />
    <Stack.Screen name="setup" />
    <Stack.Screen name="join" />
  </Stack>
  ```

  Updated file:
  ```tsx
  <Stack screenOptions={{ headerShown: false }}>
    <Stack.Screen name="index" />
    <Stack.Screen name="setup" />
    <Stack.Screen name="join" />
    <Stack.Screen name="child-setup" options={{ headerShown: false, gestureEnabled: false }} />
  </Stack>
  ```

  `gestureEnabled: false` prevents the user from swiping back to bypass the wizard.

- [ ] **Step 2: Commit**

  ```bash
  git add app/_layout.tsx
  git commit -m "feat: register child-setup route with back-gesture disabled"
  ```

---

## Task 3: Update `setup.tsx` navigation

**Files:**
- Modify: `app/setup.tsx`

- [ ] **Step 1: Change child mode navigation target**

  In `selectMode`, the current code navigates to `/` regardless of mode:
  ```tsx
  await _callBare('setMode', [mode])
  router.replace('/')
  ```

  Change it so child mode goes to the wizard:
  ```tsx
  await _callBare('setMode', [mode])
  router.replace(mode === 'child' ? '/child-setup' : '/')
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add app/setup.tsx
  git commit -m "feat: route child mode selection to setup wizard"
  ```

---

## Task 4: Create `app/child-setup.tsx`

**Files:**
- Create: `app/child-setup.tsx`

- [ ] **Step 1: Create the file**

  ```tsx
  // app/child-setup.tsx
  //
  // Mandatory two-step wizard shown to child device users on first launch
  // and whenever Accessibility Service or Usage Stats permission is missing.
  // No back button (gestureEnabled: false in _layout.tsx).

  import { useState, useEffect } from 'react'
  import { View, Text, TouchableOpacity, StyleSheet, Linking, NativeModules, ActivityIndicator } from 'react-native'
  import { useLocalSearchParams, useRouter } from 'expo-router'

  type Permissions = { accessibility: boolean; usageStats: boolean }

  // Styled placeholder icons — avoid emoji for cross-Android-version rendering consistency.
  function IconA() {
    return (
      <View style={styles.iconCircle}>
        <Text style={styles.iconLetter}>A</Text>
      </View>
    )
  }
  function IconU() {
    return (
      <View style={styles.iconCircle}>
        <Text style={styles.iconLetter}>U</Text>
      </View>
    )
  }

  const STEPS = {
    1: {
      Icon: IconA,
      title: 'Enable Accessibility Service',
      description:
        'PearGuard needs the Accessibility Service to detect and block restricted apps on this device.',
      instructions: [
        'Tap the button below',
        'Find PearGuard in the list',
        'Toggle it ON',
        'Return to this app',
      ],
      buttonLabel: 'Open Accessibility Settings',
      settingsAction: 'android.settings.ACCESSIBILITY_SETTINGS',
    },
    2: {
      Icon: IconU,
      title: 'Grant Usage Access',
      description:
        'PearGuard needs Usage Access to track daily app time and enforce screen time limits set by your parent.',
      instructions: [
        'Tap the button below',
        'Find PearGuard in the list',
        'Toggle it ON',
        'Return to this app',
      ],
      buttonLabel: 'Open Usage Access Settings',
      settingsAction: 'android.settings.USAGE_ACCESS_SETTINGS',
    },
  } as const

  export default function ChildSetupScreen() {
    const router = useRouter()
    const { step: stepParam } = useLocalSearchParams<{ step?: string }>()
    const [step, setStep] = useState<1 | 2>(stepParam === '2' ? 2 : 1)
    const [polling, setPolling] = useState(false)

    // Regression guard: whenever step reaches 2 (first-launch advancement or re-appear jump),
    // verify step 1 is still satisfied before showing step 2.
    useEffect(() => {
      if (step !== 2) return
      NativeModules.UsageStatsModule?.checkChildPermissions?.()
        .then((p: Permissions) => { if (!p.accessibility) setStep(1) })
        .catch(() => {})
    }, [step])

    // Polling loop: check current permission every 1.5 s and auto-advance.
    useEffect(() => {
      const timerId = setInterval(async () => {
        try {
          const p: Permissions = await NativeModules.UsageStatsModule?.checkChildPermissions?.()
          if (!p) return
          if (step === 1 && p.accessibility) {
            setPolling(false)
            setStep(2)
          } else if (step === 2 && p.usageStats) {
            router.replace('/')
          }
        } catch (e) {
          console.warn('[child-setup] checkChildPermissions error:', e)
        }
      }, 1500)
      return () => clearInterval(timerId)
    }, [step, router])

    function openSettings() {
      setPolling(true)
      Linking.sendIntent(STEPS[step].settingsAction).catch(() => {
        // sendIntent is Android-only; fallback for dev/test environments
        console.warn('[child-setup] sendIntent failed for:', STEPS[step].settingsAction)
      })
    }

    const config = STEPS[step]

    return (
      <View style={styles.container}>
        <Text style={styles.stepLabel}>Step {step} of 2</Text>

        <config.Icon />

        <Text style={styles.title}>{config.title}</Text>
        <Text style={styles.description}>{config.description}</Text>

        <View style={styles.instructions}>
          <Text style={styles.instructionsLabel}>HOW TO ENABLE</Text>
          {config.instructions.map((line, i) => (
            <Text key={i} style={styles.instructionLine}>
              {i + 1}. {line}
            </Text>
          ))}
        </View>

        <TouchableOpacity style={styles.button} onPress={openSettings} activeOpacity={0.8}>
          <Text style={styles.buttonText}>{config.buttonLabel} →</Text>
        </TouchableOpacity>

        {polling ? (
          <View style={styles.waitingRow}>
            <ActivityIndicator size="small" color="#555" />
            <Text style={styles.waitingText}>Waiting for permission…</Text>
          </View>
        ) : (
          <Text style={styles.waitingText}>Tap the button above to open Settings</Text>
        )}
      </View>
    )
  }

  const styles = StyleSheet.create({
    container:        { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 32 },
    stepLabel:        { color: '#555', fontSize: 13, marginBottom: 24, textTransform: 'uppercase', letterSpacing: 1 },
    iconCircle:       { width: 72, height: 72, borderRadius: 36, backgroundColor: '#1a2e1a', borderWidth: 2, borderColor: '#6FCF97', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
    iconLetter:       { color: '#6FCF97', fontSize: 28, fontWeight: '700' },
    title:            { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
    description:      { color: '#aaa', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
    instructions:     { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#333', borderRadius: 12, padding: 16, width: '100%', marginBottom: 32 },
    instructionsLabel:{ color: '#555', fontSize: 11, letterSpacing: 0.5, marginBottom: 10 },
    instructionLine:  { color: '#ccc', fontSize: 14, lineHeight: 26 },
    button:           { backgroundColor: '#1a2e1a', borderWidth: 1, borderColor: '#6FCF97', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, width: '100%', alignItems: 'center', marginBottom: 16 },
    buttonText:       { color: '#6FCF97', fontSize: 15, fontWeight: '600' },
    waitingRow:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
    waitingText:      { color: '#555', fontSize: 13 },
  })
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add app/child-setup.tsx
  git commit -m "feat: add child setup wizard screen (Accessibility + Usage Stats)"
  ```

---

## Task 5: Add re-appear check to `index.tsx`

**Files:**
- Modify: `app/index.tsx`

The AppState listener is registered inside a `useEffect([], [])` closure where React state variables like `dbReady` and mode are not directly accessible. Use module-level variables `_mode` and `_dbReady` (consistent with the existing `_worklet`, `_workletStarted` pattern) to track these values outside React state.

- [ ] **Step 1: Add `_mode` and `_dbReady` module-level variables**

  Near the top of the file, alongside the other module-level vars (`_worklet`, `_workletStarted`, etc.), add:

  ```tsx
  let _mode: string | null = null
  let _dbReady = false
  ```

- [ ] **Step 2: Set `_mode` and `_dbReady` in the `ready` event handler**

  Find the `onEvent('ready', (data) => { ... })` handler (around line 393). Add both assignments at the start:

  ```tsx
  onEvent('ready', (data) => {
    _mode = data.mode   // ← add this line
    _dbReady = true     // ← add this line
    setDbReady(true)
    // ... rest unchanged
  })
  ```

- [ ] **Step 3: Extend the AppState listener**

  Find the existing AppState listener in `nativeSubs` (around line 292):

  ```tsx
  AppState.addEventListener('change', (state) => {
    if (state === 'active') sendToWorklet({ method: 'swarm:reconnect' })
  }),
  ```

  Replace with:

  ```tsx
  AppState.addEventListener('change', (state) => {
    if (state !== 'active') return
    sendToWorklet({ method: 'swarm:reconnect' })
    // Re-appear check: only after DB is ready and mode is known
    if (_dbReady && _mode === 'child') {
      NativeModules.UsageStatsModule?.checkChildPermissions?.()
        .then((p: { accessibility: boolean; usageStats: boolean }) => {
          if (!p.accessibility) router.replace('/child-setup?step=1')
          else if (!p.usageStats) router.replace('/child-setup?step=2')
        })
        .catch(() => {})
    }
  }),
  ```

  Note: `router` is available via `useRouter()` in the component. The AppState listener is inside the `start()` function within `useEffect`, where `router` is in scope from the component's closure.

- [ ] **Step 4: Commit**

  ```bash
  git add app/index.tsx
  git commit -m "feat: re-trigger child setup wizard when permissions revoked on foreground"
  ```

---

## Task 6: Build, install, and verify on device

- [ ] **Step 1: Build**

  This is a UI-only change (no bare.js changes), but includes native Java changes:

  ```bash
  npm run build:ui
  cd android && ./gradlew assembleDebug && cd ..
  ```

  Expected: `BUILD SUCCESSFUL`

- [ ] **Step 2: Install on both devices**

  ```bash
  adb -s 53071FDAP00038 install -r /home/tim/peerloomllc/pearguard/android/app/build/outputs/apk/debug/app-debug.apk
  adb -s 4H65K7MFZXSCSWPR install -r /home/tim/peerloomllc/pearguard/android/app/build/outputs/apk/debug/app-debug.apk
  ```

- [ ] **Step 3: Verify first-launch flow on child device (TCL)**

  1. Clear app data: `adb -s 4H65K7MFZXSCSWPR shell pm clear com.peerloomllc.pearguard`
  2. Open the app — should see the mode selection screen
  3. Tap "I'm a Child"
  4. Should land on Step 1 (Accessibility Service) — NOT the main screen
  5. Tap "Open Accessibility Settings →" — Android Settings opens
  6. Enable PearGuard Accessibility Service
  7. Return to app — should auto-advance to Step 2 (Usage Access) within 1.5 s
  8. Tap "Open Usage Access Settings →" — Android Settings opens
  9. Grant PearGuard usage access
  10. Return to app — should auto-navigate to main child screen

- [ ] **Step 4: Verify re-appear flow**

  1. With the child fully set up, go to Android Settings → Accessibility → disable PearGuard
  2. Return to PearGuard
  3. Should immediately show Step 1 of the wizard (no main screen visible)
  4. Re-enable the service and return — should auto-advance to Step 2 (if usage stats still granted) or main screen

- [ ] **Step 5: Run tests and confirm no regressions**

  ```bash
  npx jest
  ```

  Expected: same 7 pre-existing failures, 208 passing.

- [ ] **Step 6: Final commit (if any fixups needed from verification)**

  ```bash
  git add -p
  git commit -m "fix: <describe any device-discovered issues>"
  ```
