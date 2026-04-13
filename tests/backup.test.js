// tests/backup.test.js
const {
  buildBackup,
  buildRulesExport,
  parseAndVerify,
  diffPolicies,
  mergeRulesIntoPolicy,
  KIND_BACKUP,
  KIND_RULES,
  BACKUP_VERSION
} = require('../src/backup')
const { generateKeypair } = require('../src/identity')

function hexIdentity () {
  const kp = generateKeypair()
  return { publicKey: kp.publicKey.toString('hex'), secretKey: kp.secretKey.toString('hex') }
}

function samplePolicy (overrides = {}) {
  return {
    childPublicKey: 'aa'.repeat(32),
    version: 3,
    apps: {
      'com.example.a': { status: 'allowed', appName: 'A', addedAt: 1 },
      'com.example.b': { status: 'blocked', appName: 'B', addedAt: 2 }
    },
    schedules: [{ label: 'Bedtime', days: [0, 6], start: '21:00', end: '07:00', exemptApps: [] }],
    pinHash: 'deadbeef',
    pinPlain: '1234',
    locked: false,
    lockMessage: '',
    ...overrides
  }
}

describe('backup / device-backup', () => {
  test('round-trips and verifies', () => {
    const identity = hexIdentity()
    const snapshot = {
      identity,
      profile: { displayName: 'Parent', avatar: null },
      parentSettings: { timeRequestMinutes: [15, 30], warningMinutes: [5] },
      peers: [{ publicKey: 'bb'.repeat(32), displayName: 'Kid', swarmTopic: 'cc'.repeat(32) }],
      policies: { ['bb'.repeat(32)]: samplePolicy() }
    }
    const json = buildBackup(snapshot)
    const { payload } = parseAndVerify(json, KIND_BACKUP)
    expect(payload.kind).toBe(KIND_BACKUP)
    expect(payload.version).toBe(BACKUP_VERSION)
    expect(payload.identity.publicKey).toBe(identity.publicKey)
    expect(payload.peers).toHaveLength(1)
    expect(payload.policies['bb'.repeat(32)].pinPlain).toBeUndefined()
    expect(payload.policies['bb'.repeat(32)].pinHash).toBe('deadbeef')
  })

  test('tampered payload fails verification', () => {
    const identity = hexIdentity()
    const json = buildBackup({ identity, peers: [], policies: {} })
    const env = JSON.parse(json)
    env.payload.exportedAt = 0
    expect(() => parseAndVerify(JSON.stringify(env), KIND_BACKUP))
      .toThrow(/signature/)
  })

  test('swapped signer rejected', () => {
    const identity = hexIdentity()
    const other = hexIdentity()
    const json = buildBackup({ identity, peers: [], policies: {} })
    const env = JSON.parse(json)
    env.signerPublicKey = other.publicKey
    expect(() => parseAndVerify(JSON.stringify(env), KIND_BACKUP)).toThrow()
  })

  test('unsupported version rejected', () => {
    const identity = hexIdentity()
    const json = buildBackup({ identity, peers: [], policies: {} })
    const env = JSON.parse(json)
    env.payload.version = 999
    expect(() => parseAndVerify(JSON.stringify(env), KIND_BACKUP)).toThrow(/version/)
  })

  test('wrong kind rejected when gated', () => {
    const identity = hexIdentity()
    const json = buildRulesExport(samplePolicy(), 'bb'.repeat(32), identity)
    expect(() => parseAndVerify(json, KIND_BACKUP)).toThrow(/expected/)
  })

  test('malformed JSON rejected', () => {
    expect(() => parseAndVerify('not json', KIND_BACKUP)).toThrow(/invalid JSON/)
  })
})

describe('backup / child-rules', () => {
  test('round-trips and strips device fields', () => {
    const identity = hexIdentity()
    const json = buildRulesExport(samplePolicy(), 'bb'.repeat(32), identity)
    const { payload } = parseAndVerify(json, KIND_RULES)
    expect(payload.kind).toBe(KIND_RULES)
    expect(payload.sourceChildPubKey).toBe('bb'.repeat(32))
    expect(payload.policy.pinHash).toBeUndefined()
    expect(payload.policy.pinPlain).toBeUndefined()
    expect(payload.policy.locked).toBeUndefined()
    expect(payload.policy.lockMessage).toBeUndefined()
    expect(payload.policy.childPublicKey).toBeUndefined()
    expect(payload.policy.apps['com.example.a'].status).toBe('allowed')
  })
})

