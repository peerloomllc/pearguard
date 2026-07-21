#!/usr/bin/env node
// Stand-alone Node test for the usage-tracker clock-tamper guard. Reproduces the
// bug where moving the clock (or just the timezone) forward past local midnight
// and then back handed the child a fresh daily budget for the rest of the real
// day, and pins the legitimate rollovers that must keep zeroing.
// Runs without Electron or active-win. Exits 0 on pass, 1 on first failure.
// Run from desktop/: `node tests/clock-tamper.smoke.js`.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { UsageTracker } = require('../src/enforcement/usage-tracker')

let passed = 0
function ok(name) { console.log('  ok -', name); passed++ }

const SEC = 1000
const MIN = 60 * SEC
const HOUR = 60 * MIN
const QUIET = { log() {}, error() {}, warn() {} }

function makeTracker(startTs, opts = {}) {
  const clock = { t: startTs }
  const tracker = new UsageTracker({ now: () => clock.t, logger: QUIET, ...opts })
  return { tracker, clock }
}

// Accrue `seconds` of foreground time on `pkg`, the way the 1s monitor poll does,
// then close the session so we are asserting against settled counters only.
function burn(tracker, clock, seconds, pkg = 'chrome') {
  tracker.noteForeground({ packageName: pkg, appName: 'Chrome' })
  for (let i = 0; i < seconds; i++) {
    clock.t += SEC
    tracker.noteObserved({ packageName: pkg, appName: 'Chrome' })
  }
  tracker.endActive()
}

console.log('usage-tracker: clock tamper')

// --- 1. THE BUG: forward past midnight, then back = free budget -------------
{
  const base = new Date(2026, 0, 15, 20, 0, 0).getTime()  // Thu 20:00 local
  const { tracker, clock } = makeTracker(base)
  burn(tracker, clock, 600)
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 600, 'baseline accrual')

  // Kid winds the clock past midnight. This legitimately looks like a new day.
  clock.t = new Date(2026, 0, 16, 1, 0, 0).getTime()
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 0, 'new day starts empty')

  // ...and winds it straight back to the real time. Before the fix the tracker
  // refused to roll backwards, so the zeroed counters stood and the rest of the
  // real Thursday was budget-free.
  clock.t = base + 10 * MIN
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 600, 'day-15 counters restored')
  ok('clock forward past midnight then back does NOT reset the daily budget')
}

// --- 2. Same trick against the weekly budget --------------------------------
{
  const base = new Date(2026, 0, 15, 20, 0, 0).getTime()  // Thu, week began Sun 11th
  const { tracker, clock } = makeTracker(base)
  burn(tracker, clock, 900)
  const weekOf = (t) => {
    const row = t.getWeeklyUsageAll().find((r) => r.packageName === 'chrome')
    return row ? row.secondsThisWeek : 0
  }
  assert.strictEqual(weekOf(tracker), 900, 'baseline weekly accrual')

  clock.t = new Date(2026, 0, 18, 9, 0, 0).getTime()   // Sun 18th, a new week
  assert.strictEqual(weekOf(tracker), 0, 'new week starts empty')
  clock.t = base + 10 * MIN
  assert.strictEqual(weekOf(tracker), 900, 'week-of-11th counters restored')
  ok('clock forward past Sunday then back does NOT reset the weekly budget')
}

// --- 3. Backward FIRST, then forward, is the same hole in reverse -----------
{
  const base = new Date(2026, 0, 15, 20, 0, 0).getTime()
  const { tracker, clock } = makeTracker(base)
  burn(tracker, clock, 600)

  // Wind back to yesterday. Whatever we serve there, coming home must not be a
  // fresh start: day 15 has been served and its counters have to come back.
  clock.t = new Date(2026, 0, 14, 20, 0, 0).getTime()
  burn(tracker, clock, 60)
  clock.t = base + 10 * MIN
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 600, 'day-15 counters restored intact')
  ok('clock backward then forward again does NOT reset the daily budget')
}

// --- 4. THE OTHER WAY IN: a timezone shift, no admin rights needed ----------
// Date.now() is UTC epoch ms and never moves, but localDayStart() is local, so
// shifting the zone moves the day boundary underneath the tracker. Unlike the
// clock cases the budget must hold WHILE shifted, not just on the way back:
// the day moving forward while the week moves backward is impossible for real
// elapsed time, so it is caught outright.
{
  const original = process.env.TZ
  try {
    process.env.TZ = 'UTC'
    const base = Date.UTC(2026, 0, 15, 20, 0, 0)   // Thu 20:00 UTC
    const { tracker, clock } = makeTracker(base)
    burn(tracker, clock, 600)
    assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 600, 'baseline accrual in UTC')
    const events = []
    tracker.on('clock-tamper', (info) => events.push(info))

    // UTC+14: same instant, but local time is now 10:00 on Fri the 16th.
    process.env.TZ = 'Pacific/Kiritimati'
    assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 600, 'no fresh budget while shifted')
    assert.strictEqual(events.length, 1, 'and the parent is told')
    assert.strictEqual(events[0].window, 'zone')

    // The guard deliberately leaves the windows alone, so the contradiction is
    // still there on every later poll. It must not alert once a second.
    // packageName null so the poll drives _syncTo without accruing usage of its
    // own, which would confound the counter assertion below.
    for (let i = 0; i < 120; i++) {
      clock.t += SEC
      tracker.noteObserved({ packageName: null })
    }
    assert.strictEqual(events.length, 1, 'staying shifted does not restate the alert every poll')

    process.env.TZ = 'UTC'
    assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 600, 'still intact once shifted back')
    ok('timezone shift forward does NOT reset the daily budget, even while shifted')
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
}

