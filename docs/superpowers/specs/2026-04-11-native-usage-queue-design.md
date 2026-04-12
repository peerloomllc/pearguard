# Native Usage Queue with WorkManager Wake-Up

**Bug:** #131 - Not consistently receiving usage stats from Child
**Date:** 2026-04-11

## Problem

When the child dismisses PearGuard from the app switcher, Android kills the React Native process. EnforcementService (foreground service) survives and keeps polling every 5 seconds, but `maybeFlushUsageStats()` checks `hasActiveReactInstance()` and silently retries forever when the RN bridge is dead. No usage reports reach the parent until the child manually reopens the app.

The "current app" indicator on the parent dashboard is inherently real-time and only works when the bare worklet is alive - this design does not attempt to solve that. The goal is to ensure usage stats (daily totals, weekly totals, sessions) are never lost and are delivered to the parent with minimal delay.

## Design

### Overview

Move usage stat collection into EnforcementService (native Java) so it runs regardless of RN bridge state. When the bridge is alive, flush immediately as today. When the bridge is dead, queue reports in SharedPreferences. Add a WorkManager periodic task (every 15 minutes) that wakes the app process and attempts to restart the RN bridge, flushing any queued reports.

### Components

#### 1. Native Usage Collection in EnforcementService

`EnforcementService.maybeFlushUsageStats()` currently only emits an event to RN. Change it to:

1. Collect usage stats directly using `UsageStatsManager` (same logic as `UsageStatsModule.getDailyUsageAllEvents()`, extracted into a shared static helper)
2. **If RN bridge is active:** emit `onUsageFlush` as today (RN gathers the full payload including weekly stats and sessions, sends to bare worklet)
3. **If RN bridge is dead:** serialize a lightweight usage snapshot to the queue

The native collection captures daily per-app usage (packageName, appName, secondsToday). Weekly stats and session-level data are omitted from queued reports since they require more complex queries that are already implemented in UsageStatsModule - the bare worklet handles their absence gracefully.

#### 2. SharedPreferences Queue

Storage key: `"usage_queue"` in `"PearGuardPrefs"`.

Format: JSON array of report objects, each containing:
```json
{
  "timestamp": 1744300000000,
  "usage": [
    { "packageName": "com.example", "appName": "Example", "secondsToday": 3600 }
  ]
}
```

Queue management:
- Max 96 entries (24 hours at 15-min intervals). Oldest entries are dropped when the cap is reached.
- Queue is cleared after successful flush to bare worklet.
- Thread safety: all queue reads/writes use `synchronized` on a shared lock object since both EnforcementService and WorkManager may access it.

#### 3. WorkManager Periodic Wake-Up

