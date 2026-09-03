// tests/bare-dispatch.test.js
//
// Tests the method dispatch table in isolation.
// Does NOT test the full IPC stream (that requires a running Bare worklet — device test).

// Minimal stub for BareKit global (not available in Node/jest)
global.BareKit = { IPC: { write: jest.fn(), on: jest.fn() } }

// We require the dispatch logic indirectly by extracting it.
const { createDispatch, withPolicyLock, stripAppIcons, shouldAcceptRelayedPolicy, replayActiveGrants, settleDeliveredGrant, handleRequestResolved, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingAppsSync, handleIncomingTimeRequest, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue, dailyTotalsSignature, resolveAppName, applyPolicyNamesToReport, isBlockClearedByFreshInvite, groupSessionsByLocalDate, pruneStaleKeys } = require('../src/bare-dispatch')
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
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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
      const ctx = { db: mockDb, sodium, identity: { publicKey: 'abc123', secretKey: 'secret' } }
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
      const ctx = { db: mockDb, sodium, identity: { publicKey: 'abc123', secretKey: 'secret' } }
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
      const ctx = { db: mockDb, sodium, identity: { publicKey: 'abc123', secretKey: 'secret' } }
      const dispatch = createDispatch(ctx)

      await expect(dispatch('pin:set', {})).rejects.toThrow(/4 to 10 digits/)
    })

    test('non-string pin throws', async () => {
      const mockDb = makeMockDb()
      const ctx = { db: mockDb, sodium, identity: { publicKey: 'abc123', secretKey: 'secret' } }
      const dispatch = createDispatch(ctx)

      await expect(dispatch('pin:set', { pin: 1234 })).rejects.toThrow(/4 to 10 digits/)
    })

    test('pin shorter than 4 or longer than 10 digits throws', async () => {
      const mockDb = makeMockDb()
      const ctx = { db: mockDb, sodium, identity: { publicKey: 'abc123', secretKey: 'secret' } }
      const dispatch = createDispatch(ctx)

      await expect(dispatch('pin:set', { pin: '123' })).rejects.toThrow(/4 to 10 digits/)
      await expect(dispatch('pin:set', { pin: '12345678901' })).rejects.toThrow(/4 to 10 digits/)
    })

    test('non-digit pin throws', async () => {
      const mockDb = makeMockDb()
      const ctx = { db: mockDb, sodium, identity: { publicKey: 'abc123', secretKey: 'secret' } }
      const dispatch = createDispatch(ctx)

      await expect(dispatch('pin:set', { pin: '12a4' })).rejects.toThrow(/only digits/)
    })

    test('accepts a 10-digit pin and stores its hash', async () => {
      const mockDb = makeMockDb()
      const ctx = { db: mockDb, sodium, identity: { publicKey: 'abc123', secretKey: 'secret' } }
      const dispatch = createDispatch(ctx)

      await expect(dispatch('pin:set', { pin: '1234567890' })).resolves.toEqual({ ok: true })
      const stored = await mockDb.get('policy')
      expect(stored.value.pinPlain).toBe('1234567890')
      expect(stored.value.pinHash).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('usage:flush', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        // usage:flush sweeps resolved req: entries to piggyback on the report
        createReadStream: jest.fn(({ gt, lt } = {}) => {
          const entries = Object.entries(stored)
            .filter(([k]) => (!gt || k > gt) && (!lt || k < lt))
            .map(([k, v]) => ({ key: k, value: v }))
          return (async function* () { for (const e of entries) yield e })()
        }),
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

    test('persists report to db under the single usage:latest key', async () => {
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
      expect(key).toBe('usage:latest')
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
      const ctx = { db: mockDb, send: mockSend, sendToAllParents: mockSendToParent }
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
      expect(report.apps[0]).toEqual({ packageName: 'com.example.chrome', displayName: 'Chrome', todaySeconds: 3600, weekSeconds: 0, dailyLimitSeconds: null })
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
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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

    // The Linux child's usage rows can arrive naming apps by their slug: its
    // tracker cached names in memory only, so anything restored after a restart
    // had counters but no name, and usage:flush fell back to the packageName.
    // The parent already knows the real name from apps:sync, so it fixes the
    // label on read — including for reports already stored.
    test('names apps from the policy when the child sent the raw slug', async () => {
      const mockDb = makeMockDb({
        'usageReport:pk-child:latest': {
          timestamp: Date.now(),
          apps: [
            { packageName: 'linux.firefox_esr', displayName: 'linux.firefox_esr', todaySeconds: 420 },
            { packageName: 'linux.calculator', displayName: 'linux.calculator', todaySeconds: 1140 },
          ],
          sessions: [{ packageName: 'linux.firefox_esr', displayName: null, startedAt: Date.now(), durationSeconds: 420 }],
          currentAppPackage: 'linux.firefox_esr',
          currentApp: 'linux.firefox_esr',
          childPublicKey: 'pk-child',
        },
        'policy:pk-child': {
          apps: {
            'linux.firefox_esr': { appName: 'Firefox ESR', status: 'allowed' },
            'linux.calculator': { appName: 'Calculator', status: 'allowed' },
          },
        },
      })
      mockDb.createReadStream = jest.fn(async function * () {})
      const dispatch = createDispatch({ db: mockDb, send: jest.fn() })

      const result = await dispatch('usage:getLatest', { childPublicKey: 'pk-child' })
      expect(result.apps.map((a) => a.displayName)).toEqual(['Firefox ESR', 'Calculator'])
      expect(result.sessions[0].displayName).toBe('Firefox ESR')
      expect(result.currentApp).toBe('Firefox ESR')
      // The counters must survive the relabel untouched.
      expect(result.apps[0].todaySeconds).toBe(420)
    })

    test('keeps a name the child sent for an app the policy has never seen', async () => {
      const mockDb = makeMockDb({
        'usageReport:pk-child:latest': {
          timestamp: Date.now(),
          apps: [{ packageName: 'linux.brand_new', displayName: 'Brand New', todaySeconds: 60 }],
          childPublicKey: 'pk-child',
        },
        'policy:pk-child': { apps: {} },
      })
      mockDb.createReadStream = jest.fn(async function * () {})
      const dispatch = createDispatch({ db: mockDb, send: jest.fn() })

      const result = await dispatch('usage:getLatest', { childPublicKey: 'pk-child' })
      expect(result.apps[0].displayName).toBe('Brand New')
    })
  })

  // The Activity feed showed a wall of rows reading literally
  // "linux:extension-disabled", each badged red as a "Bypass Attempt". The label
  // came from a hardcoded map of the five Android reasons, so every desktop
  // reason fell through to the raw slug; and every reason was typed 'bypass',
  // which accuses the child even when PearGuard is the thing that failed.
  // Relabelling on READ fixes the rows already stored, not just new ones.
  describe('alerts:list relabels stored bypass alerts', () => {
    function makeAlertDb (alerts) {
      const stored = {}
      for (const a of alerts) stored['alert:pk-child:' + a.timestamp] = a
      return {
        get: jest.fn(async () => null),
        put: jest.fn(),
        del: jest.fn(),
        createReadStream: jest.fn(async function * ({ gt }) {
          if (!gt.startsWith('alert:')) return
          for (const [key, value] of Object.entries(stored)) yield { key, value }
        }),
      }
    }

    test('a capability failure is not shown as a bypass attempt', async () => {
      const db = makeAlertDb([{
        id: 'bypass:1', type: 'bypass', timestamp: Date.now(),
        reason: 'linux:extension-not-loaded',
        appDisplayName: 'linux:extension-not-loaded',   // the raw slug, as stored
        childPublicKey: 'pk-child', childDisplayName: 'Ben',
      }])
      const dispatch = createDispatch({ db, send: jest.fn(), getMode: () => 'parent', sendToPeer: jest.fn() })

      const [alert] = await dispatch('alerts:list', { childPublicKey: 'pk-child' })
      expect(alert.type).toBe('enforcement_off')
      expect(alert.appDisplayName).not.toMatch(/^linux:/)
      expect(alert.appDisplayName).toMatch(/Ben/)
      expect(alert.body).toMatch(/log out/i)
    })

    test('real tampering is still typed as a bypass and still names what they did', async () => {
      const db = makeAlertDb([{
        id: 'bypass:2', type: 'bypass', timestamp: Date.now(),
        reason: 'linux:extension-disabled',
        appDisplayName: 'linux:extension-disabled',
        childPublicKey: 'pk-child', childDisplayName: 'Ben',
      }])
      const dispatch = createDispatch({ db, send: jest.fn(), getMode: () => 'parent', sendToPeer: jest.fn() })

      const [alert] = await dispatch('alerts:list', { childPublicKey: 'pk-child' })
      expect(alert.type).toBe('bypass')
      expect(alert.appDisplayName).toMatch(/Ben/)
      expect(alert.body).toMatch(/turned off/i)
    })

    test('an Android reason keeps its meaning', async () => {
      const db = makeAlertDb([{
        id: 'bypass:3', type: 'bypass', timestamp: Date.now(),
        reason: 'accessibility_disabled',
        appDisplayName: 'Accessibility Service disabled',
        childPublicKey: 'pk-child', childDisplayName: 'Ben',
      }])
      const dispatch = createDispatch({ db, send: jest.fn(), getMode: () => 'parent', sendToPeer: jest.fn() })

      const [alert] = await dispatch('alerts:list', { childPublicKey: 'pk-child' })
      expect(alert.type).toBe('bypass')
      expect(alert.body).toMatch(/Accessibility Service/)
    })
  })

  describe('alerts:dismiss / alerts:clear', () => {
    function makeStore (stored) {
      return {
        stored,
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        put: jest.fn(async (k, v) => { stored[k] = v }),
        del: jest.fn(async (k) => { delete stored[k] }),
        createReadStream: jest.fn(async function * ({ gt, lt }) {
          for (const [key, value] of Object.entries(stored)) {
            if (key > gt && key < lt) yield { key, value }
          }
        }),
      }
    }

    test('dismiss removes exactly the one alert', async () => {
      const db = makeStore({
        'alert:pk-child:100': { id: 'bypass:100', type: 'bypass', timestamp: 100 },
        'alert:pk-child:200': { id: 'bypass:200', type: 'bypass', timestamp: 200 },
      })
      const dispatch = createDispatch({ db, send: jest.fn() })

      await dispatch('alerts:dismiss', { childPublicKey: 'pk-child', timestamp: 100 })
      expect(db.stored['alert:pk-child:100']).toBeUndefined()
      expect(db.stored['alert:pk-child:200']).toBeDefined()
    })

    // The Activity feed is fed from BOTH alert: and request: rows. A request is
    // an unanswered question from the child — clearing history must never throw
    // one away, or the child waits forever for an answer that no longer exists.
    test('clear wipes alerts but NEVER touches requests', async () => {
      const db = makeStore({
        'alert:pk-child:100': { id: 'bypass:100', type: 'bypass', timestamp: 100 },
        'alert:pk-child:200': { id: 'bypass:200', type: 'enforcement_off', timestamp: 200 },
        'request:req-1': { id: 'req-1', childPublicKey: 'pk-child', status: 'pending', requestedAt: 150 },
      })
      const dispatch = createDispatch({ db, send: jest.fn() })

      const result = await dispatch('alerts:clear', { childPublicKey: 'pk-child' })
      expect(result.dismissed).toBe(2)
      expect(db.stored['alert:pk-child:100']).toBeUndefined()
      expect(db.stored['alert:pk-child:200']).toBeUndefined()
      expect(db.stored['request:req-1']).toBeDefined()
    })

    test('clear only touches the child it was asked about', async () => {
      const db = makeStore({
        'alert:pk-child:100': { id: 'bypass:100', timestamp: 100 },
        'alert:pk-other:100': { id: 'bypass:100', timestamp: 100 },
      })
      const dispatch = createDispatch({ db, send: jest.fn() })

      await dispatch('alerts:clear', { childPublicKey: 'pk-child' })
      expect(db.stored['alert:pk-child:100']).toBeUndefined()
      expect(db.stored['alert:pk-other:100']).toBeDefined()
    })

    test('both reject a missing childPublicKey', async () => {
      const dispatch = createDispatch({ db: makeStore({}), send: jest.fn() })
      await expect(dispatch('alerts:dismiss', { timestamp: 1 })).rejects.toThrow(/invalid/)
      await expect(dispatch('alerts:clear', {})).rejects.toThrow(/invalid/)
    })
  })

  describe('resolveAppName', () => {
    test('prefers the policy name, which is the one the Apps tab shows', () => {
      expect(resolveAppName('linux.firefox_esr', 'Firefox ESR', 'firefox-esr')).toBe('Firefox ESR')
    })

    test('falls back to the reported name when the policy has none', () => {
      expect(resolveAppName('win.notepad', undefined, 'Notepad')).toBe('Notepad')
      expect(resolveAppName('win.notepad', null, 'Notepad')).toBe('Notepad')
    })

    // Both sides store `appName || packageName`, so "the name is the slug" is
    // the shape a missing name actually takes. It must never win over a real one.
    test('treats a name equal to the package as no name at all', () => {
      expect(resolveAppName('linux.calculator', 'linux.calculator', 'Calculator')).toBe('Calculator')
      expect(resolveAppName('linux.calculator', 'Calculator', 'linux.calculator')).toBe('Calculator')
    })

    test('shows the package only when nothing better exists anywhere', () => {
      expect(resolveAppName('linux.software', null, null)).toBe('linux.software')
      expect(resolveAppName('linux.software', 'linux.software', 'linux.software')).toBe('linux.software')
    })
  })

  describe('applyPolicyNamesToReport', () => {
    test('leaves a report with no apps/sessions arrays alone', () => {
      const r = applyPolicyNamesToReport({ timestamp: 1, todayScreenTimeSeconds: 0 }, {})
      expect(r.timestamp).toBe(1)
      expect(r.todayScreenTimeSeconds).toBe(0)
    })

    test('is a no-op without a policy rather than throwing', () => {
      const report = { apps: [{ packageName: 'a', displayName: 'A' }] }
      expect(applyPolicyNamesToReport(report, null)).toBe(report)
    })
  })

  describe('time:request', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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
      const ctx = { db: mockDb, send: mockSend, sendToAllParents: mockSendToParent }
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
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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

    test('creates an approved request record if requestId not found (so a re-send is deduped), stores override grant and sends native/events', async () => {
      const mockDb = makeMockDb({})  // empty db — child was offline, so never saw the request
      const mockSend = jest.fn()

      await handleTimeExtend({ requestId: 'req:999:com.example.app', packageName: 'com.example.app', extraSeconds: 300 }, mockDb, mockSend)

      // The request record is CREATED with status 'approved' so the idempotency guard
      // drops the parent's next re-send of the same offline grant (#210).
      const reqPuts = mockDb.put.mock.calls.filter(([k]) => k === 'req:999:com.example.app')
      expect(reqPuts).toHaveLength(1)
      expect(reqPuts[0][1]).toMatchObject({ id: 'req:999:com.example.app', packageName: 'com.example.app', status: 'approved' })
      // The override grant is still persisted so overrides:list can find it (#61)
      const overridePuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('override:'))
      expect(overridePuts).toHaveLength(1)

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

  describe('appendPinUseLog', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
        _stored: stored,
      }
    }

    test('appends an entry to pinLog', async () => {
      const stored = {}
      const mockDb = makeMockDb(stored)
      await appendPinUseLog({ packageName: 'com.a', grantedAt: 1, expiresAt: 2 }, mockDb)
      expect(stored.pinLog).toHaveLength(1)
      expect(stored.pinLog[0]).toEqual({ packageName: 'com.a', grantedAt: 1, expiresAt: 2 })
    })

    test('caps pinLog at 500 entries, keeping the most recent', async () => {
      const existing = Array.from({ length: 500 }, (_, i) => ({ packageName: 'com.old', grantedAt: i }))
      const stored = { pinLog: existing }
      const mockDb = makeMockDb(stored)

      await appendPinUseLog({ packageName: 'com.new', grantedAt: 9999 }, mockDb)

      expect(stored.pinLog).toHaveLength(500)
      // oldest (grantedAt 0) was dropped, newest is at the tail
      expect(stored.pinLog[0]).toEqual({ packageName: 'com.old', grantedAt: 1 })
      expect(stored.pinLog[499]).toEqual({ packageName: 'com.new', grantedAt: 9999 })
    })
  })

  describe('dailyTotalsSignature', () => {
    test('is identical regardless of app order (so reordered-but-same days dedup)', () => {
      const a = [
        { packageName: 'com.a', secondsToday: 60, displayName: 'A' },
        { packageName: 'com.b', secondsToday: 120, displayName: 'B' },
      ]
      const b = [
        { packageName: 'com.b', secondsToday: 120, displayName: 'B' },
        { packageName: 'com.a', secondsToday: 60, displayName: 'A' },
      ]
      expect(dailyTotalsSignature(a)).toBe(dailyTotalsSignature(b))
    })

    test('differs when seconds change (so an updated day is written)', () => {
      const a = [{ packageName: 'com.a', secondsToday: 60, displayName: 'A' }]
      const b = [{ packageName: 'com.a', secondsToday: 61, displayName: 'A' }]
      expect(dailyTotalsSignature(a)).not.toBe(dailyTotalsSignature(b))
    })

    test('differs when an app is added or removed', () => {
      const a = [{ packageName: 'com.a', secondsToday: 60 }]
      const b = [
        { packageName: 'com.a', secondsToday: 60 },
        { packageName: 'com.b', secondsToday: 5 },
      ]
      expect(dailyTotalsSignature(a)).not.toBe(dailyTotalsSignature(b))
    })

    test('handles missing fields and non-arrays safely', () => {
      expect(dailyTotalsSignature(null)).toBe('')
      expect(dailyTotalsSignature(undefined)).toBe('')
      expect(dailyTotalsSignature([{}])).toBe('=0:')
    })
  })

  // ── Task 6: app:installed ──────────────────────────────────────────────────

  describe('app:installed', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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
      const ctx = { db: mockDb, send: mockSend, sendToAllParents: mockSendToParent }
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
      const ctx = { db: mockDb, send: mockSend, sendToAllParents: mockSendToParent }
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
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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
      const ctx = { db: mockDb, send: mockSend, sendToAllParents: mockSendToParent }
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
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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

    test('repeated heartbeats collapse to the latest only', async () => {
      const stored = {}
      const mockDb = makeMockDb(stored)

      await queueMessage({ type: 'heartbeat', payload: { seq: 1 } }, mockDb)
      await queueMessage({ type: 'heartbeat', payload: { seq: 2 } }, mockDb)
      await queueMessage({ type: 'heartbeat', payload: { seq: 3 } }, mockDb)

      expect(stored.pendingMessages).toHaveLength(1)
      expect(stored.pendingMessages[0].message).toEqual({ type: 'heartbeat', payload: { seq: 3 } })
    })

    test('repeated usage:report collapse to the latest only', async () => {
      const stored = {}
      const mockDb = makeMockDb(stored)

      await queueMessage({ type: 'usage:report', payload: { ts: 1000 } }, mockDb)
      await queueMessage({ type: 'usage:report', payload: { ts: 2000 } }, mockDb)

      expect(stored.pendingMessages).toHaveLength(1)
      expect(stored.pendingMessages[0].message).toEqual({ type: 'usage:report', payload: { ts: 2000 } })
    })

    test('collapsing a snapshot type preserves other queued messages and ordering', async () => {
      const stored = {}
      const mockDb = makeMockDb(stored)

      await queueMessage({ type: 'usage:report', payload: { ts: 1000 } }, mockDb)
      await queueMessage({ type: 'time:request', payload: { id: 'r1' } }, mockDb)
      await queueMessage({ type: 'heartbeat', payload: { seq: 1 } }, mockDb)
      await queueMessage({ type: 'usage:report', payload: { ts: 2000 } }, mockDb)
      await queueMessage({ type: 'time:request', payload: { id: 'r2' } }, mockDb)

      const types = stored.pendingMessages.map((e) => e.message.type)
      // both distinct time:requests survive; only the latest usage:report + heartbeat remain
      expect(types).toEqual(['time:request', 'heartbeat', 'usage:report', 'time:request'])
      const report = stored.pendingMessages.find((e) => e.message.type === 'usage:report')
      expect(report.message.payload).toEqual({ ts: 2000 })
      expect(stored.pendingMessages.filter((e) => e.message.type === 'time:request').map((e) => e.message.payload.id))
        .toEqual(['r1', 'r2'])
    })
  })

  describe('flushMessageQueue', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
        _stored: stored,
      }
    }

    test('calls appendPinUseLog with packageName, grantedAt, expiresAt; returns { logged: true }', async () => {
      const mockDb = makeMockDb({})
      const ctx = { db: mockDb, send: jest.fn() }
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
      const ctx = { db: mockDb, send: jest.fn() }
      const dispatch = createDispatch(ctx)

      // timestamp and durationSeconds are undefined — expiresAt will be NaN, but should not throw
      const result = await dispatch('pin:used', {})

      expect(result).toEqual({ logged: true })

      const logPuts = mockDb.put.mock.calls.filter(([k]) => k === 'pinLog')
      expect(logPuts).toHaveLength(1)
    })
  })

  // ── pin:failed (parent alert on lockout) ───────────────────────────────────

  describe('pin:failed', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
        _stored: stored,
      }
    }

    test('relays a pin:failure to parents with resolved appName and lockout details', async () => {
      const mockDb = makeMockDb({
        policy: { apps: { 'com.example.game': { appName: 'Some Game' } } },
      })
      const sendToAllParents = jest.fn(async () => {})
      const ctx = { db: mockDb, send: jest.fn(), sendToAllParents }
      const dispatch = createDispatch(ctx)

      const timestamp = 1_700_000_000_000
      const result = await dispatch('pin:failed', {
        packageName: 'com.example.game', timestamp, failCount: 6, lockoutMs: 30000,
      })

      expect(result).toEqual({ logged: true })
      expect(sendToAllParents).toHaveBeenCalledTimes(1)
      expect(sendToAllParents).toHaveBeenCalledWith({
        type: 'pin:failure',
        payload: {
          packageName: 'com.example.game',
          appName: 'Some Game',
          failedAt: timestamp,
          failCount: 6,
          lockoutMs: 30000,
        },
      })
    })

    test('does not store anything child-side (parent owns the alert)', async () => {
      const mockDb = makeMockDb({})
      const ctx = { db: mockDb, send: jest.fn(), sendToAllParents: jest.fn(async () => {}) }
      const dispatch = createDispatch(ctx)

      await dispatch('pin:failed', { packageName: 'com.x', timestamp: 1, failCount: 5, lockoutMs: 30000 })

      expect(mockDb.put).not.toHaveBeenCalled()
    })

    test('is graceful when no parents are connected (no sendToAllParents)', async () => {
      const mockDb = makeMockDb({})
      const ctx = { db: mockDb, send: jest.fn() }
      const dispatch = createDispatch(ctx)

      const result = await dispatch('pin:failed', { packageName: 'com.x', timestamp: 1, failCount: 5, lockoutMs: 30000 })
      expect(result).toEqual({ logged: true })
    })
  })

  // ── Task 8: bypass:detected ────────────────────────────────────────────────

  describe('bypass:detected', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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
        // A new pending app scans for an existing approval before creating a
        // duplicate card, so the mock has to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
        _stored: stored,
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
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer, send: jest.fn() })

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
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer, send: jest.fn() })

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
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer, send: jest.fn() })

      const result = await dispatch('app:decide', { childPublicKey: 'child1', packageName: 'com.example.app', decision: 'approve' })

      expect(result).toMatchObject({ ok: true })
      const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
      expect(policyPuts).toHaveLength(1)
    })

    test('no existing policy: creates new one with apps object', async () => {
      const mockDb = makeMockDb({})
      const mockSendToPeer = jest.fn()
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer, send: jest.fn() })

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
        // A new pending app scans for an existing approval before creating a
        // duplicate card, so the mock has to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
        _stored: stored,
      }
    }

    test('stores policy:{childPublicKey}, increments version, calls sendToPeer with noiseKey', async () => {
      const policy = { apps: { 'com.example.app': { status: 'allowed' } }, childPublicKey: 'child1', version: 2 }
      // Peer record with noiseKey — sendToPeer requires the noise key, not identity key
      const peerRecord = { publicKey: 'child1', noiseKey: 'noise1', displayName: 'Test', pairedAt: 1 }
      const mockDb = makeMockDb({ 'peers:child1': peerRecord })
      const mockSendToPeer = jest.fn()
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer, send: jest.fn() })

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
      const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer, send: jest.fn() })

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
        del: jest.fn(async (k) => { delete stored[k] }),
        // A new pending app now scans for an existing approval before creating a
        // duplicate card, so the mock has to be able to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
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

    test('auto-approve on: new app is allowed, gets an alert but no approval card', async () => {
      const mockDb = makeMockDb({ parentSettings: { autoApproveNewApps: true }, 'peers:childpk1': { noiseKey: 'noise-abc', displayName: 'Kid' } })
      const mockSend = jest.fn()
      const mockSendToPeer = jest.fn()

      await handleIncomingAppInstalled(
        { packageName: 'com.example.app', appName: 'Example App', detectedAt: 1000 },
        'childpk1', mockDb, mockSend, mockSendToPeer
      )

      expect(mockDb._stored['policy:childpk1'].apps['com.example.app']).toMatchObject({ status: 'allowed' })
      // The child still gets the policy so the app shows up as allowed there too.
      expect(mockSendToPeer).toHaveBeenCalledWith('noise-abc', expect.objectContaining({ type: 'policy:update' }))

      const alerts = Object.entries(mockDb._stored).filter(([k]) => k.startsWith('alert:')).map(([, v]) => v)
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toMatchObject({ type: 'app_installed', autoApproved: true })
      const requests = Object.keys(mockDb._stored).filter((k) => k.startsWith('request:'))
      expect(requests).toHaveLength(0)

      const events = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')
      expect(events).toHaveLength(1)
      expect(events[0][0].data).toMatchObject({ packageName: 'com.example.app', autoApproved: true })
    })

    test('auto-approve off (default) still leaves the new app pending', async () => {
      const mockDb = makeMockDb({ parentSettings: { timeRequestMinutes: [5] } })
      await handleIncomingAppInstalled({ packageName: 'com.example.app', appName: 'Example App' }, 'childpk1', mockDb, jest.fn())
      expect(mockDb._stored['policy:childpk1'].apps['com.example.app']).toMatchObject({ status: 'pending' })
      const events = []
      expect(Object.keys(mockDb._stored).filter((k) => k.startsWith('request:'))).toHaveLength(1)
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
        // A new pending app scans for an existing approval before creating a
        // duplicate card, so the mock has to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
        _stored: stored,
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

    test('incremental sync with auto-approve on: new apps are allowed and raise no approval card', async () => {
      const existing = { apps: { 'com.example.old': { status: 'allowed' } }, childPublicKey: 'childpk1', version: 0 }
      const mockDb = makeMockDb({ 'policy:childpk1': existing, parentSettings: { autoApproveNewApps: true }, 'peers:childpk1': { noiseKey: 'noise-abc' } })
      const mockSend = jest.fn()
      const mockSendToPeer = jest.fn()

      await handleIncomingAppsSync(
        { apps: [{ packageName: 'com.example.new', appName: 'New App' }, { packageName: 'com.example.two', appName: 'Two' }] },
        'childpk1', mockDb, mockSend, mockSendToPeer
      )

      const saved = mockDb._stored['policy:childpk1']
      expect(saved.apps['com.example.new']).toMatchObject({ status: 'allowed' })
      expect(saved.apps['com.example.two']).toMatchObject({ status: 'allowed' })
      expect(mockSendToPeer).toHaveBeenCalledWith('noise-abc', expect.objectContaining({ type: 'policy:update' }))

      const alerts = Object.entries(mockDb._stored).filter(([k]) => k.startsWith('alert:')).map(([, v]) => v)
      expect(alerts).toHaveLength(2)
      expect(alerts.every((a) => a.autoApproved === true)).toBe(true)
      expect(Object.keys(mockDb._stored).filter((k) => k.startsWith('request:'))).toHaveLength(0)

      const events = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')
      expect(events).toHaveLength(2)
      expect(events.every(([m]) => m.data.autoApproved === true)).toBe(true)
    })

    test('first sync ignores auto-approve: everything is allowed and nothing is announced', async () => {
      const mockDb = makeMockDb({ parentSettings: { autoApproveNewApps: true } })
      const mockSend = jest.fn()
      await handleIncomingAppsSync({ apps: [{ packageName: 'com.example.a', appName: 'A' }] }, 'childpk1', mockDb, mockSend)
      expect(mockDb._stored['policy:childpk1'].apps['com.example.a']).toMatchObject({ status: 'allowed' })
      expect(Object.keys(mockDb._stored).filter((k) => k.startsWith('alert:'))).toHaveLength(0)
      expect(mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')).toHaveLength(0)
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

  // A newly installed app arrives as 'pending', but before this nothing ever ASKED
  // the parent to decide — the approve/deny lived in the Apps tab, which they had
  // to know to go looking in. Now the install raises the same kind of request a
  // time request raises, so it lands in the Activity inbox with Approve/Deny.
  describe('a new app asks the parent to decide', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        del: jest.fn(async (k) => { delete stored[k] }),
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
        _stored: stored,
      }
    }

    const requestRows = (db) => Object.entries(db._stored)
      .filter(([k]) => k.startsWith('request:'))
      .map(([, v]) => v)

    test('an installed app creates a pending approval request', async () => {
      const db = makeMockDb({ 'peers:childpk1': { displayName: 'Ben' } })
      const send = jest.fn()

      await handleIncomingAppInstalled(
        { packageName: 'com.mojang', appName: 'Minecraft', detectedAt: 1000 },
        'childpk1', db, send,
      )

      const [req] = requestRows(db)
      expect(req).toMatchObject({
        packageName: 'com.mojang',
        appName: 'Minecraft',
        status: 'pending',
        requestType: 'approval',
        origin: 'install',       // the app appeared; the child did not beg for it
        childPublicKey: 'childpk1',
      })
      // Reuses the event the child's own requests fire, so the Activity tab and
      // the pending badge pick it up with no new wiring.
      const events = send.mock.calls.filter(([m]) => m.event === 'time:request:received')
      expect(events).toHaveLength(1)
    })

    // The same undecided app can reach the parent three ways: the install relay,
    // a batch sync, and the child hitting the block screen and asking. That is ONE
    // decision — the parent must not get a stack of identical cards.
    test('the child asking for an app it just installed does not stack a second card', async () => {
      const db = makeMockDb({ 'peers:childpk1': { displayName: 'Ben' } })
      const send = jest.fn()

      await handleIncomingAppInstalled(
        { packageName: 'com.mojang', appName: 'Minecraft', detectedAt: 1000 }, 'childpk1', db, send,
      )
      await handleIncomingTimeRequest(
        { requestId: 'req:2:com.mojang', packageName: 'com.mojang', appName: 'Minecraft', requestedAt: 2000 },
        'childpk1', db, send,
      )

      expect(requestRows(db)).toHaveLength(1)
    })

    test('a redelivered install does not stack a second card either', async () => {
      const db = makeMockDb({ 'peers:childpk1': { displayName: 'Ben' } })
      const send = jest.fn()
      const payload = { packageName: 'com.mojang', appName: 'Minecraft', detectedAt: 1000 }

      await handleIncomingAppInstalled(payload, 'childpk1', db, send)
      await handleIncomingAppInstalled(payload, 'childpk1', db, send)

      expect(requestRows(db)).toHaveLength(1)
    })

    // ...but a request for MORE TIME on an already-allowed app is a genuinely new
    // ask, and must never be swallowed by the dedupe.
    test('an extra-time request is never deduped against an approval', async () => {
      const db = makeMockDb({ 'peers:childpk1': { displayName: 'Ben' } })
      const send = jest.fn()

      await handleIncomingAppInstalled(
        { packageName: 'com.mojang', appName: 'Minecraft', detectedAt: 1000 }, 'childpk1', db, send,
      )
      await handleIncomingTimeRequest(
        {
          requestId: 'req:2:com.mojang', packageName: 'com.mojang', appName: 'Minecraft',
          requestedAt: 2000, requestType: 'extra_time', extraSeconds: 1800,
        },
        'childpk1', db, send,
      )

      const rows = requestRows(db)
      expect(rows).toHaveLength(2)
      expect(rows.some((r) => r.requestType === 'extra_time' && r.extraSeconds === 1800)).toBe(true)
    })

    test('approving from the inbox resolves the install request and pushes the policy', async () => {
      const db = makeMockDb({ 'peers:childpk1': { displayName: 'Ben', noiseKey: 'noise-abc' } })
      const send = jest.fn()
      const sendToPeer = jest.fn()

      await handleIncomingAppInstalled(
        { packageName: 'com.mojang', appName: 'Minecraft', detectedAt: 1000 }, 'childpk1', db, send, sendToPeer,
      )
      const dispatch = createDispatch({ db, send, sendToPeer, getMode: () => 'parent' })
      await dispatch('app:decide', { childPublicKey: 'childpk1', packageName: 'com.mojang', decision: 'approve' })

      expect(requestRows(db)[0].status).toBe('approved')
      expect(db._stored['policy:childpk1'].apps['com.mojang'].status).toBe('allowed')
      expect(sendToPeer).toHaveBeenCalledWith('noise-abc', expect.objectContaining({ type: 'app:decision' }))
    })

    test('a batch sync raises one request per new app, and none at first pairing', async () => {
      const first = makeMockDb({ 'peers:childpk1': { displayName: 'Ben' } })
      await handleIncomingAppsSync(
        { apps: [{ packageName: 'a', appName: 'A' }, { packageName: 'b', appName: 'B' }] },
        'childpk1', first, jest.fn(),
      )
      // First pairing auto-allows everything — there is nothing to decide.
      expect(requestRows(first)).toHaveLength(0)

      const later = makeMockDb({
        'peers:childpk1': { displayName: 'Ben' },
        'policy:childpk1': { apps: { a: { status: 'allowed', appName: 'A' } }, childPublicKey: 'childpk1', version: 1 },
      })
      await handleIncomingAppsSync(
        { apps: [{ packageName: 'a', appName: 'A' }, { packageName: 'b', appName: 'B' }] },
        'childpk1', later, jest.fn(),
      )
      const rows = requestRows(later)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ packageName: 'b', requestType: 'approval', origin: 'install' })
    })
  })

  describe('handleIncomingTimeRequest', () => {
    function makeMockDb (stored = {}) {
      return {
        put: jest.fn(async (k, v) => { stored[k] = v }),
        get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
        // A new pending app scans for an existing approval before creating a
        // duplicate card, so the mock has to stream its own rows.
        createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
          for (const [key, value] of Object.entries(stored)) {
            if (gt !== undefined && !(key > gt)) continue
            if (lt !== undefined && !(key < lt)) continue
            yield { key, value }
          }
        }),
        _stored: stored,
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

    // Regression (#179): the parent used to collapse general_time to 'approval'
    // and drop extraSeconds, so the UI silently approved the app instead of
    // granting the screen time the child asked for.
    test.each([
      ['general_time', 900],
      ['extra_time', 1800],
    ])('preserves requestType=%s and extraSeconds', async (requestType, extraSeconds) => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()

      await handleIncomingTimeRequest(
        { requestId: 'req:1:com.example.app', packageName: 'com.example.app', requestedAt: 1, requestType, extraSeconds },
        'childpk1',
        mockDb,
        mockSend
      )

      const [, saved] = mockDb.put.mock.calls.find(([k]) => k === 'request:req:1:com.example.app')
      expect(saved.requestType).toBe(requestType)
      expect(saved.extraSeconds).toBe(extraSeconds)
    })

    test('unknown requestType still degrades to approval and drops extraSeconds', async () => {
      const mockDb = makeMockDb({})
      const mockSend = jest.fn()

      await handleIncomingTimeRequest(
        { requestId: 'req:2:com.example.app', packageName: 'com.example.app', requestedAt: 2, requestType: 'bogus', extraSeconds: 900 },
        'childpk1',
        mockDb,
        mockSend
      )

      const [, saved] = mockDb.put.mock.calls.find(([k]) => k === 'request:req:2:com.example.app')
      expect(saved.requestType).toBe('approval')
      expect(saved.extraSeconds).toBeUndefined()
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
      return { db, stored, identity, sendToPeer: jest.fn(), send: jest.fn(), peers: new Map() }
    }

    test('rules:export then rules:import:preview produces an installed-scoped diff', async () => {
      const ctx = makeCtx()
      const childA = 'aa'.repeat(32)
      const childB = 'bb'.repeat(32)
      ctx.stored['policy:' + childA] = {
        childPublicKey: childA, version: 1,
        apps: {
          'com.x': { status: 'blocked', appName: 'X', addedAt: 1 }, // installed on B, status differs -> changed
          'com.z': { status: 'blocked', appName: 'Z', addedAt: 1 }, // not installed on B -> skipped
        },
        schedules: [], pinHash: 'A', locked: false, lockMessage: ''
      }
      ctx.stored['policy:' + childB] = {
        childPublicKey: childB, version: 1,
        apps: { 'com.x': { status: 'allowed', appName: 'X', addedAt: 1 } }, // com.x installed on B
        schedules: [], pinHash: 'B', locked: false, lockMessage: ''
      }
      const dispatch = createDispatch(ctx)
      const { json } = await dispatch('rules:export', { childPubKey: childA })
      const preview = await dispatch('rules:import:preview', { jsonString: json, targetChildPubKey: childB })
      expect(preview.sourceChildPubKey).toBe(childA)
      // Import is intersect-scoped to apps installed on the target and never removes apps:
      // com.x is installed on B with a different status -> changed; com.z isn't installed on B -> skipped.
      expect(preview.appsChanged).toEqual([{ packageName: 'com.x', appName: 'X' }])
      expect(preview.appsSkipped).toEqual([{ packageName: 'com.z', appName: 'Z' }])
      expect(preview.appsAdded).toEqual([])
      expect(preview.appsRemoved).toEqual([])
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
        // com.x must be installed on the target for the intersect-scoped import to apply its rule
        apps: { 'com.x': { status: 'allowed', appName: 'X', addedAt: 1 } }, schedules: [],
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

describe('isBlockClearedByFreshInvite (handleHello block-clear guard)', () => {
  function makeMockDb (stored = {}) {
    return {
      get: jest.fn(async (k) => (stored[k] ? { value: stored[k] } : null)),
    }
  }
  const PEER = 'childpk_A'
  const BLOCKED_AT = 1000

  test('clears when a pendingInviteTopic matches THIS connection topic and is newer', async () => {
    const db = makeMockDb({ 'pendingInviteTopic:topicA': { topicHex: 'topicA', createdAt: 2000 } })
    const ok = await isBlockClearedByFreshInvite(db, {
      peerIdentityKeyHex: PEER, incomingTopic: 'topicA', isChildHello: true, blockedAt: BLOCKED_AT,
    })
    expect(ok).toBe(true)
  })

  test('clears when a pendingChild is keyed by THIS peer and is newer', async () => {
    const db = makeMockDb({ ['pendingChild:' + PEER]: { publicKey: PEER, ts: 2000 } })
    const ok = await isBlockClearedByFreshInvite(db, {
      peerIdentityKeyHex: PEER, incomingTopic: null, isChildHello: true, blockedAt: BLOCKED_AT,
    })
    expect(ok).toBe(true)
  })

  // The regression: a blocked child reconnecting with empty info.topics[] must NOT
  // clear its block just because an UNRELATED new-child invite is open (opened for a
  // different child). Previously a "any newer pendingInviteTopic" fallback did exactly
  // that, letting a removed child re-pair itself.
  test('does NOT clear on an unrelated fresh invite (no bound topic, no pendingChild)', async () => {
    const db = makeMockDb({ 'pendingInviteTopic:topicForChildB': { topicHex: 'topicForChildB', createdAt: 5000 } })
    const ok = await isBlockClearedByFreshInvite(db, {
      peerIdentityKeyHex: PEER, incomingTopic: null, isChildHello: true, blockedAt: BLOCKED_AT,
    })
    expect(ok).toBe(false)
  })

  test('does NOT clear when the matching invite topic is OLDER than the block', async () => {
    const db = makeMockDb({ 'pendingInviteTopic:topicA': { topicHex: 'topicA', createdAt: 500 } })
    const ok = await isBlockClearedByFreshInvite(db, {
      peerIdentityKeyHex: PEER, incomingTopic: 'topicA', isChildHello: true, blockedAt: BLOCKED_AT,
    })
    expect(ok).toBe(false)
  })

  test('does NOT clear when the pendingChild belongs to a DIFFERENT peer', async () => {
    const db = makeMockDb({ 'pendingChild:someOtherChild': { publicKey: 'someOtherChild', ts: 9000 } })
    const ok = await isBlockClearedByFreshInvite(db, {
      peerIdentityKeyHex: PEER, incomingTopic: null, isChildHello: true, blockedAt: BLOCKED_AT,
    })
    expect(ok).toBe(false)
  })

  test('does NOT clear when nothing pending exists', async () => {
    const db = makeMockDb({})
    const ok = await isBlockClearedByFreshInvite(db, {
      peerIdentityKeyHex: PEER, incomingTopic: 'topicA', isChildHello: true, blockedAt: BLOCKED_AT,
    })
    expect(ok).toBe(false)
  })
})

describe('groupSessionsByLocalDate (usage:report day bucketing)', () => {
  // Use local-time Date construction so the assertions are timezone-independent:
  // whatever the runner's tz, these two instants are on different local calendar days.
  const jan15late = new Date(2024, 0, 15, 23, 59, 0).getTime()
  const jan16early = new Date(2024, 0, 16, 0, 1, 0).getTime()
  const jan16noon = new Date(2024, 0, 16, 12, 0, 0).getTime()

  // The core fix: two sessions two minutes apart but across local midnight must land
  // on their own days, not both on the flush day. The old code filed both under
  // localDateStr(flushTimestamp).
  test('splits a flush that straddles local midnight by each session startedAt', () => {
    const g = groupSessionsByLocalDate([
      { packageName: 'a', startedAt: jan15late },
      { packageName: 'b', startedAt: jan16early },
    ], jan16early)
    expect([...g.keys()].sort()).toEqual(['2024-01-15', '2024-01-16'])
    expect(g.get('2024-01-15').map((s) => s.packageName)).toEqual(['a'])
    expect(g.get('2024-01-16').map((s) => s.packageName)).toEqual(['b'])
  })

  test('groups multiple same-day sessions into one bucket', () => {
    const g = groupSessionsByLocalDate([
      { packageName: 'a', startedAt: jan16early },
      { packageName: 'b', startedAt: jan16noon },
    ], jan16noon)
    expect([...g.keys()]).toEqual(['2024-01-16'])
    expect(g.get('2024-01-16')).toHaveLength(2)
  })

  test('falls back to the flush timestamp when a session has no startedAt', () => {
    const g = groupSessionsByLocalDate([{ packageName: 'a' }], jan15late)
    expect([...g.keys()]).toEqual(['2024-01-15'])
    expect(g.get('2024-01-15')).toHaveLength(1)
  })

  test('returns an empty map for empty or nullish input', () => {
    expect(groupSessionsByLocalDate([], jan16noon).size).toBe(0)
    expect(groupSessionsByLocalDate(null, jan16noon).size).toBe(0)
    expect(groupSessionsByLocalDate(undefined, jan16noon).size).toBe(0)
  })
})

describe('pruneStaleKeys (cleanup sweep helper)', () => {
  // Mock db with a range-scannable store and a del spy.
  function makeMockDb (stored) {
    return {
      _stored: stored,
      del: jest.fn(async (k) => { delete stored[k] }),
      createReadStream: async function * ({ gt, lt } = {}) {
        for (const [key, value] of Object.entries(stored)) {
          if ((gt == null || key > gt) && (lt == null || key < lt)) yield { key, value }
        }
      },
    }
  }
  const NOW = new Date(2024, 5, 1, 12, 0, 0).getTime()
  const cutoff = NOW - 7 * 24 * 60 * 60 * 1000
  const old = cutoff - 60_000     // just past the window
  const recent = cutoff + 60_000  // just inside the window

  test('deletes only entries older than cutoff, keyed on the given field', async () => {
    const stored = {
      ['screentime:grant:childA:' + old]: { grantedAt: old },
      ['screentime:grant:childA:' + recent]: { grantedAt: recent },
      ['screentime:grant:childB:' + old]: { grantedAt: old },
    }
    const db = makeMockDb(stored)
    const removed = await pruneStaleKeys(db, 'screentime:grant:', 'grantedAt', cutoff)
    expect(removed).toBe(2)
    expect(Object.keys(stored)).toEqual(['screentime:grant:childA:' + recent])
  })

  test('stays within the prefix range (does not touch neighbouring key spaces)', async () => {
    const stored = {
      'pendingChild:aaaa': { ts: old },
      'pendingParent:bbbb': { ts: old }, // different prefix — must be untouched
      'peers:cccc': { pairedAt: old },
    }
    const db = makeMockDb(stored)
    const removed = await pruneStaleKeys(db, 'pendingChild:', 'ts', cutoff)
    expect(removed).toBe(1)
    expect(Object.keys(stored).sort()).toEqual(['peers:cccc', 'pendingParent:bbbb'])
  })

  test('treats a missing timestamp field as 0 (stale) and skips null values', async () => {
    const stored = {
      'pendingChild:noTs': { publicKey: 'x' }, // no ts -> 0 -> pruned
      'pendingChild:nullVal': null,            // null value -> skipped, not a crash
      'pendingChild:fresh': { ts: recent },
    }
    const db = makeMockDb(stored)
    const removed = await pruneStaleKeys(db, 'pendingChild:', 'ts', cutoff)
    expect(removed).toBe(1)
    expect(Object.keys(stored).sort()).toEqual(['pendingChild:fresh', 'pendingChild:nullVal'])
  })
})

describe('apps:sync reconciliation (child prunes uninstalled apps)', () => {
  function makeMockDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => (stored[k] ? { value: stored[k] } : null)),
      _stored: stored,
    }
  }

  function makeCtx (stored) {
    const db = makeMockDb(stored)
    const send = jest.fn()
    const sendToAllParents = jest.fn(async () => {})
    return { ctx: { db, send, sendToAllParents }, db, send, sendToAllParents }
  }

  const policyWith = (statuses) => ({
    apps: Object.fromEntries(Object.entries(statuses).map(([p, s]) => [p, { status: s, appName: p }])),
    version: 1,
  })

  test('prunes a policy app absent from installedAll and relays app:uninstalled', async () => {
    const stored = { policy: policyWith({ 'com.a': 'allowed', 'com.b': 'blocked', 'com.c': 'pending' }) }
    const { ctx, send, sendToAllParents } = makeCtx(stored)
    const dispatch = createDispatch(ctx)

    // com.c has been uninstalled: it is in neither the launcher list nor installedAll.
    const res = await dispatch('apps:sync', {
      apps: [{ packageName: 'com.a', appName: 'A' }, { packageName: 'com.b', appName: 'B' }],
      installedAll: ['com.a', 'com.b'],
    })

    expect(res.removed).toBe(1)
    expect(Object.keys(stored.policy.apps).sort()).toEqual(['com.a', 'com.b'])
    // Native policy refreshed and parent notified so its Apps list drops com.c.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ method: 'native:setPolicy' }))
    expect(sendToAllParents).toHaveBeenCalledWith(expect.objectContaining({ type: 'app:uninstalled', payload: expect.objectContaining({ packageName: 'com.c' }) }))
  })

  test('does NOT prune a blocked app that is still installed but non-launchable', async () => {
    // com.b is blocked and installed but not a launcher app, so it is absent from
    // `apps` (launcher-only) yet present in installedAll — it must be kept.
    const stored = { policy: policyWith({ 'com.a': 'allowed', 'com.b': 'blocked' }) }
    const { ctx, sendToAllParents } = makeCtx(stored)
    const dispatch = createDispatch(ctx)

    const res = await dispatch('apps:sync', {
      apps: [{ packageName: 'com.a', appName: 'A' }],
      installedAll: ['com.a', 'com.b'],
    })

    expect(res.removed).toBe(0)
    expect(Object.keys(stored.policy.apps).sort()).toEqual(['com.a', 'com.b'])
    expect(sendToAllParents).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'app:uninstalled' }))
  })

  test('never prunes when installedAll is missing (fail safe, do not wipe policy)', async () => {
    const stored = { policy: policyWith({ 'com.a': 'allowed', 'com.b': 'blocked' }) }
    const { ctx } = makeCtx(stored)
    const dispatch = createDispatch(ctx)

    const res = await dispatch('apps:sync', { apps: [{ packageName: 'com.a', appName: 'A' }] })

    expect(res.removed).toBe(0)
    expect(Object.keys(stored.policy.apps).sort()).toEqual(['com.a', 'com.b'])
  })

  test('never prunes when installedAll is empty (treated as unknown)', async () => {
    const stored = { policy: policyWith({ 'com.a': 'allowed' }) }
    const { ctx } = makeCtx(stored)
    const dispatch = createDispatch(ctx)

    const res = await dispatch('apps:sync', { apps: [{ packageName: 'com.a', appName: 'A' }], installedAll: [] })

    expect(res.removed).toBe(0)
    expect(Object.keys(stored.policy.apps)).toEqual(['com.a'])
  })

  test('initial sync (empty policy) adds without pruning', async () => {
    const stored = {} // no policy yet
    const { ctx, sendToAllParents } = makeCtx(stored)
    const dispatch = createDispatch(ctx)

    const res = await dispatch('apps:sync', {
      apps: [{ packageName: 'com.a', appName: 'A', isLauncher: true }],
      installedAll: ['com.a'],
    })

    expect(res.removed).toBe(0)
    expect(res.count).toBe(1)
    expect(stored.policy.apps['com.a'].status).toBe('allowed')
    expect(sendToAllParents).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'app:uninstalled' }))
  })
})

