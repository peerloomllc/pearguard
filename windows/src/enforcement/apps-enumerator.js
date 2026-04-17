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
// Force the output stream to UTF-8 before emitting JSON. Without this,
// PowerShell's default [Console]::OutputEncoding on Windows is usually
// UTF-16 LE (with BOM), which Node reads as a string full of null bytes
// and JSON.parse bombs out -> we silently return 0 apps. The encoding
// override has to be *inside* the script, not set from Node, because the
// child process inherits the defaults before -Command runs.
const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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

// Get-StartApps surfaces UWP/Store apps that don't leave Uninstall registry
// entries (Xbox, Instagram, TikTok, etc.). AppID format is
// `PackageFamilyName!PRAID` for UWP; Win32 shortcuts resolve to filesystem
// paths, which we skip because the Uninstall hives already cover them.
const PS_STARTAPPS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@(Get-StartApps |
  Where-Object { $_.AppID -match '!' } |
  Select-Object Name, AppID) |
  ConvertTo-Json -Compress -Depth 3
`.trim()

// Default PowerShell invoker. Injectable so tests can feed canned JSON
// without spawning a shell. Resolves to the raw stdout string. Takes the
// script as an arg so we can reuse the same helper for Uninstall hives and
// Get-StartApps.
function defaultPowershellExec(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout || '')
      },
    )
  })
}

// Entry point. `exec` is optional — pass a fake returning canned JSON in tests.
// Tests pass a single function that receives the script string; production
// uses defaultPowershellExec which binds it into the spawn.
async function enumerateInstalledApps({ exec = defaultPowershellExec, logger = console } = {}) {
  if (process.platform !== 'win32' && exec === defaultPowershellExec) {
    // Dev runs on Linux/macOS would crash trying to invoke powershell.exe. The
    // feature only matters on real Windows children; return empty on anything
    // else unless the caller swapped in a fake.
    return []
  }
  let registryStdout = ''
  let startStdout = ''
  try {
    registryStdout = await exec(PS_SCRIPT)
  } catch (e) {
    logger.warn('[apps-enumerator] registry powershell invocation failed:', e.message)
  }
  try {
    startStdout = await exec(PS_STARTAPPS_SCRIPT)
  } catch (e) {
    // UWP enumeration is a best-effort add-on; failing here should not drop
    // the registry results we already collected.
    logger.warn('[apps-enumerator] get-startapps invocation failed:', e.message)
  }
  if (typeof logger.log === 'function') {
    logger.log('[apps-enumerator] registry stdout bytes=%d startapps bytes=%d', registryStdout.length, startStdout.length)
  }
  const registryRows = parseAndShape(registryStdout, logger)
  const uwpRows = parseUwpAndShape(startStdout, logger)
  const merged = mergeRows(registryRows, uwpRows)
  if (typeof logger.log === 'function') {
    logger.log('[apps-enumerator] shaped %d registry + %d uwp -> %d unique rows', registryRows.length, uwpRows.length, merged.length)
  }
  return merged
}

// Union two shaped-row lists, deduping by packageName. Registry rows win over
// UWP rows when a collision occurs — the registry entry carries the exe path
// that the foreground monitor needs to actually enforce.
function mergeRows(primary, secondary) {
  const byPackage = new Map()
  for (const row of primary) {
    if (row && row.packageName) byPackage.set(row.packageName, row)
  }
  for (const row of secondary) {
    if (row && row.packageName && !byPackage.has(row.packageName)) {
      byPackage.set(row.packageName, row)
    }
  }
  return Array.from(byPackage.values())
}

// Shape Get-StartApps JSON into the same row format as parseAndShape.
// AppID is split on '!' to recover the Package Family Name, which becomes
// the stable identifier for the synthesized packageName ("uwp.<family>").
// We don't resolve an exe here: UWP apps run inside ApplicationFrameHost and
// foreground enforcement has to match on window title / family name, not exe.
function parseUwpAndShape(stdout, logger = console) {
  const rows = parsePowershellJson(stdout, logger)
  const byFamily = new Map()
  for (const r of rows) {
    if (!r || typeof r.Name !== 'string' || typeof r.AppID !== 'string') continue
    const name = r.Name.trim()
    const appId = r.AppID.trim()
    if (!name || !appId.includes('!')) continue
    const family = appId.split('!')[0]
    if (!family) continue
    const packageName = 'uwp.' + slugify(family)
    if (byFamily.has(packageName)) continue
    byFamily.set(packageName, {
      packageName,
      appName: name,
      exeBasename: null,
      isLauncher: false,
    })
  }
  return Array.from(byFamily.values())
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
  // Strip UTF-8 BOM if present — PowerShell sometimes prepends one even when
  // OutputEncoding is forced to UTF-8.
  let text = (stdout || '').replace(/^\uFEFF/, '').trim()
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

module.exports = { enumerateInstalledApps, parseAndShape, parseUwpAndShape, mergeRows, extractExeBasename, slugify }
