#!/usr/bin/env node
// Stand-alone Node test for the usage-tracker observation guard. Reproduces the
// bug where an open session accrued unobserved wall-clock (machine suspended,
// screen locked, poll loop stalled) and invented hours of foreground usage.
// Runs without Electron or active-win. Exits 0 on pass, 1 on first failure.
// Run from desktop/: `node tests/usage-sleep.smoke.js`.

const assert = require('assert')
const { UsageTracker } = require('../src/enforcement/usage-tracker')
const { ForegroundMonitor } = require('../src/enforcement/foreground-monitor')

let passed = 0
function ok(name) { console.log('  ok -', name); passed++ }

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN

// Controllable clock so we can fast-forward through an overnight suspend.
function makeTracker(startTs, opts = {}) {
  const clock = { t: startTs }
  const tracker = new UsageTracker({
    now: () => clock.t,
    logger: { log() {}, error() {}, warn() {} },
    ...opts,
  })
  return { tracker, clock }
}

// Drive the monitor's 1s poll heartbeat for `seconds`, as ForegroundMonitor
// does in production (emits 'tick' every poll, not just on change).
function pollFor(tracker, clock, seconds, packageName, appName = null) {
  for (let i = 0; i < seconds; i++) {
    clock.t += SEC
    tracker.noteObserved({ packageName, appName })
  }
}

console.log('usage-tracker: observation guard')

// --- 1. Live accrual still works while the monitor is polling ---------------
{
  const base = new Date(2026, 0, 15, 9, 0, 0).getTime()  // 09:00 local
  const { tracker, clock } = makeTracker(base)
  tracker.noteForeground({ packageName: 'chrome', appName: 'Chrome' })
  pollFor(tracker, clock, 60, 'chrome', 'Chrome')
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 60)
  ok('60s of observed foreground time accrues normally')
}

// --- 2. THE BUG: an 8h suspend must not become 8h of usage ------------------
{
  const base = new Date(2026, 0, 15, 9, 0, 0).getTime()
  const { tracker, clock } = makeTracker(base)
  tracker.noteForeground({ packageName: 'chrome', appName: 'Chrome' })
  pollFor(tracker, clock, 60, 'chrome', 'Chrome')

  // Machine suspends: the poll timer stops firing. No observations at all.
  clock.t += 8 * HOUR

  // Old behaviour: reads virtually extended the open session to `now`,
  // returning 60 + 28800 seconds. The session must instead have been retired
  // at the last observation.
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 60,
    'suspend gap must not be credited as foreground usage')
  const all = tracker.getDailyUsageAll()
  assert.strictEqual(all.find((a) => a.packageName === 'chrome').secondsToday, 60)
  const weekly = tracker.getWeeklyUsageAll()
  assert.strictEqual(weekly.find((a) => a.packageName === 'chrome').secondsThisWeek, 60)
  ok('8h suspend adds 0s (reporting + weekly)')
}

// --- 3. Enforcement reads the same counters, so limits are safe too ---------
{
  const base = new Date(2026, 0, 15, 9, 0, 0).getTime()
  const { tracker, clock } = makeTracker(base)
  tracker.noteForeground({ packageName: 'chrome', appName: 'Chrome' })
  pollFor(tracker, clock, 30, 'chrome', 'Chrome')
  clock.t += 6 * HOUR  // overnight-ish suspend

  // block-evaluator calls getDailyUsageSeconds via _getUsageSeconds. A 1h
  // daily limit must not be considered spent after a suspend the kid slept
  // through.
  const usedSeconds = tracker.getDailyUsageSeconds('chrome')
  assert.ok(usedSeconds < 3600, 'phantom hours would have tripped a 1h limit')
  assert.strictEqual(usedSeconds, 30)
  ok('screen-time limit not tripped by a suspend gap')
}

// --- 4. Accrual resumes after wake (session must reopen) --------------------
{
  const base = new Date(2026, 0, 15, 9, 0, 0).getTime()
  const { tracker, clock } = makeTracker(base)
  tracker.noteForeground({ packageName: 'chrome', appName: 'Chrome' })
  pollFor(tracker, clock, 60, 'chrome', 'Chrome')
  clock.t += 8 * HOUR                                  // suspend
  pollFor(tracker, clock, 10, 'chrome', 'Chrome')      // wake: polls resume

  // foreground-changed only fires on a *change*, and the app never changed —
  // so the tick heartbeat is the only thing that can restart accrual.
  //
  // 69, not 70: the session reopens *at* the first post-wake observation, so
  // 10 polls bound 9 seconds of measured time. We deliberately don't credit the
  // instant before we saw the app again — that's the whole point of the guard.
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 69)
  ok('session reopens on the first poll after wake (60 + 9 measured)')
}