describe('time:grantGeneral (proactive parent grant, no request)', () => {
  function makeCtx (stored = {}) {
    const db = {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => (stored[k] ? { value: stored[k] } : null)),
    }
    const send = jest.fn()
    const sendToPeer = jest.fn()
    return { ctx: { db, send, sendToPeer }, stored, send, sendToPeer }
  }

  test('grants without a requestId: stores a grant, pushes to child, emits no request:updated', async () => {
    const { ctx, stored, send, sendToPeer } = makeCtx({ 'peers:childpk': { noiseKey: 'noise1' } })
    const dispatch = createDispatch(ctx)

    const res = await dispatch('time:grantGeneral', { childPublicKey: 'childpk', extraSeconds: 1800 })
    expect(res).toEqual({ ok: true })

    const grantKey = Object.keys(stored).find((k) => k.startsWith('screentime:grant:childpk:'))
    expect(grantKey).toBeDefined()
    const grant = stored[grantKey]
    expect(grant.extraSeconds).toBe(1800)
    expect(grant.source).toBe('parent-approved')
    // A unique synthetic id was minted for child-side idempotency/replay.
    expect(grant.requestId).toMatch(/^grant:childpk:/)

    // Child was pushed the extension using that same id.
    expect(sendToPeer).toHaveBeenCalledWith('noise1', { type: 'time:extendGeneral', payload: { requestId: grant.requestId, extraSeconds: 1800 } })
    // No pending request exists, so no request:updated event fires.
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'request:updated' }))
  })

  test('still flips a real request to approved and emits request:updated when requestId is given', async () => {
    const { ctx, stored, send } = makeCtx({
      'peers:childpk': { noiseKey: 'noise1' },
      'request:req1': { id: 'req1', status: 'pending' },
    })
    const dispatch = createDispatch(ctx)

    await dispatch('time:grantGeneral', { childPublicKey: 'childpk', requestId: 'req1', extraSeconds: 900 })

    expect(stored['request:req1'].status).toBe('approved')
    expect(send).toHaveBeenCalledWith({ type: 'event', event: 'request:updated', data: { requestId: 'req1', status: 'approved' } })
  })

  test('rejects a non-positive or missing duration', async () => {
    const { ctx } = makeCtx()
    const dispatch = createDispatch(ctx)
    await expect(dispatch('time:grantGeneral', { childPublicKey: 'childpk', extraSeconds: 0 })).rejects.toThrow()
    await expect(dispatch('time:grantGeneral', { childPublicKey: 'childpk' })).rejects.toThrow()
    await expect(dispatch('time:grantGeneral', { extraSeconds: 600 })).rejects.toThrow()
  })
})

