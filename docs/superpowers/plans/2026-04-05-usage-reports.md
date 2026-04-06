# Usage Reports - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Screen Time-style usage reports with session-level data, interactive charts, and drill-down views on the parent device.

**Architecture:** Native Android builds session objects from UsageStatsManager events, child flushes them alongside existing usage data, parent stores sessions in Hyperbee and aggregates on the fly. New `UsageReports.jsx` component provides four interactive views (Daily Summary, Weekly Trends, Per-App Drill-Down, Category Breakdown) with custom SVG charts and CSS animations. Accessed via "See Details" from the existing Usage tab.

**Tech Stack:** Java (UsageStatsModule), JavaScript (bare-dispatch, React UI), custom SVG charts, CSS transitions/keyframes.

**Spec:** `docs/superpowers/specs/2026-04-05-usage-reports-design.md`

---

### Task 1: Native session building - `getSessionsSinceLastFlush()`

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/UsageStatsModule.java`

Add a new React Native bridge method that queries `UsageStatsManager.queryEvents()` from the last flush timestamp, pairs `MOVE_TO_FOREGROUND` / `MOVE_TO_BACKGROUND` events into session objects, and updates the flush timestamp in SharedPreferences.

- [ ] **Step 1: Add getSessionsSinceLastFlush method**

After the `getDailyUsageAllEvents()` method (around line 305), add:

```java
    @ReactMethod
    public void getSessionsSinceLastFlush(Promise promise) {
        try {
            Context ctx = getReactApplicationContext();
            UsageStatsManager usm = (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            PackageManager pm = ctx.getPackageManager();
            SharedPreferences prefs = ctx.getSharedPreferences("PearGuardPrefs", Context.MODE_PRIVATE);

            long now = System.currentTimeMillis();
            long lastFlush = prefs.getLong("pearguard_last_session_flush", startOfToday());

            UsageEvents events = usm.queryEvents(lastFlush, now);
            if (events == null) {
                promise.resolve(Arguments.createArray());
                return;
            }

            // Track foreground start times per package
            Map<String, Long> fgStarts = new HashMap<>();
            WritableArray sessions = Arguments.createArray();
            UsageEvents.Event event = new UsageEvents.Event();

            while (events.getNextEvent(event)) {
                String pkg = event.getPackageName();
                // Skip non-launcher / system / self
                if (pkg.equals(ctx.getPackageName())) continue;

                if (event.getEventType() == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                    fgStarts.put(pkg, event.getTimeStamp());
                } else if (event.getEventType() == UsageEvents.Event.MOVE_TO_BACKGROUND) {
                    Long start = fgStarts.remove(pkg);
                    if (start != null) {
                        long durationSec = (event.getTimeStamp() - start) / 1000;
                        if (durationSec >= 1) {
                            WritableMap session = Arguments.createMap();
                            session.putString("packageName", pkg);
                            session.putString("displayName", getAppLabel(pm, pkg));
                            session.putDouble("startedAt", (double) start);
                            session.putDouble("endedAt", (double) event.getTimeStamp());
                            session.putInt("durationSeconds", (int) durationSec);
                            sessions.pushMap(session);
                        }
                    }
                }
            }

            // Open sessions (still in foreground): endedAt = null
            for (Map.Entry<String, Long> entry : fgStarts.entrySet()) {
                long start = entry.getValue();
                long durationSec = (now - start) / 1000;
                if (durationSec >= 1) {
                    WritableMap session = Arguments.createMap();
                    session.putString("packageName", entry.getKey());
                    session.putString("displayName", getAppLabel(pm, entry.getKey()));
                    session.putDouble("startedAt", (double) start);
                    session.putNull("endedAt");
                    session.putInt("durationSeconds", (int) durationSec);
                    sessions.pushMap(session);
                }
            }

            // Update last flush timestamp
            prefs.edit().putLong("pearguard_last_session_flush", now).apply();

            promise.resolve(sessions);
        } catch (Exception e) {
            promise.reject("SESSION_ERROR", e.getMessage());
        }
    }

    private long startOfToday() {
        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.set(java.util.Calendar.HOUR_OF_DAY, 0);
        cal.set(java.util.Calendar.MINUTE, 0);
        cal.set(java.util.Calendar.SECOND, 0);
        cal.set(java.util.Calendar.MILLISECOND, 0);
        return cal.getTimeInMillis();
    }

    private String getAppLabel(PackageManager pm, String packageName) {
        try {
            ApplicationInfo ai = pm.getApplicationInfo(packageName, 0);
            return pm.getApplicationLabel(ai).toString();
        } catch (Exception e) {
            return packageName;
        }
    }
```

Note: Check if `getAppLabel` or `startOfToday` helpers already exist in the file. If so, reuse them instead of adding duplicates.

- [ ] **Step 2: Build to verify compilation**

```bash
cd android && ./gradlew assembleDebug && cd ..
```

Expected: BUILD SUCCESSFUL

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/pearguard/UsageStatsModule.java
git commit -m "feat(native): add getSessionsSinceLastFlush for session-level usage tracking (#95)"
```

---

### Task 2: Enhance usage:flush to include sessions

**Files:**
- Modify: `app/index.tsx` (usage flush handler, around line 444)
- Modify: `src/bare-dispatch.js` (usage:flush case, around line 763)

Wire the new native method into the flush pipeline and store sessions in Hyperbee.

- [ ] **Step 1: Add session fetch to the flush handler in app/index.tsx**

In the `onUsageFlush` listener (around line 444), add `getSessionsSinceLastFlush()` to the `Promise.all` call and pass the result to the worklet:

```typescript
DeviceEventEmitter.addListener('onUsageFlush', async (_e: { timestamp: number }) => {
  try {
    const [usageList, weeklyList, foregroundPkg, sessionsList] = await Promise.all([
      NativeModules.UsageStatsModule.getDailyUsageAllEvents(),
      NativeModules.UsageStatsModule.getWeeklyUsageAll(),
      NativeModules.UsageStatsModule.getLastForegroundPackage(),
      NativeModules.UsageStatsModule.getSessionsSinceLastFlush(),
    ])
    sendToWorklet({ method: 'usage:flush', args: { usage: usageList, weekly: weeklyList, foregroundPackage: foregroundPkg, sessions: sessionsList } })
  } catch (err) {
    console.warn('[PearGuard] Usage flush failed:', err)
  }
})
```

- [ ] **Step 2: Store sessions in bare-dispatch.js usage:flush handler**

In the `usage:flush` case (around line 763), after the report is built and before `ctx.db.put('usage:' + report.timestamp, report)`, add session storage. Also add sessions to the report payload so they travel over P2P:

After the line `const now = Date.now()` and before the `const report = {` block, add:

```javascript
        // Store session-level data for usage reports
        const sessions = args.sessions || []
        if (sessions.length > 0) {
          const dateStr = new Date(now).toISOString().slice(0, 10)
          await ctx.db.put('sessions:' + (childPublicKey || 'local') + ':' + dateStr + ':' + now, sessions)
        }
```

Then add `sessions` to the report object so it's sent to the parent:

```javascript
        const report = {
          type: 'usage:report',
          timestamp: now,
          lastSynced: now,
          apps,
          sessions,
          pinOverrides: pinLog,
          childPublicKey,
          currentApp,
          currentAppPackage,
          todayScreenTimeSeconds,
        }
```

- [ ] **Step 3: Store sessions on parent side in bare.js**

In `src/bare.js`, in the `usage:report` P2P message handler (around line 323), after the existing `db.put('usageReport:...')` line, add session storage:

```javascript
      // Store session-level data for reports
      const incomingSessions = msg.payload.sessions || []
      if (incomingSessions.length > 0) {
        const dateStr = new Date(msg.payload.timestamp || Date.now()).toISOString().slice(0, 10)
        await db.put('sessions:' + childPublicKey + ':' + dateStr + ':' + (msg.payload.timestamp || Date.now()), incomingSessions)
      }
```

- [ ] **Step 4: Build to verify**

```bash
npm run build:bare && npm run build:ui && cd android && ./gradlew assembleDebug && cd ..
```

Expected: BUILD SUCCESSFUL

- [ ] **Step 5: Commit**

```bash
git add app/index.tsx src/bare-dispatch.js src/bare.js
git commit -m "feat: include session data in usage:flush pipeline (#95)"
```

---

### Task 3: Add bare-dispatch query methods for reports

**Files:**
- Modify: `src/bare-dispatch.js`

Add three new dispatch cases: `usage:getSessions`, `usage:getDailySummaries`, `usage:getCategorySummary`.

- [ ] **Step 1: Add usage:getSessions handler**

After the `usage:getLatest` case (around line 842), add:

```javascript
      case 'usage:getSessions': {
        const { childPublicKey, date } = args
        if (!childPublicKey || !date) throw new Error('invalid usage:getSessions args')
        const allSessions = []
        for await (const { value } of ctx.db.createReadStream({
          gt: 'sessions:' + childPublicKey + ':' + date + ':',
          lt: 'sessions:' + childPublicKey + ':' + date + ':~',
        })) {
          if (Array.isArray(value)) {
            for (const s of value) allSessions.push(s)
          }
        }
        // Deduplicate by packageName + startedAt
        const seen = new Set()
        const deduped = []
        for (const s of allSessions) {
          const key = s.packageName + ':' + s.startedAt
          if (!seen.has(key)) {
            seen.add(key)
            deduped.push(s)
          }
        }
        return deduped
      }
```

- [ ] **Step 2: Add usage:getDailySummaries handler**

```javascript
      case 'usage:getDailySummaries': {
        const { childPublicKey, days, packageName } = args
        if (!childPublicKey || !days) throw new Error('invalid usage:getDailySummaries args')
        const summaries = []
        const now = new Date()
        for (let i = 0; i < days; i++) {
          const d = new Date(now)
          d.setDate(d.getDate() - i)
          const dateStr = d.toISOString().slice(0, 10)
          let totalSeconds = 0
          let sessionCount = 0
          for await (const { value } of ctx.db.createReadStream({
            gt: 'sessions:' + childPublicKey + ':' + dateStr + ':',
            lt: 'sessions:' + childPublicKey + ':' + dateStr + ':~',
          })) {
            if (Array.isArray(value)) {
              for (const s of value) {
                if (packageName && s.packageName !== packageName) continue
                totalSeconds += s.durationSeconds || 0
                sessionCount++
              }
            }
          }
          summaries.push({ date: dateStr, totalSeconds, sessionCount })
        }
        return summaries
      }
```

- [ ] **Step 3: Add usage:getCategorySummary handler**

```javascript
      case 'usage:getCategorySummary': {
        const { childPublicKey, date } = args
        if (!childPublicKey || !date) throw new Error('invalid usage:getCategorySummary args')
        // Get policy for category info
        const policyRaw = await ctx.db.get('policy:' + childPublicKey)
        const policyApps = policyRaw?.value?.apps || {}
        // Get sessions for the date
        const sessions = []
        for await (const { value } of ctx.db.createReadStream({
          gt: 'sessions:' + childPublicKey + ':' + date + ':',
          lt: 'sessions:' + childPublicKey + ':' + date + ':~',
        })) {
          if (Array.isArray(value)) {
            for (const s of value) sessions.push(s)
          }
        }
        // Group by category
        const categories = {}
        for (const s of sessions) {
          const appInfo = policyApps[s.packageName]
          const category = appInfo?.category || 'Other'
          if (!categories[category]) {
            categories[category] = { category, totalSeconds: 0, apps: {} }
          }
          categories[category].totalSeconds += s.durationSeconds || 0
          if (!categories[category].apps[s.packageName]) {
            categories[category].apps[s.packageName] = {
              packageName: s.packageName,
              displayName: s.displayName || s.packageName,
              totalSeconds: 0,
              iconBase64: appInfo?.iconBase64 || null,
            }
          }
          categories[category].apps[s.packageName].totalSeconds += s.durationSeconds || 0
        }
        // Convert apps objects to sorted arrays
        const result = Object.values(categories).map((cat) => ({
          ...cat,
          apps: Object.values(cat.apps).sort((a, b) => b.totalSeconds - a.totalSeconds),
        }))
        result.sort((a, b) => b.totalSeconds - a.totalSeconds)
        return result
      }
```

- [ ] **Step 4: Build to verify**

```bash
npm run build:bare && npm run build:ui
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/bare-dispatch.js
git commit -m "feat: add session query dispatch methods for usage reports (#95)"
```

---

### Task 4: Add 30-day cleanup

**Files:**
- Modify: `src/bare-dispatch.js`

Add a cleanup function that runs on `init` and prunes sessions and usage reports older than 30 days. Also set up a daily interval.

- [ ] **Step 1: Add cleanup logic to the init case**

In the `init` case handler in `bare-dispatch.js`, after existing initialization logic, add:

```javascript
        // Clean up usage data older than 30 days
        async function cleanupOldUsageData() {
          const cutoff = new Date()
          cutoff.setDate(cutoff.getDate() - 30)
          const cutoffStr = cutoff.toISOString().slice(0, 10)
          const cutoffMs = cutoff.getTime()

          // Clean old session batches
          for await (const { key } of ctx.db.createReadStream({
            gt: 'sessions:',
            lt: 'sessions:~',
          })) {
            // Key format: sessions:{childKey}:{YYYY-MM-DD}:{timestamp}
            const parts = key.split(':')
            if (parts.length >= 3) {
              const dateStr = parts[2]
              if (dateStr < cutoffStr) {
                await ctx.db.del(key)
              }
            }
          }

          // Clean old usage reports
          for await (const { key } of ctx.db.createReadStream({
            gt: 'usageReport:',
            lt: 'usageReport:~',
          })) {
            // Key format: usageReport:{childKey}:{timestamp}
            const parts = key.split(':')
            if (parts.length >= 3) {
              const ts = parseInt(parts[2], 10)
              if (ts < cutoffMs) {
                await ctx.db.del(key)
              }
            }
          }

          // Clean old child-side usage keys
          for await (const { key } of ctx.db.createReadStream({
            gt: 'usage:',
            lt: 'usage:~',
          })) {
            // Key format: usage:{timestamp} (child side)
            const parts = key.split(':')
            if (parts.length === 2) {
              const ts = parseInt(parts[1], 10)
              if (ts < cutoffMs) {
                await ctx.db.del(key)
              }
            }
          }
        }

        cleanupOldUsageData().catch((e) => console.error('[bare] cleanup error:', e))

        // Run cleanup once per day
        setInterval(() => {
          cleanupOldUsageData().catch((e) => console.error('[bare] cleanup error:', e))
        }, 24 * 60 * 60 * 1000)
```

- [ ] **Step 2: Build to verify**

```bash
npm run build:bare
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/bare-dispatch.js
git commit -m "feat: add 30-day cleanup for session and usage data (#95)"
```

---

### Task 5: Add CaretRight icon

**Files:**
- Modify: `src/ui/icons.js`

The UI needs a CaretRight icon for the day navigation arrows. Add it to the icon set.

- [ ] **Step 1: Add CaretRight path**

In `src/ui/icons.js`, after the `CaretLeft` line (around line 15), add:

```javascript
  CaretRight: 'M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z',
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/icons.js
git commit -m "feat: add CaretRight icon for usage reports navigation (#95)"
```

---

### Task 6: Animate UsageTab bars and add "See Details" button

**Files:**
- Modify: `src/ui/components/UsageTab.jsx`

Add staggered bar animations and a "See Details" button that calls `onShowReports` callback.

- [ ] **Step 1: Update UsageTab to accept onShowReports prop and animate bars**

Replace the full content of `src/ui/components/UsageTab.jsx`:

```jsx
import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import Button from './primitives/Button.jsx';

function timeAgo(timestamp) {
  if (!timestamp) return 'Never';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatSeconds(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function UsageBar({ appName, todaySeconds, weekSeconds, dailyLimitSeconds, index }) {
  const { colors, spacing, radius } = useTheme();
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setAnimated(true), 80 * index);
    return () => clearTimeout(timer);
  }, [index]);

  const todayScale = dailyLimitSeconds || 86400;
  const weekScale = dailyLimitSeconds ? dailyLimitSeconds * 7 : 604800;
  const todayPct = Math.min(100, (todaySeconds / todayScale) * 100);
  const weekPct = Math.min(100, (weekSeconds / weekScale) * 100);
  const overLimit = dailyLimitSeconds && todaySeconds > dailyLimitSeconds;

  return (
    <div style={{ marginBottom: `${spacing.lg}px` }}>
      <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '6px', color: colors.text.primary }}>{appName}</div>
      <div>
        <div style={{ fontSize: '12px', color: colors.text.secondary, marginBottom: '3px', marginTop: '6px' }}>Today: {formatSeconds(todaySeconds)}</div>
        <div style={{ height: '8px', backgroundColor: colors.surface.elevated, borderRadius: `${radius.sm}px`, overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              borderRadius: `${radius.sm}px`,
              transition: 'width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
              width: animated ? `${todayPct}%` : '0%',
              backgroundColor: overLimit ? colors.error : colors.primary,
            }}
          />
        </div>
        <div style={{ fontSize: '12px', color: colors.text.secondary, marginBottom: '3px', marginTop: '6px' }}>This week: {formatSeconds(weekSeconds)}</div>
        <div style={{ height: '8px', backgroundColor: colors.surface.elevated, borderRadius: `${radius.sm}px`, overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              borderRadius: `${radius.sm}px`,
              transition: 'width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
              transitionDelay: `${0.1 + 0.08 * index}s`,
              width: animated ? `${weekPct}%` : '0%',
              backgroundColor: colors.success,
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default function UsageTab({ childPublicKey, onShowReports }) {
  const { colors, spacing } = useTheme();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.callBare('usage:getLatest', { childPublicKey })
      .then((data) => {
        setReport(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    const unsub = window.onBareEvent('usage:report', (data) => {
      if (data && data.childPublicKey === childPublicKey && data.apps && data.apps.length > 0) {
        setReport(data);
        setLoading(false);
      }
    });
    return unsub;
  }, [childPublicKey]);

  if (loading) return <div style={{ padding: `${spacing.base}px`, color: colors.text.muted, fontSize: '14px' }}>Loading usage data...</div>;
  if (!report || !report.apps || report.apps.length === 0) {
    return <div style={{ padding: `${spacing.base}px`, color: colors.text.muted, fontSize: '14px' }}>No usage data yet. Data syncs every 5 minutes.</div>;
  }

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <p style={{ fontSize: '12px', color: colors.text.muted, marginBottom: `${spacing.base}px` }}>Last synced: {timeAgo(report.lastSynced || report.timestamp)}</p>
      {report.apps.map((app, i) => (
        <UsageBar
          key={app.packageName}
          appName={app.displayName || app.packageName}
          todaySeconds={app.todaySeconds}
          weekSeconds={app.weekSeconds}
          dailyLimitSeconds={app.dailyLimitSeconds}
          index={i}
        />
      ))}
      {onShowReports && (
        <div style={{ marginTop: `${spacing.base}px`, textAlign: 'center' }}>
          <Button variant="secondary" onClick={onShowReports}>See Details</Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
npm run build:ui
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/UsageTab.jsx
git commit -m "feat: animate usage bars and add See Details button (#95)"
```

---

### Task 7: Create UsageReports.jsx - shell with pill selector and daily summary

**Files:**
- Create: `src/ui/components/UsageReports.jsx`

Build the main reports component with the pill navigation and the Daily Summary view (hourly SVG bar chart, total screen time, top 5 apps, day navigation arrows).

- [ ] **Step 1: Create UsageReports.jsx**

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';

const VIEWS = [
  { key: 'daily', label: 'Daily' },
  { key: 'trends', label: 'Trends' },
  { key: 'apps', label: 'Apps' },
  { key: 'categories', label: 'Categories' },
];

function formatSeconds(s) {
  if (!s || s <= 0) return '0m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  if (dateStr === todayStr) return 'Today';
  if (dateStr === yesterdayStr) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function dateOffset(dateStr, offset) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

// --- Hourly Bar Chart (SVG) ---

function HourlyChart({ sessions, colors }) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    setAnimated(false);
    const t = requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimated(true));
    });
    return () => cancelAnimationFrame(t);
  }, [sessions]);

  // Aggregate sessions into hourly buckets
  const hours = new Array(24).fill(0);
  for (const s of sessions) {
    const hour = new Date(s.startedAt).getHours();
    hours[hour] += s.durationSeconds || 0;
  }
  const maxSeconds = Math.max(...hours, 1);

  const chartW = 300;
  const chartH = 120;
  const barW = (chartW - 23 * 2) / 24; // 2px gap between bars
  const labels = [0, 6, 12, 18, 23];

  return (
    <svg viewBox={`0 0 ${chartW} ${chartH + 20}`} style={{ width: '100%', maxWidth: '400px', display: 'block', margin: '0 auto' }}>
      {hours.map((sec, i) => {
        const pct = sec / maxSeconds;
        const barH = pct * chartH;
        const x = i * (barW + 2);
        return (
          <rect
            key={i}
            x={x}
            y={animated ? chartH - barH : chartH}
            width={barW}
            height={animated ? barH : 0}
            rx={2}
            fill={sec > 0 ? colors.primary : colors.surface.elevated}
            style={{
              transition: `y 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.02}s, height 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.02}s`,
            }}
          />
        );
      })}
      {labels.map((h) => (
        <text
          key={h}
          x={h * (barW + 2) + barW / 2}
          y={chartH + 14}
          textAnchor="middle"
          fill={colors.text.muted}
          fontSize="9"
        >
          {h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
        </text>
      ))}
    </svg>
  );
}

