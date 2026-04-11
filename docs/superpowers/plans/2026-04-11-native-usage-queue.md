# Native Usage Queue with WorkManager Wake-Up - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure child usage stats are never lost when PearGuard is dismissed from the app switcher, by queuing reports natively and using WorkManager to periodically wake the app and flush them.

**Architecture:** EnforcementService collects usage stats natively when the RN bridge is dead and queues them in SharedPreferences. A WorkManager periodic task (every 15 min) launches a transparent Activity to restart the RN lifecycle, which flushes queued reports to the bare worklet for P2P delivery to the parent.

**Tech Stack:** Java (Android native), WorkManager (androidx.work), SharedPreferences, React Native bridge, existing bare worklet IPC

---

### Task 1: Add WorkManager Dependency

**Files:**
- Modify: `android/app/build.gradle:155-161`

- [ ] **Step 1: Add androidx.work:work-runtime to dependencies**

In `android/app/build.gradle`, add the WorkManager dependency after the lazysodium/jna lines:

```gradle
implementation 'com.goterl:lazysodium-android:5.1.0@aar'
implementation 'net.java.dev.jna:jna:5.14.0@aar'

implementation 'androidx.work:work-runtime:2.9.1'
```

- [ ] **Step 2: Verify it compiles**

Run: `cd android && ./gradlew assembleDebug 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Commit**

```bash
git add android/app/build.gradle
git commit -m "chore(#131): add WorkManager dependency for background usage queue"
```

---

### Task 2: Create UsageQueueHelper

**Files:**
- Create: `android/app/src/main/java/com/pearguard/UsageQueueHelper.java`

- [ ] **Step 1: Create UsageQueueHelper.java**

This is a thread-safe SharedPreferences-backed queue with a 96-entry cap. All access is synchronized since both EnforcementService (main looper) and WorkManager (background thread) may read/write concurrently.

```java
package com.pearguard;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Thread-safe SharedPreferences-backed queue for usage reports.
 * Used when the RN bridge is dead and EnforcementService needs to
 * store usage snapshots for later delivery.
 */
public class UsageQueueHelper {

    private static final String PREFS_NAME = "PearGuardPrefs";
    private static final String QUEUE_KEY = "usage_queue";
    private static final int MAX_ENTRIES = 96;
    private static final Object LOCK = new Object();

    /**
     * Enqueue a usage snapshot. Each entry is:
     * { "timestamp": long, "usage": [ { packageName, appName, secondsToday } ] }
     */
    public static void enqueue(Context context, JSONArray usage) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray queue;
            try {
                String raw = prefs.getString(QUEUE_KEY, "[]");
                queue = new JSONArray(raw);
            } catch (JSONException e) {
                queue = new JSONArray();
            }

            try {
                JSONObject entry = new JSONObject();
                entry.put("timestamp", System.currentTimeMillis());
                entry.put("usage", usage);
                queue.put(entry);

                // Drop oldest entries if over cap
                while (queue.length() > MAX_ENTRIES) {
                    queue.remove(0);
                }
            } catch (JSONException e) {
                return; // Don't corrupt the queue
            }

            prefs.edit().putString(QUEUE_KEY, queue.toString()).apply();
        }
    }

    /**
     * Read all queued reports without removing them.
     * Returns a JSON array string of report objects.
     */
    public static String dequeue(Context context) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            return prefs.getString(QUEUE_KEY, "[]");
        }
    }

    /**
     * Clear the queue after successful flush.
     */
    public static void clear(Context context) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(QUEUE_KEY, "[]").apply();
        }
    }

    /**
     * Check if there are any queued reports.
     */
    public static boolean hasQueued(Context context) {
        synchronized (LOCK) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String raw = prefs.getString(QUEUE_KEY, "[]");
            try {
                return new JSONArray(raw).length() > 0;
            } catch (JSONException e) {
                return false;
            }
        }
    }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd android && ./gradlew assembleDebug 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/pearguard/UsageQueueHelper.java
git commit -m "feat(#131): add UsageQueueHelper for SharedPreferences-backed report queue"
```

---

### Task 3: Extract Native Usage Collection Helper

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/UsageStatsModule.java:226-335`

The daily usage collection logic in `getDailyUsageAllEvents()` currently lives inside a `@ReactMethod` that returns via a Promise. Extract the core logic into a static helper that returns a `JSONArray`, callable from both `getDailyUsageAllEvents()` (which wraps it in RN WritableArray) and `EnforcementService` (which passes it to `UsageQueueHelper`).