describe('policy:setPause (free-time / holiday mode)', () => {
  function makeCtx (stored = {}) {
    const db = {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => (stored[k] ? { value: stored[k] } : null)),
    }
    const sendToPeer = jest.fn()
    return { ctx: { db, sendToPeer, send: jest.fn() }, stored, sendToPeer }
  }

  test('sets a future pauseUntil, clears lock, bumps version, pushes to child', async () => {
    const until = Date.now() + 3600_000
    const { ctx, stored, sendToPeer } = makeCtx({
      'peers:childpk': { noiseKey: 'noise1' },
      'policy:childpk': { apps: {}, childPublicKey: 'childpk', version: 4, locked: true, lockMessage: 'nope' },
    })
    const dispatch = createDispatch(ctx)

    const res = await dispatch('policy:setPause', { childPublicKey: 'childpk', pauseUntil: until })
    expect(res).toEqual({ ok: true, pauseUntil: until })

    const p = stored['policy:childpk']
    expect(p.pauseUntil).toBe(until)
    expect(p.locked).toBe(false) // pause and lock are mutually exclusive
    expect(p.lockMessage).toBe('')
    expect(p.version).toBe(5)
    expect(sendToPeer).toHaveBeenCalledWith('noise1', { type: 'policy:update', payload: p })
  })

  test('a non-future pauseUntil clears the pause (resume protection)', async () => {
    const { ctx, stored } = makeCtx({
      'policy:childpk': { apps: {}, childPublicKey: 'childpk', version: 2, pauseUntil: Date.now() + 1000 },
    })
    const dispatch = createDispatch(ctx)

    const res = await dispatch('policy:setPause', { childPublicKey: 'childpk', pauseUntil: 0 })
    expect(res.pauseUntil).toBe(0)
    expect(stored['policy:childpk']).not.toHaveProperty('pauseUntil')
  })

  test('locking a paused child clears the pause', async () => {
    const { ctx, stored } = makeCtx({
      'policy:childpk': { apps: {}, childPublicKey: 'childpk', version: 1, pauseUntil: Date.now() + 3600_000 },
    })
    const dispatch = createDispatch(ctx)

    await dispatch('policy:setLock', { childPublicKey: 'childpk', locked: true, lockMessage: 'bed' })
    expect(stored['policy:childpk'].locked).toBe(true)
    expect(stored['policy:childpk']).not.toHaveProperty('pauseUntil')
  })

  test('rejects a missing childPublicKey', async () => {
    const { ctx } = makeCtx()
    const dispatch = createDispatch(ctx)
    await expect(dispatch('policy:setPause', { pauseUntil: Date.now() + 1000 })).rejects.toThrow()
  })

})

