const fs = require('fs')
const path = require('path')
const { EventEmitter } = require('events')

// Last-known policy, mirrored to a JSON file so it survives a restart.
//
// This used to be memory-only (`this._policy = null`, no file, no load), which
// left every desktop restart completely unenforced. The only thing that ever
// fills the cache is a `native:setPolicy` push from bare, and bare pushes that
// exclusively on CHANGE - app installed/uninstalled, an apps:sync carrying new
// apps, or an incoming policy:update from the parent - plus once when a parent
// actually connects. Nothing pushed the stored policy at boot, even though the
// child's own Hyperbee holds it under the `policy` key. Meanwhile evaluate()
// returns null for a null policy, which means allow everything, including the
// device-wide lock. So from every desktop launch until a parent connected, the
// child was completely unprotected, and since a parent's phone app is closed
// most of the time that window ran to hours or days.
//
// Android was never affected: its native AppBlockerModule persists the policy
// in SharedPreferences. This is the desktop equivalent of that.
//
// Failing OPEN on a genuinely absent policy is deliberate and kept as-is: a
// fresh, never-paired install must not brick the machine, and a parent who has
// never set a policy has not asked us to block anything. What changes is what
// "absent" means. Before, it meant "we restarted". Now it means "this child has
// never received a policy", which is the only case where allowing everything is
// the right answer.
class PolicyCache extends EventEmitter {
  // filePath is optional - pass null (the default) for an ephemeral cache, which
  // is what the unit tests want.
  constructor({ filePath = null } = {}) {
    super()
    this._filePath = filePath
    this._policy = null
    if (filePath) this._load()
  }

  _load() {
    try {
      if (!fs.existsSync(this._filePath)) return
      const parsed = JSON.parse(fs.readFileSync(this._filePath, 'utf8'))
      // Guard the shape: a truthy non-object would sail through evaluate()'s
      // `if (!policy)` check and then throw on every property read, turning a
      // corrupt file into a crash loop instead of a fail-open.
      if (!parsed || typeof parsed !== 'object') return
      this._policy = parsed
      // Worth a line: it's the difference between "enforcing from the first
      // tick" and "unprotected until a parent connects", and it's the first
      // thing to check when a child reports blocking didn't apply after a boot.
      console.log('[policy-cache] hydrated last-known policy from disk:',
        Object.keys(parsed.apps || {}).length, 'apps, locked =', !!parsed.locked)
    } catch (e) {
      // Corrupt or unreadable file: stay null and fail open, exactly as a
      // never-paired install would. Loud, because this IS an enforcement hole.
      console.error('[policy-cache] load failed, starting with no policy:', e.message)
    }
  }

  _persist() {
    if (!this._filePath) return
    try {
      const dir = path.dirname(this._filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(this._filePath, JSON.stringify(this._policy))
    } catch (e) {
      console.error('[policy-cache] persist failed:', e.message)
    }
  }

  setPolicyJson(json) {
    let parsed
    try {
      parsed = JSON.parse(json)
    } catch (e) {
      console.error('[policy-cache] invalid policy JSON:', e.message)
      return false
    }
    this._policy = parsed
    this._persist()
    this.emit('change', parsed)
    return true
  }

  getPolicy() {
    return this._policy
  }

  hasPolicy() {
    return this._policy !== null
  }
}

module.exports = { PolicyCache }
