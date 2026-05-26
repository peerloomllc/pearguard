// Shims global.BareKit so that the unmodified src/bare.js can run inside the
// Electron main process. Only BareKit.IPC.write / BareKit.IPC.on('data') are
// used by bare.js; both are mapped to an EventEmitter-backed duplex so the
// host (Electron main) can pump IPC lines in and read them back out.

const { EventEmitter } = require('events')

function createBareKitShim() {
  const fromBare = new EventEmitter()   // lines emitted by bare.js (send)
  const toBare = new EventEmitter()     // lines to feed into bare.js (on 'data')

  const ipc = {
    write(buf) {
      fromBare.emit('line', buf)
    },
    on(event, handler) {
      if (event !== 'data') return
      toBare.on('data', handler)
    },
  }

  global.BareKit = { IPC: ipc }
  global.Buffer = global.Buffer || require('buffer').Buffer

  return {
    ipc,
    onBareOut(handler) {
      fromBare.on('line', handler)
    },
    sendToBare(buf) {
      toBare.emit('data', buf)
    },
  }
}

module.exports = { createBareKitShim }
