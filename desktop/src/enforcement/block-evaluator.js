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
  'searchhost.exe',            // Win11 search flyout
  'searchui.exe',              // Win10 Cortana/search UI
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
  // Host/broker processes: these show up as the foreground owner when a
  // UWP app is focused (ApplicationFrameHost) or when capability prompts
  // steal focus (RuntimeBroker). Blocking the host itself is meaningless —
  // the owned UWP needs to be resolved separately and evaluated on its own
  // packageName. Keeping the raw host exempt also stops first-sighting from
  // spamming the parent with "ApplicationFrameHost.exe was installed".
  'applicationframehost.exe',
  'runtimebroker.exe',
  'textinputhost.exe',         // Win11 IME / touch keyboard host
  'useroobebroker.exe',        // first-run / OOBE
  'widgets.exe',               // Win11 widgets board
  'widgetservice.exe',
])

// Linux counterpart of SYSTEM_EXEMPT_BASENAMES. Compositors, shells, and
// background daemons that own the foreground briefly during normal use must
// be allowed through unconditionally so a device-wide lock can never wedge
// the child in a black screen. Mirrors Android's PHONE_PACKAGES rule.
const LINUX_SYSTEM_EXEMPT_BASENAMES = new Set([
  // Desktop shells / panels
  'gnome-shell',
  'gnome-session',
  'gnome-session-binary',
  'kwin',
  'kwin_x11',
  'kwin_wayland',
  'plasmashell',
  'kded5',
  'kded6',
  'kdeinit5',
  'kdeinit6',
  'mutter',
  'mutter-x11-frames',
  'cinnamon',
  'mate-panel',
  'mate-session',
  'xfce4-panel',
  'xfce4-session',
  'lxsession',
  'lxqt-session',
  'i3',
  'sway',
  'hyprland',

  // Display servers / login managers
  'xorg',
  'xwayland',
  'gdm',
  'gdm3',
  'sddm',
  'lightdm',

  // System / IPC daemons that occasionally surface as foreground owners on
  // their own renderer windows (settings dialogs, notification popups).
  'systemd',
  'systemd-logind',
  'dbus-daemon',
  'dbus-broker',
  'pipewire',
  'wireplumber',
  'pulseaudio',
  'polkit-gnome-authentication-agent-1',
  'polkitd',

  // Input methods (foreground briefly during composition)
  'ibus-daemon',
  'ibus-x11',
  'fcitx5',

  // GNOME Settings + sub-tools that the user shouldn't be locked out of
  'gnome-control-center',
  'gnome-settings-daemon',
])

function isSystemExempt(exeBasename) {
  if (!exeBasename) return true
  const lower = exeBasename.toLowerCase()
  // Cross-platform check: Windows names carry .exe and Linux names don't,
  // so the two sets never collide. Walking both lets shared code on either
  // platform reach the right shell exemption without branching.
  return SYSTEM_EXEMPT_BASENAMES.has(lower) || LINUX_SYSTEM_EXEMPT_BASENAMES.has(lower)
}

