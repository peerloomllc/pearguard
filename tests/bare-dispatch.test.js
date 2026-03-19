// tests/bare-dispatch.test.js
//
// Tests the method dispatch table in isolation.
// Does NOT test the full IPC stream (that requires a running Bare worklet — device test).

// Minimal stub for BareKit global (not available in Node/jest)
global.BareKit = { IPC: { write: jest.fn(), on: jest.fn() } }

// We require the dispatch logic indirectly by extracting it.
const { createDispatch, handlePolicyUpdate, handleTimeExtend, appendPinUseLog, getPinUseLog } = require('../src/bare-dispatch')
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

  describe('time:request', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('stores pending request to db with key starting with req:', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('time:request', { packageName: 'com.example.tiktok' })

      expect(result).toHaveProperty('requestId')
      expect(result.requestId).toMatch(/^req:/)
      expect(result).toHaveProperty('status', 'pending')

      // db.put called with a key starting with 'req:'
      const reqPuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('req:'))
      expect(reqPuts).toHaveLength(1)
      const [key, value] = reqPuts[0]
      expect(key).toMatch(/^req:/)
      expect(value).toHaveProperty('status', 'pending')
      expect(value).toHaveProperty('packageName', 'com.example.tiktok')
      expect(value).toHaveProperty('requestedAt')
      expect(value).toHaveProperty('id', key)
    })

    test('emits request:submitted event with request data', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      await dispatch('time:request', { packageName: 'com.example.tiktok' })

      const submittedCalls = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'request:submitted')
      expect(submittedCalls).toHaveLength(1)
      const [msg] = submittedCalls[0]
      expect(msg.data).toHaveProperty('status', 'pending')
      expect(msg.data).toHaveProperty('packageName', 'com.example.tiktok')
    })

    test('emits time:request:sent event', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      await dispatch('time:request', { packageName: 'com.example.tiktok' })

      const sentCalls = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'time:request:sent')
      expect(sentCalls).toHaveLength(1)
      const [msg] = sentCalls[0]
      expect(msg.data).toHaveProperty('packageName', 'com.example.tiktok')
      expect(msg.data).toHaveProperty('requestId')
      expect(msg.data).toHaveProperty('requestedAt')
    })
  })

  describe('handleTimeExtend', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('updates request status to approved and stores expiresAt', async () => {
      const requestId = 'req:1000:com.example.tiktok'
      const pendingRequest = { id: requestId, packageName: 'com.example.tiktok', requestedAt: 1000, status: 'pending' }
      const stored = { [requestId]: pendingRequest }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()

      await handleTimeExtend({ requestId, packageName: 'com.example.tiktok', extraSeconds: 600 }, mockDb, mockSend)

      const reqPuts = mockDb.put.mock.calls.filter(([k]) => k === requestId)
      expect(reqPuts).toHaveLength(1)
      const [, savedReq] = reqPuts[0]
      expect(savedReq.status).toBe('approved')
      expect(savedReq.expiresAt).toBeGreaterThan(Date.now())
    })

    test('sends native:grantOverride', async () => {
      const requestId = 'req:1000:com.example.tiktok'
      const pendingRequest = { id: requestId, packageName: 'com.example.tiktok', requestedAt: 1000, status: 'pending' }
      const stored = { [requestId]: pendingRequest }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()

      await handleTimeExtend({ requestId, packageName: 'com.example.tiktok', extraSeconds: 600 }, mockDb, mockSend)

      const nativeCalls = mockSend.mock.calls.filter(([m]) => m.method === 'native:grantOverride')
      expect(nativeCalls).toHaveLength(1)
      const [msg] = nativeCalls[0]
      expect(msg.args).toHaveProperty('packageName', 'com.example.tiktok')
      expect(msg.args).toHaveProperty('source', 'parent-approved')
    })

    test('emits override:granted event', async () => {
      const requestId = 'req:1000:com.example.tiktok'
      const pendingRequest = { id: requestId, packageName: 'com.example.tiktok', requestedAt: 1000, status: 'pending' }
      const stored = { [requestId]: pendingRequest }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()

      await handleTimeExtend({ requestId, packageName: 'com.example.tiktok', extraSeconds: 600 }, mockDb, mockSend)

      const grantedCalls = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'override:granted')
      expect(grantedCalls).toHaveLength(1)
    })

    test('emits request:updated event with approved status', async () => {
      const requestId = 'req:1000:com.example.tiktok'
      const pendingRequest = { id: requestId, packageName: 'com.example.tiktok', requestedAt: 1000, status: 'pending' }
      const stored = { [requestId]: pendingRequest }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()

      await handleTimeExtend({ requestId, packageName: 'com.example.tiktok', extraSeconds: 600 }, mockDb, mockSend)

      const updatedCalls = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'request:updated')
      expect(updatedCalls).toHaveLength(1)
      const [msg] = updatedCalls[0]
      expect(msg.data).toHaveProperty('requestId', requestId)
      expect(msg.data).toHaveProperty('status', 'approved')
      expect(msg.data).toHaveProperty('expiresAt')
    })

    test('drops malformed payload (missing extraSeconds) — no db writes, no sends', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()

      await handleTimeExtend({ requestId: 'req:1', packageName: 'com.example.app' }, mockDb, mockSend)

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('drops malformed payload (missing requestId) — no db writes, no sends', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()

      await handleTimeExtend({ packageName: 'com.example.app', extraSeconds: 600 }, mockDb, mockSend)

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('skips db.put if requestId not found in db but still sends native and events', async () => {
      const mockDb = makeMockDb({})  // empty db — request not found
      const mockSend = jest.fn()

      await handleTimeExtend({ requestId: 'req:999:com.example.app', packageName: 'com.example.app', extraSeconds: 300 }, mockDb, mockSend)

      // No put since request not found
      expect(mockDb.put).not.toHaveBeenCalled()

      // Native and events still fire
      const nativeCalls = mockSend.mock.calls.filter(([m]) => m.method === 'native:grantOverride')
      expect(nativeCalls).toHaveLength(1)
      const grantedCalls = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'override:granted')
      expect(grantedCalls).toHaveLength(1)
    })
  })

  describe('requests:list', () => {
    function makeAsyncIterable (arr) {
      return {
        [Symbol.asyncIterator] () {
          let i = 0
          return {
            next () {
              if (i < arr.length) return Promise.resolve({ value: arr[i++], done: false })
              return Promise.resolve({ value: undefined, done: true })
            },
          }
        },
      }
    }

    test('returns requests sorted by requestedAt descending', async () => {
      const items = [
        { key: 'req:100:com.a', value: { id: 'req:100:com.a', packageName: 'com.a', requestedAt: 100, status: 'pending' } },
        { key: 'req:300:com.b', value: { id: 'req:300:com.b', packageName: 'com.b', requestedAt: 300, status: 'pending' } },
        { key: 'req:200:com.c', value: { id: 'req:200:com.c', packageName: 'com.c', requestedAt: 200, status: 'approved' } },
      ]
      const mockDb = {
        put: jest.fn(),
        get: jest.fn(),
        createReadStream: jest.fn().mockReturnValue(makeAsyncIterable(items)),
      }
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('requests:list', {})

      expect(result).toHaveProperty('requests')
      expect(result.requests).toHaveLength(3)
      // Sorted descending by requestedAt
      expect(result.requests[0].requestedAt).toBe(300)
      expect(result.requests[1].requestedAt).toBe(200)
      expect(result.requests[2].requestedAt).toBe(100)
    })

    test('calls createReadStream with correct range options', async () => {
      const mockDb = {
        put: jest.fn(),
        get: jest.fn(),
        createReadStream: jest.fn().mockReturnValue(makeAsyncIterable([])),
      }
      const ctx = { db: mockDb, send: jest.fn() }
      const dispatch = createDispatch(ctx)

      await dispatch('requests:list', {})

      expect(mockDb.createReadStream).toHaveBeenCalledWith({ gt: 'req:', lt: 'req:~' })
    })

    test('returns empty requests array when no requests exist', async () => {
      const mockDb = {
        put: jest.fn(),
        get: jest.fn(),
        createReadStream: jest.fn().mockReturnValue(makeAsyncIterable([])),
      }
      const ctx = { db: mockDb, send: jest.fn() }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('requests:list', {})

      expect(result).toEqual({ requests: [] })
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
