#!/usr/bin/env node
// Stand-alone Node smoke test for the Windows enforcement modules. Runs
// without Electron, without active-win, without any P2P backend. Exits 0 on
// pass, 1 on first failure. Run from desktop/: `node tests/enforcement.smoke.js`.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { evaluate, isSystemExempt, LINUX_SYSTEM_EXEMPT_BASENAMES } = require('../src/enforcement/block-evaluator')
const { ExeMap, ALIAS_MAP, UWP_HOST_BASENAMES, LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP, computeAppImageMountPrefix, extractAppImageMountPrefix } = require('../src/enforcement/exe-map')
const { PolicyCache } = require('../src/enforcement/policy-cache')
const { ForegroundMonitor } = require('../src/enforcement/foreground-monitor')
const { OverridesStore } = require('../src/enforcement/overrides-store')
const { EnforcementController } = require('../src/enforcement')
const { UsageTracker, localDayStart, localWeekStart } = require('../src/enforcement/usage-tracker')
const { enumerateInstalledApps, extractExeBasename, extractExePath, slugify, parseAndShape, parseUwpAndShape, parseShortcutMap, parseMsixExeMap, mergeRows } = require('../src/enforcement/apps-enumerator')
const { categorizeApp } = require('../src/enforcement/app-category')
const { extractWin32Icons, extractUwpIcons, buildWin32Script, buildUwpScript, parseRows } = require('../src/enforcement/icon-extractor')
const { verifyPin, hashPin } = require('../src/enforcement/pin-verify')
const {
  PinLockoutStore,
  lockoutDelayForFailCount,
  lockRemainingMs,
  nextStateAfterFailure,
  formatLockRemaining,
  FREE_ATTEMPTS,
  LOCKOUT_LADDER_MS,
} = require('../src/enforcement/pin-lockout')
const { TamperDetector, STALE_MS } = require('../src/main/tamper-detector')
const { WarningChecker, DEFAULT_WARNING_THRESHOLDS_MIN, GRACE_WINDOW_SECONDS } = require('../src/enforcement/warning-checker')
const { parseVdf, scanSteam, isBlacklisted } = require('../src/enforcement/launchers/steam')
const { scanEpic } = require('../src/enforcement/launchers/epic')
const { enumerateRegistryLaunchers, buildUbisoftRow, buildEaRow, buildOriginRow, buildGogRow, extractExeFromDisplayIcon } = require('../src/enforcement/launchers/registry-scanner')
const { enumerateLauncherApps } = require('../src/enforcement/launchers')

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

test('ExeMap resolves Steam helper processes to steam packageName', () => {
  const m = new ExeMap()
  const steamPkg = 'com.valvesoftware.android.steam.community'
  assert.strictEqual(m.resolve('C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win7x64\\steamwebhelper.exe'), steamPkg)
  assert.strictEqual(m.resolve('C:\\Program Files (x86)\\Steam\\steam_bpm.exe'), steamPkg)
  assert.strictEqual(m.resolve('C:\\Program Files (x86)\\Steam\\bin\\steamservice.exe'), steamPkg)
})

test('ExeMap resolves EpicWebHelper to Epic Games Launcher packageName', () => {
  const m = new ExeMap()
  assert.strictEqual(
    m.resolve('C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Extras\\WebHelper\\EpicWebHelper.exe'),
    'com.epicgames.portal',
  )
})

test('ExeMap alias lookup is case-insensitive', () => {
  const m = new ExeMap()
  assert.strictEqual(
    m.resolve('C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win7x64\\SteamWebHelper.EXE'),
    'com.valvesoftware.android.steam.community',
  )
})

test('ExeMap.learnAlias adds runtime aliases that resolve through learned primaries', () => {
  const m = new ExeMap({})
  m.learnAlias('fooclient.exe', 'foo.exe')
  // Primary not yet mapped — alias should resolve to null, not crash.
  assert.strictEqual(m.resolve('C:\\fooclient.exe'), null)
  m.learn('foo.exe', 'com.example.foo')
  assert.strictEqual(m.resolve('C:\\fooclient.exe'), 'com.example.foo')
})

test('ExeMap direct mapping wins over alias for the same basename', () => {
  const m = new ExeMap({ 'helper.exe': 'com.example.helper', 'primary.exe': 'com.example.primary' })
  // If someone learned an alias but also has a direct mapping, the direct
  // mapping is authoritative.
  m.learnAlias('helper.exe', 'primary.exe')
  assert.strictEqual(m.resolve('C:\\helper.exe'), 'com.example.helper')
})

