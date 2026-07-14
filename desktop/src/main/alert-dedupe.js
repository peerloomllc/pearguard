// Should we alert the parent about this reason right now, or have we already?
//
// An enforcement problem is usually a STATE, not an event: an extension that
// isn't loaded stays not-loaded until the child logs out, and the watchdog
// re-checks every 15s. Its in-memory cooldown only throttled that to one alert
// per 5 minutes, which is how the parent's Activity feed filled with a wall of
// identical rows overnight (and, since the parent persists every alert, a wall
// of Hyperbee records to go with it). A parent who is pushed the same alert
// twelve times an hour learns to ignore all of them, which defeats the alert.
//
// So: at most one alert per reason per window, persisted, so a restart (or an
// auto-update, or a crash-loop) can't reset the counter and start the flood
// again. A CHANGE of reason always alerts immediately — that's new information.
const fs = require('fs')

const DEFAULT_WINDOW_MS = 12 * 60 * 60 * 1000

function readState(statePath, readFile) {
  try {
    return JSON.parse(readFile(statePath, 'utf8'))
  } catch (_e) {
    return {}
  }
}

// Deciding and recording are deliberately separate calls. The caller records
// only once the alert has actually reached bare — if the relay throws, we must
// NOT have written "already alerted", or a single failed send would mute the
// parent for the whole window. Suppression is only ever earned by an alert that
// really went out.

/**
 * @returns {boolean} true if this reason is outside its quiet window
 */
function shouldAlert({
  statePath,
  reason,
  now = Date.now(),
  windowMs = DEFAULT_WINDOW_MS,
  logger = console,
  readFile = fs.readFileSync,
} = {}) {
  if (!statePath || !reason) return true

  const last = readState(statePath, readFile)
  if (last.reason === reason && typeof last.at === 'number' && now - last.at < windowMs) {
    logger.log('[alert-dedupe] already alerted for', reason,
      Math.round((now - last.at) / 60000), 'min ago; staying quiet')
    return false
  }
  return true
}

function recordAlert({
  statePath,
  reason,
  now = Date.now(),
  logger = console,
  writeFile = fs.writeFileSync,
} = {}) {
  if (!statePath || !reason) return
  try {
    writeFile(statePath, JSON.stringify({ reason, at: now }))
  } catch (e) {
    // Couldn't record it: we may alert again next window. Noisy beats silent.
    logger.warn('[alert-dedupe] could not persist alert state:', e.message)
  }
}

module.exports = { shouldAlert, recordAlert, DEFAULT_WINDOW_MS }
