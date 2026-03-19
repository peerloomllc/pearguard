// src/bare-dispatch.js
//
// Pure method dispatch table for the Bare worklet.
// Separated from IPC wiring so it can be unit tested in Node/jest.
// src/bare.js imports this and wires it to BareKit.IPC.

/**
 * Create a dispatch function bound to the given context (db, swarm, etc.)
 * @param {object} ctx — { db, identity, swarm, peers }
 * @returns {(method: string, args: any[]) => Promise<any>}
 */
function createDispatch (ctx) {
  return async function dispatch (method, args) {
    switch (method) {
      case 'ping':
        return 'pong'

      case 'setMode': {
        const newMode = args[0]
        if (newMode !== 'parent' && newMode !== 'child') {
          throw new Error('invalid mode: must be "parent" or "child"')
        }
        await ctx.db.put('mode', newMode)
        ctx.mode = newMode
        return newMode
      }

      case 'getMode': {
        const stored = await ctx.db.get('mode')
        return stored ? stored.value : null
      }

      case 'connectToPeer': {
        // args[0]: swarmTopic (hex string)
        const topic = args[0]
        if (!topic || typeof topic !== 'string' || !/^[0-9a-f]{64}$/i.test(topic)) {
          throw new Error('invalid swarmTopic')
        }
        await ctx.joinTopic(topic)
        return { joined: true, topic }
      }

      case 'sendPeerMessage': {
        // args[0]: remoteKeyHex, args[1]: { type, payload }
        ctx.sendToPeer(args[0], args[1])
        return { sent: true }
      }

      case 'generateInvite': {
        // Generate a random 32-byte swarm topic
        const topicBuf = Buffer.allocUnsafe(32)
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          crypto.getRandomValues(topicBuf)
        } else {
          require('sodium-native').randombytes_buf(topicBuf)
        }
        const topicHex = topicBuf.toString('hex')
        const parentPublicKey = Buffer.from(ctx.identity.publicKey).toString('hex')

        // Join the swarm topic (parent listens for child connections)
        await ctx.joinTopic(topicHex)

        // Build and return the invite link
        const { buildInviteLink } = require('./invite')
        const inviteLink = buildInviteLink({ parentPublicKey, swarmTopic: topicHex })

        return { inviteLink, swarmTopic: topicHex, parentPublicKey }
      }

      case 'acceptInvite': {
        // args[0]: full pearguard://join/... URL
        const { parseInviteLink } = require('./invite')
        const parsed = parseInviteLink(args[0])
        if (!parsed.ok) throw new Error('invalid invite: ' + parsed.error)

        const { parentPublicKey, swarmTopic } = parsed

        // Store the parent's public key as a "pending" entry — will be confirmed on hello
        await ctx.db.put('pendingParent', { publicKey: parentPublicKey, ts: Date.now() })

        // Join the swarm topic (child connects to parent)
        await ctx.joinTopic(swarmTopic)

        return { ok: true, swarmTopic, parentPublicKey }
      }

      case 'policy:getCurrent': {
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : null
        return { policy }
      }

      case 'pin:set': {
        const { pin } = args
        if (!pin || typeof pin !== 'string') throw new Error('invalid pin')

        // Hash the PIN using pwhash (slow by design — runs in worker context)
        const hash = Buffer.alloc(ctx.sodium.crypto_pwhash_STRBYTES)
        ctx.sodium.crypto_pwhash_str(
          hash,
          Buffer.from(pin),
          ctx.sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
          ctx.sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE
        )

        // Read current policy (or start with empty object)
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : {}

        // Update pinHash in the policy
        policy.pinHash = hash.toString()  // store as string
        await ctx.db.put('policy', policy)

        return { ok: true }
      }

      case 'pin:verify': {
        const { pin, packageName } = args
        const raw = await ctx.db.get('policy')
        if (!raw) { return { granted: false, reason: 'no-policy' } }
        const policy = raw.value  // Hyperbee uses valueEncoding:'json' so raw.value is already parsed
        if (!policy.pinHash) { return { granted: false, reason: 'no-pin' } }

        // crypto_pwhash_str_verify: compares plaintext against stored hash
        // This is deliberately slow (~100-500ms) — runs in bare worklet (worker context), not main thread
        const pinBuffer = Buffer.from(pin)
        const hashBuffer = Buffer.from(policy.pinHash)
        const verified = ctx.sodium.crypto_pwhash_str_verify(hashBuffer, pinBuffer)

        if (!verified) {
          ctx.send({ type: 'event', event: 'override:denied', data: { packageName, reason: 'wrong-pin' } })
          return { granted: false, reason: 'wrong-pin' }
        }

        const now = Date.now()
        const expiresAt = now + (policy.overrideDurationSeconds || 3600) * 1000
        const grant = { packageName, grantedAt: now, expiresAt }

        // Store grant to Hyperbee for audit log
        await ctx.db.put('override:' + packageName + ':' + now, grant)

        // Log to usage report
        await appendPinUseLog({ packageName, grantedAt: now, expiresAt }, ctx.db)

        // Notify native to allow app temporarily
        ctx.send({ method: 'native:grantOverride', args: grant })

        ctx.send({ type: 'event', event: 'override:granted', data: grant })
        return { granted: true, expiresAt }
      }

      case 'time:request': {
        const { packageName } = args
        const requestId = 'req:' + Date.now() + ':' + packageName
        const request = {
          id: requestId,
          packageName,
          requestedAt: Date.now(),
          status: 'pending',
        }

        await ctx.db.put(requestId, request)

        // Notify parent (emit event to RN for relay)
        ctx.send({ type: 'event', event: 'time:request:sent', data: { packageName, requestId, requestedAt: request.requestedAt } })

        // Notify WebView that request was submitted
        ctx.send({ type: 'event', event: 'request:submitted', data: request })

        return { requestId, status: 'pending' }
      }

      case 'requests:list': {
        // Scan Hyperbee for all keys matching 'req:*'
        const requests = []
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
          requests.push(value)
        }
        // Sort by requestedAt descending
        requests.sort((a, b) => b.requestedAt - a.requestedAt)
        return { requests }
      }

      case 'app:installed': {
        const { packageName } = args

        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : { apps: {} }
        if (!policy.apps) policy.apps = {}

        // Mark as pending if not already in policy
        if (!policy.apps[packageName]) {
          policy.apps[packageName] = { status: 'pending' }
          await ctx.db.put('policy', policy)

          // Notify native enforcement of updated policy
          ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })

          // Notify parent
          ctx.send({ type: 'event', event: 'app:installed', data: { packageName, detectedAt: Date.now() } })

          // Notify WebView
          ctx.send({ type: 'event', event: 'policy:updated', data: policy })
        }

        return { status: policy.apps[packageName].status }
      }

      case 'heartbeat:send': {
        const identityRaw = await ctx.db.get('identity')
        const childPublicKey = identityRaw ? identityRaw.value.publicKey : null

        const heartbeat = {
          type: 'heartbeat',
          payload: {
            childPublicKey,
            isOnline: true,
            // TODO: enforcementActive should come from native:getEnforcementState via RN.
            // Since we lack a synchronous callRN helper, default to null (unknown) for now.
            enforcementActive: null,
            timestamp: Date.now(),
          },
        }

        ctx.send({ type: 'event', event: 'heartbeat:send', data: heartbeat })
        return heartbeat.payload
      }

      case 'bypass:detected': {
        const { reason } = args
        const entry = { reason, detectedAt: Date.now() }

        await ctx.db.put('bypass:' + entry.detectedAt, entry)

        ctx.send({ type: 'event', event: 'alert:bypass', data: { reason, detectedAt: entry.detectedAt } })
        ctx.send({ type: 'event', event: 'enforcement:offline', data: { reason } })

        return { logged: true }
      }

      case 'usage:flush': {
        // Build usage report from PIN log and identity
        const pinLog = await getPinUseLog(ctx.db)
        const identityRaw = await ctx.db.get('identity')
        const childPublicKey = identityRaw ? identityRaw.value.publicKey : null

        // TODO: nativeStats would be fetched via a request/response IPC call to native
        // (native:getUsageStats). For now, use empty stats.
        // This will be properly implemented in a future task.

        const report = {
          type: 'usage:report',
          timestamp: Date.now(),
          usageStats: {},  // TODO: populate when native:getUsageStats is implemented
          pinOverrides: pinLog,
          childPublicKey,
        }

        // Persist report to Hyperbee
        await ctx.db.put('usage:' + report.timestamp, report)

        // Emit event to RN which can relay to parent (sendToParent not yet implemented — see Task 13)
        ctx.send({ type: 'event', event: 'usage:report', data: report })

        // Clear PIN log for next reporting period
        await ctx.db.put('pinLog', [])

        return { flushed: true, timestamp: report.timestamp }
      }

      default:
        throw new Error('unknown method: ' + method)
    }
  }
}

