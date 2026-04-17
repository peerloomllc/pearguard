const { PolicyCache } = require('./policy-cache')
const { ExeMap } = require('./exe-map')
const { ForegroundMonitor } = require('./foreground-monitor')
const { OverridesStore } = require('./overrides-store')
const { evaluate } = require('./block-evaluator')
const { verifyPin } = require('./pin-verify')

const DEFAULT_OVERRIDE_SECONDS = 3600

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
    sodium = null,         // sodium-native, optional — required only for PIN verification
    isOwnWindow = null,    // (info) => bool — used to ignore our own electron windows
    logger = console,
  } = {}) {
    this._sodium = sodium
    this.policyCache = new PolicyCache()
    this.exeMap = new ExeMap()
    this.overrides = overridesStore
    this.monitor = new ForegroundMonitor({ activeWin, intervalMs })
    this._overlay = overlay
    this._isOwnWindow = typeof isOwnWindow === 'function' ? isOwnWindow : () => false
    this._logger = logger
    this._getUsageSeconds = () => 0  // PR 3 plugs in real usage tracking

    // Track the latest foreground signal so applyGrant / setPolicyJson can
    // re-evaluate without waiting for the next monitor tick. This mirrors
    // Android's behavior of dismissing the overlay the moment a grant arrives.
    this._lastForeground = null  // { packageName, exeBasename, title }
    // Visibility tracking for the overlay. We can't use _currentOverlayKey ===
    // null as the "hidden" sentinel because unmapped exes legitimately have
    // packageName === null when blocked by lock or schedule.
    this._overlayVisible = false
    this._currentOverlayKey = null  // packageName || exeBasename of currently shown block

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

  // Verify a PIN against the cached policy. Used by the overlay before
  // routing audit logging through bare via pin:used. Returns:
  //   { ok: true, expiresAt: number, durationSeconds: number }   on success
  //   { ok: false, reason: 'no-policy'|'no-pin'|'wrong-pin'|'no-sodium' }
  verifyPinAndGrant({ pin, packageName }) {
    if (!this._sodium) return { ok: false, reason: 'no-sodium' }
    const policy = this.policyCache.getPolicy()
    const result = verifyPin({ sodium: this._sodium, policy, pin })
    if (!result.ok) return result
    const durationSeconds = (policy && policy.overrideDurationSeconds) || DEFAULT_OVERRIDE_SECONDS
    const expiresAt = Date.now() + durationSeconds * 1000
    if (packageName) {
      this.applyGrant({ packageName, expiresAt })
    } else {
      // No app to grant against (unmapped exe). Still re-evaluate so a
      // schedule-clearing policy push can dismiss; the kid won't get a
      // persistent override but at least the dialog completes successfully.
      this._reevaluateCurrent()
    }
    return { ok: true, expiresAt, durationSeconds }
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
    // Skip our own electron windows (main + overlay). When the kid clicks
    // "Enter PIN" the overlay window takes focus and active-win reports it as
    // electron.exe; without this guard the controller would re-show the
    // overlay against itself and clobber the PIN view.
    if (this._isOwnWindow(info)) {
      this._logger.log('[enforcement] skip own window', { exe: info.exePath, pid: info.pid })
      return
    }
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
    const key = fg.packageName || fg.exeBasename || ''
    // If the same target is already overlaid, don't churn the window.
    if (this._overlayVisible && this._currentOverlayKey === key) return
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
    this._overlayVisible = true
    this._currentOverlayKey = key
  }

  _hideOverlayIfShown() {
    if (!this._overlay || !this._overlayVisible) return
    this._overlay.hide()
    this._overlayVisible = false
    this._currentOverlayKey = null
  }
}

module.exports = { EnforcementController }
