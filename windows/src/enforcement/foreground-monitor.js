const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')

const DEFAULT_INTERVAL_MS = 1000
const SAVE_DEBOUNCE_MS = 500

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
  constructor({ activeWin, intervalMs = DEFAULT_INTERVAL_MS, seenExesPath = null } = {}) {
    super()
    if (typeof activeWin !== 'function') {
      throw new Error('ForegroundMonitor requires activeWin function')
    }
    this._activeWin = activeWin
    this._intervalMs = intervalMs
    this._seenExesPath = seenExesPath
    this._seenExes = new Set()
    this._seenLoaded = false
    this._saveTimer = null
    this._timer = null
    this._lastKey = null
    this._inflight = false
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
      const win = await this._activeWin()
      if (!win || !win.owner) return
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

      const key = exePath + '|' + pid
      if (key === this._lastKey) return
      this._lastKey = key
      this.emit('foreground-changed', { exePath, pid, title, ownerName })
    } catch (e) {
      this.emit('error', e)
    } finally {
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
