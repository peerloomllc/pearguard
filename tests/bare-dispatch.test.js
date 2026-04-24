// tests/bare-dispatch.test.js
//
// Tests the method dispatch table in isolation.
// Does NOT test the full IPC stream (that requires a running Bare worklet — device test).

// Minimal stub for BareKit global (not available in Node/jest)
global.BareKit = { IPC: { write: jest.fn(), on: jest.fn() } }

// We require the dispatch logic indirectly by extracting it.
const { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingAppsSync, handleIncomingTimeRequest, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue } = require('../src/bare-dispatch')
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
    expect(result).toEqual({ mode: 'parent' })
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

    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] ? { value: stored[k] } : null),
        createReadStream: jest.fn(async function * () {}),
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

    test('syncs pending req:* entries when policy marks app as allowed', async () => {
      const pendingReq = {
        id: 'req:1000:com.example.app',
        packageName: 'com.example.app',
        appName: 'Example App',
        status: 'pending',
        requestedAt: 1000,
      }
      const stored = { 'req:1000:com.example.app': pendingReq }
      const mockDb = makeMockDb(stored)
      mockDb.createReadStream = jest.fn(async function * () {
        yield { key: 'req:1000:com.example.app', value: pendingReq }
      })
      const mockSend = jest.fn()
      const payload = {
        version: 2,
        childPublicKey: 'deadbeef',
        apps: { 'com.example.app': { status: 'allowed', appName: 'Example App' } },
      }

      await handlePolicyUpdate(payload, mockDb, mockSend)

      // req:* should be updated to approved
      const reqPuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('req:'))
      expect(reqPuts).toHaveLength(1)
      expect(reqPuts[0][1].status).toBe('approved')

      // request:updated event should fire
      const updatedEvents = mockSend.mock.calls.filter(
        ([m]) => m.type === 'event' && m.event === 'request:updated'
      )
      expect(updatedEvents).toHaveLength(1)
      expect(updatedEvents[0][0].data.status).toBe('approved')
    })

    test('syncs pending req:* entries when policy marks app as blocked', async () => {
      const pendingReq = {
        id: 'req:2000:com.blocked.app',
        packageName: 'com.blocked.app',
        appName: 'Blocked App',
        status: 'pending',
        requestedAt: 2000,
      }
      const stored = { 'req:2000:com.blocked.app': pendingReq }
      const mockDb = makeMockDb(stored)
      mockDb.createReadStream = jest.fn(async function * () {
        yield { key: 'req:2000:com.blocked.app', value: pendingReq }
      })
      const mockSend = jest.fn()
      const payload = {
        version: 2,
        childPublicKey: 'deadbeef',
        apps: { 'com.blocked.app': { status: 'blocked', appName: 'Blocked App' } },
      }

      await handlePolicyUpdate(payload, mockDb, mockSend)

      const reqPuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('req:'))
      expect(reqPuts).toHaveLength(1)
      expect(reqPuts[0][1].status).toBe('denied')
    })

    test('does not update req:* entries that are already resolved', async () => {
      const resolvedReq = {
        id: 'req:3000:com.example.app',
        packageName: 'com.example.app',
        status: 'approved',
        requestedAt: 3000,
      }
      const stored = { 'req:3000:com.example.app': resolvedReq }
      const mockDb = makeMockDb(stored)
      mockDb.createReadStream = jest.fn(async function * () {
        yield { key: 'req:3000:com.example.app', value: resolvedReq }
      })
      const mockSend = jest.fn()
      const payload = {
        version: 2,
        childPublicKey: 'deadbeef',
        apps: { 'com.example.app': { status: 'allowed', appName: 'Example App' } },
      }

      await handlePolicyUpdate(payload, mockDb, mockSend)

      // No req:* puts — already resolved
      const reqPuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('req:'))
      expect(reqPuts).toHaveLength(0)
    })
  })

  describe('pin:verify', () => {
    // Generate the BLAKE2b hash used by pin:set/pin:verify
    let pinHash

    beforeAll(() => {
      pinHash = Buffer.alloc(sodium.crypto_generichash_BYTES)
      sodium.crypto_generichash(pinHash, Buffer.from('1234'))
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
        pinHash: pinHash.toString('hex'),
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
        pinHash: pinHash.toString('hex'),
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
    // Pre-compute expected BLAKE2b hash for PIN '5678'
    let pinHash

    beforeAll(() => {
      pinHash = Buffer.alloc(sodium.crypto_generichash_BYTES)
      sodium.crypto_generichash(pinHash, Buffer.from('5678'))
    })

    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        // pin:set iterates peers to propagate pinHash to child policies
        createReadStream: jest.fn(({ gt, lt } = {}) => {
          const entries = Object.entries(stored)
            .filter(([k]) => (!gt || k > gt) && (!lt || k < lt))
            .map(([k, v]) => ({ key: k, value: v }))
          return entries[Symbol.iterator] ? (async function* () { for (const e of entries) yield e })() : []
        }),
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

      // The stored pinHash should be the expected BLAKE2b hex string
      const savedPolicy = mockDb.put.mock.calls.find(([k]) => k === 'policy')[1]
      expect(savedPolicy.pinHash.length).toBeGreaterThan(0)
      expect(savedPolicy.pinHash).toBe(pinHash.toString('hex'))
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

      const result = await dispatch('usage:flush', { usage: [{ packageName: 'com.example.app', appName: 'Example', secondsToday: 60 }] })

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

      const result = await dispatch('usage:flush', { usage: [{ packageName: 'com.example.app', appName: 'Example', secondsToday: 60 }] })

      // Find the db.put call with the usage: key
      const usagePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('usage:'))
      expect(usagePuts).toHaveLength(1)

      const [key, value] = usagePuts[0]
      expect(key).toBe('usage:' + result.timestamp)
      expect(value).toHaveProperty('type', 'usage:report')
      expect(value).toHaveProperty('timestamp', result.timestamp)
      expect(value).toHaveProperty('pinOverrides')
      expect(value).toHaveProperty('childPublicKey')
      expect(value).toHaveProperty('apps')
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

      await dispatch('usage:flush', { usage: [{ packageName: 'com.example.app', appName: 'Example', secondsToday: 60 }] })

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

      const result = await dispatch('usage:flush', { usage: [{ packageName: 'com.example.app', appName: 'Example', secondsToday: 60 }] })

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

      await dispatch('usage:flush', { usage: [{ packageName: 'com.example.app', appName: 'Example', secondsToday: 60 }] })

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

      const result = await dispatch('usage:flush', { usage: [{ packageName: 'com.example.app', appName: 'Example', secondsToday: 60 }] })

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

      const result = await dispatch('usage:flush', { usage: [{ packageName: 'com.example.app', appName: 'Example', secondsToday: 60 }] })

      expect(result).toHaveProperty('flushed', true)

      const usagePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('usage:'))
      const [, report] = usagePuts[0]
      expect(report.pinOverrides).toEqual([])
    })

    test('calls ctx.sendToParent with usage:report payload when sendToParent is provided', async () => {
      const identity = { publicKey: 'abc123def456', secretKey: 'secret' }
      const stored = { pinLog: [], identity }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const mockSendToParent = jest.fn().mockResolvedValue(undefined)
      const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
      const dispatch = createDispatch(ctx)

      await dispatch('usage:flush', { usage: [{ packageName: 'com.example.app', appName: 'Example', secondsToday: 60 }] })

      expect(mockSendToParent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'usage:report',
        payload: expect.objectContaining({ type: 'usage:report' }),
      }))
    })

    test('populates apps from args.usage native data', async () => {
      const identity = { publicKey: 'abc123', secretKey: 'secret' }
      const stored = { identity }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const nativeUsage = [
        { packageName: 'com.example.chrome', appName: 'Chrome', secondsToday: 3600 },
        { packageName: 'com.example.maps', appName: 'Maps', secondsToday: 120 },
      ]

      await dispatch('usage:flush', { usage: nativeUsage })

      const usagePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('usage:'))
      const [, report] = usagePuts[0]
      expect(report.apps).toHaveLength(2)
      expect(report.apps[0]).toEqual({ packageName: 'com.example.chrome', displayName: 'Chrome', todaySeconds: 3600, weekSeconds: 0 })
    })

    test('returns flushed:false without storing when apps is empty', async () => {
      const stored = { identity: { publicKey: 'abc123', secretKey: 'secret' } }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:flush', { usage: [] })

      expect(result).toEqual({ flushed: false, reason: 'no data' })
      const usagePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('usage:'))
      expect(usagePuts).toHaveLength(0)
      const eventCalls = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'usage:report')
      expect(eventCalls).toHaveLength(0)
    })

    test('report includes lastSynced timestamp', async () => {
      const identity = { publicKey: 'abc123', secretKey: 'secret' }
      const stored = { identity }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:flush', { usage: [{ packageName: 'com.example.app', appName: 'Example', secondsToday: 60 }] })

      const usagePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('usage:'))
      const [, report] = usagePuts[0]
      expect(report).toHaveProperty('lastSynced')
      expect(typeof report.lastSynced).toBe('number')
      expect(report.lastSynced).toBe(result.timestamp)
    })
  })

  describe('usage:getLatest', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('returns the latest usageReport for childPublicKey', async () => {
      const report = { type: 'usage:report', timestamp: Date.now(), apps: [], childPublicKey: 'pk-child' }
      const mockDb = makeMockDb()
      mockDb.createReadStream = jest.fn(async function * () {
        yield { value: report }
      })
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:getLatest', { childPublicKey: 'pk-child' })
      expect(result).toEqual(report)
    })

    test('zeros out today-scoped fields when stored report is from a previous local day', async () => {
      const yesterday = Date.now() - 36 * 60 * 60 * 1000
      const stored = {
        type: 'usage:report',
        timestamp: yesterday,
        todayScreenTimeSeconds: 3600,
        apps: [{ packageName: 'com.example.chrome', displayName: 'Chrome', todaySeconds: 3600, weekSeconds: 7200 }],
        sessions: [{ packageName: 'com.example.chrome', startedAt: yesterday, durationSeconds: 3600 }],
        childPublicKey: 'pk-child',
      }
      const mockDb = makeMockDb({ ['usageReport:pk-child:latest']: stored })
      mockDb.createReadStream = jest.fn(async function * () {})
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:getLatest', { childPublicKey: 'pk-child' })
      expect(result.todayScreenTimeSeconds).toBe(0)
      expect(result.apps[0].todaySeconds).toBe(0)
      expect(result.apps[0].weekSeconds).toBe(7200)
      expect(result.sessions).toEqual([])
      expect(result.stale).toBe(true)
      expect(result.timestamp).toBe(yesterday)
    })

    test('returns null when no report exists', async () => {
      const mockDb = makeMockDb()
      mockDb.createReadStream = jest.fn(async function * () {})
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('usage:getLatest', { childPublicKey: 'pk-child' })
      expect(result).toBeNull()
    })

    test('throws when childPublicKey is missing', async () => {
      const mockDb = makeMockDb()
      mockDb.createReadStream = jest.fn(async function * () {})
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      await expect(dispatch('usage:getLatest', {})).rejects.toThrow('invalid usage:getLatest args')
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

    test('calls ctx.sendToParent with time:request payload when sendToParent is provided', async () => {
      const mockDb = makeMockDb()
      const mockSend = jest.fn()
      const mockSendToParent = jest.fn().mockResolvedValue(undefined)
      const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
      const dispatch = createDispatch(ctx)

      await dispatch('time:request', { packageName: 'com.example.tiktok' })

      expect(mockSendToParent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'time:request',
        payload: expect.objectContaining({ packageName: 'com.example.tiktok' }),
      }))
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
      const now = Date.now()
      const items = [
        { key: 'req:1:com.a', value: { id: 'req:1:com.a', packageName: 'com.a', requestedAt: now - 100, status: 'pending' } },
        { key: 'req:3:com.b', value: { id: 'req:3:com.b', packageName: 'com.b', requestedAt: now - 300, status: 'pending' } },
        { key: 'req:2:com.c', value: { id: 'req:2:com.c', packageName: 'com.c', requestedAt: now - 200, status: 'approved' } },
      ]
      const mockDb = {
        put: jest.fn(),
        get: jest.fn(),
        del: jest.fn(),
        createReadStream: jest.fn().mockReturnValue(makeAsyncIterable(items)),
      }
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('requests:list', {})

      expect(result).toHaveProperty('requests')
      expect(result.requests).toHaveLength(3)
      // Sorted descending by requestedAt (now-100 is most recent)
      expect(result.requests[0].packageName).toBe('com.a')
      expect(result.requests[1].packageName).toBe('com.c')
      expect(result.requests[2].packageName).toBe('com.b')
    })

    test('calls createReadStream with correct range options', async () => {
      const mockDb = {
        put: jest.fn(),
        get: jest.fn(),
        del: jest.fn(),
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
        del: jest.fn(),
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

  // ── Task 6: app:installed ──────────────────────────────────────────────────

  describe('app:installed', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('new package: sets status to pending, calls db.put, sends native:setPolicy and policy:updated', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('app:installed', { packageName: 'com.example.newapp' })

      expect(result).toEqual({ status: 'pending' })

      // db.put called with policy containing the new app
      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy')
      expect(policyPuts).toHaveLength(1)
      const [, savedPolicy] = policyPuts[0]
      expect(savedPolicy.apps['com.example.newapp']).toMatchObject({ status: 'pending' })

      // native:setPolicy sent
      const nativeCalls = mockSend.mock.calls.filter(([m]) => m.method === 'native:setPolicy')
      expect(nativeCalls).toHaveLength(1)

      // app:installed event emitted
      const installedEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')
      expect(installedEvents).toHaveLength(1)
      expect(installedEvents[0][0].data.packageName).toBe('com.example.newapp')

      // policy:updated event emitted
      const updatedEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'policy:updated')
      expect(updatedEvents).toHaveLength(1)
    })

    test('already-known package: existing status NOT overwritten, no db.put, no sends', async () => {
      const existingPolicy = { apps: { 'com.example.known': { status: 'allowed' } } }
      const mockDb = makeMockDb({ policy: existingPolicy })
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('app:installed', { packageName: 'com.example.known' })

      expect(result).toEqual({ status: 'allowed' })
      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('new package: calls ctx.sendToParent with app:installed payload when sendToParent is provided', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()
      const mockSendToParent = jest.fn().mockResolvedValue(undefined)
      const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
      const dispatch = createDispatch(ctx)

      await dispatch('app:installed', { packageName: 'com.example.newapp', appName: 'New App' })

      expect(mockSendToParent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'app:installed',
        payload: expect.objectContaining({ packageName: 'com.example.newapp', appName: 'New App' }),
      }))
    })

    test('already-known package: does NOT call sendToParent', async () => {
      const existingPolicy = { apps: { 'com.example.known': { status: 'allowed' } } }
      const mockDb = makeMockDb({ policy: existingPolicy })
      const mockSend = jest.fn()
      const mockSendToParent = jest.fn()
      const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
      const dispatch = createDispatch(ctx)

      await dispatch('app:installed', { packageName: 'com.example.known' })

      expect(mockSendToParent).not.toHaveBeenCalled()
    })
  })

  // ── Task 6: handleAppDecision ──────────────────────────────────────────────

  describe('handleAppDecision', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        createReadStream: jest.fn(({ gt, lt } = {}) => {
          const entries = Object.entries(stored)
            .filter(([k]) => (!gt || k > gt) && (!lt || k < lt))
            .map(([key, value]) => ({ key, value }))
          return (async function * () { yield * entries })()
        }),
        _stored: stored,
      }
    }

    test('allowed: updates app status, sends native:setPolicy and policy:updated', async () => {
      const existingPolicy = { apps: { 'com.example.app': { status: 'pending' } } }
      const mockDb = makeMockDb({ policy: existingPolicy })
      const mockSend = jest.fn()

      await handleAppDecision({ packageName: 'com.example.app', decision: 'allowed' }, mockDb, mockSend)

      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy')
      expect(policyPuts).toHaveLength(1)
      const [, savedPolicy] = policyPuts[0]
      expect(savedPolicy.apps['com.example.app'].status).toBe('allowed')

      const nativeCalls = mockSend.mock.calls.filter(([m]) => m.method === 'native:setPolicy')
      expect(nativeCalls).toHaveLength(1)

      const updatedEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'policy:updated')
      expect(updatedEvents).toHaveLength(1)
    })

    test('blocked: updates app status to blocked', async () => {
      const existingPolicy = { apps: { 'com.example.app': { status: 'pending' } } }
      const mockDb = makeMockDb({ policy: existingPolicy })
      const mockSend = jest.fn()

      await handleAppDecision({ packageName: 'com.example.app', decision: 'blocked' }, mockDb, mockSend)

      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy')
      expect(policyPuts).toHaveLength(1)
      const [, savedPolicy] = policyPuts[0]
      expect(savedPolicy.apps['com.example.app'].status).toBe('blocked')
    })

    test('invalid decision string: no state change', async () => {
      const existingPolicy = { apps: { 'com.example.app': { status: 'pending' } } }
      const mockDb = makeMockDb({ policy: existingPolicy })
      const mockSend = jest.fn()

      await handleAppDecision({ packageName: 'com.example.app', decision: 'maybe' }, mockDb, mockSend)

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('no policy in db: returns without error', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()

      await expect(
        handleAppDecision({ packageName: 'com.example.app', decision: 'allowed' }, mockDb, mockSend)
      ).resolves.toBeUndefined()

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('allowed: updates pending request status to approved and emits request:updated', async () => {
      const reqKey = 'req:1000:com.example.app'
      const existingPolicy = { apps: { 'com.example.app': { status: 'pending' } } }
      const stored = {
        policy: existingPolicy,
        [reqKey]: { id: reqKey, packageName: 'com.example.app', status: 'pending', requestedAt: 1000 },
      }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()

      await handleAppDecision({ packageName: 'com.example.app', decision: 'allowed' }, mockDb, mockSend)

      expect(stored[reqKey].status).toBe('approved')
      const updatedEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'request:updated')
      expect(updatedEvents).toHaveLength(1)
      expect(updatedEvents[0][0].data).toMatchObject({ requestId: reqKey, status: 'approved' })
    })

    test('blocked: updates pending request status to denied and emits request:updated', async () => {
      const reqKey = 'req:1001:com.example.app'
      const existingPolicy = { apps: { 'com.example.app': { status: 'pending' } } }
      const stored = {
        policy: existingPolicy,
        [reqKey]: { id: reqKey, packageName: 'com.example.app', status: 'pending', requestedAt: 1001 },
      }
      const mockDb = makeMockDb(stored)
      const mockSend = jest.fn()

      await handleAppDecision({ packageName: 'com.example.app', decision: 'blocked' }, mockDb, mockSend)

      expect(stored[reqKey].status).toBe('denied')
      const updatedEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'request:updated')
      expect(updatedEvents).toHaveLength(1)
    })
  })

  // ── Task 7: heartbeat:send ─────────────────────────────────────────────────

  describe('heartbeat:send', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('returns payload with isOnline:true and numeric timestamp', async () => {
      const identity = { publicKey: 'abc123', secretKey: 'secret' }
      const mockDb = makeMockDb({ identity })
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const before = Date.now()
      const result = await dispatch('heartbeat:send', {})
      const after = Date.now()

      expect(result.isOnline).toBe(true)
      expect(result.timestamp).toBeGreaterThanOrEqual(before)
      expect(result.timestamp).toBeLessThanOrEqual(after)
      expect(result.childPublicKey).toBe('abc123')
    })

    test('emits heartbeat:send event', async () => {
      const identity = { publicKey: 'abc123', secretKey: 'secret' }
      const mockDb = makeMockDb({ identity })
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      await dispatch('heartbeat:send', {})

      const events = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'heartbeat:send')
      expect(events).toHaveLength(1)
    })

    test('enforcementActive is null (TODO: not yet wired to native:getEnforcementState)', async () => {
      const identity = { publicKey: 'abc123', secretKey: 'secret' }
      const mockDb = makeMockDb({ identity })
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('heartbeat:send', {})

      // TODO: enforcementActive should be populated via native:getEnforcementState once
      // the RN callRN round-trip helper is implemented.
      expect(result.enforcementActive).toBeNull()
    })

    test('calls ctx.sendToParent with heartbeat payload when sendToParent is provided', async () => {
      const identity = { publicKey: 'abc123', secretKey: 'secret' }
      const mockDb = makeMockDb({ identity })
      const mockSend = jest.fn()
      const mockSendToParent = jest.fn().mockResolvedValue(undefined)
      const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
      const dispatch = createDispatch(ctx)

      await dispatch('heartbeat:send', {})

      expect(mockSendToParent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'heartbeat',
        payload: expect.objectContaining({ isOnline: true }),
      }))
    })
  })

  // ── Task 13: queueMessage / flushMessageQueue ──────────────────────────────

  describe('queueMessage', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('first message creates a single-element array in pendingMessages', async () => {
      const mockDb = makeMockDb({})

      await queueMessage({ type: 'heartbeat', payload: {} }, mockDb)

      const puts = mockDb.put.mock.calls.filter(([k]) => k === 'pendingMessages')
      expect(puts).toHaveLength(1)
      const [, queue] = puts[0]
      expect(queue).toHaveLength(1)
      expect(queue[0].message).toEqual({ type: 'heartbeat', payload: {} })
      expect(typeof queue[0].queuedAt).toBe('number')
    })

    test('second message appends in order', async () => {
      const stored = {}
      const mockDb = makeMockDb(stored)

      await queueMessage({ type: 'msg1' }, mockDb)
      await queueMessage({ type: 'msg2' }, mockDb)

      const puts = mockDb.put.mock.calls.filter(([k]) => k === 'pendingMessages')
      // Second call will have both items
      const [, finalQueue] = puts[puts.length - 1]
      expect(finalQueue).toHaveLength(2)
      expect(finalQueue[0].message).toEqual({ type: 'msg1' })
      expect(finalQueue[1].message).toEqual({ type: 'msg2' })
    })
  })

  describe('flushMessageQueue', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('calls writeMessage for each queued item, clears queue, returns count', async () => {
      const queue = [
        { message: { type: 'msg1' }, queuedAt: 1000 },
        { message: { type: 'msg2' }, queuedAt: 2000 },
        { message: { type: 'msg3' }, queuedAt: 3000 },
      ]
      const mockDb = makeMockDb({ pendingMessages: queue })
      const writeMessage = jest.fn()

      const count = await flushMessageQueue(mockDb, writeMessage)

      expect(count).toBe(3)
      expect(writeMessage).toHaveBeenCalledTimes(3)
      expect(writeMessage.mock.calls[0][0]).toEqual({ type: 'msg1' })
      expect(writeMessage.mock.calls[1][0]).toEqual({ type: 'msg2' })
      expect(writeMessage.mock.calls[2][0]).toEqual({ type: 'msg3' })

      // Queue cleared
      const clearPuts = mockDb.put.mock.calls.filter(([k]) => k === 'pendingMessages')
      expect(clearPuts).toHaveLength(1)
      expect(clearPuts[0][1]).toEqual([])
    })

    test('empty queue: does nothing and returns 0', async () => {
      const mockDb = makeMockDb({ pendingMessages: [] })
      const writeMessage = jest.fn()

      const count = await flushMessageQueue(mockDb, writeMessage)

      expect(count).toBe(0)
      expect(writeMessage).not.toHaveBeenCalled()
      expect(mockDb.put).not.toHaveBeenCalled()
    })

    test('no pendingMessages key: does nothing and returns 0', async () => {
      const mockDb = makeMockDb({})
      const writeMessage = jest.fn()

      const count = await flushMessageQueue(mockDb, writeMessage)

      expect(count).toBe(0)
      expect(writeMessage).not.toHaveBeenCalled()
      expect(mockDb.put).not.toHaveBeenCalled()
    })
  })

  // ── Task 9: pin:used ──────────────────────────────────────────────────────

  describe('pin:used', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('calls appendPinUseLog with packageName, grantedAt, expiresAt; returns { logged: true }', async () => {
      const mockDb = makeMockDb({})
      const ctx = { db: mockDb }
      const dispatch = createDispatch(ctx)

      const timestamp = Date.now()
      const durationSeconds = 600
      const result = await dispatch('pin:used', { packageName: 'com.example.app', timestamp, durationSeconds })

      expect(result).toEqual({ logged: true })

      // appendPinUseLog calls db.put('pinLog', [...])
      const logPuts = mockDb.put.mock.calls.filter(([k]) => k === 'pinLog')
      expect(logPuts).toHaveLength(1)
      const [, log] = logPuts[0]
      expect(log).toHaveLength(1)
      expect(log[0].packageName).toBe('com.example.app')
      expect(log[0].grantedAt).toBe(timestamp)
      expect(log[0].expiresAt).toBe(timestamp + durationSeconds * 1000)
    })

    test('pin:used with missing args: still returns { logged: true } (graceful)', async () => {
      const mockDb = makeMockDb({})
      const ctx = { db: mockDb }
      const dispatch = createDispatch(ctx)

      // timestamp and durationSeconds are undefined — expiresAt will be NaN, but should not throw
      const result = await dispatch('pin:used', {})

      expect(result).toEqual({ logged: true })

      const logPuts = mockDb.put.mock.calls.filter(([k]) => k === 'pinLog')
      expect(logPuts).toHaveLength(1)
    })
  })

  // ── Task 8: bypass:detected ────────────────────────────────────────────────

  describe('bypass:detected', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('stores entry with bypass: key, emits alert:bypass and enforcement:offline, returns { logged: true }', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()
      const ctx = { db: mockDb, send: mockSend }
      const dispatch = createDispatch(ctx)

      const before = Date.now()
      const result = await dispatch('bypass:detected', { reason: 'accessibility_disabled' })
      const after = Date.now()

      expect(result).toEqual({ logged: true })

      // db.put called with a key starting with 'bypass:'
      const bypassPuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('bypass:'))
      expect(bypassPuts).toHaveLength(1)
      const [key, entry] = bypassPuts[0]
      expect(key).toMatch(/^bypass:\d+$/)
      expect(entry.reason).toBe('accessibility_disabled')
      expect(entry.detectedAt).toBeGreaterThanOrEqual(before)
      expect(entry.detectedAt).toBeLessThanOrEqual(after)

      // alert:bypass event emitted
      const bypassEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'alert:bypass')
      expect(bypassEvents).toHaveLength(1)
      expect(bypassEvents[0][0].data.reason).toBe('accessibility_disabled')

      // enforcement:offline event emitted
      const offlineEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'enforcement:offline')
      expect(offlineEvents).toHaveLength(1)
      expect(offlineEvents[0][0].data.reason).toBe('accessibility_disabled')
    })
  })

  // ── Parent-side policy dispatch ─────────────────────────────────────────────

  describe('policy:get', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      }
    }

    test('returns policy for known child', async () => {
      const policy = { apps: { 'com.example.app': { status: 'allowed' } }, childPublicKey: 'abc', version: 1 }
      const mockDb = makeMockDb({ 'policy:abc': policy })
      const dispatch = createDispatch({ db: mockDb })

      const result = await dispatch('policy:get', { childPublicKey: 'abc' })
      expect(result).toEqual(policy)
    })

    test('returns { apps: {} } for unknown child', async () => {
      const mockDb = makeMockDb({})
      const dispatch = createDispatch({ db: mockDb })

      const result = await dispatch('policy:get', { childPublicKey: 'unknown' })
      expect(result).toEqual({ apps: {} })
    })

    test('throws when childPublicKey is missing', async () => {
      const dispatch = createDispatch({ db: makeMockDb() })
      await expect(dispatch('policy:get', {})).rejects.toThrow()
    })
  })

  describe('app:decide', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        del: jest.fn(async (k) => { delete stored[k] }),
        createReadStream: jest.fn(({ gt, lt } = {}) => {
          const entries = Object.entries(stored)
            .filter(([k]) => (!gt || k > gt) && (!lt || k < lt))
            .map(([key, value]) => ({ key, value }))
          return (async function * () { yield * entries })()
        }),
        _stored: stored,
      }
    }

    test('approve: updates app status to allowed, stores policy:{childPublicKey}, calls sendToPeer with noiseKey', async () => {
      const existing = { apps: { 'com.example.app': { status: 'pending' } }, childPublicKey: 'child1', version: 1 }
      // Peer record with noiseKey — sendToPeer requires the noise key, not identity key
      const peerRecord = { publicKey: 'child1', noiseKey: 'noise1', displayName: 'Test', pairedAt: 1 }
      const mockDb = makeMockDb({ 'policy:child1': existing, 'peers:child1': peerRecord })
      const mockSendToPeer = jest.fn()
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

      const result = await dispatch('app:decide', { childPublicKey: 'child1', packageName: 'com.example.app', decision: 'approve' })

      expect(result).toMatchObject({ ok: true, decision: 'allowed' })

      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
      expect(policyPuts).toHaveLength(1)
      const [, saved] = policyPuts[0]
      expect(saved.apps['com.example.app'].status).toBe('allowed')
      expect(saved.version).toBe(2)

      expect(mockSendToPeer).toHaveBeenCalledWith('noise1', expect.objectContaining({
        type: 'app:decision',
        payload: expect.objectContaining({ packageName: 'com.example.app', decision: 'allowed' }),
      }))
    })

    test('deny: updates app status to blocked', async () => {
      const existing = { apps: { 'com.example.app': { status: 'pending' } }, childPublicKey: 'child1', version: 1 }
      const mockDb = makeMockDb({ 'policy:child1': existing })
      const mockSendToPeer = jest.fn()
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

      const result = await dispatch('app:decide', { childPublicKey: 'child1', packageName: 'com.example.app', decision: 'deny' })

      expect(result).toMatchObject({ ok: true, decision: 'blocked' })
      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
      const [, saved] = policyPuts[0]
      expect(saved.apps['com.example.app'].status).toBe('blocked')
    })

    test('child offline (sendToPeer throws): still stores policy, returns ok:true', async () => {
      const existing = { apps: {}, childPublicKey: 'child1', version: 0 }
      const mockDb = makeMockDb({ 'policy:child1': existing })
      const mockSendToPeer = jest.fn().mockImplementation(() => { throw new Error('peer not connected') })
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

      const result = await dispatch('app:decide', { childPublicKey: 'child1', packageName: 'com.example.app', decision: 'approve' })

      expect(result).toMatchObject({ ok: true })
      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
      expect(policyPuts).toHaveLength(1)
    })

    test('no existing policy: creates new one with apps object', async () => {
      const mockDb = makeMockDb({})
      const mockSendToPeer = jest.fn()
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

      const result = await dispatch('app:decide', { childPublicKey: 'child1', packageName: 'com.example.app', decision: 'approve' })

      expect(result).toMatchObject({ ok: true })
      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
      expect(policyPuts).toHaveLength(1)
      const [, saved] = policyPuts[0]
      expect(saved.apps['com.example.app'].status).toBe('allowed')
    })
  })

  describe('policy:update (parent-initiated)', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      }
    }

    test('stores policy:{childPublicKey}, increments version, calls sendToPeer with noiseKey', async () => {
      const policy = { apps: { 'com.example.app': { status: 'allowed' } }, childPublicKey: 'child1', version: 2 }
      // Peer record with noiseKey — sendToPeer requires the noise key, not identity key
      const peerRecord = { publicKey: 'child1', noiseKey: 'noise1', displayName: 'Test', pairedAt: 1 }
      const mockDb = makeMockDb({ 'peers:child1': peerRecord })
      const mockSendToPeer = jest.fn()
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

      const result = await dispatch('policy:update', { childPublicKey: 'child1', policy })

      expect(result).toEqual({ ok: true })

      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
      expect(policyPuts).toHaveLength(1)
      const [, saved] = policyPuts[0]
      expect(saved.version).toBe(3)
      expect(saved.childPublicKey).toBe('child1')

      expect(mockSendToPeer).toHaveBeenCalledWith('noise1', expect.objectContaining({
        type: 'policy:update',
        payload: expect.objectContaining({ version: 3, childPublicKey: 'child1' }),
      }))
    })

    test('child offline (sendToPeer throws): still stores policy, returns ok:true', async () => {
      const policy = { apps: {}, childPublicKey: 'child1', version: 1 }
      const mockDb = makeMockDb({})
      const mockSendToPeer = jest.fn().mockImplementation(() => { throw new Error('peer not connected') })
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

      const result = await dispatch('policy:update', { childPublicKey: 'child1', policy })

      expect(result).toEqual({ ok: true })
      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
      expect(policyPuts).toHaveLength(1)
    })

    test('throws when args are invalid', async () => {
      const dispatch = createDispatch({ db: makeMockDb() })
      await expect(dispatch('policy:update', { childPublicKey: 'child1' })).rejects.toThrow()
      await expect(dispatch('policy:update', { policy: {} })).rejects.toThrow()
    })
  })

  describe('handleIncomingAppInstalled', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        _stored: stored,
      }
    }

    test('new app: creates policy:{childPK} entry with status pending, emits app:installed event', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()

      await handleIncomingAppInstalled(
        { packageName: 'com.example.app', appName: 'Example App', detectedAt: 1000 },
        'childpk1',
        mockDb,
        mockSend
      )

      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:childpk1')
      expect(policyPuts).toHaveLength(1)
      const [, saved] = policyPuts[0]
      expect(saved.apps['com.example.app']).toMatchObject({ status: 'pending' })

      const events = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')
      expect(events).toHaveLength(1)
      expect(events[0][0].data).toMatchObject({ packageName: 'com.example.app', childPublicKey: 'childpk1' })
    })

    test('new app: sends policy:update to child via sendToPeer using stored noiseKey', async () => {
      const mockDb = makeMockDb({ 'peers:childpk1': { noiseKey: 'noise-abc', displayName: 'Kid' } })
      const mockSend = jest.fn()
      const mockSendToPeer = jest.fn()

      await handleIncomingAppInstalled(
        { packageName: 'com.example.app', appName: 'Example App', detectedAt: 1000 },
        'childpk1',
        mockDb,
        mockSend,
        mockSendToPeer
      )

      expect(mockSendToPeer).toHaveBeenCalledWith('noise-abc', expect.objectContaining({
        type: 'policy:update',
        payload: expect.objectContaining({ apps: expect.objectContaining({ 'com.example.app': expect.objectContaining({ status: 'pending' }) }) }),
      }))
    })

    test('new app: no sendToPeer call when child has no noiseKey', async () => {
      const mockDb = makeMockDb({ 'peers:childpk1': { displayName: 'Kid' } }) // no noiseKey
      const mockSend = jest.fn()
      const mockSendToPeer = jest.fn()

      await handleIncomingAppInstalled(
        { packageName: 'com.example.app', appName: 'Example App', detectedAt: 1000 },
        'childpk1', mockDb, mockSend, mockSendToPeer
      )

      expect(mockSendToPeer).not.toHaveBeenCalled()
    })

    test('already-known app: no db write, no event', async () => {
      const existing = { apps: { 'com.example.app': { status: 'allowed' } }, childPublicKey: 'childpk1', version: 1 }
      const mockDb = makeMockDb({ 'policy:childpk1': existing })
      const mockSend = jest.fn()

      await handleIncomingAppInstalled(
        { packageName: 'com.example.app', appName: 'Example App', detectedAt: 1000 },
        'childpk1',
        mockDb,
        mockSend
      )

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('missing packageName: returns without error, no writes', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()

      await handleIncomingAppInstalled({}, 'childpk1', mockDb, mockSend)

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe('handleIncomingAppsSync', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      }
    }

    test('first sync: apps get status allowed, policy:update sent to child, events suppressed', async () => {
      const mockDb = makeMockDb({ 'peers:childpk1': { noiseKey: 'noise-abc' } }) // no prior policy
      const mockSend = jest.fn()
      const mockSendToPeer = jest.fn()

      await handleIncomingAppsSync(
        { apps: [{ packageName: 'com.example.app', appName: 'Example' }] },
        'childpk1', mockDb, mockSend, mockSendToPeer
      )

      // Policy written with status 'allowed' (not 'pending')
      expect(mockDb.put).toHaveBeenCalledWith('policy:childpk1', expect.objectContaining({
        apps: expect.objectContaining({
          'com.example.app': expect.objectContaining({ status: 'allowed' }),
        }),
      }))

      // Policy pushed to child on first sync
      expect(mockSendToPeer).toHaveBeenCalledWith('noise-abc', expect.objectContaining({ type: 'policy:update' }))

      // Alert entries suppressed
      const alertPuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('alert:'))
      expect(alertPuts).toHaveLength(0)

      // app:installed events suppressed
      const appInstalledEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')
      expect(appInstalledEvents).toHaveLength(0)

      // apps:synced still fires
      const syncedEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'apps:synced')
      expect(syncedEvents).toHaveLength(1)
    })

    test('incremental sync: emits app:installed, writes alert, and sends policy:update to child', async () => {
      const existing = { apps: { 'com.example.old': { status: 'allowed' } }, childPublicKey: 'childpk1', version: 0 }
      const mockDb = makeMockDb({ 'policy:childpk1': existing, 'peers:childpk1': { noiseKey: 'noise-abc' } })
      const mockSend = jest.fn()
      const mockSendToPeer = jest.fn()

      await handleIncomingAppsSync(
        { apps: [{ packageName: 'com.example.new', appName: 'New App' }] },
        'childpk1', mockDb, mockSend, mockSendToPeer
      )

      const alertPuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('alert:'))
      expect(alertPuts).toHaveLength(1)

      const appInstalledEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')
      expect(appInstalledEvents).toHaveLength(1)
      expect(appInstalledEvents[0][0].data).toMatchObject({ packageName: 'com.example.new', childPublicKey: 'childpk1' })

      expect(mockSendToPeer).toHaveBeenCalledWith('noise-abc', expect.objectContaining({ type: 'policy:update' }))
    })

    test('incremental sync: already-known apps are not re-emitted', async () => {
      const existing = { apps: { 'com.example.app': { status: 'pending' } }, childPublicKey: 'childpk1', version: 0 }
      const mockDb = makeMockDb({ 'policy:childpk1': existing })
      const mockSend = jest.fn()

      await handleIncomingAppsSync(
        { apps: [{ packageName: 'com.example.app', appName: 'Example' }] },
        'childpk1', mockDb, mockSend
      )

      const appInstalledEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')
      expect(appInstalledEvents).toHaveLength(0)
      // No policy write needed since nothing changed
      expect(mockDb.put).not.toHaveBeenCalled()
    })
  })

  describe('handleIncomingTimeRequest', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      }
    }

    test('stores request with request:{requestId} key, emits time:request:received event', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()

      await handleIncomingTimeRequest(
        { requestId: 'req:1234:com.example.tiktok', packageName: 'com.example.tiktok', requestedAt: 1234 },
        'childpk1',
        mockDb,
        mockSend
      )

      const reqPuts = mockDb.put.mock.calls.filter(([k]) => k === 'request:req:1234:com.example.tiktok')
      expect(reqPuts).toHaveLength(1)
      const [, saved] = reqPuts[0]
      expect(saved).toMatchObject({ status: 'pending', packageName: 'com.example.tiktok', childPublicKey: 'childpk1' })

      const events = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'time:request:received')
      expect(events).toHaveLength(1)
      expect(events[0][0].data).toMatchObject({ packageName: 'com.example.tiktok', childPublicKey: 'childpk1' })
    })

    test('missing requestId: returns without error, no writes', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()

      await handleIncomingTimeRequest({ packageName: 'com.example.tiktok' }, 'childpk1', mockDb, mockSend)

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })

    test('duplicate: does not re-emit event or overwrite existing entry', async () => {
      const existing = { id: 'req:1234:com.example.tiktok', packageName: 'com.example.tiktok', requestedAt: 1234, status: 'pending', childPublicKey: 'childpk1' }
      const mockDb = makeMockDb({ 'request:req:1234:com.example.tiktok': existing })
      const mockSend = jest.fn()

      await handleIncomingTimeRequest(
        { requestId: 'req:1234:com.example.tiktok', packageName: 'com.example.tiktok', requestedAt: 1234 },
        'childpk1',
        mockDb,
        mockSend
      )

      expect(mockDb.put).not.toHaveBeenCalled()
      expect(mockSend).not.toHaveBeenCalled()
    })
  })

  describe('pin:isSet', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        createReadStream: jest.fn(async function * () {}),
      }
    }

    test('returns { isSet: true } when pinHash is stored in policy', async () => {
      const mockDb = makeMockDb({ policy: { pinHash: '$argon2id$...' } })
      const ctx = { db: mockDb, send: jest.fn() }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('pin:isSet', {})
      expect(result).toEqual({ isSet: true })
    })

    test('returns { isSet: false } when policy exists but has no pinHash', async () => {
      const mockDb = makeMockDb({ policy: { apps: {} } })
      const ctx = { db: mockDb, send: jest.fn() }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('pin:isSet', {})
      expect(result).toEqual({ isSet: false })
    })

    test('returns { isSet: false } when no policy key exists at all', async () => {
      const mockDb = makeMockDb({}) // empty DB
      const ctx = { db: mockDb, send: jest.fn() }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('pin:isSet', {})
      expect(result).toEqual({ isSet: false })
    })
  })

  describe('export / import dispatch', () => {
    const { generateKeypair } = require('../src/identity')

    function makeCtx () {
      const kp = generateKeypair()
      const identity = { publicKey: kp.publicKey.toString('hex'), secretKey: kp.secretKey.toString('hex') }
      const stored = { identity }
      const db = {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        del: jest.fn(async (k) => { delete stored[k] }),
        createReadStream: ({ gt, lt }) => {
          const prefix = gt.replace(/[^:]*$/, '')
          const keys = Object.keys(stored).filter(k => k > gt && k < lt).sort()
          return (async function* () {
            for (const k of keys) yield { key: k, value: stored[k] }
          })()
        }
      }
      return { db, stored, identity, sendToPeer: jest.fn(), peers: new Map() }
    }

    test('rules:export then rules:import:preview produces diff', async () => {
      const ctx = makeCtx()
      const childA = 'aa'.repeat(32)
      const childB = 'bb'.repeat(32)
      ctx.stored['policy:' + childA] = {
        childPublicKey: childA, version: 1,
        apps: { 'com.x': { status: 'blocked', appName: 'X', addedAt: 1 } },
        schedules: [], pinHash: 'A', locked: false, lockMessage: ''
      }
      ctx.stored['policy:' + childB] = {
        childPublicKey: childB, version: 1,
        apps: { 'com.y': { status: 'allowed', appName: 'Y', addedAt: 1 } },
        schedules: [], pinHash: 'B', locked: false, lockMessage: ''
      }
      const dispatch = createDispatch(ctx)
      const { json } = await dispatch('rules:export', { childPubKey: childA })
      const preview = await dispatch('rules:import:preview', { jsonString: json, targetChildPubKey: childB })
      expect(preview.sourceChildPubKey).toBe(childA)
      expect(preview.appsAdded).toEqual([{ packageName: 'com.x', appName: 'X' }])
      expect(preview.appsRemoved).toEqual([{ packageName: 'com.y', appName: 'Y' }])
    })

    test('rules:import:apply preserves target pinHash and locked', async () => {
      const ctx = makeCtx()
      const childA = 'aa'.repeat(32)
      const childB = 'bb'.repeat(32)
      ctx.stored['policy:' + childA] = {
        childPublicKey: childA, version: 1,
        apps: { 'com.x': { status: 'blocked', appName: 'X', addedAt: 1 } },
        schedules: [{ label: 'N', days: [0], start: '21:00', end: '07:00', exemptApps: [] }],
        pinHash: 'A', locked: false, lockMessage: ''
      }
      ctx.stored['policy:' + childB] = {
        childPublicKey: childB, version: 5,
        apps: {}, schedules: [],
        pinHash: 'KEEPME', locked: true, lockMessage: 'hi'
      }
      ctx.stored['peers:' + childB] = { publicKey: childB, noiseKey: 'nk' }
      const dispatch = createDispatch(ctx)
      const { json } = await dispatch('rules:export', { childPubKey: childA })
      await dispatch('rules:import:apply', { jsonString: json, targetChildPubKey: childB })
      const written = ctx.stored['policy:' + childB]
      expect(written.pinHash).toBe('KEEPME')
      expect(written.locked).toBe(true)
      expect(written.lockMessage).toBe('hi')
      expect(written.apps['com.x']).toBeDefined()
      expect(written.schedules).toHaveLength(1)
      expect(written.version).toBe(6)
      expect(ctx.sendToPeer).toHaveBeenCalledWith('nk', expect.objectContaining({ type: 'policy:update' }))
    })

    test('backup:export then backup:import round-trips on fresh ctx', async () => {
      const ctxA = makeCtx()
      const childA = 'aa'.repeat(32)
      ctxA.stored['profile'] = { displayName: 'Parent', avatar: null }
      ctxA.stored['parentSettings'] = { timeRequestMinutes: [15], warningMinutes: [5] }
      ctxA.stored['peers:' + childA] = { publicKey: childA, displayName: 'Kid', swarmTopic: 'cc'.repeat(32), noiseKey: 'nk' }
      ctxA.stored['policy:' + childA] = { childPublicKey: childA, version: 1, apps: {}, schedules: [] }
      const dispatchA = createDispatch(ctxA)
      const { json, peerCount, policyCount } = await dispatchA('backup:export', {})
      expect(peerCount).toBe(1)
      expect(policyCount).toBe(1)

      const ctxB = { ...makeCtx(), sendToPeer: jest.fn(), peers: new Map() }
      delete ctxB.stored.identity // fresh install
      const dispatchB = createDispatch(ctxB)
      const result = await dispatchB('backup:import', { jsonString: json })
      expect(result.ok).toBe(true)
      expect(result.paired).toContain(childA)
      expect(ctxB.stored.identity.publicKey).toBe(ctxA.identity.publicKey)
      expect(ctxB.stored['peers:' + childA]).toBeDefined()
      expect(ctxB.stored['policy:' + childA]).toBeDefined()
      expect(ctxB.stored.mode).toBe('parent')
    })

    test('backup:import refuses non-fresh device without allowOverwrite', async () => {
      const ctxA = makeCtx()
      const dispatchA = createDispatch(ctxA)
      const { json } = await dispatchA('backup:export', {})
      const ctxB = makeCtx() // already has its own identity
      const dispatchB = createDispatch(ctxB)
      await expect(dispatchB('backup:import', { jsonString: json })).rejects.toThrow(/not fresh/)
    })
  })
})
