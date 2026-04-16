#!/usr/bin/env node
// Stand-alone Node smoke test for the Windows enforcement modules. Runs
// without Electron, without active-win, without any P2P backend. Exits 0 on
// pass, 1 on first failure. Run from windows/: `node tests/enforcement.smoke.js`.

const assert = require('assert')
const { evaluate, isSystemExempt } = require('../src/enforcement/block-evaluator')
const { ExeMap } = require('../src/enforcement/exe-map')
const { PolicyCache } = require('../src/enforcement/policy-cache')
const { ForegroundMonitor } = require('../src/enforcement/foreground-monitor')

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
