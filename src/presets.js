// src/presets.js
//
// Onboarding setup presets. First-run seeds nothing and initial pairing
// auto-approves every app, which is backwards for a young child. These presets
// compose a starting policy - a device-wide daily cap, category time limits and
// a bedtime blackout - by age, plus a strict allowlist-only mode that blocks
// every app so the parent approves just a few.
//
// Pure policy composition over the existing schema (policy.categories,
// policy.schedules, policy.dailyScreenTimeLimitSeconds, per-app status). No
// protocol change: the composed policy rides the normal policy:update path.
//
// Category names MUST match APP_CATEGORIES in src/ui/components/appCategories.js.

const MIN = 60
const HOUR = 60 * 60

// Age presets set a daily cap, category limits and a bedtime; they leave each
// app's allow/block decision intact (an existing block stays blocked).
const PRESETS = {
  young: {
    id: 'young',
    label: 'Young child',
    ageHint: 'Around 5-8',
    description: 'Tight limits and an early bedtime. A gentle starting point you can loosen later.',
    dailyScreenTimeLimitSeconds: 1 * HOUR,
    categories: { Games: 30 * MIN, Social: 15 * MIN, 'Video & Music': 30 * MIN },
    bedtime: { start: '19:30', end: '07:00' },
  },
  preteen: {
    id: 'preteen',
    label: 'Pre-teen',
    ageHint: 'Around 9-12',
    description: 'Moderate limits and a school-night bedtime.',
    dailyScreenTimeLimitSeconds: 2 * HOUR,
    categories: { Games: 60 * MIN, Social: 45 * MIN, 'Video & Music': 60 * MIN },
    bedtime: { start: '20:30', end: '07:00' },
  },
  teen: {
    id: 'teen',
    label: 'Teen',
    ageHint: 'Around 13-17',
    description: 'Lighter limits and a later bedtime.',
    dailyScreenTimeLimitSeconds: 4 * HOUR,
    categories: { Games: 2 * HOUR, Social: 90 * MIN },
    bedtime: { start: '22:00', end: '06:30' },
  },
  allowlist: {
    id: 'allowlist',
    label: 'Allowlist only',
    ageHint: 'Block by default',
    description: 'Blocks every app. You then approve just the handful you want to allow.',
    blockAll: true,
  },
}

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]

// Compose a preset onto an existing policy, returning a NEW policy object.
// Preserves everything not owned by the preset (pinHash, childPublicKey, apps
// for age presets, screenTimeExemptApps, etc.). Version is bumped by the
// policy:update handler, so it is left untouched here.
function composePreset (presetId, policy) {
  const preset = PRESETS[presetId]
  if (!preset) throw new Error('unknown preset: ' + presetId)
  const base = policy && typeof policy === 'object' ? policy : {}
  const next = { ...base }

  if (preset.blockAll) {
    // Allowlist-only: block every currently-known app; the parent approves a
    // few afterwards, and apps installed later arrive as 'pending' (blocked
    // until decided) on their own. Clear limits/schedules to a clean slate.
    const apps = {}
    for (const [pkg, ap] of Object.entries(base.apps || {})) {
      apps[pkg] = { ...ap, status: 'blocked' }
    }
    next.apps = apps
    next.categories = {}
    next.schedules = []
    delete next.dailyScreenTimeLimitSeconds
    return next
  }

  next.dailyScreenTimeLimitSeconds = preset.dailyScreenTimeLimitSeconds
  next.categories = {}
  for (const [cat, secs] of Object.entries(preset.categories)) {
    next.categories[cat] = { dailyLimitSeconds: secs }
  }
  next.schedules = [{
    label: 'Bedtime',
    days: ALL_DAYS.slice(),
    start: preset.bedtime.start,
    end: preset.bedtime.end,
    exemptApps: [],
  }]
  // Age presets intentionally leave per-app allow/block status untouched.
  return next
}

// Ordered list for the picker UI.
const PRESET_LIST = ['young', 'preteen', 'teen', 'allowlist'].map((id) => PRESETS[id])

module.exports = { PRESETS, PRESET_LIST, composePreset }
