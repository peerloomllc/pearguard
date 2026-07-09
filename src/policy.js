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

// Device-wide cumulative cap: sums today's foreground seconds across every
// app with reported usage and compares to the policy's daily screen-time
// budget. Unlike per-app/category limits this ignores which app is in the
// foreground — once the total is spent, every non-exempt app is blocked.
// Exemptions (PearGuard itself, phone/messaging, system shells) are handled
// by the native callers, not here. Parent-chosen exempt apps (#178) are
// subtracted from the total so their use never spends the shared budget.
function hasExceededScreenTimeLimit(policy, usageStats) {
  if (!policy) return false
  const limit = policy.dailyScreenTimeLimitSeconds
  if (typeof limit !== 'number' || limit <= 0) return false
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
function isAppBlocked(packageName, policy, usageStats, now) {
  if (!policy) return false

  const appPolicy = policy.apps && policy.apps[packageName]

  if (appPolicy && appPolicy.status === 'blocked') return true
  if (appPolicy && appPolicy.status === 'pending') return true

  // Device-wide cumulative screen-time cap blocks every app once spent, except
  // the ones the parent marked exempt (#178). An exempt app still falls through
  // to the schedule and per-app/category limit checks below.
  if (!isScreenTimeExempt(packageName, policy) &&
      hasExceededScreenTimeLimit(policy, usageStats)) {
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
  isScheduleActive,
  hasExceededLimit,
  hasExceededCategoryLimit,
  hasExceededScreenTimeLimit,
  isScreenTimeExempt,
  isSmsCallException,
}
