// src/bare.js
//
// Bare worklet entry point. Runs inside the Bare runtime launched by BareKit.
// Do NOT use Node.js APIs (path, fs, etc.) — use bare-* equivalents.
// Communicates with the RN shell via BareKit.IPC (JSON-over-newline).

const Hyperbee   = require('hyperbee')
const Hypercore  = require('hypercore')
const Hyperswarm = require('hyperswarm')
const sodium     = require('sodium-native')
const b4a        = require('b4a')
const { generateKeypair, sign, verify } = require('./identity')
const { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, queueMessage, flushMessageQueue } = require('./bare-dispatch')
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

// Parent connection state (child mode only)
let peerConnected = false
let parentPeer = null  // the connected parent peer entry from `peers` map

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

async function init (dataDir) {
  // Idempotent: if already initialized, just re-emit 'ready' so the remounted
  // RN component can set dbReady=true without reopening the Hypercore.
  if (_initialized) {
    send({ type: 'event', event: 'ready', data: {
      publicKey: b4a.toString(identity.publicKey, 'hex'),
      mode,
    }})
    return
  }
  _initialized = true

  // Open (or create) the local Hypercore + Hyperbee
  core = new Hypercore(dataDir + '/pearguard/core')
  await core.ready()
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
    })
  }

  // Load mode
  const storedMode = await db.get('mode')
  mode = storedMode ? storedMode.value : null

  // Build dispatch with live context
  dispatch = createDispatch({ db, identity, swarm, peers, send, sign, verify, b4a, mode,
    joinTopic, sendToPeer, sendToParent, sodium,
    onModeChange: (m) => { mode = m } })

  // Signal ready
  send({ type: 'event', event: 'ready', data: {
    publicKey: b4a.toString(identity.publicKey, 'hex'),
    mode,
  }})

  // Start 5-minute usage reporting timer
  setInterval(() => {
    handleDispatch('usage:flush', {}, null)
  }, 5 * 60 * 1000)

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
    swarm = new Hyperswarm()
    swarm.on('connection', onPeerConnection)
  }
  const topicBuf = typeof topicInput === 'string'
    ? b4a.from(topicInput, 'hex')
    : topicInput
  await swarm.join(topicBuf, { client: true, server: true })
  await swarm.flush()
  send({ type: 'event', event: 'swarm:joined', data: { topic: b4a.toString(topicBuf, 'hex') } })
}

/**
 * Called for each new Hyperswarm peer connection.
 */
function onPeerConnection (conn, info) {
  const remoteKeyHex = b4a.toString(conn.remotePublicKey, 'hex')
  console.log('[bare] peer connected:', remoteKeyHex.slice(0, 12))

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

  conn.on('error', e => console.error('[bare] peer error:', e.message))
  conn.on('close', () => {
    peers.delete(remoteKeyHex)
    // Reset parent connection state if this was the parent peer
    if (mode === 'child' && parentPeer && parentPeer.remoteKeyHex === remoteKeyHex) {
      peerConnected = false
      parentPeer = null
    }
    send({ type: 'event', event: 'peer:disconnected', data: { remoteKey: remoteKeyHex } })
  })

  // Store the connection for sending
  peers.set(remoteKeyHex, { conn, remoteKeyHex, displayName: null })
  send({ type: 'event', event: 'peer:connected', data: { remoteKey: remoteKeyHex } })

  // Child sends hello proactively on new connection
  if (mode === 'child') {
    const myIdentityHex = b4a.toString(identity.publicKey, 'hex')
    const hello = signMessage({
      type: 'hello',
      payload: { publicKey: myIdentityHex, displayName: 'Child Device' },
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
    case 'app:decision':
      await handleAppDecision(msg.payload, db, send)
      break
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
 * Send a message to the connected parent, or queue it in Hyperbee if not connected.
 * Child mode only.
 * @param {{ type: string, payload: object }} message
 */
async function sendToParent (message) {
  if (peerConnected && parentPeer && parentPeer.conn) {
    const signed = signMessage(message, identity)
    parentPeer.conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
  } else {
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
  const { publicKey: peerIdentityKeyHex, displayName } = msg.payload ?? {}
  if (!peerIdentityKeyHex || typeof peerIdentityKeyHex !== 'string') {
    console.warn('[bare] invalid hello: missing publicKey')
    return
  }

  // Verify signature using the declared identity key
  if (!verifyMessage(msg, peerIdentityKeyHex)) {
    console.warn('[bare] invalid hello: bad signature')
    return
  }

  // Store peer identity
  const peerRecord = {
    publicKey:   peerIdentityKeyHex,
    displayName: displayName ?? 'Unknown',
    pairedAt:    Date.now(),
    noiseKey:    remoteKeyHex,
  }
  await db.put('peers:' + peerIdentityKeyHex, peerRecord)

  // Update the in-memory peers map with the identity key
  const peer = peers.get(remoteKeyHex)
  if (peer) {
    peer.identityKey = peerIdentityKeyHex
    peer.displayName = displayName ?? 'Unknown'
  }

  console.log('[bare] paired with:', peerIdentityKeyHex.slice(0, 12), displayName)
  send({ type: 'event', event: 'peer:paired', data: peerRecord })

  // Notify the parent UI that a child has connected
  if (mode === 'parent') {
    send({ type: 'event', event: 'child:connected', data: peerRecord })
  }

  // Send our own hello back (if we haven't already)
  const alreadySentHello = peer?.sentHello
  if (!alreadySentHello) {
    if (peer) peer.sentHello = true
    const myIdentityHex = b4a.toString(identity.publicKey, 'hex')
    const hello = signMessage({
      type: 'hello',
      payload: { publicKey: myIdentityHex, displayName: 'PearGuard Device' },
    }, identity)
    conn.write(Buffer.from(JSON.stringify(hello) + '\n'))
  }

  // If we're the child, check if this is our pending parent
  if (mode === 'child') {
    const pendingParent = await db.get('pendingParent').catch(() => null)
    if (pendingParent && pendingParent.value.publicKey === peerIdentityKeyHex) {
      await db.del('pendingParent').catch(() => {})
    }

    // Mark parent as connected and flush any queued messages
    peerConnected = true
    parentPeer = peers.get(remoteKeyHex)
    await flushPendingMessages(conn)
  }
}

// Signal that bare.js has loaded (before init is called)
send({ type: 'event', event: 'bareReady', data: {} })