test('ALIAS_MAP seeds Steam and Epic helpers', () => {
  assert.strictEqual(ALIAS_MAP['steamwebhelper.exe'], 'steam.exe')
  assert.strictEqual(ALIAS_MAP['steam_bpm.exe'], 'steam.exe')
  assert.strictEqual(ALIAS_MAP['steamservice.exe'], 'steam.exe')
  assert.strictEqual(ALIAS_MAP['epicwebhelper.exe'], 'epicgameslauncher.exe')
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

// ForegroundMonitor emits a 'tick' heartbeat on EVERY 1s poll, not just when the
// focused app changes, and UsageTracker depends on it: with no observations it
// refuses to credit elapsed wall-clock, because an unobserved gap is
// indistinguishable from a suspended machine or a locked screen. (That refusal
// is the fix — see tests/usage-sleep.smoke.js.) So advancing the fake clock has
// to drive the heartbeat the way production does.
function advance(clock, u, ms, packageName, appName = null) {
  for (let i = 0; i < ms; i += 1000) {
    clock.t += 1000
    u.noteObserved({ packageName, appName })
  }
}

test('UsageTracker.noteForeground accrues seconds to the previous package', () => {
  const clock = { t: localNoonToday() }
  const u = new UsageTracker({ now: () => clock.t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  advance(clock, u, 45_000, 'com.discord', 'Discord')
  u.noteForeground({ packageName: 'com.roblox.client', appName: 'Roblox' })
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 45)
  // New session has just started, so ~0 seconds accrued so far.
  assert.strictEqual(u.getDailyUsageSeconds('com.roblox.client'), 0)
  advance(clock, u, 30_000, 'com.roblox.client', 'Roblox')
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
  const clock = { t: localNoonToday() }
  const u = new UsageTracker({ now: () => clock.t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  advance(clock, u, 20_000, 'com.discord', 'Discord')
  u.noteForeground({ packageName: null })
  advance(clock, u, 60_000, null)
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 20)
  assert.strictEqual(u.getLastForegroundPackage(), null)
})

test('UsageTracker.takeSessions drains and re-opens the active session', () => {
  const clock = { t: localNoonToday() }
  const u = new UsageTracker({ now: () => clock.t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  advance(clock, u, 30_000, 'com.discord', 'Discord')
  u.noteForeground({ packageName: 'com.roblox.client', appName: 'Roblox' })
  advance(clock, u, 20_000, 'com.roblox.client', 'Roblox')

  const first = u.takeSessions()
  assert.strictEqual(first.length, 2, 'expected discord-close + roblox-snapshot')
  assert.strictEqual(first[0].packageName, 'com.discord')
  assert.strictEqual(first[0].displayName, 'Discord')
  assert.strictEqual(first[0].durationSeconds, 30)
  assert.strictEqual(first[1].packageName, 'com.roblox.client')
  assert.strictEqual(first[1].displayName, 'Roblox')
  assert.strictEqual(first[1].durationSeconds, 20)
  // Accrued time lives on in daily after takeSessions.
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 30)
  assert.strictEqual(u.getDailyUsageSeconds('com.roblox.client'), 20)

  // Continuing in Roblox — next takeSessions should contain only the new slice.
  advance(clock, u, 10_000, 'com.roblox.client', 'Roblox')
  const second = u.takeSessions()
  assert.strictEqual(second.length, 1)
  assert.strictEqual(second[0].packageName, 'com.roblox.client')
  assert.strictEqual(second[0].displayName, 'Roblox')
  assert.strictEqual(second[0].durationSeconds, 10)
  assert.strictEqual(u.getDailyUsageSeconds('com.roblox.client'), 30)
})

test('UsageTracker daily rollover zeros daily but preserves weekly', () => {
  const clock = { t: localNoonToday() }
  const u = new UsageTracker({ now: () => clock.t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  advance(clock, u, 60_000, 'com.discord', 'Discord')
  u.noteForeground({ packageName: null })  // close the session cleanly
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 60)

  // Jump forward 24h — daily resets, weekly keeps the 60s (same week unless
  // we also cross Sunday; localNoonToday + 24h stays inside the same week as
  // long as "today" isn't Saturday). Check both and adjust expectations.
  // No session is open here, so the 24h jump needs no heartbeat.
  const startOfThisWeek = localWeekStart(localNoonToday())
  clock.t = localNoonToday() + 24 * 3600 * 1000
  const acrossWeek = localWeekStart(clock.t) !== startOfThisWeek

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
  const clock = { t: midnight - 30 * 60 * 1000 }
  const u = new UsageTracker({ now: () => clock.t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  // 40 minutes of real, observed foreground use straddling the boundary.
  advance(clock, u, 40 * 60 * 1000, 'com.discord', 'Discord')
  u.noteForeground({ packageName: null })  // close

  // After midnight, the old day is gone — daily counter for discord is the
  // 10 minutes that landed in the new day.
  assert.strictEqual(u.getDailyUsageSeconds('com.discord'), 600)
})

test('UsageTracker persists daily/weekly across instantiations on the same day', () => {
  const filePath = tmpUsagePath()
  try {
    const clock = { t: localNoonToday() }
    const a = new UsageTracker({ filePath, now: () => clock.t })
    a.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
    advance(clock, a, 120_000, 'com.discord', 'Discord')
    a.endActive()  // persists

    const b = new UsageTracker({ filePath, now: () => clock.t })
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
  const clock = { t: localNoonToday() }
  const u = new UsageTracker({ now: () => clock.t })
  u.noteForeground({ packageName: 'com.discord', appName: 'Discord' })
  advance(clock, u, 30_000, 'com.discord', 'Discord')
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
    // The controller now drives a per-poll observation heartbeat; the stub has
    // to answer it. Accrual is faked via _used, so this is a no-op.
    noteObserved() {},
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

// --- pin-lockout ---------------------------------------------------------

test('lockoutDelayForFailCount gives free attempts then escalates and caps', () => {
  for (let i = 1; i <= FREE_ATTEMPTS; i++) {
    assert.strictEqual(lockoutDelayForFailCount(i), 0, 'attempt ' + i + ' should be free')
  }
  assert.strictEqual(lockoutDelayForFailCount(FREE_ATTEMPTS + 1), LOCKOUT_LADDER_MS[0])
  assert.strictEqual(lockoutDelayForFailCount(FREE_ATTEMPTS + 2), LOCKOUT_LADDER_MS[1])
  assert.strictEqual(lockoutDelayForFailCount(FREE_ATTEMPTS + 4), LOCKOUT_LADDER_MS[3])
  // Beyond the ladder it pins to the longest wait rather than reading past the end.
  assert.strictEqual(lockoutDelayForFailCount(FREE_ATTEMPTS + 99), LOCKOUT_LADDER_MS[3])
})

test('lockRemainingMs counts down and expires', () => {
  const state = { failCount: 6, lockedAt: 1000, lockedUntil: 31_000 }
  assert.strictEqual(lockRemainingMs(state, 1000), 30_000)
  assert.strictEqual(lockRemainingMs(state, 16_000), 15_000)
  assert.strictEqual(lockRemainingMs(state, 31_000), 0)
  assert.strictEqual(lockRemainingMs(state, 99_000), 0)
  assert.strictEqual(lockRemainingMs({ failCount: 1 }, 5000), 0)
})

test('lockRemainingMs ignores a backwards clock jump', () => {
  const state = { failCount: 6, lockedAt: 100_000, lockedUntil: 130_000 }
  // Child winds the clock back to before the lock was applied: still fully locked.
  assert.strictEqual(lockRemainingMs(state, 50_000), 30_000)
  assert.strictEqual(lockRemainingMs(state, 0), 30_000)
})

test('a forward clock jump clears the wait but the failure count still escalates', () => {
  let state = { failCount: 0, lockedAt: 0, lockedUntil: 0 }
  for (let i = 0; i < FREE_ATTEMPTS; i++) state = nextStateAfterFailure(state, 1000).state
  const first = nextStateAfterFailure(state, 1000)
  assert.strictEqual(first.lockMs, LOCKOUT_LADDER_MS[0])

  // Jump past lockedUntil — the keypad unlocks...
  assert.strictEqual(lockRemainingMs(first.state, 10_000_000), 0)
  // ...but the next wrong guess costs strictly more than the one before it.
  const second = nextStateAfterFailure(first.state, 10_000_000)
  assert.strictEqual(second.lockMs, LOCKOUT_LADDER_MS[1])
  assert.ok(second.lockMs > first.lockMs)
})

test('PinLockoutStore persists lockout across a restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinlock-'))
  const filePath = path.join(dir, 'pin-lockout.json')
  let now = 1_000_000
  const store = new PinLockoutStore({ filePath, now: () => now })

  for (let i = 0; i < FREE_ATTEMPTS; i++) assert.strictEqual(store.recordFailure(), 0)
  assert.strictEqual(store.attemptsRemaining(), 0)
  assert.strictEqual(store.recordFailure(), LOCKOUT_LADDER_MS[0])

  // A fresh process (kid force-quits Electron) sees the same remaining lockout.
  const reopened = new PinLockoutStore({ filePath, now: () => now + 10_000 })
  assert.strictEqual(reopened.remainingMs(), 20_000)

  // Success clears everything, on disk too.
  reopened.clear()
  assert.strictEqual(reopened.remainingMs(), 0)
  assert.strictEqual(new PinLockoutStore({ filePath, now: () => now }).attemptsRemaining(), FREE_ATTEMPTS)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('formatLockRemaining rounds up and never shows 0s', () => {
  assert.strictEqual(formatLockRemaining(1), '1s')
  assert.strictEqual(formatLockRemaining(30_000), '30s')
  assert.strictEqual(formatLockRemaining(90_000), '1m 30s')
  assert.strictEqual(formatLockRemaining(600_000), '10m 00s')
  assert.strictEqual(formatLockRemaining(3_600_000), '1h 00m')
  assert.strictEqual(formatLockRemaining(3_840_000), '1h 04m')
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

withSodium('verifyPinOnly locks out after the free attempts are spent', () => {
  let now = 500_000
  const controller = new EnforcementController({
    activeWin: async () => null,
    sodium,
    overridesStore: new OverridesStore({ filePath: null }),
    pinLockoutStore: new PinLockoutStore({ filePath: null, now: () => now }),
  })
  controller.policyCache.setPolicyJson(JSON.stringify({ pinHashes: { p: hashPin(sodium, '1234') } }))

  for (let i = 1; i <= FREE_ATTEMPTS; i++) {
    const r = controller.verifyPinOnly({ pin: '9999' })
    assert.strictEqual(r.reason, 'wrong-pin', 'attempt ' + i)
    assert.strictEqual(r.attemptsRemaining, FREE_ATTEMPTS - i)
  }

  const locked = controller.verifyPinOnly({ pin: '9999' })
  assert.deepStrictEqual(locked, {
    ok: false, reason: 'locked', retryAfterMs: LOCKOUT_LADDER_MS[0],
    justLocked: true, failCount: FREE_ATTEMPTS + 1,
  })

  // A submit that arrives while already locked must NOT set justLocked, or the
  // parent would be re-alerted on every keystroke a tampering child sends.
  const stillLocked = controller.verifyPinOnly({ pin: '1234' })
  assert.strictEqual(stillLocked.reason, 'locked')
  assert.strictEqual(stillLocked.justLocked, undefined)

  // Once the wait elapses, the right PIN works again and resets the counter.
  now += LOCKOUT_LADDER_MS[0]
  assert.deepStrictEqual(controller.verifyPinOnly({ pin: '1234' }), { ok: true })
  assert.strictEqual(controller.pinLockout.attemptsRemaining(), FREE_ATTEMPTS)
})

withSodium('verifyPinOnly does not count no-pin/no-policy against the child', () => {
  const controller = new EnforcementController({
    activeWin: async () => null,
    sodium,
    overridesStore: new OverridesStore({ filePath: null }),
    pinLockoutStore: new PinLockoutStore({ filePath: null }),
  })
  // No policy loaded yet.
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(controller.verifyPinOnly({ pin: '1234' }).reason, 'no-policy')
  }
  assert.strictEqual(controller.pinLockout.attemptsRemaining(), FREE_ATTEMPTS)

  // Policy loaded but no PIN set on it.
  controller.policyCache.setPolicyJson(JSON.stringify({ apps: {} }))
  for (let i = 0; i < 10; i++) {
    assert.strictEqual(controller.verifyPinOnly({ pin: '1234' }).reason, 'no-pin')
  }
  assert.strictEqual(controller.pinLockout.attemptsRemaining(), FREE_ATTEMPTS)
})

withSodium('a correct PIN before the limit resets the failure count', () => {
  const controller = new EnforcementController({
    activeWin: async () => null,
    sodium,
    overridesStore: new OverridesStore({ filePath: null }),
    pinLockoutStore: new PinLockoutStore({ filePath: null }),
  })
  controller.policyCache.setPolicyJson(JSON.stringify({ pinHashes: { p: hashPin(sodium, '1234') } }))

  controller.verifyPinOnly({ pin: '0000' })
  controller.verifyPinOnly({ pin: '0000' })
  assert.strictEqual(controller.pinLockout.attemptsRemaining(), FREE_ATTEMPTS - 2)

  assert.deepStrictEqual(controller.verifyPinOnly({ pin: '1234' }), { ok: true })
  assert.strictEqual(controller.pinLockout.attemptsRemaining(), FREE_ATTEMPTS)
})

withSodium('verifyPinOnly + applyPinOverride applies kid-chosen duration', async () => {
  // The PIN flow is split so the kid picks a duration post-verify, matching
  // Android's AppBlockerModule picker. verifyPinOnly marks the controller
  // verified without granting; applyPinOverride consumes that state.
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
  controller.setPolicyJson(JSON.stringify(p))
  controller.start()
  await new Promise(r => setTimeout(r, 20))
  assert.strictEqual(overlay.shows.length, 1)

  const verify = controller.verifyPinOnly({ pin: '1234' })
  assert.strictEqual(verify.ok, true)
  // No grant yet — overlay still shown.
  assert.strictEqual(overlay.hides, 0)

  const result = controller.applyPinOverride({ packageName: 'com.roblox.client', durationSeconds: 1800 })
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.durationSeconds, 1800)
  assert.ok(result.expiresAt > Date.now())
  // Grant should have triggered a re-evaluate that hides the overlay.
  assert.strictEqual(overlay.hides, 1)
  controller.stop()
})

withSodium('verifyPinOnly rejects wrong pin and leaves verified-state empty', async () => {
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

  const verify = controller.verifyPinOnly({ pin: '0000' })
  assert.strictEqual(verify.ok, false)
  assert.strictEqual(verify.reason, 'wrong-pin')

  // applyPinOverride should refuse — no PIN was verified.
  const apply = controller.applyPinOverride({ packageName: 'com.roblox.client', durationSeconds: 1800 })
  assert.deepStrictEqual(apply, { ok: false, reason: 'pin-not-verified' })
  assert.strictEqual(overlay.hides, 0)
  controller.stop()
})

test('verifyPinOnly without sodium → no-sodium', () => {
  const controller = new EnforcementController({
    activeWin: async () => null,
    intervalMs: 5,
    overridesStore: new OverridesStore({ filePath: null }),
    overlay: makeFakeOverlay(),
    sodium: null,
    logger: { log() {}, warn() {} },
  })
  const r = controller.verifyPinOnly({ pin: '1234' })
  assert.deepStrictEqual(r, { ok: false, reason: 'no-sodium' })
})

withSodium('applyPinOverride rejects duration not in allowlist', async () => {
  const overlay = makeFakeOverlay()
  const controller = new EnforcementController({
    activeWin: async () => null,
    intervalMs: 5,
    overridesStore: new OverridesStore({ filePath: null }),
    overlay,
    sodium,
    logger: { log() {}, warn() {} },
  })
  const p = policy()
  p.pinHashes = { 'parent-A': hashPin(sodium, '1234') }
  controller.setPolicyJson(JSON.stringify(p))

  assert.strictEqual(controller.verifyPinOnly({ pin: '1234' }).ok, true)
  // 999s is not one of the default [900,1800,3600,7200].
  const r = controller.applyPinOverride({ packageName: 'com.foo', durationSeconds: 999 })
  assert.deepStrictEqual(r, { ok: false, reason: 'invalid-duration' })
})

const { getAllowedPinDurationSeconds } = require('../src/enforcement')

test('getAllowedPinDurationSeconds: defaults when policy has no timeRequestMinutes', () => {
  assert.deepStrictEqual(getAllowedPinDurationSeconds({}), [900, 1800, 3600, 7200])
})

test('getAllowedPinDurationSeconds: honors policy.settings.timeRequestMinutes', () => {
  const r = getAllowedPinDurationSeconds({ settings: { timeRequestMinutes: [10, 20, 60] } })
  assert.deepStrictEqual(r, [600, 1200, 3600])
})

test('getAllowedPinDurationSeconds: dedupes and drops bad entries', () => {
  const r = getAllowedPinDurationSeconds({ settings: { timeRequestMinutes: [15, 15, 0, -5, 'bad', 30] } })
  assert.deepStrictEqual(r, [900, 1800])
})

test('controller.getPinDurationSeconds returns allowlist', () => {
  const controller = new EnforcementController({
    activeWin: async () => null,
    intervalMs: 5,
    overridesStore: new OverridesStore({ filePath: null }),
    overlay: makeFakeOverlay(),
    sodium: null,
    logger: { log() {}, warn() {} },
  })
  controller.setPolicyJson(JSON.stringify({ ...policy(), settings: { timeRequestMinutes: [15, 30] } }))
  assert.deepStrictEqual(controller.getPinDurationSeconds(), [900, 1800])
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

test('parseShortcutMap keys by normalized display name', () => {
  const quiet = { warn() {} }
  const json = JSON.stringify([
    { Name: 'Steam', Target: 'C:\\Program Files (x86)\\Steam\\steam.exe' },
    { Name: 'Microsoft Edge', Target: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
    { Name: 'NoExe', Target: 'C:\\weird.dll' },  // non-exe targets are skipped
  ])
  const map = parseShortcutMap(json, quiet)
  assert.deepStrictEqual(map.get('steam'), { exeBasename: 'steam.exe', exePath: 'C:\\Program Files (x86)\\Steam\\steam.exe' })
  // Whitespace and punctuation drop out of the key so "Microsoft Edge" matches
  // the registry DisplayName of the same app.
  assert.strictEqual(map.get('microsoftedge').exeBasename, 'msedge.exe')
  assert.strictEqual(map.has('noexe'), false)
})

test('parseShortcutMap handles empty and non-JSON gracefully', () => {
  const quiet = { warn() {} }
  assert.strictEqual(parseShortcutMap('', quiet).size, 0)
  assert.strictEqual(parseShortcutMap('[]', quiet).size, 0)
  assert.strictEqual(parseShortcutMap('not json', quiet).size, 0)
})

test('parseMsixExeMap strips subfolder from manifest Executable', () => {
  const quiet = { warn() {} }
  const json = JSON.stringify([
    { Family: 'Keet_k5xf9864y0668', Executable: 'App\\Keet.exe' },
    { Family: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe', Executable: 'CalculatorApp.exe' },
    { Family: 'Bogus.Package_deadbeef', Executable: 'not-an-exe.dll' },
  ])
  const map = parseMsixExeMap(json, quiet)
  assert.strictEqual(map.get('Keet_k5xf9864y0668'), 'keet.exe')
  assert.strictEqual(map.get('Microsoft.WindowsCalculator_8wekyb3d8bbwe'), 'calculatorapp.exe')
  assert.strictEqual(map.has('Bogus.Package_deadbeef'), false)
})

test('parseAndShape prefers Start Menu shortcut exe over DisplayIcon (Steam case)', () => {
  const quiet = { warn() {} }
  // Reproduces the real Steam registry row: DisplayIcon points at the
  // uninstaller. Without the shortcut override, the row packages as
  // win.steam because uninstall.exe misses DEFAULT_MAP.
  const stdout = JSON.stringify([
    { DisplayName: 'Steam', DisplayIcon: 'C:\\Program Files (x86)\\Steam\\uninstall.exe' },
  ])
  const shortcutMap = new Map([
    ['steam', { exeBasename: 'steam.exe', exePath: 'C:\\Program Files (x86)\\Steam\\steam.exe' }],
  ])
  const rows = parseAndShape(stdout, quiet, shortcutMap)
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].packageName, 'com.valvesoftware.android.steam.community')
  assert.strictEqual(rows[0].exeBasename, 'steam.exe')
  assert.strictEqual(rows[0].exePath, 'C:\\Program Files (x86)\\Steam\\steam.exe')
})

test('parseAndShape falls back to DisplayIcon when shortcut map misses', () => {
  const quiet = { warn() {} }
  const stdout = JSON.stringify([
    { DisplayName: 'Firefox', DisplayIcon: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe,0' },
  ])
  const rows = parseAndShape(stdout, quiet, new Map())
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].packageName, 'org.mozilla.firefox')
  assert.strictEqual(rows[0].exeBasename, 'firefox.exe')
})

test('parseUwpAndShape attaches MSIX exeBasename when available (Keet case)', () => {
  const quiet = { warn() {} }
  const stdout = JSON.stringify([
    { Name: 'Keet', AppID: 'Keet_k5xf9864y0668!App' },
    { Name: 'Calculator', AppID: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' },
  ])
  const msixMap = new Map([['Keet_k5xf9864y0668', 'keet.exe']])
  const rows = parseUwpAndShape(stdout, quiet, msixMap)
  const keet = rows.find((r) => r.packageName.startsWith('uwp.keet'))
  const calc = rows.find((r) => r.packageName.startsWith('uwp.microsoft_windowscalculator'))
  assert.ok(keet && calc)
  assert.strictEqual(keet.exeBasename, 'keet.exe')
  assert.strictEqual(calc.exeBasename, null)
})

test('enumerateInstalledApps feeds shortcut + msix maps through to rows', async () => {
  let callIdx = 0
  const responses = [
    // 1. registry
    JSON.stringify([{ DisplayName: 'Steam', DisplayIcon: 'C:\\Program Files (x86)\\Steam\\uninstall.exe' }]),
    // 2. Get-StartApps (UWP)
    JSON.stringify([{ Name: 'Keet', AppID: 'Keet_k5xf9864y0668!App' }]),
    // 3. Start Menu shortcuts
    JSON.stringify([{ Name: 'Steam', Target: 'C:\\Program Files (x86)\\Steam\\steam.exe' }]),
    // 4. MSIX manifests
    JSON.stringify([{ Family: 'Keet_k5xf9864y0668', Executable: 'App\\Keet.exe' }]),
  ]
  const fakeExec = async () => {
    const body = responses[callIdx] || '[]'
    callIdx++
    return body
  }
  const apps = await enumerateInstalledApps({ exec: fakeExec, logger: { log() {}, warn() {} } })
  const steam = apps.find((a) => a.appName === 'Steam')
  const keet = apps.find((a) => a.appName === 'Keet')
  assert.ok(steam, 'Steam row present')
  assert.strictEqual(steam.packageName, 'com.valvesoftware.android.steam.community')
  assert.strictEqual(steam.exeBasename, 'steam.exe')
  assert.ok(keet, 'Keet row present')
  assert.strictEqual(keet.packageName, 'uwp.keet_k5xf9864y0668')
  assert.strictEqual(keet.exeBasename, 'keet.exe')
})

// --- app-category --------------------------------------------------------

test('categorizeApp classifies known exe basenames', () => {
  assert.strictEqual(categorizeApp({ exeBasename: 'chrome.exe' }), 'Productivity')
  assert.strictEqual(categorizeApp({ exeBasename: 'discord.exe' }), 'Social')
  assert.strictEqual(categorizeApp({ exeBasename: 'spotify.exe' }), 'Video & Music')
  assert.strictEqual(categorizeApp({ exeBasename: 'steam.exe' }), 'Games')
  assert.strictEqual(categorizeApp({ exeBasename: 'teams.exe' }), 'Communication')
  assert.strictEqual(categorizeApp({ exeBasename: 'code.exe' }), 'Productivity')
  assert.strictEqual(categorizeApp({ exeBasename: 'RobloxPlayerBeta.exe' }), 'Games')
})

test('categorizeApp classifies known UWP families', () => {
  assert.strictEqual(categorizeApp({ packageFamilyName: 'Microsoft.XboxApp_8wekyb3d8bbwe' }), 'Games')
  assert.strictEqual(categorizeApp({ packageFamilyName: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0' }), 'Video & Music')
  assert.strictEqual(categorizeApp({ packageFamilyName: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe' }), 'Productivity')
  assert.strictEqual(categorizeApp({ packageFamilyName: 'Microsoft.BingNews_8wekyb3d8bbwe' }), 'News')
  assert.strictEqual(categorizeApp({ packageFamilyName: 'Microsoft.WindowsStore_8wekyb3d8bbwe' }), 'System')
})

test('categorizeApp classifies launcher-prefixed packageNames as Games', () => {
  assert.strictEqual(categorizeApp({ packageName: 'steam.app.391540' }), 'Games')
  assert.strictEqual(categorizeApp({ packageName: 'epic.fortnite' }), 'Games')
  assert.strictEqual(categorizeApp({ packageName: 'ubisoft.assassinscreed' }), 'Games')
  assert.strictEqual(categorizeApp({ packageName: 'ea.battlefield' }), 'Games')
  assert.strictEqual(categorizeApp({ packageName: 'gog.witcher3' }), 'Games')
})

test('categorizeApp falls back to display-name keywords', () => {
  assert.strictEqual(categorizeApp({ appName: 'Some Game Studios' }), 'Games')
  assert.strictEqual(categorizeApp({ appName: 'Khan Academy Kids' }), 'Education')
  assert.strictEqual(categorizeApp({ appName: 'YouTube Music' }), 'Video & Music')
  assert.strictEqual(categorizeApp({ appName: 'Totally Unknown Utility' }), 'Other')
})

test('categorizeApp prefers exe basename over fallback name match', () => {
  // exe wins over name keyword, which would otherwise pick Games from 'Steam'.
  assert.strictEqual(categorizeApp({ exeBasename: 'chrome.exe', appName: 'Steam' }), 'Productivity')
})

test('parseAndShape rows carry category derived from exe basename', () => {
  const quiet = { warn() {} }
  const stdout = JSON.stringify([
    { DisplayName: 'Spotify', DisplayIcon: 'C:\\Spotify\\Spotify.exe,0' },
    { DisplayName: 'Discord', DisplayIcon: 'C:\\Discord\\Discord.exe' },
    { DisplayName: 'Steam', DisplayIcon: 'C:\\Steam\\steam.exe' },
  ])
  const rows = parseAndShape(stdout, quiet)
  const byName = Object.fromEntries(rows.map((r) => [r.appName, r.category]))
  assert.strictEqual(byName['Spotify'], 'Video & Music')
  assert.strictEqual(byName['Discord'], 'Social')
  assert.strictEqual(byName['Steam'], 'Games')
})

test('parseUwpAndShape rows carry category derived from family', () => {
  const quiet = { warn() {} }
  const stdout = JSON.stringify([
    { Name: 'Xbox', AppID: 'Microsoft.XboxApp_8wekyb3d8bbwe!Microsoft.XboxApp' },
    { Name: 'Spotify', AppID: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
  ])
  const rows = parseUwpAndShape(stdout, quiet)
  const xbox = rows.find((r) => r.appName === 'Xbox')
  const spotify = rows.find((r) => r.appName === 'Spotify')
  assert.strictEqual(xbox.category, 'Games')
  assert.strictEqual(spotify.category, 'Video & Music')
})

test('enumerateInstalledApps assigns category to every row', async () => {
  let callIdx = 0
  const responses = [
    // registry
    JSON.stringify([
      { DisplayName: 'Spotify', DisplayIcon: 'C:\\Spotify\\Spotify.exe,0' },
      { DisplayName: 'Mystery Tool', DisplayIcon: 'C:\\weird\\nothing_known.exe' },
    ]),
    // UWP
    JSON.stringify([{ Name: 'Xbox', AppID: 'Microsoft.XboxApp_8wekyb3d8bbwe!Microsoft.XboxApp' }]),
    // shortcuts
    '[]',
    // msix manifests
    '[]',
  ]
  const fakeExec = async () => {
    const body = responses[callIdx] || '[]'
    callIdx++
    return body
  }
  const apps = await enumerateInstalledApps({ exec: fakeExec, logger: { log() {}, warn() {} } })
  for (const row of apps) {
    assert.ok(typeof row.category === 'string' && row.category.length > 0,
      'every row has a category: ' + row.appName)
  }
  const byName = Object.fromEntries(apps.map((r) => [r.appName, r.category]))
  assert.strictEqual(byName['Spotify'], 'Video & Music')
  assert.strictEqual(byName['Xbox'], 'Games')
  assert.strictEqual(byName['Mystery Tool'], 'Other')
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
    if (script.includes('Valve') || script.includes('Ubisoft') || script.includes('Ubisoft') || script.includes('GOG.com') || script.includes('Electronic Arts') || script.includes('Origin Games')) {
      return ''
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
    if (script.includes('Valve') || script.includes('Ubisoft') || script.includes('GOG.com') || script.includes('Electronic Arts') || script.includes('Origin Games')) {
      return ''
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

// --- TamperDetector ------------------------------------------------------

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pg-tamper-'))
}

test('TamperDetector first run reports no tamper (no prior state file)', () => {
  const dir = makeTempDir()
  let fired = null
  const td = new TamperDetector({ userDataDir: dir, onTamper: (r) => { fired = r }, now: () => 1000 })
  const result = td.checkOnStartup()
  assert.strictEqual(result.tampered, false)
  assert.strictEqual(fired, null)
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'runtime-state.json'), 'utf8'))
  assert.strictEqual(state.cleanQuit, false)
  assert.strictEqual(state.lastHeartbeat, 1000)
})

test('TamperDetector clean quit on prior session → no tamper', () => {
  const dir = makeTempDir()
  fs.writeFileSync(path.join(dir, 'runtime-state.json'), JSON.stringify({ cleanQuit: true, lastHeartbeat: 500 }))
  let fired = null
  const td = new TamperDetector({ userDataDir: dir, onTamper: (r) => { fired = r }, now: () => 1000 })
  const result = td.checkOnStartup()
  assert.strictEqual(result.tampered, false)
  assert.strictEqual(fired, null)
})

test('TamperDetector recent heartbeat + no clean quit → tamper fires', () => {
  const dir = makeTempDir()
  fs.writeFileSync(path.join(dir, 'runtime-state.json'), JSON.stringify({ cleanQuit: false, lastHeartbeat: 500 }))
  let fired = null
  const td = new TamperDetector({ userDataDir: dir, onTamper: (r) => { fired = r }, now: () => 1000 })
  const result = td.checkOnStartup()
  assert.strictEqual(result.tampered, true)
  assert.strictEqual(result.reason, 'force_stopped')
  assert.ok(fired !== null)
  assert.strictEqual(fired.reason, 'force_stopped')
})

test('TamperDetector stale heartbeat (beyond window) → no tamper', () => {
  const dir = makeTempDir()
  const start = 10_000_000
  fs.writeFileSync(path.join(dir, 'runtime-state.json'), JSON.stringify({ cleanQuit: false, lastHeartbeat: start }))
  let fired = null
  const td = new TamperDetector({ userDataDir: dir, onTamper: (r) => { fired = r }, now: () => start + STALE_MS + 1 })
  const result = td.checkOnStartup()
  assert.strictEqual(result.tampered, false)
  assert.strictEqual(fired, null)
})

test('TamperDetector markCleanQuit persists cleanQuit=true', () => {
  const dir = makeTempDir()
  const td = new TamperDetector({ userDataDir: dir, onTamper: () => {}, now: () => 2000 })
  td.checkOnStartup()
  td.markCleanQuit()
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'runtime-state.json'), 'utf8'))
  assert.strictEqual(state.cleanQuit, true)
})

test('TamperDetector corrupt state file is ignored (no tamper fire)', () => {
  const dir = makeTempDir()
  fs.writeFileSync(path.join(dir, 'runtime-state.json'), '{ not json')
  let fired = null
  const td = new TamperDetector({ userDataDir: dir, onTamper: (r) => { fired = r }, now: () => 1000 })
  const result = td.checkOnStartup()
  assert.strictEqual(result.tampered, false)
  assert.strictEqual(fired, null)
})

// --- WarningChecker tests ------------------------------------------------

// Thursday 2026-04-16 at local time. Day-of-week 4 matches Android.
function warningPolicy(extra = {}) {
  return {
    schedules: [],
    apps: {},
    ...extra,
  }
}

test('WarningChecker: returns [] when policy is null', () => {
  const wc = new WarningChecker({ now: () => THURSDAY_NOON })
  assert.deepStrictEqual(wc.check({ policy: null, foregroundPackage: null, getUsageSeconds: () => 0 }), [])
})

test('WarningChecker: default thresholds when policy.settings.warningMinutes missing', () => {
  assert.deepStrictEqual(DEFAULT_WARNING_THRESHOLDS_MIN, [10, 5, 1])
})

test('WarningChecker: schedule 10-min warning fires once per day', () => {
  const scheduleStart = new Date('2026-04-16T13:00:00').getTime()
  // 10 minutes out exactly, 12:50:00 local
  const t = scheduleStart - 10 * 60 * 1000
  let clock = t
  const wc = new WarningChecker({ now: () => clock })
  const policy = warningPolicy({
    schedules: [{ days: [4], start: '13:00', end: '14:00', label: 'Homework' }],
  })
  const events = wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 })
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].kind, 'schedule')
  assert.strictEqual(events[0].threshold, 10)
  assert.strictEqual(events[0].label, 'Homework')
  assert.ok(events[0].title.includes('10 minutes'))
  // Same tick repeated: dedupe keeps it empty.
  assert.deepStrictEqual(wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 }), [])
  // 5 seconds later (still inside 6s grace): still deduped.
  clock += 5000
  assert.deepStrictEqual(wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 }), [])
})

test('WarningChecker: schedule hits 10, 5, and 1 thresholds across the hour', () => {
  const scheduleStart = new Date('2026-04-16T13:00:00').getTime()
  let clock = scheduleStart - 10 * 60 * 1000  // 12:50
  const wc = new WarningChecker({ now: () => clock })
  const policy = warningPolicy({
    schedules: [{ days: [4], start: '13:00', end: '14:00', label: 'Bedtime' }],
  })
  const fired = []
  for (let i = 0; i < 130; i++) {  // ~10.8 min of 5s ticks
    const events = wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 })
    for (const e of events) fired.push(e.threshold)
    clock += 5000
  }
  assert.deepStrictEqual(fired.sort((a, b) => b - a), [10, 5, 1])
})

test('WarningChecker: skips schedule on wrong day-of-week', () => {
  // THURSDAY_NOON is day 4; require day 0 (Sunday) only.
  const wc = new WarningChecker({ now: () => new Date('2026-04-16T12:50:00').getTime() })
  const policy = warningPolicy({
    schedules: [{ days: [0], start: '13:00', end: '14:00', label: 'Sunday quiet' }],
  })
  assert.deepStrictEqual(wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 }), [])
})

test('WarningChecker: early-exit skips far-off schedules', () => {
  // Schedule 2 hours out — no threshold (max 10 min) can fire this tick.
  const wc = new WarningChecker({ now: () => new Date('2026-04-16T12:00:00').getTime() })
  const policy = warningPolicy({
    schedules: [{ days: [4], start: '14:00', end: '15:00', label: 'Far' }],
  })
  assert.deepStrictEqual(wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 }), [])
})

test('WarningChecker: limit warning fires for foreground app near expiry', () => {
  // App has 10 min/day, used 9:55. 5 seconds remaining would be past the
  // 1-min threshold. Use 4:55 used → 5:05 remaining → inside 5-min window.
  let clock = new Date('2026-04-16T10:00:00').getTime()
  const wc = new WarningChecker({ now: () => clock })
  const policy = warningPolicy({
    apps: { 'com.roblox.client': { status: 'allowed', appName: 'Roblox', dailyLimitSeconds: 600 } },
  })
  // remaining = 600 - used = 298 seconds → inside (300-6, 300] window
  const events = wc.check({
    policy,
    foregroundPackage: 'com.roblox.client',
    getUsageSeconds: () => 302,
  })
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].kind, 'limit')
  assert.strictEqual(events[0].threshold, 5)
  assert.strictEqual(events[0].packageName, 'com.roblox.client')
  assert.ok(events[0].title.includes('Roblox'))
  assert.ok(events[0].title.includes('5 minutes'))
})

