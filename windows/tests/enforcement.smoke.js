#!/usr/bin/env node
// Stand-alone Node smoke test for the Windows enforcement modules. Runs
// without Electron, without active-win, without any P2P backend. Exits 0 on
// pass, 1 on first failure. Run from windows/: `node tests/enforcement.smoke.js`.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { evaluate, isSystemExempt } = require('../src/enforcement/block-evaluator')
const { ExeMap, UWP_HOST_BASENAMES } = require('../src/enforcement/exe-map')
const { PolicyCache } = require('../src/enforcement/policy-cache')
const { ForegroundMonitor } = require('../src/enforcement/foreground-monitor')
const { OverridesStore } = require('../src/enforcement/overrides-store')
const { EnforcementController } = require('../src/enforcement')
const { UsageTracker, localDayStart, localWeekStart } = require('../src/enforcement/usage-tracker')
const { enumerateInstalledApps, extractExeBasename, extractExePath, slugify, parseAndShape, parseUwpAndShape, mergeRows } = require('../src/enforcement/apps-enumerator')
const { extractWin32Icons, extractUwpIcons, buildWin32Script, buildUwpScript, parseRows } = require('../src/enforcement/icon-extractor')
const { verifyPin, hashPin } = require('../src/enforcement/pin-verify')

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

// --- Fixture builders ----------------------------------------------------

function policy(extra = {}) {
  return {
    apps: {
      'com.discord': { status: 'allowed', appName: 'Discord', category: 'Social' },
      'com.spotify.music': { status: 'allowed', appName: 'Spotify', category: 'Music' },
      'com.android.chrome': { status: 'allowed', appName: 'Chrome' },
      'com.roblox.client': { status: 'blocked', appName: 'Roblox' },
      'com.pending.example': { status: 'pending', appName: 'Pending app' },
      'com.limited.example': { status: 'allowed', appName: 'Limited', dailyLimitSeconds: 600 },
    },
    categories: { Social: { dailyLimitSeconds: 1200 } },
    schedules: [],
    version: 1,
    ...extra,
  }
}

// 2026-04-16 is a Thursday → dayOfWeek 4
const THURSDAY_NOON = new Date('2026-04-16T12:00:00').getTime()
const THURSDAY_2300 = new Date('2026-04-16T23:00:00').getTime()
const THURSDAY_0500 = new Date('2026-04-16T05:00:00').getTime()

// --- Evaluator tests -----------------------------------------------------

test('isSystemExempt allows shell processes', () => {
  assert.strictEqual(isSystemExempt('explorer.exe'), true)
  assert.strictEqual(isSystemExempt('SearchApp.exe'), true)
  assert.strictEqual(isSystemExempt('chrome.exe'), false)
})

test('isSystemExempt covers Win11 host processes (ApplicationFrameHost, RuntimeBroker, etc.)', () => {
  // These are Windows-owned host processes that briefly take focus when UWP
  // apps launch or capability prompts appear. The raw host itself is not
  // something a parent can meaningfully block — the hosted UWP needs to be
  // resolved separately (title-based or subprocess-based) and evaluated on
  // its own packageName. Case-insensitive to match Win32's filesystem rules.
  assert.strictEqual(isSystemExempt('ApplicationFrameHost.exe'), true)
  assert.strictEqual(isSystemExempt('RuntimeBroker.exe'), true)
  assert.strictEqual(isSystemExempt('SearchHost.exe'), true)
  assert.strictEqual(isSystemExempt('TextInputHost.exe'), true)
  assert.strictEqual(isSystemExempt('Widgets.exe'), true)
})

test('exempt host exe short-circuits enforcement even under device lock', () => {
  // Locks apply to everything non-exempt, so this confirms the host exempt
  // is on the allow-always path — a UWP focus blip that reports as
  // ApplicationFrameHost.exe won't trap the child behind a bedtime lock.
  const r = evaluate({
    policy: policy({ locked: true, lockMessage: 'Bedtime' }),
    packageName: null,
    exeBasename: 'ApplicationFrameHost.exe',
  })
  assert.strictEqual(r, null)
})

test('exempt exe short-circuits even without policy', () => {
  const r = evaluate({ policy: null, packageName: null, exeBasename: 'explorer.exe' })
  assert.strictEqual(r, null)
})

test('no policy → allow', () => {
  const r = evaluate({ policy: null, packageName: 'com.discord', exeBasename: 'discord.exe' })
  assert.strictEqual(r, null)
})

test('unmapped exe → allow (no packageName)', () => {
  const r = evaluate({ policy: policy(), packageName: null, exeBasename: 'mystery.exe' })
  assert.strictEqual(r, null)
})

test('unknown packageName → allow (Android default)', () => {
  const r = evaluate({ policy: policy(), packageName: 'com.totally.unknown', exeBasename: 'foo.exe' })
  assert.strictEqual(r, null)
})

test('device lock blocks unmapped exe (no packageName)', () => {
  const r = evaluate({
    policy: policy({ locked: true, lockMessage: 'Bedtime' }),
    packageName: null,
    exeBasename: 'mystery.exe',
  })
  assert.deepStrictEqual(r, { reason: 'Bedtime', category: 'lock' })
})

test('schedule blocks unmapped exe (no packageName) during blackout', () => {
  const r = evaluate({
    policy: policy({
      schedules: [{ label: 'School', days: [4], start: '08:00', end: '15:00' }],
    }),
    packageName: null,
    exeBasename: 'mystery.exe',
    now: THURSDAY_NOON,
  })
  assert.strictEqual(r.category, 'schedule')
})

test('schedule does not block unmapped exe outside blackout', () => {
  const r = evaluate({
    policy: policy({
      schedules: [{ label: 'School', days: [4], start: '08:00', end: '15:00' }],
    }),
    packageName: null,
    exeBasename: 'mystery.exe',
    now: THURSDAY_2300,
  })
  assert.strictEqual(r, null)
})

test('device lock blocks even allowed apps', () => {
  const r = evaluate({
    policy: policy({ locked: true, lockMessage: 'Bedtime' }),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
  })
  assert.deepStrictEqual(r, { reason: 'Bedtime', category: 'lock' })
})

test('device lock with empty message uses default text', () => {
  const r = evaluate({
    policy: policy({ locked: true, lockMessage: '' }),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
  })
  assert.strictEqual(r.category, 'lock')
  assert.ok(r.reason.includes('locked'))
})

test('active override beats device lock? — no, lock check is Step 0', () => {
  // Mirrors Android: device lock is Step 0, before override check. Verifying
  // we kept that ordering so a kid with a stale PIN override can't bypass a
  // bedtime lock.
  const overrides = new Map([['com.discord', Date.now() + 60_000]])
  const r = evaluate({
    policy: policy({ locked: true }),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
    overrides,
  })
  assert.strictEqual(r.category, 'lock')
})

test('active override beats blocked status', () => {
  const overrides = new Map([['com.roblox.client', Date.now() + 60_000]])
  const r = evaluate({
    policy: policy(),
    packageName: 'com.roblox.client',
    exeBasename: 'roblox.exe',
    overrides,
  })
  assert.strictEqual(r, null)
})

test('expired override is ignored', () => {
  const overrides = new Map([['com.roblox.client', Date.now() - 1000]])
  const r = evaluate({
    policy: policy(),
    packageName: 'com.roblox.client',
    exeBasename: 'roblox.exe',
    overrides,
  })
  assert.strictEqual(r.category, 'status')
})

