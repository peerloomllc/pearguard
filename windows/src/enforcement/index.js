const { PolicyCache } = require('./policy-cache')
const { ExeMap } = require('./exe-map')
const { ForegroundMonitor } = require('./foreground-monitor')
const { OverridesStore } = require('./overrides-store')
const { evaluate } = require('./block-evaluator')

// Wires the enforcement primitives together. The controller is intentionally
// I/O-free: it doesn't open BrowserWindows itself. The host (main/index.js)
// passes show/hide callbacks for the blocking overlay so the controller stays
// testable with a fake overlay.
class EnforcementController {
  constructor({
    activeWin,
    intervalMs,
    overridesStore = new OverridesStore(),
    overlay = null,        // { show({packageName, appName, reason, category}), hide() }
    logger = console,
  } = {}) {
    this.policyCache = new PolicyCache()
    this.exeMap = new ExeMap()
    this.overrides = overridesStore
    this.monitor = new ForegroundMonitor({ activeWin, intervalMs })
    this._overlay = overlay
    this._logger = logger
    this._getUsageSeconds = () => 0  // PR 3 plugs in real usage tracking

    // Track the latest foreground signal so applyGrant / setPolicyJson can
    // re-evaluate without waiting for the next monitor tick. This mirrors
    // Android's behavior of dismissing the overlay the moment a grant arrives.
    this._lastForeground = null  // { packageName, exeBasename, title }
    this._currentOverlayPkg = null

    this.monitor.on('foreground-changed', (info) => this._onForegroundChanged(info))
    this.monitor.on('error', (err) => this._logger.warn('[enforcement] active-win error:', err.message))

    // Re-evaluate when policy changes — a parent toggling status, lock, or
    // schedule should immediately reflect on the child without waiting for
    // a focus change.
    this.policyCache.on('change', () => this._reevaluateCurrent())
  }

  setPolicyJson(json) {
    return this.policyCache.setPolicyJson(json)
  }

  // Apply a grant from native:grantOverride. Re-evaluates the current
  // foreground app so the overlay dismisses immediately if the grant covers
  // the blocked app.
  applyGrant(grant) {
    const expiry = this.overrides.applyGrant(grant)
    if (expiry !== null) this._reevaluateCurrent()
    return expiry
  }

  setOverlay(overlay) {
    this._overlay = overlay
  }

  start() {
    this.monitor.start()
  }

  stop() {
    this.monitor.stop()
  }

  _onForegroundChanged(info) {
    const exeBasename = info.exePath ? info.exePath.split(/[\\/]/).pop() : ''
    this._lastForeground = {
      exePath: info.exePath,
      exeBasename,
      pid: info.pid,
      title: info.title,
      packageName: this.exeMap.resolve(info.exePath),
    }
    this._evaluateAndApply()
  }

  _reevaluateCurrent() {
    if (this._lastForeground) this._evaluateAndApply()
  }

  _evaluateAndApply() {
    const fg = this._lastForeground
    if (!fg) return
    const decision = evaluate({
      policy: this.policyCache.getPolicy(),
      packageName: fg.packageName,
      exeBasename: fg.exeBasename,
      overrides: this.overrides.asMap(),
      getUsageSeconds: this._getUsageSeconds,
    })

    if (decision) {
      this._logger.log('[enforcement] BLOCK', {
        exe: fg.exeBasename, pid: fg.pid, packageName: fg.packageName, title: fg.title, ...decision,
      })
      this._showOverlay(fg, decision)
    } else {
      this._logger.log('[enforcement] allow', {
        exe: fg.exeBasename, pid: fg.pid, packageName: fg.packageName || '(unmapped)',
      })
      this._hideOverlayIfShown()
    }
  }

  _showOverlay(fg, decision) {
    if (!this._overlay) return
    // If the same package is already overlaid, don't churn the window.
    if (this._currentOverlayPkg === fg.packageName) return
    const policy = this.policyCache.getPolicy()
    const appEntry = (policy && policy.apps && policy.apps[fg.packageName]) || {}
    const settings = (policy && policy.settings) || {}
    this._overlay.show({
      packageName: fg.packageName,
      appName: appEntry.appName || fg.packageName || fg.exeBasename,
      reason: decision.reason,
      category: decision.category,
      timeRequestMinutes: Array.isArray(settings.timeRequestMinutes) ? settings.timeRequestMinutes : null,
    })
    this._currentOverlayPkg = fg.packageName
  }

  _hideOverlayIfShown() {
    if (!this._overlay || !this._currentOverlayPkg) return
    this._overlay.hide()
    this._currentOverlayPkg = null
  }
}

module.exports = { EnforcementController }