test('WarningChecker: limit warning uses 1-minute singular wording', () => {
  const wc = new WarningChecker({ now: () => new Date('2026-04-16T10:00:00').getTime() })
  const policy = warningPolicy({
    apps: { 'com.roblox.client': { status: 'allowed', appName: 'Roblox', dailyLimitSeconds: 600 } },
  })
  const events = wc.check({
    policy,
    foregroundPackage: 'com.roblox.client',
    getUsageSeconds: () => 600 - 58,  // remaining = 58s → threshold 1 (60-6,60]
  })
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].threshold, 1)
  assert.ok(events[0].title.includes('1 minute '))
  assert.ok(!events[0].title.includes('1 minutes'))
})

test('WarningChecker: no limit warning when no foreground app', () => {
  const wc = new WarningChecker({ now: () => new Date('2026-04-16T10:00:00').getTime() })
  const policy = warningPolicy({
    apps: { 'com.roblox.client': { status: 'allowed', appName: 'Roblox', dailyLimitSeconds: 600 } },
  })
  assert.deepStrictEqual(wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 298 }), [])
})

test('WarningChecker: no limit warning for app without dailyLimitSeconds', () => {
  const wc = new WarningChecker({ now: () => new Date('2026-04-16T10:00:00').getTime() })
  const policy = warningPolicy({
    apps: { 'com.discord': { status: 'allowed', appName: 'Discord' } },
  })
  assert.deepStrictEqual(wc.check({
    policy, foregroundPackage: 'com.discord', getUsageSeconds: () => 298,
  }), [])
})