// --- 5. Locked workstation stops accrual -----------------------------------
{
  const base = new Date(2026, 0, 15, 9, 0, 0).getTime()
  const { tracker, clock } = makeTracker(base)
  tracker.noteForeground({ packageName: 'chrome', appName: 'Chrome' })
  pollFor(tracker, clock, 60, 'chrome', 'Chrome')

  // Win+L: active-win yields no window -> 'foreground-lost' -> noteObserved(null).
  tracker.noteObserved({ packageName: null })
  // Machine sits locked for an hour, still polling (screen locked, not asleep).
  pollFor(tracker, clock, 3600, null)

  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 60,
    'time on the lock screen must not count against the last-focused app')
  ok('1h locked adds 0s')
}

// --- 6. Suspend across midnight lands in the right day ---------------------
{
  const base = new Date(2026, 0, 15, 23, 0, 0).getTime()  // 23:00
  const { tracker, clock } = makeTracker(base)
  tracker.noteForeground({ packageName: 'chrome', appName: 'Chrome' })
  pollFor(tracker, clock, 600, 'chrome', 'Chrome')        // 10 min -> 23:10

  // Suspend overnight, wake at 09:00 the next morning.
  clock.t = new Date(2026, 0, 16, 9, 0, 0).getTime()

  // Today is a fresh day: the kid has used nothing yet. The 10 minutes belong
  // to yesterday, and the ~10h suspend belongs to nobody.
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 0,
    'overnight suspend must not seed the new day with phantom usage')

  const sessions = tracker.takeSessions()
  const s = sessions.find((x) => x.packageName === 'chrome')
  assert.ok(s, 'the pre-suspend session should have been emitted')
  assert.strictEqual(s.durationSeconds, 600)
  assert.strictEqual(s.endedAt, base + 600 * SEC, 'session ends at the last observation')
  ok('overnight suspend: 0s today, 600s session credited to the previous day')
}

// --- 7. A brief stall inside the grace window is tolerated ------------------
{
  const base = new Date(2026, 0, 15, 9, 0, 0).getTime()
  const { tracker, clock } = makeTracker(base)
  tracker.noteForeground({ packageName: 'chrome', appName: 'Chrome' })
  pollFor(tracker, clock, 60, 'chrome', 'Chrome')

  clock.t += 5 * SEC   // a slow active-win call, well under the 15s grace
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 65,
    'a short poll hiccup should not drop real usage')
  ok('5s poll hiccup still counts (grace window)')
}

// --- 8. ForegroundMonitor emits the heartbeat and the lost signal -----------
;(async () => {
  // Ticks every poll, even when the focused app does not change.
  const win = { owner: { path: 'C:\\p\\chrome.exe', processId: 1, name: 'Chrome' }, title: 't' }
  const mon = new ForegroundMonitor({ activeWin: async () => win })
  let ticks = 0
  let changes = 0
  mon.on('tick', () => ticks++)
  mon.on('foreground-changed', () => changes++)
  await mon._tick()
  await mon._tick()
  await mon._tick()
  assert.strictEqual(ticks, 3, 'tick fires on every poll')
  assert.strictEqual(changes, 1, 'foreground-changed still only fires on a change')
  ok('monitor: tick every poll, foreground-changed only on change')

  // No window (locked workstation) -> foreground-lost, and the next sighting of
  // the same app re-emits foreground-changed.
  let lost = 0
  const mon2 = new ForegroundMonitor({ activeWin: async () => cur })
  let cur = win
  mon2.on('foreground-lost', () => lost++)
  let changes2 = 0
  mon2.on('foreground-changed', () => changes2++)
  await mon2._tick()
  cur = null
  await mon2._tick()
  cur = win
  await mon2._tick()
  assert.strictEqual(lost, 1, 'foreground-lost fires when active-win yields nothing')
  assert.strictEqual(changes2, 2, 'returning to the same app after a lock re-emits the change')
  ok('monitor: foreground-lost on locked screen, re-emits on unlock')

  console.log(`\n${passed} checks passed`)
})().catch((e) => {
  console.error('\nFAILED:', e.message)
  process.exit(1)
})