describe('child side honours policy.settings.autoApproveNewApps', () => {
  function makeCtx (stored) {
    const db = {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      createReadStream: jest.fn(async function * () {}),
    }
    return { db, send: jest.fn(), sendToAllParents: jest.fn(), mode: 'child' }
  }

  test('app:installed marks the app allowed when the pushed policy says so', async () => {
    const stored = { policy: { apps: { 'com.example.old': { status: 'allowed' } }, settings: { autoApproveNewApps: true } } }
    const ctx = makeCtx(stored)
    const dispatch = createDispatch(ctx)
    const result = await dispatch('app:installed', { packageName: 'com.example.new', appName: 'New' })
    expect(result).toEqual({ status: 'allowed' })
    expect(stored.policy.apps['com.example.new']).toMatchObject({ status: 'allowed' })
    // The parent still hears about it so its own list stays complete.
    expect(ctx.sendToAllParents).toHaveBeenCalledWith(expect.objectContaining({ type: 'app:installed' }))
  })

  test('app:installed stays pending when the setting is off or absent', async () => {
    const stored = { policy: { apps: { 'com.example.old': { status: 'allowed' } }, settings: { autoApproveNewApps: false } } }
    const dispatch = createDispatch(makeCtx(stored))
    expect(await dispatch('app:installed', { packageName: 'com.example.new', appName: 'New' })).toEqual({ status: 'pending' })
  })

  test('apps:sync after pairing allows new apps when the setting is on', async () => {
    const stored = { policy: { apps: { 'com.example.old': { status: 'allowed' } }, settings: { autoApproveNewApps: true } } }
    const dispatch = createDispatch(makeCtx(stored))
    await dispatch('apps:sync', { apps: [{ packageName: 'com.example.new', appName: 'New' }], installedAll: ['com.example.old', 'com.example.new'] })
    expect(stored.policy.apps['com.example.new']).toMatchObject({ status: 'allowed' })
  })

  test('apps:sync after pairing leaves new apps pending when the setting is off', async () => {
    const stored = { policy: { apps: { 'com.example.old': { status: 'allowed' } } } }
    const dispatch = createDispatch(makeCtx(stored))
    await dispatch('apps:sync', { apps: [{ packageName: 'com.example.new', appName: 'New' }], installedAll: ['com.example.old', 'com.example.new'] })
    expect(stored.policy.apps['com.example.new']).toMatchObject({ status: 'pending' })
  })
})