test('WarningChecker: honors custom policy.settings.warningMinutes', () => {
  // Policy configures [30, 15] — the 5-min default must NOT fire.
  const scheduleStart = new Date('2026-04-16T13:00:00').getTime()
  let clock = scheduleStart - 30 * 60 * 1000  // 30 min out
  const wc = new WarningChecker({ now: () => clock })
  const policy = warningPolicy({
    settings: { warningMinutes: [30, 15] },
    schedules: [{ days: [4], start: '13:00', end: '14:00', label: 'Homework' }],
  })
  const fired = []
  for (let i = 0; i < 400; i++) {  // ~33 min of 5s ticks
    const events = wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 })
    for (const e of events) fired.push(e.threshold)
    clock += 5000
  }
  assert.deepStrictEqual(fired.sort((a, b) => b - a), [30, 15])
})

test('WarningChecker: unsorted warningMinutes still fires all thresholds', () => {
  // Ascending [1, 10] — checker must sort descending so the 10-min gate
  // doesn't cut off the 10-min warning.
  const scheduleStart = new Date('2026-04-16T13:00:00').getTime()
  let clock = scheduleStart - 11 * 60 * 1000
  const wc = new WarningChecker({ now: () => clock })
  const policy = warningPolicy({
    settings: { warningMinutes: [1, 10] },
    schedules: [{ days: [4], start: '13:00', end: '14:00', label: 'Homework' }],
  })
  const fired = []
  for (let i = 0; i < 140; i++) {
    const events = wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 })
    for (const e of events) fired.push(e.threshold)
    clock += 5000
  }
  assert.deepStrictEqual(fired.sort((a, b) => b - a), [10, 1])
})

test('WarningChecker: invalid warningMinutes falls back to defaults', () => {
  const scheduleStart = new Date('2026-04-16T13:00:00').getTime()
  const clock = scheduleStart - 10 * 60 * 1000
  const wc = new WarningChecker({ now: () => clock })
  const policy = warningPolicy({
    settings: { warningMinutes: ['nope', -5, 0] },
    schedules: [{ days: [4], start: '13:00', end: '14:00', label: 'Homework' }],
  })
  const events = wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 })
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].threshold, 10)
})

test('WarningChecker: dedupe resets at midnight', () => {
  const wc = new WarningChecker({ now: () => new Date('2026-04-16T12:50:00').getTime() })
  const policy = warningPolicy({
    schedules: [{ days: [4], start: '13:00', end: '14:00', label: 'Homework' }],
  })
  // Fire once on Thursday.
  const firstRun = wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 })
  assert.strictEqual(firstRun.length, 1)
  // Second tick same day — dedupe.
  wc._now = () => new Date('2026-04-16T12:50:05').getTime()
  assert.strictEqual(wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 }).length, 0)
  // Next day at the same time — Friday (day 5), so schedule won't match days=[4] now.
  // Use a schedule that matches Friday too so we can verify the reset.
  const policyFriday = warningPolicy({
    schedules: [{ days: [4, 5], start: '13:00', end: '14:00', label: 'Homework' }],
  })
  wc._now = () => new Date('2026-04-17T12:50:00').getTime()
  const nextDay = wc.check({ policy: policyFriday, foregroundPackage: null, getUsageSeconds: () => 0 })
  assert.strictEqual(nextDay.length, 1, 'dedupe should reset overnight')
})

test('WarningChecker: handles overnight wrap (schedule start before now modulo 24h)', () => {
  // Now 23:50, schedule starts at 00:00 (midnight) → 10 min away via wrap.
  const wc = new WarningChecker({ now: () => new Date('2026-04-16T23:50:00').getTime() })
  const policy = warningPolicy({
    schedules: [{ days: [4], start: '00:00', end: '06:00', label: 'Overnight' }],
  })
  const events = wc.check({ policy, foregroundPackage: null, getUsageSeconds: () => 0 })
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].threshold, 10)
})

test('WarningChecker: getUsageSeconds throwing is treated as 0', () => {
  // remaining becomes 600 = 10min exactly → 10-min threshold should fire.
  const wc = new WarningChecker({ now: () => new Date('2026-04-16T10:00:00').getTime() })
  const policy = warningPolicy({
    apps: { 'com.roblox.client': { status: 'allowed', appName: 'Roblox', dailyLimitSeconds: 600 } },
  })
  const events = wc.check({
    policy,
    foregroundPackage: 'com.roblox.client',
    getUsageSeconds: () => { throw new Error('boom') },
  })
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].threshold, 10)
})

test('EnforcementController emits warning events when checker returns events', () => {
  // Drive the controller directly, no monitor tick — just force a foreground
  // and tick _checkWarnings once. Verifies the pure module is correctly
  // re-emitted as an 'warning' EventEmitter event.
  const activeWin = async () => null
  const ctrl = new EnforcementController({
    activeWin,
    overlay: { show() {}, hide() {} },
    logger: { log() {}, warn() {} },
  })
  const scheduleStart = new Date('2026-04-16T13:00:00').getTime()
  const policy = warningPolicy({
    schedules: [{ days: [4], start: '13:00', end: '14:00', label: 'Bedtime' }],
  })
  // Replace the checker with one whose clock is fixed so the test is stable.
  ctrl._warningChecker = new WarningChecker({ now: () => scheduleStart - 10 * 60 * 1000 })
  ctrl.policyCache.setPolicyJson(JSON.stringify(policy))
  const fired = []
  ctrl.on('warning', (ev) => fired.push(ev))
  ctrl._checkWarnings()
  assert.strictEqual(fired.length, 1)
  assert.strictEqual(fired[0].kind, 'schedule')
  assert.strictEqual(fired[0].threshold, 10)
})

// --- Launcher scanners ---------------------------------------------------

test('parseVdf parses flat key-value pairs', () => {
  const text = '"AppState" { "appid" "391540" "name" "UNDERTALE" "installdir" "Undertale" }'
  const tree = parseVdf(text)
  assert.strictEqual(tree.AppState.appid, '391540')
  assert.strictEqual(tree.AppState.name, 'UNDERTALE')
  assert.strictEqual(tree.AppState.installdir, 'Undertale')
})

test('parseVdf parses nested objects', () => {
  const text = '"libraryfolders" { "0" { "path" "C:\\\\Steam" } "1" { "path" "D:\\\\SteamLib" } }'
  const tree = parseVdf(text)
  assert.strictEqual(tree.libraryfolders['0'].path, 'C:\\Steam')
  assert.strictEqual(tree.libraryfolders['1'].path, 'D:\\SteamLib')
})

test('parseVdf handles escape sequences', () => {
  const text = '"root" { "message" "line1\\nline2" "quote" "he said \\"hi\\"" }'
  const tree = parseVdf(text)
  assert.strictEqual(tree.root.message, 'line1\nline2')
  assert.strictEqual(tree.root.quote, 'he said "hi"')
})

test('parseVdf skips // comments', () => {
  const text = '// top comment\n"root" { // inline\n "k" "v" }'
  const tree = parseVdf(text)
  assert.strictEqual(tree.root.k, 'v')
})

test('isBlacklisted catches installers and redistributables', () => {
  assert.strictEqual(isBlacklisted('unins000.exe'), true)
  assert.strictEqual(isBlacklisted('UnityCrashHandler64.exe'), true)
  assert.strictEqual(isBlacklisted('vc_redist.x64.exe'), true)
  assert.strictEqual(isBlacklisted('UE4PrereqSetup_x64.exe'), true)
  assert.strictEqual(isBlacklisted('undertale.exe'), false)
  assert.strictEqual(isBlacklisted('Game.exe'), false)
})

