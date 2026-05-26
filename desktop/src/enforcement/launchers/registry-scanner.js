// Ubisoft Connect, EA App (plus legacy Origin), GOG Galaxy all publish their
// installed games under HKLM registry paths. A single PowerShell script reads
// the three sources and tags each row so parsers can split them apart. One
// PS invocation instead of three amortizes the ~300 ms cold start.
//
// Game launch exes can't always be extracted from the registry alone:
//  - GOG stores exeFile + path, so we get the full launch path outright.
//  - Ubisoft stores InstallDir but no exe name; we walk the dir for the
//    biggest non-blacklisted exe (same heuristic as Steam).
//  - EA's new Desktop client stores "Install Dir" plus sometimes an
//    executable hint; legacy Origin stores "InstallDir" and "DisplayIcon".

const realFsSync = require('fs')
const path = require('path')

const PS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Dump-Key($root, $label, $props) {
  $items = Get-ChildItem -Path $root -ErrorAction SilentlyContinue
  foreach ($it in $items) {
    $p = Get-ItemProperty -Path $it.PSPath -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $out = [ordered]@{ source = $label; keyName = $it.PSChildName }
    foreach ($n in $props) { $out[$n] = $p.$n }
    [PSCustomObject]$out
  }
}

$rows = @()
$rows += Dump-Key 'HKLM:\\SOFTWARE\\Ubisoft\\Launcher\\Installs' 'ubisoft' @('InstallDir')
$rows += Dump-Key 'HKLM:\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs' 'ubisoft' @('InstallDir')
$rows += Dump-Key 'HKLM:\\SOFTWARE\\WOW6432Node\\Electronic Arts\\EA Desktop' 'ea' @('DisplayName','Install Dir','Locale')
$rows += Dump-Key 'HKLM:\\SOFTWARE\\Electronic Arts\\EA Desktop' 'ea' @('DisplayName','Install Dir','Locale')
$rows += Dump-Key 'HKLM:\\SOFTWARE\\WOW6432Node\\Origin Games' 'origin' @('DisplayName','InstallDir','DisplayIcon')
$rows += Dump-Key 'HKLM:\\SOFTWARE\\Origin Games' 'origin' @('DisplayName','InstallDir','DisplayIcon')
$rows += Dump-Key 'HKLM:\\SOFTWARE\\WOW6432Node\\GOG.com\\Games' 'gog' @('gameID','gameName','path','exeFile')
$rows += Dump-Key 'HKLM:\\SOFTWARE\\GOG.com\\Games' 'gog' @('gameID','gameName','path','exeFile')

