// src/webview-replay.js
//
// Bounded, sequence-keyed replay buffer for Bare→WebView events.
//
// Problem: the RN shell (app/index.tsx) forwards bare events into the WebView by
// injecting `window.__pearEvent(...)`. When the WebView is reloaded — the
// black-screen watchdog fires, or Android kills the render/content process
// (onRenderProcessGone / onContentProcessDidTerminate) — the fresh page has no
// memory of events already delivered to the dead context, and the old pre-load
// buffer was emptied on the first load. Any event that landed on the old context
// (or in the reload gap) is silently lost, so e.g. a peer:paired / child:connected
// that arrived during the flap never reaches the new UI.
//
// This buffer keeps the last N forwarded events, each tagged with a monotonic
// sequence number. On every WebView load (first paint OR post-reload) the shell
// replays the buffer so the fresh context catches up. The seq lets the WebView
// ignore any event it has already applied, so redelivery is idempotent.

const DEFAULT_CAP = 64

class ReplayBuffer {
  constructor (cap = DEFAULT_CAP) {
    // Guard against 0/NaN/negative — a buffer must hold at least one event.
    const n = Math.floor(cap)
    this._cap = Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP
    this._seq = 0
    this._events = [] // [{ seq, event, data }], oldest first
  }

  // Assign the next seq, append (evicting the oldest beyond cap) and return the
  // tagged record so the caller can inject it live.
  record (event, data) {
    const rec = { seq: ++this._seq, event, data }
    this._events.push(rec)
    if (this._events.length > this._cap) {
      this._events.splice(0, this._events.length - this._cap)
    }
    return rec
  }

  // Snapshot of buffered events to replay on WebView load, oldest first.
  // A fresh page has applied nothing, so it passes 0 (the default) and gets
  // every retained event; `afterSeq` lets a caller ask for only newer ones.
  replay (afterSeq = 0) {
    if (!afterSeq) return this._events.slice()
    return this._events.filter((e) => e.seq > afterSeq)
  }

  get lastSeq () { return this._seq }
  get size () { return this._events.length }
}

module.exports = { ReplayBuffer, DEFAULT_CAP }