// --- 5. REGRESSION GUARD: a real midnight still zeroes ----------------------
{
  const base = new Date(2026, 0, 15, 23, 50, 0).getTime()
  const { tracker, clock } = makeTracker(base)
  burn(tracker, clock, 300)
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 300, 'baseline')

  // Walk over midnight the way the 1s poll actually does.
  for (let i = 0; i < 15 * 60; i++) {
    clock.t += SEC
    tracker.noteObserved({ packageName: null })
  }
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 0, 'genuine new day is empty')
  ok('a genuine midnight crossing still zeroes the daily counters')
}

// --- 6. REGRESSION GUARD: overnight suspend still rolls the day -------------
{
  const base = new Date(2026, 0, 15, 23, 0, 0).getTime()
  const { tracker, clock } = makeTracker(base)
  burn(tracker, clock, 600)
  // Machine sleeps through midnight and wakes on a genuinely new day. Forward
  // into a window never served, so nothing to restore and no tamper.
  let tampers = 0
  tracker.on('clock-tamper', () => tampers++)
  clock.t = new Date(2026, 0, 16, 8, 0, 0).getTime()
  assert.strictEqual(tracker.getDailyUsageSeconds('chrome'), 0, 'new day after suspend is empty')
  assert.strictEqual(tampers, 0, 'a suspend is not tampering')
  ok('overnight suspend still rolls the day and raises no false accusation')
}

// --- 7. The parent gets told, and only when it is really tampering ----------
{
  const base = new Date(2026, 0, 15, 20, 0, 0).getTime()
  const { tracker, clock } = makeTracker(base)
  burn(tracker, clock, 600)
  const events = []
  tracker.on('clock-tamper', (info) => events.push(info))

  clock.t = new Date(2026, 0, 16, 1, 0, 0).getTime()
  tracker.getDailyUsageSeconds('chrome')
  assert.strictEqual(events.length, 0, 'moving forward alone is not yet provable tampering')

  clock.t = base + 10 * MIN
  tracker.getDailyUsageSeconds('chrome')
  assert.strictEqual(events.length, 1, 'coming back into a served window is')
  assert.strictEqual(events[0].window, 'day')
  assert.strictEqual(events[0].direction, 'backward')
  assert.strictEqual(events[0].restoredSeconds, 600, 'reports what it put back')
  ok('clock-tamper fires on the return leg, with the restored total')
}

// --- 8. Restarting the app between the two clock changes must not help ------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearguard-clock-'))
  const filePath = path.join(dir, 'usage.json')
  try {
    const base = new Date(2026, 0, 15, 20, 0, 0).getTime()
    const first = makeTracker(base, { filePath })
    burn(first.tracker, first.clock, 600)

    // Forward past midnight, then quit the app while the clock is still wrong.
    first.clock.t = new Date(2026, 0, 16, 1, 0, 0).getTime()
    assert.strictEqual(first.tracker.getDailyUsageSeconds('chrome'), 0, 'zeroed on the fake day')

    // Clock goes back, app restarts. The old _load dropped any counters whose
    // window was not today, which is a fresh budget by another route.
    const clock = { t: base + 10 * MIN }
    const reloaded = new UsageTracker({ filePath, now: () => clock.t, logger: QUIET })
    assert.strictEqual(reloaded.getDailyUsageSeconds('chrome'), 600, 'restored across the restart')

    const tampers = []
    reloaded.on('clock-tamper', (info) => tampers.push(info))
    reloaded.getDailyUsageSeconds('chrome')
    assert.strictEqual(tampers.length, 1, 'a tamper found during load is still reported')
    ok('restarting the app between the clock changes does NOT reset the budget')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// --- 9. A restart on a genuinely new day still starts clean -----------------
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pearguard-clock-'))
  const filePath = path.join(dir, 'usage.json')
  try {
    const base = new Date(2026, 0, 15, 20, 0, 0).getTime()
    const first = makeTracker(base, { filePath })
    burn(first.tracker, first.clock, 600)

    const clock = { t: new Date(2026, 0, 16, 9, 0, 0).getTime() }
    const reloaded = new UsageTracker({ filePath, now: () => clock.t, logger: QUIET })
    assert.strictEqual(reloaded.getDailyUsageSeconds('chrome'), 0, 'new day after a restart is empty')
    ok('a restart on a genuinely new day still starts from zero')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// --- 10. The archive cannot grow without bound ------------------------------
{
  const { tracker, clock } = makeTracker(new Date(2026, 0, 1, 12, 0, 0).getTime())
  for (let day = 1; day <= 40; day++) {
    clock.t = new Date(2026, 0, day, 12, 0, 0).getTime()
    burn(tracker, clock, 5)
  }
  assert.ok(tracker._dayArchive.size <= 8, 'day archive is capped, got ' + tracker._dayArchive.size)
  assert.ok(tracker._weekArchive.size <= 3, 'week archive is capped, got ' + tracker._weekArchive.size)
  ok('the archive is bounded as days go by')
}

console.log(`\n${passed} checks passed`)
