// Detect and counter the kid's most obvious bypass on a Linux/GNOME child:
// toggle off the PearGuard Focus Reporter extension in Settings → Extensions.
// Without the extension, the Wayland adapter's gdbus calls fail and the
// foreground monitor falls back to xprop, which can't see Wayland-native
// apps — enforcement silently stops.
//
// Watchdog responsibilities:
//   1. Poll `gnome-extensions info <uuid>` every CHECK_INTERVAL_MS to read
//      State. Only ACTIVE means the D-Bus interface is live.
//   2. If the state isn't ACTIVE, try `gnome-extensions enable <uuid>` to
//      put it back. Idempotent and cheap if it's already ACTIVE.
//   3. The first deactivation fires an onTamper callback so the host can
//      relay bypass:detected to the parent. Repeated transitions within
//      CONSECUTIVE_REPORT_COOLDOWN_MS are throttled to one report so a kid
//      furiously toggling the switch doesn't spam the parent's alert feed.
//   4. ENOENT on gnome-extensions (non-GNOME session) is treated as
//      "watchdog not applicable" and quietly stops the timer.
//
// Why poll instead of subscribing to extension-state signals: the
// gnome-shell-extensions D-Bus API is fragile across versions and a poll is
// 1ms of work every 15s. The Wayland adapter already shells out to gdbus
// once a second; we're not increasing the IPC footprint meaningfully.

const { EventEmitter } = require('events')
const { execFile } = require('child_process')
const { isSessionLocked } = require('../enforcement/session-lock')

const DEFAULT_UUID = 'pearguard-focus@peerloomllc.com'
const CHECK_INTERVAL_MS = 15_000
// Don't fire onTamper more than once per 5-min window. Stops a kid who
// figures out the toggle from filling the parent's alert feed in a minute.
const CONSECUTIVE_REPORT_COOLDOWN_MS = 5 * 60_000

// Acceptable states reported by `gnome-extensions info`:
//   ENABLED, ACTIVE   — both indicate the extension is running. Newer GNOME
//                       releases prefer ACTIVE but ENABLED still appears in
//                       some intermediate states.
//   INITIALIZED       — object created but the Shell hasn't run it.
//   INACTIVE          — enabled in settings, but the Shell never loaded it
//                       (typically: files changed and it needs a Shell restart,
//                       i.e. a logout on Wayland).
//   OUT_OF_DATE       — shell-version mismatch.
//   ERROR             — the extension crashed.
const ACTIVE_STATES = new Set(['ENABLED', 'ACTIVE'])

// `Enabled:` is the USER'S TOGGLE. `State:` is whether the Shell actually loaded
// it. Conflating the two is how we ended up telling a parent "Ben disabled
// PearGuard's app-blocking extension" when Ben had done nothing at all: the
// extension was `Enabled: Yes, State: INACTIVE` (the Shell simply hadn't loaded
// it), and every non-ACTIVE state was being reported as `extension-disabled`.
//
// A parental-control app must not accuse a child of defeating protection when
// the truth is that the protection failed on its own. So: only `Enabled: No` —
// the user affirmatively switching it off — counts as tampering. Everything else
// is reported as a capability failure, which the parent still hears about (they
// must know blocking is off) but which does not blame the child.
function classifyFailure(state, enabled) {
  if (enabled === false) return 'extension-disabled'      // the kid flipped the switch
  if (state === 'OUT_OF_DATE') return 'extension-out-of-date'
  if (state === 'ERROR') return 'extension-error'
  return 'extension-not-loaded'                            // INACTIVE / INITIALIZED / unknown
}

function runGnomeExtensions(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile('gnome-extensions', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message, code: err.code, stdout: stdout || '', stderr: stderr || '' })
        return
      }
      resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' })
    })
  })
}

// Parse the key:value text `gnome-extensions info` emits. Each line looks
// like `  State: ACTIVE` — leading whitespace varies across GNOME versions.
// Returns the value for `State` or null. Resilient to extra blank lines.
function extractState(infoStdout) {
  if (typeof infoStdout !== 'string') return null
  const m = infoStdout.match(/^\s*State:\s*(\S+)/m)
  return m ? m[1] : null
}

// `  Enabled: Yes` / `  Enabled: No`. Returns true/false, or null when the line
// is absent (older GNOME) — in which case we can't prove the user disabled it,
// so classifyFailure falls through to the non-accusatory branch. Fail towards
// "not the child's fault": a missed accusation is far cheaper than a false one.
function extractEnabled(infoStdout) {
  if (typeof infoStdout !== 'string') return null
  const m = infoStdout.match(/^\s*Enabled:\s*(\S+)/m)
  if (!m) return null
  return /^yes$/i.test(m[1]) ? true : (/^no$/i.test(m[1]) ? false : null)
}

class GnomeExtensionWatchdog extends EventEmitter {
  constructor({
    uuid = DEFAULT_UUID,
    checkIntervalMs = CHECK_INTERVAL_MS,
    cooldownMs = CONSECUTIVE_REPORT_COOLDOWN_MS,
    onTamper = null,
    logger = console,
    runExtensions = runGnomeExtensions,
    isLocked = isSessionLocked,
    now = Date.now,
  } = {}) {
    super()
    this._uuid = uuid
    this._intervalMs = checkIntervalMs
    this._cooldownMs = cooldownMs
    this._onTamper = onTamper
    this._logger = logger
    this._run = runExtensions
    this._isLocked = isLocked
    this._now = now
    this._timer = null
    // Logged once per lock so a long lock doesn't write a line every 15s.
    this._loggedLockSkip = false
    // Sentinel meaning "never reported"; a real Date.now() value will always
    // exceed -Infinity + cooldown so the very first tamper always reports.
    this._lastReportAt = -Infinity
    // _lastState tracks the previous check so we can log a transition rather
    // than spamming the log on every tick when the kid leaves it disabled.
    this._lastState = null
    this._stopped = false
  }

