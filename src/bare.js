// src/bare.js
//
// Bare worklet entry point. Runs inside the Bare runtime launched by BareKit.
// Do NOT use Node.js APIs (path, fs, etc.) — use bare-* equivalents.
// Communicates with the RN shell via BareKit.IPC (JSON-over-newline).

// Return YYYY-MM-DD in local time (not UTC) so session date keys
// match the user's calendar day regardless of timezone.
function localDateStr(ts) {
  const d = new Date(ts || Date.now())
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

const Hyperbee   = require('hyperbee')
const Hypercore  = require('hypercore')
const Hyperswarm = require('hyperswarm')
const sodium     = require('sodium-native')
const b4a        = require('b4a')
const { generateKeypair, sign, verify } = require('./identity')
const { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingAppUninstalled, handleIncomingAppsSync, handleIncomingTimeRequest, queueMessage, flushMessageQueue } = require('./bare-dispatch')
const { signMessage, verifyMessage } = require('./message')

// ── State ─────────────────────────────────────────────────────────────────────

let db           = null   // Hyperbee (local persistence)
let core         = null   // Hypercore backing the Hyperbee
let swarm        = null   // Hyperswarm instance
let identity     = null   // { publicKey: Buffer, secretKey: Buffer }
let mode         = null   // 'parent' | 'child' | null
let dispatch     = null   // method dispatch function
let _initialized = false  // guard against re-running init on component remount

// Peers map: hex(publicKey) → { publicKey: Buffer, displayName: string, conn: object }
const peers = new Map()

// Parent connections (child mode only) — Map<identityKeyHex, { conn, remoteKeyHex, displayName, topicHex }>
const parentPeers = new Map()

// ── IPC helpers ───────────────────────────────────────────────────────────────

const send = (msg) => BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))

let _buf = ''

BareKit.IPC.on('data', chunk => {
  _buf += chunk.toString()
  const lines = _buf.split('\n')
  _buf = lines.pop()
  for (const line of lines) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch (e) {
      console.error('[bare] IPC parse error:', e.message)
      continue
    }
    if (msg.method === 'init') {
      init(msg.dataDir).catch(e => console.error('[bare] init error:', e.message))
    } else {
      handleDispatch(msg.method, msg.args ?? [], msg.id)
    }
  }
})

