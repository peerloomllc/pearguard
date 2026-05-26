const fs = require('fs')
const path = require('path')

// Persists a small runtime-state file and uses it to distinguish a clean quit
// from a kill. On startup, if the previous session didn't set cleanQuit and
// the last heartbeat is recent enough that we couldn't have been off cleanly,
// report it as a force-stop tamper event. Bare's `bypass:detected` path then
// stores an alert and relays `bypass:alert` to every paired parent, matching
// the Android enforcement-service behavior.
//
// False-positive cases we accept as "correct enough" for parental control:
//   - Abrupt power-off / BSOD before `before-quit` fires: reads as tampered.
//   - Electron main-process crash: reads as tampered. Both are signals the
//     parent probably wants to see.
//
// False-negative we accept:
//   - Kill the app, leave it off for >STALE_MS, then it relaunches: won't
//     fire. That's fine: a long outage is more plausibly a reboot or
//     shutdown, and the scheduled-task watchdog relaunches within a minute
//     anyway, so a real bypass lands inside the window.

const HEARTBEAT_INTERVAL_MS = 30_000
const STALE_MS = 2 * 60_000

class TamperDetector {
  constructor({ userDataDir, onTamper, now = Date.now }) {
    this._path = path.join(userDataDir, 'runtime-state.json')
    this._onTamper = onTamper
    this._now = now
    this._timer = null
  }

  _read() {
    try {
      return JSON.parse(fs.readFileSync(this._path, 'utf8'))
    } catch (_e) {
      return null
    }
  }

  _write(state) {
    try {
      fs.writeFileSync(this._path, JSON.stringify(state))
    } catch (e) {
      console.warn('[tamper] write failed:', e.message)
    }
  }

  // Inspect the previous session's marker, fire the tamper callback if
  // applicable, then immediately claim the current session (cleanQuit=false,
  // fresh heartbeat). Returns the evaluation so callers can log/test it.
  checkOnStartup() {
    const prev = this._read()
    const now = this._now()
    let result = { tampered: false, reason: null, prev }

    if (prev && prev.cleanQuit === false && typeof prev.lastHeartbeat === 'number') {
      const age = now - prev.lastHeartbeat
      if (age >= 0 && age <= STALE_MS) {
        result = { tampered: true, reason: 'force_stopped', prev, age }
      }
    }

    this._write({ cleanQuit: false, lastHeartbeat: now })

    if (result.tampered && typeof this._onTamper === 'function') {
      try {
        this._onTamper(result)
      } catch (e) {
        console.warn('[tamper] onTamper handler failed:', e.message)
      }
    }

    return result
  }

  startHeartbeat() {
    if (this._timer) return
    this._timer = setInterval(() => {
      this._write({ cleanQuit: false, lastHeartbeat: this._now() })
    }, HEARTBEAT_INTERVAL_MS)
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  stopHeartbeat() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  }

  markCleanQuit() {
    this.stopHeartbeat()
    this._write({ cleanQuit: true, lastHeartbeat: this._now() })
  }
}

module.exports = { TamperDetector, HEARTBEAT_INTERVAL_MS, STALE_MS }
