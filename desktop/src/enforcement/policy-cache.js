const { EventEmitter } = require('events')

class PolicyCache extends EventEmitter {
  constructor() {
    super()
    this._policy = null
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
