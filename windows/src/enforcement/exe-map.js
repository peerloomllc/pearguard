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
const fs = require('fs')
const path = require('path')

// Debounce filesystem writes so a burst of learn() calls during apps:sync
// (which can register 40+ basenames in a tight loop) results in one write,
// not one per row.
const PERSIST_DEBOUNCE_MS = 500

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

// Linux counterparts of DEFAULT_MAP. Keys are the process basenames active-win
// reports on Linux (read from /proc/$PID/exe), without the .exe extension.
// Values reuse the same Android-style packageNames as the Windows map so the
// parent's policy speaks one identifier across platforms.
const LINUX_DEFAULT_MAP = {
  // Browsers — Linux ships multiple basenames per browser depending on the
  // packager (firefox-esr on Debian, google-chrome and chromium-browser on
  // Chrome installs, etc.). Map all of them to the same canonical packageName.
  'chrome': 'com.android.chrome',
  'google-chrome': 'com.android.chrome',
  'google-chrome-stable': 'com.android.chrome',
  'chromium': 'com.android.chrome',
  'chromium-browser': 'com.android.chrome',
  'firefox': 'org.mozilla.firefox',
  'firefox-esr': 'org.mozilla.firefox',
  'brave': 'com.brave.browser',
  'brave-browser': 'com.brave.browser',
  'opera': 'com.opera.browser',
  'microsoft-edge': 'com.microsoft.emmx',

  // Chat / social
  'discord': 'com.discord',
  'slack': 'com.Slack',
  'telegram-desktop': 'org.telegram.messenger',
  'telegram': 'org.telegram.messenger',
  'signal-desktop': 'org.thoughtcrime.securesms',

  // Streaming / media
  'spotify': 'com.spotify.music',
  'vlc': 'org.videolan.vlc',

  // Games / launchers
  'steam': 'com.valvesoftware.android.steam.community',
  'minecraft-launcher': 'com.mojang.minecraftpe',

  // Productivity (rarely blocked, but useful to recognize so they don't trip
  // first-sighting notifications)
  'code': 'com.microsoft.vscode',
}

// Exes whose foreground reports the host itself rather than the real app.
// When active-win surfaces one of these as the owner, the hosted app's
// identity lives in the window title (e.g. "Calculator" while
// ApplicationFrameHost hosts the UWP). Callers resolve those via
// ExeMap.resolveUwpByTitle() before falling back to "unmapped → allow".
const UWP_HOST_BASENAMES = new Set([
  'applicationframehost.exe',
])

// Helper / sub-process exes that belong to a larger app. The foreground often
// reports one of these (Steam's web helper renderers, Big Picture Mode, Epic's
// web helper) rather than the primary exe a parent would block by name. When
// resolve() misses on the direct basename, it consults this alias map and
// retries against the primary basename before giving up.
const ALIAS_MAP = {
  // Steam family
  'steamwebhelper.exe': 'steam.exe',
  'steam_bpm.exe': 'steam.exe',
  'steamservice.exe': 'steam.exe',

  // Epic Games Launcher family
  'epicwebhelper.exe': 'epicgameslauncher.exe',
}

// Linux counterpart of ALIAS_MAP. Steam on Linux renders its UI through
// steamwebhelper (same as Windows), so a foreground tick against the helper
// should resolve to the Steam packageName via the alias chain.
const LINUX_ALIAS_MAP = {
  // Steam family — bin names confirmed against active-win output on Debian
  // (path was /home/user/.local/share/Steam/ubuntu12_64/steamwebhelper).
  'steamwebhelper': 'steam',
  'steam_bpm': 'steam',

  // Browser crashpad/helper bins. Active-win occasionally returns these
  // instead of the primary browser when a crash reporter or GPU process
  // briefly holds focus.
  'chrome_crashpad_handler': 'chrome',
  'crashpad_handler': 'chrome',
}

