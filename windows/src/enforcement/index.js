const EventEmitter = require('events')
const { PolicyCache } = require('./policy-cache')
const { ExeMap, UWP_HOST_BASENAMES } = require('./exe-map')
const { ForegroundMonitor } = require('./foreground-monitor')
const { OverridesStore } = require('./overrides-store')
const { UsageTracker } = require('./usage-tracker')
const { evaluate } = require('./block-evaluator')
const { verifyPin } = require('./pin-verify')
const { WarningChecker } = require('./warning-checker')

const DEFAULT_OVERRIDE_SECONDS = 3600
// Matches Android's AppBlockerModule PIN picker (15/30/60/120 min). Used
// as the allowlist when policy.settings.timeRequestMinutes is missing.
const DEFAULT_PIN_DURATION_MINUTES = [15, 30, 60, 120]
// Window in which a PIN verification stays good for a subsequent
// applyPinOverride call. Long enough for a kid to pick a duration button,
// short enough that a forgotten overlay can't be exploited later.
const PIN_VERIFY_TTL_MS = 30_000

// Wires the enforcement primitives together. The controller is intentionally
// I/O-free: it doesn't open BrowserWindows itself. The host (main/index.js)
// passes show/hide callbacks for the blocking overlay so the controller stays
// testable with a fake overlay.
class EnforcementController extends EventEmitter {
  constructor({
    activeWin,
    intervalMs,
    seenExesPath = null,   // persistence path for first-seen dedupe
    overridesStore = new OverridesStore(),
    usageTracker = new UsageTracker(),
    overlay = null,        // { show({packageName, appName, reason, category}), hide() }
    sodium = null,         // sodium-native, optional — required only for PIN verification
    isOwnWindow = null,    // (info) => bool — used to ignore our own electron windows
    warningChecker = new WarningChecker(),
    logger = console,
  } = {}) {
    super()
    this._sodium = sodium
    this.policyCache = new PolicyCache()
    this.exeMap = new ExeMap()
    this.overrides = overridesStore
    this.usage = usageTracker
    this.monitor = new ForegroundMonitor({ activeWin, intervalMs, seenExesPath })
    this._warningChecker = warningChecker
    this._overlay = overlay
    this._isOwnWindow = typeof isOwnWindow === 'function' ? isOwnWindow : () => false
    this._logger = logger
    this._getUsageSeconds = (pkg) => this.usage.getDailyUsageSeconds(pkg)

    // Track the latest foreground signal so applyGrant / setPolicyJson can
    // re-evaluate without waiting for the next monitor tick. This mirrors
    // Android's behavior of dismissing the overlay the moment a grant arrives.
    this._lastForeground = null  // { packageName, exeBasename, title }
    // Visibility tracking for the overlay. We can't use _currentOverlayKey ===
    // null as the "hidden" sentinel because unmapped exes legitimately have
    // packageName === null when blocked by lock or schedule.
    this._overlayVisible = false
    this._currentOverlayKey = null  // packageName || exeBasename of currently shown block
    // Set by verifyPinOnly on successful PIN, consumed by applyPinOverride.
    // null when no PIN has been verified (or window expired).
    this._pinVerified = null  // { expiresAt }

    this.monitor.on('foreground-changed', (info) => this._onForegroundChanged(info))
    this.monitor.on('error', (err) => this._logger.warn('[enforcement] active-win error:', err.message))

    // Re-evaluate when policy changes — a parent toggling status, lock, or
    // schedule should immediately reflect on the child without waiting for
    // a focus change.
    this.policyCache.on('change', () => this._reevaluateCurrent())

    // Periodic re-evaluation so a daily-limit crossing flips a live session to
    // blocked even while the kid stays in the same app. Started lazily in
    // start() so tests that never call start() don't leave a dangling timer.
    this._limitCheckTimer = null
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

  // Verify a PIN against the cached policy without applying a grant. Marks
  // the controller as "PIN-verified" for a short window so a subsequent
  // applyPinOverride can use the caller-supplied durationSeconds. Returns:
  //   { ok: true }                                             on success
  //   { ok: false, reason: 'no-policy'|'no-pin'|'wrong-pin'|'no-sodium' }
  verifyPinOnly({ pin }) {
    if (!this._sodium) return { ok: false, reason: 'no-sodium' }
    const policy = this.policyCache.getPolicy()
    const result = verifyPin({ sodium: this._sodium, policy, pin })
    if (!result.ok) return result
    this._pinVerified = { expiresAt: Date.now() + PIN_VERIFY_TTL_MS }
    return { ok: true }
  }

  // Apply the override grant for a PIN that verifyPinOnly has already
  // validated within PIN_VERIFY_TTL_MS. durationSeconds must be one of the
  // allowed options so a malicious renderer can't forge an arbitrary grant
  // even if it bypasses the UI. Returns:
  //   { ok: true, expiresAt, durationSeconds }                  on success
  //   { ok: false, reason: 'pin-not-verified'|'invalid-duration' }
  applyPinOverride({ packageName, durationSeconds }) {
    const now = Date.now()
    if (!this._pinVerified || this._pinVerified.expiresAt < now) {
      this._pinVerified = null
      return { ok: false, reason: 'pin-not-verified' }
    }
    const allowedSeconds = getAllowedPinDurationSeconds(this.policyCache.getPolicy())
    if (!allowedSeconds.includes(durationSeconds)) {
      return { ok: false, reason: 'invalid-duration' }
    }
    this._pinVerified = null
    const expiresAt = now + durationSeconds * 1000
    if (packageName) {
      this.applyGrant({ packageName, expiresAt })
    } else {
      this._reevaluateCurrent()
    }
    return { ok: true, expiresAt, durationSeconds }
  }

  // Duration options surfaced to the renderer for the post-PIN picker.
  getPinDurationSeconds() {
    return getAllowedPinDurationSeconds(this.policyCache.getPolicy())
  }

  setOverlay(overlay) {
    this._overlay = overlay
  }

  start() {
    this.monitor.start()
    if (!this._limitCheckTimer) {
      this._limitCheckTimer = setInterval(() => {
        this._reevaluateCurrent()
        this._checkWarnings()
      }, 5000)
      if (typeof this._limitCheckTimer.unref === 'function') this._limitCheckTimer.unref()
    }
  }

  // Compute countdown-warning events for the current foreground and policy,
  // then emit each as a `warning` event. main/index.js subscribes and turns
  // the event into an Electron toast. Separate method so tests can tick it
  // without spinning up the 5s timer.
  _checkWarnings() {
    const policy = this.policyCache.getPolicy()
    if (!policy) return
    const fg = this._lastForeground
    const events = this._warningChecker.check({
      policy,
      foregroundPackage: fg ? fg.packageName : null,
      getUsageSeconds: this._getUsageSeconds,
    })
    for (const ev of events) this.emit('warning', ev)
  }

  stop() {
    this.monitor.stop()
    if (this._limitCheckTimer) {
      clearInterval(this._limitCheckTimer)
      this._limitCheckTimer = null
    }
    this.usage.endActive()
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
    let exeBasename = info.exePath ? info.exePath.split(/[\\/]/).pop() : ''
    let packageName = this.exeMap.resolve(info.exePath)

    // UWP host fallback. ApplicationFrameHost.exe is the foreground owner
    // whenever the kid focuses a UWP app (Calculator, Store, Xbox, etc.) and
    // is in SYSTEM_EXEMPT_BASENAMES, so the evaluator would short-circuit if
    // we passed the host's basename through. Resolve the hosted UWP via the
    // title map and substitute a synthetic non-exempt exeBasename so
    // evaluate() treats this like a normal app foreground.
    if (!packageName && exeBasename && UWP_HOST_BASENAMES.has(exeBasename.toLowerCase())) {
      const uwp = this.exeMap.resolveUwpByTitle(info.title)
      if (uwp) {
        packageName = uwp.packageName
        exeBasename = uwp.exeBasename || ('uwp:' + packageName)
      }
    }

    this._lastForeground = {
      exePath: info.exePath,
      exeBasename,
      pid: info.pid,
      title: info.title,
      packageName,
    }
    // Feed the usage tracker. Unmapped exes are recorded as null so the
    // previous session closes cleanly without accruing to an unknown bucket.
    const policy = this.policyCache.getPolicy()
    const appName = (packageName && policy && policy.apps && policy.apps[packageName] && policy.apps[packageName].appName)
      || info.ownerName || exeBasename || null
    this.usage.noteForeground({ packageName, appName })
    this._evaluateAndApply()
  }

  // Re-run the evaluator against whatever exe is currently in the foreground,
  // without waiting for the next monitor tick. Driven by the 5s limit-check
  // timer, policy changes, grant arrivals, and any external caller that needs
  // to reflect a state change synchronously.
  reevaluate() {
    this._reevaluateCurrent()
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

function getAllowedPinDurationSeconds(policy) {
  const settings = (policy && policy.settings) || {}
  const raw = Array.isArray(settings.timeRequestMinutes) && settings.timeRequestMinutes.length
    ? settings.timeRequestMinutes
    : DEFAULT_PIN_DURATION_MINUTES
  const seen = new Set()
  const out = []
  for (const m of raw) {
    const n = Number(m)
    if (!Number.isFinite(n) || n <= 0) continue
    const seconds = Math.round(n * 60)
    if (seen.has(seconds)) continue
    seen.add(seconds)
    out.push(seconds)
  }
  return out.length ? out : DEFAULT_PIN_DURATION_MINUTES.map((m) => m * 60)
}

module.exports = { EnforcementController, getAllowedPinDurationSeconds, DEFAULT_PIN_DURATION_MINUTES }
