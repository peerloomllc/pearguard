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
const { createDispatch } = require('./bare-dispatch')

// ── State ─────────────────────────────────────────────────────────────────────

let db       = null   // Hyperbee (local persistence)
let core     = null   // Hypercore backing the Hyperbee
let swarm    = null   // Hyperswarm instance
let identity = null   // { publicKey: Buffer, secretKey: Buffer }
let mode     = null   // 'parent' | 'child' | null
let dispatch = null   // method dispatch function

// Peers map: hex(publicKey) → { publicKey: Buffer, displayName: string, conn: object }
const peers = new Map()

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
  dispatch = createDispatch({ db, identity, swarm, peers, send, sign, verify, b4a, mode })

  // Signal ready
  send({ type: 'event', event: 'ready', data: {
    publicKey: b4a.toString(identity.publicKey, 'hex'),
    mode,
  }})
}

// Signal that bare.js has loaded (before init is called)
send({ type: 'event', event: 'bareReady', data: {} })
