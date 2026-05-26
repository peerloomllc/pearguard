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

const DEFAULT_UUID = 'pearguard-focus@peerloomllc.com'
const CHECK_INTERVAL_MS = 15_000
// Don't fire onTamper more than once per 5-min window. Stops a kid who
// figures out the toggle from filling the parent's alert feed in a minute.
const CONSECUTIVE_REPORT_COOLDOWN_MS = 5 * 60_000

// Acceptable states reported by `gnome-extensions info`:
//   ENABLED, ACTIVE   — both indicate the extension is running. Newer GNOME
//                       releases prefer ACTIVE but ENABLED still appears in
//                       some intermediate states.
//   INITIALIZED       — loaded into shell but disabled by the user.
//   OUT_OF_DATE       — shell-version mismatch; treated as tamper-equivalent
//                       so the parent gets a heads-up; we still try
//                       gnome-extensions enable which on success bumps it.
//   ERROR             — extension crashed; same response as INITIALIZED.
const ACTIVE_STATES = new Set(['ENABLED', 'ACTIVE'])

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

class GnomeExtensionWatchdog extends EventEmitter {
  constructor({
    uuid = DEFAULT_UUID,
    checkIntervalMs = CHECK_INTERVAL_MS,
    cooldownMs = CONSECUTIVE_REPORT_COOLDOWN_MS,
    onTamper = null,
    logger = console,
    runExtensions = runGnomeExtensions,
    now = Date.now,
  } = {}) {
    super()
    this._uuid = uuid
    this._intervalMs = checkIntervalMs
    this._cooldownMs = cooldownMs
    this._onTamper = onTamper
    this._logger = logger
    this._run = runExtensions
    this._now = now
    this._timer = null
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
      this._logger.warn('[gnome-watchdog] info failed:', info.error)
      this._reportTamper('extension-info-failed')
      return
    }
    const state = extractState(info.stdout)
    if (!state) {
      this._logger.warn('[gnome-watchdog] could not parse State from gnome-extensions info; stdout=', info.stdout.slice(0, 120))
      return
    }
    if (ACTIVE_STATES.has(state)) {
      if (this._lastState && !ACTIVE_STATES.has(this._lastState)) {
        this._logger.log('[gnome-watchdog] extension back to ACTIVE')
      }
      this._lastState = state
      return
    }
    // Tampered (or out-of-date / errored). Always log; throttle the tamper
    // callback so the parent's alert feed doesn't get flooded.
    if (this._lastState !== state) {
      this._logger.warn('[gnome-watchdog] extension state changed to', state, '(was', this._lastState, ') — attempting re-enable')
    }
    this._lastState = state
    this._reportTamper(state === 'OUT_OF_DATE' ? 'extension-out-of-date' : 'extension-disabled')
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
  DEFAULT_UUID,
  CHECK_INTERVAL_MS,
  CONSECUTIVE_REPORT_COOLDOWN_MS,
}
