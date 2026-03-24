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
        if (ctx.onModeChange) ctx.onModeChange(newMode)
        return newMode
      }

      case 'identity:getMode':
      case 'getMode': {
        const stored = await ctx.db.get('mode')
        return { mode: stored ? stored.value : null }
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

      case 'children:list': {
        const children = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          const isOnline = value.noiseKey ? ctx.peers.has(value.noiseKey) : false
          children.push({ ...value, isOnline })
        }
        return children
      }

      case 'invite:generate': {
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

        return { inviteLink, inviteString: inviteLink, qrData: inviteLink, swarmTopic: topicHex, parentPublicKey }
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

      case 'identity:setName': {
        const { name } = args
        if (!name || typeof name !== 'string') throw new Error('invalid name')
        const raw = await ctx.db.get('profile')
        const profile = raw ? raw.value : {}
        profile.displayName = name.trim()
        await ctx.db.put('profile', profile)
        return { ok: true }
      }

      case 'identity:getName': {
        const raw = await ctx.db.get('profile')
        const displayName = raw ? (raw.value.displayName || null) : null
        return { displayName }
      }

      case 'pin:set': {
        const { pin } = args
        if (!pin || typeof pin !== 'string') throw new Error('invalid pin')

        // Hash the PIN using BLAKE2b (crypto_generichash) — a core libsodium primitive
        // that is reliably available in all builds including Android/Bare.
        // crypto_pwhash_str (argon2id) is intentionally NOT used here because its
        // availability in the Android libsodium build is not guaranteed.
        const hashBuf = Buffer.alloc(ctx.sodium.crypto_generichash_BYTES)
        ctx.sodium.crypto_generichash(hashBuf, Buffer.from(pin))
        const hashStr = hashBuf.toString('hex')
        if (!hashStr) throw new Error('PIN hashing failed — crypto_generichash returned empty result')

        // Store in parent's own policy key
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : {}
        policy.pinHash = hashStr
        await ctx.db.put('policy', policy)

        // Propagate pinHash into every child's policy and push to connected children
        for await (const { value: peerRecord } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          const childPK = peerRecord.publicKey
          const childPolicyRaw = await ctx.db.get('policy:' + childPK).catch(() => null)
          const childPolicy = childPolicyRaw
            ? childPolicyRaw.value
            : { apps: {}, childPublicKey: childPK, version: 0 }
          childPolicy.pinHash = hashStr
          childPolicy.version = (childPolicy.version || 0) + 1
          await ctx.db.put('policy:' + childPK, childPolicy)
          try {
            const noiseKey = peerRecord.noiseKey
            if (noiseKey) {
              ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: childPolicy })
            }
          } catch (_e) {
            // child offline — pinHash stored; will be pushed on next hello
          }
        }

        return { ok: true }
      }

      case 'pin:verify': {
        const { pin, packageName } = args
        const raw = await ctx.db.get('policy')
        if (!raw) { return { granted: false, reason: 'no-policy' } }
        const policy = raw.value  // Hyperbee uses valueEncoding:'json' so raw.value is already parsed
        if (!policy.pinHash) { return { granted: false, reason: 'no-pin' } }

        // Verify using the same BLAKE2b hash used in pin:set
        const enteredHashBuf = Buffer.alloc(ctx.sodium.crypto_generichash_BYTES)
        ctx.sodium.crypto_generichash(enteredHashBuf, Buffer.from(pin))
        const enteredHash = enteredHashBuf.toString('hex')
        const verified = enteredHash === policy.pinHash

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

      case 'pin:isSet': {
        // Reads the parent's own 'policy' key — NOT a per-child 'policy:{childPK}' key.
        // pin:set stores pinHash here (ctx.db.put('policy', policy)).
        // valueEncoding: 'json' means raw.value is already a parsed JS object.
        const raw = await ctx.db.get('policy')
        return { isSet: !!(raw && raw.value && raw.value.pinHash) }
      }

      case 'time:request': {
        const { packageName, appName } = args
        const requestId = 'req:' + Date.now() + ':' + packageName
        const request = {
          id: requestId,
          packageName,
          appName: appName || packageName,
          requestedAt: Date.now(),
          status: 'pending',
        }

        await ctx.db.put(requestId, request)

        // Notify parent (emit event to RN for relay)
        ctx.send({ type: 'event', event: 'time:request:sent', data: { packageName, requestId, requestedAt: request.requestedAt } })

        // Notify WebView that request was submitted
        ctx.send({ type: 'event', event: 'request:submitted', data: request })

        if (ctx.sendToParent) {
          await ctx.sendToParent({ type: 'time:request', payload: { requestId, packageName, requestedAt: request.requestedAt } })
        }

        return { requestId, status: 'pending' }
      }

      case 'requests:list': {
        // Scan Hyperbee for all keys matching 'req:*'; auto-expire entries older than 7 days
        const requests = []
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
          if (value.requestedAt < cutoff) {
            await ctx.db.del(key)
          } else {
            requests.push(value)
          }
        }
        // Sort by requestedAt descending
        requests.sort((a, b) => b.requestedAt - a.requestedAt)
        return { requests }
      }

      case 'requests:clear': {
        // Delete all resolved (approved or denied) req:* entries
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
          if (value.status === 'approved' || value.status === 'denied') {
            await ctx.db.del(key)
          }
        }
        return { ok: true }
      }

      case 'app:installed': {
        const { packageName, appName } = args

        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : { apps: {} }
        if (!policy.apps) policy.apps = {}

        // Mark as pending if not already in policy
        if (!policy.apps[packageName]) {
          policy.apps[packageName] = { status: 'pending', appName: appName || packageName, addedAt: Date.now() }
          await ctx.db.put('policy', policy)

          // Notify native enforcement of updated policy
          ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })

          // Notify parent (event carries appName for notification label)
          ctx.send({ type: 'event', event: 'app:installed', data: { packageName, appName: appName || packageName, detectedAt: Date.now() } })

          // Notify WebView
          ctx.send({ type: 'event', event: 'policy:updated', data: policy })

          if (ctx.sendToParent) {
            await ctx.sendToParent({ type: 'app:installed', payload: { packageName, appName: appName || packageName, detectedAt: Date.now() } })
          }
        }

        return { status: policy.apps[packageName].status }
      }

      case 'app:uninstalled': {
        // Child device: an app was removed. Strip it from local child policy,
        // update native enforcement, and relay to parent so their Apps list stays clean.
        const { packageName } = args
        if (!packageName) return { ok: false }

        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : { apps: {} }
        if (!policy.apps || !policy.apps[packageName]) return { ok: true } // already absent

        delete policy.apps[packageName]
        await ctx.db.put('policy', policy)

        // Keep native enforcement in sync
        ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })

        // Relay to parent so they can prune their Apps list
        if (ctx.sendToParent) {
          await ctx.sendToParent({ type: 'app:uninstalled', payload: { packageName } })
        }

        return { ok: true }
      }

      case 'apps:sync': {
        // Batch version of app:installed — receives all installed apps at once.
        // Avoids the race condition where concurrent individual app:installed messages
        // all read the same policy key before any write completes.
        const { apps } = args
        if (!Array.isArray(apps) || apps.length === 0) return { count: 0 }

        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : { apps: {} }
        if (!policy.apps) policy.apps = {}

        // If no apps are in the policy yet, this is the initial sync at first pairing —
        // auto-approve everything so enforcement doesn't immediately block all apps on a
        // freshly paired device. Apps installed after pairing start as 'pending'.
        const isInitialSync = Object.keys(policy.apps).length === 0

        let newCount = 0
        for (const { packageName, appName, isLauncher } of apps) {
          if (!policy.apps[packageName]) {
            const status = (isInitialSync || isLauncher) ? 'allowed' : 'pending'
            policy.apps[packageName] = { status, appName: appName || packageName, addedAt: Date.now() }
            newCount++
          }
        }

        if (newCount > 0) {
          await ctx.db.put('policy', policy)
          ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })
          ctx.send({ type: 'event', event: 'policy:updated', data: policy })
          if (ctx.sendToParent) {
            await ctx.sendToParent({ type: 'apps:sync', payload: { apps } })
          }
        }

        return { count: newCount }
      }

      case 'swarm:reconnect': {
        if (ctx.swarm) {
          await ctx.swarm.flush().catch(e => console.warn('[bare] swarm:reconnect flush failed:', e.message))
        }
        return {}
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

        if (ctx.sendToParent) {
          await ctx.sendToParent({ type: 'heartbeat', payload: heartbeat.payload })
        }

        return heartbeat.payload
      }

      case 'pin:used': {
        const { packageName, timestamp, durationSeconds } = args
        await appendPinUseLog({
          packageName,
          grantedAt: timestamp,
          expiresAt: timestamp + durationSeconds * 1000,
        }, ctx.db)
        return { logged: true }
      }

      case 'bypass:detected': {
        const { reason } = args
        const entry = { reason, detectedAt: Date.now() }

        await ctx.db.put('bypass:' + entry.detectedAt, entry)

        ctx.send({ type: 'event', event: 'alert:bypass', data: { reason, detectedAt: entry.detectedAt } })
        ctx.send({ type: 'event', event: 'enforcement:offline', data: { reason } })

        if (ctx.sendToParent) {
          await ctx.sendToParent({ type: 'bypass:alert', payload: { reason, detectedAt: entry.detectedAt } })
        }

        return { logged: true }
      }

      case 'usage:flush': {
        // Build usage report from PIN log, identity, and native usage stats
        const pinLog = await getPinUseLog(ctx.db)
        const identityRaw = await ctx.db.get('identity')
        const childPublicKey = identityRaw ? identityRaw.value.publicKey : null

        // args.usage is [{ packageName, appName, secondsToday }] from getDailyUsageAll()
        const apps = (args.usage || []).map((a) => ({
          packageName: a.packageName,
          displayName: a.appName || a.packageName,
          todaySeconds: a.secondsToday || 0,
          weekSeconds: 0,
        }))

        const report = {
          type: 'usage:report',
          timestamp: Date.now(),
          apps,
          pinOverrides: pinLog,
          childPublicKey,
        }

        // Persist report to Hyperbee
        await ctx.db.put('usage:' + report.timestamp, report)

        ctx.send({ type: 'event', event: 'usage:report', data: report })

        if (ctx.sendToParent) {
          await ctx.sendToParent({ type: 'usage:report', payload: report })
        }

        // Clear PIN log for next reporting period
        await ctx.db.put('pinLog', [])

        return { flushed: true, timestamp: report.timestamp }
      }

      case 'usage:getLatest': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid usage:getLatest args')
        let latest = null
        for await (const { value } of ctx.db.createReadStream({
          gt: 'usageReport:' + childPublicKey + ':',
          lt: 'usageReport:' + childPublicKey + ':~',
          reverse: true,
          limit: 1,
        })) {
          latest = value
        }
        return latest || null
      }

      case 'policy:get': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid policy:get args')
        const raw = await ctx.db.get('policy:' + childPublicKey)
        return raw ? raw.value : { apps: {} }
      }

      case 'app:decide': {
        const { childPublicKey, packageName, decision } = args
        if (!childPublicKey || !packageName || !['approve', 'deny'].includes(decision)) {
          throw new Error('invalid app:decide args')
        }
        const raw = await ctx.db.get('policy:' + childPublicKey)
        const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
        if (!policy.apps) policy.apps = {}
        const d = decision === 'approve' ? 'allowed' : 'blocked'
        policy.apps[packageName] = { ...(policy.apps[packageName] || {}), status: d }
        policy.version = (policy.version || 0) + 1
        await ctx.db.put('policy:' + childPublicKey, policy)
        try {
          // sendToPeer requires the Hyperswarm noise key, not the identity key.
          // The stored peer record contains noiseKey for this cross-lookup.
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'app:decision', payload: { packageName, decision: d } })
          }
        } catch (_e) {
          // child offline — policy stored; will be sent on next reconnect
        }

        // Mark matching pending requests for this child+package as resolved in Hyperbee
        // so AlertsTab shows the correct status after navigating away and back.
        const reqStatus = d === 'allowed' ? 'approved' : 'denied'
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value.childPublicKey === childPublicKey && value.packageName === packageName && value.status === 'pending') {
            await ctx.db.put(key, { ...value, status: reqStatus })
          }
        }

        return { ok: true, decision: d }
      }

      case 'policy:update': {
        const { childPublicKey, policy } = args
        if (!childPublicKey || !policy || typeof policy !== 'object') {
          throw new Error('invalid policy:update args')
        }
        const newPolicy = { ...policy, childPublicKey, version: (policy.version || 0) + 1 }
        await ctx.db.put('policy:' + childPublicKey, newPolicy)
        try {
          // sendToPeer requires the Hyperswarm noise key, not the identity key.
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: newPolicy })
          }
        } catch (_e) {
          // child offline — policy stored; will be sent on reconnect
        }
        return { ok: true }
      }

      case 'alerts:list': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid alerts:list args')
        const results = []
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000 // 7 days

        // Bypass alerts stored when a bypass:alert P2P message was received from this child
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'alert:' + childPublicKey + ':', lt: 'alert:' + childPublicKey + ':~' })) {
          if ((value.timestamp || 0) < cutoff) {
            await ctx.db.del(key) // auto-expire stale alerts
            continue
          }
          results.push(value)
        }

        // Time requests received from this child
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value.childPublicKey !== childPublicKey) continue
          if ((value.requestedAt || 0) < cutoff) {
            await ctx.db.del(key)
            continue
          }
          results.push({
            id: value.id,
            type: 'time_request',
            timestamp: value.requestedAt,
            packageName: value.packageName,
            appDisplayName: value.appName,
            status: value.status,
            resolved: value.status !== 'pending',
            childPublicKey,
          })
        }

        results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
        return results
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

  // Update any pending time requests for this package so the child's request
  // list reflects the parent's decision ('allowed' → 'approved', 'blocked' → 'denied').
  const requestStatus = decision === 'allowed' ? 'approved' : 'denied'
  let requestFound = false
  for await (const { key, value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
    if (value.packageName === packageName && value.status === 'pending') {
      const updated = { ...value, status: requestStatus }
      await db.put(key, updated)
      send({ type: 'event', event: 'request:updated', data: { requestId: value.id, status: requestStatus, packageName: value.packageName, appName: value.appName || value.packageName } })
      requestFound = true
    }
  }
  // Fallback: always emit so the child notification fires even if no req:* entry was found
  if (!requestFound) {
    send({ type: 'event', event: 'request:updated', data: { status: requestStatus, packageName } })
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

  // Sync pending req:* entries with the new policy so ChildRequests shows the correct status.
  // This handles the case where app:decision was not delivered directly (e.g., child was offline
  // and the parent's decision arrives via the policy:update pushed on reconnect).
  const apps = payload.apps || {}
  for await (const { key, value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
    if (value.status !== 'pending') continue
    const appEntry = apps[value.packageName]
    const appStatus = appEntry && appEntry.status
    if (appStatus === 'allowed' || appStatus === 'blocked') {
      const newStatus = appStatus === 'allowed' ? 'approved' : 'denied'
      await db.put(key, { ...value, status: newStatus })
      send({ type: 'event', event: 'request:updated', data: {
        requestId: value.id, status: newStatus,
        packageName: value.packageName, appName: value.appName || value.packageName,
      } })
    }
  }
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

/**
 * Handle an incoming `app:installed` P2P message from a child peer.
 * Runs on the PARENT device.
 */
async function handleIncomingAppInstalled (payload, childPublicKey, db, send, sendToPeer) {
  const { packageName, appName, iconBase64 } = payload
  if (!packageName) {
    console.warn('[bare] app:installed from child: missing packageName')
    return
  }

  const raw = await db.get('policy:' + childPublicKey)
  const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
  if (!policy.apps) policy.apps = {}

  if (!policy.apps[packageName]) {
    const now = Date.now()
    policy.apps[packageName] = { status: 'pending', appName: appName || packageName, addedAt: now, ...(iconBase64 && { iconBase64 }) }
    policy.version = (policy.version || 0) + 1
    await db.put('policy:' + childPublicKey, policy)

    const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
    const childDisplayName = peerRecord?.value?.displayName || 'Your child'

    // Push updated policy to child so overlay fires immediately when they open the new app
    if (sendToPeer) {
      try {
        const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
        if (noiseKey) sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
      } catch (_e) {
        // child offline — stored policy will be pushed on next reconnect via handleHello
      }
    }

    // Write an informational alert entry so it appears in the parent's Alerts tab
    const alertEntry = {
      id: 'app_installed:' + now,
      type: 'app_installed',
      timestamp: now,
      packageName,
      appDisplayName: appName || packageName,
      childPublicKey,
      childDisplayName,
    }
    await db.put('alert:' + childPublicKey + ':' + now, alertEntry)

    // apps:synced refreshes the Apps tab; app:installed carries data for the notification
    send({ type: 'event', event: 'apps:synced', data: { childPublicKey, totalApps: Object.keys(policy.apps).length } })
    send({ type: 'event', event: 'app:installed', data: { packageName, appName: appName || packageName, childPublicKey, childDisplayName } })
  }
}

/**
 * Handle an incoming `apps:sync` P2P message from a child peer.
 * Receives all installed apps in one batch — avoids read-modify-write races.
 * Runs on the PARENT device.
 */
async function handleIncomingAppsSync (payload, childPublicKey, db, send, sendToPeer) {
  const { apps } = payload
  if (!Array.isArray(apps) || apps.length === 0) return

  const raw = await db.get('policy:' + childPublicKey)
  const isFirstSync = !raw
  const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
  if (!policy.apps) policy.apps = {}

  const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
  const childDisplayName = peerRecord?.value?.displayName || 'Your child'

  let newCount = 0
  let iconUpdateCount = 0
  // Use a single timestamp for the whole batch so apps from the same sync
  // sort together by date rather than getting subtly different millisecond values.
  const batchAddedAt = Date.now()
  const newApps = []
  for (const { packageName, appName, iconBase64 } of apps) {
    if (!policy.apps[packageName]) {
      policy.apps[packageName] = { status: isFirstSync ? 'allowed' : 'pending', appName: appName || packageName, addedAt: batchAddedAt, ...(iconBase64 && { iconBase64 }) }
      newApps.push({ packageName, appName: appName || packageName })
      newCount++
    } else if (iconBase64 && !policy.apps[packageName].iconBase64) {
      // Back-fill icon for apps already in the policy (e.g. from before this feature)
      policy.apps[packageName].iconBase64 = iconBase64
      iconUpdateCount++
    }
  }

  if (newCount > 0 || iconUpdateCount > 0) {
    if (newCount > 0) policy.version = (policy.version || 0) + 1
    await db.put('policy:' + childPublicKey, policy)

    // Push policy to child on every sync (first AND incremental) so the child
    // immediately receives the allowed/pending status for new apps.
    if (sendToPeer) {
      try {
        const peerRec = await db.get('peers:' + childPublicKey).catch(() => null)
        const noiseKey = peerRec && peerRec.value && peerRec.value.noiseKey
        if (noiseKey) sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
      } catch (_e) {}
    }

    // On first sync only suppress per-app alert entries and app:installed events.
    if (!isFirstSync) {
      for (const { packageName, appName } of newApps) {
        const now = Date.now()
        const alertEntry = {
          id: 'app_installed:' + now + ':' + packageName,
          type: 'app_installed',
          timestamp: now,
          packageName,
          appDisplayName: appName,
          childPublicKey,
          childDisplayName,
        }
        await db.put('alert:' + childPublicKey + ':' + now + ':' + packageName, alertEntry)
        send({ type: 'event', event: 'app:installed', data: { packageName, appName, childPublicKey, childDisplayName } })
      }
    }

    send({ type: 'event', event: 'apps:synced', data: { childPublicKey, totalApps: Object.keys(policy.apps).length } })
  }
}

/**
 * Handle an incoming `time:request` P2P message from a child peer.
 * Runs on the PARENT device.
 */
async function handleIncomingTimeRequest (payload, childPublicKey, db, send) {
  const { requestId, packageName, requestedAt } = payload
  if (!requestId || !packageName) {
    console.warn('[bare] time:request from child: missing fields')
    return
  }

  // Deduplicate: re-delivered messages (from queue flush after reconnect) should not
  // fire a second notification or create a duplicate entry.
  const existing = await db.get('request:' + requestId).catch(() => null)
  if (existing) return

  // Look up child display name and app name for notification
  const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
  const childDisplayName = peerRecord ? (peerRecord.value.displayName || 'Child') : 'Child'
  const childPolicyRaw = await db.get('policy:' + childPublicKey).catch(() => null)
  const appName = childPolicyRaw && childPolicyRaw.value.apps && childPolicyRaw.value.apps[packageName]
    ? (childPolicyRaw.value.apps[packageName].appName || packageName)
    : packageName

  const request = { id: requestId, packageName, appName, requestedAt, status: 'pending', childPublicKey, childDisplayName }
  await db.put('request:' + requestId, request)
  send({ type: 'event', event: 'time:request:received', data: request })
}

/**
 * Handle an incoming `app:uninstalled` P2P message from a child peer.
 * Removes the package from the child's policy on the PARENT device so the
 * Apps list no longer shows stale entries for apps that no longer exist.
 * Runs on the PARENT device.
 */
async function handleIncomingAppUninstalled (payload, childPublicKey, db, send) {
  const { packageName } = payload
  if (!packageName) {
    console.warn('[bare] app:uninstalled from child: missing packageName')
    return
  }

  const raw = await db.get('policy:' + childPublicKey)
  if (!raw) return

  const policy = raw.value
  if (!policy.apps || !policy.apps[packageName]) return

  // Grab the display name before deleting so the alert has a readable label
  const appName = policy.apps[packageName].appName || packageName

  delete policy.apps[packageName]
  await db.put('policy:' + childPublicKey, policy)

  const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
  const childDisplayName = peerRecord?.value?.displayName || 'Your child'

  // Write an informational alert entry so it appears in the parent's Alerts tab
  const now = Date.now()
  const alertEntry = {
    id: 'app_uninstalled:' + now,
    type: 'app_uninstalled',
    timestamp: now,
    packageName,
    appDisplayName: appName,
    childPublicKey,
    childDisplayName,
  }
  await db.put('alert:' + childPublicKey + ':' + now, alertEntry)

  // apps:synced refreshes the Apps tab; app:uninstalled carries data for the notification
  send({ type: 'event', event: 'apps:synced', data: { childPublicKey } })
  send({ type: 'event', event: 'app:uninstalled', data: { packageName, appName, childPublicKey, childDisplayName } })
}

module.exports = { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingAppUninstalled, handleIncomingAppsSync, handleIncomingTimeRequest, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue }