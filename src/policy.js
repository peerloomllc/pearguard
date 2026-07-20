'use strict'

function isPhoneOrMessagingApp(packageName) {
  const knownPackages = [
    'com.android.dialer',
    'com.google.android.dialer',
    'com.android.mms',
    'com.google.android.apps.messaging',
  ]
  if (knownPackages.includes(packageName)) return true
  return (
    packageName.includes('dialer') ||
    packageName.includes('sms') ||
    packageName.includes('messaging')
  )
}

function isScheduleActive(schedule, now) {
  if (!schedule || !schedule.days || !schedule.start || !schedule.end) {
    return false
  }

  const currentDay = now.getDay()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()

  const [startH, startM] = schedule.start.split(':').map(Number)
  const [endH, endM] = schedule.end.split(':').map(Number)
  const startMinutes = startH * 60 + startM
  const endMinutes = endH * 60 + endM

  if (endMinutes > startMinutes) {
    if (!schedule.days.includes(currentDay)) return false
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  } else {
    if (endMinutes === startMinutes) return false
    const yesterday = (currentDay + 6) % 7
    const inWindowA =
      schedule.days.includes(currentDay) && currentMinutes >= startMinutes
    const inWindowB =
      schedule.days.includes(yesterday) && currentMinutes < endMinutes
    return inWindowA || inWindowB
  }
}

// Per-app time-of-day window (#per-app-windows). An app can carry a single
// `window` = { mode: 'allow'|'block', days:[0-6], start:'HH:MM', end:'HH:MM' }:
//   - mode 'allow'  → usable ONLY inside the window ("games only 4-6pm")
//   - mode 'block'  → blocked DURING the window ("social blocked during school")
// Reuses isScheduleActive for the day + overnight-wrap maths. A malformed window
// has no effect (returns false) so a half-configured rule never bricks an app.
function isBlockedByAppWindow(appPolicy, now) {
  const w = appPolicy && appPolicy.window
  if (!w || (w.mode !== 'allow' && w.mode !== 'block')) return false
  if (!Array.isArray(w.days) || w.days.length === 0 || !w.start || !w.end) return false
  const inside = isScheduleActive(w, now)
  return w.mode === 'block' ? inside : !inside
}

function hasExceededLimit(packageName, policy, usageStats) {
  if (!policy || !policy.apps) return false
  const appPolicy = policy.apps[packageName]
  if (!appPolicy) return false
  if (typeof appPolicy.dailyLimitSeconds !== 'number') return false

  const stats = usageStats && usageStats[packageName]
  if (!stats) return false
  return stats.dailySeconds >= appPolicy.dailyLimitSeconds
}

// Per-app limit wins: only consult category limit when the app has no
// dailyLimitSeconds of its own.
function hasExceededCategoryLimit(packageName, policy, usageStats) {
  if (!policy || !policy.apps || !policy.categories) return false
  const appPolicy = policy.apps[packageName]
  if (!appPolicy) return false
  if (typeof appPolicy.dailyLimitSeconds === 'number') return false

  const category = appPolicy.category
  if (!category) return false
  const categoryPolicy = policy.categories[category]
  if (!categoryPolicy || typeof categoryPolicy.dailyLimitSeconds !== 'number') {
    return false
  }

  let total = 0
  for (const pkg of Object.keys(policy.apps)) {
    if (policy.apps[pkg].category !== category) continue
    const stats = usageStats && usageStats[pkg]
    if (stats && typeof stats.dailySeconds === 'number') {
      total += stats.dailySeconds
    }
  }
  return total >= categoryPolicy.dailyLimitSeconds
}

// Parent-chosen apps that don't count toward the device-wide screen-time
// budget and stay usable once it's spent (#178). Distinct from the built-in
// exemptions (PearGuard, phone/messaging, system shells), which the native
// callers filter before we ever see them.
function isScreenTimeExempt(packageName, policy) {
  if (!policy) return false
  const exempt = policy.screenTimeExemptApps
  return Array.isArray(exempt) && exempt.includes(packageName)
}