async function handleDispatch (method, args, id) {
  try {
    const result = await dispatch(method, args)
    send({ type: 'response', id, result })
  } catch (e) {
    console.error('[bare] dispatch error:', method, e.message)
    send({ type: 'response', id, error: e.message })
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init (dataDir, attempt = 0) {
  // Idempotent: if already initialized, just re-emit 'ready' so the remounted
  // RN component can set dbReady=true without reopening the Hypercore.
  if (_initialized) {
    send({ type: 'event', event: 'ready', data: {
      publicKey: b4a.toString(identity.publicKey, 'hex'),
      mode,
    }})
    return
  }

  // Open (or create) the local Hypercore + Hyperbee.
  // Retry up to 20 times on lock errors — Bare may restart before the previous
  // instance releases the Hypercore lock file.
  try {
    core = new Hypercore(dataDir + '/pearguard/core')
    await core.ready()
  } catch (e) {
    if (e.message && e.message.includes('lock') && attempt < 20) {
      console.warn('[bare] init lock retry', attempt + 1, e.message)
      await new Promise(r => setTimeout(r, 1000))
      return init(dataDir, attempt + 1)
    }
    throw e
  }

  _initialized = true
  db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()

  // Load or generate identity
  const storedIdentity = await db.get('identity')
  if (storedIdentity) {
    identity = {
      publicKey: b4a.from(storedIdentity.value.publicKey, 'hex'),
      secretKey: b4a.from(storedIdentity.value.secretKey, 'hex'),
    }
  } else {
    identity = generateKeypair()
    await db.put('identity', {
      publicKey: b4a.toString(identity.publicKey, 'hex'),
      secretKey: b4a.toString(identity.secretKey, 'hex'),
      createdAt: Date.now(),
    })
  }

  // Load mode
  const storedMode = await db.get('mode')
  mode = storedMode ? storedMode.value : null

  // Build dispatch with live context
  dispatch = createDispatch({ db, identity, swarm, peers, send, sign, verify, b4a, mode,
    joinTopic, sendToPeer, sendToParent, sodium,
    onModeChange: (m) => { mode = m },
    getMode: () => mode,
    resetParentConnection: (identityKey) => {
      if (identityKey) parentPeers.delete(identityKey)
      else parentPeers.clear()
    } })

  // Rejoin any persisted swarm topics so peers can reconnect after app restart.
  // Run all joins in parallel — each swarm.flush() blocks ~5s waiting for DHT
  // acknowledgement, so sequential joins multiply that delay by topic count.
  //
  // Prune orphaned topics first (#75): topics left behind after remove/unpair
  // inflate startup time by ~5s each. A topic is orphaned if no paired peer
  // references it. Only prune when there are paired peers — if there are none,
  // we may be mid-invite and shouldn't touch the topic.
  const activePeerTopics = new Set()
  for await (const { value } of db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
    if (value && value.swarmTopic) activePeerTopics.add(value.swarmTopic)
  }
  const topicHexes = []
  for await (const { key, value } of db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
    if (!value || !value.topicHex) continue
    if (activePeerTopics.size > 0 && !activePeerTopics.has(value.topicHex)) {
      console.log('[bare] pruning orphaned topic at startup:', value.topicHex.slice(0, 8))
      await db.del(key).catch(() => {})
    } else {
      topicHexes.push(value.topicHex)
    }
  }
  await Promise.all(topicHexes.map(t => joinTopic(t).catch(() => {})))

  // Clean up usage data older than 30 days
  async function cleanupOldUsageData() {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)
    const cutoffStr = localDateStr(cutoff)
    const cutoffMs = cutoff.getTime()

    for await (const { key } of db.createReadStream({ gt: 'sessions:', lt: 'sessions:~' })) {
      const parts = key.split(':')
      if (parts.length >= 3 && parts[2] < cutoffStr) {
        await db.del(key)
      }
    }
    for await (const { key } of db.createReadStream({ gt: 'usageReport:', lt: 'usageReport:~' })) {
      const parts = key.split(':')
      if (parts.length >= 3) {
        const ts = parseInt(parts[2], 10)
        if (ts < cutoffMs) await db.del(key)
      }
    }
    for await (const { key } of db.createReadStream({ gt: 'usage:', lt: 'usage:~' })) {
      const parts = key.split(':')
      if (parts.length === 2) {
        const ts = parseInt(parts[1], 10)
        if (ts < cutoffMs) await db.del(key)
      }
    }
  }

  // One-time migration: re-key sessions from UTC dates to local dates.
  // Previous versions used toISOString().slice(0,10) (UTC) for the date
  // portion of session keys. Re-derive the date from each session's startedAt
  // so the key matches the user's local calendar day.
  async function migrateSessionDatesToLocal() {
    const migrated = await db.get('_migration:sessionLocalDates').catch(() => null)
    if (migrated) return
    const toDelete = []
    const toWrite = new Map()
    for await (const { key, value } of db.createReadStream({ gt: 'sessions:', lt: 'sessions:~' })) {
      if (!Array.isArray(value) || value.length === 0) continue
      const parts = key.split(':')
      // key format: sessions:{childPublicKey}:{dateStr}:{timestamp}
      if (parts.length < 4) continue
      const childPk = parts[1]
      const oldDate = parts[2]
      const ts = parts[3]
      // Derive correct local date from first session's startedAt
      const firstSession = value[0]
      const correctDate = firstSession.startedAt ? localDateStr(new Date(firstSession.startedAt)) : oldDate
      if (correctDate !== oldDate) {
        const newKey = 'sessions:' + childPk + ':' + correctDate + ':' + ts
        const existing = toWrite.get(newKey) || []
        for (const s of value) existing.push(s)
        toWrite.set(newKey, existing)
        toDelete.push(key)
      }
    }
    for (const key of toDelete) await db.del(key)
    for (const [key, sessions] of toWrite) await db.put(key, sessions)
    await db.put('_migration:sessionLocalDates', { done: true, at: Date.now() })
    if (toDelete.length > 0) console.log('[bare] migrated', toDelete.length, 'session keys from UTC to local dates')
  }

  migrateSessionDatesToLocal().catch(e => console.error('[bare] session date migration error:', e))
  cleanupOldUsageData().catch(e => console.error('[bare] cleanup error:', e))
  setInterval(() => {
    cleanupOldUsageData().catch(e => console.error('[bare] cleanup error:', e))
  }, 24 * 60 * 60 * 1000)

  // Signal ready
  send({ type: 'event', event: 'ready', data: {
    publicKey: b4a.toString(identity.publicKey, 'hex'),
    mode,
  }})

  // Start 60-second heartbeat timer
  setInterval(() => {
    handleDispatch('heartbeat:send', {}, null)
  }, 60 * 1000)
}

// ── P2P / Hyperswarm ──────────────────────────────────────────────────────────

/**
 * Join a Hyperswarm topic. Called by the pairing flow (generateInvite / acceptInvite).
 * topic: 32-byte Buffer or hex string
 */
async function joinTopic (topicInput) {
  if (!swarm) {
    swarm = new Hyperswarm({ keyPair: identity })
    swarm.on('connection', onPeerConnection)
  }
  const topicBuf = typeof topicInput === 'string'
    ? b4a.from(topicInput, 'hex')
    : topicInput
  const topicHex = b4a.toString(topicBuf, 'hex')
  await swarm.join(topicBuf, { client: true, server: true })
  await swarm.flush()
  // Persist topic so we can rejoin on next app launch
  await db.put('topics:' + topicHex, { topicHex, joinedAt: Date.now() }).catch(() => {})
  send({ type: 'event', event: 'swarm:joined', data: { topic: topicHex } })
}

/**
 * Called for each new Hyperswarm peer connection.
 */
async function onPeerConnection (conn, info) {
  const remoteKeyHex = b4a.toString(conn.remotePublicKey, 'hex')
  const connTopicHex = info.topics && info.topics[0]
    ? b4a.toString(info.topics[0], 'hex')
    : null

  let peerBuf = ''
  conn.on('data', chunk => {
    peerBuf += chunk.toString()
    const lines = peerBuf.split('\n')
    peerBuf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        handlePeerMessage(msg, conn, remoteKeyHex)
      } catch (e) {
        console.error('[bare] peer message parse error:', e.message)
      }
    }
  })

  conn.on('error', e => {
    console.error('[bare] peer error:', e.message)
    // Remove from parentPeers if this was a parent connection
    if (mode === 'child') {
      for (const [ik, pp] of parentPeers) {
        if (pp.remoteKeyHex === remoteKeyHex) { parentPeers.delete(ik); break }
      }
    }
  })
  conn.on('close', () => {
    peers.delete(remoteKeyHex)
    // Remove from parentPeers if this was a parent connection
    if (mode === 'child') {
      for (const [ik, pp] of parentPeers) {
        if (pp.remoteKeyHex === remoteKeyHex) { parentPeers.delete(ik); break }
      }
    }
    send({ type: 'event', event: 'peer:disconnected', data: { remoteKey: remoteKeyHex } })
    // Signal Hyperswarm to expedite reconnection
    if (swarm) swarm.flush().catch(() => {})
  })

  // Store the connection for sending
  peers.set(remoteKeyHex, { conn, remoteKeyHex, displayName: null, topicHex: connTopicHex })
  send({ type: 'event', event: 'peer:connected', data: { remoteKey: remoteKeyHex } })

  // Child sends hello proactively on new connection — include real profile name + avatar
  if (mode === 'child') {
    const myIdentityHex = b4a.toString(identity.publicKey, 'hex')
    const profileRaw = await db.get('profile').catch(() => null)
    const profile = profileRaw ? profileRaw.value : {}
    const displayName = profile.displayName || 'Child Device'
    const avatarThumb = profile.avatar
      ? (profile.avatar.type === 'preset' ? 'preset:' + profile.avatar.id : profile.avatar.thumb64 || null)
      : null
    const hello = signMessage({
      type: 'hello',
      payload: { publicKey: myIdentityHex, displayName, avatarThumb },
    }, identity)
    peers.get(remoteKeyHex).sentHello = true
    conn.write(Buffer.from(JSON.stringify(hello) + '\n'))
  }
}

