// Linux apps enumeration. Walks the XDG application directories, parses each
// .desktop file, and returns rows shaped like apps-enumerator.js (Windows)
// so the existing bare apps:sync dispatch can ingest them without branching
// on platform.
//
// Linux has no equivalent of the Windows Uninstall registry, so .desktop
// entries are the closest source of truth: every distro and packaging system
// (apt, dnf, flatpak, snap, AppImage with desktop integration) writes one to
// announce a launchable app. Anything without a .desktop entry (manually
// downloaded binaries, scripts the user runs from a terminal) won't appear,
// which mirrors how the Windows enumerator misses portable .exes.
const fs = require('fs').promises
const path = require('path')
const os = require('os')

// Categories map to the same fixed set the parent UI expects
// (see src/ui/components/AppsTab.jsx and app-category.js for the Windows
// analogue). XDG categories from
// https://specifications.freedesktop.org/menu-spec/latest/apa.html — we pick
// the first that matches, so order matters when categories overlap (e.g.
// "AudioVideo;Game" goes to Games).
const XDG_CATEGORY_PRIORITY = [
  ['Game', 'Games'],
  ['InstantMessaging', 'Communication'],
  ['IRCClient', 'Communication'],
  ['Email', 'Communication'],
  ['Telephony', 'Communication'],
  ['VideoConference', 'Communication'],
  ['Chat', 'Social'],
  // WebBrowser sits under Network in XDG; pin it ahead so a browser maps to
  // Productivity (matching Windows' app-category.js) instead of Communication.
  ['WebBrowser', 'Productivity'],
  ['Network', 'Communication'],
  ['AudioVideo', 'Video & Music'],
  ['Audio', 'Video & Music'],
  ['Video', 'Video & Music'],
  ['Player', 'Video & Music'],
  ['Recorder', 'Video & Music'],
  ['Education', 'Education'],
  ['Science', 'Education'],
  ['Development', 'Productivity'],
  ['IDE', 'Productivity'],
  ['Office', 'Productivity'],
  ['TextEditor', 'Productivity'],
  ['Spreadsheet', 'Productivity'],
  ['WordProcessor', 'Productivity'],
  ['Graphics', 'Productivity'],
  ['News', 'News'],
  ['Settings', 'System'],
  ['System', 'System'],
  ['Utility', 'Productivity'],
]

function defaultAppDirs() {
  // XDG Base Directory spec order: user dirs first (so a user override beats
  // the system entry of the same name during dedupe), then system, then
  // ecosystem-specific (Flatpak, Snap). Skipped silently if not present.
  const home = os.homedir()
  const xdgData = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.trim()
  const xdgDataDirs = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)
  const dirs = []
  dirs.push(path.join(xdgData || path.join(home, '.local/share'), 'applications'))
  for (const d of xdgDataDirs) dirs.push(path.join(d, 'applications'))
  // Flatpak's user + system exports; Snap's desktop integration dir. These
  // aren't in XDG_DATA_DIRS by default on every distro so list them explicitly.
  dirs.push(path.join(home, '.local/share/flatpak/exports/share/applications'))
  dirs.push('/var/lib/flatpak/exports/share/applications')
  dirs.push('/var/lib/snapd/desktop/applications')
  // De-dupe while preserving order so user/system precedence is stable.
  const seen = new Set()
  const out = []
  for (const d of dirs) {
    if (!d || seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown'
}

// Parse one .desktop file. Spec lives at
// https://specifications.freedesktop.org/desktop-entry-spec/latest/.
// We only read [Desktop Entry] — locale-suffixed Name keys ("Name[de]") are
// skipped because the parent UI shows the en_US name regardless of the
// child's locale. Action subgroups are ignored because they aren't apps.
function parseDesktopFile(content) {
  const fields = {}
  let inMain = false
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]'
      continue
    }
    if (!inMain) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    // Skip locale-suffixed keys ("Name[de]", "Comment[fr]") — we only want the
    // default-locale value, which is always the bare key per the spec.
    if (key.includes('[')) continue
    fields[key] = line.slice(eq + 1)
  }
  return fields
}

