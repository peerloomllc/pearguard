// Brute-force lockout for the child-side PIN keypad, mirroring the Android
// implementation in AppBlockerModule.java (PIN_FREE_ATTEMPTS / PIN_LOCKOUT_LADDER_MS).
//
// The child controls this machine, so state is persisted to disk rather than
// held in memory: it has to survive closing the overlay and restarting Electron.
//
// Escalation is driven by the persisted failure count, not by elapsed time. A
// child who moves the system clock forward clears the current wait, but the
// count survives, so the next wrong guess costs strictly more than the last.

const fs = require('fs')
const path = require('path')

const FREE_ATTEMPTS = 5
const LOCKOUT_LADDER_MS = [30_000, 120_000, 600_000, 3_600_000]

// Milliseconds owed after `fails` consecutive wrong PINs; 0 while attempts remain.
function lockoutDelayForFailCount(fails) {
  if (fails <= FREE_ATTEMPTS) return 0
  const idx = Math.min(fails - FREE_ATTEMPTS - 1, LOCKOUT_LADDER_MS.length - 1)
  return LOCKOUT_LADDER_MS[idx]
}

// Remaining lockout in ms given persisted state, or 0 if the keypad is usable.
function lockRemainingMs(state, now) {
  const { lockedUntil = 0, lockedAt = 0 } = state || {}
  if (lockedUntil <= 0) return 0
  // Clock rolled back to before the lock was applied: serve the full remaining
  // duration rather than letting a backwards jump look like an expired lock.
  if (now < lockedAt) return lockedUntil - lockedAt
  if (now >= lockedUntil) return 0
  return lockedUntil - now
}

// Pure transition for a wrong PIN. Returns the next state plus the ms now owed.
function nextStateAfterFailure(state, now) {
  const fails = ((state && state.failCount) || 0) + 1
  const delay = lockoutDelayForFailCount(fails)
  if (delay <= 0) return { state: { failCount: fails, lockedAt: 0, lockedUntil: 0 }, lockMs: 0 }
  return { state: { failCount: fails, lockedAt: now, lockedUntil: now + delay }, lockMs: delay }
}

function attemptsRemaining(state) {
  return Math.max(0, FREE_ATTEMPTS - ((state && state.failCount) || 0))
}

// "1h 04m", "9m 30s" or "45s". Mirrors AppBlockerModule.formatLockRemaining.
function formatLockRemaining(ms) {
  const totalSeconds = Math.ceil(ms / 1000) // round up so we never display "0s"
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
}

const EMPTY = { failCount: 0, lockedAt: 0, lockedUntil: 0 }

// Persisted wrapper. filePath may be null for an ephemeral store (tests).
class PinLockoutStore {
  constructor({ filePath = null, now = () => Date.now() } = {}) {
    this._filePath = filePath
    this._now = now
    this._state = { ...EMPTY }
    if (filePath) this._load()
  }

  _load() {
    try {
      if (!fs.existsSync(this._filePath)) return
      const parsed = JSON.parse(fs.readFileSync(this._filePath, 'utf8'))
      this._state = {
        failCount: Number(parsed.failCount) || 0,
        lockedAt: Number(parsed.lockedAt) || 0,
        lockedUntil: Number(parsed.lockedUntil) || 0,
      }
    } catch (e) {
      console.error('[pin-lockout] load failed:', e.message)
    }
  }

  _persist() {
    if (!this._filePath) return
    try {
      const dir = path.dirname(this._filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this._filePath, JSON.stringify(this._state))
    } catch (e) {
      console.error('[pin-lockout] persist failed:', e.message)
    }
  }

  remainingMs() {
    return lockRemainingMs(this._state, this._now())
  }

  attemptsRemaining() {
    return attemptsRemaining(this._state)
  }

  // Returns the lockout in ms now owed, or 0 if attempts remain.
  recordFailure() {
    const { state, lockMs } = nextStateAfterFailure(this._state, this._now())
    this._state = state
    this._persist()
    return lockMs
  }

  clear() {
    this._state = { ...EMPTY }
    this._persist()
  }
}

module.exports = {
  PinLockoutStore,
  lockoutDelayForFailCount,
  lockRemainingMs,
  nextStateAfterFailure,
  attemptsRemaining,
  formatLockRemaining,
  FREE_ATTEMPTS,
  LOCKOUT_LADDER_MS,
}
