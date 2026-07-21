const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')

const DEFAULT_INTERVAL_MS = 1000
const SAVE_DEBOUNCE_MS = 500
// active-win shells out (xprop on X11, a gdbus call on our Wayland adapter) and
// can hang indefinitely if the child process never returns. Without a bound,
// one hung call sets _inflight forever and every subsequent tick early-returns
// at `if (this._inflight) return` - the monitor stops evaluating blocks, and
// nothing anywhere notices. 5s is far above a healthy poll (single-digit ms)
// while staying under the 5s re-evaluate tick.
const DEFAULT_ACTIVE_WIN_TIMEOUT_MS = 5000
// Consecutive timeouts before we stop treating it as a blip and declare the
// monitor stalled. Three means ~15s of no foreground reads.
const STALL_TIMEOUT_STREAK = 3

// Polls the active foreground window and emits 'foreground-changed' whenever
// the focused exe changes. Mirrors Android's TYPE_WINDOW_STATE_CHANGED hook
// plus the 5s EnforcementService poll, but on a single 1s tick because Windows
// has no equivalent of an Accessibility event push.
//
// Also emits 'app-first-seen' the first time a given exe basename appears in
// the foreground. This is the desktop analogue of Android's PACKAGE_ADDED
// broadcast — we can't observe installs directly on Windows (no filesystem
// watcher covers every portable/Store install path), so we approximate
// "installed" with "first launched". The seen set is persisted so a restart
// doesn't resurface exes the parent has already been told about.
class ForegroundMonitor extends EventEmitter {
  // activeWin is injected so tests can swap a fake. In production this is
  // require('active-win'), which returns a function returning a Promise.
  // seenExesPath is optional; when provided, the Set of seen basenames is
  // loaded on start() and persisted (debounced) after each new entry.
  constructor({
    activeWin,
    intervalMs = DEFAULT_INTERVAL_MS,
    seenExesPath = null,
    activeWinTimeoutMs = DEFAULT_ACTIVE_WIN_TIMEOUT_MS,
  } = {}) {
    super()
    if (typeof activeWin !== 'function') {
      throw new Error('ForegroundMonitor requires activeWin function')
    }
    this._activeWin = activeWin
    this._intervalMs = intervalMs
    this._seenExesPath = seenExesPath
    this._activeWinTimeoutMs = activeWinTimeoutMs
    this._seenExes = new Set()
    this._seenLoaded = false
    this._saveTimer = null
    this._timer = null
    this._lastKey = null
    this._inflight = false
    // How many polls in a row have timed out, and whether we've already said so.
    // The 'stalled' event fires once per stall, not once per tick, so the host
    // can alert the parent without spamming them every second.
    this._timeoutStreak = 0
    this._stallReported = false
  }