/**
 * Handle an incoming signed message from a peer.
 * Verifies signature against known peer identity. Drops unknown/invalid messages.
 */
async function handlePeerMessage (msg, conn, remoteKeyHex) {
  // Require the 'from' field to match the connection's remote key
  if (!msg.from || msg.from !== remoteKeyHex) {
    console.warn('[bare] dropped message: from mismatch')
    return
  }

  // Look up known peer — pairing handshake messages are handled before full verification
  const peer = peers.get(remoteKeyHex)
  if (!peer) return

  // For 'hello' messages (pairing handshake): we don't have the peer's pubkey yet —
  // but we DO know their Hyperswarm public key (NOISE key), which is different from their
  // Ed25519 identity key. We accept 'hello' only once and then store their identity key.
  if (msg.type === 'hello') {
    await handleHello(msg, conn, remoteKeyHex)
    return
  }

  // For all other messages: verify signature against stored identity key
  const storedPeer = await db.get('peers:' + msg.from).catch(() => null)
  if (!storedPeer) {
    console.warn('[bare] dropped message: unknown peer', msg.from.slice(0, 12))
    return
  }
  if (!verifyMessage(msg, msg.from)) {
    console.warn('[bare] dropped message: invalid signature from', msg.from.slice(0, 12))
    return
  }

  // Dispatch verified peer message by type
  switch (msg.type) {
    case 'policy:update':
      await handlePolicyUpdate(msg.payload, db, send)
      break
    case 'time:extend':
      await handleTimeExtend(msg.payload, db, send)
      break
    case 'request:denied': {
      // Parent denied an extra-time request — update the child-side req: entry and notify.
      const { requestId, packageName, appName } = msg.payload || {}
      if (requestId) {
        const existing = await db.get(requestId).catch(() => null)
        if (existing) {
          await db.put(requestId, { ...existing.value, status: 'denied' })
        }
      }
      send({ type: 'event', event: 'request:updated', data: { requestId, packageName, status: 'denied' } })
      // Trigger native notification (same channel as approval decisions)
      send({ method: 'native:showDecisionNotification', args: { appName: appName || packageName || 'the app', decision: 'denied' } })
      break
    }
    case 'app:decision':
      await handleAppDecision(msg.payload, db, send)
      break
    case 'app:installed':
      await handleIncomingAppInstalled(msg.payload, msg.from, db, send, sendToPeer)
      break
    case 'app:uninstalled':
      await handleIncomingAppUninstalled(msg.payload, msg.from, db, send)
      break
    case 'apps:sync':
      await handleIncomingAppsSync(msg.payload, msg.from, db, send, sendToPeer)
      break
    case 'time:request':
      await handleIncomingTimeRequest(msg.payload, msg.from, db, send)
      break
    case 'usage:report': {
      // Prefer the identity key carried in the signed payload (set by usage:flush on the child)
      // over msg.from (the Hyperswarm noise key), which may differ from the Ed25519 identity key.
      // usage:getLatest queries by child.publicKey (identity key), so both sides must agree.
      const childPublicKey = msg.payload.childPublicKey || msg.from
      await db.put('usageReport:' + childPublicKey + ':' + (msg.payload.timestamp || Date.now()), msg.payload)
      // Store session-level data for reports.
      // Sessions now cover the full day (from midnight), so overwrite
      // previous entries for today to avoid stale/duplicate data.
      const incomingSessions = msg.payload.sessions || []
      const dateStr = localDateStr(msg.payload.timestamp || Date.now())
      const sessionPrefix = 'sessions:' + childPublicKey + ':' + dateStr + ':'
      for await (const { key } of db.createReadStream({ gt: sessionPrefix, lt: sessionPrefix + '~' })) {
        await db.del(key)
      }
      if (incomingSessions.length > 0) {
        await db.put(sessionPrefix + (msg.payload.timestamp || Date.now()), incomingSessions)
      }
      // Look up icon for the current foreground app from parent's policy store
      let currentAppIcon = null
      if (msg.payload.currentAppPackage) {
        const policyRaw = await db.get('policy:' + childPublicKey).catch(() => null)
        const policyApps = policyRaw?.value?.apps || {}
        currentAppIcon = policyApps[msg.payload.currentAppPackage]?.iconBase64 || null
      }
      send({ type: 'event', event: 'usage:report', data: { ...msg.payload, childPublicKey, currentAppIcon } })
      break
    }
    case 'heartbeat': {
      const childPublicKey = msg.from
      const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
      const childDisplayName = peerRecord?.value?.displayName || 'Child'
      send({ type: 'event', event: 'heartbeat:received', data: { ...msg.payload, childPublicKey, childDisplayName } })
      break
    }
    case 'bypass:alert': {
      const childPublicKey = msg.from
      const { reason, detectedAt } = msg.payload
      const reasonLabels = {
        accessibility_disabled: 'Accessibility Service disabled',
        force_stopped: 'App was force-closed',
        device_admin_disabled: 'Device Admin disabled',
      }
      const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
      const childDisplayName = peerRecord?.value?.displayName || 'Child'
      const alertEntry = {
        id: 'bypass:' + detectedAt,
        type: 'bypass',
        timestamp: detectedAt,
        reason,
        appDisplayName: reasonLabels[reason] || reason,
        childPublicKey,
        childDisplayName,
      }
      await db.put('alert:' + childPublicKey + ':' + detectedAt, alertEntry)
      send({ type: 'event', event: 'alert:bypass', data: alertEntry })
      break
    }
    case 'pin:override': {
      // Child used PIN to bypass a blocked app — store alert on parent so it shows
      // in the Alerts tab and the parent can monitor PIN usage.
      const childPublicKey = msg.from
      const { packageName, appName, grantedAt, expiresAt } = msg.payload
      const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
      const childDisplayName = peerRecord?.value?.displayName || 'Your child'
      const alertEntry = {
        id: 'pin_override:' + grantedAt,
        type: 'pin_override',
        timestamp: grantedAt,
        packageName,
        appDisplayName: appName || packageName,
        childPublicKey,
        childDisplayName,
        expiresAt,
      }
      await db.put('alert:' + childPublicKey + ':' + grantedAt, alertEntry)
      // Store as override so parent's overrides:list shows it as active
      await db.put('override:' + childPublicKey + ':' + grantedAt, {
        packageName, appName: appName || packageName, childPublicKey,
        grantedAt, expiresAt, source: 'pin-verified',
      })
      send({ type: 'event', event: 'alert:pin_override', data: alertEntry })
      break
    }
    case 'unpair': {
      // Parent has removed this child — wipe all local state and return to setup.
      // Collect keys first, then delete: avoids Hyperbee deadlock from writing
      // inside a createReadStream iteration.
      const allKeys = []
      for await (const { key } of db.createReadStream()) {
        allKeys.push(key)
      }
      for (const key of allKeys) await db.del(key).catch(() => {})

      // Rotate to a fresh identity keypair immediately in memory and DB.
      // The old keypair may be listed as blocked on the parent (blocked:{oldPK}).
      // If we keep the old keypair in memory, the next connection attempt after
      // scanning a new invite will send hello with the old blocked PK — the parent
      // rejects it, sends unpair again, and the child is stuck in a reset loop.
      // A fresh keypair is not blocked, so re-pairing succeeds in one scan.
      //
      // IMPORTANT: mutate the existing identity object in place rather than
      // reassigning the variable. The dispatch context (createDispatch) holds a
      // reference to the same object via ctx.identity. Reassigning would leave
      // ctx.identity pointing to the old keypair, so identity:setName would
      // broadcast hello with the stale public key — causing signature mismatches
      // on the parent and silently dropping the name update.
      const newKeypair = generateKeypair()
      identity.publicKey = newKeypair.publicKey
      identity.secretKey = newKeypair.secretKey
      await db.put('identity', {
        publicKey:  b4a.toString(identity.publicKey, 'hex'),
        secretKey:  b4a.toString(identity.secretKey, 'hex'),
      })

      // Destroy the in-memory Hyperswarm so it stops auto-reconnecting on old topics.
      // joinTopic() recreates the swarm lazily when the child scans a new invite.
      if (swarm) {
        try { await swarm.destroy() } catch (_e) {}
        swarm = null
      }
      peerConnected = false
      parentPeer = null

      send({ type: 'event', event: 'child:reset', data: {} })
      break
    }
    default:
      send({ type: 'event', event: 'peer:message', data: msg })
      break
  }
}

