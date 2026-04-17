// Translation table from Windows exe basename (lowercased) to the Android
// packageName the policy schema uses as its canonical app identifier.
//
// This is a starter set covering common kid-targeted desktop apps. Two ways
// to extend:
//  - DEFAULT_MAP below for apps shipped with PearGuard.
//  - learnMapping(exe, packageName) to record per-install additions the parent
//    sets up via the policy editor (persisted to userData in a later PR).

// Use win32.basename so dev runs on Linux can still parse Windows paths
// like 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'.
const { win32: pathWin32 } = require('path')

const DEFAULT_MAP = {
  // Browsers
  'chrome.exe': 'com.android.chrome',
  'msedge.exe': 'com.microsoft.emmx',
  'firefox.exe': 'org.mozilla.firefox',
  'brave.exe': 'com.brave.browser',
  'opera.exe': 'com.opera.browser',

  // Chat / social
  'discord.exe': 'com.discord',
  'slack.exe': 'com.Slack',
  'telegram.exe': 'org.telegram.messenger',
  'whatsapp.exe': 'com.whatsapp',
  'signal.exe': 'org.thoughtcrime.securesms',

  // Streaming / media
  'spotify.exe': 'com.spotify.music',
  'vlc.exe': 'org.videolan.vlc',

  // Games / launchers
  'steam.exe': 'com.valvesoftware.android.steam.community',
  'epicgameslauncher.exe': 'com.epicgames.portal',
  'roblox.exe': 'com.roblox.client',
  'robloxplayerbeta.exe': 'com.roblox.client',
  'minecraft.exe': 'com.mojang.minecraftpe',
  'minecraftlauncher.exe': 'com.mojang.minecraftpe',

  // Productivity (rarely blocked but useful to recognize)
  'code.exe': 'com.microsoft.vscode',
  'notepad.exe': 'com.android.notes',
}

// Exes whose foreground reports the host itself rather than the real app.
// When active-win surfaces one of these as the owner, the hosted app's
// identity lives in the window title (e.g. "Calculator" while
// ApplicationFrameHost hosts the UWP). Callers resolve those via
// ExeMap.resolveUwpByTitle() before falling back to "unmapped → allow".
const UWP_HOST_BASENAMES = new Set([
  'applicationframehost.exe',
])

class ExeMap {
  constructor(initial = DEFAULT_MAP) {
    this._map = new Map()
    this._uwpByTitle = new Map()  // normalized title -> { packageName, exeBasename }
    for (const [exe, pkg] of Object.entries(initial)) {
      this._map.set(exe.toLowerCase(), pkg)
    }
  }

  // Look up a packageName from an exe path or basename. Returns null if
  // unmapped — the caller decides what to do (typically: allow, since policy
  // can't speak to apps it doesn't recognize).
  resolve(exePath) {
    if (!exePath) return null
    const basename = pathWin32.basename(exePath).toLowerCase()
    return this._map.get(basename) || null
  }

  // Add or override a mapping. Used by the parent-side policy editor when the
  // parent attaches an exe identifier to an existing app entry.
  learn(exeBasename, packageName) {
    if (!exeBasename || !packageName) return
    this._map.set(exeBasename.toLowerCase(), packageName)
  }

  // Register a UWP app by its display title. Populated from apps:sync rows
  // whose packageName starts with 'uwp.' so a foreground tick against
  // ApplicationFrameHost can map the window title back to the stable UWP
  // packageName. exeBasename is optional and only present when the UWP was
  // fuzzy-merged with a Win32 twin (e.g. Calculator).
  learnUwp({ title, packageName, exeBasename = null } = {}) {
    if (!title || !packageName) return
    const n = normalizeTitle(title)
    if (!n) return
    this._uwpByTitle.set(n, { packageName, exeBasename })
  }

  // Resolve a foreground window title to a UWP packageName. Called from the
  // controller when the foreground exe is a known UWP host; returns null if
  // the title doesn't match any registered UWP.
  resolveUwpByTitle(title) {
    if (!title) return null
    const n = normalizeTitle(title)
    if (!n) return null
    return this._uwpByTitle.get(n) || null
  }

  toJSON() {
    return Object.fromEntries(this._map)
  }
}

function normalizeTitle(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

module.exports = { ExeMap, DEFAULT_MAP, UWP_HOST_BASENAMES }
