// tests/bare-dispatch.test.js
//
// Tests the method dispatch table in isolation.
// Does NOT test the full IPC stream (that requires a running Bare worklet — device test).

// Minimal stub for BareKit global (not available in Node/jest)
global.BareKit = { IPC: { write: jest.fn(), on: jest.fn() } }

// We require the dispatch logic indirectly by extracting it.
const { createDispatch, handlePolicyUpdate, appendPinUseLog, getPinUseLog } = require('../src/bare-dispatch')
const sodium = require('sodium-native')

describe('bare dispatch', () => {
  test('ping returns pong', async () => {
    const dispatch = createDispatch({})
    const result = await dispatch('ping', [])
    expect(result).toBe('pong')
  })

  test('unknown method throws', async () => {
    const dispatch = createDispatch({})
    await expect(dispatch('unknownMethod', [])).rejects.toThrow('unknown method')
  })

  test('setMode stores mode and getMode returns it', async () => {
    const stored = {}
    const mockDb = {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] ? { value: stored[k] } : null),
    }
    const ctx = { db: mockDb, mode: null }
    const dispatch = createDispatch(ctx)

    await dispatch('setMode', ['parent'])
    expect(mockDb.put).toHaveBeenCalledWith('mode', 'parent')

    const result = await dispatch('getMode', [])
    expect(result).toBe('parent')
  })

  test('setMode rejects invalid mode', async () => {
    const ctx = { db: { put: jest.fn(), get: jest.fn() }, mode: null }
    const dispatch = createDispatch(ctx)
    await expect(dispatch('setMode', ['admin'])).rejects.toThrow()
  })

  describe('policy:getCurrent', () => {
    test('returns parsed policy when policy exists in db', async () => {
      const storedPolicy = { version: 1, childPublicKey: 'abc123', rules: [] }
      const stored = { policy: storedPolicy }
      const mockDb = {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] ? { value: stored[k] } : null),
      }
      const ctx = { db: mockDb, mode: 'child' }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('policy:getCurrent', {})
      expect(result).toEqual({ policy: storedPolicy })
    })

    test('returns { policy: null } when no policy stored', async () => {
      const mockDb = {
        put: jest.fn(),
        get: jest.fn(async () => null),
      }
      const ctx = { db: mockDb, mode: 'child' }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('policy:getCurrent', {})
      expect(result).toEqual({ policy: null })
    })
  })

  describe('handlePolicyUpdate', () => {
    // NOTE: Signature verification for policy:update P2P messages is handled upstream
    // in bare.js handlePeerMessage (using sodium-native verify) before handlePolicyUpdate
    // is ever called. There is therefore no "bad signature" test in this file — that
    // path is covered by integration testing on a physical device.

    function makeMockDb () {
      const stored = {}
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('stores valid policy to db and emits events', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()
      const payload = { version: 1, childPublicKey: 'deadbeef', rules: [] }

      await handlePolicyUpdate(payload, mockDb, mockSend)

      expect(mockDb.put).toHaveBeenCalledWith('policy', payload)

      // native:setPolicy must come first so the native module receives the policy
      // before the WebView reacts to policy:updated.
      expect(mockSend.mock.calls[0]).toEqual([{
        method: 'native:setPolicy',
        args: { json: JSON.stringify(payload) },
      }])
      expect(mockSend.mock.calls[1]).toEqual([{
        type: 'event',
        event: 'policy:updated',
        data: payload,
      }])
    })

    test('does NOT call db.put when payload is missing version', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()
      const payload = { childPublicKey: 'deadbeef', rules: [] }  // no version

      await handlePolicyUpdate(payload, mockDb, mockSend)

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('does NOT call db.put when payload is missing childPublicKey', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()
      const payload = { version: 1, rules: [] }  // no childPublicKey

      await handlePolicyUpdate(payload, mockDb, mockSend)

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('does NOT call db.put when version is not a number', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()
      const payload = { version: '1', childPublicKey: 'deadbeef', rules: [] }  // string version

      await handlePolicyUpdate(payload, mockDb, mockSend)

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe('pin:verify', () => {
    // pwhash is intentionally slow (~300ms) — generate once and reuse across all test cases
    let pinHash

    beforeAll(() => {
      pinHash = Buffer.alloc(sodium.crypto_pwhash_STRBYTES)
      sodium.crypto_pwhash_str(
        pinHash,
        Buffer.from('1234'),
        sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
        sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
      )
    })

    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('correct PIN grants override, stores to db, calls appendPinUseLog', async () => {
      const policyObj = {
        version: 1,
        childPublicKey: 'abc',
        pinHash: pinHash.toString(),
        overrideDurationSeconds: 600,
      }
      const stored = { policy: policyObj }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend, sodium }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('pin:verify', { pin: '1234', packageName: 'com.example.app' })

      expect(result.granted).toBe(true)
      const expectedExpiry = Date.now() + 600 * 1000
      expect(result.expiresAt).toBeGreaterThanOrEqual(expectedExpiry - 200)
      expect(result.expiresAt).toBeLessThanOrEqual(expectedExpiry + 200)

      // Override grant stored to db
      const overridePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('override:com.example.app:'))
      expect(overridePuts).toHaveLength(1)

      // pinLog appended (appendPinUseLog calls db.put('pinLog', ...))
      const logPuts = mockDb.put.mock.calls.filter(([k]) => k === 'pinLog')
      expect(logPuts).toHaveLength(1)
      expect(logPuts[0][1]).toHaveLength(1)
      expect(logPuts[0][1][0].packageName).toBe('com.example.app')

      // native:grantOverride sent
      const nativeCalls = mockSend.mock.calls.filter(([m]) => m.method === 'native:grantOverride')
      expect(nativeCalls).toHaveLength(1)

      // override:granted event emitted
      const eventCalls = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'override:granted')
      expect(eventCalls).toHaveLength(1)
    })

    test('wrong PIN returns { granted: false, reason: "wrong-pin" }, no override in db', async () => {
      const policyObj = {
        version: 1,
        childPublicKey: 'abc',
        pinHash: pinHash.toString(),
      }
      const stored = { policy: policyObj }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend, sodium }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('pin:verify', { pin: '9999', packageName: 'com.example.app' })

      expect(result).toEqual({ granted: false, reason: 'wrong-pin' })

      // No override stored
      const overridePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('override:'))
      expect(overridePuts).toHaveLength(0)

      // override:denied event emitted
      const deniedCalls = mockSend.mock.calls.filter(([m]) => m.event === 'override:denied')
      expect(deniedCalls).toHaveLength(1)
    })

    test('no policy stored returns { granted: false, reason: "no-policy" }', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend, sodium }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('pin:verify', { pin: '1234', packageName: 'com.example.app' })

      expect(result).toEqual({ granted: false, reason: 'no-policy' })
      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('policy with no pinHash returns { granted: false, reason: "no-pin" }', async () => {
      const policyObj = { version: 1, childPublicKey: 'abc', rules: [] }  // no pinHash
      const stored = { policy: policyObj }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend, sodium }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('pin:verify', { pin: '1234', packageName: 'com.example.app' })

      expect(result).toEqual({ granted: false, reason: 'no-pin' })
      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe('pin:set', () => {
    // pwhash is intentionally slow (~300ms) — generate once and reuse across all test cases
    let pinHash

    beforeAll(() => {
      pinHash = Buffer.alloc(sodium.crypto_pwhash_STRBYTES)
      sodium.crypto_pwhash_str(
        pinHash,
        Buffer.from('5678'),
        sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
        sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
      )
    })

    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('setting a PIN stores a non-empty pinHash in the policy', async () => {
      const stored = {}
      const mockDb = makeMockDb(stored)
      const ctx = { db: mockDb, sodium }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('pin:set', { pin: '5678' })

      expect(result).toEqual({ ok: true })

      // db.put should have been called with 'policy'
      expect(mockDb.put).toHaveBeenCalledWith('policy', expect.objectContaining({
        pinHash: expect.any(String),
      }))

      // The stored pinHash should be non-empty
      const savedPolicy = mockDb.put.mock.calls.find(([k]) => k === 'policy')[1]
      expect(savedPolicy.pinHash.length).toBeGreaterThan(0)

      // The stored hash should verify correctly against the original PIN
      const verifyResult = sodium.crypto_pwhash_str_verify(
        Buffer.from(savedPolicy.pinHash),
        Buffer.from('5678')
      )
      expect(verifyResult).toBe(true)
    })

    test('pin:set merges pinHash into existing policy without overwriting other fields', async () => {
      const existingPolicy = { version: 1, childPublicKey: 'abc', overrideDurationSeconds: 300 }
      const stored = { policy: existingPolicy }
      const mockDb = makeMockDb(stored)
      const ctx = { db: mockDb, sodium }
      const dispatch = createDispatch(ctx)

      await dispatch('pin:set', { pin: '5678' })

      const savedPolicy = mockDb.put.mock.calls.find(([k]) => k === 'policy')[1]
      expect(savedPolicy.version).toBe(1)
      expect(savedPolicy.childPublicKey).toBe('abc')
      expect(savedPolicy.overrideDurationSeconds).toBe(300)
      expect(savedPolicy.pinHash).toBeTruthy()
    })

    test('missing pin throws', async () => {
      const mockDb = makeMockDb()
      const ctx = { db: mockDb, sodium }
      const dispatch = createDispatch(ctx)

      await expect(dispatch('pin:set', {})).rejects.toThrow('invalid pin')
    })

    test('non-string pin throws', async () => {
      const mockDb = makeMockDb()
      const ctx = { db: mockDb, sodium }
      const dispatch = createDispatch(ctx)

      await expect(dispatch('pin:set', { pin: 1234 })).rejects.toThrow('invalid pin')
    })
  })

  describe('usage:flush', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('builds report with pinLog, identity, and timestamp', async () => {
      const pinLogEntry = { packageName: 'com.example.app', grantedAt: 1000, expiresAt: 2000 }
      const identity = { publicKey: 'abc123def456', secretKey: 'secret' }
      const stored = {
        pinLog: [pinLogEntry],
        identity: identity,
      }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:flush', [])

      expect(result).toHaveProperty('flushed', true)
      expect(result).toHaveProperty('timestamp')
      expect(typeof result.timestamp).toBe('number')
    })

    test('persists report to db with key usage:{timestamp}', async () => {
      const pinLogEntry = { packageName: 'com.example.app', grantedAt: 1000, expiresAt: 2000 }
      const identity = { publicKey: 'abc123def456', secretKey: 'secret' }
      const stored = {
        pinLog: [pinLogEntry],
        identity: identity,
      }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:flush', [])

      // Find the db.put call with the usage: key
      const usagePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('usage:'))
      expect(usagePuts).toHaveLength(1)

      const [key, value] = usagePuts[0]
      expect(key).toBe('usage:' + result.timestamp)
      expect(value).toHaveProperty('type', 'usage:report')
      expect(value).toHaveProperty('timestamp', result.timestamp)
      expect(value).toHaveProperty('pinOverrides')
      expect(value).toHaveProperty('childPublicKey')
      expect(value).toHaveProperty('usageStats')
    })

    test('includes pinLog entries in pinOverrides', async () => {
      const pinLogEntry = { packageName: 'com.example.app', grantedAt: 1000, expiresAt: 2000 }
      const identity = { publicKey: 'abc123def456', secretKey: 'secret' }
      const stored = {
        pinLog: [pinLogEntry],
        identity: identity,
      }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      await dispatch('usage:flush', [])

      const usagePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('usage:'))
      const [, report] = usagePuts[0]
      expect(report.pinOverrides).toEqual([pinLogEntry])
    })

    test('emits usage:report event with report data', async () => {
      const pinLogEntry = { packageName: 'com.example.app', grantedAt: 1000, expiresAt: 2000 }
      const identity = { publicKey: 'abc123def456', secretKey: 'secret' }
      const stored = {
        pinLog: [pinLogEntry],
        identity: identity,
      }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:flush', [])

      // Find the event:usage:report call
      const eventCalls = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'usage:report')
      expect(eventCalls).toHaveLength(1)

      const [eventMsg] = eventCalls[0]
      expect(eventMsg.data).toHaveProperty('type', 'usage:report')
      expect(eventMsg.data).toHaveProperty('timestamp', result.timestamp)
      expect(eventMsg.data).toHaveProperty('pinOverrides')
      expect(eventMsg.data).toHaveProperty('childPublicKey')
    })

    test('clears pinLog to empty array', async () => {
      const pinLogEntry = { packageName: 'com.example.app', grantedAt: 1000, expiresAt: 2000 }
      const identity = { publicKey: 'abc123def456', secretKey: 'secret' }
      const stored = {
        pinLog: [pinLogEntry],
        identity: identity,
      }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      await dispatch('usage:flush', [])

      // Find the db.put call that clears pinLog
      const logPuts = mockDb.put.mock.calls.filter(([k]) => k === 'pinLog')
      expect(logPuts).toHaveLength(1)
      expect(logPuts[0][1]).toEqual([])
    })

    test('handles missing identity gracefully', async () => {
      const pinLogEntry = { packageName: 'com.example.app', grantedAt: 1000, expiresAt: 2000 }
      const stored = {
        pinLog: [pinLogEntry],
        // no identity
      }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:flush', [])

      expect(result).toHaveProperty('flushed', true)

      const usagePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('usage:'))
      const [, report] = usagePuts[0]
      expect(report.childPublicKey).toBeNull()
    })

    test('handles empty pinLog', async () => {
      const identity = { publicKey: 'abc123def456', secretKey: 'secret' }
      const stored = {
        identity: identity,
        // no pinLog
      }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:flush', [])

      expect(result).toHaveProperty('flushed', true)

      const usagePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('usage:'))
      const [, report] = usagePuts[0]
      expect(report.pinOverrides).toEqual([])
    })
  })

  describe('getPinUseLog', () => {
    test('returns existing pinLog array', async () => {
      const pinLogEntry = { packageName: 'com.example.app', grantedAt: 1000, expiresAt: 2000 }
      const mockDb = {
        get: jest.fn(async () => ({ value: [pinLogEntry] })),
      }

      const result = await getPinUseLog(mockDb)

      expect(result).toEqual([pinLogEntry])
    })

    test('returns empty array when pinLog does not exist', async () => {
      const mockDb = {
        get: jest.fn(async () => null),
      }

      const result = await getPinUseLog(mockDb)

      expect(result).toEqual([])
    })
  })
})