@($rows) | ConvertTo-Json -Compress -Depth 3
`.trim()

async function enumerateRegistryLaunchers({ exec, fs = realFsSync, logger = console } = {}) {
  if (process.platform !== 'win32' && typeof exec !== 'function') return []
  if (typeof exec !== 'function') return []
  let stdout = ''
  try {
    stdout = await exec(PS_SCRIPT)
  } catch (e) {
    logger.warn('[launchers/registry] powershell failed:', e.message)
    return []
  }
  const rows = parsePsJson(stdout, logger)
  const out = []
  for (const r of rows) {
    if (!r || typeof r.source !== 'string') continue
    const row = buildRow(r, { fs, logger })
    if (row) out.push(row)
  }
  return out
}

function buildRow(r, { fs, logger }) {
  const source = r.source
  if (source === 'ubisoft') return buildUbisoftRow(r, { fs, logger })
  if (source === 'ea') return buildEaRow(r, { fs, logger })
  if (source === 'origin') return buildOriginRow(r, { fs, logger })
  if (source === 'gog') return buildGogRow(r, { fs, logger })
  return null
}

function buildUbisoftRow(r, { fs, logger }) {
  const dir = stringOr(r.InstallDir)
  const keyName = stringOr(r.keyName)
  if (!dir || !keyName) return null
  if (!dirExists(dir, fs)) return null
  const exe = guessBiggestExe(dir, fs)
  if (!exe) return null
  const appName = deriveNameFromDir(dir)
  return {
    packageName: 'ubisoft.app.' + slugify(keyName),
    appName,
    exeBasename: exe.basename.toLowerCase(),
    exePath: exe.full,
    isLauncher: false,
  }
}

function buildEaRow(r, { fs, logger }) {
  const dir = stringOr(r['Install Dir']) || stringOr(r.InstallDir)
  const keyName = stringOr(r.keyName)
  const name = stringOr(r.DisplayName) || (keyName ? deriveNameFromEaKey(keyName) : null) || deriveNameFromDir(dir)
  if (!dir || !keyName || !name) return null
  if (!dirExists(dir, fs)) return null
  const exe = guessBiggestExe(dir, fs)
  if (!exe) return null
  return {
    packageName: 'ea.app.' + slugify(keyName),
    appName: name,
    exeBasename: exe.basename.toLowerCase(),
    exePath: exe.full,
    isLauncher: false,
  }
}

function buildOriginRow(r, { fs, logger }) {
  const dir = stringOr(r.InstallDir)
  const keyName = stringOr(r.keyName)
  const displayIcon = stringOr(r.DisplayIcon)
  const name = stringOr(r.DisplayName) || (keyName ? deriveNameFromEaKey(keyName) : null) || deriveNameFromDir(dir)
  if (!dir || !keyName || !name) return null
  if (!dirExists(dir, fs)) return null
  let exe = extractExeFromDisplayIcon(displayIcon)
  if (!exe || !fileExists(exe.full, fs)) {
    exe = guessBiggestExe(dir, fs)
  }
  if (!exe) return null
  return {
    packageName: 'ea.app.' + slugify(keyName),
    appName: name,
    exeBasename: exe.basename.toLowerCase(),
    exePath: exe.full,
    isLauncher: false,
  }
}

function buildGogRow(r, { fs, logger }) {
  const dir = stringOr(r.path)
  const gameID = stringOr(r.gameID) || stringOr(r.keyName)
  const gameName = stringOr(r.gameName) || deriveNameFromDir(dir)
  const exeFile = stringOr(r.exeFile)
  if (!dir || !gameID || !gameName || !exeFile) return null
  if (!dirExists(dir, fs)) return null
  const exePath = path.win32.join(dir, exeFile)
  const exeBasename = exeFile.split(/[\\/]/).pop().toLowerCase()
  if (!/\.exe$/i.test(exeBasename)) return null
  return {
    packageName: 'gog.app.' + slugify(gameID),
    appName: gameName,
    exeBasename,
    exePath,
    isLauncher: false,
  }
}

function guessBiggestExe(dir, fs) {
  const candidates = []
  walkExes(dir, fs, candidates, 0)
  if (!candidates.length) return null
  candidates.sort((a, b) => b.size - a.size)
  return candidates[0]
}

function walkExes(dir, fs, out, depth) {
  if (depth > 2) return
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const name = e.name
    const full = path.win32.join(dir, name)
    if (e.isFile() && /\.exe$/i.test(name) && !isCommonBlacklistedExe(name)) {
      try {
        const st = fs.statSync(full)
        out.push({ full, basename: name, size: st.size })
      } catch {}
    } else if (e.isDirectory() && !/^(\.|redist|_CommonRedist|DirectX|vcredist|crashreport)/i.test(name)) {
      if (out.length < 200) walkExes(full, fs, out, depth + 1)
    }
  }
}

const BLACKLIST = [
  /^unins\d*\.exe$/i,
  /^uninstall\.exe$/i,
  /crashreport/i,
  /crashpad/i,
  /crashhandler/i,
  /^vc_?redist/i,
  /^dxsetup\.exe$/i,
  /^ue4prereqsetup_/i,
  /^ueprereqsetup_/i,
  /shaderc/i,
  /cef.*helper/i,
  /^python\.exe$/i,
]

function isCommonBlacklistedExe(name) {
  return BLACKLIST.some((re) => re.test(name))
}

function extractExeFromDisplayIcon(raw) {
  if (!raw) return null
  let s = raw.trim()
  if (s.startsWith('"')) {
    const end = s.indexOf('"', 1)
    if (end > 0) s = s.slice(1, end)
  } else {
    s = s.replace(/,-?\d+\s*$/, '')
  }
  if (!/\.exe$/i.test(s)) return null
  const basename = s.split(/[\\/]/).pop().toLowerCase()
  if (!basename) return null
  return { full: s, basename, size: 0 }
}

function dirExists(dir, fs) {
  try {
    const st = fs.statSync(dir)
    return st.isDirectory()
  } catch {
    return false
  }
}

function fileExists(f, fs) {
  try {
    const st = fs.statSync(f)
    return st.isFile()
  } catch {
    return false
  }
}

function stringOr(v) {
  if (typeof v !== 'string') return null
  const s = v.trim()
  return s || null
}

function deriveNameFromDir(dir) {
  if (!dir) return null
  const last = dir.split(/[\\/]/).filter(Boolean).pop()
  if (!last) return null
  return last
}

// Origin key names are of the form "Origin.OFR.50.0001234"; strip the
// prefix so what's left is something that at least identifies the title
// internally. If we have DisplayName we never hit this.
function deriveNameFromEaKey(keyName) {
  const trimmed = keyName.replace(/^Origin\.OFR\.\d+\./i, '').replace(/_/g, ' ')
  return trimmed || keyName
}

function parsePsJson(stdout, logger) {
  let text = (stdout || '').replace(/^\uFEFF/, '').trim()
  if (!text) return []
  let parsed
  try { parsed = JSON.parse(text) } catch (e) {
    logger.warn('[launchers/registry] json parse failed:', e.message)
    return []
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed && typeof parsed === 'object') return [parsed]
  return []
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown'
}

module.exports = {
  enumerateRegistryLaunchers,
  PS_SCRIPT,
  buildUbisoftRow,
  buildEaRow,
  buildOriginRow,
  buildGogRow,
  parsePsJson,
  extractExeFromDisplayIcon,
}
