// harness-lib.js — orchestration helpers for driving headless bare.js instances.
//
// Each instance runs bare.js in its own forked process (bare.js keeps module-level
// singletons for db/swarm/identity, so instances MUST be separate processes) with
// its own temp data dir. Instances discover and pair over the real Hyperswarm DHT,
// exactly as two devices would — so these exercise the true P2P path, not a mock.
const { fork } = require('child_process')
const os = require('os')
const path = require('path')
const fs = require('fs')

// Default entry: this repo's bare.js. Override with BARE_ENTRY to test another build
// (e.g. a git worktree at an older commit).
const BARE_ENTRY = process.env.BARE_ENTRY || path.resolve(__dirname, '../../src/bare.js')

function spawnInstance (role, bareEntry = BARE_ENTRY) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `pg-${role}-`))
  return respawn({ role, dataDir, bareEntry, _id: 0 })
}

// (Re)start a process for an instance, PRESERVING its dataDir (and therefore its
// Hyperbee identity). Used to simulate a device going offline and coming back.
function respawn (base) {
  const child = fork(path.join(__dirname, 'bare-runner.js'), [], {
    env: { ...process.env, HARNESS_ROLE: base.role, BARE_ENTRY: base.bareEntry },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
  })
  const inst = Object.assign(base, { child, events: [], pending: new Map(), waiters: [], exited: null })
  child.on('message', (m) => {
    const msg = m && m.out
    if (!msg) return
    if (msg.type === 'response') {
      const p = inst.pending.get(msg.id)
      if (p) { inst.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result) }
    } else if (msg.type === 'event') {
      inst.events.push(msg)
      inst.waiters = inst.waiters.filter((w) => { if (w.match(msg)) { w.resolve(msg); return false } return true })
    }
  })
  child.on('exit', (code, sig) => { inst.exited = { code, sig } })
  return inst
}

function call (inst, method, args, timeout = 30000) {
  const id = ++inst._id
  return new Promise((resolve, reject) => {
    inst.pending.set(id, { resolve, reject })
    inst.child.send({ in: { method, args, id } })
    setTimeout(() => { if (inst.pending.has(id)) { inst.pending.delete(id); reject(new Error(`call timeout: ${method}`)) } }, timeout)
  })
}

function waitEvent (inst, match, timeout = 60000) {
  const found = inst.events.find(match)
  if (found) return Promise.resolve(found)
  return new Promise((resolve, reject) => {
    const w = { match, resolve }
    inst.waiters.push(w)
    setTimeout(() => { inst.waiters = inst.waiters.filter((x) => x !== w); reject(new Error('event timeout')) }, timeout)
  })
}

function init (inst, debug = false) {
  inst.child.send({ in: { method: 'init', dataDir: inst.dataDir, debug } })
  return waitEvent(inst, (m) => m.event === 'ready', 20000)
}

// Kill an instance's process but KEEP its dataDir so it can respawn with the same
// identity (offline/online simulation). Returns a fresh, un-inited instance object.
function kill (inst) {
  return new Promise((resolve) => {
    inst.child.once('exit', () => resolve())
    try { inst.child.kill('SIGKILL') } catch { resolve() }
  })
}

function teardown (insts) {
  for (const inst of insts) {
    try { inst.child.kill('SIGKILL') } catch {}
    try { fs.rmSync(inst.dataDir, { recursive: true, force: true }) } catch {}
  }
}

module.exports = { spawnInstance, respawn, call, waitEvent, init, kill, teardown, BARE_ENTRY }