- [ ] **Step 1: Add the static helper method**

Add this method to `UsageStatsModule.java` before the existing `getDailyUsageAllEvents()` method (before line 226):

```java
/**
 * Collect daily per-app usage as a JSONArray.
 * Callable from EnforcementService without needing the RN bridge.
 * Returns: [ { "packageName": "...", "appName": "...", "secondsToday": N }, ... ]
 */
public static JSONArray collectDailyUsageNative(Context context) {
    JSONArray result = new JSONArray();
    try {
        UsageStatsManager usm = (UsageStatsManager)
                context.getSystemService(Context.USAGE_STATS_SERVICE);
        android.content.pm.PackageManager pm = context.getPackageManager();

        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long startOfDay = cal.getTimeInMillis();
        long now = System.currentTimeMillis();

        // Build launcher-visible set
        java.util.Set<String> launcherPackages = new java.util.HashSet<>();
        Intent launcherIntent = new Intent(Intent.ACTION_MAIN, null);
        launcherIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        java.util.List<android.content.pm.ResolveInfo> resolveInfos =
                pm.queryIntentActivities(launcherIntent, 0);
        if (resolveInfos != null) {
            for (android.content.pm.ResolveInfo ri : resolveInfos) {
                launcherPackages.add(ri.activityInfo.packageName);
            }
        }

        final long MERGE_GAP_MS = 3000;
        java.util.Map<String, Long> totalMs = new java.util.HashMap<>();
        java.util.Map<String, Long> sessionStarts = new java.util.HashMap<>();
        java.util.Map<String, Long> recentPauses = new java.util.HashMap<>();

        UsageEvents events = usm.queryEvents(startOfDay, now);
        if (events != null) {
            UsageEvents.Event event = new UsageEvents.Event();
            while (events.hasNextEvent()) {
                events.getNextEvent(event);
                String pkg = event.getPackageName();
                int type = event.getEventType();
                if (type == UsageEvents.Event.MOVE_TO_FOREGROUND || type == UsageEvents.Event.ACTIVITY_RESUMED) {
                    Long pausedAt = recentPauses.remove(pkg);
                    if (pausedAt != null && (event.getTimeStamp() - pausedAt) <= MERGE_GAP_MS) {
                        // Short gap - merge
                    } else {
                        if (pausedAt != null) {
                            Long start = sessionStarts.remove(pkg);
                            if (start != null) {
                                long prev = totalMs.containsKey(pkg) ? totalMs.get(pkg) : 0;
                                totalMs.put(pkg, prev + (pausedAt - start));
                            }
                        }
                        sessionStarts.put(pkg, event.getTimeStamp());
                    }
                } else if (type == UsageEvents.Event.MOVE_TO_BACKGROUND || type == UsageEvents.Event.ACTIVITY_PAUSED) {
                    if (sessionStarts.containsKey(pkg)) {
                        recentPauses.put(pkg, event.getTimeStamp());
                    }
                }
            }
        }

        // Flush remaining pauses
        for (java.util.Map.Entry<String, Long> entry : recentPauses.entrySet()) {
            String pkg = entry.getKey();
            Long start = sessionStarts.remove(pkg);
            if (start != null) {
                long prev = totalMs.containsKey(pkg) ? totalMs.get(pkg) : 0;
                totalMs.put(pkg, prev + (entry.getValue() - start));
            }
        }

        // Add elapsed time for apps still in foreground
        for (java.util.Map.Entry<String, Long> entry : sessionStarts.entrySet()) {
            String pkg = entry.getKey();
            long prev = totalMs.containsKey(pkg) ? totalMs.get(pkg) : 0;
            totalMs.put(pkg, prev + (now - entry.getValue()));
        }

        String ownPackage = context.getPackageName();
        for (java.util.Map.Entry<String, Long> entry : totalMs.entrySet()) {
            long ms = entry.getValue();
            if (ms <= 0) continue;
            if (!launcherPackages.contains(entry.getKey())) continue;
            if (entry.getKey().equals(ownPackage)) continue;

            String label = entry.getKey();
            try {
                android.content.pm.ApplicationInfo info = pm.getApplicationInfo(entry.getKey(), 0);
                label = pm.getApplicationLabel(info).toString();
            } catch (android.content.pm.PackageManager.NameNotFoundException ignored) {}

            try {
                JSONObject item = new JSONObject();
                item.put("packageName", entry.getKey());
                item.put("appName", label);
                item.put("secondsToday", (int)(ms / 1000));
                result.put(item);
            } catch (JSONException ignored) {}
        }
    } catch (Exception ignored) {}
    return result;
}
```