/**
 * Handle a verified `app:decision` P2P message from a parent peer.
 * Extracted for testability — called from bare.js handlePeerMessage.
 *
 * @param {object} payload — { packageName, decision }
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare→RN IPC send function
 */
async function handleAppDecision (payload, db, send) {
  const { packageName, decision } = payload
  if (!packageName || !['allowed', 'blocked'].includes(decision)) {
    console.warn('[bare] app:decision: malformed payload')
    return
  }

  const raw = await db.get('policy')
  if (!raw) return
  const policy = raw.value

  if (!policy.apps) policy.apps = {}
  policy.apps[packageName] = { ...(policy.apps[packageName] || {}), status: decision }

  await db.put('policy', policy)
  send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })
  send({ type: 'event', event: 'policy:updated', data: policy })
}

/**
 * Handle a verified `policy:update` P2P message from a parent peer.
 * Extracted for testability — called from bare.js handlePeerMessage.
 *
 * @param {object} payload — the policy object from msg.payload
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare→RN IPC send function
 */
async function handlePolicyUpdate (payload, db, send) {
  if (typeof payload.version !== 'number' || !payload.childPublicKey) {
    console.warn('[bare] policy:update ignored: invalid payload (missing version or childPublicKey)')
    return
  }
  await db.put('policy', payload)
  // Use method format (not event) so the RN shell routes this to
  // NativeModules.UsageStatsModule.setPolicy() via the msg.method === 'native:setPolicy' branch
  // in the bare IPC data handler (app/index.tsx ~line 162).
  // Sending as a type:'event' would only forward it to the WebView, never to the native module.
  send({ method: 'native:setPolicy', args: { json: JSON.stringify(payload) } })
  send({ type: 'event', event: 'policy:updated', data: payload })
}