test('schedule blocks during a same-day blackout', () => {
  const r = evaluate({
    policy: policy({
      schedules: [{ label: 'School', days: [4], start: '08:00', end: '15:00' }],
    }),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
    now: THURSDAY_NOON,
  })
  assert.strictEqual(r.category, 'schedule')
  assert.ok(r.reason.includes('School'))
})

test('schedule does not block on non-matching day', () => {
  const r = evaluate({
    policy: policy({
      schedules: [{ label: 'School', days: [1, 2, 3], start: '08:00', end: '15:00' }],
    }),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
    now: THURSDAY_NOON,
  })
  assert.strictEqual(r, null)
})

test('schedule respects exemptApps', () => {
  const r = evaluate({
    policy: policy({
      schedules: [{
        label: 'School', days: [4], start: '08:00', end: '15:00',
        exemptApps: ['com.discord'],
      }],
    }),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
    now: THURSDAY_NOON,
  })
  assert.strictEqual(r, null)
})

test('overnight schedule blocks at 23:00', () => {
  const r = evaluate({
    policy: policy({
      schedules: [{ label: 'Bedtime', days: [4], start: '21:00', end: '07:00' }],
    }),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
    now: THURSDAY_2300,
  })
  assert.strictEqual(r.category, 'schedule')
})

test('overnight schedule blocks at 05:00 (still in window)', () => {
  // Note: overnight rules apply on the day they STARTED. Android compares
  // against the current day-of-week at the wall clock instant we're testing,
  // and the rule on that day's row says 21:00–07:00 wraps. So "Thursday's"
  // bedtime rule should also be in effect at Thursday 05:00.
  const r = evaluate({
    policy: policy({
      schedules: [{ label: 'Bedtime', days: [4], start: '21:00', end: '07:00' }],
    }),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
    now: THURSDAY_0500,
  })
  assert.strictEqual(r.category, 'schedule')
})

test('status blocked → block', () => {
  const r = evaluate({
    policy: policy(),
    packageName: 'com.roblox.client',
    exeBasename: 'roblox.exe',
  })
  assert.strictEqual(r.category, 'status')
  assert.ok(r.reason.includes('Not approved'))
})

test('status pending → block', () => {
  const r = evaluate({
    policy: policy(),
    packageName: 'com.pending.example',
    exeBasename: 'pending.exe',
  })
  assert.strictEqual(r.category, 'status')
  assert.ok(r.reason.includes('approval'))
})

test('per-app daily limit reached → block', () => {
  const r = evaluate({
    policy: policy(),
    packageName: 'com.limited.example',
    exeBasename: 'limited.exe',
    getUsageSeconds: (pkg) => pkg === 'com.limited.example' ? 700 : 0,
  })
  assert.strictEqual(r.category, 'daily_limit')
})

test('per-app daily limit not reached → allow', () => {
  const r = evaluate({
    policy: policy(),
    packageName: 'com.limited.example',
    exeBasename: 'limited.exe',
    getUsageSeconds: () => 100,
  })
  assert.strictEqual(r, null)
})

test('per-app limit takes precedence over category fallback', () => {
  // com.limited.example has a per-app limit AND would qualify for a category
  // fallback if it had no per-app limit. Per-app must win.
  const p = policy({
    categories: { Limited: { dailyLimitSeconds: 60 } },
  })
  p.apps['com.limited.example'].category = 'Limited'
  const r = evaluate({
    policy: p,
    packageName: 'com.limited.example',
    exeBasename: 'limited.exe',
    getUsageSeconds: () => 200,  // over category, under per-app
  })
  assert.strictEqual(r, null)  // per-app limit (600) governs, 200 < 600
})

test('category limit fallback blocks when summed usage exceeds budget', () => {
  // Discord + Spotify both Social? No, Spotify is Music. Use Discord alone.
  // Bump the category budget so it's the limiting factor.
  const r = evaluate({
    policy: policy({ categories: { Social: { dailyLimitSeconds: 300 } } }),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
    getUsageSeconds: (pkg) => pkg === 'com.discord' ? 400 : 0,
  })
  assert.strictEqual(r.category, 'category_limit')
})

test('category limit fallback allows when under budget', () => {
  const r = evaluate({
    policy: policy(),
    packageName: 'com.discord',
    exeBasename: 'discord.exe',
    getUsageSeconds: () => 100,
  })
  assert.strictEqual(r, null)
})

// --- ExeMap --------------------------------------------------------------