- [ ] **Step 2: Add JSONArray and JSONObject imports to UsageStatsModule**

Add at the top of UsageStatsModule.java with the other imports:

```java
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
```

- [ ] **Step 3: Add getQueuedReports and clearQueuedReports React methods**

Add these two methods to `UsageStatsModule.java` after the `collectDailyUsageNative` method:

```java
@ReactMethod
public void getQueuedReports(Promise promise) {
    try {
        String json = UsageQueueHelper.dequeue(reactContext);
        promise.resolve(json);
    } catch (Exception e) {
        promise.resolve("[]");
    }
}

@ReactMethod
public void clearQueuedReports(Promise promise) {
    try {
        UsageQueueHelper.clear(reactContext);
        promise.resolve(true);
    } catch (Exception e) {
        promise.resolve(false);
    }
}
```

- [ ] **Step 4: Verify it compiles**

Run: `cd android && ./gradlew assembleDebug 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/pearguard/UsageStatsModule.java
git commit -m "feat(#131): extract native usage collection helper and add queue methods"
```

---

### Task 4: Update EnforcementService to Queue When Bridge is Dead

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/EnforcementService.java:0-18` (imports)
- Modify: `android/app/src/main/java/com/pearguard/EnforcementService.java:142-159` (maybeFlushUsageStats)

- [ ] **Step 1: Add imports to EnforcementService**

Add these imports at the top of `EnforcementService.java` with the existing imports (after line 17):

```java
import org.json.JSONArray;
```

- [ ] **Step 2: Update maybeFlushUsageStats to collect and queue natively**

Replace the `maybeFlushUsageStats()` method (lines 142-159) with:

```java
/**
 * Every 60 seconds: if RN bridge is active, emit onUsageFlush so the
 * bare worklet can send a full usage report to parents.
 * If bridge is dead, collect stats natively and queue for later delivery.
 */
