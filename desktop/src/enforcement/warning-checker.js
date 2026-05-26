// Pure module: decides which countdown-warning thresholds the child is
// currently crossing, without firing any notifications itself. The controller
// owns the 5s tick and re-emits events; main/index.js turns those into
// Electron toast notifications. Mirrors android EnforcementService's
// checkScheduleWarnings / checkTimeLimitWarnings so both platforms warn with
// the same cadence and wording.

const DEFAULT_WARNING_THRESHOLDS_MIN = [10, 5, 1]
// Android uses a 6s grace against a 5s poll so exactly one tick lands inside
// the window per threshold crossing. We poll every 5s too; keep parity.
const GRACE_WINDOW_SECONDS = 6

class WarningChecker {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now
    // Dedupe per day so a 10-min warning doesn't re-fire on the next tick
    // or every time the kid alt-tabs back into the same app.
    this._shown = new Set()
    this._dayKey = null
  }

  // Returns an array of warning events that crossed a threshold this tick.
  // Each event: { kind: 'schedule'|'limit', id, threshold, title, body, ... }
  //
  // packageName is the currently foreground app (or null). Limits only warn
  // for the foreground app to match Android, which only inspects the app in
  // front of the kid.
  check({ policy, foregroundPackage, getUsageSeconds }) {
    if (!policy) return []
    const ts = this._now()
    this._resetIfNewDay(ts)
    const thresholds = getThresholds(policy)
    if (!thresholds.length) return []

    const events = []
    this._checkSchedules(policy, thresholds, ts, events)
    this._checkTimeLimits(policy, foregroundPackage, getUsageSeconds, thresholds, ts, events)
    return events
  }

  _resetIfNewDay(ts) {
    const d = new Date(ts)
    const key = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
    if (this._dayKey !== key) {
      this._shown.clear()
      this._dayKey = key
    }
  }

  _checkSchedules(policy, thresholds, ts, events) {
    const schedules = policy.schedules
    if (!Array.isArray(schedules) || schedules.length === 0) return
    const d = new Date(ts)
    const dayOfWeek = d.getDay()  // 0=Sunday, matches Android (Calendar.DAY_OF_WEEK - 1)
    const nowSeconds = d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()
    const maxThresholdSec = thresholds[0] * 60  // thresholds sorted descending

    for (let i = 0; i < schedules.length; i++) {
      const sched = schedules[i]
      if (!sched || !Array.isArray(sched.days) || !sched.days.includes(dayOfWeek)) continue
      const startMinutes = parseHM(sched.start)
      if (startMinutes == null) continue
      const startSeconds = startMinutes * 60
      let secondsUntil = startSeconds - nowSeconds
      if (secondsUntil < 0) secondsUntil += 86400
      if (secondsUntil <= 0) continue
      // Cheap gate: if the schedule is further out than the largest threshold
      // (+1 min slack), no threshold can fire this tick.
      if (secondsUntil > maxThresholdSec + 60) continue

      const label = sched.label || 'Scheduled block'
      for (const threshMin of thresholds) {
        const threshSec = threshMin * 60
        if (secondsUntil > threshSec) continue
        if (secondsUntil <= threshSec - GRACE_WINDOW_SECONDS) continue
        const dedupKey = 'sched:' + i + ':' + threshMin
        if (this._shown.has(dedupKey)) continue
        this._shown.add(dedupKey)
        events.push({
          kind: 'schedule',
          id: dedupKey,
          threshold: threshMin,
          scheduleIndex: i,
          label,
          title: label + ' starts in ' + threshMin + ' minute' + (threshMin > 1 ? 's' : ''),
          body: 'Apps will be restricted when "' + label + '" begins.',
        })
      }
    }
  }

  _checkTimeLimits(policy, packageName, getUsageSeconds, thresholds, ts, events) {
    if (!packageName) return
    const apps = policy.apps || {}
    const appPolicy = apps[packageName]
    if (!appPolicy) return
    const limit = appPolicy.dailyLimitSeconds
    if (typeof limit !== 'number' || limit <= 0) return
    const used = safeUsage(getUsageSeconds, packageName)
    const remaining = limit - used
    if (remaining <= 0) return

    const appName = appPolicy.appName || packageName
    for (const threshMin of thresholds) {
      const threshSec = threshMin * 60
      if (remaining > threshSec) continue
      if (remaining <= threshSec - GRACE_WINDOW_SECONDS) continue
      const dedupKey = 'limit:' + packageName + ':' + threshMin
      if (this._shown.has(dedupKey)) continue
      this._shown.add(dedupKey)
      events.push({
        kind: 'limit',
        id: dedupKey,
        threshold: threshMin,
        packageName,
        appName,
        title: appName + ': ' + threshMin + ' minute' + (threshMin > 1 ? 's' : '') + ' remaining',
        body: 'Your daily limit for ' + appName + ' is almost up.',
      })
    }
  }
}

function getThresholds(policy) {
  const settings = policy && policy.settings
  const raw = settings && Array.isArray(settings.warningMinutes) ? settings.warningMinutes : null
  if (!raw || raw.length === 0) return DEFAULT_WARNING_THRESHOLDS_MIN.slice()
  const seen = new Set()
  const nums = []
  for (const v of raw) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) continue
    const floored = Math.floor(n)
    if (seen.has(floored)) continue
    seen.add(floored)
    nums.push(floored)
  }
  if (nums.length === 0) return DEFAULT_WARNING_THRESHOLDS_MIN.slice()
  nums.sort((a, b) => b - a)  // descending so thresholds[0] is the largest
  return nums
}

function parseHM(s) {
  if (typeof s !== 'string') return null
  const parts = s.split(':')
  if (parts.length !== 2) return null
  const h = parseInt(parts[0], 10)
  const m = parseInt(parts[1], 10)
  if (Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

function safeUsage(fn, packageName) {
  if (typeof fn !== 'function') return 0
  try {
    const v = fn(packageName)
    return typeof v === 'number' && v > 0 ? v : 0
  } catch (_) {
    return 0
  }
}

module.exports = { WarningChecker, DEFAULT_WARNING_THRESHOLDS_MIN, GRACE_WINDOW_SECONDS }
