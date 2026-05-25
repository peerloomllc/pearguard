// XDG autostart for Linux. setLoginItemSettings only supports macOS/Windows,
// so we hand-roll a .desktop file in ~/.config/autostart/. Same intent as
// Windows: a parental-control app shouldn't surface a "disable on login"
// toggle; the kid can still delete this file, but doing so requires more
// than flipping a settings switch and we can re-create it on every launch.
const fs = require('fs')
const path = require('path')
const os = require('os')

const ENTRY_NAME = 'pearguard.desktop'

function autostartDir() {
  // Honor XDG_CONFIG_HOME so installs on systems with a non-default config
  // root still write to the right place. Default per the XDG Base Directory
  // spec is $HOME/.config.
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() ? xdg : path.join(os.homedir(), '.config')
  return path.join(base, 'autostart')
}

function autostartPath() {
  return path.join(autostartDir(), ENTRY_NAME)
}

// Build the .desktop body. execPath under an AppImage points at the mounted
// runtime, which goes stale on the next update; APPIMAGE (set by the AppImage
// runtime) is the stable path on disk, so we prefer that when present.
function buildDesktopEntry({ execPath, appName = 'PearGuard' } = {}) {
  const exe = process.env.APPIMAGE || execPath
  if (!exe) throw new Error('no exec path for autostart entry')
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${appName}`,
    `Exec="${exe}" --hidden`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    'Hidden=false',
    'NoDisplay=false',
    'Comment=PearGuard child device client',
    '',
  ].join('\n')
}

// Write (or rewrite) the autostart entry. Idempotent: if the on-disk content
// matches what we'd write, skip the write so we don't churn mtime.
function ensureAutostart({ execPath, appName } = {}) {
  const desired = buildDesktopEntry({ execPath, appName })
  const filePath = autostartPath()
  try {
    const existing = fs.readFileSync(filePath, 'utf8')
    if (existing === desired) return { wrote: false, path: filePath }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, desired, { mode: 0o644 })
  return { wrote: true, path: filePath }
}

module.exports = { ensureAutostart, buildDesktopEntry, autostartPath }
