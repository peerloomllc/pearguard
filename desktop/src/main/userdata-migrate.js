// One-time migration from the old `pearguard-windows` userData root to the
// renamed `pearguard-desktop`. The package.json `name` drives Electron's
// app.getPath('userData'), so when we renamed the package every existing
// install would otherwise lose its Hyperbee store (= pairing, policy,
// usage). This shim copies the entire old dir to the new one on first
// launch after the upgrade and tags it so we never try again.
//
// Why copy (rather than move): renames across filesystems can fail, and a
// crashed mid-migration leaves the user with neither store. Copy + leave
// the old dir in place is safer; the old dir becomes orphaned but the kid
// can clean it up later. We mark the new dir with a `.migrated-from`
// sentinel so a successful copy is idempotent across launches.
//
// Why this lives outside Electron's app.getPath: we must run BEFORE any
// other code touches userData (bare init opens Hypercore locks, the
// installer touches gnome-shell extensions etc.). The function takes
// explicit paths so it's testable without Electron, and main/index.js
// passes app.getPath('userData') after calling it.
const fs = require('fs')
const path = require('path')
const os = require('os')

const OLD_NAME = 'pearguard-windows'
const NEW_NAME = 'pearguard-desktop'
const SENTINEL_FILE = '.migrated-from-pearguard-windows'

// Returns the platform-specific path for the old/new userData root. Electron's
// `app.getPath('userData')` does the same computation under the hood but we
// can't call it before app.whenReady, and we need both paths regardless.
function userDataDirFor(name, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming')
    return path.join(appData, name)
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', name)
  }
  // linux + others: XDG_CONFIG_HOME ?? ~/.config
  const xdg = (env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim()) || path.join(home, '.config')
  return path.join(xdg, name)
}

function copyTreeSync(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const name of fs.readdirSync(srcDir)) {
    const sp = path.join(srcDir, name)
    const dp = path.join(destDir, name)
    const stat = fs.lstatSync(sp)
    if (stat.isSymbolicLink()) {
      try { fs.symlinkSync(fs.readlinkSync(sp), dp) } catch (_) {}
    } else if (stat.isDirectory()) {
      copyTreeSync(sp, dp)
    } else {
      fs.copyFileSync(sp, dp)
    }
  }
}

// Run the migration. Returns one of:
//   { migrated: true, files }       — copied N files from old to new
//   { migrated: false, reason }     — nothing to do; reason is one of
//                                     'no-old-dir', 'new-dir-already-has-data',
//                                     'sentinel-present'
function migrateUserData({
  oldDir = userDataDirFor(OLD_NAME),
  newDir = userDataDirFor(NEW_NAME),
  logger = console,
} = {}) {
  // Sentinel: a prior launch already finished migrating. Skip.
  const sentinel = path.join(newDir, SENTINEL_FILE)
  if (fs.existsSync(sentinel)) {
    return { migrated: false, reason: 'sentinel-present' }
  }
  // No old dir → fresh install on the renamed package. Nothing to migrate.
  if (!fs.existsSync(oldDir)) {
    return { migrated: false, reason: 'no-old-dir' }
  }
  // If the new dir already exists and has a Hyperbee store, somehow the
  // user already has fresh data — don't clobber. (Could happen if a kid
  // ran the new build first and got paired, then the old data showed up.)
  if (fs.existsSync(path.join(newDir, 'pearguard', 'core'))) {
    return { migrated: false, reason: 'new-dir-already-has-data' }
  }
  try {
    logger.log('[userdata-migrate] copying', oldDir, '->', newDir)
    copyTreeSync(oldDir, newDir)
    // Record success so the next launch skips the copy.
    fs.writeFileSync(sentinel, new Date().toISOString())
    let files = 0
    try { files = fs.readdirSync(oldDir).length } catch (_) {}
    return { migrated: true, files }
  } catch (e) {
    logger.warn('[userdata-migrate] copy failed:', e.message)
    return { migrated: false, reason: 'copy-failed', error: e.message }
  }
}

module.exports = {
  migrateUserData,
  userDataDirFor,
  OLD_NAME,
  NEW_NAME,
  SENTINEL_FILE,
}
