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
const { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingAppUninstalled, handleIncomingAppsSync, handleIncomingTimeRequest, handleRequestResolved, queueMessage, flushMessageQueue } = require('./bare-dispatch')
const { signMessage, verifyMessage } = require('./message')

// ── State ─────────────────────────────────────────────────────────────────────

let db           = null   // Hyperbee (local persistence)
let core         = null   // Hypercore backing the Hyperbee
let swarm        = null   // Hyperswarm instance
let identity     = null   // { publicKey: Buffer, secretKey: Buffer }
let mode         = null   // 'parent' | 'child' | null
let dispatch     = null   // method dispatch function
let _initialized = false  // guard against re-running init on component remount
let _dataDir     = null   // Absolute data dir (set in init); used by storage breakdown/reclaim
let _rebuildBusy = false  // Single-flight guard for storage reclaim
let _dispatchCtx = null   // Captured ctx object so storage rebuild can swap db reference

// Peers map: hex(publicKey) → { publicKey: Buffer, displayName: string, conn: object }
const peers = new Map()

// Parent connections (child mode only) — Map<identityKeyHex, { conn, remoteKeyHex, displayName, topicHex }>
const parentPeers = new Map()

// Known peer identity keys that have been stored via db.put('peers:' + key).
// Used as a fallback in children:list when Hyperbee's createReadStream misses
// recently-written records due to B-tree snapshot timing.
const knownPeerKeys = new Set()

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
  _dataDir = dataDir
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
  _dispatchCtx = { db, identity, swarm, peers, send, sign, verify, b4a, mode,
    joinTopic, sendToPeer, sendToAllParents, sodium, knownPeerKeys,
    onModeChange: (m) => { mode = m },
    getMode: () => mode,
    resetParentConnection: (identityKey) => {
      if (identityKey) parentPeers.delete(identityKey)
      else parentPeers.clear()
    },
    storageBreakdown: () => storageBreakdown(),
    analyzeStorage: () => analyzeStorage(),
    rebuildLocalDb: () => rebuildLocalDb(),
  }
  dispatch = createDispatch(_dispatchCtx)

  // Rejoin any persisted swarm topics so peers can reconnect after app restart.
  // Run all joins in parallel — each swarm.flush() blocks ~5s waiting for DHT
  // acknowledgement, so sequential joins multiply that delay by topic count.
  //
  // Prune orphaned topics first (#75): topics left behind after remove/unpair
  // inflate startup time by ~5s each. A topic is orphaned if no paired peer
  // references it. Only prune when there are paired peers — if there are none,
  // we may be mid-invite and shouldn't touch the topic.
  // Self-heal peer records missing swarmTopic by binding them to an orphan topic
  // (a topics:* entry not referenced by any other peer). This repairs state left
  // behind by previous pair cycles where the parent's peer record was written
  // without a swarmTopic because Hyperswarm delivered empty info.topics[] (#147).
  const peersMissingTopic = []
  const activePeerTopics = new Set()
  for await (const { key, value } of db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
    if (value && value.publicKey) knownPeerKeys.add(value.publicKey)
    if (value && value.swarmTopic) activePeerTopics.add(value.swarmTopic)
    else if (value) peersMissingTopic.push({ key, value })
  }
  if (peersMissingTopic.length > 0) {
    const orphanTopics = []
    for await (const { value } of db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
      if (value && value.topicHex && !activePeerTopics.has(value.topicHex)) {
        orphanTopics.push(value.topicHex)
      }
    }
    if (peersMissingTopic.length === 1 && orphanTopics.length === 1) {
      const healed = { ...peersMissingTopic[0].value, swarmTopic: orphanTopics[0] }
      await db.put(peersMissingTopic[0].key, healed).catch(() => {})
      activePeerTopics.add(orphanTopics[0])
      console.log('[bare] healed peer', peersMissingTopic[0].key, 'with topic', orphanTopics[0].slice(0, 8))
    } else if (orphanTopics.length > 1) {
      // Ambiguous (multiple orphan topics, e.g. install/pair cycles left leftovers):
      // we can't know which topic belongs to which peer. Drop the orphans and their
      // persisted records so we stop announcing on topics no peer uses. Affected peers
      // will need to re-pair — which is already the only known recovery path.
      console.warn('[bare] cannot auto-heal:', peersMissingTopic.length, 'peers missing topic,',
        orphanTopics.length, 'orphan topics — dropping orphans, re-pair required')
      for (const t of orphanTopics) {
        await db.del('topics:' + t).catch(() => {})
      }
    }
  }
  const topicHexSet = new Set()
  for await (const { key, value } of db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
    if (!value || !value.topicHex) continue
    if (activePeerTopics.size > 0 && !activePeerTopics.has(value.topicHex)) {
      console.log('[bare] pruning orphaned topic at startup:', value.topicHex.slice(0, 8))
      await db.del(key).catch(() => {})
    } else {
      topicHexSet.add(value.topicHex)
    }
  }
  // Backfill: rejoin any peer's swarmTopic even if the topics:* record was
  // never persisted (older pairings predate topic persistence — #144).
  for (const t of activePeerTopics) topicHexSet.add(t)
  const topicHexes = [...topicHexSet]
  console.log('[bare] rejoining', topicHexes.length, 'topic(s) on startup (async)')
  // Fire-and-forget: swarm.flush() blocks ~5s per topic on DHT ack, which would
  // delay the 'ready' event (and therefore the UI) by that much. Peers reconnect
  // as soon as the joins complete in the background.
  Promise.all(topicHexes.map(t => joinTopic(t).catch(e => console.error('[bare] rejoin failed:', e.message))))

  // Clean up usage data older than 7 days
  async function cleanupOldUsageData() {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 7)
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

  // Auto-reclaim when the Hypercore on-disk footprint exceeds AUTO_RECLAIM_THRESHOLD.
  // Hyperbee deletes leave tombstones in the append-only log, so scheduled cleanup
  // alone cannot shrink disk use; a full core rebuild is required.
  const AUTO_RECLAIM_THRESHOLD = 75 * 1024 * 1024
  async function maybeAutoReclaim () {
    try {
      const { total } = await storageBreakdown()
      if (total < AUTO_RECLAIM_THRESHOLD) return
      console.log('[bare] auto-reclaim triggered: on-disk', total, 'bytes exceeds threshold')
      const result = await rebuildLocalDb()
      console.log('[bare] auto-reclaim freed', result.freed, 'bytes (kept', result.kept, 'dropped', result.dropped + ')')
      send({ type: 'event', event: 'storage:autoReclaimed', data: result })
    } catch (e) {
      console.error('[bare] auto-reclaim error:', e.message)
    }
  }

  async function runDailyMaintenance () {
    await cleanupOldUsageData().catch(e => console.error('[bare] cleanup error:', e))
    await maybeAutoReclaim()
  }

  runDailyMaintenance()
  setInterval(runDailyMaintenance, 24 * 60 * 60 * 1000)

  // Signal ready
  send({ type: 'event', event: 'ready', data: {
    publicKey: b4a.toString(identity.publicKey, 'hex'),
    mode,
    pairedKeys: [...knownPeerKeys],
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
  // Sequential message processing: use a promise chain so each message fully
  // completes (including DB writes) before the next one starts. Without this,
  // rapid messages (e.g. queued time:request followed by request:resolved
  // backfill) race and the second message can't find DB entries written by the
  // first (#122).
  let msgChain = Promise.resolve()
  conn.on('data', chunk => {
    peerBuf += chunk.toString()
    const lines = peerBuf.split('\n')
    peerBuf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        msgChain = msgChain.then(() => handlePeerMessage(msg, conn, remoteKeyHex)).catch(e => {
          console.error('[bare] peer message handler error:', e.message)
        })
      } catch (e) {
        console.error('[bare] peer message parse error:', e.message)
      }
    }
  })

  conn.on('error', e => {
    console.error('[bare] peer error:', e.message)
    // Remove from parentPeers only if this exact connection is still the active one.
    // Hyperswarm dedup creates two connections with the same remoteKeyHex; if the
    // surviving connection already updated parentPeers, we must not delete it (#122).
    if (mode === 'child') {
      for (const [ik, pp] of parentPeers) {
        if (pp.remoteKeyHex === remoteKeyHex && pp.conn === conn) {
          const survivingPeer = peers.get(remoteKeyHex)
          if (survivingPeer && survivingPeer.conn !== conn) {
            parentPeers.set(ik, { ...pp, conn: survivingPeer.conn })
          } else {
            parentPeers.delete(ik)
          }
          break
        }
      }
    }
  })
  conn.on('close', () => {
    const currentPeer = peers.get(remoteKeyHex)
    if (currentPeer && currentPeer.conn === conn) {
      peers.delete(remoteKeyHex)
    }
    if (mode === 'child') {
      for (const [ik, pp] of parentPeers) {
        if (pp.remoteKeyHex === remoteKeyHex && pp.conn === conn) {
          const survivingPeer = peers.get(remoteKeyHex)
          if (survivingPeer && survivingPeer.conn !== conn) {
            parentPeers.set(ik, { ...pp, conn: survivingPeer.conn })
          } else {
            parentPeers.delete(ik)
          }
          break
        }
        if (pp.remoteKeyHex === remoteKeyHex && pp.conn !== conn) break
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
      ? (profile.avatar.type === 'preset' ? 'preset:' + profile.avatar.id
        : profile.avatar.mime ? 'mime:' + profile.avatar.mime + ';' + (profile.avatar.base64 || profile.avatar.thumb64 || '')
        : profile.avatar.thumb64 || null)
      : null
    const hello = signMessage({
      type: 'hello',
      payload: { publicKey: myIdentityHex, displayName, avatarThumb, mode: 'child' },
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
  if (!peer) {
    console.warn('[bare] dropped message: no peer entry for', remoteKeyHex.slice(0, 8), 'type:', msg.type)
    return
  }

  // For 'hello' messages (pairing handshake): we don't have the peer's pubkey yet —
  // but we DO know their Hyperswarm public key (NOISE key), which is different from their
  // Ed25519 identity key. We accept 'hello' only once and then store their identity key.
  if (msg.type === 'hello') {
    await handleHello(msg, conn, remoteKeyHex)
    return
  }

  // Verify signature against stored identity key.
  // Hyperbee's B-tree can return null from db.get shortly after db.put (eventual
  // consistency under concurrent reads/writes). Fall back to knownPeerKeys which
  // is updated synchronously on every db.put('peers:...') call.
  const storedPeer = await db.get('peers:' + msg.from).catch(() => null)
  if (!storedPeer && !knownPeerKeys.has(msg.from)) {
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
      if (mode === 'parent') {
        // Parent receiving a relayed policy from the child — store under parent-mode key
        const cpk = msg.payload?.childPublicKey
        if (cpk) {
          await db.put('policy:' + cpk, msg.payload)
          send({ type: 'event', event: 'policy:updated', data: msg.payload })
          console.log('[bare] parent stored relayed policy for child', cpk.slice(0, 8), 'v' + msg.payload.version)
        }
      } else {
        await handlePolicyUpdate(msg.payload, db, send, sendToAllParents, msg.from)
      }
      break
    case 'time:extend':
      await handleTimeExtend(msg.payload, db, send, sendToAllParents)
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
      // Broadcast resolution to all parents so co-parent activity lists update (#122)
      sendToAllParents({ type: 'request:resolved', payload: { requestId, status: 'denied', packageName, appName, resolvedAt: Date.now() } })
      break
    }
    case 'app:decision':
      await handleAppDecision(msg.payload, db, send, sendToAllParents)
      break
    case 'request:resolved':
      console.log('[bare] received request:resolved from', msg.from?.slice(0, 8), 'id:', msg.payload?.requestId?.slice(0, 20), 'status:', msg.payload?.status)
      await handleRequestResolved(msg.payload, db, send, msg.from)
      break
    case 'requests:syncResolved': {
      // Parent is asking for resolved request statuses (#122 pull-based sync).
      console.log('[bare] received requests:syncResolved from', msg.from?.slice(0, 8))
      const resolvedCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      for await (const { value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
        if (!value || value.status === 'pending') continue
        if (value.requestedAt < resolvedCutoff) continue
        sendToPeer(remoteKeyHex, {
          type: 'request:resolved',
          payload: { requestId: value.id, status: value.status, packageName: value.packageName, appName: value.appName, resolvedAt: value.expiresAt || Date.now() },
        })
      }
      break
    }
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
      // Overwrite a single "latest" key per child rather than timestamped keys.
      // Append-only Hypercore log still grows with every put, but the live-key
      // set stays O(1) per child so reclaim is aggressive and the B-tree stays flat.
      await db.put('usageReport:' + childPublicKey + ':latest', msg.payload)
      // Store session-level data for reports. Sessions are now deltas (only
      // sessions closed since the child's last flush, plus still-open sessions)
      // so we append under a unique-timestamped key instead of wiping today's
      // prefix. Dedup on read keeps the snapshot with the highest duration for
      // any (packageName, startedAt) pair, so repeated open-session snapshots
      // collapse into the final closed version.
      const incomingSessions = msg.payload.sessions || []
      const reportTs = msg.payload.timestamp || Date.now()
      const dateStr = localDateStr(reportTs)
      const sessionPrefix = 'sessions:' + childPublicKey + ':' + dateStr + ':'
      if (incomingSessions.length > 0) {
        await db.put(sessionPrefix + reportTs, incomingSessions)
      }
      // Look up icon for the current foreground app from parent's policy store
      let currentAppIcon = null
      if (msg.payload.currentAppPackage) {
        const policyRaw = await db.get('policy:' + childPublicKey).catch(() => null)
        const policyApps = policyRaw?.value?.apps || {}
        currentAppIcon = policyApps[msg.payload.currentAppPackage]?.iconBase64 || null
      }
      // Process piggybacked resolved requests so co-parents see status updates (#122).
      if (Array.isArray(msg.payload.resolvedRequests) && msg.payload.resolvedRequests.length > 0) {
        for (const rr of msg.payload.resolvedRequests) {
          await handleRequestResolved(rr, db, send, childPublicKey)
        }
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
      // A parent has removed this child.
      // Find which parent sent this by looking up the identity key for this noise key.
      // Fall back to msg.from when identityKey is unset: handleHello is the only place
      // that sets identityKey, and a blocked-peer rejection skips it. msg.from is already
      // verified to equal remoteKeyHex above, and in this app noise key == identity key.
      const senderPeer = peers.get(remoteKeyHex)
      const senderIdentityKey = senderPeer?.identityKey || msg.from

      // Remove this parent's peer record and topic
      if (senderIdentityKey) {
        const peerRecord = await db.get('peers:' + senderIdentityKey).catch(() => null)
        const parentTopic = peerRecord?.value?.swarmTopic
        await db.del('peers:' + senderIdentityKey).catch(() => {})
        knownPeerKeys.delete(senderIdentityKey)
        await db.del('pendingParent:' + senderIdentityKey).catch(() => {})
        parentPeers.delete(senderIdentityKey)

        // Leave this parent's swarm topic if no other parent uses it
        if (parentTopic) {
          let topicStillUsed = false
          for await (const { value } of db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
            if (value && value.swarmTopic === parentTopic) { topicStillUsed = true; break }
          }
          if (!topicStillUsed) {
            await db.del('topics:' + parentTopic).catch(() => {})
            if (swarm) {
              try { swarm.leave(b4a.from(parentTopic, 'hex')) } catch (_e) {}
            }
          }
        }
      }

      // Close the connection from this parent
      try { conn.destroy() } catch (_e) {}
      peers.delete(remoteKeyHex)

      // Check if any parents remain
      const remainingParents = []
      for await (const { value } of db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
        if (value) remainingParents.push(value)
      }

      if (remainingParents.length === 0) {
        // Last parent removed - full reset
        const allKeys = []
        for await (const { key } of db.createReadStream()) {
          allKeys.push(key)
        }
        for (const key of allKeys) await db.del(key).catch(() => {})

        // Rotate identity keypair so re-pairing with a fresh invite works.
        // Mutate in place so ctx.identity stays in sync (see original comments).
        const newKeypair = generateKeypair()
        identity.publicKey = newKeypair.publicKey
        identity.secretKey = newKeypair.secretKey
        await db.put('identity', {
          publicKey:  b4a.toString(identity.publicKey, 'hex'),
          secretKey:  b4a.toString(identity.secretKey, 'hex'),
        })

        // Destroy swarm - no parents to reconnect to
        if (swarm) {
          try { await swarm.destroy() } catch (_e) {}
          swarm = null
        }
        parentPeers.clear()

        send({ type: 'event', event: 'child:reset', data: {} })
      } else {
        // Still have other parent(s) - just notify UI about the removed parent
        send({ type: 'event', event: 'parent:removed', data: { parentKey: senderIdentityKey } })
      }
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
 * Send a message to all connected parents.
 * - If any parent is connected: send immediately to each.
 * - If no parents connected (or all sends fail): queue for reconnect delivery.
 * Child mode only.
 * @param {{ type: string, payload: object }} message
 * @param {string} [excludeKey] — optional identity key to skip (e.g. the sender during policy relay)
 */
async function sendToAllParents (message, excludeKey) {
  if (parentPeers.size === 0) {
    console.log('[bare] sendToAllParents: no parents connected, queuing', message.type)
    await queueMessage(message, db)
    return
  }
  const signed = signMessage(message, identity)
  const payload = Buffer.from(JSON.stringify(signed) + '\n')
  let sentToAny = false
  for (const [ik, pp] of parentPeers) {
    if (excludeKey && ik === excludeKey) continue
    try {
      pp.conn.write(payload)
      console.log('[bare] sendToAllParents:', message.type, 'sent to parent', ik.slice(0, 8))
      sentToAny = true
    } catch (e) {
      console.warn('[bare] sendToAllParents: write failed for parent', ik.slice(0, 8), e.message)
      parentPeers.delete(ik)
    }
  }
  if (!sentToAny && !excludeKey) {
    console.log('[bare] sendToAllParents: all writes failed, queuing', message.type)
    await queueMessage(message, db)
  }
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
  // Exception: if the hello arrives on a pendingInviteTopic, the parent has issued
  // a fresh invite and the block is obsolete — clear it and proceed. This unsticks
  // re-pair attempts when the original child:unpair never reached the child (e.g.
  // the connection dropped before the unpair flushed, so the child kept its old
  // identity and still matches the block).
  const blockedEntry = await db.get('blocked:' + peerIdentityKeyHex).catch(() => null)
  if (blockedEntry) {
    const incomingTopic = (peers.get(remoteKeyHex) || {}).topicHex
    let matchesFreshInvite = false
    if (incomingTopic) {
      const pending = await db.get('pendingInviteTopic:' + incomingTopic).catch(() => null)
      if (pending) matchesFreshInvite = true
    } else if (msg.payload && msg.payload.mode === 'child') {
      // Topic not delivered on this connection (Hyperswarm dedup). If ANY
      // pendingInviteTopic exists, treat this child-hello as a fresh invite ack.
      for await (const { value } of db.createReadStream({ gt: 'pendingInviteTopic:', lt: 'pendingInviteTopic:~' })) {
        if (value) { matchesFreshInvite = true; break }
      }
    }
    if (matchesFreshInvite) {
      console.log('[bare] clearing obsolete block on fresh invite for peer:', peerIdentityKeyHex.slice(0, 8))
      await db.del('blocked:' + peerIdentityKeyHex).catch(() => {})
    } else {
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
        if (value.publicKey) knownPeerKeys.delete(value.publicKey)
      }
    }
  }

  const inMemoryPeer = peers.get(remoteKeyHex)
  // Resolve swarmTopic with fallbacks so the peer record always has it. Hyperswarm
  // can deliver a connection with empty info.topics[] (dedup / reconnect paths),
  // leaving inMemoryPeer.topicHex null; without a fallback the parent's peer record
  // gets written without swarmTopic and the topic is lost after app restart (#147).
  let resolvedTopic = inMemoryPeer && inMemoryPeer.topicHex
    ? inMemoryPeer.topicHex
    : (existingRecord && existingRecord.value && existingRecord.value.swarmTopic)
      || null
  if (!resolvedTopic) {
    if (msg.payload && msg.payload.mode === 'child') {
      // Parent receiving hello from a child: bind to the most recent pending invite topic.
      const pendingTopics = []
      for await (const { key, value } of db.createReadStream({ gt: 'pendingInviteTopic:', lt: 'pendingInviteTopic:~' })) {
        if (value && value.topicHex) pendingTopics.push({ key, ...value })
      }
      if (pendingTopics.length === 1) {
        resolvedTopic = pendingTopics[0].topicHex
      } else if (pendingTopics.length > 1) {
        pendingTopics.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        resolvedTopic = pendingTopics[0].topicHex
      }
    } else {
      // Child receiving hello from a parent: read swarmTopic from pendingParent.
      const pending = await db.get('pendingParent:' + peerIdentityKeyHex).catch(() => null)
      if (pending && pending.value && pending.value.swarmTopic) {
        resolvedTopic = pending.value.swarmTopic
      }
    }
  }
  const peerRecord = {
    ...(existingRecord ? existingRecord.value : {}),
    publicKey:   peerIdentityKeyHex,
    displayName: displayName ?? 'Unknown',
    avatarThumb: avatarThumb || (existingRecord ? existingRecord.value.avatarThumb : null) || null,
    pairedAt:    existingRecord ? existingRecord.value.pairedAt : Date.now(),
    lastSeen:    Date.now(),
    noiseKey:    remoteKeyHex,
    ...(resolvedTopic ? { swarmTopic: resolvedTopic } : {}),
  }
  // Clear the one-shot pending invite topic record once it's bound.
  if (resolvedTopic && msg.payload && msg.payload.mode === 'child') {
    await db.del('pendingInviteTopic:' + resolvedTopic).catch(() => {})
  }
  await db.put('peers:' + peerIdentityKeyHex, peerRecord)
  knownPeerKeys.add(peerIdentityKeyHex)

  // Re-check blocked status after writing — a concurrent child:unpair could have written
  // blocked: after our initial check above but before we stored the peer. If so, undo
  // the write and re-deliver unpair so the child resets even if it missed the original.
  const laterBlock = await db.get('blocked:' + peerIdentityKeyHex).catch(() => null)
  if (laterBlock) {
    console.warn('[bare] peer blocked during hello handshake, re-unpairing:', peerIdentityKeyHex.slice(0, 8))
    await db.del('peers:' + peerIdentityKeyHex).catch(() => {})
    knownPeerKeys.delete(peerIdentityKeyHex)
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
    // Both parents share the child's swarm topic. Skip pairing if the incoming
    // peer is another parent - only pair with children.
    if (msg.payload?.mode === 'parent') {
      console.log('[bare] ignoring hello from fellow parent:', peerIdentityKeyHex.slice(0, 12))
      return
    }

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

  // Send hello reply if we haven't already on THIS specific connection.
  // Track per-connection (not per-peer) because Hyperswarm dedup creates
  // multiple connections with the same remoteKeyHex. The peer entry in the
  // peers map gets overwritten, so sentHello on the peer entry is unreliable.
  // Using conn._sentHello ensures each connection gets exactly one reply (#122).
  if (!conn._sentHello) {
    conn._sentHello = true
    if (peer) peer.sentHello = true
    const myIdentityHex = b4a.toString(identity.publicKey, 'hex')
    const profileRaw = await db.get('profile').catch(() => null)
    const myProfile = profileRaw ? profileRaw.value : {}
    const myDisplayName = myProfile.displayName || 'PearGuard Device'
    const myAvatarThumb = myProfile.avatar
      ? (myProfile.avatar.type === 'preset' ? 'preset:' + myProfile.avatar.id
        : myProfile.avatar.mime ? 'mime:' + myProfile.avatar.mime + ';' + (myProfile.avatar.base64 || myProfile.avatar.thumb64 || '')
        : myProfile.avatar.thumb64 || null)
      : null
    const hello = signMessage({
      type: 'hello',
      payload: { publicKey: myIdentityHex, displayName: myDisplayName, avatarThumb: myAvatarThumb, mode },
    }, identity)
    conn.write(Buffer.from(JSON.stringify(hello) + '\n'))
  }

  // If we're the child, check if this is our pending parent
  if (mode === 'child') {
    const pendingParent = await db.get('pendingParent:' + peerIdentityKeyHex).catch(() => null)
    if (pendingParent) {
      await db.del('pendingParent:' + peerIdentityKeyHex).catch(() => {})
    }

    // Track this parent connection using the conn that delivered the hello message.
    // Hyperswarm dedup may have overwritten peers Map with a different conn; using
    // the hello conn guarantees we reference a known-working connection.
    const peerEntry = peers.get(remoteKeyHex)
    const topicHex = peerEntry ? peerEntry.topicHex : null
    if (peerEntry && peerEntry.conn !== conn) {
      peers.set(remoteKeyHex, { ...peerEntry, conn })
    }
    parentPeers.set(peerIdentityKeyHex, {
      conn,
      remoteKeyHex,
      displayName: displayName ?? 'Parent',
      topicHex,
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

    // Backfill resolved requests so co-parents who were offline see updated statuses (#122).
    // Send all non-pending requests from the last 7 days.
    try {
      const resolvedCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      let backfilled = 0
      for await (const { value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
        if (!value || value.status === 'pending') continue
        if (value.requestedAt < resolvedCutoff) continue
        const resolved = signMessage({
          type: 'request:resolved',
          payload: { requestId: value.id, status: value.status, packageName: value.packageName, appName: value.appName, resolvedAt: value.expiresAt || Date.now() },
        }, identity)
        conn.write(Buffer.from(JSON.stringify(resolved) + '\n'))
        backfilled++
      }
      if (backfilled > 0) console.log('[bare] backfilled', backfilled, 'resolved request(s) to parent on reconnect')
    } catch (e) {
      console.warn('[bare] resolved request backfill failed:', e.message)
    }

    // Ask RN shell to scan installed apps and relay each as app:installed
    send({ type: 'event', event: 'apps:syncRequested', data: {} })
    // Ask RN shell to gather usage stats and send a fresh report to the parent
    send({ type: 'event', event: 'usageFlushRequested', data: {} })
  }
}

// ── Storage: breakdown, analyze, reclaim ──────────────────────────────────────
//
// Ported from PearCal (see p2p-wiki/wiki/concepts/hyperbee-bloat-and-reclaim.md).
// PearGuard is single-core (no Autobase) and no replication: the local Hyperbee
// is not shared via swarm, so closing/swapping `core` is safe without tearing
// down hyperswarm connections.

// Hyperbee keys that must survive a reclaim rebuild.
const MUST_KEEP_EXACT = new Set([
  'identity', 'mode', 'profile', 'parentSettings', 'policy',
  'settings:theme', 'donationReminderDismissed', 'pinLog', 'pendingMessages',
])
const MUST_KEEP_PREFIXES = [
  'peers:', 'topics:', 'policy:', 'blocked:', 'pendingParent:',
  'pendingInviteTopic:', 'pref:', '_migration:',
]
const WIPEABLE_PREFIXES = [
  'alert:', 'override:', 'usage:', 'usageReport:', 'bypass:', 'sessions:',
]

function classifyKey (k) {
  if (MUST_KEEP_EXACT.has(k)) return 'keep'
  for (const p of MUST_KEEP_PREFIXES) if (k.startsWith(p)) return 'keep'
  // Requests: keep only pending; drop resolved.
  if (k.startsWith('req:') || k.startsWith('request:')) return 'request'
  for (const p of WIPEABLE_PREFIXES) if (k.startsWith(p)) return 'wipe'
  return 'other'
}

async function storageBreakdown () {
  const fs = require('bare-fs')
  const path = require('bare-path')
  const root = _dataDir + '/pearguard/core'
  let total = 0
  const cats = {
    data: { size: 0, count: 0 },      // core blocks / oplog
    tree: { size: 0, count: 0 },      // hypercore tree
    bitfield: { size: 0, count: 0 },
    header: { size: 0, count: 0 },
    other: { size: 0, count: 0 },
  }
  const perDir = {}
  async function walk (dir, rel) {
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
    catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { await walk(p, rel ? rel + '/' + e.name : e.name); continue }
      let size = 0
      try { size = (await fs.promises.stat(p)).size } catch { continue }
      total += size
      perDir[rel || '.'] = (perDir[rel || '.'] || 0) + size
      const n = e.name
      let cat = 'other'
      if (n === 'data' || n.startsWith('data.')) cat = 'data'
      else if (n === 'tree' || n.startsWith('tree.')) cat = 'tree'
      else if (n === 'bitfield' || n.startsWith('bitfield.')) cat = 'bitfield'
      else if (n === 'header' || n === 'oplog' || n === 'key' || n === 'signatures') cat = 'header'
      cats[cat].size += size
      cats[cat].count += 1
    }
  }
  await walk(root, '')
  return { total, cats, perDir, root }
}

async function analyzeStorage () {
  // Walk every live key and group by classification + prefix.
  // Byte estimate = key.length + JSON(value).length (rough, ignores b-tree nodes).
  const groups = { keep: 0, wipe: 0, request: 0, other: 0 }
  const byPrefix = {}
  let totalKeys = 0
  let estLiveBytes = 0
  let pendingRequests = 0
  let resolvedRequests = 0
  for await (const { key, value } of db.createReadStream()) {
    totalKeys++
    const cls = classifyKey(key)
    groups[cls] = (groups[cls] || 0) + 1
    // Derive a prefix bucket: take up to first ':' or whole key.
    const colonIdx = key.indexOf(':')
    const prefix = colonIdx === -1 ? key : key.slice(0, colonIdx + 1) + '*'
    let approx = key.length
    try { approx += JSON.stringify(value).length } catch {}
    byPrefix[prefix] = byPrefix[prefix] || { count: 0, bytes: 0, cls }
    byPrefix[prefix].count++
    byPrefix[prefix].bytes += approx
    estLiveBytes += approx
    if (cls === 'request') {
      if (value && value.status === 'pending') pendingRequests++
      else resolvedRequests++
    }
  }
  // On-disk footprint and reclaimable estimate.
  const { total: onDisk } = await storageBreakdown()
  // All historical versions are on disk; live keys are a small subset. Reclaim
  // estimate = onDisk - (estimated size of kept-key live values). This is an
  // upper bound because b-tree overhead for kept keys is also kept.
  const keepBytes = Object.entries(byPrefix)
    .filter(([, v]) => v.cls === 'keep')
    .reduce((a, [, v]) => a + v.bytes, 0)
    + Object.entries(byPrefix)
      .filter(([, v]) => v.cls === 'request')
      .reduce((a, [, v]) => a + v.bytes, 0) // pending requests are kept
  const reclaimableBytes = Math.max(0, onDisk - keepBytes)
  const pct = onDisk > 0 ? Math.round(100 * reclaimableBytes / onDisk) : 0
  return {
    onDisk,
    totalKeys,
    estLiveBytes,
    reclaimableBytes,
    pct,
    groups,
    pendingRequests,
    resolvedRequests,
    byPrefix,
  }
}

async function rebuildLocalDb () {
  if (_rebuildBusy) throw new Error('rebuild already running')
  if (!_dataDir) throw new Error('dataDir not set')
  _rebuildBusy = true
  const fs = require('bare-fs')
  async function dirSize (dir) {
    let total = 0
    let entries
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) }
    catch { return 0 }
    for (const e of entries) {
      const p = dir + '/' + e.name
      if (e.isDirectory()) total += await dirSize(p)
      else { try { total += (await fs.promises.stat(p)).size } catch {} }
    }
    return total
  }
  const coreDir = _dataDir + '/pearguard/core'
  const newDir  = _dataDir + '/pearguard/core.new'
  const bakDir  = _dataDir + '/pearguard/core.old'
  try {
    const before = await dirSize(coreDir)
    try { await fs.promises.rm(newDir, { recursive: true, force: true }) } catch {}
    try { await fs.promises.rm(bakDir, { recursive: true, force: true }) } catch {}

    const newCore = new Hypercore(newDir)
    await newCore.ready()
    const newDb = new Hyperbee(newCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await newDb.ready()

    let kept = 0
    let dropped = 0
    for await (const entry of db.createReadStream()) {
      const cls = classifyKey(entry.key)
      if (cls === 'keep') {
        await newDb.put(entry.key, entry.value)
        kept++
      } else if (cls === 'request') {
        if (entry.value && entry.value.status === 'pending') {
          await newDb.put(entry.key, entry.value)
          kept++
        } else {
          dropped++
        }
      } else {
        // wipe or other — drop
        dropped++
      }
    }

    await newDb.close()
    await newCore.close()
    await db.close()
    await core.close()

    // Atomic swap.
    await fs.promises.rename(coreDir, bakDir)
    await fs.promises.rename(newDir, coreDir)

    core = new Hypercore(coreDir)
    await core.ready()
    db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await db.ready()
    // Rewire dispatch ctx so subsequent calls use the new db.
    if (_dispatchCtx) _dispatchCtx.db = db

    try { await fs.promises.rm(bakDir, { recursive: true, force: true }) } catch {}

    const after = await dirSize(coreDir)
    return { before, after, freed: Math.max(0, before - after), kept, dropped }
  } finally {
    _rebuildBusy = false
  }
}

// Signal that bare.js has loaded (before init is called)
send({ type: 'event', event: 'bareReady', data: {} })