// Returns null (allow) or { reason: string, category: string }.
//   category ∈ 'lock' | 'override-bypass' | 'screen_time' | 'schedule' | 'status' | 'daily_limit' | 'category_limit'
function evaluate({
  policy,
  packageName,
  exeBasename,
  overrides,
  getUsageSeconds,
  bonusSeconds = 0,
  // Optional () => [{ packageName, secondsToday }] over everything used today.
  // Supplied by the controller; omitted by callers that only have per-package
  // lookups, which keeps the old catalog-walk behavior.
  getAllUsage = null,
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

  // Step 0.5: Free-time / holiday pause — parent temporarily suspended ALL
  // enforcement until pauseUntil. The inverse of a lock (mutually exclusive with
  // it), so it allows everything, including unmapped exes.
  if (policy.pauseUntil && now < policy.pauseUntil) return null

  // Step 1: Active override beats everything below. Overrides key by
  // packageName, so unmapped exes have nothing to look up here.
  if (packageName && overrides) {
    const expiry = overrides.get(packageName)
    if (expiry && now < expiry) return null
  }

  // Step 1.5: Device-wide cumulative screen-time cap. Applies to every
  // non-exempt app (including unmapped exes), but the active override above
  // already returned null for the foreground app, so a parent-granted time
  // extension still wins. Parent-chosen exempt apps (#178) skip the cap and
  // fall through to their own limits. Exemption matches by packageName, so an
  // unmapped exe can never be exempt — same rule as scheduled blackouts below.
  if (!isScreenTimeExempt(policy, packageName)) {
    const screenTimeReason = getScreenTimeBlockReason(policy, getUsageSeconds, bonusSeconds, getAllUsage)
    if (screenTimeReason) return { reason: screenTimeReason, category: 'screen_time' }
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

  // Step 3.5: Per-app time-of-day window (allow-only or block-during).
  const windowReason = getAppWindowBlockReason(appPolicy, now)
  if (windowReason) return { reason: windowReason, category: 'schedule' }

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

// Parent-chosen apps that don't count toward the device-wide screen-time
// budget and stay usable once it's spent (#178).
function isScreenTimeExempt(policy, packageName) {
  if (!packageName) return false
  const exempt = policy.screenTimeExemptApps
  return Array.isArray(exempt) && exempt.includes(packageName)
}

// bonusSeconds is today's parent-granted top-up (#179), already date-checked by
// the caller. It raises the cap and nothing else.
function getScreenTimeBlockReason(policy, getUsageSeconds, bonusSeconds = 0, getAllUsage = null) {
  const base = policy.dailyScreenTimeLimitSeconds
  if (typeof base !== 'number' || base <= 0) return null
  const limit = base + (typeof bonusSeconds === 'number' && bonusSeconds > 0 ? bonusSeconds : 0)

  let total = 0
  // Sum over what was actually USED, not over the parent's catalog. Iterating
  // policy.apps meant any app missing from the catalog burned zero screen time:
  // an app first-sighted since the last apps:sync, or one whose identity didn't
  // match the catalog's, could be used all day against a device-wide cap that
  // never moved. The usage map only ever contains resolved packages (unmapped
  // exes are recorded as null), so this is still bounded to real apps.
  if (typeof getAllUsage === 'function') {
    let rows = []
    try {
      rows = getAllUsage() || []
    } catch (_e) {
      rows = []
    }
    for (const row of rows) {
      const pkg = row && row.packageName
      if (!pkg || isScreenTimeExempt(policy, pkg)) continue
      const seconds = typeof row.secondsToday === 'number' ? row.secondsToday : 0
      total += seconds > 0 ? seconds : 0
      if (total >= limit) break
    }
  } else {
    // No usage map supplied (older callers and most unit tests): fall back to
    // the catalog walk so behavior is unchanged rather than silently zero.
    const apps = policy.apps || {}
    for (const pkg of Object.keys(apps)) {
      if (isScreenTimeExempt(policy, pkg)) continue
      total += safeUsage(getUsageSeconds, pkg)
      if (total >= limit) break
    }
  }
  if (total >= limit) {
    return 'Screen time limit reached (' + Math.floor(limit / 60) + ' min/day).'
  }
  return null
}

function getScheduleBlockReason(policy, packageName, now) {
  const schedules = policy.schedules
  if (!Array.isArray(schedules) || schedules.length === 0) return null

  const d = new Date(now)
  const dayOfWeek = d.getDay()  // 0=Sunday, matches Android (Calendar.DAY_OF_WEEK - 1)
  // An overnight window's after-midnight tail belongs to the PREVIOUS day's
  // schedule entry, so we need yesterday's index too.
  const yesterday = (dayOfWeek + 6) % 7
  const nowMinutes = d.getHours() * 60 + d.getMinutes()

  for (const schedule of schedules) {
    if (!Array.isArray(schedule.days)) continue
    if (Array.isArray(schedule.exemptApps) && schedule.exemptApps.includes(packageName)) continue

    const start = parseHM(schedule.start)
    const end = parseHM(schedule.end)
    if (start == null || end == null) continue

    // The day check has to happen INSIDE the wrap branch, not before it. A
    // "Fri 22:00-06:00" rule has days=[5], and at 02:00 on Saturday the old
    // code bailed at the day test (6 is not in [5]) and allowed everything -
    // so the second half of every overnight blackout was free time, which is
    // exactly the half a kid is awake for. The pre-midnight segment belongs to
    // the listed day; the post-midnight segment belongs to the day BEFORE it.
    const inBlackout = start <= end
      ? schedule.days.includes(dayOfWeek) && nowMinutes >= start && nowMinutes < end
      : (schedule.days.includes(dayOfWeek) && nowMinutes >= start)
        || (schedule.days.includes(yesterday) && nowMinutes < end)

    if (inBlackout) {
      const label = schedule.label || 'scheduled time'
      return 'Blocked during "' + label + '".'
    }
  }
  return null
}

// Per-app time-of-day window. appPolicy.window = { mode:'allow'|'block',
// days:[0-6], start:'HH:MM', end:'HH:MM' }. Mirrors isBlockedByAppWindow in
// src/policy.js and getAppWindowBlockReason in AppBlockerModule.java.
function getAppWindowBlockReason(appPolicy, now) {
  const w = appPolicy && appPolicy.window
  if (!w || (w.mode !== 'allow' && w.mode !== 'block')) return null
  if (!Array.isArray(w.days) || w.days.length === 0 || !w.start || !w.end) return null

  const d = new Date(now)
  const dayOfWeek = d.getDay()
  const nowMinutes = d.getHours() * 60 + d.getMinutes()
  const start = parseHM(w.start)
  const end = parseHM(w.end)
  if (start == null || end == null) return null

  const dayMatches = w.days.includes(dayOfWeek)
  const inWindow = dayMatches && (start <= end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end)

  if (w.mode === 'block') {
    return inWindow ? 'Blocked from ' + fmt12(w.start) + ' to ' + fmt12(w.end) + '.' : null
  }
  return inWindow ? null : 'Allowed only ' + fmt12(w.start) + ' to ' + fmt12(w.end) + '.'
}

function fmt12(hhmm) {
  const m = parseHM(hhmm)
  if (m == null) return hhmm
  const h = Math.floor(m / 60)
  const min = m % 60
  const ap = h < 12 ? 'AM' : 'PM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return h12 + ':' + String(min).padStart(2, '0') + ' ' + ap
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

module.exports = { evaluate, isSystemExempt, SYSTEM_EXEMPT_BASENAMES, LINUX_SYSTEM_EXEMPT_BASENAMES }