// Pull the launching executable out of an Exec= field. The spec encodes args
// like %f %u %i which we strip; quoting/escapes per the spec are honored just
// enough to handle paths with spaces wrapped in double quotes. The first
// token is treated as the binary and reduced to its basename — that's what
// active-win surfaces as owner.name on Linux, so it's the join key.
//
// Wrappers like 'env', 'sh -c', 'bash -lc', and Flatpak's 'flatpak run' are
// peeled off so the binary we record matches what active-win reports.
function extractExeBasenameFromExec(execValue) {
  if (typeof execValue !== 'string') return null
  const trimmed = execValue.trim()
  if (!trimmed) return null
  // Tokenize honoring quoted segments. Some distros wrap tokens in single
  // quotes ('run') even though the spec only blesses double quotes; accept
  // both so those entries don't fall through as literal quoted strings.
  const tokens = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m
  while ((m = re.exec(trimmed))) {
    tokens.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3])
  }
  if (!tokens.length) return null
  let i = 0
  // Skip leading env-variable assignments ('FOO=bar baz=qux exec') that some
  // desktop entries use.
  while (i < tokens.length && /^[A-Z_][A-Z0-9_]*=/.test(tokens[i])) i++
  // Peel known wrappers. Each entry: [wrapper basename, number of arg tokens
  // to consume before reaching the real binary]. Order matters: longer
  // matches first.
  const WRAPPERS = [
    { name: 'flatpak', shape: (rest) => peelFlatpak(rest) },
    { name: 'env',      shape: peelEnv },
    { name: 'sh',       shape: peelShDashC },
    { name: 'bash',     shape: peelShDashC },
    { name: 'gtk-launch', shape: () => null },  // gtk-launch <id> can't be resolved without re-lookup
    { name: 'xdg-open',   shape: () => null },
    { name: 'snap',       shape: peelSnap },
  ]
  while (i < tokens.length) {
    const base = path.win32.basename(tokens[i] || '').replace(/\.(exe|sh|py|pl|rb)$/i, '')
    const lower = base.toLowerCase()
    const wrapper = WRAPPERS.find((w) => w.name === lower)
    if (!wrapper) break
    const peeled = wrapper.shape(tokens.slice(i + 1))
    if (!peeled) return null
    return peeled
  }
  const raw = tokens[i]
  if (!raw) return null
  // %-codes are runtime placeholders and never the binary.
  if (raw.startsWith('%')) return null
  const base = path.win32.basename(raw)
  if (!base) return null
  return base
}

function peelEnv(rest) {
  // 'env [VAR=val ...] command [args...]' — skip assignments, return basename
  // of the first non-assignment token.
  let i = 0
  while (i < rest.length && /^[A-Z_][A-Z0-9_]*=/.test(rest[i])) i++
  if (i >= rest.length) return null
  return path.win32.basename(rest[i])
}

function peelShDashC(rest) {
  // 'sh -c "real-binary --arg"' — the script string is the next token after
  // -c. Pull the first whitespace-separated word as the binary. Anything
  // fancier (pipes, multiple statements) we punt on.
  let i = 0
  while (i < rest.length && rest[i].startsWith('-')) {
    if (rest[i] === '-c') {
      i++
      const script = rest[i]
      if (!script) return null
      const first = script.trim().split(/\s+/)[0]
      return first ? path.win32.basename(first) : null
    }
    i++
  }
  return null
}

function peelFlatpak(rest) {
  // 'flatpak run [--opt ...] <app-id>' — the app id is the first non-option,
  // non-`run` token. We can't recover the actual exe but the app id is a
  // stable handle active-win surfaces as the process name on Linux (bwrap
  // re-execs the entry-point but /proc/$PID/exe resolves through the runtime
  // mount), so returning the app id basename is the best stable join we can
  // do. Treats `run` and any `-` token as skippable so `flatpak --user run
  // <id>` (uncommon but legal) parses the same as the documented ordering.
  let i = 0
  while (i < rest.length && (rest[i] === 'run' || rest[i].startsWith('-'))) i++
  if (i >= rest.length) return null
  return path.win32.basename(rest[i])
}