describe('app icons stay out of policy pushes', () => {
  const ICON = 'iVBORw0KGgo='

  test('stripAppIcons drops iconBase64 from every app and nothing else', () => {
    const policy = {
      childPublicKey: 'c1', version: 3, locked: true,
      apps: { a: { status: 'allowed', iconBase64: ICON, category: 'Games' }, b: { status: 'pending' } },
    }
    const out = stripAppIcons(policy)
    expect(out).not.toBe(policy)
    expect(out.apps.a).toEqual({ status: 'allowed', category: 'Games' })
    expect(out.apps.b).toEqual({ status: 'pending' })
    expect(out).toMatchObject({ childPublicKey: 'c1', version: 3, locked: true })
    // The original is untouched: the parent keeps its icons for the Apps tab.
    expect(policy.apps.a.iconBase64).toBe(ICON)
  })

  test('stripAppIcons returns the same object when there is nothing to strip', () => {
    const policy = { version: 1, apps: { a: { status: 'allowed' } } }
    expect(stripAppIcons(policy)).toBe(policy)
    expect(stripAppIcons(null)).toBe(null)
    expect(stripAppIcons({ version: 1 })).toEqual({ version: 1 })
  })

  test('handlePolicyUpdate stores, hands native and relays the policy without icons', async () => {
    const stored = {}
    const db = {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      createReadStream: jest.fn(async function * () {}),
    }
    const send = jest.fn()
    const sendToAllParents = jest.fn()
    const payload = { childPublicKey: 'c1', version: 5, apps: { a: { status: 'blocked', iconBase64: ICON }, b: { status: 'allowed' } } }

    await handlePolicyUpdate(payload, db, send, sendToAllParents, 'parent1')

    expect(stored.policy.apps.a).toEqual({ status: 'blocked' })
    const native = send.mock.calls.find(([m]) => m.method === 'native:setPolicy')[0]
    expect(native.args.json).not.toContain(ICON)
    expect(JSON.parse(native.args.json).apps.a).toEqual({ status: 'blocked' })
    const relayed = sendToAllParents.mock.calls[0][0]
    expect(relayed.type).toBe('policy:update')
    expect(relayed.payload.apps.a).toEqual({ status: 'blocked' })
    expect(relayed.payload.apps.b).toEqual({ status: 'allowed' })
  })

  test('child app:installed relays the icon to parents but keeps it out of its own policy', async () => {
    const stored = { policy: { apps: { old: { status: 'allowed' } } } }
    const db = {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      createReadStream: jest.fn(async function * () {}),
    }
    const ctx = { db, send: jest.fn(), sendToAllParents: jest.fn(), mode: 'child' }
    await createDispatch(ctx)('app:installed', { packageName: 'com.new', appName: 'New', iconBase64: ICON, category: 'Games' })

    expect(stored.policy.apps['com.new']).toEqual(expect.objectContaining({ status: 'pending', appName: 'New', category: 'Games' }))
    expect(stored.policy.apps['com.new'].iconBase64).toBeUndefined()
    const native = ctx.send.mock.calls.find(([m]) => m.method === 'native:setPolicy')[0]
    expect(native.args.json).not.toContain(ICON)
    expect(ctx.sendToAllParents).toHaveBeenCalledWith(expect.objectContaining({
      type: 'app:installed', payload: expect.objectContaining({ packageName: 'com.new', iconBase64: ICON }),
    }))
  })
})

