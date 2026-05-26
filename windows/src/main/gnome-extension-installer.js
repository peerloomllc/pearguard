// Install (or refresh) the PearGuard GNOME Shell extension into the running
// user's local extensions directory so the Wayland foreground adapter has a
// D-Bus partner to query.
//
// We could ship to /usr/share/gnome-shell/extensions/ as part of the .deb
// (system-wide install) but that has two strikes against it:
//   1. GNOME 45+ still requires the user to enable per-uuid, so system-wide
//      doesn't avoid the enable step.
//   2. dpkg's postinst runs as root and can't see the interactive user's
//      DBus session to enable on their behalf.
// Per-user copy keeps install + enable in PearGuard's runtime where we have
// the user's session bus.
//
// Two limitations we accept:
//   - GNOME Shell can't load a new extension without a Shell restart. On X11
//     that's `Alt+F2 r`; on Wayland it requires a logout/login. The first
//     install therefore lights up the next session, not the current one. We
//     log the requirement and continue.
//   - The child can disable the extension via Settings -> Extensions. That's
//     a parental-control tamper concern, not addressed here.
const fs = require('fs')
const path = require('path')
const os = require('os')
const { execFile } = require('child_process')

const EXTENSION_UUID = 'pearguard-focus@peerloomllc.com'

function localExtensionsDir() {
  return path.join(os.homedir(), '.local/share/gnome-shell/extensions')
}

function localExtensionDir() {
  return path.join(localExtensionsDir(), EXTENSION_UUID)
}

// Compare two trees by file size + mtime so we don't re-copy on every launch.
// Quick + good enough: an upgrade ships fresh mtimes via the .deb, so a real
// version change always re-copies.
function treesEqual(srcDir, destDir) {
  let srcEntries, destEntries
  try { srcEntries = fs.readdirSync(srcDir).sort() } catch (_) { return false }
  try { destEntries = fs.readdirSync(destDir).sort() } catch (_) { return false }
  if (srcEntries.length !== destEntries.length) return false
  if (srcEntries.join('|') !== destEntries.join('|')) return false
  for (const name of srcEntries) {
    const sSrc = fs.statSync(path.join(srcDir, name))
    const sDest = fs.statSync(path.join(destDir, name))
    if (sSrc.size !== sDest.size) return false
  }
  return true
}

function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  for (const name of fs.readdirSync(srcDir)) {
    const sp = path.join(srcDir, name)
    const dp = path.join(destDir, name)
    const stat = fs.statSync(sp)
    if (stat.isDirectory()) copyTree(sp, dp)
    else fs.copyFileSync(sp, dp)
  }
}

function runGnomeExtensions(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile('gnome-extensions', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        // ENOENT: gnome-extensions tool missing (non-GNOME session, e.g.
        // KDE Wayland). Caller treats as "best-effort skip".
        resolve({ ok: false, error: err.message, stdout, stderr })
        return
      }
      resolve({ ok: true, stdout, stderr })
    })
  })
}

// Idempotent: copies the extension dir from the packaged resources to the
// user's extensions dir if missing or stale, then enables it if disabled.
// Returns { installed, enabled, requiresShellRestart, reason? } so the caller
// can log appropriately. Safe to call from app.whenReady before any of the
// enforcement controller exists.
async function ensureExtensionInstalled({ sourceDir, logger = console } = {}) {
  if (process.platform !== 'linux') return { installed: false, enabled: false, reason: 'not-linux' }
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return { installed: false, enabled: false, reason: 'source-missing' }
  }
  const destDir = localExtensionDir()
  let copied = false
  if (!treesEqual(sourceDir, destDir)) {
    try {
      fs.mkdirSync(localExtensionsDir(), { recursive: true })
      fs.rmSync(destDir, { recursive: true, force: true })
      copyTree(sourceDir, destDir)
      copied = true
      logger.log('[gnome-ext] copied extension to', destDir)
    } catch (e) {
      logger.warn('[gnome-ext] copy failed:', e.message)
      return { installed: false, enabled: false, reason: 'copy-failed' }
    }
  }

  // gnome-extensions enable is idempotent for an already-enabled extension.
  // Failure modes here: non-GNOME session (tool missing) or DBus not reachable.
  const enableResult = await runGnomeExtensions(['enable', EXTENSION_UUID])
  if (!enableResult.ok) {
    logger.warn('[gnome-ext] enable failed:', enableResult.error)
    return { installed: true, enabled: false, requiresShellRestart: copied, reason: 'enable-failed' }
  }
  // If we just copied a fresh tree, GNOME Shell still has the old copy in
  // memory. The new copy lights up only after a Shell restart.
  return { installed: true, enabled: true, requiresShellRestart: copied }
}

module.exports = {
  ensureExtensionInstalled,
  localExtensionDir,
  EXTENSION_UUID,
}