function peelSnap(rest) {
  // 'snap run <name>' or 'snap run --command=X <name>'.
  let i = 0
  while (i < rest.length && rest[i].startsWith('-')) i++
  if (rest[i] !== 'run') return null
  i++
  while (i < rest.length && rest[i].startsWith('-')) i++
  if (i >= rest.length) return null
  return path.win32.basename(rest[i])
}

function categorizeFromXdg(categoriesField) {
  if (typeof categoriesField !== 'string') return 'Other'
  const set = new Set(categoriesField.split(';').map((s) => s.trim()).filter(Boolean))
  for (const [xdg, mapped] of XDG_CATEGORY_PRIORITY) {
    if (set.has(xdg)) return mapped
  }
  return 'Other'
}

function shouldHide(fields) {
  if (fields.Type !== 'Application') return true
  if (fields.NoDisplay === 'true') return true
  if (fields.Hidden === 'true') return true
  // Many distros ship -settings.desktop or kde admin .desktop files that the
  // user wouldn't recognize. OnlyShowIn restricts a launcher to a specific
  // desktop environment (KDE-only, GNOME-only); skipping a foreign-DE-only
  // entry avoids surfacing apps the child can't actually launch.
  if (fields.OnlyShowIn) {
    const allowed = fields.OnlyShowIn.split(';').map((s) => s.trim().toLowerCase()).filter(Boolean)
    const xdgCurrent = (process.env.XDG_CURRENT_DESKTOP || '').toLowerCase()
    const sessionDesktops = xdgCurrent.split(':').map((s) => s.trim()).filter(Boolean)
    if (allowed.length && !allowed.some((d) => sessionDesktops.includes(d))) return true
  }
  return false
}

async function readDirSafe(dir) {
  try {
    return await fs.readdir(dir)
  } catch (_e) {
    return []
  }
}

async function enumerateInstalledApps({ dirs = defaultAppDirs(), logger = console } = {}) {
  if (process.platform !== 'linux') return []
  // Map keyed by appName so that a user override of /usr/share/applications/foo.desktop
  // at ~/.local/share/applications/foo.desktop replaces, not duplicates. Order
  // of dirs decides precedence — user wins, then system, then flatpak/snap.
  const byName = new Map()
  let scanned = 0
  let dropped = 0
  for (const dir of dirs) {
    const entries = await readDirSafe(dir)
    for (const name of entries) {
      if (!name.endsWith('.desktop')) continue
      const full = path.join(dir, name)
      let content
      try { content = await fs.readFile(full, 'utf8') } catch (_e) { continue }
      scanned++
      const fields = parseDesktopFile(content)
      if (shouldHide(fields)) { dropped++; continue }
      const appName = (fields.Name || '').trim()
      if (!appName) { dropped++; continue }
      const exeBasename = extractExeBasenameFromExec(fields.Exec)
      if (!exeBasename) { dropped++; continue }
      // First write wins, which honors the user/system precedence in `dirs`.
      if (byName.has(appName)) continue
      const packageName = 'linux.' + slugify(appName)
      byName.set(appName, {
        packageName,
        appName,
        exeBasename,
        isLauncher: false,
        category: categorizeFromXdg(fields.Categories),
      })
    }
  }
  const rows = Array.from(byName.values())
  if (typeof logger.log === 'function') {
    logger.log('[apps-enumerator-linux] scanned=%d kept=%d dropped=%d', scanned, rows.length, dropped)
  }
  return rows
}

module.exports = {
  enumerateInstalledApps,
  parseDesktopFile,
  extractExeBasenameFromExec,
  categorizeFromXdg,
  shouldHide,
  defaultAppDirs,
  slugify,
}
