const { EventEmitter } = require('events')

const DEFAULT_INTERVAL_MS = 1000

// Polls the active foreground window and emits 'foreground-changed' whenever
// the focused exe changes. Mirrors Android's TYPE_WINDOW_STATE_CHANGED hook
// plus the 5s EnforcementService poll, but on a single 1s tick because Windows
// has no equivalent of an Accessibility event push.
class ForegroundMonitor extends EventEmitter {
  // activeWin is injected so tests can swap a fake. In production this is
  // require('active-win'), which returns a function returning a Promise.
  constructor({ activeWin, intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    super()
    if (typeof activeWin !== 'function') {
      throw new Error('ForegroundMonitor requires activeWin function')
    }
    this._activeWin = activeWin
    this._intervalMs = intervalMs
    this._timer = null
    this._lastKey = null
    this._inflight = false
  }

  start() {
    if (this._timer) return
    this._tick()
    this._timer = setInterval(() => this._tick(), this._intervalMs)
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
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
      const key = exePath + '|' + pid
      if (key === this._lastKey) return
      this._lastKey = key
      this.emit('foreground-changed', { exePath, pid, title, ownerName: win.owner.name })
    } catch (e) {
      this.emit('error', e)
    } finally {
      this._inflight = false
    }
  }
}

module.exports = { ForegroundMonitor, DEFAULT_INTERVAL_MS }