test('scanSteam returns empty when SteamPath is missing', async () => {
  const fakeExec = async () => ''
  const rows = await scanSteam({ exec: fakeExec, fs: { readFile: async () => { throw new Error('ENOENT') } }, logger: { warn() {}, log() {} } })
  assert.deepStrictEqual(rows, [])
})

test('scanSteam discovers a game from fixture library + manifest', async () => {
  const STEAM = 'C:\\Steam'
  const libraryfolders = `
"libraryfolders"
{
  "0"
  {
    "path"    "C:\\\\Steam"
  }
  "1"
  {
    "path"    "D:\\\\SteamLibrary"
  }
}`
  const manifest = `
"AppState"
{
  "appid"        "391540"
  "name"         "UNDERTALE"
  "installdir"   "Undertale"
}`
  const files = {
    'C:\\Steam\\steamapps\\libraryfolders.vdf': libraryfolders,
    'C:\\Steam\\steamapps\\appmanifest_391540.acf': manifest,
  }
  const dirs = {
    'C:\\Steam\\steamapps': ['appmanifest_391540.acf'],
    'D:\\SteamLibrary\\steamapps': [],
    'C:\\Steam\\steamapps\\common\\Undertale': [
      { name: 'UNDERTALE.exe', isFile: () => true, isDirectory: () => false },
      { name: 'unins000.exe', isFile: () => true, isDirectory: () => false },
      { name: 'data', isFile: () => false, isDirectory: () => true },
    ],
  }
  const sizes = {
    'C:\\Steam\\steamapps\\common\\Undertale\\UNDERTALE.exe': 12_000_000,
  }
  const fakeFs = {
    readFile: async (p) => {
      if (files[p] !== undefined) return files[p]
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
    readdir: async (p, opts) => {
      if (dirs[p] === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      if (opts && opts.withFileTypes) return dirs[p]
      return dirs[p].map((e) => typeof e === 'string' ? e : e.name)
    },
    stat: async (p) => {
      if (sizes[p] !== undefined) return { size: sizes[p] }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  }
  const fakeExec = async () => STEAM
  const rows = await scanSteam({ exec: fakeExec, fs: fakeFs, logger: { warn() {}, log() {} } })
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].packageName, 'steam.app.391540')
  assert.strictEqual(rows[0].appName, 'UNDERTALE')
  assert.strictEqual(rows[0].exeBasename, 'undertale.exe')
  assert.strictEqual(rows[0].isLauncher, false)
})

test('scanEpic returns empty when manifest dir is missing', async () => {
  const fakeFs = { readdir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, readFile: async () => '' }
  const rows = await scanEpic({ fs: fakeFs, env: { ProgramData: 'C:\\ProgramData' }, logger: { warn() {}, log() {} } })
  assert.deepStrictEqual(rows, [])
})

test('scanEpic parses a complete manifest', async () => {
  const manifest = JSON.stringify({
    DisplayName: 'Fall Guys',
    LaunchExecutable: 'FallGuys_client.exe',
    InstallLocation: 'C:\\Epic\\FallGuys',
    CatalogItemId: '0a2d9f6403244d1b9e2b3f7a9fb9aa80',
    AppName: '0a2d9f6403244d1b9e2b3f7a9fb9aa80',
  })
  const fakeFs = {
    readdir: async () => ['fallguys.item', 'readme.txt'],
    readFile: async (p) => {
      if (/fallguys\.item$/.test(p)) return manifest
      return ''
    },
  }
  const rows = await scanEpic({ fs: fakeFs, env: { ProgramData: 'C:\\ProgramData' }, logger: { warn() {}, log() {} } })
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].appName, 'Fall Guys')
  assert.strictEqual(rows[0].exeBasename, 'fallguys_client.exe')
  assert.ok(rows[0].packageName.startsWith('epic.app.'))
})

test('scanEpic skips incomplete installs', async () => {
  const manifest = JSON.stringify({
    DisplayName: 'Half Installed',
    LaunchExecutable: 'game.exe',
    InstallLocation: 'C:\\Epic\\HalfInstalled',
    bIsIncompleteInstall: true,
  })
  const fakeFs = {
    readdir: async () => ['bad.item'],
    readFile: async () => manifest,
  }
  const rows = await scanEpic({ fs: fakeFs, env: { ProgramData: 'C:\\ProgramData' }, logger: { warn() {}, log() {} } })
  assert.deepStrictEqual(rows, [])
})

test('extractExeFromDisplayIcon parses quoted and indexed forms', () => {
  assert.strictEqual(extractExeFromDisplayIcon('"C:\\EA\\sims4\\game.exe",0').basename, 'game.exe')
  assert.strictEqual(extractExeFromDisplayIcon('C:\\EA\\sims4\\game.exe,0').basename, 'game.exe')
  assert.strictEqual(extractExeFromDisplayIcon('C:\\EA\\sims4\\game.exe').basename, 'game.exe')
  assert.strictEqual(extractExeFromDisplayIcon('C:\\readme.txt'), null)
  assert.strictEqual(extractExeFromDisplayIcon(null), null)
})

test('buildGogRow produces row with stable gog.app.<id> packageName', () => {
  const row = buildGogRow({
    source: 'gog',
    keyName: '1207658924',
    gameID: '1207658924',
    gameName: 'Baldur\'s Gate',
    path: 'C:\\GOG Games\\Baldurs Gate',
    exeFile: 'BGMain.exe',
  }, {
    fs: { statSync: () => ({ isDirectory: () => true, isFile: () => true }) },
    logger: { warn() {} },
  })
  assert.strictEqual(row.packageName, 'gog.app.1207658924')
  assert.strictEqual(row.appName, "Baldur's Gate")
  assert.strictEqual(row.exeBasename, 'bgmain.exe')
})

test('buildGogRow rejects entries whose install dir is gone', () => {
  const row = buildGogRow({
    source: 'gog',
    keyName: '123',
    gameID: '123',
    gameName: 'Old Game',
    path: 'C:\\Stale',
    exeFile: 'Game.exe',
  }, {
    fs: { statSync: () => { throw new Error('ENOENT') } },
    logger: { warn() {} },
  })
  assert.strictEqual(row, null)
})

test('buildUbisoftRow guesses biggest non-blacklisted exe', () => {
  const fakeFs = {
    statSync(p) {
      if (/\\Game\.exe$/.test(p)) return { size: 50_000_000 }
      if (/\\tool\.exe$/.test(p)) return { size: 5_000_000 }
      if (/\\unins000\.exe$/.test(p)) return { size: 1_000 }
      return { isDirectory: () => true, isFile: () => true }
    },
    readdirSync(p, opts) {
      if (/5595$/.test(p)) return [
        { name: 'Game.exe', isFile: () => true, isDirectory: () => false },
        { name: 'tool.exe', isFile: () => true, isDirectory: () => false },
        { name: 'unins000.exe', isFile: () => true, isDirectory: () => false },
      ]
      return []
    },
  }
  const row = buildUbisoftRow({
    source: 'ubisoft',
    keyName: '5595',
    InstallDir: 'C:\\Ubisoft\\5595',
  }, { fs: fakeFs, logger: { warn() {} } })
  assert.strictEqual(row.packageName, 'ubisoft.app.5595')
  assert.strictEqual(row.exeBasename, 'game.exe')
})

test('enumerateRegistryLaunchers dispatches rows by source tag', async () => {
  const exec = async () => JSON.stringify([
    { source: 'gog', keyName: '1', gameID: '1', gameName: 'G', path: 'C:\\G', exeFile: 'g.exe' },
    { source: 'ubisoft', keyName: 'nope', InstallDir: 'C:\\missing' },
    { source: 'unknown', keyName: 'x' },
  ])
  const fakeFs = {
    statSync(p) {
      if (p === 'C:\\G') return { isDirectory: () => true, isFile: () => true }
      if (p === 'C:\\G\\g.exe') return { isFile: () => true }
      throw new Error('ENOENT')
    },
    readdirSync: () => [],
  }
  const rows = await enumerateRegistryLaunchers({ exec, fs: fakeFs, logger: { warn() {} } })
  assert.strictEqual(rows.length, 1)
  assert.strictEqual(rows[0].packageName, 'gog.app.1')
})

test('enumerateLauncherApps returns [] when every scanner fails gracefully', async () => {
  // No exec provided → registry scanner exits early; default fs finds no
  // Epic manifests and no Steam libraryfolders.vdf on a non-Windows dev box.
  const rows = await enumerateLauncherApps({ logger: { log() {}, warn() {} } })
  assert.ok(Array.isArray(rows))
  assert.strictEqual(rows.length, 0)
})

test('mergeRows launcher row wins over win.<slug> matching by appName', () => {
  const registry = [
    { packageName: 'win.undertale', appName: 'Undertale', exeBasename: 'undertale.exe', iconBase64: 'WElDT04=' },
    { packageName: 'win.keep', appName: 'Keep Me', exeBasename: 'keep.exe' },
  ]
  const uwp = []
  const launchers = [
    { packageName: 'steam.app.391540', appName: 'Undertale', exeBasename: 'undertale.exe' },
  ]
  const merged = mergeRows(registry, uwp, launchers)
  assert.strictEqual(merged.length, 2, 'duplicate win.<slug> absorbed by launcher')
  const steam = merged.find((r) => r.packageName === 'steam.app.391540')
  assert.ok(steam)
  assert.strictEqual(steam.iconBase64, 'WElDT04=', 'registry icon carried over to launcher row')
  assert.ok(merged.find((r) => r.packageName === 'win.keep'))
})

test('mergeRows launcher row wins over win.<slug> matching by exeBasename', () => {
  // Fuzzy-name might miss if the registry display name differs from the
  // launcher's app name (e.g. "UNDERTALE" vs "Undertale Deluxe Edition"),
  // but the exe basename still catches the match.
  const registry = [
    { packageName: 'win.different_name', appName: 'Game (Steam Edition)', exeBasename: 'undertale.exe' },
  ]
  const launchers = [
    { packageName: 'steam.app.391540', appName: 'UNDERTALE', exeBasename: 'undertale.exe' },
  ]
  const merged = mergeRows(registry, [], launchers)
  assert.strictEqual(merged.length, 1)
  assert.strictEqual(merged[0].packageName, 'steam.app.391540')
})

test('mergeRows keeps uncontested launcher rows', () => {
  const launchers = [
    { packageName: 'steam.app.1', appName: 'A', exeBasename: 'a.exe' },
    { packageName: 'epic.app.b', appName: 'B', exeBasename: 'b.exe' },
  ]
  const merged = mergeRows([], [], launchers)
  assert.strictEqual(merged.length, 2)
})

// --- Linux apps enumerator -----------------------------------------------

const linuxEnum = require('../src/enforcement/apps-enumerator-linux')

test('linux extractExeBasenameFromExec handles plain exec', () => {
  assert.strictEqual(linuxEnum.extractExeBasenameFromExec('firefox %u'), 'firefox')
  assert.strictEqual(linuxEnum.extractExeBasenameFromExec('/usr/bin/firefox'), 'firefox')
})

test('linux extractExeBasenameFromExec strips quoted paths and trailing args', () => {
  assert.strictEqual(
    linuxEnum.extractExeBasenameFromExec('"/usr/bin/google-chrome" --no-sandbox %U'),
    'google-chrome',
  )
})

test('linux extractExeBasenameFromExec peels env wrapper', () => {
  assert.strictEqual(linuxEnum.extractExeBasenameFromExec('env LANG=C foo --bar'), 'foo')
})

test('linux extractExeBasenameFromExec peels sh -c "binary args"', () => {
  assert.strictEqual(linuxEnum.extractExeBasenameFromExec('sh -c "steam --silent"'), 'steam')
})

test('linux extractExeBasenameFromExec peels flatpak run with options in any order', () => {
  assert.strictEqual(
    linuxEnum.extractExeBasenameFromExec('flatpak run --branch=stable org.mozilla.firefox'),
    'org.mozilla.firefox',
  )
  assert.strictEqual(
    linuxEnum.extractExeBasenameFromExec('flatpak --user run org.bar'),
    'org.bar',
  )
})

test('linux extractExeBasenameFromExec peels snap run', () => {
  assert.strictEqual(linuxEnum.extractExeBasenameFromExec('snap run signal-desktop'), 'signal-desktop')
})

test('linux extractExeBasenameFromExec returns null for %-only Exec', () => {
  assert.strictEqual(linuxEnum.extractExeBasenameFromExec('%U'), null)
})

