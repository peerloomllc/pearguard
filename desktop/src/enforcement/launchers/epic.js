// Epic Games Launcher library scanner. Each installed title has a JSON
// manifest under %ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item
// listing InstallLocation + LaunchExecutable. Uninstalled titles leave no
// manifest behind, so the list is always accurate without a filesystem walk.

const realFs = require('fs').promises
const path = require('path')

async function scanEpic({ fs = realFs, logger = console, env = process.env } = {}) {
  const base = resolveManifestDir(env)
  if (!base) return []
  let entries
  try {
    entries = await fs.readdir(base)
  } catch {
    return []
  }
  const rows = []
  for (const name of entries) {
    if (!/\.item$/i.test(name)) continue
    const full = path.win32.join(base, name)
    let text
    try {
      text = await fs.readFile(full, 'utf8')
    } catch {
      continue
    }
    let m
    try {
      m = JSON.parse(text.replace(/^\uFEFF/, ''))
    } catch (e) {
      logger.warn('[launchers/epic] manifest parse failed for ' + name + ':', e.message)
      continue
    }
    if (m.bIsIncompleteInstall) continue
    const displayName = typeof m.DisplayName === 'string' ? m.DisplayName.trim() : ''
    const launchExe = typeof m.LaunchExecutable === 'string' ? m.LaunchExecutable.trim() : ''
    const installLocation = typeof m.InstallLocation === 'string' ? m.InstallLocation.trim() : ''
    if (!displayName || !launchExe || !installLocation) continue
    const catalogId = typeof m.CatalogItemId === 'string' && m.CatalogItemId.trim() ? m.CatalogItemId.trim() : null
    const appName = typeof m.AppName === 'string' ? m.AppName.trim() : ''
    const exePath = path.win32.join(installLocation, launchExe)
    const exeBasename = launchExe.split(/[\\/]/).pop().toLowerCase()
    if (!exeBasename || !/\.exe$/.test(exeBasename)) continue
    const idSource = catalogId || appName || displayName
    rows.push({
      packageName: 'epic.app.' + slugify(idSource),
      appName: displayName,
      exeBasename,
      exePath,
      isLauncher: false,
    })
  }
  return rows
}

function resolveManifestDir(env) {
  const programData = env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData'
  return path.win32.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
}

function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown'
}

module.exports = { scanEpic }
