// Wayland-aware foreground-window adapter. Replaces (or augments) active-win
// on GNOME Wayland sessions where xprop can only see Xwayland-hosted apps —
// every Wayland-native window (most GNOME apps in 2026: Calculator, Files,
// Settings, Firefox by default, etc.) is invisible to xprop and active-win
// throws "Failed to parse process ID" on every tick.
//
// We bridge the gap via a tiny GNOME Shell extension (see
// windows/build/gnome-extension/) that exports a D-Bus method returning the
// focused window's pid/title/wmClass. This module shells out to gdbus to read
// it; gdbus ships with glib2-tools on every GNOME-running distro, so we don't
// need a native dbus binding.
//
// Returned shape matches active-win's so ForegroundMonitor doesn't care which
// backend produced it:
//   { platform: 'linux', title, id?, owner: { name, processId, path } }
const { execFile } = require('child_process')
const fs = require('fs')

// Bus identifiers — must agree with windows/build/gnome-extension/extension.js
const BUS_NAME = 'com.peerloomllc.PearGuardFocus'
const OBJECT_PATH = '/com/peerloomllc/PearGuardFocus'
const METHOD = 'com.peerloomllc.PearGuardFocus.GetFocus'

// Detect whether the host is a Wayland session. The shell extension only
// exists on Wayland and only matters there — X11 sessions go straight to
// active-win as before. Both env vars are checked because containers and SSH
// can drop one but not the other.
function isWaylandSession() {
  return process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY
}

// gdbus output looks like: (uint32 12345, 'Title', 'WMClass', 'instance')
// or with no focus: (uint32 0, '', '', '')
// Single quotes inside the strings are escaped as \' so we read non-greedily
// and accept escape sequences in title/wmClass.
const TUPLE_RE = /^\(uint32\s+(\d+),\s+'((?:[^'\\]|\\.)*)',\s+'((?:[^'\\]|\\.)*)',\s+'((?:[^'\\]|\\.)*)'\)/

function unescape(s) {
  // gdbus escapes \', \\, \n, \r, \t in returned strings. We rebuild the
  // original; an unknown escape stays literal so we don't lose data.
  return s.replace(/\\(['\\nrt])/g, (_, c) => {
    if (c === 'n') return '\n'
    if (c === 'r') return '\r'
    if (c === 't') return '\t'
    return c
  })
}

function callGdbus({ timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    execFile('gdbus', [
      'call', '--session',
      '--dest', BUS_NAME,
      '--object-path', OBJECT_PATH,
      '--method', METHOD,
    ], { timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        // ENOENT: gdbus not on PATH (very rare on GNOME systems; ships with
        // glib2-tools). Bus name not registered: extension not installed or
        // not enabled. Either way, surface as null so the caller can fall
        // back to active-win.
        resolve(null)
        return
      }
      const m = TUPLE_RE.exec(stdout.trim())
      if (!m) { resolve(null); return }
      const pid = Number.parseInt(m[1], 10)
      if (!Number.isFinite(pid) || pid <= 0) { resolve(null); return }
      resolve({
        pid,
        title: unescape(m[2]),
        wmClass: unescape(m[3]),
        wmClassInstance: unescape(m[4]),
      })
    })
  })
}

// Best-effort PID -> /proc/<pid>/exe resolution. Returns '' if /proc is gone
// or the process exited between the gdbus call and our readlink (race that
// the controller already tolerates via its 'unmapped' branch).
function resolveExePath(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/exe`)
  } catch (_) {
    return ''
  }
}

// Public API: one shot. Shape mirrors active-win so the ForegroundMonitor
// doesn't need to know which backend it called.
async function activeWindowWayland() {
  const info = await callGdbus()
  if (!info) return null
  const path = resolveExePath(info.pid)
  // wmClass is more useful than name-from-path for window-title matching
  // (UWP-host analogues on GNOME would key off this), but pass the exe
  // basename as owner.name to keep parity with X11/Windows shape.
  const slash = path.lastIndexOf('/')
  const name = slash >= 0 ? path.slice(slash + 1) : (info.wmClass || '')
  return {
    platform: 'linux',
    title: info.title || '',
    owner: {
      name,
      processId: info.pid,
      path,
    },
  }
}

// Build a function with the same signature as `require('active-win')` so the
// host can hand it to ForegroundMonitor unchanged. On Wayland we try our
// extension first and fall back to active-win when it returns null (which
// happens when the focused app IS Xwayland — Steam, legacy apps — so xprop
// still has the data).
function makeWaylandActiveWin(fallbackActiveWin) {
  return async function activeWinUnified() {
    const wayland = await activeWindowWayland()
    if (wayland) return wayland
    if (typeof fallbackActiveWin === 'function') {
      try { return await fallbackActiveWin() } catch (_) { return null }
    }
    return null
  }
}

module.exports = {
  isWaylandSession,
  activeWindowWayland,
  makeWaylandActiveWin,
  callGdbus,            // exported for tests
  resolveExePath,       // exported for tests
  BUS_NAME,
  OBJECT_PATH,
  METHOD,
}
