// Screenshot-mode fixtures. Activated when window.__PEARGUARD_SCREENSHOT_SCENE is
// set before this bundle runs. Replaces window.callBare with canned responses and
// freezes "now" to FROZEN_NOW so rendered timestamps are deterministic.
//
// PearGuard's UI calls window.callBare(method, args) directly (there is no shared
// db/sync/notifs object like PearCal), so fixtures work by installing a fake
// callBare that dispatches on method name to canned data.
//
// Final scene list (all light mode):
//   1  — Parent dashboard with paired child (Alex)
//   2  — ChildDetail → Rules (Bedtime + School Hours schedule rules)
//   3  — ChildDetail → Apps (grouped by category)
//   4  — ChildDetail → Usage (per-app screen time bars)
//   5  — ChildDetail → Activity (pending time request highlighted)
//   6  — Usage Reports → Daily (hourly chart + top apps)
//   7  — Usage Reports → Categories (donut chart breakdown)
//   8  — Empty dashboard with Invite/pairing card active
//   9  — Child device: Home status screen
//   10 — Child device: Locked by parent (with message)

export const FROZEN_TODAY = '2026-04-14'
const FROZEN_MS = new Date(FROZEN_TODAY + 'T18:24:00').getTime()

// Dark mode removed; fixtures always render in light mode.
const PREFERS_DARK = false

// ─── Child records (visible in parent dashboard) ─────────────────────────────
const CHILD_ALEX = {
  publicKey: 'a1b2c3d4e5f6708192a1b2c3d4e5f6708192a1b2c3d4e5f6708192a1b2c3d4e5',
  displayName: 'Alex',
  avatar: null,
  avatarThumb: null,
  pairedAt: FROZEN_MS - 12 * 86400000,
  isOnline: true,
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
// Shape follows what the bare worklet returns:
//   schedules: [{ label, days, start, end, exemptApps }]
//   apps:     { [pkg]: { appName, status, category, dailyLimitSeconds, addedAt } }
//   categories: { [name]: { dailyLimitSeconds } }
const POLICY = {
  version: 7,
  updatedAt: FROZEN_MS - 3600000,
  schedules: [
    {
      label: 'Bedtime',
      days: [0, 1, 2, 3, 4, 5, 6],
      start: '21:00',
      end: '07:00',
      exemptApps: ['com.duolingo'],
    },
    {
      label: 'School Hours',
      days: [1, 2, 3, 4, 5],
      start: '08:30',
      end: '15:00',
      exemptApps: [],
    },
    {
      label: 'Homework Focus',
      days: [1, 2, 3, 4],
      start: '17:00',
      end: '18:30',
      exemptApps: ['com.duolingo', 'com.khanacademy.android'],
    },
  ],
  apps: {
    'com.google.android.youtube':  { appName: 'YouTube',      status: 'allowed', category: 'Video & Music', dailyLimitSeconds: 45 * 60, addedAt: FROZEN_MS - 20 * 86400000 },
    'com.netflix.mediaclient':     { appName: 'Netflix',      status: 'allowed', category: 'Video & Music', dailyLimitSeconds: 60 * 60, addedAt: FROZEN_MS - 18 * 86400000 },
    'com.spotify.music':           { appName: 'Spotify',      status: 'allowed', category: 'Video & Music', addedAt: FROZEN_MS - 25 * 86400000 },
    'com.instagram.android':       { appName: 'Instagram',    status: 'blocked', category: 'Social',        addedAt: FROZEN_MS - 14 * 86400000 },
    'com.tiktok':                  { appName: 'TikTok',       status: 'blocked', category: 'Social',        addedAt: FROZEN_MS - 10 * 86400000 },
    'com.discord':                 { appName: 'Discord',      status: 'pending', category: 'Social',        addedAt: FROZEN_MS - 2 * 86400000 },
    'com.snapchat.android':        { appName: 'Snapchat',     status: 'pending', category: 'Social',        addedAt: FROZEN_MS - 1 * 86400000 },
    'com.whatsapp':                { appName: 'WhatsApp',     status: 'allowed', category: 'Communication', addedAt: FROZEN_MS - 30 * 86400000 },
    'com.roblox.client':           { appName: 'Roblox',       status: 'allowed', category: 'Games',         dailyLimitSeconds: 45 * 60, addedAt: FROZEN_MS - 22 * 86400000 },
    'com.mojang.minecraftpe':      { appName: 'Minecraft',    status: 'allowed', category: 'Games',         dailyLimitSeconds: 30 * 60, addedAt: FROZEN_MS - 9 * 86400000 },
    'com.supercell.clashroyale':   { appName: 'Clash Royale', status: 'blocked', category: 'Games',         addedAt: FROZEN_MS - 6 * 86400000 },
    'com.duolingo':                { appName: 'Duolingo',     status: 'allowed', category: 'Education',     addedAt: FROZEN_MS - 40 * 86400000 },
    'com.khanacademy.android':     { appName: 'Khan Academy', status: 'allowed', category: 'Education',     addedAt: FROZEN_MS - 35 * 86400000 },
    'com.google.android.apps.docs': { appName: 'Google Docs', status: 'allowed', category: 'Productivity',  addedAt: FROZEN_MS - 50 * 86400000 },
    'com.google.android.calendar': { appName: 'Calendar',     status: 'allowed', category: 'Productivity',  addedAt: FROZEN_MS - 50 * 86400000 },
  },
  categories: {
    'Social':        { dailyLimitSeconds: 30 * 60 },
    'Games':         { dailyLimitSeconds: 60 * 60 },
    'Video & Music': { dailyLimitSeconds: 90 * 60 },
  },
  allowedContacts: [
    { name: 'Mom', phone: '+1 (555) 123-4567' },
    { name: 'Dad', phone: '+1 (555) 987-6543' },
    { name: 'Grandma', phone: '+1 (555) 555-0142' },
  ],
}

// ─── Usage (UsageTab: usage:getLatest) ───────────────────────────────────────
const USAGE_APPS = [
  { packageName: 'com.google.android.youtube',  displayName: 'YouTube',      category: 'Video & Music', todaySeconds: 42 * 60, weekSeconds: 4 * 3600 + 38 * 60, dailyLimitSeconds: 45 * 60 },
  { packageName: 'com.roblox.client',           displayName: 'Roblox',       category: 'Games',         todaySeconds: 38 * 60, weekSeconds: 3 * 3600 + 50 * 60, dailyLimitSeconds: 45 * 60 },
  { packageName: 'com.netflix.mediaclient',     displayName: 'Netflix',      category: 'Video & Music', todaySeconds: 24 * 60, weekSeconds: 2 * 3600 + 44 * 60, dailyLimitSeconds: 60 * 60 },
  { packageName: 'com.spotify.music',           displayName: 'Spotify',      category: 'Video & Music', todaySeconds: 21 * 60, weekSeconds: 2 * 3600 + 10 * 60 },
  { packageName: 'com.whatsapp',                displayName: 'WhatsApp',     category: 'Communication', todaySeconds: 14 * 60, weekSeconds: 1 * 3600 + 32 * 60 },
  { packageName: 'com.mojang.minecraftpe',      displayName: 'Minecraft',    category: 'Games',         todaySeconds: 12 * 60, weekSeconds: 1 * 3600 + 18 * 60, dailyLimitSeconds: 30 * 60 },
  { packageName: 'com.duolingo',                displayName: 'Duolingo',     category: 'Education',     todaySeconds: 9 * 60,  weekSeconds: 48 * 60 },
  { packageName: 'com.khanacademy.android',     displayName: 'Khan Academy', category: 'Education',     todaySeconds: 6 * 60,  weekSeconds: 42 * 60 },
]

const USAGE_REPORT = {
  childPublicKey: CHILD_ALEX.publicKey,
  timestamp: FROZEN_MS - 5 * 60 * 1000,
  lastSynced: FROZEN_MS - 5 * 60 * 1000,
  apps: USAGE_APPS,
}

// ─── Sessions (UsageReports → Daily view) ────────────────────────────────────
// Build realistic-looking sessions spread across the day.
function mkSession (pkg, displayName, hour, minute, durationMin) {
  const startedAt = new Date(FROZEN_TODAY + 'T00:00:00').getTime() + hour * 3600000 + minute * 60000
  return {
    packageName: pkg,
    displayName,
    startedAt,
    endedAt: startedAt + durationMin * 60000,
    durationSeconds: durationMin * 60,
  }
}

const TODAY_SESSIONS = [
  mkSession('com.duolingo',              'Duolingo',     7, 20, 9),
  mkSession('com.google.android.youtube', 'YouTube',      7, 45, 14),
  mkSession('com.whatsapp',              'WhatsApp',    12, 10, 6),
  mkSession('com.spotify.music',         'Spotify',     12, 30, 21),
  mkSession('com.netflix.mediaclient',   'Netflix',     15, 30, 24),
  mkSession('com.google.android.youtube', 'YouTube',     16, 10, 18),
  mkSession('com.roblox.client',         'Roblox',      16, 35, 22),
  mkSession('com.khanacademy.android',   'Khan Academy', 17, 5, 6),
  mkSession('com.mojang.minecraftpe',    'Minecraft',   17, 45, 12),
  mkSession('com.google.android.youtube', 'YouTube',     18, 0, 10),
  mkSession('com.roblox.client',         'Roblox',      18, 15, 16),
  mkSession('com.whatsapp',              'WhatsApp',    18, 40, 8),
]

// Daily summaries for trends view (last 30 days, most recent first)
const DAILY_SUMMARIES = (() => {
  const out = []
  const base = [138, 122, 156, 101, 94, 172, 188, 145, 118, 132, 109, 87, 164, 201, 178, 143, 126, 98, 111, 152, 167, 139, 104, 119, 145, 158, 133, 112, 129, 141]
  for (let i = 0; i < 30; i++) {
    const d = new Date(FROZEN_MS - i * 86400000)
    const ymd = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    out.push({ date: ymd, totalSeconds: base[i] * 60 })
  }
  return out
})()

// Category summary
const CATEGORY_SUMMARY = [
  { category: 'Video & Music', totalSeconds: 87 * 60, apps: [
    { packageName: 'com.google.android.youtube', displayName: 'YouTube',  totalSeconds: 42 * 60 },
    { packageName: 'com.netflix.mediaclient',    displayName: 'Netflix',  totalSeconds: 24 * 60 },
    { packageName: 'com.spotify.music',          displayName: 'Spotify',  totalSeconds: 21 * 60 },
  ]},
  { category: 'Games', totalSeconds: 50 * 60, apps: [
    { packageName: 'com.roblox.client',      displayName: 'Roblox',    totalSeconds: 38 * 60 },
    { packageName: 'com.mojang.minecraftpe', displayName: 'Minecraft', totalSeconds: 12 * 60 },
  ]},
  { category: 'Communication', totalSeconds: 14 * 60, apps: [
    { packageName: 'com.whatsapp', displayName: 'WhatsApp', totalSeconds: 14 * 60 },
  ]},
  { category: 'Education', totalSeconds: 15 * 60, apps: [
    { packageName: 'com.duolingo',            displayName: 'Duolingo',     totalSeconds: 9 * 60 },
    { packageName: 'com.khanacademy.android', displayName: 'Khan Academy', totalSeconds: 6 * 60 },
  ]},
]

// ─── Alerts / activity (ActivityTab: alerts:list) ────────────────────────────
const ALERTS = [
  {
    id: 'req-1',
    type: 'time_request',
    appDisplayName: 'Roblox',
    packageName: 'com.roblox.client',
    timestamp: FROZEN_MS - 6 * 60 * 1000,
    requestedSeconds: 30 * 60,
    extraSeconds: 30 * 60,
    requestType: 'extra_time',
    resolved: false,
  },
  {
    id: 'alt-2',
    type: 'app_installed',
    appDisplayName: 'Snapchat',
    packageName: 'com.snapchat.android',
    timestamp: FROZEN_MS - 55 * 60 * 1000,
  },
  {
    id: 'alt-3',
    type: 'time_request',
    appDisplayName: 'YouTube',
    packageName: 'com.google.android.youtube',
    timestamp: FROZEN_MS - 3 * 3600 * 1000,
    requestedSeconds: 15 * 60,
    requestType: 'extra_time',
    resolved: true,
    status: 'approved',
  },
  {
    id: 'alt-4',
    type: 'bypass',
    appDisplayName: 'TikTok',
    packageName: 'com.tiktok',
    timestamp: FROZEN_MS - 5 * 3600 * 1000,
  },
  {
    id: 'alt-5',
    type: 'app_installed',
    appDisplayName: 'Discord',
    packageName: 'com.discord',
    timestamp: FROZEN_MS - 26 * 3600 * 1000,
  },
  {
    id: 'alt-6',
    type: 'time_request',
    appDisplayName: 'Minecraft',
    packageName: 'com.mojang.minecraftpe',
    timestamp: FROZEN_MS - 2 * 86400 * 1000,
    requestedSeconds: 20 * 60,
    requestType: 'extra_time',
    resolved: true,
    status: 'denied',
  },
]

// ─── Child home data (ChildHome: child:homeData) ─────────────────────────────
const CHILD_HOME = {
  childName: 'Alex',
  parentName: 'Mom',
  locked: false,
  lockMessage: '',
  todayScreenTimeSeconds: 2 * 3600 + 17 * 60,
  dailyLimitMinutes: 120,
  blockedCount: 3,
  pendingCount: 2,
  pendingRequests: 1,
  schoolHoursActive: false,
  bedtimeActive: false,
  nextUnlock: null,
  activeOverrides: [
    { appName: 'YouTube',   source: 'parent-approved', expiresAt: FROZEN_MS + 14 * 60 * 1000 },
    { appName: 'Minecraft', source: 'pin',             expiresAt: FROZEN_MS + 27 * 60 * 1000 },
  ],
  blockedApps: [
    { appName: 'Instagram',    packageName: 'com.instagram.android' },
    { appName: 'TikTok',       packageName: 'com.tiktok' },
    { appName: 'Clash Royale', packageName: 'com.supercell.clashroyale' },
  ],
  pendingApps: [
    { appName: 'Discord',  packageName: 'com.discord' },
    { appName: 'Snapchat', packageName: 'com.snapchat.android' },
  ],
  pendingRequestsList: [
    { id: 'req-1', appName: 'Roblox', packageName: 'com.roblox.client', requestedAt: FROZEN_MS - 6 * 60 * 1000 },
  ],
}

const CHILD_HOME_LOCKED = {
  ...CHILD_HOME,
  locked: true,
  lockMessage: 'Time for dinner — phone back at 7pm.',
  activeOverrides: [],
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
  const homeData = scene.homeData || CHILD_HOME

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
      case 'donation:check':       return Promise.resolve({ createdAt: FROZEN_MS - 3 * 86400000, dismissed: true })
      case 'donation:dismiss':     return Promise.resolve(true)

      // policy / apps / overrides
      case 'policy:get':           return Promise.resolve(POLICY)
      case 'policy:update':        return Promise.resolve(true)
      case 'policy:setLock':       return Promise.resolve(true)
      case 'overrides:list':       return Promise.resolve({ overrides: [] })
      case 'apps:decideBatch':     return Promise.resolve(true)
      case 'app:decide':           return Promise.resolve(true)
      case 'time:grant':           return Promise.resolve(true)
      case 'time:deny':            return Promise.resolve(true)

      // usage (tab and reports)
      case 'usage:getLatest':      return Promise.resolve(USAGE_REPORT)
      case 'usage:getSessions':    return Promise.resolve(TODAY_SESSIONS)
      case 'usage:getDailySummaries': {
        const days = args.days || 7
        return Promise.resolve(DAILY_SUMMARIES.slice(0, days))
      }
      case 'usage:getCategorySummary': return Promise.resolve(CATEGORY_SUMMARY)

      // activity / alerts
      case 'alerts:list':          return Promise.resolve(ALERTS)

      // child mode
      case 'child:homeData':       return Promise.resolve(homeData)
      case 'requests:list':        return Promise.resolve({ requests: homeData.pendingRequestsList || [] })
      case 'requests:clear':       return Promise.resolve(true)

      // settings
      case 'settings:get':         return Promise.resolve({ notifications: true, haptics: true })
      case 'settings:save':        return Promise.resolve(true)

      // invite (scene 8 shows pairing card)
      case 'invite:generate':      return Promise.resolve({
        inviteLink: 'pear://pearguard/join/01HXYZABCDEFG1234567890abcdef',
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
        return Promise.resolve(null)
    }
  }
}

function makeOnBareEvent () {
  return function (_event, _handler) { return function () {} }
}

// ─── Scene definitions ───────────────────────────────────────────────────────
export const SCENES = {
  1:  { mode: 'parent', children: [CHILD_ALEX] },
  2:  { mode: 'parent', children: [CHILD_ALEX], openChild: CHILD_ALEX.publicKey, openTab: 'rules' },
  3:  { mode: 'parent', children: [CHILD_ALEX], openChild: CHILD_ALEX.publicKey, openTab: 'apps' },
  4:  { mode: 'parent', children: [CHILD_ALEX], openChild: CHILD_ALEX.publicKey, openTab: 'usage' },
  5:  { mode: 'parent', children: [CHILD_ALEX], openChild: CHILD_ALEX.publicKey, openTab: 'activity' },
  6:  { mode: 'parent', children: [CHILD_ALEX], openChild: CHILD_ALEX.publicKey, openTab: 'usage', showReports: true, reportsView: 'daily' },
  7:  { mode: 'parent', children: [CHILD_ALEX], openChild: CHILD_ALEX.publicKey, openTab: 'usage', showReports: true, reportsView: 'categories' },
  8:  { mode: 'parent', children: [], inviteActive: true },
  9:  { mode: 'child', homeData: CHILD_HOME },
  10: { mode: 'child', homeData: CHILD_HOME_LOCKED },
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
  if (scene.openChild) {
    window.__pearScreenshotOpenChild = { publicKey: scene.openChild, tab: scene.openTab || 'usage' }
  }
  if (scene.showReports) {
    window.__pearScreenshotShowReports = true
    window.__pearScreenshotReportsView = scene.reportsView || 'daily'
  }
  if (scene.inviteActive) {
    window.__pearScreenshotInvite = true
  }
  return { scene }
}