describe('relayed policies cannot roll a parent back', () => {
  function makeDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      _stored: stored,
    }
  }

  test('queueMessage refuses to queue a policy:update relay', async () => {
    const db = makeDb({})
    await queueMessage({ type: 'policy:update', payload: { version: 4, apps: {} } }, db)
    expect(db.put).not.toHaveBeenCalled()
    await queueMessage({ type: 'app:installed', payload: { packageName: 'a' } }, db)
    expect(db._stored.pendingMessages.map((e) => e.message.type)).toEqual(['app:installed'])
  })

  test('flushMessageQueue drops policy:update relays queued by older code and keeps the rest', async () => {
    const db = makeDb({ pendingMessages: [
      { message: { type: 'policy:update', payload: { version: 5 } } },
      { message: { type: 'app:installed', payload: { packageName: 'a' } } },
      { message: { type: 'policy:update', payload: { version: 6 } } },
      { message: { type: 'usage:report', payload: {} } },
    ] })
    const written = []
    const count = await flushMessageQueue(db, async (m) => { written.push(m.type) })
    expect(written).toEqual(['app:installed', 'usage:report'])
    expect(count).toBe(2)
    expect(db._stored.pendingMessages).toEqual([])
  })

  test('shouldAcceptRelayedPolicy takes only a strictly newer version', () => {
    expect(shouldAcceptRelayedPolicy({ version: 9 }, { version: 10 })).toBe(true)
    // The parent hearing its own push back, or a child that is behind at reconnect.
    expect(shouldAcceptRelayedPolicy({ version: 9 }, { version: 9 })).toBe(false)
    expect(shouldAcceptRelayedPolicy({ version: 9 }, { version: 5 })).toBe(false)
    // Nothing stored yet: a re-paired parent takes whatever the child holds.
    expect(shouldAcceptRelayedPolicy(null, { version: 3 })).toBe(true)
    expect(shouldAcceptRelayedPolicy({ apps: {} }, { version: 1 })).toBe(true)
    // Unversioned payloads never replace a copy.
    expect(shouldAcceptRelayedPolicy({ version: 2 }, { apps: {} })).toBe(false)
    expect(shouldAcceptRelayedPolicy({ version: 2 }, null)).toBe(false)
  })
})