/**
 * Handle a verified `time:extend` P2P message from a parent peer.
 * Extracted for testability — called from bare.js handlePeerMessage.
 *
 * @param {object} payload — { requestId, packageName, extraSeconds }
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare→RN IPC send function
 */
async function handleTimeExtend (payload, db, send) {
  const { requestId, packageName, extraSeconds } = payload
  if (!requestId || !packageName || typeof extraSeconds !== 'number') {
    console.warn('[bare] time:extend: malformed payload, dropping')
    return
  }

  const expiresAt = Date.now() + extraSeconds * 1000
  const grant = { packageName, grantedAt: Date.now(), expiresAt, source: 'parent-approved' }

  // Update request status in Hyperbee
  const existing = await db.get(requestId)
  if (existing) {
    const req = existing.value
    req.status = 'approved'
    req.expiresAt = expiresAt
    await db.put(requestId, req)
  }

  // Notify native to grant override
  send({ method: 'native:grantOverride', args: grant })

  // Notify WebView
  send({ type: 'event', event: 'override:granted', data: grant })
  send({ type: 'event', event: 'request:updated', data: { requestId, status: 'approved', expiresAt } })
}

/**
 * Append an entry to the `pinLog` array in Hyperbee.
 * Creates the log if it doesn't exist yet.
 *
 * @param {object} entry — { packageName, grantedAt, expiresAt }
 * @param {object} db — Hyperbee instance
 */
async function appendPinUseLog (entry, db) {
  const raw = await db.get('pinLog')
  const log = raw ? raw.value : []  // Hyperbee json encoding returns parsed value
  log.push(entry)
  await db.put('pinLog', log)
}

/**
 * Retrieve the PIN usage log from Hyperbee.
 * Returns an empty array if no log exists yet.
 *
 * @param {object} db — Hyperbee instance
 * @returns {Promise<array>} — array of PIN override entries
 */
async function getPinUseLog (db) {
  const raw = await db.get('pinLog')
  return raw ? raw.value : []
}

/**
 * Queue a message for later delivery when no parent connection is available.
 * Appends to the `pendingMessages` array in Hyperbee.
 *
 * @param {object} message — the message object to queue
 * @param {object} db — Hyperbee instance
 */
async function queueMessage (message, db) {
  const raw = await db.get('pendingMessages')
  const queue = raw ? raw.value : []
  queue.push({ message, queuedAt: Date.now() })
  await db.put('pendingMessages', queue)
}

/**
 * Flush all queued messages by calling writeMessage for each, then clear the queue.
 *
 * @param {object} db — Hyperbee instance
 * @param {function} writeMessage — async function called with each queued message
 * @returns {Promise<number>} — number of messages flushed
 */
async function flushMessageQueue (db, writeMessage) {
  const raw = await db.get('pendingMessages')
  if (!raw || !raw.value || raw.value.length === 0) return 0
  const queue = raw.value
  for (const { message } of queue) {
    await writeMessage(message)
  }
  await db.put('pendingMessages', [])
  return queue.length
}

module.exports = { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue }
