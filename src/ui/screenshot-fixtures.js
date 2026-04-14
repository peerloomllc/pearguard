// Screenshot-mode fixtures. Activated when window.__PEARGUARD_SCREENSHOT_SCENE is
// set before this bundle runs. Replaces window.callBare with canned responses and
// freezes "now" to FROZEN_NOW so rendered timestamps are deterministic.
//
// PearGuard's UI calls window.callBare(method, args) directly (there is no shared
// db/sync/notifs object like PearCal), so fixtures work by installing a fake
// callBare that dispatches on method name to canned data.
//
// Scenes (tune these — user can rewire SCENES to match desired App Store shots):
//   1 — Parent dashboard: one paired child, today's screen time, pending alerts
//   2 — Child detail: Rules tab (policy editor)
//   3 — Child detail: Apps tab
//   4 — Parent dashboard showing the Invite card (no child paired yet)
//   5 — Child home screen (child mode)

export const FROZEN_TODAY = '2026-04-14'
const FROZEN_MS = new Date(FROZEN_TODAY + 'T09:41:00').getTime()

const _darkFlag = typeof window !== 'undefined' ? window.__PEARGUARD_SCREENSHOT_DARK : -1
const PREFERS_DARK = _darkFlag === 1 ? true
  : _darkFlag === 0 ? false
  : (typeof window !== 'undefined' && window.matchMedia
      && window.matchMedia('(prefers-color-scheme: dark)').matches)

// ─── Child records (visible in parent dashboard) ─────────────────────────────
const CHILD_ALEX = {
  publicKey: 'a1b2c3d4e5f6708192a1b2c3d4e5f6708192a1b2c3d4e5f6708192a1b2c3d4e5',
  displayName: 'Alex',
  avatar: null,
  pairedAt: FROZEN_MS - 12 * 86400000,
  bypassAlerts: 0,
  pendingApprovals: 2,
  pendingTimeRequests: 1,
  todayScreenTimeSeconds: 2 * 3600 + 17 * 60,
  currentApp: 'YouTube',
  currentAppPackage: 'com.google.android.youtube',
  currentAppIcon: null,
  locked: false,
}

// ─── Policy (RulesTab / AppsTab) ─────────────────────────────────────────────
const POLICY = {
  version: 4,
  updatedAt: FROZEN_MS - 3600000,
  schoolHours: { enabled: true, start: '08:30', end: '15:00', days: [1, 2, 3, 4, 5] },
  bedtime: { enabled: true, start: '21:00', end: '07:00' },
  dailyLimit: { enabled: true, minutes: 120 },
  categoryLimits: {
    social: { minutes: 30 },
    games: { minutes: 45 },
    video: { minutes: 60 },
  },
  apps: {
    'com.google.android.youtube':  { status: 'allowed', limitMinutes: 30, category: 'video' },
    'com.instagram.android':       { status: 'blocked', category: 'social' },
    'com.roblox.client':           { status: 'allowed', limitMinutes: 45, category: 'games' },
    'com.discord':                 { status: 'pending', category: 'social' },
    'com.spotify.music':           { status: 'allowed', category: 'music' },
    'com.duolingo':                { status: 'allowed', category: 'education' },
    'com.netflix.mediaclient':     { status: 'allowed', limitMinutes: 60, category: 'video' },
    'com.tiktok':                  { status: 'blocked', category: 'social' },
    'com.snapchat.android':        { status: 'pending', category: 'social' },
  },
  allowedContacts: [
    { name: 'Mom', phone: '+15551234567' },
    { name: 'Dad', phone: '+15559876543' },
    { name: 'Grandma', phone: '+15555550142' },
  ],
}

const APP_META = [
  { packageName: 'com.google.android.youtube', label: 'YouTube',   category: 'video',     todaySeconds: 42 * 60 },
  { packageName: 'com.roblox.client',          label: 'Roblox',    category: 'games',     todaySeconds: 38 * 60 },
  { packageName: 'com.spotify.music',          label: 'Spotify',   category: 'music',     todaySeconds: 21 * 60 },
  { packageName: 'com.duolingo',               label: 'Duolingo',  category: 'education', todaySeconds: 12 * 60 },
  { packageName: 'com.netflix.mediaclient',    label: 'Netflix',   category: 'video',     todaySeconds: 18 * 60 },
  { packageName: 'com.instagram.android',      label: 'Instagram', category: 'social',    todaySeconds: 0 },
  { packageName: 'com.tiktok',                 label: 'TikTok',    category: 'social',    todaySeconds: 0 },
  { packageName: 'com.discord',                label: 'Discord',   category: 'social',    todaySeconds: 0 },
  { packageName: 'com.snapchat.android',       label: 'Snapchat',  category: 'social',    todaySeconds: 0 },
]

// ─── Usage report ────────────────────────────────────────────────────────────
const USAGE_REPORT = {
  childPublicKey: CHILD_ALEX.publicKey,
  timestamp: FROZEN_MS - 5 * 60 * 1000,
  lastSynced: FROZEN_MS - 5 * 60 * 1000,
  apps: APP_META.filter(a => a.todaySeconds > 0).map(a => ({
    packageName: a.packageName,
    label: a.label,
    category: a.category,
    todaySeconds: a.todaySeconds,
    weekSeconds: a.todaySeconds * 5,
    limitMinutes: POLICY.apps[a.packageName]?.limitMinutes ?? null,
  })),
}

// ─── Alerts / requests ───────────────────────────────────────────────────────
const ALERTS = [
  { id: 'a-1', type: 'bypass',   childPublicKey: CHILD_ALEX.publicKey, at: FROZEN_MS - 90 * 60 * 1000,   message: 'Override PIN used on TikTok' },
  { id: 'a-2', type: 'timeReq',  childPublicKey: CHILD_ALEX.publicKey, at: FROZEN_MS - 25 * 60 * 1000,   message: '+15 min requested (Roblox)' },
  { id: 'a-3', type: 'appReq',   childPublicKey: CHILD_ALEX.publicKey, at: FROZEN_MS - 8 * 60 * 1000,    message: 'Discord — awaiting approval' },
]

// ─── Child home data ─────────────────────────────────────────────────────────
const CHILD_HOME = {
  locked: false,
  parentName: 'Mom',
  todayScreenTimeSeconds: 2 * 3600 + 17 * 60,
  dailyLimitMinutes: 120,
  blockedCount: 2,
  pendingAppCount: 2,
  pendingRequestCount: 1,
  schoolHoursActive: false,
  bedtimeActive: false,
  nextUnlock: null,
  apps: APP_META.slice(0, 5),
}

// ─── Scene definitions ───────────────────────────────────────────────────────
// A scene is state that fixtures bake into responses. openChild triggers
// ChildDetail navigation; openTab selects the nested child tab.
export const SCENES = {
  1: { mode: 'parent', children: [CHILD_ALEX] },
  2: { mode: 'parent', children: [CHILD_ALEX], openChild: CHILD_ALEX.publicKey, openTab: 'rules' },
  3: { mode: 'parent', children: [CHILD_ALEX], openChild: CHILD_ALEX.publicKey, openTab: 'apps' },
  4: { mode: 'parent', children: [], showInvite: true },
  5: { mode: 'child' },
}

// ─── Date freeze ─────────────────────────────────────────────────────────────
function freezeDate () {
  const OrigDate = window.Date
  const FrozenDate = function (...args) {
    if (args.length === 0) return new OrigDate(FROZEN_MS)
    return new OrigDate(...args)
  }
  FrozenDate.now = () => FROZEN_MS
  FrozenDate.parse = OrigDate.parse
  FrozenDate.UTC = OrigDate.UTC
  FrozenDate.prototype = OrigDate.prototype
  window.Date = FrozenDate
}

// ─── Fake callBare dispatch ──────────────────────────────────────────────────
function makeCallBare (scene) {
  const children = scene.children ?? []
  const mode = scene.mode ?? 'parent'

  return function fakeCallBare (method, args) {
    args = args || {}
    switch (method) {
      // identity / setup
      case 'identity:getMode':     return Promise.resolve({ mode })
      case 'identity:getName':     return Promise.resolve({ name: mode === 'parent' ? 'Mom' : 'Alex' })
      case 'identity:setName':     return Promise.resolve(true)
      case 'identity:setAvatar':   return Promise.resolve(true)

      // parent dashboard
      case 'children:list':        return Promise.resolve(children)
      case 'pin:isSet':            return Promise.resolve({ isSet: true })
      case 'pin:get':              return Promise.resolve({ pin: '1234' })
      case 'pin:set':              return Promise.resolve(true)
      case 'donation:check':       return Promise.resolve({ createdAt: FROZEN_MS - 3 * 86400000, dismissed: false })
      case 'donation:dismiss':     return Promise.resolve(true)

      // policy / apps / usage
      case 'policy:get':           return Promise.resolve(POLICY)
      case 'policy:update':        return Promise.resolve(true)
      case 'policy:setLock':       return Promise.resolve(true)
      case 'overrides:list':       return Promise.resolve([])
      case 'usage:getLatest':      return Promise.resolve(USAGE_REPORT)
      case 'alerts:list':          return Promise.resolve(ALERTS)
      case 'apps:decideBatch':     return Promise.resolve(true)
      case 'app:decide':           return Promise.resolve(true)
      case 'time:grant':           return Promise.resolve(true)
      case 'time:deny':            return Promise.resolve(true)

      // child mode
      case 'child:homeData':       return Promise.resolve(CHILD_HOME)

      // settings
      case 'settings:get':         return Promise.resolve({ notifications: true, haptics: true })
      case 'settings:save':        return Promise.resolve(true)

      // invite (scene 4 shows pairing code)
      case 'invite:generate':      return Promise.resolve({
        url: 'pear://pearguard/join/01HXYZABCDEFG1234567890abcdef',
        code: '842-193',
      })

      // preferences / contacts
      case 'pref:get':             return Promise.resolve(null)
      case 'pref:set':             return Promise.resolve(true)
      case 'contacts:pick':        return Promise.resolve(null)

      // no-op shims
      case 'haptic:tap':           return Promise.resolve(true)
      case 'openURL':              return Promise.resolve(true)
      case 'canOpenURL':           return Promise.resolve(false)
      case 'share:text':           return Promise.resolve(true)
      case 'file:save':            return Promise.resolve(true)
      case 'file:pick':            return Promise.resolve(null)

      default:
        // Swallow anything else so a missing stub doesn't blow up the scene
        return Promise.resolve(null)
    }
  }
}

// Replace onBareEvent with a no-op returning an unsubscribe function so
// components mount cleanly without a live bare worklet.
function makeOnBareEvent () {
  return function (_event, _handler) { return function () {} }
}

export function installFixtures (sceneNum) {
  const scene = SCENES[sceneNum]
  if (!scene) {
    console.warn('[screenshot] unknown scene', sceneNum)
    return null
  }
  freezeDate()
  window.callBare = makeCallBare(scene)
  window.onBareEvent = makeOnBareEvent()
  window.__pearScreenshotScene = scene
  window.__pearScreenshotDark = PREFERS_DARK
  // Hint to navigate into a specific child after Dashboard mounts.
  if (scene.openChild) {
    window.__pearScreenshotOpenChild = { publicKey: scene.openChild, tab: scene.openTab || 'activity' }
  }
  return { scene }
}