/**
 * Send a signed message to a connected peer.
 * @param {string} remoteKeyHex — the peer's Hyperswarm public key (hex)
 * @param {{ type: string, payload: object }} msg
 */
function sendToPeer (remoteKeyHex, msg) {
  const peer = peers.get(remoteKeyHex)
  if (!peer || !peer.conn) {
    throw new Error('peer not connected: ' + remoteKeyHex.slice(0, 12))
  }
  const signed = signMessage(msg, identity)
  peer.conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
}

/**
 * Send a message to the connected parent.
 * - If connected: send immediately. No queuing — avoids duplicate delivery when the
 *   connection is active (queue would be flushed again on next handleHello).
 * - If not connected or send fails: queue in Hyperbee for reconnect delivery.
 * Child mode only.
 * @param {{ type: string, payload: object }} message
 */
async function sendToParent (message) {
  if (peerConnected && parentPeer && parentPeer.conn) {
    try {
      const signed = signMessage(message, identity)
      parentPeer.conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
      return  // Sent immediately; queuing would cause a duplicate on next reconnect
    } catch (e) {
      // Write failed — connection was dead; fall through to queue
      peerConnected = false
      parentPeer = null
    }
  }
  // Not connected (or send failed): queue for delivery on next handleHello
  await queueMessage(message, db)
}

