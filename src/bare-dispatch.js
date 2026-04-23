// src/bare-dispatch.js
//
// Pure method dispatch table for the Bare worklet.
// Separated from IPC wiring so it can be unit tested in Node/jest.
// src/bare.js imports this and wires it to BareKit.IPC.

// Return YYYY-MM-DD in local time (not UTC) so session date keys
// match the user's calendar day regardless of timezone.
function localDateStr(ts) {
  const d = new Date(ts || Date.now())
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

// Filter out system-level packages that aren't user-facing apps.
// Must match the UI-side isSystemPackage() filter in UsageReports.jsx.
const SYSTEM_PACKAGES = new Set([
  'com.android.launcher', 'com.android.launcher3', 'com.google.android.apps.nexuslauncher',
  'com.android.packageinstaller', 'com.google.android.packageinstaller',
  'com.android.permissioncontroller', 'com.google.android.permissioncontroller',
  'com.android.settings', 'com.android.systemui', 'com.android.vending',
  'com.android.inputmethod.latin', 'com.google.android.inputmethod.latin',
  'com.android.providers.downloads.ui', 'com.android.documentsui',
])

function isSystemPackage(pkg) {
  if (SYSTEM_PACKAGES.has(pkg)) return true
  if (pkg.startsWith('com.android.') && !pkg.startsWith('com.android.chrome')) return true
  if (pkg.includes('.launcher')) return true
  return false
}

// RN shells push fresh app/usage values into this cache via 'heartbeat:updateData'
// whenever the JS thread is alive. bare.js's native-thread setInterval calls
// 'heartbeat:send', which reads from this cache so heartbeats stay reliable
// even when the RN JS thread is suspended (backgrounded child on Android).
const heartbeatCache = {
  currentApp: null,
  currentAppPackage: null,
  todayScreenTimeSeconds: null,
}

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

      case 'pref:set': {
        const { key, value } = args
        await ctx.db.put('pref:' + key, value)
        return { ok: true }
      }

      case 'pref:get': {
        const entry = await ctx.db.get('pref:' + args.key)
        return entry ? entry.value : null
      }

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
        // Child-mode auto-dedup (#151): same parent re-paired with a fresh identity
        // leaves a stale peers:{oldKey} record. Group by normalized displayName;
        // keep (isOnline desc, lastSeen desc, pairedAt desc); delete the rest.
        if (ctx.mode === 'child') {
          const groups = new Map()
          for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
            const name = (value.displayName || '').trim().toLowerCase()
            if (!name) continue
            if (!groups.has(name)) groups.set(name, [])
            groups.get(name).push(value)
          }
          for (const entries of groups.values()) {
            if (entries.length < 2) continue
            entries.sort((a, b) => {
              const aOnline = a.noiseKey && ctx.peers.has(a.noiseKey) ? 1 : 0
              const bOnline = b.noiseKey && ctx.peers.has(b.noiseKey) ? 1 : 0
              if (aOnline !== bOnline) return bOnline - aOnline
              if ((b.lastSeen || 0) !== (a.lastSeen || 0)) return (b.lastSeen || 0) - (a.lastSeen || 0)
              return (b.pairedAt || 0) - (a.pairedAt || 0)
            })
            for (let i = 1; i < entries.length; i++) {
              const stale = entries[i]
              console.log('[bare] auto-dedup parent peer:', stale.displayName, stale.publicKey?.slice(0, 12))
              await ctx.db.del('peers:' + stale.publicKey).catch(() => {})
              await ctx.db.del('pendingParent:' + stale.publicKey).catch(() => {})
              if (ctx.knownPeerKeys) ctx.knownPeerKeys.delete(stale.publicKey)
            }
          }
        }

        const children = []
        const seenKeys = new Set()
        const seenNoiseKeys = new Set()
        let streamCount = 0
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          streamCount++
          // Skip any peer that also has a blocked: entry — stale record from a race
          // between handleHello and child:unpair.
          const isBlocked = await ctx.db.get('blocked:' + value.publicKey).catch(() => null)
          if (isBlocked) continue
          const isOnline = value.noiseKey ? ctx.peers.has(value.noiseKey) : false
          // Deduplicate: if two entries claim the same noise key, keep only the online one.
          // This guards against stale Hyperbee entries that weren't pruned by handleHello.
          if (isOnline && value.noiseKey) {
            if (seenNoiseKeys.has(value.noiseKey)) continue
            seenNoiseKeys.add(value.noiseKey)
          }
          // Merge latest usage report so Dashboard has currentApp/todayScreenTimeSeconds on mount
          let usageFields = {}
          const policyRaw = await ctx.db.get('policy:' + value.publicKey).catch(() => null)
          const policyApps = policyRaw?.value?.apps || {}
          const lockedField = {
            locked: !!(policyRaw?.value?.locked),
            lockMessage: policyRaw?.value?.lockMessage || '',
          }
          for await (const { value: report } of ctx.db.createReadStream({
            gt: 'usageReport:' + value.publicKey + ':',
            lt: 'usageReport:' + value.publicKey + ':~',
            reverse: true,
            limit: 1,
          })) {
            let currentAppIcon = null
            if (report.currentAppPackage) {
              currentAppIcon = policyApps[report.currentAppPackage]?.iconBase64 || null
            }
            usageFields = {
              currentApp: report.currentApp || null,
              currentAppPackage: report.currentAppPackage || null,
              currentAppIcon,
              todayScreenTimeSeconds: report.todayScreenTimeSeconds || 0,
            }
          }
          seenKeys.add(value.publicKey)
          children.push({ ...value, isOnline, ...lockedField, ...usageFields })
        }
        // Fallback: Hyperbee createReadStream range queries can miss recently-stored
        // records due to B-tree snapshot timing. Use db.get for any known peer keys
        // that the range scan missed.
        if (ctx.knownPeerKeys) {
          for (const key of ctx.knownPeerKeys) {
            if (seenKeys.has(key)) continue
            const record = await ctx.db.get('peers:' + key).catch(() => null)
            console.log('[bare] children:list fallback for', key.slice(0, 12), ':', record ? 'FOUND' : 'NOT FOUND',
              'streamCount=' + streamCount, 'knownKeys=' + ctx.knownPeerKeys.size)
            if (!record) { ctx.knownPeerKeys.delete(key); continue }
            const isBlocked = await ctx.db.get('blocked:' + key).catch(() => null)
            if (isBlocked) continue
            const value = record.value
            const isOnline = value.noiseKey ? ctx.peers.has(value.noiseKey) : false
            const policyRaw = await ctx.db.get('policy:' + key).catch(() => null)
            const locked = !!(policyRaw?.value?.locked)
            const lockMessage = policyRaw?.value?.lockMessage || ''
            children.push({ ...value, isOnline, locked, lockMessage })
          }
        }
        if (children.length === 0 && ctx.knownPeerKeys && ctx.knownPeerKeys.size > 0) {
          console.log('[bare] children:list returned 0 but knownPeerKeys has', ctx.knownPeerKeys.size, 'keys:', [...ctx.knownPeerKeys].map(k => k.slice(0, 12)).join(', '))
        }
        return children
      }

      case 'peers:hasParent': {
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          if (value) return { hasPeers: true }
        }
        return { hasPeers: false }
      }

      case 'child:unpair': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('child:unpair requires childPublicKey')

        // Get noise key and swarm topic before deleting the peer record
        const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
        const noiseKey = peerRecord?.value?.noiseKey
        const swarmTopic = peerRecord?.value?.swarmTopic

        // Write the block entry FIRST so any rapid reconnect is rejected by handleHello
        // before we destroy the connection (Hyperswarm reconnects in <1s).
        await ctx.db.put('blocked:' + childPublicKey, { childPublicKey, blockedAt: Date.now() })

        // Remove parent-side records.
        // Collect keys first, then delete — avoids deadlocking Hyperbee's internal lock
        // (createReadStream + del cannot interleave).
        await ctx.db.del('peers:' + childPublicKey).catch(() => {})
        if (ctx.knownPeerKeys) ctx.knownPeerKeys.delete(childPublicKey)
        await ctx.db.del('policy:' + childPublicKey).catch(() => {})
        const alertKeys = []
        for await (const { key } of ctx.db.createReadStream({ gt: 'alert:' + childPublicKey + ':', lt: 'alert:' + childPublicKey + ':~' })) {
          alertKeys.push(key)
        }
        for (const key of alertKeys) await ctx.db.del(key).catch(() => {})
        const usageKeys = []
        for await (const { key } of ctx.db.createReadStream({ gt: 'usageReport:' + childPublicKey + ':', lt: 'usageReport:' + childPublicKey + ':~' })) {
          usageKeys.push(key)
        }
        for (const key of usageKeys) await ctx.db.del(key).catch(() => {})
        // Remove parent-side request records for this child so a re-pair starts clean.
        const requestKeys = []
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value.childPublicKey === childPublicKey) requestKeys.push(key)
        }
        for (const key of requestKeys) await ctx.db.del(key).catch(() => {})

        // Remove the persisted swarm topic for this child so it is not rejoined on
        // next startup. Also leave the topic on the live swarm so we stop advertising
        // on a topic no peer will ever use again.
        if (swarmTopic) {
          await ctx.db.del('topics:' + swarmTopic).catch(() => {})
          if (ctx.swarm) {
            try { ctx.swarm.leave(ctx.b4a.from(swarmTopic, 'hex')) } catch (_e) {}
          }
        } else {
          // swarmTopic was not stored in the peer record (can happen if info.topics was
          // empty on the Hyperswarm connection). Fall back: remove any topic not associated
          // with a remaining paired peer so the parent stops advertising on stale topics.
          const remainingTopics = new Set()
          for await (const { key, value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
            if (key !== 'peers:' + childPublicKey && value.swarmTopic) {
              remainingTopics.add(value.swarmTopic)
            }
          }
          const orphanedTopics = []
          for await (const { key, value } of ctx.db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
            if (!remainingTopics.has(value.topicHex)) orphanedTopics.push({ key, topicHex: value.topicHex })
          }
          for (const { key, topicHex } of orphanedTopics) {
            await ctx.db.del(key).catch(() => {})
            if (ctx.swarm) {
              try { ctx.swarm.leave(ctx.b4a.from(topicHex, 'hex')) } catch (_e) {}
            }
          }
        }

        // Notify child and gracefully close the connection AFTER deleting records.
        // Don't call conn.destroy() — that's a hard close that drops buffered writes
        // before the child receives the unpair message. Let the child close its end on receipt.
        if (noiseKey && ctx.peers.has(noiseKey)) {
          try {
            await ctx.sendToPeer(noiseKey, { type: 'unpair', payload: {} })
          } catch (_e) { /* offline or send failed */ }
        }

        ctx.send({ type: 'event', event: 'child:unpaired', data: { childPublicKey } })
        return { ok: true }
      }

      case 'child:clearBlocked': {
        // Clear a blocked: entry so a previously-unpaired child can re-pair without
        // rotating its identity. Needed when the child missed the original 'unpair'
        // message (e.g. offline during unpair, or connection dropped before wipe ran).
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('child:clearBlocked requires childPublicKey')
        const existed = await ctx.db.get('blocked:' + childPublicKey).catch(() => null)
        await ctx.db.del('blocked:' + childPublicKey).catch(() => {})
        return { ok: true, cleared: !!existed }
      }

      case 'child:listBlocked': {
        const blocked = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'blocked:', lt: 'blocked:~' })) {
          if (value) blocked.push(value)
        }
        return { blocked }
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

        // Leave and delete any topics not associated with a currently paired peer — BEFORE
        // joining the new topic. Running this after joinTopic would sweep the new topic too
        // (no peer is paired on it yet), causing the parent to immediately leave its own invite.
        const activePeerTopics = new Set()
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          if (value.swarmTopic) activePeerTopics.add(value.swarmTopic)
        }
        const staleTopicEntries = []
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
          if (!activePeerTopics.has(value.topicHex)) staleTopicEntries.push({ key, topicHex: value.topicHex })
        }
        for (const { key, topicHex: staleTopicHex } of staleTopicEntries) {
          await ctx.db.del(key).catch(() => {})
          if (ctx.swarm) {
            try { ctx.swarm.leave(ctx.b4a.from(staleTopicHex, 'hex')) } catch (_e) {}
          }
        }

        // Record this topic as a pending invite so handleHello can bind it to the
        // child's peer record even if Hyperswarm delivers an empty info.topics[] on
        // the accepted connection (#147 follow-up).
        await ctx.db.put('pendingInviteTopic:' + topicHex, { topicHex, createdAt: Date.now() }).catch(() => {})

        // Join the swarm topic (parent listens for child connections)
        await ctx.joinTopic(topicHex)

        // NOTE: we intentionally do NOT clear blocked: entries here. Clearing them while
        // Hyperswarm DHT propagation is still settling creates a race: the old child can
        // reconnect on a lingering connection before the old topic fully departs, pass the
        // handleHello blocked check, and re-write their peers: entry — causing duplicate
        // children on the dashboard. The block is harmless once the child processes unpair
        // (they wipe their DB and get a new identity keypair), so it never matches them again.

        // Build and return the invite link
        const { buildInviteLink } = require('./invite')
        const inviteLink = buildInviteLink({ parentPublicKey, swarmTopic: topicHex, role: 'p' })

        return { inviteLink, inviteString: inviteLink, qrData: inviteLink, swarmTopic: topicHex, parentPublicKey }
      }

      case 'child-invite:generate': {
        // Child-hosted pairing invite: the child generates a topic and publishes a QR
        // the parent can scan. Inverse of 'invite:generate'. Runs in child mode only.
        const liveMode = ctx.getMode ? ctx.getMode() : ctx.mode
        if (liveMode && liveMode !== 'child') {
          throw new Error('child-invite:generate requires child mode')
        }
        const topicBuf = Buffer.allocUnsafe(32)
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          crypto.getRandomValues(topicBuf)
        } else {
          require('sodium-native').randombytes_buf(topicBuf)
        }
        const topicHex = topicBuf.toString('hex')
        const childPublicKey = Buffer.from(ctx.identity.publicKey).toString('hex')

        await ctx.db.put('pendingInviteTopic:' + topicHex, { topicHex, createdAt: Date.now(), role: 'c' }).catch(() => {})

        await ctx.joinTopic(topicHex)

        const { buildInviteLink } = require('./invite')
        const inviteLink = buildInviteLink({ childPublicKey, swarmTopic: topicHex, role: 'c' })

        return { inviteLink, inviteString: inviteLink, qrData: inviteLink, swarmTopic: topicHex, childPublicKey }
      }

      case 'acceptInvite': {
        // args[0]: full pear://pearguard/join?t=... URL
        const { parseInviteLink } = require('./invite')
        const parsed = parseInviteLink(args[0])
        if (!parsed.ok) throw new Error('invalid invite: ' + parsed.error)
        if (parsed.role === 'c') {
          throw new Error('This is a child device QR code. Use the Add Child → Scan option on the parent device.')
        }

        const { parentPublicKey, swarmTopic } = parsed

        // Store/refresh the pendingParent entry so handleHello can bind the
        // incoming connection to the new invite's topic even if we already have
        // a peers: entry from a prior pair.
        await ctx.db.put('pendingParent:' + parentPublicKey, { publicKey: parentPublicKey, swarmTopic, ts: Date.now() })

        // Always join the new swarm topic. A parent that issued a fresh invite
        // after rotating topics won't be reachable on the old one, so even when
        // we already have a peers: entry we need to rejoin on the new topic for
        // Hyperswarm to rediscover them.
        await ctx.joinTopic(swarmTopic)

        // If we already have a confirmed peers: entry for this parent, surface
        // an explicit alreadyPaired signal so the UI can stop waiting on a
        // peer:paired event that won't fire a second time.
        const existing = await ctx.db.get('peers:' + parentPublicKey)
        if (existing) {
          return { ok: true, alreadyPaired: true, parentPublicKey, swarmTopic }
        }

        return { ok: true, swarmTopic, parentPublicKey }
      }

      case 'acceptChildInvite': {
        const liveMode = ctx.getMode ? ctx.getMode() : ctx.mode
        if (liveMode && liveMode !== 'parent') {
          throw new Error('acceptChildInvite requires parent mode')
        }
        const { parseInviteLink } = require('./invite')
        const parsed = parseInviteLink(args[0])
        if (!parsed.ok) throw new Error('invalid invite: ' + parsed.error)
        if (parsed.role !== 'c') {
          throw new Error('This is a parent device QR code. Use Profile → Pair to Parent on the child device.')
        }

        const { childPublicKey, swarmTopic } = parsed

        await ctx.db.put('pendingChild:' + childPublicKey, { publicKey: childPublicKey, swarmTopic, ts: Date.now() })

        await ctx.joinTopic(swarmTopic)

        const existing = await ctx.db.get('peers:' + childPublicKey)
        if (existing) {
          return { ok: true, alreadyPaired: true, childPublicKey, swarmTopic }
        }

        return { ok: true, swarmTopic, childPublicKey }
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
        // Broadcast updated hello to all connected peers (#73).
        const myIdentityHex = ctx.b4a.toString(ctx.identity.publicKey, 'hex')
        const avatarThumb = profile.avatar
          ? (profile.avatar.type === 'preset' ? 'preset:' + profile.avatar.id
            : profile.avatar.mime ? 'mime:' + profile.avatar.mime + ';' + (profile.avatar.base64 || profile.avatar.thumb64 || '')
            : profile.avatar.thumb64 || null)
          : null
        const helloMsg = { type: 'hello', payload: { publicKey: myIdentityHex, displayName: name.trim(), avatarThumb } }
        for (const [noiseKey] of ctx.peers) {
          try { ctx.sendToPeer(noiseKey, helloMsg) } catch (_e) {}
        }
        return { ok: true }
      }

      case 'identity:getName': {
        const raw = await ctx.db.get('profile')
        const profile = raw ? raw.value : {}
        return { displayName: profile.displayName || null, avatar: profile.avatar || null }
      }

      case 'identity:setAvatar': {
        const { avatar } = args
        // avatar: { type: 'preset', id } | { type: 'custom', base64, thumb64 } | null
        const raw = await ctx.db.get('profile')
        const profile = raw ? raw.value : {}
        profile.avatar = avatar || null
        await ctx.db.put('profile', profile)
        // Broadcast updated hello to all connected peers
        const myIdHex = ctx.b4a.toString(ctx.identity.publicKey, 'hex')
        const thumb = avatar
          ? (avatar.type === 'preset' ? 'preset:' + avatar.id
            : avatar.mime ? 'mime:' + avatar.mime + ';' + (avatar.base64 || avatar.thumb64 || '')
            : avatar.thumb64 || null)
          : null
        const helloPayload = { publicKey: myIdHex, displayName: profile.displayName || '', avatarThumb: thumb }
        const helloUpdate = { type: 'hello', payload: helloPayload }
        for (const [noiseKey] of ctx.peers) {
          try { ctx.sendToPeer(noiseKey, helloUpdate) } catch (_e) {}
        }
        return { ok: true }
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

        // Store in parent's own policy key (unchanged - for local use).
        // pinPlain is kept ONLY in the parent's local policy so the parent
        // can reveal it on the Settings page if they forget. It is never
        // placed into per-child policies or sent over the wire.
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : {}
        policy.pinHash = hashStr
        policy.pinPlain = pin
        await ctx.db.put('policy', policy)

        // Propagate pinHashes into every child's policy and push to connected children
        const myPublicKey = Buffer.from(ctx.identity.publicKey).toString('hex')
        for await (const { value: peerRecord } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          const childPK = peerRecord.publicKey
          const childPolicyRaw = await ctx.db.get('policy:' + childPK).catch(() => null)
          const childPolicy = childPolicyRaw
            ? childPolicyRaw.value
            : { apps: {}, childPublicKey: childPK, version: 0 }
          // Write per-parent pinHash into pinHashes map; remove legacy field
          if (!childPolicy.pinHashes) childPolicy.pinHashes = {}
          childPolicy.pinHashes[myPublicKey] = hashStr
          delete childPolicy.pinHash
          childPolicy.version = (childPolicy.version || 0) + 1
          await ctx.db.put('policy:' + childPK, childPolicy)
          try {
            const noiseKey = peerRecord.noiseKey
            if (noiseKey) {
              ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: childPolicy })
            }
          } catch (_e) {
            // child offline — pinHashes stored; will be pushed on next hello
          }
        }

        return { ok: true }
      }

      case 'pin:get': {
        // Returns the parent's own plaintext PIN (stored locally only) so
        // they can reveal it on the Settings page. Returns null if unset
        // or if this device was set before plaintext was stored.
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : null
        return { pin: policy && policy.pinPlain ? policy.pinPlain : null }
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
        // Resolve appName from policy so override displays show the label
        const appEntry = policy.apps && policy.apps[packageName]
        const appName = (appEntry && appEntry.appName) || packageName
        const grant = { packageName, appName, grantedAt: now, expiresAt, source: 'pin-verified' }

        // Store grant to Hyperbee for audit log and overrides:list
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
        const { packageName, appName, requestType, extraSeconds } = args
        // requestType: 'approval' (blocked/pending — parent changes policy)
        //              'extra_time' (approved but hit limit/schedule — parent grants timed override)
        // Defaults to 'approval' for backward compatibility with older clients.
        const resolvedType = requestType === 'extra_time' ? 'extra_time' : 'approval'
        const requestId = 'req:' + Date.now() + ':' + packageName
        const request = {
          id: requestId,
          packageName,
          appName: appName || packageName,
          requestedAt: Date.now(),
          status: 'pending',
          requestType: resolvedType,
          ...(resolvedType === 'extra_time' && typeof extraSeconds === 'number' ? { extraSeconds } : {}),
        }

        await ctx.db.put(requestId, request)

        // Notify parent (emit event to RN for relay)
        ctx.send({ type: 'event', event: 'time:request:sent', data: { packageName, requestId, requestedAt: request.requestedAt } })

        // Notify WebView that request was submitted
        ctx.send({ type: 'event', event: 'request:submitted', data: request })

        if (ctx.sendToAllParents) {
          const p2pPayload = { requestId, packageName, appName: request.appName, requestedAt: request.requestedAt, requestType: resolvedType }
          if (resolvedType === 'extra_time' && typeof extraSeconds === 'number') p2pPayload.extraSeconds = extraSeconds
          await ctx.sendToAllParents({ type: 'time:request', payload: p2pPayload })
        }

        return { requestId, status: 'pending' }
      }

      case 'time:grant': {
        // Parent approves an extra-time request — sends time:extend P2P to child.
        const { childPublicKey, requestId, packageName, extraSeconds } = args
        if (!childPublicKey || !requestId || !packageName || typeof extraSeconds !== 'number') {
          throw new Error('invalid time:grant args')
        }
        const existing = await ctx.db.get('request:' + requestId).catch(() => null)
        const appName = (existing && existing.value && (existing.value.appDisplayName || existing.value.appName)) || packageName
        if (existing) {
          await ctx.db.put('request:' + requestId, { ...existing.value, status: 'approved' })
        }

        // Store override grant on parent side so parent UI can display active overrides (#61)
        const grantedAt = Date.now()
        const expiresAt = grantedAt + extraSeconds * 1000
        await ctx.db.put('override:' + childPublicKey + ':' + grantedAt, {
          packageName, appName, childPublicKey, grantedAt, expiresAt, source: 'parent-approved',
        })

        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'time:extend', payload: { requestId, packageName, extraSeconds } })
          }
        } catch (_e) {
          // child offline — grant stored; child will receive on reconnect via handleHello
        }
        ctx.send({ type: 'event', event: 'request:updated', data: { requestId, status: 'approved' } })
        return { ok: true }
      }

      case 'time:deny': {
        // Parent denies an extra-time request — marks it denied and notifies child.
        const { childPublicKey, requestId, packageName, appName } = args
        if (!childPublicKey || !requestId || !packageName) {
          throw new Error('invalid time:deny args')
        }
        const existing = await ctx.db.get('request:' + requestId).catch(() => null)
        if (existing) {
          await ctx.db.put('request:' + requestId, { ...existing.value, status: 'denied' })
        }
        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'request:denied', payload: { requestId, packageName, appName } })
          }
        } catch (_e) { /* child offline */ }
        ctx.send({ type: 'event', event: 'request:updated', data: { requestId, status: 'denied' } })
        return { ok: true }
      }

      case 'request:markNotified': {
        // Mark a pending request as having had its notification shown, so it isn't
        // re-fired during the reconnect backfill scan (see handleHello in bare.js).
        const { requestId } = args || {}
        if (requestId) {
          const existing = await ctx.db.get('request:' + requestId).catch(() => null)
          if (existing) await ctx.db.put('request:' + requestId, { ...existing.value, notified: true })
        }
        return { ok: true }
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

      case 'overrides:list': {
        // Scan Hyperbee for active override grants (PIN or parent-approved).
        // Returns only non-expired entries so the UI shows what's currently active.
        // Optional childPublicKey filter for parent-side queries.
        const filterChild = args && args.childPublicKey
        const overrides = []
        const now = Date.now()
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'override:', lt: 'override:~' })) {
          if (value.expiresAt <= now) continue
          if (filterChild && value.childPublicKey !== filterChild) continue
          // Resolve appName from policy if not already on the record
          if (!value.appName) {
            const policyKey = filterChild ? ('policy:' + filterChild) : 'policy'
            const raw = await ctx.db.get(policyKey)
            const apps = raw && raw.value && raw.value.apps
            value.appName = (apps && apps[value.packageName] && apps[value.packageName].appName) || value.packageName
          }
          overrides.push(value)
        }
        overrides.sort((a, b) => a.expiresAt - b.expiresAt)
        return { overrides }
      }

      case 'child:homeData': {
        // Aggregated data for the child Home tab: status summary, usage, blocks, requests
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : null
        const apps = (policy && policy.apps) || {}

        // Collect blocked and pending app lists
        const blockedApps = []
        const pendingApps = []
        for (const pkg of Object.keys(apps)) {
          const entry = apps[pkg]
          const item = { packageName: pkg, appName: entry.appName || pkg }
          if (entry.status === 'blocked') blockedApps.push(item)
          if (entry.status === 'pending') pendingApps.push(item)
        }
        blockedApps.sort((a, b) => a.appName.localeCompare(b.appName))
        pendingApps.sort((a, b) => a.appName.localeCompare(b.appName))
        const blockedCount = blockedApps.length
        const pendingCount = pendingApps.length

        // Collect pending requests with app name resolution
        const pendingRequestsList = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
          if (value.status === 'pending') {
            const appEntry = apps[value.packageName]
            pendingRequestsList.push({
              ...value,
              appName: value.appName || (appEntry && appEntry.appName) || value.packageName,
            })
          }
        }
        pendingRequestsList.sort((a, b) => b.requestedAt - a.requestedAt)
        const pendingRequests = pendingRequestsList.length

        // Count active overrides
        const now = Date.now()
        const activeOverrides = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'override:', lt: 'override:~' })) {
          if (value.expiresAt > now) {
            const appEntry = apps[value.packageName]
            activeOverrides.push({
              ...value,
              appName: value.appName || (appEntry && appEntry.appName) || value.packageName,
            })
          }
        }

        // Locked state and names for lock banner / greeting
        const locked = !!(policy && policy.locked)
        const lockMessage = (policy && policy.lockMessage) || ''
        let parentName = null
        let childName = null
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          if (value && value.displayName) { parentName = value.displayName; break }
        }
        const identRaw = await ctx.db.get('identity')
        if (identRaw && identRaw.value && identRaw.value.name) childName = identRaw.value.name

        return { blockedCount, pendingCount, pendingRequests, blockedApps, pendingApps, pendingRequestsList, activeOverrides, hasPolicy: !!policy, locked, lockMessage, parentName, childName }
      }

      case 'app:installed': {
        const { packageName, appName, category, exeBasename, iconBase64 } = args

        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : { apps: {} }
        if (!policy.apps) policy.apps = {}

        // Mark as pending if not already in policy. Persisting exeBasename on
        // the entry lets the child re-seed its in-memory ExeMap from policy at
        // startup, so block-evaluator can still match the exe after a restart
        // when seen-exes.json has already deduped away the first-sighting.
        if (!policy.apps[packageName]) {
          policy.apps[packageName] = {
            status: 'pending',
            appName: appName || packageName,
            addedAt: Date.now(),
            ...(category && { category }),
            ...(exeBasename && { exeBasename }),
            ...(iconBase64 && { iconBase64 }),
          }
          await ctx.db.put('policy', policy)

          // Notify native enforcement of updated policy
          ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })

          // Notify parent (event carries appName for notification label)
          ctx.send({ type: 'event', event: 'app:installed', data: { packageName, appName: appName || packageName, detectedAt: Date.now() } })

          // Notify WebView
          ctx.send({ type: 'event', event: 'policy:updated', data: policy })

          if (ctx.sendToAllParents) {
            await ctx.sendToAllParents({ type: 'app:installed', payload: { packageName, appName: appName || packageName, category, exeBasename, iconBase64, detectedAt: Date.now() } })
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

        // Grab the display name before deleting so notifications show a readable label (#71)
        const appName = policy.apps[packageName].appName || packageName

        delete policy.apps[packageName]
        await ctx.db.put('policy', policy)

        // Keep native enforcement in sync
        ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })

        // Emit local event so the child's own notification shows the app name
        ctx.send({ type: 'event', event: 'app:uninstalled', data: { packageName, appName } })

        // Relay to parent so they can prune their Apps list
        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'app:uninstalled', payload: { packageName, appName } })
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
        for (const { packageName, appName, isLauncher, category } of apps) {
          if (!policy.apps[packageName]) {
            const status = (isInitialSync || isLauncher) ? 'allowed' : 'pending'
            policy.apps[packageName] = { status, appName: appName || packageName, addedAt: Date.now(), ...(category && { category }) }
            newCount++
          } else if (category && !policy.apps[packageName].category) {
            // Backfill category for apps already in policy
            policy.apps[packageName].category = category
          }
        }

        if (newCount > 0) {
          await ctx.db.put('policy', policy)
          ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })
          ctx.send({ type: 'event', event: 'policy:updated', data: policy })
        }

        // Always relay to parents — even when no new apps were added locally.
        // A second parent may have just paired and needs the full app list even
        // though the child already has all apps in its own policy (#109).
        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'apps:sync', payload: { apps } })
        }

        return { count: newCount }
      }

      case 'swarm:reconnect': {
        if (!ctx.swarm) return { rejoined: 0 }
        // Re-announce on every paired peer's topic. swarm.flush() alone is not
        // enough: after long background, network change, or Android doze the
        // DHT announce can go stale and peers stop discovering each other (#147).
        // Mirror the cold-start rejoin loop in init() so foreground recovery
        // matches a fresh launch.
        const activePeerTopics = new Set()
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          if (value && value.swarmTopic) activePeerTopics.add(value.swarmTopic)
        }
        const topicHexSet = new Set(activePeerTopics)
        for await (const { value } of ctx.db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
          if (value && value.topicHex) topicHexSet.add(value.topicHex)
        }
        const topicHexes = [...topicHexSet]
        await Promise.all(topicHexes.map(t =>
          ctx.joinTopic(t).catch(e => console.warn('[bare] swarm:reconnect rejoin failed:', e.message))
        ))
        return { rejoined: topicHexes.length }
      }

      case 'heartbeat:updateData': {
        if (args && typeof args === 'object') {
          if ('currentApp' in args) heartbeatCache.currentApp = args.currentApp
          if ('currentAppPackage' in args) heartbeatCache.currentAppPackage = args.currentAppPackage
          if (typeof args.todayScreenTimeSeconds === 'number') {
            heartbeatCache.todayScreenTimeSeconds = args.todayScreenTimeSeconds
          }
        }
        return { ok: true }
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
            currentApp: heartbeatCache.currentApp,
            currentAppPackage: heartbeatCache.currentAppPackage,
            todayScreenTimeSeconds: heartbeatCache.todayScreenTimeSeconds,
            timestamp: Date.now(),
          },
        }

        ctx.send({ type: 'event', event: 'heartbeat:send', data: heartbeat })

        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'heartbeat', payload: heartbeat.payload })
        }

        return heartbeat.payload
      }

      case 'pin:used': {
        // Native overlay verified PIN and granted override — store to Hyperbee
        // so overrides:list can find it, and relay to parent as an alert (#61).
        const { packageName, timestamp, durationSeconds } = args
        const grantedAt = timestamp || Date.now()
        const expiresAt = grantedAt + (durationSeconds || 3600) * 1000

        // Resolve appName from policy
        const policyRaw = await ctx.db.get('policy')
        const policyApps = policyRaw && policyRaw.value && policyRaw.value.apps
        const appName = (policyApps && policyApps[packageName] && policyApps[packageName].appName) || packageName

        const grant = { packageName, appName, grantedAt, expiresAt, source: 'pin-verified' }

        await ctx.db.put('override:' + packageName + ':' + grantedAt, grant)
        await appendPinUseLog({ packageName, grantedAt, expiresAt }, ctx.db)

        // Emit event so child UI updates immediately
        ctx.send({ type: 'event', event: 'override:granted', data: grant })

        // Relay to parent so they see PIN usage in alerts
        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'pin:override', payload: { packageName, appName, grantedAt, expiresAt } })
        }

        return { logged: true }
      }

      case 'bypass:detected': {
        const { reason } = args
        const entry = { reason, detectedAt: Date.now() }

        await ctx.db.put('bypass:' + entry.detectedAt, entry)

        ctx.send({ type: 'event', event: 'alert:bypass', data: { reason, detectedAt: entry.detectedAt } })
        ctx.send({ type: 'event', event: 'enforcement:offline', data: { reason } })

        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'bypass:alert', payload: { reason, detectedAt: entry.detectedAt } })
        }

        return { logged: true }
      }

      case 'usage:flush': {
        // Build usage report from PIN log, identity, and native usage stats
        const pinLog = await getPinUseLog(ctx.db)
        const identityRaw = await ctx.db.get('identity')
        const childPublicKey = identityRaw ? identityRaw.value.publicKey : null

        // Build weekly lookup: packageName → secondsThisWeek
        const weeklyMap = {}
        for (const w of args.weekly || []) {
          weeklyMap[w.packageName] = w.secondsThisWeek || 0
        }

        // Load policy to attach daily limits per app
        const policyRaw = await ctx.db.get('policy')
        const policyApps = policyRaw?.value?.apps || {}

        // args.usage is [{ packageName, appName, secondsToday }] from getDailyUsageAllEvents()
        const apps = (args.usage || []).map((a) => ({
          packageName: a.packageName,
          displayName: a.appName || a.packageName,
          todaySeconds: a.secondsToday || 0,
          weekSeconds: weeklyMap[a.packageName] || 0,
          dailyLimitSeconds: policyApps[a.packageName]?.dailyLimitSeconds || null,
        }))

        // Skip storing/sending if no usage data — avoids overwriting a valid
        // report with an empty one when the native stats aren't available yet
        if (apps.length === 0) {
          return { flushed: false, reason: 'no data' }
        }

        // Resolve display name of the current foreground app
        const foregroundPkg = args.foregroundPackage || null
        const foregroundEntry = foregroundPkg ? apps.find((a) => a.packageName === foregroundPkg) : null
        const currentApp = foregroundEntry ? foregroundEntry.displayName : null
        const currentAppPackage = foregroundEntry ? foregroundPkg : null
        const todayScreenTimeSeconds = apps.reduce((sum, a) => sum + (a.todaySeconds || 0), 0)

        const now = Date.now()

        // Store session-level data for usage reports as deltas.
        // Native Android returns today's full session list each flush, but we
        // filter down to sessions that closed after the last flush plus any
        // still-open session (which we re-send on each flush with its growing
        // duration — dedup on read prefers the longest snapshot). Windows'
        // takeSessions() already drains a buffer, so the filter is a no-op
        // there. Parent and child both append under a unique-timestamped key
        // so today's storage footprint is bounded by actual session count
        // rather than flushes × sessions.
        const flushStateRaw = await ctx.db.get('sessions:flushState:' + (childPublicKey || 'local')).catch(() => null)
        const lastFlushAt = flushStateRaw?.value?.lastFlushAt || 0
        const allSessions = args.sessions || []
        const sessionsDelta = allSessions.filter((s) => s.endedAt == null || s.endedAt > lastFlushAt)

        const dateStr = localDateStr(now)
        const sessionPrefix = 'sessions:' + (childPublicKey || 'local') + ':' + dateStr + ':'
        if (sessionsDelta.length > 0) {
          await ctx.db.put(sessionPrefix + now, sessionsDelta)
        }
        await ctx.db.put('sessions:flushState:' + (childPublicKey || 'local'), { lastFlushAt: now })

        // Piggyback resolved request statuses so co-parents get updates (#122).
        // Collect all non-pending req: entries from child's Hyperbee.
        const resolvedRequests = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
          if (value.status && value.status !== 'pending') {
            resolvedRequests.push({
              requestId: value.id,
              status: value.status,
              packageName: value.packageName,
              resolvedAt: value.resolvedAt || value.requestedAt,
            })
          }
        }
        if (resolvedRequests.length > 0) console.log('[bare] usage:flush piggyback:', resolvedRequests.length, 'resolved requests')

        const report = {
          type: 'usage:report',
          timestamp: now,
          lastSynced: now,
          apps,
          sessions: sessionsDelta,
          pinOverrides: pinLog,
          childPublicKey,
          currentApp,
          currentAppPackage,
          todayScreenTimeSeconds,
          resolvedRequests,
        }

        // Persist report to Hyperbee (single overwriting key per child's own copy).
        await ctx.db.put('usage:latest', report)

        ctx.send({ type: 'event', event: 'usage:report', data: report })

        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'usage:report', payload: report })
        }

        // Clear PIN log for next reporting period
        await ctx.db.put('pinLog', [])

        return { flushed: true, timestamp: report.timestamp }
      }

      case 'usage:getLatest': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid usage:getLatest args')
        // Fast path: single overwriting key.
        const direct = await ctx.db.get('usageReport:' + childPublicKey + ':latest').catch(() => null)
        if (direct?.value) return direct.value
        // Fallback for pre-migration data that still uses timestamped keys.
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

      case 'usage:getSessions': {
        const { childPublicKey, date } = args
        if (!childPublicKey || !date) throw new Error('invalid usage:getSessions args')
        const bestByKey = new Map()
        for await (const { value } of ctx.db.createReadStream({
          gt: 'sessions:' + childPublicKey + ':' + date + ':',
          lt: 'sessions:' + childPublicKey + ':' + date + ':~',
        })) {
          if (!Array.isArray(value)) continue
          for (const s of value) {
            // Dedup prefers the longest snapshot for a given (pkg, startedAt):
            // open-session snapshots from earlier flushes get replaced once the
            // closed version arrives.
            const key = s.packageName + ':' + s.startedAt
            const existing = bestByKey.get(key)
            if (!existing || (s.durationSeconds || 0) > (existing.durationSeconds || 0)) {
              bestByKey.set(key, s)
            }
          }
        }
        return Array.from(bestByKey.values())
      }

      case 'usage:getDailySummaries': {
        const { childPublicKey, days, packageName } = args
        if (!childPublicKey || !days) throw new Error('invalid usage:getDailySummaries args')
        const summaries = []
        const now = new Date()
        for (let i = 0; i < days; i++) {
          const d = new Date(now)
          d.setDate(d.getDate() - i)
          const dateStr = localDateStr(d)
          // Collect best-duration snapshot per (pkg, startedAt) first so
          // open-session deltas collapse into their closed counterparts before
          // we sum.
          const bestByKey = new Map()
          for await (const { value } of ctx.db.createReadStream({
            gt: 'sessions:' + childPublicKey + ':' + dateStr + ':',
            lt: 'sessions:' + childPublicKey + ':' + dateStr + ':~',
          })) {
            if (!Array.isArray(value)) continue
            for (const s of value) {
              if (packageName && s.packageName !== packageName) continue
              if (isSystemPackage(s.packageName)) continue
              const key = s.packageName + ':' + s.startedAt
              const existing = bestByKey.get(key)
              if (!existing || (s.durationSeconds || 0) > (existing.durationSeconds || 0)) {
                bestByKey.set(key, s)
              }
            }
          }
          let totalSeconds = 0
          for (const s of bestByKey.values()) totalSeconds += s.durationSeconds || 0
          summaries.push({ date: dateStr, totalSeconds, sessionCount: bestByKey.size })
        }
        return summaries
      }

      case 'usage:debugSessions': {
        const { childPublicKey, date } = args
        if (!childPublicKey || !date) throw new Error('invalid args')
        let entryCount = 0
        let rawCount = 0
        let rawSeconds = 0
        const bestByKey = new Map()
        const samples = []
        for await (const { key, value } of ctx.db.createReadStream({
          gt: 'sessions:' + childPublicKey + ':' + date + ':',
          lt: 'sessions:' + childPublicKey + ':' + date + ':~',
        })) {
          entryCount++
          if (!Array.isArray(value)) continue
          for (const s of value) {
            rawCount++
            rawSeconds += s.durationSeconds || 0
            const dk = s.packageName + ':' + s.startedAt
            const existing = bestByKey.get(dk)
            if (!existing || (s.durationSeconds || 0) > (existing.durationSeconds || 0)) {
              bestByKey.set(dk, s)
            }
            if (samples.length < 20) samples.push({ pkg: s.packageName, startedAt: s.startedAt, dur: s.durationSeconds, startType: typeof s.startedAt })
          }
        }
        let dedupSeconds = 0
        for (const s of bestByKey.values()) dedupSeconds += s.durationSeconds || 0
        return { entryCount, rawCount, rawSeconds, dedupCount: bestByKey.size, dedupSeconds, samples }
      }

      case 'usage:getCategorySummary': {
        const { childPublicKey, date, days } = args
        if (!childPublicKey || (!date && !days)) throw new Error('invalid usage:getCategorySummary args')
        const policyRaw = await ctx.db.get('policy:' + childPublicKey)
        const policyApps = policyRaw?.value?.apps || {}
        const sessions = []
        if (days && days > 1) {
          const now = new Date()
          for (let i = 0; i < days; i++) {
            const d = new Date(now)
            d.setDate(d.getDate() - i)
            const dateStr = localDateStr(d)
            for await (const { value } of ctx.db.createReadStream({
              gt: 'sessions:' + childPublicKey + ':' + dateStr + ':',
              lt: 'sessions:' + childPublicKey + ':' + dateStr + ':~',
            })) {
              if (Array.isArray(value)) {
                for (const s of value) sessions.push(s)
              }
            }
          }
        } else {
          const queryDate = date || localDateStr()
          for await (const { value } of ctx.db.createReadStream({
            gt: 'sessions:' + childPublicKey + ':' + queryDate + ':',
            lt: 'sessions:' + childPublicKey + ':' + queryDate + ':~',
          })) {
            if (Array.isArray(value)) {
              for (const s of value) sessions.push(s)
            }
          }
        }
        // Dedup prefers the longest snapshot so open-session deltas collapse
        // into the final closed version.
        const bestByKey = new Map()
        for (const s of sessions) {
          const key = s.packageName + ':' + s.startedAt
          const existing = bestByKey.get(key)
          if (!existing || (s.durationSeconds || 0) > (existing.durationSeconds || 0)) {
            bestByKey.set(key, s)
          }
        }
        const categories = {}
        for (const s of bestByKey.values()) {
          const appInfo = policyApps[s.packageName]
          // Skip apps not in policy (system apps that slipped through)
          if (!appInfo) continue
          const category = appInfo.category || 'Other'
          if (!categories[category]) {
            categories[category] = { category, totalSeconds: 0, apps: {} }
          }
          categories[category].totalSeconds += s.durationSeconds || 0
          if (!categories[category].apps[s.packageName]) {
            categories[category].apps[s.packageName] = {
              packageName: s.packageName,
              displayName: s.displayName || s.packageName,
              totalSeconds: 0,
              iconBase64: appInfo?.iconBase64 || null,
            }
          }
          categories[category].apps[s.packageName].totalSeconds += s.durationSeconds || 0
        }
        const result = Object.values(categories).map((cat) => ({
          ...cat,
          apps: Object.values(cat.apps).sort((a, b) => b.totalSeconds - a.totalSeconds),
        }))
        result.sort((a, b) => b.totalSeconds - a.totalSeconds)
        return result
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
        // so ActivityTab shows the correct status after navigating away and back.
        const reqStatus = d === 'allowed' ? 'approved' : 'denied'
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value.childPublicKey === childPublicKey && value.packageName === packageName && value.status === 'pending') {
            await ctx.db.put(key, { ...value, status: reqStatus })
          }
        }

        // Notify AppsTab to reload so the status change is reflected immediately (#70).
        ctx.send({ type: 'event', event: 'apps:synced', data: { childPublicKey } })
        return { ok: true, decision: d }
      }

      case 'apps:decideBatch': {
        const { childPublicKey, packageNames, decision } = args
        if (!childPublicKey || !Array.isArray(packageNames) || packageNames.length === 0 || !['approve', 'deny'].includes(decision)) {
          throw new Error('invalid apps:decideBatch args')
        }
        const raw = await ctx.db.get('policy:' + childPublicKey)
        const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
        if (!policy.apps) policy.apps = {}
        const d = decision === 'approve' ? 'allowed' : 'blocked'

        for (const packageName of packageNames) {
          policy.apps[packageName] = { ...(policy.apps[packageName] || {}), status: d }
        }
        policy.version = (policy.version || 0) + 1
        await ctx.db.put('policy:' + childPublicKey, policy)

        // Push full policy to child in one shot — avoids per-app notifications
        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
          }
        } catch (_e) {}

        // Mark matching pending requests as resolved
        const reqStatus = d === 'allowed' ? 'approved' : 'denied'
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value.childPublicKey === childPublicKey && packageNames.includes(value.packageName) && value.status === 'pending') {
            await ctx.db.put(key, { ...value, status: reqStatus })
          }
        }

        ctx.send({ type: 'event', event: 'apps:synced', data: { childPublicKey } })
        return { ok: true, decision: d, count: packageNames.length }
      }

      case 'policy:update': {
        const { childPublicKey, policy } = args
        if (!childPublicKey || !policy || typeof policy !== 'object') {
          throw new Error('invalid policy:update args')
        }
        // Merge parent settings into policy so they reach the child device
        const settingsRaw = await ctx.db.get('parentSettings')
        const parentSettings = settingsRaw ? settingsRaw.value : {}
        const newPolicy = { ...policy, childPublicKey, settings: parentSettings, version: (policy.version || 0) + 1 }
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

      case 'policy:setLock': {
        const { childPublicKey, locked, lockMessage } = args
        if (!childPublicKey) throw new Error('invalid policy:setLock args')
        const raw = await ctx.db.get('policy:' + childPublicKey)
        const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
        policy.locked = !!locked
        if (locked) {
          const msg = typeof lockMessage === 'string' ? lockMessage.trim() : ''
          policy.lockMessage = msg ? msg.slice(0, 280) : ''
        } else {
          policy.lockMessage = ''
        }
        policy.version = (policy.version || 0) + 1
        await ctx.db.put('policy:' + childPublicKey, policy)
        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
          }
        } catch (_e) {
          // child offline — policy stored; will be sent on reconnect
        }
        return { ok: true }
      }

      case 'settings:get': {
        const raw = await ctx.db.get('parentSettings')
        return raw ? raw.value : {}
      }

      case 'settings:save': {
        const { settings } = args
        if (!settings || typeof settings !== 'object') throw new Error('invalid settings:save args')
        await ctx.db.put('parentSettings', settings)

        // Push updated settings into all child policies
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'policy:', lt: 'policy:~' })) {
          const childKey = key.replace(/^policy:/, '')
          const updated = { ...value, settings, version: (value.version || 0) + 1 }
          await ctx.db.put(key, updated)
          try {
            const peerRecord = await ctx.db.get('peers:' + childKey).catch(() => null)
            const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
            if (noiseKey) ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: updated })
          } catch (_e) {}
        }
        return { ok: true }
      }

      case 'settings:setTheme': {
        const { theme } = args
        if (!theme || typeof theme !== 'string') throw new Error('invalid settings:setTheme args')
        await ctx.db.put('settings:theme', theme)
        return {}
      }

      case 'settings:getTheme': {
        const entry = await ctx.db.get('settings:theme')
        return { theme: entry ? entry.value.toString() : 'dark' }
      }

      case 'donation:check': {
        const identityRaw = await ctx.db.get('identity')
        const createdAt = identityRaw && identityRaw.value && identityRaw.value.createdAt
        const dismissedRaw = await ctx.db.get('donationReminderDismissed')
        const dismissed = !!(dismissedRaw && dismissedRaw.value)
        return { createdAt: createdAt || null, dismissed }
      }

      case 'donation:dismiss': {
        await ctx.db.put('donationReminderDismissed', true)
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
          const entry = {
            id: value.id,
            type: 'time_request',
            timestamp: value.requestedAt,
            packageName: value.packageName,
            appDisplayName: value.appName,
            status: value.status,
            resolved: value.status !== 'pending',
            childPublicKey,
            requestType: value.requestType || 'approval',
          }
          if (value.requestType === 'extra_time' && typeof value.extraSeconds === 'number') {
            entry.extraSeconds = value.extraSeconds
          }
          results.push(entry)
        }

        results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))

        // Always ask the child for resolution updates when opening Activity tab (#122).
        // iOS may drop P2P messages when backgrounded or during Hyperswarm dedup;
        // this pull-based sync ensures the parent gets updated statuses.
        if (ctx.getMode() === 'parent') {
          try {
            const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
            const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
            if (noiseKey) {
              ctx.sendToPeer(noiseKey, { type: 'requests:syncResolved', payload: { childPublicKey } })
              console.log('[bare] alerts:list triggered syncResolved for', childPublicKey?.slice(0, 8))
            }
          } catch (e) { console.warn('[bare] alerts:list syncResolved failed:', e.message) }
        }

        return results
      }

      case 'rules:export': {
        const { childPubKey } = args
        if (!childPubKey) throw new Error('invalid rules:export args')
        const policyRaw = await ctx.db.get('policy:' + childPubKey)
        if (!policyRaw) throw new Error('no policy for child ' + childPubKey.slice(0, 8))
        const identityRaw = await ctx.db.get('identity')
        if (!identityRaw) throw new Error('no identity')
        const { buildRulesExport } = require('./backup')
        const json = buildRulesExport(policyRaw.value, childPubKey, identityRaw.value)
        return { json }
      }

      case 'rules:import:preview': {
        const { jsonString, targetChildPubKey } = args
        if (!jsonString || !targetChildPubKey) throw new Error('invalid rules:import:preview args')
        const { parseAndVerify, diffPolicies, KIND_RULES } = require('./backup')
        const { payload } = parseAndVerify(jsonString, KIND_RULES)
        const targetRaw = await ctx.db.get('policy:' + targetChildPubKey).catch(() => null)
        const targetApps = (targetRaw && targetRaw.value && targetRaw.value.apps) || {}
        const sourceApps = (payload.policy && payload.policy.apps) || {}
        const installedSet = new Set(Object.keys(targetApps))
        const diff = diffPolicies(targetRaw?.value, payload.policy, installedSet)
        const nameOf = (pkg) => (sourceApps[pkg]?.appName) || (targetApps[pkg]?.appName) || pkg
        return {
          sourceChildPubKey: payload.sourceChildPubKey,
          targetChildPubKey,
          appsAdded: diff.appsAdded.map(p => ({ packageName: p, appName: nameOf(p) })),
          appsRemoved: diff.appsRemoved.map(p => ({ packageName: p, appName: nameOf(p) })),
          appsChanged: diff.appsChanged.map(p => ({ packageName: p, appName: nameOf(p) })),
          appsSkipped: (diff.appsSkipped || []).map(p => ({ packageName: p, appName: nameOf(p) })),
          schedulesChanged: diff.schedulesChanged
        }
      }

      case 'rules:import:apply': {
        const { jsonString, targetChildPubKey } = args
        if (!jsonString || !targetChildPubKey) throw new Error('invalid rules:import:apply args')
        const { parseAndVerify, mergeRulesIntoPolicy, KIND_RULES } = require('./backup')
        const { payload } = parseAndVerify(jsonString, KIND_RULES)
        const targetRaw = await ctx.db.get('policy:' + targetChildPubKey).catch(() => null)
        const installedSet = new Set(Object.keys((targetRaw && targetRaw.value && targetRaw.value.apps) || {}))
        const merged = mergeRulesIntoPolicy(targetRaw?.value, payload.policy, targetChildPubKey, installedSet)
        await ctx.db.put('policy:' + targetChildPubKey, merged)
        try {
          const peerRecord = await ctx.db.get('peers:' + targetChildPubKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: merged })
        } catch (_e) {}
        return { ok: true }
      }

      case 'backup:export': {
        const identityRaw = await ctx.db.get('identity')
        if (!identityRaw) throw new Error('no identity')
        const profileRaw = await ctx.db.get('profile').catch(() => null)
        const settingsRaw = await ctx.db.get('parentSettings').catch(() => null)
        const parentPolicyRaw = await ctx.db.get('policy').catch(() => null)
        const peers = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          peers.push(value)
        }
        const policies = {}
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'policy:', lt: 'policy:~' })) {
          policies[key.replace(/^policy:/, '')] = value
        }
        const { buildBackup } = require('./backup')
        const json = buildBackup({
          identity: identityRaw.value,
          profile: profileRaw ? profileRaw.value : null,
          parentSettings: settingsRaw ? settingsRaw.value : null,
          parentPolicy: parentPolicyRaw ? parentPolicyRaw.value : null,
          peers,
          policies
        })
        return { json, peerCount: peers.length, policyCount: Object.keys(policies).length }
      }

      case 'backup:import': {
        const { jsonString, allowOverwrite } = args
        if (!jsonString) throw new Error('invalid backup:import args')
        const { parseAndVerify, KIND_BACKUP } = require('./backup')
        const { payload } = parseAndVerify(jsonString, KIND_BACKUP)
        const existingIdentity = await ctx.db.get('identity').catch(() => null)
        if (existingIdentity && !allowOverwrite) {
          throw new Error('Device not fresh: identity already exists. Clear app data before importing.')
        }
        await ctx.db.put('identity', payload.identity)
        if (payload.profile) await ctx.db.put('profile', payload.profile)
        if (payload.parentSettings) await ctx.db.put('parentSettings', payload.parentSettings)
        if (payload.parentPolicy) await ctx.db.put('policy', payload.parentPolicy)
        await ctx.db.put('mode', 'parent')
        const paired = []
        for (const peer of payload.peers || []) {
          if (!peer || !peer.publicKey) continue
          await ctx.db.put('peers:' + peer.publicKey, peer)
          paired.push(peer.publicKey)
        }
        for (const [childKey, policy] of Object.entries(payload.policies || {})) {
          await ctx.db.put('policy:' + childKey, policy)
        }
        return { ok: true, paired, restartRequired: true }
      }

      case 'storage:breakdown': {
        if (!ctx.storageBreakdown) throw new Error('storageBreakdown unavailable')
        return await ctx.storageBreakdown()
      }

      case 'storage:analyze': {
        if (!ctx.analyzeStorage) throw new Error('analyzeStorage unavailable')
        return await ctx.analyzeStorage()
      }

      case 'storage:rebuild': {
        if (!ctx.rebuildLocalDb) throw new Error('rebuildLocalDb unavailable')
        // This handler itself is counted in _inflightHandlers; tell rebuild
        // to exclude 1 from its drain target so it doesn't time out waiting
        // on its own caller.
        return await ctx.rebuildLocalDb({ selfInflight: 1 })
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
async function handleAppDecision (payload, db, send, sendToAllParents) {
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

  // Relay the updated policy to all OTHER parents so co-parents stay in sync.
  if (sendToAllParents) {
    sendToAllParents({ type: 'policy:update', payload: policy })
  }

  // Update any pending time requests for this package so the child's request
  // list reflects the parent's decision ('allowed' -> 'approved', 'blocked' -> 'denied').
  const requestStatus = decision === 'allowed' ? 'approved' : 'denied'
  // Only emit request:updated (which triggers a child notification) when a
  // pending request actually exists. Proactive parent decisions (approve/deny
  // from the Apps tab without a child request) should NOT notify the child.
  for await (const { key, value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
    if (value.packageName === packageName && value.status === 'pending') {
      const updated = { ...value, status: requestStatus }
      await db.put(key, updated)
      send({ type: 'event', event: 'request:updated', data: { requestId: value.id, status: requestStatus, packageName: value.packageName, appName: value.appName || value.packageName } })
      // Broadcast resolution to all parents so co-parent activity lists update (#122)
      if (sendToAllParents) {
        sendToAllParents({ type: 'request:resolved', payload: { requestId: value.id, status: requestStatus, packageName: value.packageName, appName: value.appName, resolvedAt: Date.now() } })
      }
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
async function handlePolicyUpdate (payload, db, send, sendToAllParents, senderKey) {
  if (typeof payload.version !== 'number' || !payload.childPublicKey) {
    console.warn('[bare] policy:update ignored: invalid payload (missing version or childPublicKey)')
    return
  }

  // Merge pinHashes so that each parent's PIN survives the other parent's policy push.
  // If the incoming payload has legacy pinHash but no pinHashes (sender running old code),
  // convert it using the sender's identity key.
  if (payload.pinHash && (!payload.pinHashes || Object.keys(payload.pinHashes).length === 0) && senderKey) {
    payload.pinHashes = { [senderKey]: payload.pinHash }
  }
  const existing = await db.get('policy').catch(() => null)
  const existingVersion = (existing && existing.value && typeof existing.value.version === 'number')
    ? existing.value.version
    : -1
  // Reject pushes older than what we already have. A parent reconnecting with
  // stale local state (its co-parent edited while it was offline) would otherwise
  // overwrite the newer policy and the relay would propagate the rollback to
  // every other parent.
  if (payload.version < existingVersion) {
    console.warn('[bare] policy:update ignored: stale version', payload.version, '<', existingVersion, 'from', senderKey?.slice(0, 8))
    return
  }
  const existingPinHashes = (existing && existing.value && existing.value.pinHashes) || {}
  const incomingPinHashes = payload.pinHashes || {}
  payload.pinHashes = { ...existingPinHashes, ...incomingPinHashes }
  delete payload.pinHash  // ensure legacy field is cleaned up

  await db.put('policy', payload)
  // Use method format (not event) so the RN shell routes this to
  // NativeModules.UsageStatsModule.setPolicy() via the msg.method === 'native:setPolicy' branch
  // in the bare IPC data handler (app/index.tsx ~line 162).
  // Sending as a type:'event' would only forward it to the WebView, never to the native module.
  send({ method: 'native:setPolicy', args: { json: JSON.stringify(payload) } })
  send({ type: 'event', event: 'policy:updated', data: payload })

  // Relay the policy to all OTHER parents so co-parents stay in sync.
  // The child is the policy sync hub - when any parent pushes a policy, the
  // child stores it, enforces it, and relays it to the other parent(s).
  if (sendToAllParents && senderKey) {
    sendToAllParents({ type: 'policy:update', payload }, senderKey)
  }

  // Sync pending req:* entries with the new policy so ChildRequests shows the correct status.
  // This handles the case where app:decision was not delivered directly (e.g., child was offline
  // and the parent's decision arrives via the policy:update pushed on reconnect).
  // Only resolve a pending request if the app's status ACTUALLY CHANGED vs. the prior policy.
  // Otherwise a parent re-pushing its cached policy on reconnect would auto-deny any pending
  // request whose app was already blocked (#137).
  const apps = payload.apps || {}
  const prevApps = (existing && existing.value && existing.value.apps) || {}
  for await (const { key, value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
    if (value.status !== 'pending') continue
    const appEntry = apps[value.packageName]
    const appStatus = appEntry && appEntry.status
    const prevStatus = prevApps[value.packageName] && prevApps[value.packageName].status
    if (appStatus === prevStatus) continue
    if (appStatus === 'allowed' || appStatus === 'blocked') {
      const newStatus = appStatus === 'allowed' ? 'approved' : 'denied'
      await db.put(key, { ...value, status: newStatus })
      send({ type: 'event', event: 'request:updated', data: {
        requestId: value.id, status: newStatus,
        packageName: value.packageName, appName: value.appName || value.packageName,
      } })
      // Broadcast resolution to all parents so co-parent activity lists update (#122)
      if (sendToAllParents) {
        sendToAllParents({ type: 'request:resolved', payload: { requestId: value.id, status: newStatus, packageName: value.packageName, appName: value.appName, resolvedAt: Date.now() } })
      }
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
async function handleTimeExtend (payload, db, send, sendToAllParents) {
  const { requestId, packageName, extraSeconds } = payload
  if (!requestId || !packageName || typeof extraSeconds !== 'number') {
    console.warn('[bare] time:extend: malformed payload, dropping')
    return
  }

  const expiresAt = Date.now() + extraSeconds * 1000
  const grant = { packageName, grantedAt: Date.now(), expiresAt, source: 'parent-approved' }

  // Update request status in Hyperbee
  const existing = await db.get(requestId)
  let appName = null
  if (existing) {
    const req = existing.value
    appName = req.appName || null
    req.status = 'approved'
    req.expiresAt = expiresAt
    await db.put(requestId, req)
  }

  // Store grant to Hyperbee so overrides:list can find it (#61)
  grant.appName = appName || packageName
  await db.put('override:' + packageName + ':' + grant.grantedAt, grant)

  // Notify native to grant override
  send({ method: 'native:grantOverride', args: grant })

  // Notify WebView — include appName/packageName so the decision notification (#67 fix)
  // can show the real app name instead of "an app".
  send({ type: 'event', event: 'override:granted', data: grant })
  send({ type: 'event', event: 'request:updated', data: { requestId, packageName, appName, status: 'approved', expiresAt } })

  // Broadcast resolution to all parents so co-parent activity lists update (#122)
  if (sendToAllParents) {
    sendToAllParents({ type: 'request:resolved', payload: { requestId, status: 'approved', packageName, appName: appName || packageName, resolvedAt: Date.now() } })
  }
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
  const { packageName, appName, iconBase64, category, exeBasename } = payload
  if (!packageName) {
    console.warn('[bare] app:installed from child: missing packageName')
    return
  }

  const raw = await db.get('policy:' + childPublicKey)
  const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
  if (!policy.apps) policy.apps = {}

  // Ensure pinHash is present — same gap as handleIncomingAppsSync after a re-pair.
  if (!policy.pinHash) {
    const parentPolicy = await db.get('policy').catch(() => null)
    if (parentPolicy?.value?.pinHash) policy.pinHash = parentPolicy.value.pinHash
  }

  if (!policy.apps[packageName]) {
    const now = Date.now()
    policy.apps[packageName] = { status: 'pending', appName: appName || packageName, addedAt: now, ...(iconBase64 && { iconBase64 }), ...(category && { category }), ...(exeBasename && { exeBasename }) }
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

  // Ensure pinHash is always present — it may be missing if the child was removed and
  // re-paired (child policy deleted by unpair, then recreated fresh here with no pinHash).
  if (!policy.pinHash) {
    const parentPolicy = await db.get('policy').catch(() => null)
    if (parentPolicy?.value?.pinHash) policy.pinHash = parentPolicy.value.pinHash
  }

  const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
  const childDisplayName = peerRecord?.value?.displayName || 'Your child'

  let newCount = 0
  let iconUpdateCount = 0
  // Use a single timestamp for the whole batch so apps from the same sync
  // sort together by date rather than getting subtly different millisecond values.
  const batchAddedAt = Date.now()
  const newApps = []
  for (const { packageName, appName, iconBase64, category } of apps) {
    if (!policy.apps[packageName]) {
      policy.apps[packageName] = { status: isFirstSync ? 'allowed' : 'pending', appName: appName || packageName, addedAt: batchAddedAt, ...(iconBase64 && { iconBase64 }), ...(category && { category }) }
      newApps.push({ packageName, appName: appName || packageName })
      newCount++
    } else {
      // Back-fill icon and category for apps already in the policy
      if (iconBase64 && !policy.apps[packageName].iconBase64) {
        policy.apps[packageName].iconBase64 = iconBase64
        iconUpdateCount++
      }
      if (category && !policy.apps[packageName].category) {
        policy.apps[packageName].category = category
        iconUpdateCount++ // reuse counter — any metadata backfill triggers a save
      }
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
  const { requestId, packageName, appName: payloadAppName, requestedAt, requestType, extraSeconds } = payload
  if (!requestId || !packageName) {
    console.warn('[bare] time:request from child: missing fields')
    return
  }

  // Deduplicate: re-delivered messages (from queue flush after reconnect) should not
  // fire a second notification or create a duplicate entry.
  const existing = await db.get('request:' + requestId).catch(() => null)
  if (existing) return

  // Look up child display name; prefer app name from payload (sent by child) over policy cache
  const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
  const childDisplayName = peerRecord ? (peerRecord.value.displayName || 'Child') : 'Child'
  const childPolicyRaw = await db.get('policy:' + childPublicKey).catch(() => null)
  const policyAppName = childPolicyRaw && childPolicyRaw.value.apps && childPolicyRaw.value.apps[packageName]
    ? childPolicyRaw.value.apps[packageName].appName
    : null
  const appName = payloadAppName || policyAppName || packageName

  const resolvedType = requestType === 'extra_time' ? 'extra_time' : 'approval'
  const request = { id: requestId, packageName, appName, requestedAt, status: 'pending', notified: false, childPublicKey, childDisplayName, requestType: resolvedType }
  if (resolvedType === 'extra_time' && typeof extraSeconds === 'number') request.extraSeconds = extraSeconds
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
  const { packageName, appName: payloadAppName } = payload
  if (!packageName) {
    console.warn('[bare] app:uninstalled from child: missing packageName')
    return
  }

  const raw = await db.get('policy:' + childPublicKey)
  if (!raw) return

  const policy = raw.value
  if (!policy.apps || !policy.apps[packageName]) return

  // Prefer the label the child sent; fall back to parent's cached policy (#71)
  const appName = payloadAppName || policy.apps[packageName].appName || packageName

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

/**
 * Handle a `request:resolved` P2P message from a child peer.
 * Updates the parent's local request entry so the activity list stays in sync (#122).
 *
 * @param {object} payload - { requestId, status, packageName, resolvedAt }
 * @param {object} db - Hyperbee instance
 * @param {function} send - bare->RN IPC send function
 */
async function handleRequestResolved (payload, db, send, childPublicKey) {
  const { requestId, status, packageName, appName, resolvedAt } = payload
  if (!requestId || !status) return

  const existing = await db.get('request:' + requestId).catch(() => null)

  // If the request already has a non-pending status, nothing to update.
  if (existing && existing.value.status !== 'pending') return

  if (existing) {
    // Normal path: update the existing pending entry. Backfill appName if missing
    // (older entries created via the defence-in-depth path may not have it).
    const merged = { ...existing.value, status, resolvedAt }
    if (!merged.appName && appName) merged.appName = appName
    await db.put('request:' + requestId, merged)
  } else {
    // Defence-in-depth: this parent never received the original time:request
    // (e.g. was offline during submission and reconnect message ordering lost it).
    // Create a minimal entry so the activity list shows the resolved request (#122).
    // Include childPublicKey so alerts:list can filter by child.
    const peerRecord = childPublicKey ? await db.get('peers:' + childPublicKey).catch(() => null) : null
    const childDisplayName = peerRecord?.value?.displayName || 'Child'
    console.log('[bare] request:resolved creating missing entry for', requestId, 'child:', childPublicKey?.slice(0, 8))
    await db.put('request:' + requestId, {
      id: requestId,
      packageName: packageName || 'unknown',
      appName: appName || packageName || 'unknown',
      status,
      resolvedAt,
      requestedAt: resolvedAt || Date.now(),
      notified: true,
      childPublicKey: childPublicKey || null,
      childDisplayName,
    })
  }
  send({ type: 'event', event: 'request:updated', data: { requestId, status, packageName, appName } })
}

module.exports = { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingAppUninstalled, handleIncomingAppsSync, handleIncomingTimeRequest, handleRequestResolved, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue }