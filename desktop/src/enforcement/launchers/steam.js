// Steam library scanner. Steam games live under
// <SteamPath>\steamapps\common\<installdir>, with a sibling
// <SteamPath>\steamapps\appmanifest_<appid>.acf describing each. Additional
// libraries are declared in <SteamPath>\steamapps\libraryfolders.vdf and can
// live on any drive. The Uninstall registry doesn't know about Steam games,
// so without this scanner a parent never sees Undertale, Counter-Strike, etc.
// in the AppsTab.

const { execFile } = require('child_process')
const realFs = require('fs').promises
const path = require('path')

// Exe basenames that are never the game's launch exe: installers,
// crash handlers, redistributables, Unreal shader compilers, etc. Skipped
// during the "biggest exe wins" heuristic.
const EXE_BLACKLIST = [
  /^unins\d*\.exe$/i,
  /^uninstall\.exe$/i,
  /crashreport/i,
  /crashpad/i,
  /crashhandler/i,
  /^vc_?redist/i,
  /^dxsetup\.exe$/i,
  /^dotnet/i,
  /^directx/i,
  /^ue4prereqsetup_/i,
  /^ueprereqsetup_/i,
  /shaderc/i,
  /cef.*helper/i,
  /^python\.exe$/i,
  /^steamcmd\.exe$/i,
]

async function scanSteam({ exec, fs = realFs, logger = console } = {}) {
  const steamPath = await resolveSteamPath({ exec, logger })
  if (!steamPath) return []
  const libraries = await readLibraryFolders(steamPath, { fs, logger })
  const rows = []
  for (const lib of libraries) {
    const libRows = await scanLibrary(lib, { fs, logger })
    for (const r of libRows) rows.push(r)
  }
  return rows
}

async function resolveSteamPath({ exec, logger }) {
  if (typeof exec !== 'function') return null
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$hkcu = (Get-ItemProperty -Path 'HKCU:\\Software\\Valve\\Steam' -ErrorAction SilentlyContinue).SteamPath
$hklm = (Get-ItemProperty -Path 'HKLM:\\Software\\WOW6432Node\\Valve\\Steam' -ErrorAction SilentlyContinue).InstallPath
if ($hkcu) { Write-Output $hkcu } elseif ($hklm) { Write-Output $hklm }
`.trim()
  try {
    const out = await exec(script)
    const s = (out || '').replace(/^\uFEFF/, '').trim()
    if (!s) return null
    return s.replace(/\//g, '\\')
  } catch (e) {
    logger.warn('[launchers/steam] SteamPath lookup failed:', e.message)
    return null
  }
}

async function readLibraryFolders(steamPath, { fs, logger }) {
  const vdfPath = joinWin(steamPath, 'steamapps', 'libraryfolders.vdf')
  const libraries = [steamPath]
  let text
  try {
    text = await fs.readFile(vdfPath, 'utf8')
  } catch {
    return libraries
  }
  try {
    const tree = parseVdf(text)
    const root = tree.libraryfolders || tree.LibraryFolders || {}
    for (const key of Object.keys(root)) {
      const entry = root[key]
      if (!entry || typeof entry !== 'object') continue
      const p = typeof entry.path === 'string' ? entry.path : (typeof entry === 'string' ? entry : null)
      if (!p) continue
      const normalized = p.replace(/\\\\/g, '\\')
      if (!libraries.includes(normalized)) libraries.push(normalized)
    }
  } catch (e) {
    logger.warn('[launchers/steam] libraryfolders.vdf parse failed:', e.message)
  }
  return libraries
}

async function scanLibrary(libraryRoot, { fs, logger }) {
  const steamappsDir = joinWin(libraryRoot, 'steamapps')
  let entries
  try {
    entries = await fs.readdir(steamappsDir)
  } catch {
    return []
  }
  const out = []
  for (const name of entries) {
    if (!/^appmanifest_\d+\.acf$/i.test(name)) continue
    const manifestPath = joinWin(steamappsDir, name)
    let manifestText
    try {
      manifestText = await fs.readFile(manifestPath, 'utf8')
    } catch {
      continue
    }
    let manifest
    try {
      manifest = parseVdf(manifestText)
    } catch (e) {
      logger.warn('[launchers/steam] manifest parse failed for ' + name + ':', e.message)
      continue
    }
    const app = manifest.AppState || manifest.appstate
    if (!app) continue
    const appid = String(app.appid || app.AppID || '').trim()
    const appName = String(app.name || '').trim()
    const installdir = String(app.installdir || '').trim()
    if (!appid || !appName || !installdir) continue
    const installDirFull = joinWin(steamappsDir, 'common', installdir)
    const exeInfo = await guessLaunchExe(installDirFull, { fs, logger })
    if (!exeInfo) continue
    out.push({
      packageName: 'steam.app.' + appid,
      appName,
      exeBasename: exeInfo.basename,
      exePath: exeInfo.full,
      isLauncher: false,
    })
  }
  return out
}

// Walk the game's install dir looking for the largest non-blacklisted .exe.
// Steam doesn't store the launch exe locally without parsing its binary
// appinfo.vdf cache, so this heuristic is the best we can do offline. Good
// enough for most titles; worst case is that a parent sees a tool exe and
// re-labels it from the UI.
async function guessLaunchExe(dir, { fs, logger }, depth = 0) {
  if (depth > 2) return null
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const exeCandidates = []
  const subdirs = []
  for (const entry of entries) {
    const name = entry.name
    if (entry.isFile() && /\.exe$/i.test(name) && !isBlacklisted(name)) {
      const full = joinWin(dir, name)
      let size = 0
      try {
        const st = await fs.stat(full)
        size = st.size
      } catch { continue }
      exeCandidates.push({ full, basename: name.toLowerCase(), size })
    } else if (entry.isDirectory() && !/^(\.|redist|_CommonRedist|DirectX|vcredist|crashreport|engine\\extras)/i.test(name)) {
      subdirs.push(joinWin(dir, name))
    }
  }
  if (exeCandidates.length) {
    exeCandidates.sort((a, b) => b.size - a.size)
    const best = exeCandidates[0]
    return { basename: best.basename, full: best.full }
  }
  for (const sub of subdirs.slice(0, 8)) {
    const found = await guessLaunchExe(sub, { fs, logger }, depth + 1)
    if (found) return found
  }
  return null
}

function isBlacklisted(name) {
  return EXE_BLACKLIST.some((re) => re.test(name))
}

function joinWin(...parts) {
  return path.win32.join(...parts)
}

// Minimal VDF parser. VDF is Valve's KeyValues format:
//   "key" "value"
//   "key" { ... }
// Handles C-style escapes inside quoted strings. Comment lines starting with
// // are skipped. Throws on unbalanced braces or unterminated strings.
function parseVdf(text) {
  let i = 0
  const n = text.length
  function skip() {
    while (i < n) {
      const c = text.charCodeAt(i)
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) { i++; continue }
      if (c === 0x2f && text.charCodeAt(i + 1) === 0x2f) {
        while (i < n && text.charCodeAt(i) !== 0x0a) i++
        continue
      }
      return
    }
  }
  function readString() {
    if (text.charCodeAt(i) !== 0x22) throw new Error('expected quoted string at ' + i)
    i++
    let out = ''
    while (i < n) {
      const c = text[i]
      if (c === '\\' && i + 1 < n) {
        const nxt = text[i + 1]
        if (nxt === 'n') out += '\n'
        else if (nxt === 't') out += '\t'
        else if (nxt === 'r') out += '\r'
        else out += nxt
        i += 2
        continue
      }
      if (c === '"') { i++; return out }
      out += c
      i++
    }
    throw new Error('unterminated string')
  }
  function parseObject(topLevel) {
    const obj = {}
    while (true) {
      skip()
      if (i >= n) { if (topLevel) return obj; throw new Error('unexpected eof') }
      if (text[i] === '}') { if (topLevel) throw new Error('unexpected } at top level'); i++; return obj }
      const key = readString()
      skip()
      if (i >= n) throw new Error('unexpected eof after key')
      if (text[i] === '{') { i++; obj[key] = parseObject(false); continue }
      const value = readString()
      obj[key] = value
    }
  }
  return parseObject(true)
}

module.exports = { scanSteam, parseVdf, isBlacklisted, EXE_BLACKLIST }
