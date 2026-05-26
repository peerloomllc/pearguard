const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

// In-memory map of packageName -> expiryMs, mirrored to a JSON file so
// PIN-verified and parent-granted overrides survive an Electron restart. The
// evaluator reads from the in-memory Map directly (passed in as `overrides`).
class OverridesStore extends EventEmitter {
  // filePath is optional — pass null in tests for an ephemeral store.
  constructor({ filePath = null } = {}) {
    super()
    this._filePath = filePath
    this._map = new Map()
    if (filePath) this._load()
  }

  _load() {
    try {
      if (!fs.existsSync(this._filePath)) return
      const raw = fs.readFileSync(this._filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const now = Date.now()
      for (const [pkg, expiry] of Object.entries(parsed)) {
        if (typeof expiry === 'number' && expiry > now) {
          this._map.set(pkg, expiry)
        }
      }
    } catch (e) {
      console.error('[overrides-store] load failed:', e.message)
    }
  }

  _persist() {
    if (!this._filePath) return
    try {
      const dir = path.dirname(this._filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this._filePath, JSON.stringify(Object.fromEntries(this._map)))
    } catch (e) {
      console.error('[overrides-store] persist failed:', e.message)
    }
  }

  // Returns the underlying Map so callers can pass it to the evaluator. The
  // evaluator only reads, so handing out the live Map is fine and saves a
  // per-tick rebuild.
  asMap() {
    return this._map
  }

  // Apply a grant from native:grantOverride or pin:verify. Returns the new
  // expiry, or null if the grant is already in the past.
  applyGrant({ packageName, expiresAt }) {
    if (!packageName || typeof expiresAt !== 'number') return null
    if (expiresAt <= Date.now()) return null
    this._map.set(packageName, expiresAt)
    this._persist()
    this.emit('grant', { packageName, expiresAt })
    return expiresAt
  }

  // Drop entries whose expiry is in the past. Cheap to call; safe to no-op.
  prune(now = Date.now()) {
    let removed = 0
    for (const [pkg, expiry] of this._map.entries()) {
      if (expiry <= now) {
        this._map.delete(pkg)
        removed++
      }
    }
    if (removed > 0) this._persist()
    return removed
  }

  // For tests / debugging — does NOT persist on its own.
  clearAll() {
    this._map.clear()
    this._persist()
  }
}

module.exports = { OverridesStore }
