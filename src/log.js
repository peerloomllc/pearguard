// Shared logger for the Bare worklet (bare.js + bare-dispatch.js).
//
// Every console.* call in the worklet used to run in release builds too. Most
// of them sit on hot paths — one per heartbeat (~60s per parent), one per peer
// message, one per usage flush — and on desktop they're tee'd to a rolling 5 MB
// file. The practical damage isn't CPU, it's that the spam evicts the crash
// forensics the rotation exists to preserve, and buries real signal when
// debugging a live child.
//
// So `log()` is gated: silent unless the host turns it on. `warn()` and
// `error()` are NOT gated — those are the ones you actually want in production.
//
// The host decides, because only it knows whether this is a dev build, and it
// passes the flag on the `init` IPC message (bare.js wires it up):
//   - Android/iOS shell (app/index.tsx): __DEV__
//   - Electron desktop (desktop/src/main/index.js): !app.isPackaged
//
// Nothing logged here is sensitive (no keys, PINs or PII) — this is hygiene,
// not a leak fix.

let enabled = false

// Called once from bare.js's `init` handler. Defaults to false, so a host that
// forgets to pass the flag gets the quiet (production) behaviour rather than
// accidentally shipping verbose logs.
function setLogEnabled(value) {
  enabled = !!value
}

function isLogEnabled() {
  return enabled
}

function log(...args) {
  if (enabled) console.log(...args)
}

// Always on: a warning or error in production is exactly what we need to see.
function warn(...args) {
  console.warn(...args)
}

function error(...args) {
  console.error(...args)
}

module.exports = { setLogEnabled, isLogEnabled, log, warn, error }