// --- Top Apps List ---

function TopApps({ sessions, colors, spacing }) {
  const appMap = {};
  for (const s of sessions) {
    if (!appMap[s.packageName]) {
      appMap[s.packageName] = { displayName: s.displayName || s.packageName, totalSeconds: 0 };
    }
    appMap[s.packageName].totalSeconds += s.durationSeconds || 0;
  }
  const sorted = Object.values(appMap).sort((a, b) => b.totalSeconds - a.totalSeconds).slice(0, 5);
  if (sorted.length === 0) return null;

  return (
    <div style={{ marginTop: `${spacing.base}px` }}>
      <div style={{ fontSize: '13px', fontWeight: '600', color: colors.text.secondary, marginBottom: `${spacing.sm}px` }}>Top Apps</div>
      {sorted.map((app, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${spacing.xs}px 0` }}>
          <span style={{ fontSize: '14px', color: colors.text.primary }}>{app.displayName}</span>
          <span style={{ fontSize: '13px', color: colors.text.muted }}>{formatSeconds(app.totalSeconds)}</span>
        </div>
      ))}
    </div>
  );
}

// --- Daily Summary View ---

function DailySummary({ childPublicKey, colors, spacing, radius }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fadeDir, setFadeDir] = useState(null);

  const today = new Date().toISOString().slice(0, 10);
  const minDate = dateOffset(today, -29);

  const fetchSessions = useCallback((d) => {
    setLoading(true);
    window.callBare('usage:getSessions', { childPublicKey, date: d })
      .then((data) => { setSessions(data || []); setLoading(false); })
      .catch(() => { setSessions([]); setLoading(false); });
  }, [childPublicKey]);

  useEffect(() => { fetchSessions(date); }, [date, fetchSessions]);

  function navigate(dir) {
    const next = dateOffset(date, dir);
    if (next > today || next < minDate) return;
    setFadeDir(dir);
    setTimeout(() => {
      setDate(next);
      setFadeDir(null);
    }, 150);
  }

  const totalSeconds = sessions.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
  const sessionCount = sessions.length;
  const canGoBack = dateOffset(date, -1) >= minDate;
  const canGoForward = date < today;

  return (
    <div style={{
      opacity: fadeDir !== null ? 0.3 : 1,
      transform: fadeDir !== null ? `translateX(${fadeDir > 0 ? -20 : 20}px)` : 'translateX(0)',
      transition: 'opacity 0.15s ease, transform 0.15s ease',
    }}>
      {/* Day selector */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: `${spacing.md}px`, marginBottom: `${spacing.base}px` }}>
        <button
          onClick={() => navigate(-1)}
          disabled={!canGoBack}
          style={{ background: 'none', border: 'none', cursor: canGoBack ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoBack ? 1 : 0.3 }}
        >
          <Icon name="CaretLeft" size={20} color={colors.text.primary} />
        </button>
        <span style={{ fontSize: '15px', fontWeight: '600', color: colors.text.primary, minWidth: '140px', textAlign: 'center' }}>
          {formatDate(date)}
        </span>
        <button
          onClick={() => navigate(1)}
          disabled={!canGoForward}
          style={{ background: 'none', border: 'none', cursor: canGoForward ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoForward ? 1 : 0.3 }}
        >
          <Icon name="CaretRight" size={20} color={colors.text.primary} />
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>Loading...</div>
      ) : sessions.length === 0 ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>No usage data for this day.</div>
      ) : (
        <>
          {/* Summary stats */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: `${spacing.xl}px`, marginBottom: `${spacing.base}px` }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '24px', fontWeight: '700', color: colors.text.primary }}>{formatSeconds(totalSeconds)}</div>
              <div style={{ fontSize: '12px', color: colors.text.muted }}>Screen Time</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '24px', fontWeight: '700', color: colors.text.primary }}>{sessionCount}</div>
              <div style={{ fontSize: '12px', color: colors.text.muted }}>Sessions</div>
            </div>
          </div>

          {/* Hourly chart */}
          <HourlyChart sessions={sessions} colors={colors} />

          {/* Top apps */}
          <TopApps sessions={sessions} colors={colors} spacing={spacing} />
        </>
      )}
    </div>
  );
}

// --- Main UsageReports Component ---

export default function UsageReports({ childPublicKey, onBack }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [view, setView] = useState('daily');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.surface.base }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: `${spacing.md}px`,
        padding: `${spacing.md}px ${spacing.base}px`,
        borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}>
          <Icon name="CaretLeft" size={20} color={colors.primary} />
        </button>
        <span style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600' }}>Usage Reports</span>
      </div>

      {/* Pill selector */}
      <div style={{
        display: 'flex', gap: `${spacing.xs}px`,
        padding: `${spacing.sm}px ${spacing.base}px`,
        backgroundColor: colors.surface.card,
        borderBottom: `1px solid ${colors.border}`,
      }}>
        {VIEWS.map((v) => {
          const active = v.key === view;
          return (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              style={{
                flex: 1,
                padding: `${spacing.xs + 2}px ${spacing.sm}px`,
                border: 'none',
                borderRadius: `${radius.md}px`,
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: active ? '600' : '400',
                backgroundColor: active ? colors.primary : 'transparent',
                color: active ? '#fff' : colors.text.muted,
                transition: 'background-color 0.2s ease, color 0.2s ease',
              }}
            >
              {v.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: `${spacing.base}px` }}>
        {view === 'daily' && <DailySummary childPublicKey={childPublicKey} colors={colors} spacing={spacing} radius={radius} />}
        {view === 'trends' && <div style={{ color: colors.text.muted, fontSize: '14px' }}>Weekly trends coming next...</div>}
        {view === 'apps' && <div style={{ color: colors.text.muted, fontSize: '14px' }}>App drill-down coming next...</div>}
        {view === 'categories' && <div style={{ color: colors.text.muted, fontSize: '14px' }}>Category breakdown coming next...</div>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Build to verify**

```bash
npm run build:ui
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/UsageReports.jsx
git commit -m "feat: add UsageReports shell with daily summary view (#95)"
```

---

### Task 8: Wire UsageReports into ChildDetail

**Files:**
- Modify: `src/ui/components/ChildDetail.jsx`

Add state to toggle between the subtab view and the full reports view. Pass `onShowReports` to UsageTab and render UsageReports when active.

- [ ] **Step 1: Update ChildDetail.jsx**

Add import at the top (after the RulesTab import on line 9):

```javascript
import UsageReports from './UsageReports.jsx';
```

Add state for showing reports (after the `locked` state on line 32):

```javascript
  const [showReports, setShowReports] = useState(false);
```

Wrap the return to conditionally render UsageReports. Replace the return statement (line 47 onward) with:

```javascript
  if (showReports) {
    return <UsageReports childPublicKey={child.publicKey} onBack={() => setShowReports(false)} />;
  }

  const ActiveComponent = TAB_COMPONENTS[tab] || UsageTab;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.surface.base }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: `${spacing.md}px`,
        padding: `${spacing.md}px ${spacing.base}px`,
        borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}>
          <Icon name="CaretLeft" size={20} color={colors.primary} />
        </button>
        <Avatar avatar={child.avatarThumb} name={child.displayName} size={32} />
        <span style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', flex: 1 }}>
          {child.displayName}
        </span>
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          backgroundColor: child.isOnline ? colors.success : colors.text.muted,
        }} />

        <button
          onClick={handleLockToggle}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}
          aria-label={locked ? 'Unlock device' : 'Lock device'}
        >
          <Icon name={locked ? 'LockSimple' : 'LockSimpleOpen'} size={20} color={locked ? colors.error : colors.text.muted} />
        </button>

        {!confirmRemove ? (
          <button
            onClick={() => setConfirmRemove(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}
            aria-label="Remove child"
          >
            <Icon name="Trash" size={18} color={colors.text.muted} />
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
            <span style={{ ...typography.caption, color: colors.text.secondary }}>Remove?</span>
            <Button variant="danger" onClick={handleRemove} style={{ padding: `${spacing.xs}px ${spacing.sm}px` }}>Yes</Button>
            <Button variant="secondary" onClick={() => setConfirmRemove(false)} style={{ padding: `${spacing.xs}px ${spacing.sm}px` }}>No</Button>
          </div>
        )}
      </div>

      {/* Sub-tabs */}
      <div style={{
        display: 'flex', overflowX: 'auto',
        borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
      }}>
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              onClick={() => { window.callBare('haptic:tap'); setTab(t.key); }}
              style={{
                flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`,
                padding: `${spacing.sm + 2}px ${spacing.md + 2}px`,
                border: 'none', background: 'none', cursor: 'pointer',
                borderBottom: `2px solid ${active ? colors.primary : 'transparent'}`,
                ...typography.caption,
                color: active ? colors.primary : colors.text.muted,
                fontWeight: active ? '600' : '400',
                whiteSpace: 'nowrap',
              }}
            >
              <Icon name={t.icon} size={16} color={active ? colors.primary : colors.text.muted} weight={active ? 'fill' : 'regular'} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'usage' ? (
          <UsageTab childPublicKey={child.publicKey} onShowReports={() => setShowReports(true)} />
        ) : (
          <ActiveComponent childPublicKey={child.publicKey} />
        )}
      </div>
    </div>
  );
```

Note: The only meaningful changes from the original are: (1) the `showReports` state, (2) the early return for `UsageReports`, (3) the conditional rendering in the Content area that passes `onShowReports` to UsageTab when it's the active tab.

- [ ] **Step 2: Build to verify**

```bash
npm run build:ui
```

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/ChildDetail.jsx
git commit -m "feat: wire UsageReports into ChildDetail (#95)"
```

---

### Task 9: Add Weekly Trends view

**Files:**
- Modify: `src/ui/components/UsageReports.jsx`

Replace the trends placeholder with a vertical bar chart showing daily totals, toggleable between 7-day and 30-day, with average line and period comparison.

- [ ] **Step 1: Add WeeklyTrends component**

In `UsageReports.jsx`, before the `export default function UsageReports` line, add:

```jsx
function WeeklyTrends({ childPublicKey, colors, spacing, radius }) {
  const [period, setPeriod] = useState(7);
  const [summaries, setSummaries] = useState([]);
  const [prevSummaries, setPrevSummaries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    setLoading(true);
    setAnimated(false);
    Promise.all([
      window.callBare('usage:getDailySummaries', { childPublicKey, days: period }),
      window.callBare('usage:getDailySummaries', { childPublicKey, days: period * 2 }),
    ]).then(([current, extended]) => {
      setSummaries((current || []).reverse());
      setPrevSummaries((extended || []).slice(period).reverse());
      setLoading(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setAnimated(true));
      });
    }).catch(() => { setSummaries([]); setPrevSummaries([]); setLoading(false); });
  }, [childPublicKey, period]);

  if (loading) return <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>Loading...</div>;

  const maxSeconds = Math.max(...summaries.map((s) => s.totalSeconds), 1);
  const avgSeconds = summaries.length > 0 ? summaries.reduce((sum, s) => sum + s.totalSeconds, 0) / summaries.length : 0;
  const prevAvg = prevSummaries.length > 0 ? prevSummaries.reduce((sum, s) => sum + s.totalSeconds, 0) / prevSummaries.length : 0;
  const changePct = prevAvg > 0 ? Math.round(((avgSeconds - prevAvg) / prevAvg) * 100) : null;

  const chartW = 300;
  const chartH = 140;
  const gap = period <= 7 ? 4 : 1;
  const barW = (chartW - (summaries.length - 1) * gap) / Math.max(summaries.length, 1);
  const avgY = maxSeconds > 0 ? chartH - (avgSeconds / maxSeconds) * chartH : chartH;

  return (
    <div>
      {/* Period toggle */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: `${spacing.xs}px`, marginBottom: `${spacing.base}px` }}>
        {[7, 30].map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: `${spacing.xs}px ${spacing.md}px`,
              border: 'none',
              borderRadius: `${radius.md}px`,
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: period === p ? '600' : '400',
              backgroundColor: period === p ? colors.primary : colors.surface.elevated,
              color: period === p ? '#fff' : colors.text.muted,
              transition: 'background-color 0.2s ease, color 0.2s ease',
            }}
          >
            {p} days
          </button>
        ))}
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: `${spacing.xl}px`, marginBottom: `${spacing.base}px` }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '20px', fontWeight: '700', color: colors.text.primary }}>{formatSeconds(Math.round(avgSeconds))}</div>
          <div style={{ fontSize: '12px', color: colors.text.muted }}>Daily Average</div>
        </div>
        {changePct !== null && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: changePct > 0 ? colors.error : colors.success }}>
              {changePct > 0 ? '+' : ''}{changePct}%
            </div>
            <div style={{ fontSize: '12px', color: colors.text.muted }}>vs Previous</div>
          </div>
        )}
      </div>

      {/* Bar chart */}
      {summaries.length > 0 && (
        <svg viewBox={`0 0 ${chartW} ${chartH + 20}`} style={{ width: '100%', maxWidth: '400px', display: 'block', margin: '0 auto' }}>
          {/* Average line */}
          <line x1={0} y1={avgY} x2={chartW} y2={avgY} stroke={colors.text.muted} strokeDasharray="4 3" strokeWidth={1} opacity={0.5} />

          {/* Bars */}
          {summaries.map((s, i) => {
            const barH = maxSeconds > 0 ? (s.totalSeconds / maxSeconds) * chartH : 0;
            const x = i * (barW + gap);
            return (
              <rect
                key={i}
                x={x}
                y={animated ? chartH - barH : chartH}
                width={barW}
                height={animated ? barH : 0}
                rx={period <= 7 ? 3 : 1}
                fill={colors.primary}
                style={{
                  transition: `y 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.03}s, height 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.03}s`,
                }}
              />
            );
          })}

          {/* Date labels (only for 7-day view) */}
          {period <= 7 && summaries.map((s, i) => (
            <text
              key={i}
              x={i * (barW + gap) + barW / 2}
              y={chartH + 14}
              textAnchor="middle"
              fill={colors.text.muted}
              fontSize="9"
            >
              {new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2)}
            </text>
          ))}
        </svg>
      )}

      {summaries.length === 0 && (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>No trend data available yet.</div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update the view rendering in UsageReports**

Replace the trends placeholder line:

```jsx
        {view === 'trends' && <WeeklyTrends childPublicKey={childPublicKey} colors={colors} spacing={spacing} radius={radius} />}
```

- [ ] **Step 3: Build to verify**

```bash
npm run build:ui
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/UsageReports.jsx
git commit -m "feat: add weekly trends view with 7/30-day toggle (#95)"
```

---

### Task 10: Add Per-App Drill-Down view

**Files:**
- Modify: `src/ui/components/UsageReports.jsx`

Replace the apps placeholder with a sorted list of apps that expand inline to show daily sparkline, session list, and stats.

- [ ] **Step 1: Add AppDrillDown component**

In `UsageReports.jsx`, before the `export default function UsageReports` line, add:

```jsx
function Sparkline({ data, colors, width = 120, height = 30 }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.totalSeconds), 1);
  const step = width / Math.max(data.length - 1, 1);
  const points = data.map((d, i) => {
    const x = i * step;
    const y = height - (d.totalSeconds / max) * height;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: `${width}px`, height: `${height}px` }}>
      <polyline points={points} fill="none" stroke={colors.primary} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function AppDrillDown({ childPublicKey, colors, spacing, radius }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [sparkData, setSparkData] = useState({});

  const today = new Date().toISOString().slice(0, 10);
  const minDate = dateOffset(today, -29);

  useEffect(() => {
    setLoading(true);
    window.callBare('usage:getSessions', { childPublicKey, date })
      .then((data) => { setSessions(data || []); setLoading(false); })
      .catch(() => { setSessions([]); setLoading(false); });
  }, [childPublicKey, date]);

  // Aggregate by app
  const appMap = {};
  for (const s of sessions) {
    if (!appMap[s.packageName]) {
      appMap[s.packageName] = { packageName: s.packageName, displayName: s.displayName || s.packageName, totalSeconds: 0, sessions: [] };
    }
    appMap[s.packageName].totalSeconds += s.durationSeconds || 0;
    appMap[s.packageName].sessions.push(s);
  }
  const apps = Object.values(appMap).sort((a, b) => b.totalSeconds - a.totalSeconds);

  function handleExpand(pkg) {
    if (expanded === pkg) { setExpanded(null); return; }
    setExpanded(pkg);
    if (!sparkData[pkg]) {
      window.callBare('usage:getDailySummaries', { childPublicKey, days: 7, packageName: pkg })
        .then((data) => setSparkData((prev) => ({ ...prev, [pkg]: (data || []).reverse() })))
        .catch(() => {});
    }
  }

  const canGoBack = dateOffset(date, -1) >= minDate;
  const canGoForward = date < today;

  return (
    <div>
      {/* Day selector */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: `${spacing.md}px`, marginBottom: `${spacing.base}px` }}>
        <button
          onClick={() => { if (canGoBack) setDate(dateOffset(date, -1)); }}
          disabled={!canGoBack}
          style={{ background: 'none', border: 'none', cursor: canGoBack ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoBack ? 1 : 0.3 }}
        >
          <Icon name="CaretLeft" size={20} color={colors.text.primary} />
        </button>
        <span style={{ fontSize: '15px', fontWeight: '600', color: colors.text.primary, minWidth: '140px', textAlign: 'center' }}>
          {formatDate(date)}
        </span>
        <button
          onClick={() => { if (canGoForward) setDate(dateOffset(date, 1)); }}
          disabled={!canGoForward}
          style={{ background: 'none', border: 'none', cursor: canGoForward ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoForward ? 1 : 0.3 }}
        >
          <Icon name="CaretRight" size={20} color={colors.text.primary} />
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>Loading...</div>
      ) : apps.length === 0 ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>No app usage for this day.</div>
      ) : (
        apps.map((app) => {
          const isExpanded = expanded === app.packageName;
          const appSessions = app.sessions.sort((a, b) => a.startedAt - b.startedAt);
          const longestSession = Math.max(...appSessions.map((s) => s.durationSeconds || 0));
          const avgSession = Math.round(app.totalSeconds / appSessions.length);

          return (
            <div
              key={app.packageName}
              style={{
                marginBottom: `${spacing.xs}px`,
                backgroundColor: colors.surface.card,
                borderRadius: `${radius.md}px`,
                overflow: 'hidden',
                transition: 'background-color 0.2s ease',
              }}
            >
              {/* App row */}
              <button
                onClick={() => handleExpand(app.packageName)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: `${spacing.sm + 2}px ${spacing.md}px`,
                  border: 'none', background: 'none', cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: '14px', fontWeight: '500', color: colors.text.primary }}>{app.displayName}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
                  <span style={{ fontSize: '13px', color: colors.text.muted }}>{formatSeconds(app.totalSeconds)}</span>
                  <Icon name={isExpanded ? 'CaretUp' : 'CaretDown'} size={14} color={colors.text.muted} />
                </div>
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{
                  padding: `0 ${spacing.md}px ${spacing.md}px`,
                  borderTop: `1px solid ${colors.border}`,
                }}>
                  {/* Stats */}
                  <div style={{ display: 'flex', gap: `${spacing.md}px`, padding: `${spacing.sm}px 0`, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: colors.text.muted }}>Sessions</div>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: colors.text.primary }}>{appSessions.length}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: colors.text.muted }}>Longest</div>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: colors.text.primary }}>{formatSeconds(longestSession)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: colors.text.muted }}>Average</div>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: colors.text.primary }}>{formatSeconds(avgSession)}</div>
                    </div>
                  </div>

                  {/* Sparkline */}
                  {sparkData[app.packageName] && (
                    <div style={{ padding: `${spacing.xs}px 0` }}>
                      <div style={{ fontSize: '11px', color: colors.text.muted, marginBottom: '4px' }}>Last 7 days</div>
                      <Sparkline data={sparkData[app.packageName]} colors={colors} />
                    </div>
                  )}

                  {/* Session list */}
                  <div style={{ marginTop: `${spacing.sm}px` }}>
                    <div style={{ fontSize: '11px', color: colors.text.muted, marginBottom: '4px' }}>Sessions</div>
                    {appSessions.map((s, i) => {
                      const start = new Date(s.startedAt);
                      const end = s.endedAt ? new Date(s.endedAt) : null;
                      const fmt = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                      return (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '13px' }}>
                          <span style={{ color: colors.text.secondary }}>{fmt(start)} - {end ? fmt(end) : 'now'}</span>
                          <span style={{ color: colors.text.muted }}>{formatSeconds(s.durationSeconds)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update the view rendering in UsageReports**

Replace the apps placeholder line:

```jsx
        {view === 'apps' && <AppDrillDown childPublicKey={childPublicKey} colors={colors} spacing={spacing} radius={radius} />}
```

- [ ] **Step 3: Build to verify**

```bash
npm run build:ui
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/UsageReports.jsx
git commit -m "feat: add per-app drill-down view with sessions and sparkline (#95)"
```

---

### Task 11: Add Category Breakdown view

**Files:**
- Modify: `src/ui/components/UsageReports.jsx`

Replace the categories placeholder with a custom SVG donut chart with animated segment reveal, legend, and tap-to-expand category detail.

- [ ] **Step 1: Add CategoryBreakdown component**

In `UsageReports.jsx`, before the `export default function UsageReports` line, add:

```jsx
const CATEGORY_COLORS = {
  'Games': '#FF6B6B',
  'Social': '#4ECDC4',
  'Video & Music': '#45B7D1',
  'Communication': '#96CEB4',
  'Education': '#FFEAA7',
  'News': '#DDA0DD',
  'Productivity': '#98D8C8',
  'System': '#778899',
  'Other': '#B0B0B0',
};

function DonutChart({ categories, colors, totalSeconds }) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    setAnimated(false);
    const t = requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimated(true));
    });
    return () => cancelAnimationFrame(t);
  }, [categories]);

  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 70;
  const innerR = 45;
  const circumference = 2 * Math.PI * ((outerR + innerR) / 2);

  let currentAngle = 0;
  const segments = categories.map((cat) => {
    const fraction = totalSeconds > 0 ? cat.totalSeconds / totalSeconds : 0;
    const dashLen = circumference * fraction;
    const dashOff = animated ? 0 : dashLen;
    const rotation = currentAngle;
    currentAngle += fraction * 360;
    return { ...cat, fraction, dashLen, dashOff, rotation };
  });

  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: `${size}px`, height: `${size}px`, display: 'block', margin: '0 auto' }}>
      {/* Background ring */}
      <circle cx={cx} cy={cy} r={(outerR + innerR) / 2} fill="none" stroke={colors.surface.elevated} strokeWidth={outerR - innerR} />
      {/* Segments */}
      {segments.map((seg, i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={(outerR + innerR) / 2}
          fill="none"
          stroke={CATEGORY_COLORS[seg.category] || CATEGORY_COLORS['Other']}
          strokeWidth={outerR - innerR}
          strokeDasharray={`${seg.dashLen} ${circumference - seg.dashLen}`}
          strokeDashoffset={seg.dashOff}
          transform={`rotate(${seg.rotation - 90} ${cx} ${cy})`}
          style={{
            transition: `stroke-dashoffset 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.1}s`,
          }}
        />
      ))}
      {/* Center text */}
      <text x={cx} y={cy - 6} textAnchor="middle" fill={colors.text.primary} fontSize="16" fontWeight="700">
        {formatSeconds(totalSeconds)}
      </text>
      <text x={cx} y={cy + 10} textAnchor="middle" fill={colors.text.muted} fontSize="9">
        Total
      </text>
    </svg>
  );
}