describe('diffPolicies', () => {
  test('detects added / removed / changed apps', () => {
    const current = samplePolicy()
    const incoming = samplePolicy({
      apps: {
        'com.example.a': { status: 'blocked', appName: 'A', addedAt: 1 }, // changed
        'com.example.c': { status: 'allowed', appName: 'C', addedAt: 3 }  // added
      }
    })
    const d = diffPolicies(current, incoming)
    expect(d.appsAdded).toEqual(['com.example.c'])
    expect(d.appsRemoved).toEqual(['com.example.b'])
    expect(d.appsChanged).toEqual(['com.example.a'])
  })

  test('detects schedule changes', () => {
    const current = samplePolicy()
    const incoming = samplePolicy({ schedules: [] })
    expect(diffPolicies(current, incoming).schedulesChanged).toBe(true)
  })

  test('identical policies have no diff', () => {
    const d = diffPolicies(samplePolicy(), samplePolicy())
    expect(d.appsAdded).toEqual([])
    expect(d.appsRemoved).toEqual([])
    expect(d.appsChanged).toEqual([])
    expect(d.schedulesChanged).toBe(false)
  })

  test('handles missing current policy', () => {
    const d = diffPolicies(null, samplePolicy())
    expect(d.appsAdded.sort()).toEqual(['com.example.a', 'com.example.b'])
    expect(d.appsRemoved).toEqual([])
  })

  test('with installedSet, skips uninstalled and never removes', () => {
    const current = samplePolicy() // has com.example.a, com.example.b
    const incoming = samplePolicy({
      apps: {
        'com.example.a': { status: 'blocked', appName: 'A', addedAt: 1 }, // changed
        'com.example.c': { status: 'allowed', appName: 'C', addedAt: 3 }, // not installed
        'com.example.d': { status: 'allowed', appName: 'D', addedAt: 4 }  // installed but new
      }
    })
    const installed = new Set(['com.example.a', 'com.example.b', 'com.example.d'])
    const d = diffPolicies(current, incoming, installed)
    expect(d.appsAdded).toEqual(['com.example.d'])
    expect(d.appsChanged).toEqual(['com.example.a'])
    expect(d.appsSkipped).toEqual(['com.example.c'])
    expect(d.appsRemoved).toEqual([])
  })
})

describe('mergeRulesIntoPolicy', () => {
  test('replaces apps and schedules, preserves device fields', () => {
    const target = samplePolicy({
      childPublicKey: 'cc'.repeat(32),
      pinHash: 'targetpin',
      locked: true,
      lockMessage: 'blocked by dad'
    })
    const imported = {
      apps: { 'com.new.app': { status: 'allowed', appName: 'New', addedAt: 99 } },
      schedules: []
    }
    const merged = mergeRulesIntoPolicy(target, imported, 'cc'.repeat(32))
    expect(merged.childPublicKey).toBe('cc'.repeat(32))
    expect(merged.pinHash).toBe('targetpin')
    expect(merged.locked).toBe(true)
    expect(merged.lockMessage).toBe('blocked by dad')
    expect(merged.apps).toEqual(imported.apps)
    expect(merged.schedules).toEqual([])
    expect(merged.version).toBe(target.version + 1)
  })

  test('intersect mode keeps target apps, drops source apps not installed, filters exemptApps', () => {
    const target = samplePolicy({
      apps: {
        'com.target.keep': { status: 'allowed', appName: 'Keep', addedAt: 1 },
        'com.shared.app':  { status: 'allowed', appName: 'Shared', addedAt: 2 }
      }
    })
    const imported = {
      apps: {
        'com.shared.app':   { status: 'blocked', appName: 'Shared', addedAt: 9 },
        'com.source.only':  { status: 'allowed', appName: 'Source', addedAt: 10 }
      },
      schedules: [{ label: 'Bedtime', days: [0], start: '21:00', end: '07:00', exemptApps: ['com.shared.app', 'com.source.only'] }]
    }
    const installed = new Set(['com.target.keep', 'com.shared.app'])
    const merged = mergeRulesIntoPolicy(target, imported, 'cc'.repeat(32), installed)
    expect(Object.keys(merged.apps).sort()).toEqual(['com.shared.app', 'com.target.keep'])
    expect(merged.apps['com.shared.app'].status).toBe('blocked')
    expect(merged.apps['com.target.keep'].status).toBe('allowed')
    expect(merged.schedules[0].exemptApps).toEqual(['com.shared.app'])
  })

  test('works when target has no prior policy', () => {
    const imported = { apps: {}, schedules: [] }
    const merged = mergeRulesIntoPolicy(null, imported, 'cc'.repeat(32))
    expect(merged.childPublicKey).toBe('cc'.repeat(32))
    expect(merged.version).toBe(1)
  })
})
