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

class ExeMap {
  constructor(initial = DEFAULT_MAP) {
    this._map = new Map()
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

  toJSON() {
    return Object.fromEntries(this._map)
  }
}

module.exports = { ExeMap, DEFAULT_MAP }