describe('parent-side policy writes are serialized per child', () => {
  // A db whose reads yield to the event loop, so two handlers that both read
  // before either writes really do interleave the way Hyperbee lets them.
  function makeSlowDb (stored = {}) {
    const tick = () => new Promise((r) => setTimeout(r, 1))
    return {
      put: jest.fn(async (k, v) => { await tick(); stored[k] = v }),
      // Decoded copies, as Hyperbee returns: two readers must not share one object.
      get: jest.fn(async (k) => { await tick(); return stored[k] !== undefined ? { value: JSON.parse(JSON.stringify(stored[k])) } : null }),
      del: jest.fn(async (k) => { delete stored[k] }),
      createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
        for (const [key, value] of Object.entries(stored)) {
          if (gt !== undefined && !(key > gt)) continue
          if (lt !== undefined && !(key < lt)) continue
          yield { key, value: JSON.parse(JSON.stringify(value)) }
        }
      }),
      _stored: stored,
    }
  }
  const alerts = (db) => Object.keys(db._stored).filter((k) => k.startsWith('alert:'))
  const requests = (db) => Object.keys(db._stored).filter((k) => k.startsWith('request:'))

  test('withPolicyLock runs callers for one child in order and different children in parallel', async () => {
    const order = []
    const slow = (tag, ms) => async () => { order.push(tag + ':start'); await new Promise((r) => setTimeout(r, ms)); order.push(tag + ':end'); return tag }
    const results = await Promise.all([
      withPolicyLock('kid', slow('a', 15)),
      withPolicyLock('kid', slow('b', 1)),
      withPolicyLock('other', slow('c', 1)),
    ])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(order.indexOf('b:start')).toBeGreaterThan(order.indexOf('a:end'))
    expect(order.indexOf('c:end')).toBeLessThan(order.indexOf('a:end'))
  })

  test('withPolicyLock keeps serving after a caller throws', async () => {
    await expect(withPolicyLock('kid', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withPolicyLock('kid', async () => 'ok')).resolves.toBe('ok')
  })

  test('two install relays for different packages both survive', async () => {
    const db = makeSlowDb({ 'policy:kid': { apps: { 'com.old': { status: 'allowed' } }, childPublicKey: 'kid', version: 3 } })
    await Promise.all([
      handleIncomingAppInstalled({ packageName: 'com.a', appName: 'A' }, 'kid', db, jest.fn()),
      handleIncomingAppInstalled({ packageName: 'com.b', appName: 'B' }, 'kid', db, jest.fn()),
    ])
    const apps = db._stored['policy:kid'].apps
    expect(Object.keys(apps).sort()).toEqual(['com.a', 'com.b', 'com.old'])
    expect(db._stored['policy:kid'].version).toBe(5)
  })

  test('an install relay and a batch sync for the same package yield one alert and one approval card', async () => {
    const db = makeSlowDb({ 'policy:kid': { apps: { 'com.old': { status: 'allowed' } }, childPublicKey: 'kid', version: 3 } })
    await Promise.all([
      handleIncomingAppInstalled({ packageName: 'com.new', appName: 'New' }, 'kid', db, jest.fn()),
      handleIncomingAppsSync({ apps: [{ packageName: 'com.new', appName: 'New' }, { packageName: 'com.old', appName: 'Old' }] }, 'kid', db, jest.fn()),
    ])
    expect(Object.keys(db._stored['policy:kid'].apps).sort()).toEqual(['com.new', 'com.old'])
    expect(alerts(db)).toHaveLength(1)
    expect(requests(db)).toHaveLength(1)
  })

  test('settings:save racing an install relay keeps both the settings and the app', async () => {
    const db = makeSlowDb({ 'policy:kid': { apps: { 'com.old': { status: 'allowed' } }, childPublicKey: 'kid', version: 3 } })
    const ctx = { db, send: jest.fn(), sendToPeer: jest.fn(), mode: 'parent' }
    const dispatch = createDispatch(ctx)
    await Promise.all([
      dispatch('settings:save', { settings: { timeRequestMinutes: [5], warningMinutes: [1], autoApproveNewApps: true } }),
      handleIncomingAppInstalled({ packageName: 'com.new', appName: 'New' }, 'kid', db, jest.fn()),
    ])
    const saved = db._stored['policy:kid']
    expect(saved.apps['com.new']).toBeDefined()
    expect(saved.settings).toEqual({ timeRequestMinutes: [5], warningMinutes: [1], autoApproveNewApps: true })
    expect(saved.version).toBe(5)
  })

  test('a lock decision racing a policy edit from the UI loses neither', async () => {
    const db = makeSlowDb({ 'policy:kid': { apps: { 'com.old': { status: 'allowed' } }, childPublicKey: 'kid', version: 3 }, 'peers:kid': { noiseKey: 'n' } })
    const ctx = { db, send: jest.fn(), sendToPeer: jest.fn(), mode: 'parent' }
    const dispatch = createDispatch(ctx)
    await Promise.all([
      dispatch('policy:setLock', { childPublicKey: 'kid', locked: true, lockMessage: 'Dinner' }),
      dispatch('app:decide', { childPublicKey: 'kid', packageName: 'com.old', decision: 'deny' }),
    ])
    const saved = db._stored['policy:kid']
    expect(saved.locked).toBe(true)
    expect(saved.apps['com.old'].status).toBe('blocked')
    expect(saved.version).toBe(5)
  })
})

describe('a stale push gets the child\'s current policy back', () => {
  function makeDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      createReadStream: jest.fn(async function * () {}),
      _stored: stored,
    }
  }

  test('older version: nothing stored, current copy sent to the sender without icons', async () => {
    const current = { childPublicKey: 'c1', version: 9, apps: { a: { status: 'allowed', iconBase64: 'AAAA' } }, settings: { autoApproveNewApps: true } }
    const db = makeDb({ policy: current })
    const send = jest.fn()
    const reply = jest.fn()
    await handlePolicyUpdate({ childPublicKey: 'c1', version: 7, apps: { a: { status: 'blocked' } } }, db, send, jest.fn(), 'parent1', reply)
    expect(db.put).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(reply).toHaveBeenCalledTimes(1)
    const [to, msg] = reply.mock.calls[0]
    expect(to).toBe('parent1')
    expect(msg.type).toBe('policy:update')
    expect(msg.payload.version).toBe(9)
    expect(msg.payload.apps.a).toEqual({ status: 'allowed' })
    expect(msg.payload.settings).toEqual({ autoApproveNewApps: true })
    // and the parent side takes it, since it is strictly newer than what it pushed
    expect(shouldAcceptRelayedPolicy({ version: 7 }, msg.payload)).toBe(true)
  })

  test('a reply failure is swallowed and the stale push still ignored', async () => {
    const db = makeDb({ policy: { childPublicKey: 'c1', version: 9, apps: {} } })
    const reply = jest.fn(() => { throw new Error('peer not connected') })
    await expect(handlePolicyUpdate({ childPublicKey: 'c1', version: 2, apps: {} }, db, jest.fn(), jest.fn(), 'parent1', reply)).resolves.toBeUndefined()
    expect(db.put).not.toHaveBeenCalled()
  })

  test('equal or newer versions are stored as before and send nothing back', async () => {
    const db = makeDb({ policy: { childPublicKey: 'c1', version: 9, apps: {} } })
    const reply = jest.fn()
    await handlePolicyUpdate({ childPublicKey: 'c1', version: 9, apps: { b: { status: 'blocked' } } }, db, jest.fn(), jest.fn(), 'parent1', reply)
    await handlePolicyUpdate({ childPublicKey: 'c1', version: 10, apps: { b: { status: 'allowed' } } }, db, jest.fn(), jest.fn(), 'parent1', reply)
    expect(reply).not.toHaveBeenCalled()
    expect(db._stored.policy.version).toBe(10)
  })

  test('callers without a reply function behave exactly as before', async () => {
    const db = makeDb({ policy: { childPublicKey: 'c1', version: 9, apps: {} } })
    await expect(handlePolicyUpdate({ childPublicKey: 'c1', version: 1, apps: {} }, db, jest.fn(), jest.fn(), 'parent1')).resolves.toBeUndefined()
    expect(db.put).not.toHaveBeenCalled()
  })
})