  start() {
    if (this._timer || this._stopped) return
    // Run an immediate check so a startup with the extension already off
    // doesn't wait 15s for the first repair.
    this._check().catch((e) => this._logger.warn('[gnome-watchdog] initial check failed:', e.message))
    this._timer = setInterval(
      () => this._check().catch((e) => this._logger.warn('[gnome-watchdog] check failed:', e.message)),
      this._intervalMs,
    )
    if (typeof this._timer.unref === 'function') this._timer.unref()
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._stopped = true
  }

  // A locked screen is not a failure, and it is not tampering — it is GNOME
  // doing exactly what we rely on it doing (see enforcement/session-lock.js).
  // While locked the extension is *supposed* to be unloaded, so anything that
  // looks broken right now proves nothing: say nothing, repair nothing, and
  // leave _lastState alone so the unlock doesn't read as a state transition.
  // Only consulted once something already looks wrong, so the healthy path
  // stays a single `gnome-extensions info` call per tick.
  async _suppressedByLock() {
    let locked = false
    try {
      locked = await this._isLocked()
    } catch (e) {
      // Can't tell => carry on and report. Never let a broken lock probe
      // swallow a real bypass.
      this._logger.warn('[gnome-watchdog] lock probe failed:', e.message)
      return false
    }
    if (!locked) {
      this._loggedLockSkip = false
      return false
    }
    if (!this._loggedLockSkip) {
      this._logger.log('[gnome-watchdog] session is locked; GNOME unloads the extension on the '
        + 'lock screen by design — not reporting, not re-enabling until it unlocks')
      this._loggedLockSkip = true
    }
    return true
  }

  async _check() {
    const info = await this._run(['info', this._uuid])
    if (!info.ok) {
      // ENOENT: gnome-extensions tool isn't installed (non-GNOME session).
      // Stop ourselves rather than logging every 15s for the life of the
      // process.
      if (info.code === 'ENOENT' || /command not found/i.test(info.stderr)) {
        this._logger.log('[gnome-watchdog] gnome-extensions tool missing; stopping watchdog')
        this.stop()
        return
      }
      // info on an uninstalled UUID returns non-zero with a specific message.
      // The installer should have placed the directory, but a destructive kid
      // can delete it. We can't reinstall from here (the source dir is in
      // the packaged resources path the host knows about) — emit tamper and
      // let main/index.js re-run the installer.
      // The extension directory is gone. A destructive kid deleting it is one
      // explanation, but a failed/partial install is another, and we cannot tell
      // them apart from here — so report it as "missing", not as "the child
      // disabled it". The parent still learns blocking is off; nobody gets
      // accused of something we can't prove.
      if (await this._suppressedByLock()) return
      this._logger.warn('[gnome-watchdog] info failed:', info.error)
      this._reportTamper('extension-missing')
      return
    }
    const state = extractState(info.stdout)
    const enabled = extractEnabled(info.stdout)
    if (!state) {
      this._logger.warn('[gnome-watchdog] could not parse State from gnome-extensions info; stdout=', info.stdout.slice(0, 120))
      return
    }
    if (ACTIVE_STATES.has(state)) {
      if (this._lastState && !ACTIVE_STATES.has(this._lastState)) {
        this._logger.log('[gnome-watchdog] extension back to ACTIVE')
      }
      this._lastState = state
      // Healthy again, so the session is plainly unlocked: re-arm the lock log
      // so the NEXT lock says so too. Otherwise it only ever prints once per
      // process and a later lock looks unexplained in the log.
      this._loggedLockSkip = false
      return
    }
    // Not running. Before anything else: is the screen simply locked? That alone
    // takes the extension INACTIVE (measured), and reporting it told the parent
    // "app blocking is off" every time the child locked their screen.
    if (await this._suppressedByLock()) return

    // Not running, and not locked. Classify WHY before telling the parent: only
    // an affirmative `Enabled: No` means the child switched it off.
    // INACTIVE/ERROR/OUT_OF_DATE are the app failing, not the kid defeating it.
    if (this._lastState !== state) {
      this._logger.warn('[gnome-watchdog] extension state changed to', state,
        '(was', this._lastState, ', enabled=' + enabled + ') — attempting re-enable')
    }
    this._lastState = state
    this._reportTamper(classifyFailure(state, enabled))
    // Try to re-enable. On OUT_OF_DATE this typically fails until the
    // metadata.json grows a new shell-version; we still try since it's free.
    const enableResult = await this._run(['enable', this._uuid])
    if (!enableResult.ok) {
      this._logger.warn('[gnome-watchdog] re-enable failed:', enableResult.error)
    }
  }

  _reportTamper(reason) {
    const now = this._now()
    if (now - this._lastReportAt < this._cooldownMs) return
    this._lastReportAt = now
    this.emit('tamper', { reason, at: now })
    if (typeof this._onTamper === 'function') {
      try { this._onTamper({ reason, at: now }) }
      catch (e) { this._logger.warn('[gnome-watchdog] onTamper handler threw:', e.message) }
    }
  }
}

module.exports = {
  GnomeExtensionWatchdog,
  extractState,
  extractEnabled,
  classifyFailure,
  DEFAULT_UUID,
  CHECK_INTERVAL_MS,
  CONSECUTIVE_REPORT_COOLDOWN_MS,
}
