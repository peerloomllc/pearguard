// Port of AppBlockerModule.getBlockReason precedence:
//
//   exempt > deviceLock > override > schedule > status > dailyLimit > categoryLimit
//
// The evaluator is pure: it depends only on policy + clock + a usage callback.
// That makes it unit-testable without any Windows process state. Wiring lives
// in main/index.js.

const SYSTEM_EXEMPT_BASENAMES = new Set([
  // Always-allow shells so a device-wide lock can never trap the child in a
  // black screen. Mirror Android's PHONE_PACKAGES + system-overlay exemption.
  'explorer.exe',
  'searchapp.exe',
  'startmenuexperiencehost.exe',
  'shellexperiencehost.exe',
  'lockapp.exe',
  'logonui.exe',
  'dwm.exe',
  'csrss.exe',
  'winlogon.exe',
  'fontdrvhost.exe',
  'ctfmon.exe',
  'sihost.exe',
  'taskhostw.exe',
  'systemsettings.exe',
])

function isSystemExempt(exeBasename) {
  if (!exeBasename) return true
  return SYSTEM_EXEMPT_BASENAMES.has(exeBasename.toLowerCase())
}

// Returns null (allow) or { reason: string, category: string }.
//   category ∈ 'lock' | 'override-bypass' | 'schedule' | 'status' | 'daily_limit' | 'category_limit'
function evaluate({
  policy,
  packageName,
  exeBasename,
  overrides,
  getUsageSeconds,
  now = Date.now(),
}) {
  if (isSystemExempt(exeBasename)) return null
  if (!policy) return null

  // Step 0: Device-wide lock applies to everything non-exempt, including
  // unmapped exes. Otherwise a kid running mystery.exe would walk past the
  // lock just because we lack a packageName mapping.
  if (policy.locked) {
    const msg = (policy.lockMessage && String(policy.lockMessage).trim()) || 'Device is locked by your parent.'
    return { reason: msg, category: 'lock' }
  }

  // Step 1: Active override beats everything below. Overrides key by
  // packageName, so unmapped exes have nothing to look up here.
  if (packageName && overrides) {
    const expiry = overrides.get(packageName)
    if (expiry && now < expiry) return null
  }

  // Step 2: Scheduled blackout. exemptApps matches by packageName, so an
  // unmapped exe can never be exempt — meaning any unmapped exe falling
  // inside a scheduled window will block. That matches Android's
  // "everything blocked except listed exemptions" intent.
  const scheduleReason = getScheduleBlockReason(policy, packageName, now)
  if (scheduleReason) return { reason: scheduleReason, category: 'schedule' }

  // For status / limit checks we need a packageName to look anything up.
  if (!packageName) return null

  // Step 3: Status (blocked / pending).
  const apps = policy.apps || {}
  const appPolicy = apps[packageName]
  if (!appPolicy) return null  // unknown app — allow (Android default)

  if (appPolicy.status === 'blocked') {
    return { reason: 'Not approved by your parent.', category: 'status' }
  }
  if (appPolicy.status === 'pending') {
    return { reason: 'Needs parent approval.', category: 'status' }
  }

  // Step 4: Daily limit. Per-app wins over category fallback.
  const limit = appPolicy.dailyLimitSeconds
  if (typeof limit === 'number' && limit > 0) {
    const used = safeUsage(getUsageSeconds, packageName)
    if (used >= limit) {
      return {
        reason: 'Daily limit reached (' + Math.floor(limit / 60) + ' min/day).',
        category: 'daily_limit',
      }
    }
    return null
  }

  const categoryReason = getCategoryLimitReason(policy, apps, appPolicy, getUsageSeconds)
  if (categoryReason) return { reason: categoryReason, category: 'category_limit' }

  return null
}

function getScheduleBlockReason(policy, packageName, now) {
  const schedules = policy.schedules
  if (!Array.isArray(schedules) || schedules.length === 0) return null

  const d = new Date(now)
  const dayOfWeek = d.getDay()  // 0=Sunday, matches Android (Calendar.DAY_OF_WEEK - 1)
  const nowMinutes = d.getHours() * 60 + d.getMinutes()

  for (const schedule of schedules) {
    if (!Array.isArray(schedule.days) || !schedule.days.includes(dayOfWeek)) continue
    if (Array.isArray(schedule.exemptApps) && schedule.exemptApps.includes(packageName)) continue

    const start = parseHM(schedule.start)
    const end = parseHM(schedule.end)
    if (start == null || end == null) continue

    const inBlackout = start <= end
      ? nowMinutes >= start && nowMinutes < end
      : nowMinutes >= start || nowMinutes < end  // overnight wrap

    if (inBlackout) {
      const label = schedule.label || 'scheduled time'
      return 'Blocked during "' + label + '".'
    }
  }
  return null
}

function getCategoryLimitReason(policy, apps, appPolicy, getUsageSeconds) {
  const category = appPolicy.category
  if (!category) return null
  const categories = policy.categories || {}
  const cat = categories[category]
  if (!cat) return null
  const limit = cat.dailyLimitSeconds
  if (typeof limit !== 'number' || limit <= 0) return null

  let total = 0
  for (const [pkg, other] of Object.entries(apps)) {
    if (!other || other.category !== category) continue
    total += safeUsage(getUsageSeconds, pkg)
    if (total >= limit) break
  }
  if (total >= limit) {
    return category + ' limit reached (' + Math.floor(limit / 60) + ' min/day).'
  }
  return null
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

function safeUsage(getUsageSeconds, packageName) {
  if (typeof getUsageSeconds !== 'function') return 0
  try {
    const v = getUsageSeconds(packageName)
    return typeof v === 'number' && v > 0 ? v : 0
  } catch (_) {
    return 0
  }
}

module.exports = { evaluate, isSystemExempt, SYSTEM_EXEMPT_BASENAMES }