private void maybeFlushUsageStats() {
    long now = System.currentTimeMillis();
    if (now - lastUsageFlushTime < USAGE_FLUSH_INTERVAL_MS) return;
    lastUsageFlushTime = now;

    ReactContext reactContext = PearGuardReactHost.get();
    if (reactContext != null && reactContext.hasActiveReactInstance()) {
        WritableMap params = Arguments.createMap();
        params.putDouble("timestamp", now);
        reactContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
            .emit("onUsageFlush", params);
    } else {
        // RN bridge is dead — collect usage natively and queue
        JSONArray usage = UsageStatsModule.collectDailyUsageNative(this);
        if (usage.length() > 0) {
            UsageQueueHelper.enqueue(this, usage);
        }
    }
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd android && ./gradlew assembleDebug 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 4: Commit**

```bash
git add android/app/src/main/java/com/pearguard/EnforcementService.java
git commit -m "feat(#131): queue usage stats natively when RN bridge is dead"
```

---

### Task 5: Create UsageFlushActivity (Transparent Wake-Up)

**Files:**
- Create: `android/app/src/main/java/com/pearguard/UsageFlushActivity.java`
- Modify: `android/app/src/main/res/values/styles.xml`
- Modify: `android/app/src/main/AndroidManifest.xml:83`

- [ ] **Step 1: Add transparent theme to styles.xml**

Add this style to `android/app/src/main/res/values/styles.xml` before the closing `</resources>` tag:

```xml
  <style name="Theme.Transparent" parent="Theme.AppCompat.DayNight.NoActionBar">
    <item name="android:windowIsTranslucent">true</item>
    <item name="android:windowBackground">@android:color/transparent</item>
    <item name="android:windowNoTitle">true</item>
    <item name="android:backgroundDimEnabled">false</item>
  </style>
```

- [ ] **Step 2: Create UsageFlushActivity.java**

```java
package com.pearguard;

import android.app.Activity;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;

/**
 * Invisible Activity launched by UsageFlushWorker to restart the
 * React Native lifecycle when the app has been dismissed.
 *
 * Starting this Activity causes Android to create the Application
 * instance (which initializes RN), giving index.tsx a chance to
 * flush queued usage reports to the bare worklet.
 *
 * Finishes itself after 30 seconds — enough time for:
 *   - RN bridge init (~2-3s)
 *   - Bare worklet start + Hyperswarm connect (~5-10s)
 *   - Queue flush + P2P delivery (~5-10s)
 */
public class UsageFlushActivity extends Activity {

    private static final long FINISH_DELAY_MS = 30_000;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // No setContentView — fully transparent, invisible to user

        new Handler(Looper.getMainLooper()).postDelayed(this::finish, FINISH_DELAY_MS);
    }
}
```

- [ ] **Step 3: Declare UsageFlushActivity in AndroidManifest.xml**

Add after the closing `</activity>` tag of the main activity (after line 83):

```xml
    <!-- Transparent wake-up Activity for WorkManager usage flush -->
    <activity
        android:name=".UsageFlushActivity"
        android:enabled="true"
        android:exported="false"
        android:excludeFromRecents="true"
        android:taskAffinity=""
        android:theme="@style/Theme.Transparent" />
```

- [ ] **Step 4: Verify it compiles**

Run: `cd android && ./gradlew assembleDebug 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/pearguard/UsageFlushActivity.java \
        android/app/src/main/res/values/styles.xml \
        android/app/src/main/AndroidManifest.xml
git commit -m "feat(#131): add transparent UsageFlushActivity for WorkManager wake-up"
```

---

### Task 6: Create UsageFlushWorker and Register in EnforcementService

**Files:**
- Create: `android/app/src/main/java/com/pearguard/UsageFlushWorker.java`
- Modify: `android/app/src/main/java/com/pearguard/EnforcementService.java:51-58` (onCreate)

- [ ] **Step 1: Create UsageFlushWorker.java**

```java
package com.pearguard;

import android.content.Context;
import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import com.facebook.react.bridge.ReactContext;

/**
 * WorkManager Worker that runs every 15 minutes.
 * If the RN bridge is alive, emits onUsageFlush directly.
 * If the RN bridge is dead, launches UsageFlushActivity to restart
 * the RN lifecycle so queued reports can be flushed.
 */
public class UsageFlushWorker extends Worker {

    public UsageFlushWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        // Only act if there are queued reports to flush
        if (!UsageQueueHelper.hasQueued(getApplicationContext())) {
            return Result.success();
        }

        ReactContext reactContext = PearGuardReactHost.get();
        if (reactContext != null && reactContext.hasActiveReactInstance()) {
            // Bridge is alive — emit flush event directly
            com.facebook.react.bridge.WritableMap params =
                    com.facebook.react.bridge.Arguments.createMap();
            params.putDouble("timestamp", System.currentTimeMillis());
            reactContext
                .getJSModule(com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter.class)
                .emit("onUsageFlush", params);
        } else {
            // Bridge is dead — launch transparent Activity to restart RN
            Intent intent = new Intent(getApplicationContext(), UsageFlushActivity.class);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getApplicationContext().startActivity(intent);
        }

        return Result.success();
    }
}
```

- [ ] **Step 2: Add WorkManager imports to EnforcementService**

Add these imports at the top of `EnforcementService.java`:

```java
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.util.concurrent.TimeUnit;
```

- [ ] **Step 3: Register the periodic WorkManager task in onCreate**

In `EnforcementService.java`, add the WorkManager registration at the end of `onCreate()`, after `handler.post(enforcementLoop);` (after line 57):

```java
        // Schedule periodic WorkManager task to wake app and flush queued usage reports
        PeriodicWorkRequest flushWork = new PeriodicWorkRequest.Builder(
                UsageFlushWorker.class, 15, TimeUnit.MINUTES)
                .build();
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
                "usage_flush",
                ExistingPeriodicWorkPolicy.KEEP,
                flushWork);
```

- [ ] **Step 4: Verify it compiles**

Run: `cd android && ./gradlew assembleDebug 2>&1 | tail -5`
Expected: `BUILD SUCCESSFUL`

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/pearguard/UsageFlushWorker.java \
        android/app/src/main/java/com/pearguard/EnforcementService.java
git commit -m "feat(#131): add UsageFlushWorker and register periodic task in EnforcementService"
```

---

### Task 7: Flush Queued Reports on RN Bridge Startup

**Files:**
- Modify: `app/index.tsx:826-847` (child mode startup in `onEvent('ready')` handler)

- [ ] **Step 1: Add queue flush after child permission checks**

In `app/index.tsx`, inside the `onEvent('ready')` handler's `if (data.mode === 'child')` block, add the queue flush after the bypass detection logic. After the `.catch(() => {})` on line 846, add:

```typescript
          // Flush any usage reports queued while the RN bridge was dead
          NativeModules.UsageStatsModule?.getQueuedReports?.()
            .then((json: string) => {
              const reports = JSON.parse(json || '[]')
              if (reports.length === 0) return
              console.log('[PearGuard] Flushing', reports.length, 'queued usage reports')
              for (const report of reports) {
                sendToWorklet({ method: 'usage:flush', args: { usage: report.usage, queued: true } })
              }
              NativeModules.UsageStatsModule?.clearQueuedReports?.()
            })
            .catch((e: unknown) => console.warn('[PearGuard] Queue flush failed:', e))
```

- [ ] **Step 2: Build and install on both Android devices**

```bash
npm run build:ui
cd android && ./gradlew assembleDebug && cd ..
adb -s 53071FDAP00038 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 4H65K7MFZXSCSWPR install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 3: Commit**

```bash
git add app/index.tsx
git commit -m "feat(#131): flush queued usage reports on child startup"
```

---

### Task 8: Build and Install on iOS

**Files:**
- No code changes - iOS parent-only doesn't have EnforcementService, but needs the updated UI bundle

- [ ] **Step 1: Build bare bundles for iOS (bare-dispatch.js hasn't changed but build:ui needs fresh bundle)**

```bash
npm run build:bare:ios
npm run build:bare:ios-sim
```

- [ ] **Step 2: Sync, build, and install on iPhone**

```bash
rsync -az --checksum --exclude='.git' --exclude='node_modules' --exclude='android' \
  /home/tim/peerloomllc/pearguard/ \
  Tims-Mac-mini.local:~/peerloomllc/pearguard/

ssh Tims-Mac-mini.local 'export PATH="/opt/homebrew/bin:$PATH" && export LANG=en_US.UTF-8 && \
  security unlock-keychain -p "" ~/Library/Keychains/buildkey.keychain && \
  cd ~/peerloomllc/pearguard && \
  xcodebuild -workspace ios/PearGuard.xcworkspace -scheme PearGuard -configuration Release \
    -destination "generic/platform=iOS" DEVELOPMENT_TEAM=G79ALD29NA \
    OTHER_CODE_SIGN_FLAGS="--keychain ~/Library/Keychains/buildkey.keychain" clean build 2>&1 | tail -3 && \
  rm -rf /tmp/Payload && mkdir -p /tmp/Payload && \
  cp -r "$(ls -d ~/Library/Developer/Xcode/DerivedData/PearGuard-*/Build/Products/Release-iphoneos/PearGuard.app | head -1)" /tmp/Payload/ && \
  cd /tmp && ditto -c -k --sequesterRsrc --keepParent Payload PearGuard-release.ipa && rm -rf Payload && echo "IPA ready"'

rsync -az Tims-Mac-mini.local:/tmp/PearGuard-release.ipa /tmp/
ideviceinstaller install /tmp/PearGuard-release.ipa
```

---

### Task 9: On-Device Testing

This task requires manual testing on physical devices. Do not mark complete until the user confirms.

- [ ] **Step 1: Verify normal flush still works**

On the child device (TCL, serial `4H65K7MFZXSCSWPR`):
1. Open PearGuard
2. Use other apps for a few minutes
3. Check the parent device - usage stats should appear within 1 minute (normal real-time flow)

- [ ] **Step 2: Test dismissed app queue + manual reopen**

1. On the child device, dismiss PearGuard from the app switcher (swipe away)
2. Use other apps for 5+ minutes
3. Check parent device - usage stats should stop updating (expected)
4. Reopen PearGuard on child device
5. Check parent device - a burst of queued stats should arrive within 30 seconds
6. Check adb logs for `[PearGuard] Flushing N queued usage reports`

```bash
adb -s 4H65K7MFZXSCSWPR logcat -s ReactNativeJS:* | grep -i "queue\|flush"
```

- [ ] **Step 3: Test WorkManager wake-up**

1. Dismiss PearGuard on child device
2. Wait ~15 minutes for WorkManager to fire
3. Check parent device - queued stats should arrive
4. Check adb logs for WorkManager execution:

```bash
adb -s 4H65K7MFZXSCSWPR logcat -s WM-WorkerWrapper:* | grep -i "usage_flush"
```

- [ ] **Step 4: Verify UsageFlushActivity is invisible**

While waiting for WorkManager in step 3, watch the child device screen. The transparent Activity should not be visible - no flash, no app switcher entry.