/**
 * Flush all queued messages to the parent connection and clear the queue.
 * @param {object} conn — the parent peer's connection stream
 */
async function flushPendingMessages (conn) {
  const count = await flushMessageQueue(db, (message) => {
    const signed = signMessage(message, identity)
    conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
  })
  if (count > 0) {
    console.log('[bare] flushed', count, 'queued messages to parent')
  }
}

async function handleHello (msg, conn, remoteKeyHex) {
  const { publicKey: peerIdentityKeyHex, displayName, avatarThumb } = msg.payload ?? {}
  if (!peerIdentityKeyHex || typeof peerIdentityKeyHex !== 'string') {
    console.warn('[bare] invalid hello: missing publicKey')
    return
  }

  // Verify signature using the declared identity key
  if (!verifyMessage(msg, peerIdentityKeyHex)) {
    console.warn('[bare] invalid hello: bad signature')
    return
  }

  // Reject blocked peers (previously unpaired by parent).
  // Send them the 'unpair' message before closing so they can wipe their state
  // even if they were offline when the parent originally ran child:unpair.
  const blockedEntry = await db.get('blocked:' + peerIdentityKeyHex).catch(() => null)
  if (blockedEntry) {
    console.warn('[bare] rejected hello from blocked peer:', peerIdentityKeyHex.slice(0, 8))
    // Send 'unpair' so the child can wipe its state even if it was offline when the
    // parent originally ran child:unpair. Don't destroy immediately — let the write
    // flush through. The child will close the connection after processing unpair.
    try {
      const signed = signMessage({ type: 'unpair', payload: {} }, identity)
      conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
    } catch (_e) { /* connection may already be closing */ }
    return
  }

  // Store peer identity — preserve original pairedAt, update lastSeen
  const existingRecord = await db.get('peers:' + peerIdentityKeyHex).catch(() => null)

  // If this is a new identity key (never seen before), clean up any stale Hyperbee
  // entry that previously claimed this noise key. This handles the case where a child
  // reinstalls / clears data and re-pairs with a fresh identity: the old peers:* entry
  // would otherwise persist and show as a duplicate in the children list (#74).
  if (!existingRecord) {
    for await (const { key, value } of db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
      if (value && value.noiseKey === remoteKeyHex && value.publicKey !== peerIdentityKeyHex) {
        console.log('[bare] removing stale peer entry that claimed this noise key:', value.publicKey?.slice(0, 8))
        await db.del(key).catch(() => {})
      }
    }
  }

  const inMemoryPeer = peers.get(remoteKeyHex)
  const peerRecord = {
    ...(existingRecord ? existingRecord.value : {}),
    publicKey:   peerIdentityKeyHex,
    displayName: displayName ?? 'Unknown',
    avatarThumb: avatarThumb || (existingRecord ? existingRecord.value.avatarThumb : null) || null,
    pairedAt:    existingRecord ? existingRecord.value.pairedAt : Date.now(),
    lastSeen:    Date.now(),
    noiseKey:    remoteKeyHex,
    ...(inMemoryPeer && inMemoryPeer.topicHex ? { swarmTopic: inMemoryPeer.topicHex } : {}),
  }
  await db.put('peers:' + peerIdentityKeyHex, peerRecord)

  // Re-check blocked status after writing — a concurrent child:unpair could have written
  // blocked: after our initial check above but before we stored the peer. If so, undo
  // the write and re-deliver unpair so the child resets even if it missed the original.
  const laterBlock = await db.get('blocked:' + peerIdentityKeyHex).catch(() => null)
  if (laterBlock) {
    console.warn('[bare] peer blocked during hello handshake, re-unpairing:', peerIdentityKeyHex.slice(0, 8))
    await db.del('peers:' + peerIdentityKeyHex).catch(() => {})
    try {
      const signed = signMessage({ type: 'unpair', payload: {} }, identity)
      conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
    } catch (_e) { /* connection may already be closing */ }
    return
  }

  // Evict any stale in-memory entry that already maps to this identity key
  // under a different noise key. This prevents duplicate "online" entries when
  // the parent restarts and establishes a new connection while an old connection
  // lingers in the peers map (#74).
  for (const [existingNoiseKey, existingPeer] of peers) {
    if (existingNoiseKey !== remoteKeyHex && existingPeer.identityKey === peerIdentityKeyHex) {
      console.log('[bare] evicting stale peer entry for', peerIdentityKeyHex.slice(0, 8), 'noise:', existingNoiseKey.slice(0, 8))
      peers.delete(existingNoiseKey)
      try { existingPeer.conn.destroy() } catch (_e) {}
    }
  }

  // Update the in-memory peers map with the identity key
  const peer = peers.get(remoteKeyHex)
  if (peer) {
    peer.identityKey = peerIdentityKeyHex
    peer.displayName = displayName ?? 'Unknown'
  }

  const isFirstPairing = !existingRecord
  console.log('[bare] paired with:', peerIdentityKeyHex.slice(0, 12), displayName, isFirstPairing ? '(new)' : '(reconnect)')
  send({ type: 'event', event: 'peer:paired', data: peerRecord })

  // Notify the parent UI that a child has connected
  if (mode === 'parent') {
    // Emit child:connected only for first-time pairings; child:reconnected for subsequent reconnects
    const eventName = isFirstPairing ? 'child:connected' : 'child:reconnected'
    send({ type: 'event', event: eventName, data: peerRecord })

    // Push the latest stored policy to the child so enforcement stays current
    const storedPolicy = await db.get('policy:' + peerIdentityKeyHex).catch(() => null)
    if (storedPolicy && storedPolicy.value) {
      try {
        sendToPeer(remoteKeyHex, { type: 'policy:update', payload: storedPolicy.value })
        console.log('[bare] sent stored policy to child:', peerIdentityKeyHex.slice(0, 12))
      } catch (e) {
        console.warn('[bare] could not send stored policy:', e.message)
      }
    }

    // Backfill notifications missed while the parent was force-stopped.
    // Scan for pending requests from this child that never had their notification
    // shown (notified: false). Re-emitting time:request:received causes index.tsx
    // to show the native notification and then call request:markNotified.
    if (!isFirstPairing) {
      try {
        const missed = []
        for await (const { value } of db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value && value.childPublicKey === peerIdentityKeyHex &&
              value.status === 'pending' && value.notified === false) {
            missed.push(value)
          }
        }
        if (missed.length > 0) {
          console.log('[bare] backfilling', missed.length, 'unnotified request(s) for child:', peerIdentityKeyHex.slice(0, 12))
          for (const req of missed) {
            send({ type: 'event', event: 'time:request:received', data: req })
          }
        }
      } catch (e) {
        console.warn('[bare] reconnect backfill scan failed:', e.message)
      }
    }
  }

  // Send our own hello back (if we haven't already) — include real profile name + avatar
  const alreadySentHello = peer?.sentHello
  if (!alreadySentHello) {
    if (peer) peer.sentHello = true
    const myIdentityHex = b4a.toString(identity.publicKey, 'hex')
    const profileRaw = await db.get('profile').catch(() => null)
    const myProfile = profileRaw ? profileRaw.value : {}
    const myDisplayName = myProfile.displayName || 'PearGuard Device'
    const myAvatarThumb = myProfile.avatar
      ? (myProfile.avatar.type === 'preset' ? 'preset:' + myProfile.avatar.id : myProfile.avatar.thumb64 || null)
      : null
    const hello = signMessage({
      type: 'hello',
      payload: { publicKey: myIdentityHex, displayName: myDisplayName, avatarThumb: myAvatarThumb },
    }, identity)
    conn.write(Buffer.from(JSON.stringify(hello) + '\n'))
  }

  // If we're the child, check if this is our pending parent
  if (mode === 'child') {
    const pendingParent = await db.get('pendingParent').catch(() => null)
    if (pendingParent && pendingParent.value.publicKey === peerIdentityKeyHex) {
      await db.del('pendingParent').catch(() => {})
    }

    // Track this parent connection
    const peerEntry = peers.get(remoteKeyHex)
    parentPeers.set(peerIdentityKeyHex, {
      conn: peerEntry.conn,
      remoteKeyHex,
      displayName: displayName ?? 'Parent',
      topicHex: peerEntry.topicHex,
    })
    await flushPendingMessages(conn)

    // Re-send any pending time requests from the child's own Hyperbee.
    // If the parent was force-stopped while the TCP socket appeared alive, the
    // write succeeded locally but was never received — the message was NOT queued
    // in pendingMessages. Re-sending from req:* covers that gap.
    // The parent's handleIncomingTimeRequest deduplicates via request:requestId,
    // so re-sending a request the parent already has is safe (it becomes a no-op).
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000 // ignore requests older than 24 h
      let resent = 0
      for await (const { value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
        if (!value || value.status !== 'pending' || value.requestedAt < cutoff) continue
        const p2pPayload = {
          requestId: value.id,
          packageName: value.packageName,
          appName: value.appName,
          requestedAt: value.requestedAt,
          requestType: value.requestType,
        }
        if (value.requestType === 'extra_time' && typeof value.extraSeconds === 'number') {
          p2pPayload.extraSeconds = value.extraSeconds
        }
        const signed = signMessage({ type: 'time:request', payload: p2pPayload }, identity)
        conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
        resent++
      }
      if (resent > 0) console.log('[bare] re-sent', resent, 'pending request(s) to parent on reconnect')
    } catch (e) {
      console.warn('[bare] pending request resend failed:', e.message)
    }

    // Ask RN shell to scan installed apps and relay each as app:installed
    send({ type: 'event', event: 'apps:syncRequested', data: {} })
    // Ask RN shell to gather usage stats and send a fresh report to the parent
    send({ type: 'event', event: 'usageFlushRequested', data: {} })
  }
}

// Signal that bare.js has loaded (before init is called)
send({ type: 'event', event: 'bareReady', data: {} })