test('ExeMap resolves common browsers', () => {
  const m = new ExeMap()
  assert.strictEqual(m.resolve('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), 'com.android.chrome')
  assert.strictEqual(m.resolve('C:\\Program Files\\Mozilla Firefox\\firefox.exe'), 'org.mozilla.firefox')
})

test('ExeMap is case-insensitive', () => {
  const m = new ExeMap()
  assert.strictEqual(m.resolve('C:\\Games\\Roblox\\RobloxPlayerBeta.EXE'), 'com.roblox.client')
})

test('ExeMap returns null for unknown', () => {
  const m = new ExeMap()
  assert.strictEqual(m.resolve('C:\\foo\\mystery.exe'), null)
})

test('ExeMap.learn adds runtime mappings', () => {
  const m = new ExeMap({})
  m.learn('foobar.exe', 'com.example.foobar')
  assert.strictEqual(m.resolve('C:\\foobar.exe'), 'com.example.foobar')
})

test('ExeMap.learnUwp/resolveUwpByTitle round-trip matches titles case- and punct-insensitively', () => {
  const m = new ExeMap({})
  m.learnUwp({ title: 'Calculator', packageName: 'uwp.microsoft_windowscalculator_8wekyb3d8bbwe', exeBasename: 'calculatorapp.exe' })
  assert.deepStrictEqual(
    m.resolveUwpByTitle('Calculator'),
    { packageName: 'uwp.microsoft_windowscalculator_8wekyb3d8bbwe', exeBasename: 'calculatorapp.exe' },
  )
  // Case and punctuation drop out of normalization.
  assert.deepStrictEqual(
    m.resolveUwpByTitle('CALCULATOR'),
    { packageName: 'uwp.microsoft_windowscalculator_8wekyb3d8bbwe', exeBasename: 'calculatorapp.exe' },
  )
  assert.strictEqual(m.resolveUwpByTitle('Unknown App'), null)
  assert.strictEqual(m.resolveUwpByTitle(''), null)
  assert.strictEqual(m.resolveUwpByTitle(null), null)
})

test('ExeMap.learnUwp allows null exeBasename for pure UWP apps', () => {
  const m = new ExeMap({})
  m.learnUwp({ title: 'Microsoft Store', packageName: 'uwp.microsoft_windowsstore_8wekyb3d8bbwe' })
  assert.deepStrictEqual(
    m.resolveUwpByTitle('Microsoft Store'),
    { packageName: 'uwp.microsoft_windowsstore_8wekyb3d8bbwe', exeBasename: null },
  )
})

test('UWP_HOST_BASENAMES covers ApplicationFrameHost', () => {
  assert.strictEqual(UWP_HOST_BASENAMES.has('applicationframehost.exe'), true)
})

// --- PolicyCache ---------------------------------------------------------

test('PolicyCache parses valid JSON and emits change', () => {
  const c = new PolicyCache()
  let emitted = null
  c.on('change', (p) => { emitted = p })
  const ok = c.setPolicyJson(JSON.stringify({ apps: {}, version: 7 }))
  assert.strictEqual(ok, true)
  assert.strictEqual(c.getPolicy().version, 7)
  assert.strictEqual(emitted.version, 7)
})

test('PolicyCache rejects invalid JSON without crashing', () => {
  const c = new PolicyCache()
  // Suppress expected error log noise for this assertion.
  const origErr = console.error
  console.error = () => {}
  const ok = c.setPolicyJson('{not json')
  console.error = origErr
  assert.strictEqual(ok, false)
  assert.strictEqual(c.getPolicy(), null)
})

// --- ForegroundMonitor ---------------------------------------------------

test('ForegroundMonitor emits only on focus change', async () => {
  let calls = 0
  const responses = [
    { owner: { path: 'C:\\a.exe', processId: 1, name: 'a' }, title: 'first' },
    { owner: { path: 'C:\\a.exe', processId: 1, name: 'a' }, title: 'first' },
    { owner: { path: 'C:\\b.exe', processId: 2, name: 'b' }, title: 'second' },
  ]
  const fakeActiveWin = async () => responses[Math.min(calls++, responses.length - 1)]
  const m = new ForegroundMonitor({ activeWin: fakeActiveWin, intervalMs: 5 })
  const seen = []
  m.on('foreground-changed', (info) => seen.push(info))
  m.start()
  await new Promise(r => setTimeout(r, 50))
  m.stop()
  assert.strictEqual(seen.length, 2, 'expected 2 distinct windows, got ' + seen.length)
  assert.strictEqual(seen[0].exePath, 'C:\\a.exe')
  assert.strictEqual(seen[1].exePath, 'C:\\b.exe')
})

test('ForegroundMonitor surfaces active-win errors as events', async () => {
  const fakeActiveWin = async () => { throw new Error('boom') }
  const m = new ForegroundMonitor({ activeWin: fakeActiveWin, intervalMs: 5 })
  const errs = []
  m.on('error', (e) => errs.push(e))
  m.start()
  await new Promise(r => setTimeout(r, 30))
  m.stop()
  assert.ok(errs.length >= 1)
  assert.strictEqual(errs[0].message, 'boom')
})

// --- OverridesStore ------------------------------------------------------

function tmpStorePath() {
  return path.join(os.tmpdir(), 'pearguard-test-overrides-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

test('OverridesStore.applyGrant adds entry and emits grant event', () => {
  const s = new OverridesStore({ filePath: null })
  let emitted = null
  s.on('grant', (g) => { emitted = g })
  const exp = Date.now() + 60_000
  const result = s.applyGrant({ packageName: 'com.foo', expiresAt: exp })
  assert.strictEqual(result, exp)
  assert.strictEqual(s.asMap().get('com.foo'), exp)
  assert.deepStrictEqual(emitted, { packageName: 'com.foo', expiresAt: exp })
})

test('OverridesStore.applyGrant rejects past expiry', () => {
  const s = new OverridesStore({ filePath: null })
  const result = s.applyGrant({ packageName: 'com.foo', expiresAt: Date.now() - 1000 })
  assert.strictEqual(result, null)
  assert.strictEqual(s.asMap().has('com.foo'), false)
})

test('OverridesStore persists across instantiations', () => {
  const filePath = tmpStorePath()
  try {
    const exp = Date.now() + 60_000
    const a = new OverridesStore({ filePath })
    a.applyGrant({ packageName: 'com.foo', expiresAt: exp })
    const b = new OverridesStore({ filePath })
    assert.strictEqual(b.asMap().get('com.foo'), exp)
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
})

test('OverridesStore drops already-expired entries on load', () => {
  const filePath = tmpStorePath()
  try {
    fs.writeFileSync(filePath, JSON.stringify({ 'com.fresh': Date.now() + 60_000, 'com.stale': Date.now() - 60_000 }))
    const s = new OverridesStore({ filePath })
    assert.strictEqual(s.asMap().has('com.fresh'), true)
    assert.strictEqual(s.asMap().has('com.stale'), false)
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
})

test('OverridesStore.prune removes expired entries', () => {
  const s = new OverridesStore({ filePath: null })
  s.asMap().set('com.future', Date.now() + 60_000)
  s.asMap().set('com.past', Date.now() - 1000)
  const removed = s.prune()
  assert.strictEqual(removed, 1)
  assert.strictEqual(s.asMap().has('com.past'), false)
  assert.strictEqual(s.asMap().has('com.future'), true)
})

// --- UsageTracker --------------------------------------------------------

function tmpUsagePath() {
  return path.join(os.tmpdir(), 'pearguard-test-usage-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

// Tests run in whatever TZ the CI host picks. Anchor "now" to local-noon so
// the rollover tests can walk seconds/minutes without accidentally crossing a
// boundary during test execution.
function localNoonToday() {
  const d = new Date()
  d.setHours(12, 0, 0, 0)
  return d.getTime()
}

test('UsageTracker.noteForeground accrues seconds to the previous package', () => {
  let t = localNoonToday()
  const u = new UsageTracker({ now: () => t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  t += 45_000
  u.noteForeground({ packageName: 'com.roblox.client', appName: 'Roblox' })
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 45)
  // New session has just started, so ~0 seconds accrued so far.
  assert.strictEqual(u.getDailyUsageSeconds('com.roblox.client'), 0)
  t += 30_000
  assert.strictEqual(u.getDailyUsageSeconds('com.roblox.client'), 30)
})

test('UsageTracker includes in-flight session in getDailyUsageSeconds', () => {
  let t = localNoonToday()
  const u = new UsageTracker({ now: () => t })
  u.noteForeground({ packageName: 'com.discord' })
  t += 10_000
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 10)
})

test('UsageTracker ignores unmapped foreground (no packageName)', () => {
  let t = localNoonToday()
  const u = new UsageTracker({ now: () => t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  t += 20_000
  u.noteForeground({ packageName: null })
  t += 60_000
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 20)
  assert.strictEqual(u.getLastForegroundPackage(), null)
})

test('UsageTracker.takeSessions drains and re-opens the active session', () => {
  let t = localNoonToday()
  const u = new UsageTracker({ now: () => t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  t += 30_000
  u.noteForeground({ packageName: 'com.roblox.client', appName: 'Roblox' })
  t += 20_000

  const first = u.takeSessions()
  assert.strictEqual(first.length, 2, 'expected discord-close + roblox-snapshot')
  assert.strictEqual(first[0].packageName, 'com.discord')
  assert.strictEqual(first[1].packageName, 'com.roblox.client')
  // Accrued time lives on in daily after takeSessions.
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 30)
  assert.strictEqual(u.getDailyUsageSeconds('com.roblox.client'), 20)

  // Continuing in Roblox — next takeSessions should contain only the new slice.
  t += 10_000
  const second = u.takeSessions()
  assert.strictEqual(second.length, 1)
  assert.strictEqual(second[0].packageName, 'com.roblox.client')
  assert.strictEqual(u.getDailyUsageSeconds('com.roblox.client'), 30)
})

test('UsageTracker daily rollover zeros daily but preserves weekly', () => {
  let t = localNoonToday()
  const u = new UsageTracker({ now: () => t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  t += 60_000
  u.noteForeground({ packageName: null })  // close the session cleanly
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 60)

  // Jump forward 24h — daily resets, weekly keeps the 60s (same week unless
  // we also cross Sunday; localNoonToday + 24h stays inside the same week as
  // long as "today" isn't Saturday). Check both and adjust expectations.
  const startOfThisWeek = localWeekStart(localNoonToday())
  t = localNoonToday() + 24 * 3600 * 1000
  const acrossWeek = localWeekStart(t) !== startOfThisWeek

  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 0)
  const weekly = u.getWeeklyUsageAll().find((x) => x.packageName === 'com.discord')
  if (acrossWeek) {
    assert.strictEqual(weekly, undefined, 'weekly should reset if day+1 crosses week boundary')
  } else {
    assert.strictEqual(weekly.secondsThisWeek, 60)
  }
})

test('UsageTracker splits a session that straddles local midnight', () => {
  // Start 30 minutes before midnight, end 10 minutes after.
  const tomorrow = new Date()
  tomorrow.setHours(0, 0, 0, 0)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const midnight = tomorrow.getTime()
  let t = midnight - 30 * 60 * 1000
  const u = new UsageTracker({ now: () => t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  t = midnight + 10 * 60 * 1000
  u.noteForeground({ packageName: null })  // close

  // After midnight, the old day is gone — daily counter for discord is the
  // 10 minutes that landed in the new day.
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 600)
})

test('UsageTracker persists daily/weekly across instantiations on the same day', () => {
  const filePath = tmpUsagePath()
  try {
    let t = localNoonToday()
    const a = new UsageTracker({ filePath, now: () => t })
    a.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
    t += 120_000
    a.endActive()  // persists

    const b = new UsageTracker({ filePath, now: () => t })
    assert.strictEqual(b.getDailyUsageSeconds('com.discord'), 120)
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
})

test('UsageTracker drops stored daily totals from a prior day on load', () => {
  const filePath = tmpUsagePath()
  try {
    const yesterday = localDayStart(Date.now()) - 24 * 3600 * 1000
    fs.writeFileSync(filePath, JSON.stringify({
      dayStart: yesterday,
      weekStart: localWeekStart(Date.now()),
      daily: { 'com.discord': 999 },
      weekly: { 'com.discord': 999 },
    }))
    const u = new UsageTracker({ filePath })
    // Daily reset because the stored dayStart doesn't match today.
    assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 0)
    // Weekly kept because weekStart still matches.
    const weekly = u.getWeeklyUsageAll().find((x) => x.packageName === 'com.discord')
    assert.strictEqual(weekly.secondsThisWeek, 999)
  } finally {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }
})

test('UsageTracker getDailyUsageAll surfaces display names', () => {
  let t = localNoonToday()
  const u = new UsageTracker({ now: () => t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  t += 30_000
  u.noteForeground({ packageName: 'com.roblox.client', appName: 'Roblox' })
  const list = u.getDailyUsageAll()
  const discord = list.find((x) => x.packageName === 'com.discord')
  const roblox = list.find((x) => x.packageName === 'com.roblox.client')
  assert.strictEqual(discord.appName, 'Discord')
  assert.strictEqual(roblox.appName, 'Roblox')
})

// --- apps-enumerator -----------------------------------------------------

test('extractExeBasename strips icon index and quotes', () => {
  assert.strictEqual(extractExeBasename('C:\\Program Files\\App\\app.exe,0'), 'app.exe')
  assert.strictEqual(extractExeBasename('"C:\\Program Files\\App\\app.exe",0'), 'app.exe')
  assert.strictEqual(extractExeBasename('C:\\Games\\Roblox\\RobloxPlayerBeta.exe'), 'robloxplayerbeta.exe')
  assert.strictEqual(extractExeBasename(''), null)
  assert.strictEqual(extractExeBasename(null), null)
  assert.strictEqual(extractExeBasename('C:\\no-exe-here\\readme.txt'), null)
})

test('slugify produces safe packageName suffixes', () => {
  assert.strictEqual(slugify('Microsoft Edge'), 'microsoft_edge')
  assert.strictEqual(slugify('OBS Studio (x64)'), 'obs_studio_x64')
  assert.strictEqual(slugify('  LibreOffice  '), 'libreoffice')
  assert.strictEqual(slugify(''), 'unknown')
})

test('parseAndShape maps known exes to DEFAULT_MAP packageNames', () => {
  const json = JSON.stringify([
    { DisplayName: 'Google Chrome', DisplayIcon: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe,0' },
    { DisplayName: 'Discord', DisplayIcon: '"C:\\Users\\k\\AppData\\Local\\Discord\\app-1.0\\Discord.exe"' },
  ])
  const apps = parseAndShape(json)
  const chrome = apps.find((a) => a.appName === 'Google Chrome')
  const discord = apps.find((a) => a.appName === 'Discord')
  assert.strictEqual(chrome.packageName, 'com.android.chrome')
  assert.strictEqual(chrome.exeBasename, 'chrome.exe')
  assert.strictEqual(discord.packageName, 'com.discord')
  assert.strictEqual(discord.exeBasename, 'discord.exe')
})

test('parseAndShape synthesizes win.<slug> for unknown exes', () => {
  const json = JSON.stringify([
    { DisplayName: 'LibreOffice 7.6', DisplayIcon: 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' },
  ])
  const apps = parseAndShape(json)
  assert.strictEqual(apps.length, 1)
  assert.strictEqual(apps[0].packageName, 'win.libreoffice_7_6')
  assert.strictEqual(apps[0].exeBasename, 'soffice.exe')
})

test('parseAndShape handles the single-object JSON shape PowerShell returns for one match', () => {
  const json = JSON.stringify({ DisplayName: 'Solo', DisplayIcon: 'C:\\Solo\\solo.exe' })
  const apps = parseAndShape(json)
  assert.strictEqual(apps.length, 1)
  assert.strictEqual(apps[0].appName, 'Solo')
})

test('parseAndShape drops entries without DisplayName and dedupes by name', () => {
  const json = JSON.stringify([
    { DisplayName: '', DisplayIcon: 'C:\\nope\\nope.exe' },
    { DisplayName: null, DisplayIcon: '' },
    { DisplayName: 'Discord', DisplayIcon: '' },  // first, no exe
    { DisplayName: 'Discord', DisplayIcon: 'C:\\Discord\\Discord.exe' },  // second, has exe — should win
  ])
  const apps = parseAndShape(json)
  assert.strictEqual(apps.length, 1)
  assert.strictEqual(apps[0].appName, 'Discord')
  assert.strictEqual(apps[0].exeBasename, 'discord.exe')
  assert.strictEqual(apps[0].packageName, 'com.discord')
})

test('parseAndShape returns [] on empty or non-JSON input', () => {
  const quiet = { warn() {} }
  assert.deepStrictEqual(parseAndShape('', quiet), [])
  assert.deepStrictEqual(parseAndShape('not json', quiet), [])
  assert.deepStrictEqual(parseAndShape('[]', quiet), [])
})

test('enumerateInstalledApps forwards fake exec output through parseAndShape', async () => {
  const fakeExec = async () => JSON.stringify([
    { DisplayName: 'Spotify', DisplayIcon: 'C:\\Spotify\\Spotify.exe,0' },
  ])
  const apps = await enumerateInstalledApps({ exec: fakeExec })
  assert.strictEqual(apps.length, 1)
  assert.strictEqual(apps[0].packageName, 'com.spotify.music')
  assert.strictEqual(apps[0].isLauncher, false)
})

test('enumerateInstalledApps swallows exec failure and returns []', async () => {
  const fakeExec = async () => { throw new Error('powershell missing') }
  const apps = await enumerateInstalledApps({ exec: fakeExec, logger: { warn() {} } })
  assert.deepStrictEqual(apps, [])
})

// --- EnforcementController integration -----------------------------------

function makeController(activeWin, { overlay = makeFakeOverlay() } = {}) {
  const controller = new EnforcementController({
    activeWin,
    intervalMs: 5,
    overridesStore: new OverridesStore({ filePath: null }),
    overlay,
    logger: { log() {}, warn() {} },
  })
  return { controller, overlay }
}

function makeFakeOverlay() {
  return {
    shows: [],
    hides: 0,
    show(p) { this.shows.push(p) },
    hide() { this.hides++ },
  }
}

test('Controller shows overlay on block, hides on allow', async () => {
  let current = { owner: { path: 'C:\\Games\\Roblox\\RobloxPlayerBeta.exe', processId: 1, name: 'roblox' }, title: 'Roblox' }
  const fakeActiveWin = async () => current
  const { controller, overlay } = makeController(fakeActiveWin)

  controller.setPolicyJson(JSON.stringify(policy()))  // roblox is status: blocked
  controller.start()

  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.shows.length, 1, 'expected one show after first tick')
  assert.strictEqual(overlay.shows[0].packageName, 'com.roblox.client')
  assert.strictEqual(overlay.shows[0].category, 'status')

  // Switch to an allowed app — overlay should hide.
  current = { owner: { path: 'C:\\Spotify\\Spotify.exe', processId: 2, name: 'spotify' }, title: 'Spotify' }
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.hides, 1, 'expected one hide after switching to allowed app')

  controller.stop()
})

test('Controller does not re-show overlay for the same blocked package', async () => {
  let title = 'A'
  const fakeActiveWin = async () => ({
    owner: { path: 'C:\\Games\\Roblox\\RobloxPlayerBeta.exe', processId: 1, name: 'roblox' },
    title: title++,  // change title each tick to force a foreground-changed emit
  })
  const { controller, overlay } = makeController(fakeActiveWin)
  controller.setPolicyJson(JSON.stringify(policy()))
  controller.start()
  await new Promise(r => setTimeout(r, 30))
  controller.stop()
  // The monitor's de-dup keys on exePath+pid, so the title bump alone won't
  // re-fire — but even if it did, the controller suppresses repeat shows for
  // the same package.
  assert.strictEqual(overlay.shows.length, 1)
})

test('Controller hides overlay when grant arrives for blocked app', async () => {
  const fakeActiveWin = async () => ({
    owner: { path: 'C:\\Games\\Roblox\\RobloxPlayerBeta.exe', processId: 1, name: 'roblox' },
    title: 'Roblox',
  })
  const { controller, overlay } = makeController(fakeActiveWin)
  controller.setPolicyJson(JSON.stringify(policy()))
  controller.start()
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.shows.length, 1)

  controller.applyGrant({ packageName: 'com.roblox.client', expiresAt: Date.now() + 60_000 })
  // applyGrant triggers a synchronous re-evaluate — no need to wait for the
  // next tick.
  assert.strictEqual(overlay.hides, 1)

  controller.stop()
})

test('Controller ignores foreground events from own electron windows', async () => {
  // Repro for the "PIN view gets clobbered" bug: under a device lock, clicking
  // "Enter PIN" focuses the overlay window (electron.exe). Without the
  // isOwnWindow guard, the monitor would report electron.exe as the new
  // foreground app, the lock check would block it, and _showOverlay would
  // re-deliver the payload — resetting the PIN view back to main.
  let pid = 1
  let path = 'C:\\Games\\Roblox\\RobloxPlayerBeta.exe'
  const fakeActiveWin = async () => ({
    owner: { path, processId: pid, name: 'x' },
    title: 't' + pid,
  })
  const overlay = makeFakeOverlay()
  const controller = new EnforcementController({
    activeWin: fakeActiveWin,
    intervalMs: 5,
    overridesStore: new OverridesStore({ filePath: null }),
    overlay,
    isOwnWindow: (info) => info.pid === 999,  // pretend pid 999 is our overlay
    logger: { log() {}, warn() {} },
  })
  controller.setPolicyJson(JSON.stringify(policy({ locked: true, lockMessage: 'Bedtime' })))
  controller.start()
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.shows.length, 1, 'expected initial overlay show')

  // Now simulate the kid clicking a button — focus shifts to our overlay.
  pid = 999
  path = 'C:\\Program Files\\Electron\\electron.exe'
  await new Promise(r => setTimeout(r, 30))
  controller.stop()

  // The own-window foreground event should be ignored: no extra show, no hide.
  assert.strictEqual(overlay.shows.length, 1, 'overlay should not be re-shown for own window')
  assert.strictEqual(overlay.hides, 0, 'overlay should not be hidden for own window')
})

test('Controller hides overlay when policy clears the lock for an unmapped exe', async () => {
  // Repro for the second VM-test bug: overlay was shown for a lock-blocked
  // unmapped exe (powershell.exe, packageName=null). Removing the lock did not
  // dismiss because the controller's "is overlay shown?" check used
  // _currentOverlayPkg === null as the sentinel, but unmapped blocks
  // legitimately have packageName === null — so it thought no overlay was up.
  const fakeActiveWin = async () => ({
    owner: { path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', processId: 1, name: 'pwsh' },
    title: 'PowerShell',
  })
  const { controller, overlay } = makeController(fakeActiveWin)
  controller.setPolicyJson(JSON.stringify(policy({ locked: true, lockMessage: 'Bedtime' })))
  controller.start()
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.shows.length, 1)
  assert.strictEqual(overlay.shows[0].packageName, null)
  assert.strictEqual(overlay.shows[0].category, 'lock')

  // Lock removed — overlay should hide even though packageName is null.
  controller.setPolicyJson(JSON.stringify(policy()))
  assert.strictEqual(overlay.hides, 1, 'expected hide after lock cleared on unmapped exe')

  controller.stop()
})

test('Controller hides overlay on policy change that allows the app', async () => {
  const fakeActiveWin = async () => ({
    owner: { path: 'C:\\Games\\Roblox\\RobloxPlayerBeta.exe', processId: 1, name: 'roblox' },
    title: 'Roblox',
  })
  const { controller, overlay } = makeController(fakeActiveWin)
  controller.setPolicyJson(JSON.stringify(policy()))  // blocked
  controller.start()
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.shows.length, 1)

  const updated = policy()
  updated.apps['com.roblox.client'].status = 'allowed'
  controller.setPolicyJson(JSON.stringify(updated))
  // setPolicyJson fires a re-evaluate via PolicyCache 'change' subscription.
  assert.strictEqual(overlay.hides, 1)

  controller.stop()
})

test('Controller daily-limit crossing flips an in-flight session to blocked', async () => {
  const fakeActiveWin = async () => ({
    owner: { path: 'C:\\Programs\\Limited\\limited.exe', processId: 1, name: 'limited' },
    title: 'Limited',
  })
  // Stub usage tracker so we can flip "used" without time travel. The
  // controller wires getUsageSeconds from this tracker.
  const usage = {
    _used: 0,
    _last: null,
    noteForeground(info) { this._last = info.packageName },
    getDailyUsageSeconds() { return this._used },
    getDailyUsageAll() { return [] },
    getWeeklyUsageAll() { return [] },
    takeSessions() { return [] },
    getLastForegroundPackage() { return this._last },
    endActive() {},
  }
  const overlay = makeFakeOverlay()
  const controller = new EnforcementController({
    activeWin: fakeActiveWin,
    intervalMs: 5,
    overridesStore: new OverridesStore({ filePath: null }),
    usageTracker: usage,
    overlay,
    logger: { log() {}, warn() {} },
  })
  // Teach the ExeMap how to resolve our fake path so the evaluator sees
  // com.limited.example and reads its dailyLimitSeconds.
  controller.exeMap.learn('limited.exe', 'com.limited.example')
  controller.setPolicyJson(JSON.stringify(policy()))
  controller.start()
  await new Promise(r => setTimeout(r, 20))
  // Under 600s limit → allow, no overlay.
  assert.strictEqual(overlay.shows.length, 0)

  // Cross the limit and ask for a re-eval; overlay should appear.
  usage._used = 700
  controller.reevaluate()
  assert.strictEqual(overlay.shows.length, 1)
  assert.strictEqual(overlay.shows[0].category, 'daily_limit')
  assert.strictEqual(overlay.shows[0].packageName, 'com.limited.example')

  controller.stop()
})

test('Controller blocks UWP via ApplicationFrameHost + title fallback', async () => {
  // Repro for #2: the kid opens Calculator. active-win reports
  // ApplicationFrameHost.exe as the owner and "Calculator" as the title.
  // ExeMap has no mapping for the host (and the host is SYSTEM_EXEMPT
  // post-#1), so without the title fallback the evaluator would short-circuit
  // to null and nothing would block. With learnUwp registered from apps:sync,
  // resolveUwpByTitle recovers the UWP packageName and we enforce against it.
  const fakeActiveWin = async () => ({
    owner: { path: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', processId: 1, name: 'ApplicationFrameHost' },
    title: 'Calculator',
  })
  const { controller, overlay } = makeController(fakeActiveWin)
  controller.exeMap.learnUwp({
    title: 'Calculator',
    packageName: 'uwp.microsoft_windowscalculator_8wekyb3d8bbwe',
    exeBasename: 'calculatorapp.exe',
  })
  const p = policy()
  p.apps['uwp.microsoft_windowscalculator_8wekyb3d8bbwe'] = {
    status: 'blocked', appName: 'Calculator',
  }
  controller.setPolicyJson(JSON.stringify(p))
  controller.start()
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.shows.length, 1, 'expected overlay for blocked UWP')
  assert.strictEqual(overlay.shows[0].packageName, 'uwp.microsoft_windowscalculator_8wekyb3d8bbwe')
  assert.strictEqual(overlay.shows[0].category, 'status')
  controller.stop()
})

test('Controller allows UWP host when title does not match any registered UWP', async () => {
  // Unknown UWP titles fall through to "unmapped → allow" rather than tripping
  // over the host's own SYSTEM_EXEMPT entry.
  const fakeActiveWin = async () => ({
    owner: { path: 'C:\\Windows\\System32\\ApplicationFrameHost.exe', processId: 1, name: 'ApplicationFrameHost' },
    title: 'SomeUnregisteredApp',
  })
  const { controller, overlay } = makeController(fakeActiveWin)
  controller.setPolicyJson(JSON.stringify(policy({ locked: false })))
  controller.start()
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.shows.length, 0)
  controller.stop()
})

// --- pin-verify ----------------------------------------------------------

// Lazy-load sodium-native — the prebuild may not be present in every dev env.
// If it can't load, skip the PIN tests rather than crash the whole suite.
let sodium = null
try { sodium = require('sodium-native') } catch (_) { sodium = null }

function withSodium(name, fn) {
  test(name, () => {
    if (!sodium) {
      console.log('  skip ' + name + ' (sodium-native unavailable)')
      return
    }
    fn()
  })
}

withSodium('verifyPin: no policy → no-policy', () => {
  assert.deepStrictEqual(verifyPin({ sodium, policy: null, pin: '1234' }), { ok: false, reason: 'no-policy' })
})

withSodium('verifyPin: policy without any pin → no-pin', () => {
  assert.deepStrictEqual(verifyPin({ sodium, policy: { apps: {} }, pin: '1234' }), { ok: false, reason: 'no-pin' })
})

withSodium('verifyPin: matches a pinHashes entry', () => {
  const hash = hashPin(sodium, '1234')
  const r = verifyPin({ sodium, policy: { pinHashes: { 'parent-A': hash } }, pin: '1234' })
  assert.deepStrictEqual(r, { ok: true })
})

withSodium('verifyPin: matches second parent in pinHashes', () => {
  const hashA = hashPin(sodium, 'wrong')
  const hashB = hashPin(sodium, 'right')
  const r = verifyPin({ sodium, policy: { pinHashes: { 'parent-A': hashA, 'parent-B': hashB } }, pin: 'right' })
  assert.deepStrictEqual(r, { ok: true })
})

withSodium('verifyPin: legacy pinHash fallback', () => {
  const hash = hashPin(sodium, '5555')
  const r = verifyPin({ sodium, policy: { pinHash: hash }, pin: '5555' })
  assert.deepStrictEqual(r, { ok: true })
})

withSodium('verifyPin: wrong pin → wrong-pin', () => {
  const hash = hashPin(sodium, '1234')
  const r = verifyPin({ sodium, policy: { pinHashes: { 'parent-A': hash } }, pin: '0000' })
  assert.deepStrictEqual(r, { ok: false, reason: 'wrong-pin' })
})

withSodium('verifyPinAndGrant applies override and re-evaluates', async () => {
  // Repro for the second VM-test bug: PIN entry showed "No PIN set on this
  // device" because bare's pin:verify only checked legacy policy.pinHash,
  // which is stripped on the child. We verify locally instead.
  const fakeActiveWin = async () => ({
    owner: { path: 'C:\\Games\\Roblox\\RobloxPlayerBeta.exe', processId: 1, name: 'roblox' },
    title: 'Roblox',
  })
  const overlay = makeFakeOverlay()
  const controller = new EnforcementController({
    activeWin: fakeActiveWin,
    intervalMs: 5,
    overridesStore: new OverridesStore({ filePath: null }),
    overlay,
    sodium,
    logger: { log() {}, warn() {} },
  })
  const hash = hashPin(sodium, '1234')
  const p = policy()
  p.pinHashes = { 'parent-A': hash }
  p.overrideDurationSeconds = 1800
  controller.setPolicyJson(JSON.stringify(p))
  controller.start()
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.shows.length, 1)

  const result = controller.verifyPinAndGrant({ pin: '1234', packageName: 'com.roblox.client' })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.durationSeconds, 1800)
  assert.ok(result.expiresAt > Date.now())
  // Grant should have triggered a re-evaluate that hides the overlay.
  assert.strictEqual(overlay.hides, 1)
  controller.stop()
})

withSodium('verifyPinAndGrant rejects wrong pin without granting', async () => {
  const fakeActiveWin = async () => ({
    owner: { path: 'C:\\Games\\Roblox\\RobloxPlayerBeta.exe', processId: 1, name: 'roblox' },
    title: 'Roblox',
  })
  const overlay = makeFakeOverlay()
  const controller = new EnforcementController({
    activeWin: fakeActiveWin,
    intervalMs: 5,
    overridesStore: new OverridesStore({ filePath: null }),
    overlay,
    sodium,
    logger: { log() {}, warn() {} },
  })
  const p = policy()
  p.pinHashes = { 'parent-A': hashPin(sodium, '1234') }
  controller.setPolicyJson(JSON.stringify(p))
  controller.start()
  await new Promise(r => setTimeout(r, 20))

  const result = controller.verifyPinAndGrant({ pin: '0000', packageName: 'com.roblox.client' })
  assert.deepStrictEqual(result, { ok: false, reason: 'wrong-pin' })
  assert.strictEqual(overlay.hides, 0)
  controller.stop()
})

test('verifyPinAndGrant without sodium → no-sodium', () => {
  const controller = new EnforcementController({
    activeWin: async () => null,
    intervalMs: 5,
    overridesStore: new OverridesStore({ filePath: null }),
    overlay: makeFakeOverlay(),
    sodium: null,
    logger: { log() {}, warn() {} },
  })
  const r = controller.verifyPinAndGrant({ pin: '1234', packageName: 'com.foo' })
  assert.deepStrictEqual(r, { ok: false, reason: 'no-sodium' })
})

// --- ForegroundMonitor first-sighting dedupe -----------------------------

function tmpSeenExesPath() {
  return path.join(os.tmpdir(), 'pearguard-test-seen-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

test('ForegroundMonitor emits app-first-seen once per basename', async () => {
  const responses = [
    { owner: { path: 'C:\\foo.exe', processId: 1, name: 'foo' }, title: 't1' },
    { owner: { path: 'C:\\foo.exe', processId: 2, name: 'foo' }, title: 't1' },  // same basename, new pid
    { owner: { path: 'C:\\bar.exe', processId: 3, name: 'bar' }, title: 't2' },
    { owner: { path: 'C:\\FOO.EXE', processId: 4, name: 'foo' }, title: 't3' },  // case variant — still dup
  ]
  let calls = 0
  const fakeActiveWin = async () => responses[Math.min(calls++, responses.length - 1)]
  const m = new ForegroundMonitor({ activeWin: fakeActiveWin, intervalMs: 5 })
  const firstSeen = []
  m.on('app-first-seen', (info) => firstSeen.push(info))
  m.start()
  await new Promise(r => setTimeout(r, 80))
  m.stop()
  const basenames = firstSeen.map((x) => x.exeBasename)
  assert.deepStrictEqual(new Set(basenames), new Set(['foo.exe', 'bar.exe']))
})

test('ForegroundMonitor seenExes persists across instances', async () => {
  const filePath = tmpSeenExesPath()
  try {
    const first = new ForegroundMonitor({
      activeWin: async () => ({ owner: { path: 'C:\\a.exe', processId: 1, name: 'a' }, title: '' }),
      intervalMs: 5,
      seenExesPath: filePath,
    })
    const firstEvents = []
    first.on('app-first-seen', (info) => firstEvents.push(info))
    first.start()
    await new Promise(r => setTimeout(r, 30))
    first.stop()
    assert.strictEqual(firstEvents.length, 1, 'first instance should see a.exe once')

    const second = new ForegroundMonitor({
      activeWin: async () => ({ owner: { path: 'C:\\a.exe', processId: 2, name: 'a' }, title: '' }),
      intervalMs: 5,
      seenExesPath: filePath,
    })
    const secondEvents = []
    second.on('app-first-seen', (info) => secondEvents.push(info))
    second.start()
    await new Promise(r => setTimeout(r, 30))
    second.stop()
    assert.strictEqual(secondEvents.length, 0, 'second instance should NOT re-fire for a.exe')
  } finally {
    try { fs.unlinkSync(filePath) } catch (_) {}
  }
})

test('ForegroundMonitor.markSeen suppresses first-sighting for pre-seeded exes', async () => {
  const m = new ForegroundMonitor({
    activeWin: async () => ({ owner: { path: 'C:\\electron.exe', processId: 1, name: 'electron' }, title: '' }),
    intervalMs: 5,
  })
  m.markSeen(['electron.exe'])
  const events = []
  m.on('app-first-seen', (info) => events.push(info))
  m.start()
  await new Promise(r => setTimeout(r, 30))
  m.stop()
  assert.strictEqual(events.length, 0)
})

// --- UWP / Get-StartApps -------------------------------------------------

test('parseUwpAndShape extracts UWP packages via PackageFamilyName', () => {
  const json = JSON.stringify([
    { Name: 'Xbox', AppID: 'Microsoft.XboxApp_8wekyb3d8bbwe!Microsoft.XboxApp' },
    { Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
    { Name: 'Notepad++', AppID: 'C:\\Program Files\\Notepad++\\notepad++.exe' },  // Win32 shortcut, ignored
  ])
  const rows = parseUwpAndShape(json)
  assert.strictEqual(rows.length, 2)
  const xbox = rows.find((r) => r.appName === 'Xbox')
  assert.ok(xbox)
  assert.strictEqual(xbox.packageName, 'uwp.microsoft_xboxapp_8wekyb3d8bbwe')
  assert.strictEqual(xbox.exeBasename, null)
})

test('parseUwpAndShape handles empty/non-JSON gracefully', () => {
  const quiet = { warn() {} }
  assert.deepStrictEqual(parseUwpAndShape('', quiet), [])
  assert.deepStrictEqual(parseUwpAndShape('[]', quiet), [])
  assert.deepStrictEqual(parseUwpAndShape('garbage', quiet), [])
})

test('mergeRows prefers registry rows over UWP on packageName collision', () => {
  const registry = [{ packageName: 'com.app', appName: 'App (Registry)', exeBasename: 'app.exe', isLauncher: false }]
  const uwp = [
    { packageName: 'com.app', appName: 'App (UWP)', exeBasename: null, isLauncher: false },
    { packageName: 'uwp.unique', appName: 'Unique UWP', exeBasename: null, isLauncher: false },
  ]
  const merged = mergeRows(registry, uwp)
  assert.strictEqual(merged.length, 2)
  const shared = merged.find((r) => r.packageName === 'com.app')
  assert.strictEqual(shared.appName, 'App (Registry)')
  assert.strictEqual(shared.exeBasename, 'app.exe')
})

test('mergeRows fuzzy-merges UWP and Win32 twins by normalized display name', () => {
  // Repro: Calculator ships both a registry Uninstall entry (win.calculator)
  // and a Get-StartApps entry (uwp.<family>). Without fuzzy-merge, the parent
  // sees two Calculators and has to block both; even then nothing enforces
  // because the foreground owner for UWPs is ApplicationFrameHost.exe.
  const registry = [
    { packageName: 'win.calculator', appName: 'Calculator', exeBasename: 'calculatorapp.exe', isLauncher: false },
    { packageName: 'win.notepad', appName: 'Notepad', exeBasename: 'notepad.exe', isLauncher: false },
  ]
  const uwp = [
    { packageName: 'uwp.microsoft_windowscalculator_8wekyb3d8bbwe', appName: 'Calculator', exeBasename: null, isLauncher: false },
    { packageName: 'uwp.microsoft_store', appName: 'Microsoft Store', exeBasename: null, isLauncher: false },
  ]
  const merged = mergeRows(registry, uwp)
  assert.strictEqual(merged.length, 3, 'calculator twin collapses; notepad + store pass through')
  const calc = merged.find((r) => r.appName === 'Calculator')
  assert.ok(calc, 'one calculator entry survives the merge')
  assert.strictEqual(calc.packageName, 'uwp.microsoft_windowscalculator_8wekyb3d8bbwe',
    'UWP ID wins as survivor (globally stable)')
  assert.strictEqual(calc.exeBasename, 'calculatorapp.exe',
    'Win32 twin exeBasename is absorbed so direct-exe launches still resolve')
  assert.ok(merged.find((r) => r.packageName === 'win.notepad'), 'Win32-only app survives')
  assert.ok(merged.find((r) => r.packageName === 'uwp.microsoft_store'), 'UWP-only app survives')
})

test('mergeRows fuzzy match ignores whitespace and punctuation differences', () => {
  const registry = [{ packageName: 'win.visual_studio_code', appName: 'Visual Studio Code', exeBasename: 'code.exe', isLauncher: false }]
  const uwp = [{ packageName: 'uwp.microsoft_vscode', appName: 'Visual-Studio-Code', exeBasename: null, isLauncher: false }]
  const merged = mergeRows(registry, uwp)
  assert.strictEqual(merged.length, 1)
  assert.strictEqual(merged[0].packageName, 'uwp.microsoft_vscode')
  assert.strictEqual(merged[0].exeBasename, 'code.exe')
})

test('enumerateInstalledApps merges registry and UWP exec calls', async () => {
  let callIdx = 0
  const fakeExec = async () => {
    callIdx++
    if (callIdx === 1) {
      return JSON.stringify([{ DisplayName: 'Chrome', DisplayIcon: 'C:\\chrome.exe,0' }])
    }
    return JSON.stringify([{ Name: 'Xbox', AppID: 'Microsoft.XboxApp_8wekyb3d8bbwe!Microsoft.XboxApp' }])
  }
  const apps = await enumerateInstalledApps({ exec: fakeExec, logger: { log() {}, warn() {} } })
  assert.strictEqual(apps.length, 2)
  const pkgs = apps.map((a) => a.packageName)
  assert.ok(pkgs.includes('com.android.chrome'))
  assert.ok(pkgs.some((p) => p.startsWith('uwp.')))
})

// --- icon-extractor ------------------------------------------------------

test('extractExePath strips quotes and icon index', () => {
  assert.strictEqual(extractExePath('C:\\Program Files\\App\\app.exe,0'), 'C:\\Program Files\\App\\app.exe')
  assert.strictEqual(extractExePath('"C:\\Program Files\\App\\app.exe",0'), 'C:\\Program Files\\App\\app.exe')
  assert.strictEqual(extractExePath('C:\\App\\plain.exe'), 'C:\\App\\plain.exe')
  assert.strictEqual(extractExePath('C:\\readme.txt'), null)
  assert.strictEqual(extractExePath(null), null)
})

test('buildWin32Script escapes embedded single quotes', () => {
  const script = buildWin32Script(["C:\\has'quote.exe", 'C:\\plain.exe'])
  // Embedded ' must become '' inside the generated PS array literal.
  assert.ok(script.includes("'C:\\has''quote.exe'"))
  assert.ok(script.includes("'C:\\plain.exe'"))
})

test('buildUwpScript embeds families as single-quoted literals', () => {
  const script = buildUwpScript(['Microsoft.XboxApp_8wekyb3d8bbwe'])
  assert.ok(script.includes("'Microsoft.XboxApp_8wekyb3d8bbwe'"))
})

test('extractWin32Icons returns Map of path → base64 from canned PS JSON', async () => {
  const fakeExec = async () => JSON.stringify([
    { path: 'C:\\a.exe', icon: 'ZmFrZS1pY29uLWE=' },
    { path: 'C:\\b.exe', icon: null },
    { path: 'C:\\c.exe', icon: 'ZmFrZS1pY29uLWM=' },
  ])
  const map = await extractWin32Icons(['C:\\a.exe', 'C:\\b.exe', 'C:\\c.exe'], { exec: fakeExec })
  assert.strictEqual(map.get('C:\\a.exe'), 'ZmFrZS1pY29uLWE=')
  assert.strictEqual(map.has('C:\\b.exe'), false)  // null icons omitted
  assert.strictEqual(map.get('C:\\c.exe'), 'ZmFrZS1pY29uLWM=')
})

test('extractWin32Icons returns empty Map on empty input', async () => {
  const map = await extractWin32Icons([], { exec: async () => 'unused' })
  assert.strictEqual(map.size, 0)
})

test('extractWin32Icons swallows exec failure and returns empty Map', async () => {
  const fakeExec = async () => { throw new Error('ps boom') }
  const map = await extractWin32Icons(['C:\\a.exe'], { exec: fakeExec, logger: { warn() {} } })
  assert.strictEqual(map.size, 0)
})

test('extractUwpIcons returns Map of family → base64', async () => {
  const fakeExec = async () => JSON.stringify([
    { family: 'Microsoft.XboxApp_8wekyb3d8bbwe', icon: 'WGJveC1pY29u' },
    { family: 'Missing.Package_deadbeef', icon: null },
  ])
  const map = await extractUwpIcons(['Microsoft.XboxApp_8wekyb3d8bbwe', 'Missing.Package_deadbeef'], { exec: fakeExec })
  assert.strictEqual(map.get('Microsoft.XboxApp_8wekyb3d8bbwe'), 'WGJveC1pY29u')
  assert.strictEqual(map.has('Missing.Package_deadbeef'), false)
})

test('parseRows handles empty, non-JSON, and single-object shapes', () => {
  const quiet = { warn() {} }
  assert.deepStrictEqual(parseRows('', quiet), [])
  assert.deepStrictEqual(parseRows('not json', quiet), [])
  assert.deepStrictEqual(parseRows('{"path":"x","icon":"y"}'), [{ path: 'x', icon: 'y' }])
})

test('enumerateInstalledApps attaches iconBase64 to registry rows', async () => {
  let callIdx = 0
  const fakeExec = async (script) => {
    callIdx++
    if (script.includes('Uninstall')) {
      return JSON.stringify([{ DisplayName: 'Chrome', DisplayIcon: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe,0' }])
    }
    if (script.includes('Get-StartApps')) {
      return JSON.stringify([])
    }
    if (script.includes('ExtractAssociatedIcon')) {
      return JSON.stringify([{ path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', icon: 'Y2hyb21lLWljb24=' }])
    }
    if (script.includes('Get-AppxPackage')) {
      return JSON.stringify([])
    }
    throw new Error('unexpected script: ' + script.slice(0, 40))
  }
  const apps = await enumerateInstalledApps({ exec: fakeExec, logger: { log() {}, warn() {} } })
  assert.strictEqual(apps.length, 1)
  assert.strictEqual(apps[0].packageName, 'com.android.chrome')
  assert.strictEqual(apps[0].iconBase64, 'Y2hyb21lLWljb24=')
  assert.strictEqual(apps[0].exePath, undefined, 'exePath should be stripped from returned row')
})

test('enumerateInstalledApps attaches iconBase64 to UWP rows via family', async () => {
  const fakeExec = async (script) => {
    if (script.includes('Uninstall')) return JSON.stringify([])
    if (script.includes('Get-StartApps')) {
      return JSON.stringify([{ Name: 'Xbox', AppID: 'Microsoft.XboxApp_8wekyb3d8bbwe!App' }])
    }
    if (script.includes('ExtractAssociatedIcon')) return JSON.stringify([])
    if (script.includes('Get-AppxPackage')) {
      return JSON.stringify([{ family: 'Microsoft.XboxApp_8wekyb3d8bbwe', icon: 'WGJveC1pY29u' }])
    }
    throw new Error('unexpected script')
  }
  const apps = await enumerateInstalledApps({ exec: fakeExec, logger: { log() {}, warn() {} } })
  assert.strictEqual(apps.length, 1)
  assert.strictEqual(apps[0].iconBase64, 'WGJveC1pY29u')
  assert.strictEqual(apps[0].packageFamilyName, undefined)
})

test('enumerateInstalledApps leaves iconBase64 undefined when extraction returns nothing', async () => {
  const fakeExec = async (script) => {
    if (script.includes('Uninstall')) {
      return JSON.stringify([{ DisplayName: 'Noicon', DisplayIcon: 'C:\\noicon\\noicon.exe' }])
    }
    return JSON.stringify([])  // empty for StartApps, icons, appx
  }
  const apps = await enumerateInstalledApps({ exec: fakeExec, logger: { log() {}, warn() {} } })
  assert.strictEqual(apps.length, 1)
  assert.strictEqual(apps[0].iconBase64, undefined)
})

// --- Runner --------------------------------------------------------------

;(async () => {
  let failed = 0
  for (const { name, fn } of tests) {
    try {
      await fn()
      console.log('  ok  ' + name)
    } catch (e) {
      failed++
      console.error('  FAIL  ' + name)
      console.error('        ' + (e.stack || e.message))
    }
  }
  const total = tests.length
  const passed = total - failed
  console.log('\n' + passed + '/' + total + ' passed')
  process.exit(failed === 0 ? 0 : 1)
})()