test('linux extractExeBasenameFromExec handles single-quoted tokens', () => {
  assert.strictEqual(
    linuxEnum.extractExeBasenameFromExec("flatpak 'run' org.foo.iris"),
    'org.foo.iris',
  )
})

test('linux categorizeFromXdg prefers WebBrowser over Network', () => {
  assert.strictEqual(linuxEnum.categorizeFromXdg('Network;WebBrowser'), 'Productivity')
})

test('linux categorizeFromXdg picks Games over AudioVideo', () => {
  assert.strictEqual(linuxEnum.categorizeFromXdg('AudioVideo;Game'), 'Games')
})

test('linux categorizeFromXdg falls back to Other', () => {
  assert.strictEqual(linuxEnum.categorizeFromXdg(''), 'Other')
  assert.strictEqual(linuxEnum.categorizeFromXdg(undefined), 'Other')
})

test('linux parseDesktopFile reads [Desktop Entry] and ignores locale keys', () => {
  const fields = linuxEnum.parseDesktopFile([
    '[Desktop Entry]',
    'Type=Application',
    'Name=PearGuard',
    'Name[de]=Birnenwache',  // locale-suffixed; should be skipped
    'Exec=pearguard',
    '',
    '[Desktop Action New]',
    'Name=ShouldBeIgnored',
  ].join('\n'))
  assert.strictEqual(fields.Name, 'PearGuard')
  assert.strictEqual(fields.Exec, 'pearguard')
  assert.strictEqual(fields.Type, 'Application')
  // Make sure the action subgroup didn't bleed into the main fields.
  assert.notStrictEqual(fields.Name, 'ShouldBeIgnored')
})

test('linux shouldHide drops non-Application Type entries', () => {
  assert.strictEqual(linuxEnum.shouldHide({ Type: 'Directory', Name: 'x' }), true)
})

test('linux shouldHide drops NoDisplay and Hidden entries', () => {
  assert.strictEqual(linuxEnum.shouldHide({ Type: 'Application', NoDisplay: 'true' }), true)
  assert.strictEqual(linuxEnum.shouldHide({ Type: 'Application', Hidden: 'true' }), true)
})

test('linux shouldHide honors OnlyShowIn against XDG_CURRENT_DESKTOP', () => {
  const saved = process.env.XDG_CURRENT_DESKTOP
  process.env.XDG_CURRENT_DESKTOP = 'GNOME'
  try {
    assert.strictEqual(linuxEnum.shouldHide({ Type: 'Application', OnlyShowIn: 'KDE;' }), true)
    assert.strictEqual(linuxEnum.shouldHide({ Type: 'Application', OnlyShowIn: 'GNOME;KDE;' }), false)
  } finally {
    if (saved === undefined) delete process.env.XDG_CURRENT_DESKTOP
    else process.env.XDG_CURRENT_DESKTOP = saved
  }
})

test('linux enumerateInstalledApps returns shaped rows from a temp dir', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-enum-'))
  try {
    fs.writeFileSync(path.join(tmpDir, 'firefox.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Firefox',
      'Exec=firefox %u',
      'Categories=Network;WebBrowser;',
    ].join('\n'))
    fs.writeFileSync(path.join(tmpDir, 'hidden.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Hidden',
      'NoDisplay=true',
      'Exec=hidden',
    ].join('\n'))
    fs.writeFileSync(path.join(tmpDir, 'noexec.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=NoExec',
    ].join('\n'))
    // Only valid on linux — skip otherwise so CI macOS/Windows doesn't fail.
    if (process.platform !== 'linux') return
    const rows = await linuxEnum.enumerateInstalledApps({ dirs: [tmpDir], logger: { log() {} } })
    assert.strictEqual(rows.length, 1)
    assert.deepStrictEqual(rows[0], {
      packageName: 'linux.firefox',
      appName: 'Firefox',
      exeBasename: 'firefox',
      isLauncher: false,
      category: 'Productivity',
    })
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('linux ExeMap with LINUX_DEFAULT_MAP resolves firefox basename', () => {
  const map = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP)
  assert.strictEqual(map.resolve('/usr/bin/firefox'), 'org.mozilla.firefox')
  assert.strictEqual(map.resolve('/usr/bin/firefox-esr'), 'org.mozilla.firefox')
  assert.strictEqual(map.resolve('/usr/bin/google-chrome'), 'com.android.chrome')
})

test('linux ExeMap resolves steamwebhelper via alias chain', () => {
  const map = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP)
  // active-win on Linux reports the steam UI as steamwebhelper. The alias
  // chain should route it to steam → com.valvesoftware.android.steam.community.
  assert.strictEqual(
    map.resolve('/home/kid/.local/share/Steam/ubuntu12_64/steamwebhelper'),
    'com.valvesoftware.android.steam.community',
  )
})

test('linux ExeMap returns null for unknown basename', () => {
  const map = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP)
  assert.strictEqual(map.resolve('/usr/bin/some-unmapped-tool'), null)
})

test('computeAppImageMountPrefix takes first 6 chars of full basename, lowercased', () => {
  // Verified against real mounts on Fedora 44:
  assert.strictEqual(computeAppImageMountPrefix('pearguard-v0.1.0.AppImage'), 'peargu')
  assert.strictEqual(computeAppImageMountPrefix('pearcal.appimage'), 'pearca')
  // Short basenames retain literal punctuation (the runtime copies bytes
  // byte-for-byte, it doesn't strip extension):
  assert.strictEqual(computeAppImageMountPrefix('keet.appimage'), 'keet.a')
  // Case-mixed filenames lowercase for the lookup map but match a mounted
  // case-preserved path (extractAppImageMountPrefix lowercases too).
  assert.strictEqual(computeAppImageMountPrefix('PearCal.AppImage'), 'pearca')
  // Edge cases:
  assert.strictEqual(computeAppImageMountPrefix(''), null)
  assert.strictEqual(computeAppImageMountPrefix(null), null)
})

test('extractAppImageMountPrefix recovers prefix from real runtime mount paths', () => {
  // Verified shapes from the host (Fedora 44):
  assert.strictEqual(extractAppImageMountPrefix('/tmp/.mount_peargu9A38YE/pearguard'), 'peargu')
  assert.strictEqual(extractAppImageMountPrefix('/tmp/.mount_keet.aGFHXiA/Keet'), 'keet.a')
  assert.strictEqual(extractAppImageMountPrefix('/tmp/.mount_pearcai2Vn5o/usr/bin/pearcal'), 'pearca')
  // Case-preserved mount path → lowercased prefix
  assert.strictEqual(extractAppImageMountPrefix('/tmp/.mount_PearCidkjbHp/x'), 'pearci')
  // Non-mount path
  assert.strictEqual(extractAppImageMountPrefix('/usr/bin/firefox'), null)
  // Too short to be a real mount (no random suffix)
  assert.strictEqual(extractAppImageMountPrefix('/tmp/.mount_abc/x'), null)
})

test('linux ExeMap.learn registers an AppImage mount prefix from the filename', () => {
  const map = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP)
  map.learn('pearguard-v0.1.0.AppImage', 'linux.pearguard')
  // Direct filename lookup still works:
  assert.strictEqual(map.resolve('/home/kid/Downloads/pearguard-v0.1.0.AppImage'), 'linux.pearguard')
  // Mount-path lookup uses the predicted prefix:
  assert.strictEqual(map.resolve('/tmp/.mount_peargu9A38YE/pearguard'), 'linux.pearguard')
  // Different mount path for the same prefix still resolves.
  assert.strictEqual(map.resolve('/tmp/.mount_pearguABCDEF/usr/bin/foo'), 'linux.pearguard')
})

test('linux ExeMap mount prefix lookup does not fire for non-AppImage learn', () => {
  const map = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP)
  map.learn('firefox-esr', 'linux.firefox_esr')
  // /tmp/.mount_firefoXXXXXX would resolve only if firefox-esr were learned
  // as an AppImage; bare basename .learn() must NOT poison the prefix map.
  assert.strictEqual(map.resolve('/tmp/.mount_firefoXXXXXX/firefox-bin'), null)
})

test('ExeMap persists learned mappings to disk and reloads them on construct', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exemap-'))
  const persistPath = path.join(dir, 'exemap.json')
  try {
    // First session: learn a few mappings, force the debounced save to disk.
    const a = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP, persistPath)
    a.learn('myapp', 'com.example.myapp')
    a.learn('mygame.appimage', 'linux.mygame')
    a.learnAlias('myapp-helper', 'myapp')
    a._flushPersist()  // bypass the debounce timer

    // File now exists and contains the learned mappings.
    assert.ok(fs.existsSync(persistPath))
    const raw = JSON.parse(fs.readFileSync(persistPath, 'utf8'))
    assert.strictEqual(raw.basenames.myapp, 'com.example.myapp')
    assert.strictEqual(raw.basenames['mygame.appimage'], 'linux.mygame')
    assert.strictEqual(raw.appImagePrefixes.mygame, 'linux.mygame')
    assert.strictEqual(raw.aliases['myapp-helper'], 'myapp')

    // Second session: new instance loads the persisted state.
    const b = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP, persistPath)
    assert.strictEqual(b.resolve('/usr/bin/myapp'), 'com.example.myapp')
    assert.strictEqual(b.resolve('/tmp/.mount_mygameXYZ123/inner'), 'linux.mygame')
    // alias still routes through to the learned myapp
    assert.strictEqual(b.resolve('/usr/bin/myapp-helper'), 'com.example.myapp')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ExeMap loads gracefully when persisted file is missing or corrupt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-exemap-bad-'))
  const persistPath = path.join(dir, 'exemap.json')
  try {
    // Missing file: should construct cleanly and behave as default.
    const a = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP, persistPath)
    assert.strictEqual(a.resolve('/usr/bin/firefox'), 'org.mozilla.firefox')
    // Corrupt JSON: constructor must not throw and must still use defaults.
    fs.writeFileSync(persistPath, '{not json')
    const b = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP, persistPath)
    assert.strictEqual(b.resolve('/usr/bin/firefox'), 'org.mozilla.firefox')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ExeMap without persistPath is a pure in-memory store (no fs touches)', () => {
  // Constructing without persistPath must not crash and must behave the
  // same as before. Regression guard for existing test setups.
  const m = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP)
  m.learn('firefox-esr', 'linux.firefox_esr')
  assert.strictEqual(m.resolve('/usr/bin/firefox-esr'), 'linux.firefox_esr')
  // _flushPersist is a no-op without persistPath.
  m._flushPersist()
})

test('linux ExeMap direct basename wins over mount prefix lookup', () => {
  const map = new ExeMap(LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP)
  // Learn two unrelated apps whose prefixes happen to overlap.
  map.learn('pearguard-v0.1.0.AppImage', 'linux.pearguard')
  map.learn('pearguard', 'linux.pearguard_native')
  // Mount path -> only the AppImage prefix map applies (basename pearguard
  // doesn't match the inner binary name, falls through to prefix).
  // Wait — actually basename of /tmp/.mount_peargu../pearguard IS `pearguard`,
  // which IS in the direct map. So direct map wins.
  assert.strictEqual(map.resolve('/tmp/.mount_pearguXYZ123/pearguard'), 'linux.pearguard_native')
})

test('isSystemExempt allows linux desktop shells', () => {
  assert.strictEqual(isSystemExempt('gnome-shell'), true)
  assert.strictEqual(isSystemExempt('kwin_wayland'), true)
  assert.strictEqual(isSystemExempt('plasmashell'), true)
  assert.strictEqual(isSystemExempt('mutter'), true)
  assert.strictEqual(isSystemExempt('Xwayland'), true)
})

test('isSystemExempt is case-insensitive for linux exempt names', () => {
  assert.strictEqual(isSystemExempt('GNOME-Shell'), true)
})

test('isSystemExempt still allows windows shell basenames', () => {
  // The Linux additions must not break the existing Windows behavior.
  assert.strictEqual(isSystemExempt('explorer.exe'), true)
  assert.strictEqual(isSystemExempt('applicationframehost.exe'), true)
})

test('LINUX_SYSTEM_EXEMPT_BASENAMES never overlaps the windows set', () => {
  // Linux entries have no .exe; Windows entries always do. Guard the
  // invariant so a future addition can't introduce a silent collision.
  const { SYSTEM_EXEMPT_BASENAMES } = require('../src/enforcement/block-evaluator')
  for (const name of LINUX_SYSTEM_EXEMPT_BASENAMES) {
    assert.strictEqual(SYSTEM_EXEMPT_BASENAMES.has(name), false, 'collision: ' + name)
    assert.strictEqual(name.endsWith('.exe'), false, 'linux entry ends with .exe: ' + name)
  }
})

