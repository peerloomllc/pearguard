#!/usr/bin/env node
// Stand-alone Node smoke test for the Windows enforcement modules. Runs
// without Electron, without active-win, without any P2P backend. Exits 0 on
// pass, 1 on first failure. Run from windows/: `node tests/enforcement.smoke.js`.

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { evaluate, isSystemExempt } = require('../src/enforcement/block-evaluator')
const { ExeMap } = require('../src/enforcement/exe-map')
const { PolicyCache } = require('../src/enforcement/policy-cache')
const { ForegroundMonitor } = require('../src/enforcement/foreground-monitor')
const { OverridesStore } = require('../src/enforcement/overrides-store')
const { EnforcementController } = require('../src/enforcement')
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