// AppImage mount paths look like /tmp/.mount_<6prefix><6random>/<inner-bin>.
// The 6-char prefix is the first 6 characters of the AppImage's full basename
// (extension included). Verified against keet.appimage → "keet.a",
// pearcal.appimage → "pearca", pearguard-v0.1.0.AppImage → "peargu". We
// lowercase on both sides of the comparison to handle case-mixed filenames
// like PearCal.AppImage which mount as /tmp/.mount_PearCa.../.
// Not part of any AppImage spec, so a future runtime change could break this.
// Documented in [[linux-headless-pair-harness]].
const APP_IMAGE_MOUNT_PREFIX_LEN = 6
function computeAppImageMountPrefix(basename) {
  if (typeof basename !== 'string' || !basename) return null
  return basename.slice(0, APP_IMAGE_MOUNT_PREFIX_LEN).toLowerCase()
}

// Pull the basename-derived prefix back out of a /tmp/.mount_* path. Returns
// null when the path isn't an AppImage mount or is too short to contain a
// random tail.
function extractAppImageMountPrefix(exePath) {
  if (typeof exePath !== 'string') return null
  // The mount-dir name can contain dots ("keet.a..."), underscores, and
  // hyphens — they're all valid AppImage filename characters that get
  // copied byte-for-byte into the mount prefix.
  const m = exePath.match(/\/\.mount_([^/]+)\//)
  if (!m) return null
  const full = m[1]
  // The runtime appends a 6-char random tail; anything before it is the
  // basename-derived prefix. Short basenames could yield a shorter total
  // length than 12, but in practice the runtime always emits 6+6, so refuse
  // anything shorter than that to avoid misreading non-AppImage tmp dirs.
  if (full.length <= APP_IMAGE_MOUNT_PREFIX_LEN) return null
  return full.slice(0, full.length - APP_IMAGE_MOUNT_PREFIX_LEN).toLowerCase()
}

class ExeMap {
  // persistPath is optional. When supplied, learned mappings (anything that
  // wasn't in the initial DEFAULT_MAP) are written to that JSON file on each
  // learn() call (debounced) and reloaded on construction. This closes the
  // first-tick race: without persistence, every restart starts with only
  // PLATFORM_DEFAULT_MAP entries until apps:sync completes, and the very
  // first foreground tick can evaluate against an empty exemap (allowing one
  // launch of a blocked app to slip through). With persistence, the kid's
  // app catalog survives reboots and is ready before bare even finishes init.
  constructor(initial = DEFAULT_MAP, initialAliases = ALIAS_MAP, persistPath = null) {
    this._map = new Map()
    this._aliasMap = new Map()     // child basename -> primary basename
    this._uwpByTitle = new Map()  // normalized title -> { packageName, exeBasename }
    this._appImagePrefixMap = new Map()  // 6-char prefix -> packageName
    this._persistPath = persistPath
    this._saveTimer = null
    for (const [exe, pkg] of Object.entries(initial)) {
      this._map.set(exe.toLowerCase(), pkg)
    }
    for (const [child, primary] of Object.entries(initialAliases)) {
      this._aliasMap.set(child.toLowerCase(), primary.toLowerCase())
    }
    if (persistPath) this._loadPersisted()
  }

  _loadPersisted() {
    try {
      const raw = fs.readFileSync(this._persistPath, 'utf8')
      const data = JSON.parse(raw)
      // Persisted learned mappings overlay the platform defaults — that's the
      // documented `learn()` contract (learn overwrites). If the persisted
      // file contains a stale entry for a basename that now has a different
      // canonical mapping, the next apps:sync overwrites it again. Safer to
      // load everything than to invent dedup logic at load time.
      if (data && typeof data.basenames === 'object') {
        for (const [k, v] of Object.entries(data.basenames)) {
          if (typeof k === 'string' && typeof v === 'string') this._map.set(k, v)
        }
      }
      if (data && typeof data.appImagePrefixes === 'object') {
        for (const [k, v] of Object.entries(data.appImagePrefixes)) {
          if (typeof k === 'string' && typeof v === 'string') this._appImagePrefixMap.set(k, v)
        }
      }
      if (data && typeof data.aliases === 'object') {
        for (const [k, v] of Object.entries(data.aliases)) {
          if (typeof k === 'string' && typeof v === 'string') this._aliasMap.set(k, v)
        }
      }
      if (data && typeof data.uwpByTitle === 'object') {
        for (const [k, v] of Object.entries(data.uwpByTitle)) {
          if (typeof k === 'string' && v && typeof v.packageName === 'string') {
            this._uwpByTitle.set(k, v)
          }
        }
      }
    } catch (e) {
      // Missing/corrupt file is normal on first launch. Don't propagate.
      if (e.code !== 'ENOENT') {
        try { console.warn('[exe-map] persisted load failed:', e.message) } catch (_) {}
      }
    }
  }

  _schedulePersist() {
    if (!this._persistPath) return
    if (this._saveTimer) return
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      this._flushPersist()
    }, PERSIST_DEBOUNCE_MS)
    if (typeof this._saveTimer.unref === 'function') this._saveTimer.unref()
  }

  _flushPersist() {
    if (!this._persistPath) return
    try {
      const data = {
        basenames: Object.fromEntries(this._map),
        appImagePrefixes: Object.fromEntries(this._appImagePrefixMap),
        aliases: Object.fromEntries(this._aliasMap),
        uwpByTitle: Object.fromEntries(this._uwpByTitle),
      }
      fs.mkdirSync(path.dirname(this._persistPath), { recursive: true })
      fs.writeFileSync(this._persistPath, JSON.stringify(data))
    } catch (e) {
      try { console.warn('[exe-map] persist write failed:', e.message) } catch (_) {}
    }
  }

  // Look up a packageName from an exe path or basename. Returns null if
  // unmapped — the caller decides what to do (typically: allow, since policy
  // can't speak to apps it doesn't recognize).
  //
  // When the direct basename misses, retry through the alias map so helper
  // processes (steamwebhelper.exe, steam_bpm.exe, EpicWebHelper.exe) resolve
  // to the primary app's packageName.
  resolve(exePath) {
    if (!exePath) return null
    const basename = pathWin32.basename(exePath).toLowerCase()
    const direct = this._map.get(basename)
    if (direct) return direct
    // AppImage mount-path indirection: active-win surfaces the mounted inner
    // binary (e.g. .../pearguard) rather than the .AppImage on disk. The
    // basename rarely matches a learned entry, but the mount-dir prefix
    // does — derived from the AppImage filename by the runtime.
    const mountPrefix = extractAppImageMountPrefix(exePath)
    if (mountPrefix) {
      const fromMount = this._appImagePrefixMap.get(mountPrefix)
      if (fromMount) return fromMount
    }
    const primary = this._aliasMap.get(basename)
    if (primary) return this._map.get(primary) || null
    return null
  }

  // Add or override a mapping. Used by the parent-side policy editor when the
  // parent attaches an exe identifier to an existing app entry.
  //
  // .AppImage basenames also seed the mount-prefix lookup so a foreground
  // tick against /tmp/.mount_<prefix><random>/<inner> resolves back to the
  // same packageName. The prefix is predicted from the filename — see
  // computeAppImageMountPrefix for the rule and its limitations.
  learn(exeBasename, packageName) {
    if (!exeBasename || !packageName) return
    const lower = exeBasename.toLowerCase()
    this._map.set(lower, packageName)
    if (/\.appimage$/.test(lower)) {
      const prefix = computeAppImageMountPrefix(exeBasename)
      if (prefix) this._appImagePrefixMap.set(prefix, packageName)
    }
    this._schedulePersist()
  }

  // Register a helper/sub-process basename as an alias of a primary basename.
  // The primary does not have to be mapped at alias-learn time; resolve()
  // looks it up on demand so a later learn() or a DEFAULT_MAP entry is
  // picked up automatically.
  learnAlias(childExeBasename, primaryExeBasename) {
    if (!childExeBasename || !primaryExeBasename) return
    this._aliasMap.set(childExeBasename.toLowerCase(), primaryExeBasename.toLowerCase())
    this._schedulePersist()
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
    this._schedulePersist()
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

module.exports = {
  ExeMap,
  DEFAULT_MAP,
  ALIAS_MAP,
  UWP_HOST_BASENAMES,
  LINUX_DEFAULT_MAP,
  LINUX_ALIAS_MAP,
  computeAppImageMountPrefix,
  extractAppImageMountPrefix,
  APP_IMAGE_MOUNT_PREFIX_LEN,
}