function CategoryBreakdown({ childPublicKey, colors, spacing, radius }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  const today = new Date().toISOString().slice(0, 10);
  const minDate = dateOffset(today, -29);

  useEffect(() => {
    setLoading(true);
    window.callBare('usage:getCategorySummary', { childPublicKey, date })
      .then((data) => { setCategories(data || []); setLoading(false); })
      .catch(() => { setCategories([]); setLoading(false); });
  }, [childPublicKey, date]);

  const totalSeconds = categories.reduce((sum, c) => sum + c.totalSeconds, 0);
  const canGoBack = dateOffset(date, -1) >= minDate;
  const canGoForward = date < today;

  return (
    <div>
      {/* Day selector */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: `${spacing.md}px`, marginBottom: `${spacing.base}px` }}>
        <button
          onClick={() => { if (canGoBack) setDate(dateOffset(date, -1)); }}
          disabled={!canGoBack}
          style={{ background: 'none', border: 'none', cursor: canGoBack ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoBack ? 1 : 0.3 }}
        >
          <Icon name="CaretLeft" size={20} color={colors.text.primary} />
        </button>
        <span style={{ fontSize: '15px', fontWeight: '600', color: colors.text.primary, minWidth: '140px', textAlign: 'center' }}>
          {formatDate(date)}
        </span>
        <button
          onClick={() => { if (canGoForward) setDate(dateOffset(date, 1)); }}
          disabled={!canGoForward}
          style={{ background: 'none', border: 'none', cursor: canGoForward ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoForward ? 1 : 0.3 }}
        >
          <Icon name="CaretRight" size={20} color={colors.text.primary} />
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>Loading...</div>
      ) : categories.length === 0 ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>No category data for this day.</div>
      ) : (
        <>
          <DonutChart categories={categories} colors={colors} totalSeconds={totalSeconds} />

          {/* Legend / Category list */}
          <div style={{ marginTop: `${spacing.base}px` }}>
            {categories.map((cat) => {
              const isExpanded = expanded === cat.category;
              const pct = totalSeconds > 0 ? Math.round((cat.totalSeconds / totalSeconds) * 100) : 0;
              return (
                <div key={cat.category} style={{
                  marginBottom: `${spacing.xs}px`,
                  backgroundColor: colors.surface.card,
                  borderRadius: `${radius.md}px`,
                  overflow: 'hidden',
                }}>
                  <button
                    onClick={() => setExpanded(isExpanded ? null : cat.category)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center',
                      padding: `${spacing.sm + 2}px ${spacing.md}px`,
                      border: 'none', background: 'none', cursor: 'pointer', gap: `${spacing.sm}px`,
                    }}
                  >
                    <span style={{
                      width: '10px', height: '10px', borderRadius: '50%',
                      backgroundColor: CATEGORY_COLORS[cat.category] || CATEGORY_COLORS['Other'],
                      flexShrink: 0,
                    }} />
                    <span style={{ fontSize: '14px', fontWeight: '500', color: colors.text.primary, flex: 1, textAlign: 'left' }}>{cat.category}</span>
                    <span style={{ fontSize: '13px', color: colors.text.muted }}>{formatSeconds(cat.totalSeconds)} ({pct}%)</span>
                    <Icon name={isExpanded ? 'CaretUp' : 'CaretDown'} size={14} color={colors.text.muted} />
                  </button>

                  {isExpanded && (
                    <div style={{ padding: `0 ${spacing.md}px ${spacing.md}px`, borderTop: `1px solid ${colors.border}` }}>
                      {cat.apps.map((app) => (
                        <div key={app.packageName} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                          <span style={{ fontSize: '13px', color: colors.text.secondary }}>{app.displayName}</span>
                          <span style={{ fontSize: '13px', color: colors.text.muted }}>{formatSeconds(app.totalSeconds)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Update the view rendering in UsageReports**

Replace the categories placeholder line:

```jsx
        {view === 'categories' && <CategoryBreakdown childPublicKey={childPublicKey} colors={colors} spacing={spacing} radius={radius} />}
```

- [ ] **Step 3: Build to verify**

```bash
npm run build:ui
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/components/UsageReports.jsx
git commit -m "feat: add category breakdown view with animated donut chart (#95)"
```

---

### Task 12: Build, install, and verify

**Files:** None (integration verification)

Build the full app and install on the parent device for testing.

- [ ] **Step 1: Full build**

```bash
npm run build:bare && npm run build:ui && cd android && ./gradlew assembleDebug && cd ..
```

Expected: BUILD SUCCESSFUL

- [ ] **Step 2: Install on parent device**

```bash
adb install -r /home/tim/peerloomllc/pearguard/android/app/build/outputs/apk/debug/app-debug.apk
```

Expected: Success

- [ ] **Step 3: Verify on device**

Test the following:
1. Open a child's detail view, see animated usage bars on Usage tab
2. Tap "See Details" button to open Usage Reports
3. Daily Summary: hourly bar chart loads, day arrows work, shows total screen time and top apps
4. Weekly Trends: 7-day view loads, toggle to 30-day, bars animate, shows average and comparison
5. Per-App Drill-Down: tap app to expand, see session list, sparkline, stats
6. Category Breakdown: donut chart animates, legend shows categories, tap to expand
7. Back arrow returns to Usage tab

Wait for user to confirm on-device testing results before proceeding.
