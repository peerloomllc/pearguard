const { PolicyCache } = require('./policy-cache')
const { ExeMap } = require('./exe-map')
const { ForegroundMonitor } = require('./foreground-monitor')
const { evaluate } = require('./block-evaluator')

// Wires the four enforcement primitives together. PR 1 scope: log decisions.
// PR 2 will replace the logger with overlay show/hide and override storage.
class EnforcementController {
  constructor({ activeWin, intervalMs, logger = console } = {}) {
    this.policyCache = new PolicyCache()
    this.exeMap = new ExeMap()
    this.overrides = new Map()  // packageName -> expiryMs (PR 2 populates)
    this.monitor = new ForegroundMonitor({ activeWin, intervalMs })
    this._logger = logger
    this._getUsageSeconds = () => 0  // PR 3 plugs in real usage tracking

    this.monitor.on('foreground-changed', (info) => this._onForegroundChanged(info))
    this.monitor.on('error', (err) => this._logger.warn('[enforcement] active-win error:', err.message))
  }

  setPolicyJson(json) {
    return this.policyCache.setPolicyJson(json)
  }

  start() {
    this.monitor.start()
  }

  stop() {
    this.monitor.stop()
  }

  _onForegroundChanged({ exePath, pid, title }) {
    const packageName = this.exeMap.resolve(exePath)
    const exeBasename = exePath ? exePath.split(/[\\/]/).pop() : ''
    const decision = evaluate({
      policy: this.policyCache.getPolicy(),
      packageName,
      exeBasename,
      overrides: this.overrides,
      getUsageSeconds: this._getUsageSeconds,
    })
    if (decision) {
      this._logger.log('[enforcement] BLOCK', { exe: exeBasename, pid, packageName, title, ...decision })
    } else {
      this._logger.log('[enforcement] allow', { exe: exeBasename, pid, packageName: packageName || '(unmapped)' })
    }
  }
}

module.exports = { EnforcementController }