// Local calendar date as YYYY-MM-DD. Bonus grants are stamped with this so a
// grant silently expires at midnight, and a rolled-back device clock discards
// it rather than extending it (fails safe — see the clock-tamper detector).
function localDateKey(now) {
  const d = now instanceof Date ? now : new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// Parent-granted top-up on today's screen-time budget (#179), or 0 if the
// grant is absent or was issued on a different day.
function bonusSecondsForToday(bonus, now) {
  if (!bonus || typeof bonus.seconds !== 'number' || bonus.seconds <= 0) return 0
  if (bonus.date !== localDateKey(now)) return 0
  return bonus.seconds
}

// The cap actually enforced right now: the parent's daily budget plus any
// general-time top-up granted today. Returns 0 when no cap is configured.
function effectiveScreenTimeLimitSeconds(policy, bonus, now) {
  if (!policy) return 0
  const limit = policy.dailyScreenTimeLimitSeconds
  if (typeof limit !== 'number' || limit <= 0) return 0
  return limit + bonusSecondsForToday(bonus, now)
}

// Device-wide cumulative cap: sums today's foreground seconds across every
// app with reported usage and compares to the policy's daily screen-time
// budget. Unlike per-app/category limits this ignores which app is in the
// foreground — once the total is spent, every non-exempt app is blocked.
// Exemptions (PearGuard itself, phone/messaging, system shells) are handled
// by the native callers, not here. Parent-chosen exempt apps (#178) are
// subtracted from the total so their use never spends the shared budget.
// A general-time grant (#179) raises the cap for the rest of today.
function hasExceededScreenTimeLimit(policy, usageStats, bonus, now = Date.now()) {
  if (!policy) return false
  const limit = effectiveScreenTimeLimitSeconds(policy, bonus, now)
  if (limit <= 0) return false
  if (!usageStats) return false

  let total = 0
  for (const pkg of Object.keys(usageStats)) {
    if (isScreenTimeExempt(pkg, policy)) continue
    const stats = usageStats[pkg]
    if (stats && typeof stats.dailySeconds === 'number') {
      total += stats.dailySeconds
    }
  }
  return total >= limit
}

// What the child needs to know about scheduled blackouts: the one running right
// now (with when it lifts), or the next one due to start. Handles overnight
// windows, where `end` is earlier in the day than `start` and the window runs
// into the following morning.
//
// Returns { active, label, at } where `at` is a Date: the end of the active
// window, or the start of the next one. Null when no schedule applies.
function nextScheduleWindow(schedules, now) {
  if (!Array.isArray(schedules) || schedules.length === 0) return null
  const parse = (hm) => {
    const [h, m] = String(hm).split(':').map(Number)
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
  }
  const atMinutes = (baseDate, dayOffset, minutes) => {
    const d = new Date(baseDate)
    d.setDate(d.getDate() + dayOffset)
    d.setHours(0, 0, 0, 0)
    d.setMinutes(minutes)
    return d
  }

  // An active window wins: the child cares about when they get their device back.
  for (const s of schedules) {
    if (!isScheduleActive(s, now)) continue
    const end = parse(s.end)
    if (end == null) continue
    const start = parse(s.start)
    // Overnight window entered yesterday ends today; otherwise it ends today too,
    // unless start === end which isScheduleActive already rejected.
    const endsToday = start == null || end > start || now.getHours() * 60 + now.getMinutes() < end
    return { active: true, label: s.label || 'Bedtime', at: atMinutes(now, endsToday ? 0 : 1, end) }
  }

  // Otherwise the soonest upcoming start within the next week.
  let best = null
  for (const s of schedules) {
    const start = parse(s.start)
    if (start == null || !Array.isArray(s.days) || s.days.length === 0) continue
    for (let offset = 0; offset < 8; offset++) {
      const candidate = atMinutes(now, offset, start)
      if (candidate <= now) continue
      if (!s.days.includes(candidate.getDay())) continue
      if (!best || candidate < best.at) best = { active: false, label: s.label || 'Bedtime', at: candidate }
      break
    }
  }
  return best
}

function isSmsCallException(packageName, contactPhone, policy) {
  if (!isPhoneOrMessagingApp(packageName)) return false
  if (!policy || !policy.allowedContacts) return false
  if (!contactPhone) return false
  return policy.allowedContacts.some((c) => c.phone === contactPhone)
}

/**
 * Primary enforcement decision. Returns true if the app should be blocked.
 *
 * Checks (in order):
 *   1. App is explicitly blocked in policy
 *   2. App is pending approval
 *   3. Cumulative device-wide screen time exceeded (unless app is exempt)
 *   4. Any active schedule blocks all apps
 *   5. App has exceeded its daily limit
 *
 * Does NOT check override grants — callers handle those before calling this.
 *
 * @param {string} packageName
 * @param {object} policy         Full policy object (may be null/undefined → not blocked)
 * @param {object} usageStats     { [packageName]: { dailySeconds } }
 * @param {Date}   now            Current time (injected for testability)
 * @returns {boolean}
 */
// Free-time / holiday pause (#pause). A parent can temporarily suspend ALL
// enforcement until a chosen epoch — the inverse of a device lock. While active
// every app is allowed; when `pauseUntil` passes, normal enforcement resumes.
// Trusts the wall clock, like bonus grants and schedules.
function isPaused(policy, now) {
  const until = policy && policy.pauseUntil
  if (!until) return false
  return (now == null ? Date.now() : now) < until
}

function isAppBlocked(packageName, policy, usageStats, now, bonus) {
  if (!policy) return false

  // Free-time pause suspends everything, including a 'blocked' status. Checked
  // first so it wins over schedules, limits and explicit blocks. (A device lock
  // is mutually exclusive with pause — setting one clears the other.)
  if (isPaused(policy, now)) return false

  const appPolicy = policy.apps && policy.apps[packageName]

  if (appPolicy && appPolicy.status === 'blocked') return true
  if (appPolicy && appPolicy.status === 'pending') return true

  // Per-app time-of-day window — an extra restriction on top of the app's status.
  if (isBlockedByAppWindow(appPolicy, now)) return true

  // Device-wide cumulative screen-time cap blocks every app once spent, except
  // the ones the parent marked exempt (#178). An exempt app still falls through
  // to the schedule and per-app/category limit checks below. A general-time
  // grant (#179) raises the cap but changes nothing else — so a blocked app,
  // an app past its own limit, or a bedtime schedule all still block.
  if (!isScreenTimeExempt(packageName, policy) &&
      hasExceededScreenTimeLimit(policy, usageStats, bonus, now)) {
    return true
  }

  const schedules = policy.schedules || []
  for (const schedule of schedules) {
    if (isScheduleActive(schedule, now)) return true
  }

  if (hasExceededLimit(packageName, policy, usageStats)) return true
  if (hasExceededCategoryLimit(packageName, policy, usageStats)) return true

  return false
}

module.exports = {
  isAppBlocked,
  isPaused,
  isBlockedByAppWindow,
  isScheduleActive,
  hasExceededLimit,
  hasExceededCategoryLimit,
  hasExceededScreenTimeLimit,
  isScreenTimeExempt,
  effectiveScreenTimeLimitSeconds,
  bonusSecondsForToday,
  localDateKey,
  nextScheduleWindow,
  isSmsCallException,
}