A `PeriodicWorkRequest` scheduled every 15 minutes (Android's minimum interval). The Worker:

1. Checks if the RN bridge is active via `PearGuardReactHost.get()?.hasActiveReactInstance()`
2. If not active, launches a transparent Activity (`UsageFlushActivity`) that starts the full RN lifecycle
3. The Activity finishes itself after a 30-second delay, giving the RN bridge and bare worklet time to initialize, connect to Hyperswarm, and flush queued reports
4. If the bridge is already active, emits `onUsageFlush` directly

The WorkManager task is registered once during `EnforcementService.onCreate()` using `enqueueUniquePeriodicWork` with `KEEP` policy (won't duplicate if already scheduled).

#### 4. Queue Flush on Bridge Reconnect

When the RN bridge becomes active (app foregrounded or WorkManager wake-up), the flush sequence:

1. `index.tsx` calls a new native method `UsageStatsModule.getQueuedReports()` on startup
2. If queued reports exist, send each to the bare worklet via `usage:flush` with a `queued: true` flag
3. After all queued reports are sent, call `UsageStatsModule.clearQueuedReports()`
4. Then proceed with the normal live flush

On the bare-dispatch side, `usage:flush` already handles the payload correctly. Queued reports will have `usage` but no `weekly`, `sessions`, or `foregroundPackage` - the handler already treats these as optional (`args.weekly || []`, `args.sessions || []`, `args.foregroundPackage || null`).

#### 5. UsageFlushActivity (Transparent Wake-Up)

Minimal transparent Activity used only by WorkManager to restart the RN lifecycle:

```
- Theme: Theme.Translucent.NoTitleBar
- launchMode: singleTask
- excludeFromRecents: true
- Finishes itself after 30-second delay
- No UI shown to user
```

The 30-second delay gives the RN bridge time to initialize (~2-3s), the bare worklet time to start and connect to Hyperswarm (~5-10s), and time to flush queued reports to the parent. If the worklet connects faster, the flush completes sooner but the Activity still waits the full 30 seconds to avoid cutting off in-flight P2P messages.

Declared in AndroidManifest.xml with `android:excludeFromRecents="true"` and `android:taskAffinity=""` so it doesn't appear in the app switcher.

### New Files

| File | Purpose |
|------|---------|
| `UsageQueueHelper.java` | Static methods: `enqueue(Context, JSONArray usage)`, `dequeue(Context) -> List<JSONObject>`, `clear(Context)`. SharedPreferences-backed queue with synchronized access and 96-entry cap. |
| `UsageFlushWorker.java` | WorkManager Worker. Checks bridge state, launches UsageFlushActivity if needed, or emits flush event directly. |
| `UsageFlushActivity.java` | Transparent Activity that starts RN lifecycle and finishes after 5s. |

### Modified Files

| File | Change |
|------|--------|
| `EnforcementService.java` | `maybeFlushUsageStats()`: collect stats natively when bridge is dead, enqueue via UsageQueueHelper. Register WorkManager periodic task in `onCreate()`. |
| `UsageStatsModule.java` | Extract daily usage collection into a static helper method callable from EnforcementService. Add `getQueuedReports()` and `clearQueuedReports()` React methods. |
| `android/app/build.gradle` | Add `androidx.work:work-runtime` dependency. |
| `AndroidManifest.xml` | Declare `UsageFlushActivity`. |
| `app/index.tsx` | On startup (after bare worklet ready), call `getQueuedReports()`, flush each to worklet, then `clearQueuedReports()`. |

### Data Flow

```
EnforcementService (every 60s)
  |
  |-- RN bridge alive? --> emit onUsageFlush --> index.tsx --> bare worklet --> parent
  |
  '-- RN bridge dead?  --> collect stats natively --> UsageQueueHelper.enqueue()

WorkManager (every 15 min)
  |
  |-- RN bridge alive? --> emit onUsageFlush
  |
  '-- RN bridge dead?  --> launch UsageFlushActivity --> RN lifecycle starts
                             --> index.tsx startup --> getQueuedReports()
                             --> flush each to bare worklet --> parent
                             --> clearQueuedReports()
                             --> Activity finishes after 30s
```

### Edge Cases

- **Multiple queued reports:** Flushed sequentially. The parent stores each by timestamp so no overwrites occur.
- **App killed during flush:** Queue is only cleared after all reports are sent. If killed mid-flush, remaining reports survive for next attempt.
- **Midnight rollover:** Each queued report has its own timestamp. Daily usage resets naturally since `getDailyUsageAllEvents` always queries from midnight of the current day.
- **Queue overflow:** At 96 entries max and 15-min WorkManager intervals, the queue covers 24 hours. If the child doesn't open the app for over 24 hours, oldest entries are dropped - acceptable since the parent will get the most recent daily totals when the child eventually reconnects.
- **WorkManager not firing:** Some OEMs throttle WorkManager aggressively. The queue still accumulates, and the next manual app open flushes everything. WorkManager is belt-and-suspenders, not the primary mechanism.

### Dependencies

Add to `android/app/build.gradle`:
```gradle
implementation 'androidx.work:work-runtime:2.9.1'
```

No other new dependencies required.

### What This Does NOT Solve

- **Real-time "current app" indicator:** Requires live Hyperswarm connection, which requires the bare worklet to be running. When the app is dismissed, no current app data reaches the parent. This is inherent to the architecture and not addressed here.
- **Hyperswarm reconnection on wake:** The WorkManager wake-up starts the RN bridge and bare worklet, which will attempt Hyperswarm reconnection. But the transparent Activity finishes after 5 seconds, and the process may be killed again shortly after. Sustained P2P connectivity requires the app to be in the foreground or background (not dismissed).