  // Resolve/reject with whatever active-win does, but never later than the
  // timeout. The underlying promise is deliberately abandoned rather than
  // awaited: if it is genuinely wedged it may never settle, and the whole point
  // is to free the next tick to run.
  _activeWinBounded() {
    const p = Promise.resolve(this._activeWin())
    if (!this._activeWinTimeoutMs) return p
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const err = new Error('active-win timed out after ' + this._activeWinTimeoutMs + 'ms')
        err.code = 'ACTIVE_WIN_TIMEOUT'
        reject(err)
      }, this._activeWinTimeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
      p.then(
        (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } },
        (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } },
      )
    })
  }

  // Hydrate the seen set from disk. Called automatically by start(); exposed
  // separately so tests can await it deterministically.
  loadSeen() {
    if (this._seenLoaded || !this._seenExesPath) {
      this._seenLoaded = true
      return
    }
    try {
      const raw = fs.readFileSync(this._seenExesPath, 'utf8')
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        for (const name of arr) {
          if (typeof name === 'string' && name) this._seenExes.add(name.toLowerCase())
        }
      }
    } catch (e) {
      if (e.code !== 'ENOENT') {
        this.emit('error', e)
      }
    }
    this._seenLoaded = true
  }

  // Pre-populate the seen set so a freshly-synced registry app doesn't fire
  // app-first-seen the moment the kid opens it. Called from main after
  // apps:sync returns. Basenames are normalized to lowercase.
  markSeen(basenames) {
    if (!Array.isArray(basenames)) return
    let added = false
    for (const name of basenames) {
      if (typeof name !== 'string' || !name) continue
      const lower = name.toLowerCase()
      if (!this._seenExes.has(lower)) {
        this._seenExes.add(lower)
        added = true
      }
    }
    if (added) this._scheduleSave()
  }

  hasSeen(basename) {
    if (!basename) return false
    return this._seenExes.has(String(basename).toLowerCase())
  }

  start() {
    if (this._timer) return
    this.loadSeen()
    this._tick()
    this._timer = setInterval(() => this._tick(), this._intervalMs)
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._flushSave()
  }

  async _tick() {
    if (this._inflight) return
    this._inflight = true
    try {
      const win = await this._activeWinBounded()
      // A successful read means whatever was wedged has cleared.
      if (this._timeoutStreak > 0) {
        const recovered = this._stallReported
        this._timeoutStreak = 0
        this._stallReported = false
        if (recovered) this.emit('recovered')
      }
      if (!win || !win.owner) {
        // No focusable window: the workstation is locked, the screen is off, or
        // active-win couldn't read the desktop. Previously this returned
        // silently, leaving the usage tracker's session open so it kept
        // accruing idle time against the last-focused app for as long as the
        // machine sat locked. Tell listeners so the session is closed.
        // Clearing _lastKey means returning to the same app after unlocking
        // re-emits foreground-changed (reopening the session, re-evaluating any
        // block) rather than being swallowed as "no change".
        this._lastKey = null
        this.emit('foreground-lost')
        return
      }
      const exePath = win.owner.path || ''
      const pid = win.owner.processId
      const title = win.title || ''
      const ownerName = win.owner.name
      const exeBasename = exePath ? exePath.split(/[\\/]/).pop() : ''

      if (exeBasename) {
        const lower = exeBasename.toLowerCase()
        if (!this._seenExes.has(lower)) {
          this._seenExes.add(lower)
          this._scheduleSave()
          this.emit('app-first-seen', { exePath, exeBasename, title, ownerName })
        }
      }

      // Heartbeat on EVERY successful poll, not just on a change. The usage
      // tracker needs proof it is still observing the foreground; without it,
      // "app still open" and "we stopped looking" (suspend/stall) are
      // indistinguishable and the open session silently accrues the gap.
      this.emit('tick', { exePath, pid, title, ownerName })

      const key = exePath + '|' + pid
      if (key === this._lastKey) return
      this._lastKey = key
      this.emit('foreground-changed', { exePath, pid, title, ownerName })
    } catch (e) {
      if (e && e.code === 'ACTIVE_WIN_TIMEOUT') {
        this._timeoutStreak++
        // Once we're persistently blind, the foreground is unknown, so close the
        // open usage session rather than keep accruing against the last-seen app
        // (same reasoning as the no-focusable-window branch above).
        if (this._timeoutStreak >= STALL_TIMEOUT_STREAK && !this._stallReported) {
          this._stallReported = true
          this._lastKey = null
          this.emit('foreground-lost')
          this.emit('stalled', { consecutiveTimeouts: this._timeoutStreak, timeoutMs: this._activeWinTimeoutMs })
        }
      }
      this.emit('error', e)
    } finally {
      // Always clear, including on a timeout. This is the whole fix: the
      // abandoned call may still be pending, but the next tick gets to run.
      this._inflight = false
    }
  }

  _scheduleSave() {
    if (!this._seenExesPath) return
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      this._flushSave()
    }, SAVE_DEBOUNCE_MS)
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref()
  }

  _flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer)
      this._saveTimer = null
    }
    if (!this._seenExesPath) return
    try {
      fs.mkdirSync(path.dirname(this._seenExesPath), { recursive: true })
      fs.writeFileSync(this._seenExesPath, JSON.stringify(Array.from(this._seenExes)))
    } catch (e) {
      this.emit('error', e)
    }
  }
}

module.exports = { ForegroundMonitor, DEFAULT_INTERVAL_MS }
