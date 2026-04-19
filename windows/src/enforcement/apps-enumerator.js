const { execFile } = require('child_process')
const { DEFAULT_MAP } = require('./exe-map')
const { extractWin32Icons, extractUwpIcons } = require('./icon-extractor')

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

// Walk both Start Menu directories and resolve every .lnk target to its exe.
// This is the most reliable source for "what exe launches when the user
// clicks the app tile" — the Uninstall registry's DisplayIcon is unreliable
// (Steam's points at uninstall.exe) while Start Menu shortcuts by design
// point at the real runtime exe. Output is [{Name, Target}] where Name is
// the .lnk basename (no extension) and Target is the absolute exe path.
const PS_SHORTCUTS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$folders = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"
)
@(Get-ChildItem -Path $folders -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $lnk = $shell.CreateShortcut($_.FullName)
    $target = $lnk.TargetPath
    if ($target -and $target.ToLower().EndsWith('.exe')) {
      [PSCustomObject]@{ Name = $_.BaseName; Target = $target }
    }
  }) | ConvertTo-Json -Compress -Depth 3
`.trim()

// For every installed AppX (MSIX) package, read AppxManifest.xml and pull
// the first <Application>'s Executable attribute. MSIX desktop apps like
// Keet run their own exe at runtime (not ApplicationFrameHost), so the
// catalog needs to know "family X ships exe Y" to build the runtime
// mapping. Output is [{Family, Executable}] where Family is
// PackageFamilyName and Executable is the manifest's raw value (e.g.
// "App\\Keet.exe") — the subfolder prefix is stripped in the parser.
const PS_MSIX_EXES_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
@(Get-AppxPackage | ForEach-Object {
  $pkg = $_
  if (-not $pkg.InstallLocation) { return }
  $manifestPath = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
  if (-not (Test-Path $manifestPath)) { return }
  try {
    [xml]$m = Get-Content -Raw -Path $manifestPath
    $apps = $m.Package.Applications.Application
    if (-not $apps) { return }
    $first = @($apps)[0]
    if ($first -and $first.Executable) {
      [PSCustomObject]@{ Family = $pkg.PackageFamilyName; Executable = $first.Executable }
    }
  } catch {}
}) | ConvertTo-Json -Compress -Depth 3
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
  let shortcutStdout = ''
  let msixExeStdout = ''
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
  try {
    shortcutStdout = await exec(PS_SHORTCUTS_SCRIPT)
  } catch (e) {
    // Start Menu enumeration is a refinement — if it fails, rows fall back
    // to their registry DisplayIcon exe. Steam stays broken in that case,
    // but everything that already worked keeps working.
    logger.warn('[apps-enumerator] start-menu shortcut invocation failed:', e.message)
  }
  try {
    msixExeStdout = await exec(PS_MSIX_EXES_SCRIPT)
  } catch (e) {
    logger.warn('[apps-enumerator] msix manifest invocation failed:', e.message)
  }
  if (typeof logger.log === 'function') {
    logger.log('[apps-enumerator] bytes: registry=%d startapps=%d shortcuts=%d msix=%d',
      registryStdout.length, startStdout.length, shortcutStdout.length, msixExeStdout.length)
  }
  const shortcutMap = parseShortcutMap(shortcutStdout, logger)
  const msixExeMap = parseMsixExeMap(msixExeStdout, logger)
  const registryRows = parseAndShape(registryStdout, logger, shortcutMap)
  const uwpRows = parseUwpAndShape(startStdout, logger, msixExeMap)
  const merged = mergeRows(registryRows, uwpRows)

  // Icon extraction piggybacks on the same PowerShell injector. Icons are
  // best-effort — a failure here leaves iconBase64 undefined on the row and
  // the parent UI falls back to the initials circle. Run Win32 + UWP in
  // parallel since they each spawn their own PS child.
  const win32Paths = []
  const uwpFamilies = []
  for (const row of merged) {
    if (row.exePath) win32Paths.push(row.exePath)
    if (row.packageFamilyName) uwpFamilies.push(row.packageFamilyName)
  }
  const [win32Icons, uwpIcons] = await Promise.all([
    extractWin32Icons(win32Paths, { exec, logger }),
    extractUwpIcons(uwpFamilies, { exec, logger }),
  ])
  for (const row of merged) {
    if (row.exePath) {
      const icon = win32Icons.get(row.exePath)
      if (icon) row.iconBase64 = icon
      delete row.exePath
    }
    if (row.packageFamilyName) {
      const icon = uwpIcons.get(row.packageFamilyName)
      if (icon) row.iconBase64 = icon
      delete row.packageFamilyName
    }
  }

  if (typeof logger.log === 'function') {
    logger.log('[apps-enumerator] shaped %d registry + %d uwp -> %d unique rows (%d icons)',
      registryRows.length, uwpRows.length, merged.length, win32Icons.size + uwpIcons.size)
  }
  return merged
}

// Union two shaped-row lists. Two-pass dedup:
//   1. packageName-level: if the same packageName appears in both lists,
//      primary wins (registry rows carry the exe path enforcement needs).
//   2. Fuzzy-name merge: a UWP row ('uwp.<family>') and a Win32 row
//      ('win.<slug>' or DEFAULT_MAP'd) with the same normalized display name
//      are the same app — Calculator ships both a registry Uninstall entry
//      and a Get-StartApps entry. The UWP ID wins as survivor because it's
//      globally stable (Store family name), but we absorb the Win32 row's
//      exeBasename/exePath so a direct-exe launch still resolves via ExeMap.
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
  const rows = Array.from(byPackage.values())

  const win32ByName = new Map()
  for (const row of rows) {
    if (row.packageName.startsWith('uwp.')) continue
    const n = normalizeDisplayName(row.appName)
    if (n && !win32ByName.has(n)) win32ByName.set(n, row)
  }
  const absorbed = new Set()
  for (const row of rows) {
    if (!row.packageName.startsWith('uwp.')) continue
    const n = normalizeDisplayName(row.appName)
    if (!n) continue
    const win32 = win32ByName.get(n)
    if (!win32 || absorbed.has(win32.packageName)) continue
    if (!row.exeBasename && win32.exeBasename) row.exeBasename = win32.exeBasename
    if (!row.exePath && win32.exePath) row.exePath = win32.exePath
    absorbed.add(win32.packageName)
  }
  return rows.filter((r) => !absorbed.has(r.packageName))
}

function normalizeDisplayName(name) {
  if (typeof name !== 'string') return ''
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

// Shape Get-StartApps JSON into the same row format as parseAndShape.
// AppID is split on '!' to recover the Package Family Name, which becomes
// the stable identifier for the synthesized packageName ("uwp.<family>").
//
// msixExeMap (family -> lowercased exeBasename) is folded in when present so
// MSIX desktop apps (Keet, modern Teams) carry the exe active-win actually
// reports at runtime. Classic UWPs hosted by ApplicationFrameHost still have
// exeBasename=null — they get resolved via learnUwp + window title instead.
function parseUwpAndShape(stdout, logger = console, msixExeMap = new Map()) {
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
    const exeBasename = msixExeMap.get(family) || null
    // packageFamilyName is kept on the row so enumerateInstalledApps can hand
    // it to the UWP icon extractor. Stripped before the row leaves the module.
    byFamily.set(packageName, {
      packageName,
      appName: name,
      exeBasename,
      isLauncher: false,
      packageFamilyName: family,
    })
  }
  return Array.from(byFamily.values())
}

function parseAndShape(stdout, logger = console, shortcutMap = new Map()) {
  const rows = parsePowershellJson(stdout, logger)
  // Dedupe by DisplayName, preferring entries that actually surface an exe.
  const byName = new Map()
  for (const r of rows) {
    const name = (r && typeof r.DisplayName === 'string') ? r.DisplayName.trim() : ''
    if (!name) continue
    const exePath = extractExePath(r.DisplayIcon)
    const exeBasename = exePath ? exePath.split(/[\\/]/).pop().toLowerCase() : null
    const existing = byName.get(name)
    if (!existing || (!existing.exeBasename && exeBasename)) {
      byName.set(name, { DisplayName: name, exeBasename, exePath })
    }
  }
  const out = []
  for (const { DisplayName, exeBasename, exePath } of byName.values()) {
    // Start Menu shortcut wins over DisplayIcon: the .lnk target is the real
    // runtime exe the user launches, while DisplayIcon can point at uninstallers
    // (Steam's does). Only override when the shortcut actually surfaces an exe.
    let finalBasename = exeBasename
    let finalPath = exePath
    const n = normalizeDisplayName(DisplayName)
    const shortcut = n ? shortcutMap.get(n) : null
    if (shortcut && shortcut.exeBasename) {
      finalBasename = shortcut.exeBasename
      finalPath = shortcut.exePath || finalPath
    }
    const mapped = finalBasename ? DEFAULT_MAP[finalBasename.toLowerCase()] : null
    const packageName = mapped || ('win.' + slugify(DisplayName))
    if (!packageName) continue
    // exePath is kept on the row so enumerateInstalledApps can hand it to the
    // Win32 icon extractor. Stripped before the row leaves the module.
    const row = { packageName, appName: DisplayName, exeBasename: finalBasename || null, isLauncher: false }
    if (finalPath) row.exePath = finalPath
    out.push(row)
  }
  return out
}

// Build a normalized-DisplayName -> { exeBasename, exePath } map from the
// Start Menu PS output. Used by parseAndShape to override unreliable
// DisplayIcon values. Case and punctuation are stripped so "Microsoft Edge"
// matches a shortcut named "Microsoft-Edge".
function parseShortcutMap(stdout, logger = console) {
  const rows = parsePowershellJson(stdout, logger)
  const map = new Map()
  for (const r of rows) {
    if (!r || typeof r.Name !== 'string' || typeof r.Target !== 'string') continue
    const key = normalizeDisplayName(r.Name)
    if (!key) continue
    const target = r.Target.trim()
    if (!/\.exe$/i.test(target)) continue
    const basename = target.split(/[\\/]/).pop().toLowerCase()
    if (!basename) continue
    // First .lnk wins. Start Menu duplicates are rare but harmless — user-scope
    // folder is walked before system-scope, which is a reasonable precedence.
    if (map.has(key)) continue
    map.set(key, { exeBasename: basename, exePath: target })
  }
  return map
}

// Build a PackageFamilyName -> lowercased exeBasename map from the MSIX
// manifest PS output. AppxManifest's Executable attribute is typically
// a relative path like "App\Keet.exe" — strip everything before the
// last path separator so only the basename is stored.
function parseMsixExeMap(stdout, logger = console) {
  const rows = parsePowershellJson(stdout, logger)
  const map = new Map()
  for (const r of rows) {
    if (!r || typeof r.Family !== 'string' || typeof r.Executable !== 'string') continue
    const family = r.Family.trim()
    if (!family) continue
    const basename = r.Executable.split(/[\\/]/).pop().toLowerCase()
    if (!basename || !/\.exe$/.test(basename)) continue
    if (map.has(family)) continue
    map.set(family, basename)
  }
  return map
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
// Return the full exe path (case-preserved) with quotes and the trailing
// icon index stripped. Used both to derive the basename and as the argument
// to the icon extractor.
function extractExePath(displayIcon) {
  if (!displayIcon || typeof displayIcon !== 'string') return null
  let s = displayIcon.trim()
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 0) s = s.slice(1, end)
  } else {
    s = s.replace(/,-?\d+\s*$/, '')
  }
  return /\.exe$/i.test(s) ? s : null
}

function extractExeBasename(displayIcon) {
  const p = extractExePath(displayIcon)
  if (!p) return null
  const m = /([^\\/]+\.exe)/i.exec(p)
  return m ? m[1].toLowerCase() : null
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown'
}

module.exports = { enumerateInstalledApps, parseAndShape, parseUwpAndShape, parseShortcutMap, parseMsixExeMap, mergeRows, extractExeBasename, extractExePath, slugify, normalizeDisplayName }
