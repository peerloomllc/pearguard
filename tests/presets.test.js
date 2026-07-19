const { PRESETS, PRESET_LIST, composePreset } = require('../src/presets')
const { isAppBlocked } = require('../src/policy')

describe('composePreset', () => {
  test('throws on an unknown preset id', () => {
    expect(() => composePreset('nope', {})).toThrow(/unknown preset/)
  })

  test('age preset sets a daily cap, category limits and a bedtime', () => {
    const p = composePreset('young', { childPublicKey: 'c', apps: {} })
    expect(p.dailyScreenTimeLimitSeconds).toBe(60 * 60)
    expect(p.categories.Games).toEqual({ dailyLimitSeconds: 30 * 60 })
    expect(p.categories.Social).toEqual({ dailyLimitSeconds: 15 * 60 })
    expect(p.schedules).toHaveLength(1)
    expect(p.schedules[0]).toMatchObject({ label: 'Bedtime', start: '19:30', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] })
  })

  test('age preset preserves existing fields and per-app status', () => {
    const base = {
      childPublicKey: 'c',
      pinHash: 'secret',
      screenTimeExemptApps: ['com.phone'],
      apps: { 'com.game': { status: 'blocked', category: 'Games', appName: 'Game' } },
      version: 7,
    }
    const p = composePreset('teen', base)
    expect(p.childPublicKey).toBe('c')
    expect(p.pinHash).toBe('secret')
    expect(p.screenTimeExemptApps).toEqual(['com.phone'])
    // Age presets never touch app allow/block decisions.
    expect(p.apps['com.game'].status).toBe('blocked')
  })

  test('allowlist preset blocks every app and clears limits/schedules', () => {
    const base = {
      childPublicKey: 'c',
      apps: {
        'com.a': { status: 'allowed', appName: 'A' },
        'com.b': { status: 'pending', appName: 'B' },
      },
      categories: { Games: { dailyLimitSeconds: 3600 } },
      dailyScreenTimeLimitSeconds: 7200,
      schedules: [{ label: 'x', days: [1], start: '20:00', end: '07:00' }],
    }
    const p = composePreset('allowlist', base)
    expect(p.apps['com.a'].status).toBe('blocked')
    expect(p.apps['com.b'].status).toBe('blocked')
    expect(p.categories).toEqual({})
    expect(p.schedules).toEqual([])
    expect(p).not.toHaveProperty('dailyScreenTimeLimitSeconds')
    // App metadata (name) is preserved, only status changes.
    expect(p.apps['com.a'].appName).toBe('A')
  })

  test('does not mutate the input policy', () => {
    const base = { apps: { 'com.a': { status: 'allowed' } }, categories: { Games: { dailyLimitSeconds: 60 } } }
    const snapshot = JSON.parse(JSON.stringify(base))
    composePreset('allowlist', base)
    composePreset('young', base)
    expect(base).toEqual(snapshot)
  })

  test('tolerates a null/empty base policy', () => {
    const p = composePreset('preteen', null)
    expect(p.dailyScreenTimeLimitSeconds).toBe(2 * 60 * 60)
    expect(p.schedules[0].start).toBe('20:30')
  })

  test('PRESET_LIST is ordered and complete', () => {
    expect(PRESET_LIST.map((p) => p.id)).toEqual(['young', 'preteen', 'teen', 'allowlist'])
    for (const p of PRESET_LIST) {
      expect(typeof p.label).toBe('string')
      expect(typeof p.description).toBe('string')
    }
  })
})

describe('composePreset integrates with isAppBlocked', () => {
  test('allowlist blocks a formerly-allowed app', () => {
    const base = { apps: { 'com.game': { status: 'allowed', category: 'Games' } } }
    const p = composePreset('allowlist', base)
    expect(isAppBlocked('com.game', p, {}, Date.now())) .toBe(true)
  })

  test('young preset blocks an over-limit game via the category cap', () => {
    const base = { apps: { 'com.game': { status: 'allowed', category: 'Games' }, 'com.game2': { status: 'allowed', category: 'Games' } } }
    const p = composePreset('young', base)
    // Two games summing past the 30m Games category limit → blocked.
    const usage = { 'com.game': { dailySeconds: 20 * 60 }, 'com.game2': { dailySeconds: 20 * 60 } }
    // Use midday (a Date, as isScheduleActive expects) so the bedtime window
    // isn't the thing blocking it — the category cap is.
    const midday = new Date(); midday.setHours(12, 0, 0, 0)
    expect(isAppBlocked('com.game', p, usage, midday)).toBe(true)
  })
})
