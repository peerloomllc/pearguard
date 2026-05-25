const { autoUpdater } = require('electron-updater')
const { app, dialog } = require('electron')
const { exec } = require('child_process')

// Check on startup, then every 6h. Same cadence Electron's own apps use; long
// enough that an idle child PC isn't constantly hitting GitHub, short enough
// that a critical fix lands within the same school day a release ships.
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

// The watchdog Windows Service relaunches PearGuard.exe within ~60s of it
// dying. During an in-place upgrade, NSIS' customUnInit stops this service
// itself, but there's a race window between autoUpdater quitting the app and
// the new installer firing customUnInit where the watchdog could relaunch
// PearGuard and trigger the "cannot close, please close manually" loop.
// Stopping it ahead of quitAndInstall closes that window. The new installer's
// customInstall recreates the service so this is self-healing.
const WATCHDOG_SVC = 'PearGuardWatchdogSvc'

function stopWatchdog() {
  // No watchdog service on non-Windows platforms — autostart on Linux is a
  // passive .desktop entry, not a service that could race with the installer.
  if (process.platform !== 'win32') return Promise.resolve()
  return new Promise((resolve) => {
    exec(`sc.exe stop ${WATCHDOG_SVC}`, () => resolve())
  })
}

function initAutoUpdater({ getMainWindow }) {
  // Dev runs report the unbumped windows/package.json version (0.1.0) and
  // would always claim an update is available. Only run in packaged builds.
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  let downloading = false

  autoUpdater.on('update-available', async (info) => {
    if (downloading) return
    const win = getMainWindow()
    const { response } = await dialog.showMessageBox(win || undefined, {
      type: 'info',
      title: 'PearGuard update available',
      message: `PearGuard ${info.version} is available.`,
      detail: `You're currently on ${app.getVersion()}. PearGuard will close briefly to install the update.`,
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) {
      downloading = true
      autoUpdater.downloadUpdate().catch((e) => {
        downloading = false
        console.warn('[updater] downloadUpdate failed:', e.message)
      })
    }
  })

  autoUpdater.on('update-downloaded', async () => {
    await stopWatchdog()
    autoUpdater.quitAndInstall(true /* isSilent */, true /* forceRunAfter */)
  })

  autoUpdater.on('error', (e) => {
    downloading = false
    console.warn('[updater] error:', e.message)
  })

  autoUpdater.on('checking-for-update', () => console.log('[updater] checking for update'))
  autoUpdater.on('update-not-available', () => console.log('[updater] no update available'))

  autoUpdater.checkForUpdates().catch((e) => console.warn('[updater] initial check failed:', e.message))
  const timer = setInterval(() => {
    autoUpdater.checkForUpdates().catch((e) => console.warn('[updater] periodic check failed:', e.message))
  }, CHECK_INTERVAL_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

module.exports = { initAutoUpdater }
