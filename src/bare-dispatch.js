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
          ctx.send({ method: 'event', event: 'override:denied', data: { packageName, reason: 'wrong-pin' } })
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

      default:
        throw new Error('unknown method: ' + method)
    }
  }
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

module.exports = { createDispatch, handlePolicyUpdate, appendPinUseLog }
