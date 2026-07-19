// bare-runner.js — boots ONE bare.js instance under Node with a BareKit IPC shim.
// Bridges bare.js's BareKit.IPC to the orchestrator over child_process IPC:
//
//   orchestrator --(process IPC {in})--> ipc 'data' event --> bare.js
//   bare.js --> BareKit.IPC.write --> (process IPC {out}) --> orchestrator
//
// Forked by harness-lib.js with env BARE_ENTRY pointing at the bare.js to load.

const { EventEmitter } = require('events')

const ipc = new EventEmitter()
ipc.write = (buf) => {
  const text = Buffer.isBuffer(buf) ? buf.toString() : String(buf)
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let parsed
    try { parsed = JSON.parse(line) } catch { parsed = { raw: line } }
    process.send({ out: parsed })
  }
}
// bare.js registers ipc.on('data', ...) at module load, so the shim must exist first.
global.BareKit = { IPC: ipc }

process.on('message', (m) => {
  if (m && m.in) ipc.emit('data', Buffer.from(JSON.stringify(m.in) + '\n'))
})

require(process.env.BARE_ENTRY)
