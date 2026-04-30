# Usage trends/category — backfill historical data

Date: 2026-04-30
Tier: T2 (new IPC method, new Hyperbee key)
Status: draft (awaiting approval before implementation)

## Goal

Make the parent's Trends and Category usage reports reflect what Android (and Windows) actually saw on prior days, instead of only the days the parent happened to receive a session flush.

## Background

The parent currently has two divergent data sources for child usage:

1. **`usage:report.apps[].weekSeconds`** — comes from the child's
   `getWeeklyUsageAll()`, which queries Android `UsageStatsManager`. Always
   accurate because Android keeps the rolling totals system-wide. Powers the
   Usage tab "Last 7 days" line per app.
2. **`sessions:{childPK}:{date}:full`** Hyperbee entries — populated only when
   the child flushes (`getSessionsSinceLastFlush()` on Android queries
   `UsageEvents` from midnight-of-today only). Powers Trends, Category, and
   Daily-Summary in Usage Reports.

If the child wasn't running or wasn't connected on day D, no `sessions:` entry
is ever written for D, and there's no backfill — once the day rolls over, the
events are gone from the per-flush window. Trends and Category therefore
chronically undercount on devices that don't sync every day.

(Reported case: Vanadium showed 10h 10m on the Usage tab vs 26m in the Category
report and ~49m total in Trends — a 23× gap on a single device.)

## Two approaches

### A. Session backfill on (re)connect

Add a new IPC method on the child that returns per-day session lists for the
last N days, by calling `UsageStatsManager.queryEvents(startOfDay(D), endOfDay(D))`
for each missing day and reconstructing sessions. Parent requests it whenever
a child reconnects, computes the set of dates with no `sessions:` entry, and
asks for those.

**Pros:**
- Daily Summary view (per-session detail per day) works for backfilled days.
- Re-uses existing `sessions:` storage shape. No new Hyperbee key.

**Cons:**
- Reconstructed sessions may differ slightly from the live capture (event-merge
  gaps differ across runs; Android trims old events after 7-30 days).
- Cost: walking events for 7-30 days on every reconnect; mitigate by only
  fetching dates the parent confirms are missing.
- Doesn't fix the root mismatch — Trends is still derived from sessions, which
  for very old days (>30 days) Android may not retain.

**IPC shape:**

```
method: 'usage:backfillSessions'
args: { dates: ['2026-04-26', '2026-04-27', ...] }
returns: { '2026-04-26': [session, ...], ... }
```

Sent child→parent on demand. Parent merges via existing `mergeSessions`.

### B. Per-day aggregate query (no sessions for Trends/Category)

Switch Trends and Category to draw from a new `dailyTotals:{childPK}:{date}`
key whose value is `{ apps: [{ packageName, displayName, secondsToday }] }`.
The child populates it from `UsageStatsManager.queryAndAggregateUsageStats`
(per-app daily totals — same source `getWeeklyUsageAll` uses). On every
flush, child sends the last 30 days' totals; parent stores per-date.

**Pros:**
- Trends and Category match the Usage tab numbers exactly (same Android source).
- Rolls back automatically: when the child reconnects after a gap, the next
  flush brings the full 30-day history.
- No event reconstruction, much cheaper.

**Cons:**
- Daily Summary view (per-session detail) still depends on `sessions:`. Either
  keep capturing sessions for the current day only, or drop session-level
  detail.
- New Hyperbee key + new payload field on `usage:flush`. T2 wire change.

**IPC shape:**

```
usage:flush args adds:
  dailyTotals: [
    { date: '2026-04-30', apps: [{ packageName, displayName, secondsToday }] },
    { date: '2026-04-29', apps: [...] },
    ...
  ]
```

Parent stores `dailyTotals:{childPK}:{date}` per entry. `usage:getDailySummaries`
and `usage:getCategorySummary` read from `dailyTotals:` instead of `sessions:`.

### Recommendation: do both, in this order

1. **Land B first** (per-day aggregates). Fixes the headline discrepancy
   immediately — Trends and Category will agree with the Usage tab. Low
   reconstruction risk.
2. **Land A as a follow-up** when Daily Summary needs to work for missed days.
   Otherwise Daily Summary just shows "No app usage for this day" on missed
   days, which is honest if not great.

## Compat / migration (B)

- Old child + new parent: child doesn't send `dailyTotals`. Parent's Trends/
  Category fall back to legacy `sessions:`-based read. Behavior unchanged from
  today.
- New child + old parent: parent ignores the extra payload field. No-op.
- New child + new parent: aggregates flow; legacy `sessions:` read is the
  fallback so Daily Summary still works for today.

No Hyperbee migration. New keys are write-on-demand.

## Verify (B)

- Pair child to parent. Use Vanadium for ~5 minutes, lock screen.
- Wait for next 15-min flush.
- Open Usage Reports → Trends. 7-day total should match the Usage tab "Last 7
  days" sum across all apps.
- Open Category. Vanadium total over 7 days should match Vanadium's "Last 7
  days" on the Usage tab.
- Disconnect child overnight. Reconnect. Trends/Category should still show
  full history (provided child stayed alive enough to run a flush at any point
  during the missed days; if not, Android's persistent aggregates fill it on
  reconnect via the next flush's 30-day batch).

## Rollback

Revert the dispatch handlers; old `sessions:`-based code still in place under
the fallback branch.

## Open questions

- Backfill window: 30 days or 7? `queryAndAggregateUsageStats` caps at ~6
  months, so 30 is safe. Per-flush bandwidth cost: 30 × ~10 apps × ~50 bytes
  = ~15 KB. Fine.
- Parent should expire `dailyTotals:` rows older than 30 days to avoid
  unbounded growth — keep a sweep on init.
- Windows parity: the Windows tracker currently keeps a single weekly counter
  that resets Sunday. Bringing it to per-day buckets is a separate scope; for
  now, Windows children would only populate `dailyTotals` for today.
