// Is the child's desktop session locked?
//
// This exists because a locked screen makes our GNOME extension look broken.
// GNOME UNLOADS user extensions on the lock screen by design — our
// metadata.json deliberately has no "session-modes" key, so it defaults to
// ["user"], and foreground-wayland.js *depends* on that (it's what stops the
// usage tracker accruing phantom hours while the kid is away from the machine).
//
// Measured on the Debian child, GNOME 48 Wayland:
//     unlocked:  Enabled: Yes   State: ACTIVE
//     locked:    Enabled: Yes   State: INACTIVE      <-- looks like a failure
//     unlocked:  Enabled: Yes   State: ACTIVE
//
// So without this check the watchdog fires "app blocking is off on Ben's PC" at
// the parent every single time the child locks their screen. Nothing is wrong:
// they cannot launch an app from the lock screen either.
//
// Signals, in order of trust:
//   1. org.gnome.ScreenSaver GetActive — the shield state. Authoritative on
//      GNOME, reachable from the child's own session bus, and verified to flip
//      exactly in step with the extension going INACTIVE.
//   2. logind's LockedHint — cross-desktop in principle, but NOT dependable:
//      on the Debian child the session has Type=unspecified and logind answers
//      "Session does not support lock screen", so LockedHint reads `no` even
//      while the screen is plainly locked. That is precisely the trap the
//      capability check fell into. Kept only as a fallback for non-GNOME
//      desktops, never as the primary.
//
// When neither signal answers, report NOT locked. Fail towards checking: a
// missed lock costs one spurious "blocking is off" alert, while a wrongly
// assumed lock would mask a real bypass — and masking a bypass is the one
// failure a parental-control app must never choose.
const { execFile } = require('child_process')

const SCREENSAVER_ARGS = [
  'call', '--session',
  '--dest', 'org.gnome.ScreenSaver',
  '--object-path', '/org/gnome/ScreenSaver',
  '--method', 'org.gnome.ScreenSaver.GetActive',
]

function defaultRun(cmd, args, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

// gdbus prints the boolean tuple `(true,)` / `(false,)`. Anything else (an
// error string, an empty reply, a missing bus name) is "don't know" => null.
function parseScreenSaverActive(stdout) {
  if (typeof stdout !== 'string') return null
  const m = stdout.match(/^\(\s*(true|false)\s*,?\s*\)/)
  if (!m) return null
  return m[1] === 'true'
}

// `loginctl show-session <id> -p LockedHint --value` prints `yes` / `no`.
// A session that doesn't support locking prints an error instead, which must
// read as "don't know" rather than "unlocked" — see the header.
function parseLockedHint(stdout) {
  if (typeof stdout !== 'string') return null
  const v = stdout.trim().toLowerCase()
  if (v === 'yes') return true
  if (v === 'no') return false
  return null
}

async function isSessionLocked({ run = defaultRun, sessionId = null } = {}) {
  if (process.platform !== 'linux') return false

  const screensaver = parseScreenSaverActive(await run('gdbus', SCREENSAVER_ARGS))
  if (screensaver !== null) return screensaver

  const id = sessionId || process.env.XDG_SESSION_ID || 'self'
  const hint = parseLockedHint(await run('loginctl', ['show-session', id, '-p', 'LockedHint', '--value']))
  if (hint !== null) return hint

  return false
}

module.exports = {
  isSessionLocked,
  parseScreenSaverActive,
  parseLockedHint,
  SCREENSAVER_ARGS,
}