// --- userData migration (pearguard-windows -> pearguard-desktop) ---------

const { migrateUserData, userDataDirFor } = require('../src/main/userdata-migrate')

test('userDataDirFor picks platform-appropriate path', () => {
  // Win32: %APPDATA%\<name>
  assert.strictEqual(
    userDataDirFor('pearguard-desktop', { platform: 'win32', env: { APPDATA: 'C:\\Users\\kid\\AppData\\Roaming' }, home: 'C:\\Users\\kid' }),
    path.join('C:\\Users\\kid\\AppData\\Roaming', 'pearguard-desktop'),
  )
  // Linux without XDG_CONFIG_HOME → ~/.config
  assert.strictEqual(
    userDataDirFor('pearguard-desktop', { platform: 'linux', env: {}, home: '/home/kid' }),
    '/home/kid/.config/pearguard-desktop',
  )
  // Linux with XDG_CONFIG_HOME set
  assert.strictEqual(
    userDataDirFor('pearguard-desktop', { platform: 'linux', env: { XDG_CONFIG_HOME: '/data/xdg' }, home: '/home/kid' }),
    '/data/xdg/pearguard-desktop',
  )
})

test('migrateUserData copies old dir to new and writes sentinel', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-migrate-'))
  const oldDir = path.join(root, 'pearguard-windows')
  const newDir = path.join(root, 'pearguard-desktop')
  try {
    // Set up a fake old install with a Hyperbee-shaped subtree.
    fs.mkdirSync(path.join(oldDir, 'pearguard', 'core'), { recursive: true })
    fs.writeFileSync(path.join(oldDir, 'pearguard', 'core', 'data'), 'hyperbee-bytes')
    fs.writeFileSync(path.join(oldDir, 'exemap.json'), '{"basenames":{}}')
    fs.writeFileSync(path.join(oldDir, 'overrides.json'), '{}')

    const result = migrateUserData({ oldDir, newDir, logger: { log() {}, warn() {} } })
    assert.strictEqual(result.migrated, true)
    assert.ok(fs.existsSync(path.join(newDir, 'pearguard', 'core', 'data')))
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'pearguard', 'core', 'data'), 'utf8'), 'hyperbee-bytes')
    assert.ok(fs.existsSync(path.join(newDir, 'exemap.json')))
    assert.ok(fs.existsSync(path.join(newDir, '.migrated-from-pearguard-windows')))

    // Second call must be a no-op (sentinel present).
    const second = migrateUserData({ oldDir, newDir, logger: { log() {}, warn() {} } })
    assert.strictEqual(second.migrated, false)
    assert.strictEqual(second.reason, 'sentinel-present')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('migrateUserData skips when old dir is absent (fresh install)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-migrate-fresh-'))
  try {
    const r = migrateUserData({
      oldDir: path.join(root, 'pearguard-windows'),  // does not exist
      newDir: path.join(root, 'pearguard-desktop'),
      logger: { log() {}, warn() {} },
    })
    assert.strictEqual(r.migrated, false)
    assert.strictEqual(r.reason, 'no-old-dir')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('migrateUserData deletes CORESTORE in the new dir so device-file regenerates', () => {
  // Hypercore's device-file binds the CORESTORE file to its inode + birthtime.
  // A copied CORESTORE has a fresh inode and trips the tamper check on next
  // open, so we drop it after copying and let corestore make a new one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-migrate-corestore-'))
  const oldDir = path.join(root, 'pearguard-windows')
  const newDir = path.join(root, 'pearguard-desktop')
  try {
    fs.mkdirSync(path.join(oldDir, 'pearguard', 'core', 'db'), { recursive: true })
    fs.writeFileSync(path.join(oldDir, 'pearguard', 'core', 'CORESTORE'), 'fake-device-file-bytes')
    // Sibling files should survive — they're the actual Hyperbee data.
    fs.writeFileSync(path.join(oldDir, 'pearguard', 'core', 'db', 'CURRENT'), 'manifest-pointer')
    fs.writeFileSync(path.join(oldDir, 'pearguard', 'core', 'db', '000023.blob'), 'real-data')

    const r = migrateUserData({ oldDir, newDir, logger: { log() {}, warn() {} } })
    assert.strictEqual(r.migrated, true)
    // CORESTORE removed; siblings intact.
    assert.strictEqual(fs.existsSync(path.join(newDir, 'pearguard', 'core', 'CORESTORE')), false)
    assert.ok(fs.existsSync(path.join(newDir, 'pearguard', 'core', 'db', 'CURRENT')))
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'pearguard', 'core', 'db', '000023.blob'), 'utf8'), 'real-data')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('migrateUserData refuses to clobber a new dir that already has a Hyperbee store', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-migrate-collision-'))
  const oldDir = path.join(root, 'pearguard-windows')
  const newDir = path.join(root, 'pearguard-desktop')
  try {
    fs.mkdirSync(path.join(oldDir, 'pearguard', 'core'), { recursive: true })
    fs.writeFileSync(path.join(oldDir, 'pearguard', 'core', 'data'), 'old')
    // Simulate the kid already running the new build first.
    fs.mkdirSync(path.join(newDir, 'pearguard', 'core'), { recursive: true })
    fs.writeFileSync(path.join(newDir, 'pearguard', 'core', 'data'), 'new')
    const r = migrateUserData({ oldDir, newDir, logger: { log() {}, warn() {} } })
    assert.strictEqual(r.migrated, false)
    assert.strictEqual(r.reason, 'new-dir-already-has-data')
    // Make sure the new store wasn't overwritten.
    assert.strictEqual(fs.readFileSync(path.join(newDir, 'pearguard', 'core', 'data'), 'utf8'), 'new')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// --- Overlay dismiss-shortcut filter -------------------------------------

const { isDismissShortcut, BLOCKED_GLOBAL_SHORTCUTS } = require('../src/main/overlay')

test('isDismissShortcut blocks Alt+F4', () => {
  assert.strictEqual(isDismissShortcut({ alt: true, key: 'F4' }), true)
  assert.strictEqual(isDismissShortcut({ alt: true, key: 'f4' }), true)
})

test('isDismissShortcut blocks reload + close + devtools combos', () => {
  assert.strictEqual(isDismissShortcut({ control: true, key: 'w' }), true)
  assert.strictEqual(isDismissShortcut({ control: true, key: 'r' }), true)
  assert.strictEqual(isDismissShortcut({ control: true, shift: true, key: 'r' }), true)
  assert.strictEqual(isDismissShortcut({ control: true, shift: true, key: 'i' }), true)
  assert.strictEqual(isDismissShortcut({ key: 'F11' }), true)
  assert.strictEqual(isDismissShortcut({ key: 'F12' }), true)
  // macOS Cmd works the same as Ctrl for close-style chords.
  assert.strictEqual(isDismissShortcut({ meta: true, key: 'w' }), true)
})

test('isDismissShortcut does NOT block PIN digits or normal typing', () => {
  for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
    assert.strictEqual(isDismissShortcut({ key: d }), false, 'PIN digit blocked: ' + d)
  }
  assert.strictEqual(isDismissShortcut({ key: 'Backspace' }), false)
  assert.strictEqual(isDismissShortcut({ key: 'Enter' }), false)
  assert.strictEqual(isDismissShortcut({ key: 'Tab' }), false)
  assert.strictEqual(isDismissShortcut({ key: 'ArrowDown' }), false)
  assert.strictEqual(isDismissShortcut({ shift: true, key: 'a' }), false)
})

test('isDismissShortcut handles missing or empty input', () => {
  assert.strictEqual(isDismissShortcut(null), false)
  assert.strictEqual(isDismissShortcut(undefined), false)
  assert.strictEqual(isDismissShortcut({}), false)
  assert.strictEqual(isDismissShortcut({ key: '' }), false)
})

test('BLOCKED_GLOBAL_SHORTCUTS includes Alt+F4 and the major reload/devtools chords', () => {
  // Guard against accidental removal of the most important entry.
  assert.ok(BLOCKED_GLOBAL_SHORTCUTS.includes('Alt+F4'), 'Alt+F4 missing from BLOCKED_GLOBAL_SHORTCUTS')
  assert.ok(BLOCKED_GLOBAL_SHORTCUTS.includes('F11'))
  assert.ok(BLOCKED_GLOBAL_SHORTCUTS.some((s) => /Control\+R|CommandOrControl\+R/.test(s)))
})

// --- GNOME extension watchdog --------------------------------------------

const { GnomeExtensionWatchdog, extractState } = require('../src/main/gnome-extension-watchdog')

test('extractState parses gnome-extensions info output', () => {
  const out = [
    '  Name: PearGuard Focus Reporter',
    '  UUID: pearguard-focus@peerloomllc.com',
    '  Version: 1',
    '  Enabled: Yes',
    '  State: ACTIVE',
  ].join('\n')
  assert.strictEqual(extractState(out), 'ACTIVE')
})

test('extractState returns null when state line absent', () => {
  assert.strictEqual(extractState('something else entirely'), null)
  assert.strictEqual(extractState(''), null)
  assert.strictEqual(extractState(null), null)
})

test('GnomeExtensionWatchdog stays quiet while state is ACTIVE', async () => {
  let tampers = 0
  const watchdog = new GnomeExtensionWatchdog({
    checkIntervalMs: 1_000_000,
    onTamper: () => { tampers++ },
    logger: { log() {}, warn() {} },
    runExtensions: async (args) => {
      if (args[0] === 'info') return { ok: true, stdout: '  State: ACTIVE\n', stderr: '' }
      return { ok: true, stdout: '', stderr: '' }
    },
  })
  await watchdog._check()
  await watchdog._check()
  assert.strictEqual(tampers, 0)
})

test('GnomeExtensionWatchdog fires tamper + re-enables when state is INITIALIZED', async () => {
  const calls = []
  let tamperPayload = null
  const watchdog = new GnomeExtensionWatchdog({
    checkIntervalMs: 1_000_000,
    onTamper: (p) => { tamperPayload = p },
    logger: { log() {}, warn() {} },
    runExtensions: async (args) => {
      calls.push(args.join(' '))
      if (args[0] === 'info') return { ok: true, stdout: '  State: INITIALIZED\n', stderr: '' }
      return { ok: true, stdout: '', stderr: '' }
    },
  })
  await watchdog._check()
  assert.ok(tamperPayload, 'expected tamper payload')
  assert.strictEqual(tamperPayload.reason, 'extension-disabled')
  assert.ok(calls.some((c) => c.startsWith('enable')), 'expected an enable call; got: ' + calls.join(', '))
})

test('GnomeExtensionWatchdog throttles repeated tamper reports', async () => {
  let tampers = 0
  let fakeNow = 0
  const watchdog = new GnomeExtensionWatchdog({
    checkIntervalMs: 1_000_000,
    cooldownMs: 60_000,
    onTamper: () => { tampers++ },
    now: () => fakeNow,
    logger: { log() {}, warn() {} },
    runExtensions: async () => ({ ok: true, stdout: '  State: INITIALIZED\n', stderr: '' }),
  })
  await watchdog._check()
  fakeNow = 30_000
  await watchdog._check()
  fakeNow = 90_000
  await watchdog._check()
  assert.strictEqual(tampers, 2)
})

test('GnomeExtensionWatchdog distinguishes OUT_OF_DATE from disabled', async () => {
  let payload = null
  const watchdog = new GnomeExtensionWatchdog({
    checkIntervalMs: 1_000_000,
    onTamper: (p) => { payload = p },
    logger: { log() {}, warn() {} },
    runExtensions: async (args) => {
      if (args[0] === 'info') return { ok: true, stdout: '  State: OUT_OF_DATE\n', stderr: '' }
      return { ok: true, stdout: '', stderr: '' }
    },
  })
  await watchdog._check()
  assert.ok(payload)
  assert.strictEqual(payload.reason, 'extension-out-of-date')
})

test('GnomeExtensionWatchdog stops when gnome-extensions tool is missing', async () => {
  const watchdog = new GnomeExtensionWatchdog({
    checkIntervalMs: 1_000_000,
    logger: { log() {}, warn() {} },
    runExtensions: async () => ({ ok: false, error: 'spawn ENOENT', code: 'ENOENT', stdout: '', stderr: '' }),
  })
  watchdog.start()
  // start() runs an immediate check; let the microtask drain.
  await new Promise((r) => setImmediate(r))
  assert.strictEqual(watchdog._timer, null, 'timer must be cleared after ENOENT')
})

// --- Linux Wayland foreground adapter ------------------------------------

const wayland = require('../src/enforcement/foreground-wayland')

test('wayland isWaylandSession reads XDG_SESSION_TYPE', () => {
  const savedType = process.env.XDG_SESSION_TYPE
  const savedDisp = process.env.WAYLAND_DISPLAY
  try {
    process.env.XDG_SESSION_TYPE = 'wayland'
    delete process.env.WAYLAND_DISPLAY
    assert.strictEqual(wayland.isWaylandSession(), true)
    process.env.XDG_SESSION_TYPE = 'x11'
    assert.strictEqual(wayland.isWaylandSession(), false)
    // WAYLAND_DISPLAY-only also flips on (SSH containers etc.)
    delete process.env.XDG_SESSION_TYPE
    process.env.WAYLAND_DISPLAY = 'wayland-0'
    assert.strictEqual(wayland.isWaylandSession(), true)
  } finally {
    if (savedType === undefined) delete process.env.XDG_SESSION_TYPE
    else process.env.XDG_SESSION_TYPE = savedType
    if (savedDisp === undefined) delete process.env.WAYLAND_DISPLAY
    else process.env.WAYLAND_DISPLAY = savedDisp
  }
})

test('wayland makeWaylandActiveWin falls back to active-win when extension returns null', async () => {
  // Inject a fake `active-win` to verify the fallback fires when our adapter
  // can't reach the extension (no GNOME session on the test host).
  let fallbackCalled = 0
  const fallback = async () => { fallbackCalled++; return { platform: 'linux', title: 'fallback' } }
  const fn = wayland.makeWaylandActiveWin(fallback)
  const result = await fn()
  // On a test host without our GNOME extension running, gdbus call fails →
  // adapter returns null → fallback is invoked.
  assert.strictEqual(fallbackCalled, 1)
  assert.strictEqual(result && result.title, 'fallback')
})

test('wayland makeWaylandActiveWin returns null when fallback errors', async () => {
  const fallback = async () => { throw new Error('xprop blew up') }
  const fn = wayland.makeWaylandActiveWin(fallback)
  const result = await fn()
  // Adapter must not propagate the error; ForegroundMonitor's catch path
  // already handles "active-win failed" by skipping the tick.
  assert.strictEqual(result, null)
})

// --- Linux icon extractor -------------------------------------------------

const linuxIcon = require('../src/enforcement/icon-extractor-linux')

test('linux resolveIconPath returns null for nonexistent names', async () => {
  if (process.platform !== 'linux') return
  const p = await linuxIcon.resolveIconPath('totally-fake-icon-name-12345', { roots: ['/tmp/pg-icon-nonexistent'] })
  assert.strictEqual(p, null)
})

test('linux resolveIconPath rejects xpm/non-image absolute paths', async () => {
  if (process.platform !== 'linux') return
  const p = await linuxIcon.resolveIconPath('/usr/share/icons/foo.xpm')
  assert.strictEqual(p, null)
})

test('linux resolveIconPath returns SVG path under scalable/apps', async () => {
  if (process.platform !== 'linux') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-icons-svg-'))
  try {
    const dir = path.join(root, 'hicolor', 'scalable', 'apps')
    fs.mkdirSync(dir, { recursive: true })
    const svgPath = path.join(dir, 'svg-only-app.svg')
    fs.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="red"/></svg>')
    const found = await linuxIcon.resolveIconPath('svg-only-app', { roots: [root], themes: ['hicolor'] })
    assert.strictEqual(found, svgPath)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux resolveIconPath prefers PNG over SVG when both exist', async () => {
  if (process.platform !== 'linux') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-icons-mixed-'))
  try {
    const pngDir = path.join(root, 'hicolor', '128x128', 'apps')
    const svgDir = path.join(root, 'hicolor', 'scalable', 'apps')
    fs.mkdirSync(pngDir, { recursive: true })
    fs.mkdirSync(svgDir, { recursive: true })
    fs.writeFileSync(path.join(pngDir, 'mixed.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    fs.writeFileSync(path.join(svgDir, 'mixed.svg'), '<svg/>')
    const found = await linuxIcon.resolveIconPath('mixed', { roots: [root], themes: ['hicolor'] })
    assert.ok(/\.png$/.test(found), 'expected PNG winner, got: ' + found)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux resolveIconPath skips -symbolic icon names', async () => {
  if (process.platform !== 'linux') return
  // Even if a -symbolic PNG exists, we should skip it because symbolic
  // icons render as monochrome line art that looks wrong as a launcher.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-icons-symbolic-'))
  try {
    const dir = path.join(root, 'hicolor', '128x128', 'apps')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'foo-symbolic.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    const found = await linuxIcon.resolveIconPath('foo-symbolic', { roots: [root], themes: ['hicolor'] })
    assert.strictEqual(found, null)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux extractLinuxIcons returns null entries when rsvg-convert is absent and only SVG resolves', async () => {
  // This test ONLY runs when rsvg-convert is NOT installed; with rsvg, the
  // assertion would flip. Skip rather than branch so the suite stays
  // deterministic per host.
  if (process.platform !== 'linux') return
  let rsvgPresent = false
  try { require('fs').accessSync('/usr/bin/rsvg-convert', require('fs').constants.X_OK); rsvgPresent = true } catch (_) {}
  try { require('fs').accessSync('/usr/local/bin/rsvg-convert', require('fs').constants.X_OK); rsvgPresent = true } catch (_) {}
  if (rsvgPresent) return  // separate test below covers the present case
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-icons-svg-none-'))
  try {
    const dir = path.join(root, 'hicolor', 'scalable', 'apps')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'svg-no-rsvg.svg'), '<svg/>')
    const map = await linuxIcon.extractLinuxIcons(['svg-no-rsvg'], { roots: [root], themes: ['hicolor'] })
    assert.strictEqual(map.size, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux resolveIconPath finds PNG in a synthetic hicolor tree', async () => {
  if (process.platform !== 'linux') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-icons-'))
  try {
    const dir = path.join(root, 'hicolor', '128x128', 'apps')
    fs.mkdirSync(dir, { recursive: true })
    const iconPath = path.join(dir, 'myapp.png')
    // Minimal PNG: 8-byte signature only. Enough for our magic-byte check.
    fs.writeFileSync(iconPath, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    const found = await linuxIcon.resolveIconPath('myapp', { roots: [root], themes: ['hicolor'] })
    assert.strictEqual(found, iconPath)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux resolveIconPath prefers 128 over 256 over 48', async () => {
  if (process.platform !== 'linux') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-icons-prio-'))
  try {
    for (const size of [48, 128, 256]) {
      const dir = path.join(root, 'hicolor', `${size}x${size}`, 'apps')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'pri.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    }
    const found = await linuxIcon.resolveIconPath('pri', { roots: [root], themes: ['hicolor'] })
    assert.ok(found.includes('128x128'), 'expected 128x128 winner, got: ' + found)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux resolveIconPath falls back to 256 over 48 when no medium size exists', async () => {
  if (process.platform !== 'linux') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-icons-fb-'))
  try {
    for (const size of [48, 256]) {
      const dir = path.join(root, 'hicolor', `${size}x${size}`, 'apps')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'firefox-shape.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    }
    const found = await linuxIcon.resolveIconPath('firefox-shape', { roots: [root], themes: ['hicolor'] })
    assert.ok(found.includes('256x256'), 'expected 256x256 fallback over 48, got: ' + found)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux extractLinuxIcons returns base64 for valid PNGs and skips misses', async () => {
  if (process.platform !== 'linux') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-icons-batch-'))
  try {
    const dir = path.join(root, 'hicolor', '128x128', 'apps')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'one.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    const map = await linuxIcon.extractLinuxIcons(['one', 'missing'], { roots: [root], themes: ['hicolor'] })
    assert.strictEqual(map.size, 1)
    assert.ok(map.has('one'))
    assert.strictEqual(map.get('missing'), undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux extractLinuxIcons skips files that lack the PNG magic', async () => {
  if (process.platform !== 'linux') return
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-icons-magic-'))
  try {
    const dir = path.join(root, 'hicolor', '128x128', 'apps')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'fake.png'), Buffer.from('GIF89a not a png'))
    const map = await linuxIcon.extractLinuxIcons(['fake'], { roots: [root], themes: ['hicolor'] })
    assert.strictEqual(map.size, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('linux enumerator strips __iconKey from rows whether or not lookup hits', async () => {
  if (process.platform !== 'linux') return
  const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-enum-iconkey-'))
  try {
    fs.writeFileSync(path.join(desktopDir, 'myapp.desktop'), [
      '[Desktop Entry]',
      'Type=Application',
      'Name=MyApp',
      'Exec=myapp',
      'Icon=myapp',
    ].join('\n'))
    const rows = await linuxEnum.enumerateInstalledApps({ dirs: [desktopDir], logger: { log() {} } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].appName, 'MyApp')
    // Internal field must not leak through apps:sync.
    assert.strictEqual(rows[0].__iconKey, undefined)
  } finally {
    fs.rmSync(desktopDir, { recursive: true, force: true })
  }
})

test('linux enumerateInstalledApps dedupes by appName preserving dir precedence', async () => {
  if (process.platform !== 'linux') return
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-enum-a-'))
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-enum-b-'))
  try {
    fs.writeFileSync(path.join(dirA, 'foo.desktop'), [
      '[Desktop Entry]', 'Type=Application', 'Name=Foo', 'Exec=foo-user',
    ].join('\n'))
    fs.writeFileSync(path.join(dirB, 'foo.desktop'), [
      '[Desktop Entry]', 'Type=Application', 'Name=Foo', 'Exec=foo-system',
    ].join('\n'))
    // dirA first means it should win.
    const rows = await linuxEnum.enumerateInstalledApps({ dirs: [dirA, dirB], logger: { log() {} } })
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].exeBasename, 'foo-user')
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  }
})

test('EnforcementController.setPolicyJson re-seeds ExeMap from policy.apps entries', () => {
  const controller = new EnforcementController({
    activeWin: async () => null,
    overridesStore: new OverridesStore({ filePath: null }),
    logger: { log() {}, warn() {} },
  })
  const json = JSON.stringify({
    apps: {
      'steam.app.391540': { status: 'pending', appName: 'UNDERTALE', exeBasename: 'undertale.exe' },
      'win.noexe': { status: 'allowed', appName: 'No Exe Mapping' },
    },
    version: 1,
  })
  controller.setPolicyJson(json)
  assert.strictEqual(
    controller.exeMap.resolve('C:\\Steam\\steamapps\\common\\Undertale\\UNDERTALE.exe'),
    'steam.app.391540',
  )
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

// --- linux enforcement capability -----------------------------------------
const { assessLinuxEnforcement, REASON_UNSUPPORTED, REASON_NOT_LOADED } = require('../src/enforcement/linux-capability')

test('X11 needs no extension - never reports a capability failure', () => {
  const r = assessLinuxEnforcement({ isWayland: false, hasGnome: false, extensionEnabled: false })
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.reason, null)
})

test('non-GNOME Wayland (KDE/sway) is an unsupported compositor', () => {
  const r = assessLinuxEnforcement({ isWayland: true, hasGnome: false })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, REASON_UNSUPPORTED)
  // The child must NOT be told to log out - that can never help on KDE.
  assert.ok(!/log out/i.test(r.childMessage.body), 'must not advise a pointless logout')
})

test('GNOME Wayland with the extension disabled needs a logout', () => {
  const r = assessLinuxEnforcement({ isWayland: true, hasGnome: true, extensionEnabled: false })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, REASON_NOT_LOADED)
  assert.ok(/log out/i.test(r.childMessage.body))
})

test('GNOME Wayland with a live extension is healthy', () => {
  const r = assessLinuxEnforcement({ isWayland: true, hasGnome: true, extensionEnabled: true, dbusLive: true })
  assert.strictEqual(r.ok, true)
})

// THE trap: GNOME unloads extensions on the lock screen, so D-Bus goes silent
// while locked. Treating that as evidence of failure would fire a false "your
// child disabled protection" alert at the parent every time the kid locks their
// screen. Capability must be judged from configuration, not liveness.
test('a LOCKED session must not be mistaken for broken enforcement', () => {
  const r = assessLinuxEnforcement({
    isWayland: true, hasGnome: true, extensionEnabled: true,
    dbusLive: false,      // silent purely because the screen is locked
    sessionLocked: true,
  })
  assert.strictEqual(r.ok, true, 'a locked screen must NOT raise a false alarm')
  assert.strictEqual(r.reason, null)
})

test('but an unlocked session with a dead D-Bus really is broken', () => {
  const r = assessLinuxEnforcement({
    isWayland: true, hasGnome: true, extensionEnabled: true,
    dbusLive: false, sessionLocked: false,
  })
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, REASON_NOT_LOADED)
})
