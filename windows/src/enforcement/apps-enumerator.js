const { execFile } = require('child_process')
const { DEFAULT_MAP } = require('./exe-map')

// Read installed apps from the three Uninstall registry hives (HKLM, HKLM
// Wow6432Node, HKCU) via PowerShell. Returns objects shaped like Android's
// apps:sync payload so the existing bare dispatch can ingest them without
// branching on platform.
//
// The PowerShell pipeline:
//   - loads the three hives with -ErrorAction SilentlyContinue so a missing
//     node (e.g. no HKCU Uninstall entries) doesn't hard-fail the whole read
//   - drops entries without DisplayName and anything marked SystemComponent
//     (SDK bits, redistributables) since those aren't real user-facing apps
//   - forces @() around the pipeline so a single match still serializes as a
//     JSON array — ConvertTo-Json emits a bare object otherwise
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$paths = @(
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
@(Get-ItemProperty -Path $paths |
  Where-Object { $_.DisplayName -and -not $_.SystemComponent } |
  Select-Object DisplayName, DisplayIcon, InstallLocation) |
  ConvertTo-Json -Compress -Depth 3
`.trim()

// Default PowerShell invoker. Injectable so tests can feed canned JSON
// without spawning a shell. Resolves to the raw stdout string.
function defaultPowershellExec() {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_SCRIPT],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout || '')
      },
    )
  })
}

// Entry point. `exec` is optional — pass a fake returning canned JSON in tests.
async function enumerateInstalledApps({ exec = defaultPowershellExec, logger = console } = {}) {
  if (process.platform !== 'win32' && exec === defaultPowershellExec) {
    // Dev runs on Linux/macOS would crash trying to invoke powershell.exe. The
    // feature only matters on real Windows children; return empty on anything
    // else unless the caller swapped in a fake.
    return []
  }
  let stdout
  try {
    stdout = await exec()
  } catch (e) {
    logger.warn('[apps-enumerator] powershell invocation failed:', e.message)
    return []
  }
  return parseAndShape(stdout, logger)
}

function parseAndShape(stdout, logger = console) {
  const rows = parsePowershellJson(stdout, logger)
  // Dedupe by DisplayName, preferring entries that actually surface an exe.
  const byName = new Map()
  for (const r of rows) {
    const name = (r && typeof r.DisplayName === 'string') ? r.DisplayName.trim() : ''
    if (!name) continue
    const exeBasename = extractExeBasename(r.DisplayIcon) || extractExeBasenameFromInstallLocation(r.InstallLocation, name)
    const existing = byName.get(name)
    if (!existing || (!existing.exeBasename && exeBasename)) {
      byName.set(name, { DisplayName: name, exeBasename })
    }
  }
  const out = []
  for (const { DisplayName, exeBasename } of byName.values()) {
    const mapped = exeBasename ? DEFAULT_MAP[exeBasename.toLowerCase()] : null
    const packageName = mapped || ('win.' + slugify(DisplayName))
    if (!packageName) continue
    out.push({ packageName, appName: DisplayName, exeBasename: exeBasename || null, isLauncher: false })
  }
  return out
}

// ConvertTo-Json returns either `[]`, a single object, or an array. Guard all
// three + the "empty stdout" case that happens when no hive matches.
function parsePowershellJson(stdout, logger = console) {
  const text = (stdout || '').trim()
  if (!text) return []
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    logger.warn('[apps-enumerator] parse failed:', e.message)
    return []
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') return [parsed]
  return []
}

// DisplayIcon values look like:
//   "C:\\Program Files\\App\\app.exe,0"
//   "\"C:\\Program Files\\App\\app.exe\",0"
//   "C:\\Program Files\\App\\app.exe"
// Extract the last `.exe` path segment as a lowercased basename.
function extractExeBasename(displayIcon) {
  if (!displayIcon || typeof displayIcon !== 'string') return null
  let s = displayIcon.trim()
  // Strip surrounding double-quotes
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 0) s = s.slice(1, end)
  } else {
    // Strip trailing ",N" icon index
    s = s.replace(/,-?\d+\s*$/, '')
  }
  const m = /([^\\/]+\.exe)/i.exec(s)
  return m ? m[1].toLowerCase() : null
}

// Some installers populate InstallLocation but leave DisplayIcon empty. Best
// effort: if the install dir contains an exe named similarly to the display
// name, we still can't resolve without walking the directory. For now, return
// null and let the synthesized packageName carry the entry — the parent still
// gets an Apps tab row, just with no exe hook yet.
function extractExeBasenameFromInstallLocation(_installLocation, _displayName) {
  return null
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown'
}

module.exports = { enumerateInstalledApps, parseAndShape, extractExeBasename, slugify }