describe('a grant approved while the child is offline survives until delivery', () => {
  const HOUR = 60 * 60 * 1000
  function makeDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: JSON.parse(JSON.stringify(stored[k])) } : null),
      del: jest.fn(async (k) => { delete stored[k] }),
      createReadStream: jest.fn(async function * ({ gt, lt } = {}) {
        for (const [key, value] of Object.entries(stored)) {
          if (gt !== undefined && !(key > gt)) continue
          if (lt !== undefined && !(key < lt)) continue
          yield { key, value: JSON.parse(JSON.stringify(value)) }
        }
      }),
      _stored: stored,
    }
  }
  const overrideRow = (db) => Object.entries(db._stored).find(([k]) => k.startsWith('override:'))[1]
  const pendingGrant = (extra = {}) => ({
    packageName: 'com.game', appName: 'Game', childPublicKey: 'kid', source: 'parent-approved',
    expiresAt: null, awaitingDelivery: true, requestId: 'r1', extraSeconds: 900, ...extra,
  })

  test('offline approval stores the grant with no expiry and marks it awaiting delivery', async () => {
    const db = makeDb({ 'request:r1': { id: 'r1', appName: 'Game', status: 'pending' }, 'peers:kid': { noiseKey: 'noise1' } })
    const sendToPeer = jest.fn(() => { throw new Error('peer not connected: kid') })
    const ctx = { db, send: jest.fn(), sendToPeer, mode: 'parent' }
    await createDispatch(ctx)('time:grant', { childPublicKey: 'kid', requestId: 'r1', packageName: 'com.game', extraSeconds: 900 })
    const row = overrideRow(db)
    expect(row).toMatchObject({ awaitingDelivery: true, expiresAt: null, extraSeconds: 900, requestId: 'r1', packageName: 'com.game' })
    expect(row.deliveredAt).toBeUndefined()
    expect(row.sentAt).toBeUndefined()
  })

  test('a write that appears to succeed is still not treated as delivery', async () => {
    // Writing to a peer that has just gone away does not throw (harness 12), so
    // the record waits for the child\'s own confirmation either way.
    const db = makeDb({ 'request:r1': { id: 'r1', appName: 'Game', status: 'pending' }, 'peers:kid': { noiseKey: 'noise1' } })
    const ctx = { db, send: jest.fn(), sendToPeer: jest.fn(), mode: 'parent' }
    await createDispatch(ctx)('time:grant', { childPublicKey: 'kid', requestId: 'r1', packageName: 'com.game', extraSeconds: 900 })
    const row = overrideRow(db)
    expect(row).toMatchObject({ awaitingDelivery: true, expiresAt: null, sentAt: row.grantedAt })
    expect(row.deliveredAt).toBeUndefined()
    expect(ctx.sendToPeer).toHaveBeenCalledWith('noise1', { type: 'time:extend', payload: { requestId: 'r1', packageName: 'com.game', extraSeconds: 900 } })
  })

  test('the child reconnecting hours later still gets the full grant', async () => {
    const grantedAt = Date.now() - 5 * HOUR
    const db = makeDb({ ['override:kid:' + grantedAt]: pendingGrant({ grantedAt }) })
    const sendToPeer = jest.fn()
    expect(await replayActiveGrants(db, 'kid', sendToPeer, 'noise1', Date.now())).toBe(1)
    expect(sendToPeer).toHaveBeenCalledWith('noise1', { type: 'time:extend', payload: { requestId: 'r1', packageName: 'com.game', extraSeconds: 900 } })
    // Still unsettled: only the child\'s confirmation clears it.
    expect(overrideRow(db)).toMatchObject({ awaitingDelivery: true, expiresAt: null })
  })

  test("the child's confirmation starts the parent's countdown", async () => {
    const grantedAt = Date.now() - 5 * HOUR
    const db = makeDb({ ['override:kid:' + grantedAt]: pendingGrant({ grantedAt }), 'request:r1': { id: 'r1', status: 'approved', appName: 'Game' } })
    const now = Date.now()
    expect(await settleDeliveredGrant(db, 'kid', 'r1', now)).toBe(true)
    expect(overrideRow(db)).toMatchObject({ awaitingDelivery: false, deliveredAt: now, expiresAt: now + 900000 })
    // Settling twice is a no-op, so a re-confirmation cannot extend the window.
    expect(await settleDeliveredGrant(db, 'kid', 'r1', now + 60000)).toBe(false)
    expect(overrideRow(db).expiresAt).toBe(now + 900000)
  })

  test('request:resolved from the child settles the grant even though the request is already approved', async () => {
    const grantedAt = Date.now() - HOUR
    const db = makeDb({ ['override:kid:' + grantedAt]: pendingGrant({ grantedAt }), 'request:r1': { id: 'r1', status: 'approved', appName: 'Game' } })
    await handleRequestResolved({ requestId: 'r1', status: 'approved', packageName: 'com.game', appName: 'Game', resolvedAt: Date.now() }, db, jest.fn(), 'kid')
    const row = overrideRow(db)
    expect(row.awaitingDelivery).toBe(false)
    expect(row.expiresAt).toBeGreaterThan(Date.now())
  })

  test('a denial does not settle anything', async () => {
    const grantedAt = Date.now() - HOUR
    const db = makeDb({ ['override:kid:' + grantedAt]: pendingGrant({ grantedAt }) })
    await handleRequestResolved({ requestId: 'r1', status: 'denied', packageName: 'com.game', resolvedAt: Date.now() }, db, jest.fn(), 'kid')
    expect(overrideRow(db)).toMatchObject({ awaitingDelivery: true, expiresAt: null })
  })

  test('an undelivered grant older than a day is dropped, not sprung on the child', async () => {
    const grantedAt = Date.now() - 30 * HOUR
    const db = makeDb({ ['override:kid:' + grantedAt]: pendingGrant({ grantedAt }) })
    const sendToPeer = jest.fn()
    expect(await replayActiveGrants(db, 'kid', sendToPeer, 'noise1', Date.now())).toBe(0)
    expect(sendToPeer).not.toHaveBeenCalled()
    // Flag cleared so the Apps tab stops promising time that is never coming.
    expect(overrideRow(db)).toMatchObject({ awaitingDelivery: false, expiresAt: grantedAt })
  })

  test('a delivered grant keeps the old rules: re-sent while live, dropped once expired', async () => {
    const now = Date.now()
    const live = now - 60000
    const dead = now - 2 * HOUR
    const db = makeDb({
      ['override:kid:' + live]: { packageName: 'com.live', childPublicKey: 'kid', grantedAt: live, deliveredAt: live, expiresAt: now + 300000, requestId: 'r-live', extraSeconds: 900 },
      ['override:kid:' + dead]: { packageName: 'com.dead', childPublicKey: 'kid', grantedAt: dead, deliveredAt: dead, expiresAt: dead + 900000, requestId: 'r-dead', extraSeconds: 900 },
    })
    const sendToPeer = jest.fn()
    expect(await replayActiveGrants(db, 'kid', sendToPeer, 'noise1', now)).toBe(1)
    expect(sendToPeer.mock.calls[0][1].payload.packageName).toBe('com.live')
    expect(db._stored['override:kid:' + live].expiresAt).toBe(now + 300000)
  })

  test('a legacy record with neither field keeps the old expiry rule', async () => {
    const grantedAt = Date.now() - 5 * HOUR
    const db = makeDb({ ['override:kid:' + grantedAt]: { packageName: 'com.game', childPublicKey: 'kid', grantedAt, expiresAt: grantedAt + 900000, requestId: 'r1', extraSeconds: 900 } })
    const sendToPeer = jest.fn()
    expect(await replayActiveGrants(db, 'kid', sendToPeer, 'noise1', Date.now())).toBe(0)
    expect(sendToPeer).not.toHaveBeenCalled()
  })

  test('a failed replay leaves the grant awaiting delivery for the next reconnect', async () => {
    const grantedAt = Date.now() - HOUR
    const db = makeDb({ ['override:kid:' + grantedAt]: pendingGrant({ grantedAt }) })
    const sendToPeer = jest.fn(() => { throw new Error('peer not connected') })
    expect(await replayActiveGrants(db, 'kid', sendToPeer, 'noise1', Date.now())).toBe(0)
    expect(overrideRow(db)).toMatchObject({ awaitingDelivery: true, expiresAt: null })
  })

  test('a child re-confirms a grant it has already applied, so a lost confirmation settles later', async () => {
    const expiresAt = Date.now() + 500000
    const stored = { 'req:r1': { id: 'r1', packageName: 'com.game', appName: 'Game', status: 'approved', expiresAt } }
    const db = makeDb(stored)
    const send = jest.fn()
    const sendToAllParents = jest.fn()
    await handleTimeExtend({ requestId: 'req:r1', packageName: 'com.game', extraSeconds: 900 }, db, send, sendToAllParents)
    // Not applied a second time...
    expect(send).not.toHaveBeenCalled()
    expect(db.put).not.toHaveBeenCalled()
    // ...but confirmed again so the parent can settle its record.
    expect(sendToAllParents).toHaveBeenCalledWith(expect.objectContaining({
      type: 'request:resolved',
      payload: expect.objectContaining({ requestId: 'req:r1', status: 'approved', packageName: 'com.game' }),
    }))
  })

  test('overrides:list shows a pending grant instead of hiding it, and still hides expired ones', async () => {
    const now = Date.now()
    const db = makeDb({
      'override:kid:1': pendingGrant({ grantedAt: now - HOUR, packageName: 'com.pending', appName: 'Pending' }),
      'override:kid:2': { packageName: 'com.live', childPublicKey: 'kid', grantedAt: now, expiresAt: now + 300000, deliveredAt: now, appName: 'Live' },
      'override:kid:3': { packageName: 'com.gone', childPublicKey: 'kid', grantedAt: now - 2 * HOUR, expiresAt: now - HOUR, deliveredAt: now - 2 * HOUR, appName: 'Gone' },
    })
    const { overrides } = await createDispatch({ db, send: jest.fn(), mode: 'parent' })('overrides:list', { childPublicKey: 'kid' })
    expect(overrides.map((o) => o.packageName)).toEqual(['com.pending', 'com.live'])
    expect(overrides[0].awaitingDelivery).toBe(true)
  })
})
