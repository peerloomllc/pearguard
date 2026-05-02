// Electron's Linux sandbox fails under Fedora Wayland and some other distros
// because the chrome-sandbox helper isn't setuid. Disable it before requiring
// electron so the setting propagates to child processes. Windows ignores this.
if (process.platform === 'linux') {
  process.env.ELECTRON_DISABLE_SANDBOX = '1'
}

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, clipboard, dialog } = require('electron')

// Tee console output to a rolling log file. Desktop shortcuts launch
// electron.exe directly with no stdout redirection, so without this the only
// way to see logs is to run `npm start > pearguard.log`. File lives under
// app.getPath('userData') + '/logs/', matching the electron-log convention
// and keeping logs next to the Hyperbee store (same backup/deletion boundary).
// Windows: %APPDATA%\pearguard-windows\logs\pearguard.log
;(function installFileLogger() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs')
    fs.mkdirSync(dir, { recursive: true })
    const logPath = path.join(dir, 'pearguard.log')
    // Rotate once at startup: if the existing log is over 5 MB, move it to
    // pearguard.log.1 (overwriting any prior rotation) so we keep one
    // previous-session log for crash forensics without unbounded growth.
    // Append across launches so the watchdog-triggered restart after a crash
    // preserves the crash evidence instead of wiping it on next open.
    const MAX_BYTES = 5 * 1024 * 1024
    try {
      const stat = fs.statSync(logPath)
      if (stat.size > MAX_BYTES) {
        const prev = logPath + '.1'
        try { fs.unlinkSync(prev) } catch (_e) {}
        fs.renameSync(logPath, prev)
      }
    } catch (_e) { /* no existing log yet */ }
    const stream = fs.createWriteStream(logPath, { flags: 'a' })
    const tee = (orig) => (...args) => {
      try {
        const line = args.map((a) => typeof a === 'string' ? a : require('util').inspect(a, { depth: 4 })).join(' ')
        stream.write(line + '\n')
      } catch (_e) {}
      orig.apply(console, args)
    }
    console.log = tee(console.log)
    console.warn = tee(console.warn)
    console.error = tee(console.error)
  } catch (_e) { /* best-effort */ }
})()

// Single-instance lock. Without this, every desktop-shortcut click spawns a
// fresh Electron process - all of them init bare, bind enforcement timers,
// and contend for the same userData dir. Quit any second instance and focus
// the existing window instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  return
}
app.on('second-instance', () => {
  if (mainWindow) showMainWindow()
})

const { createBareKitShim } = require('../backend/barekit-shim')
const { EnforcementController } = require('../enforcement')
const { OverridesStore } = require('../enforcement/overrides-store')
const { UsageTracker } = require('../enforcement/usage-tracker')
const { enumerateInstalledApps, slugify } = require('../enforcement/apps-enumerator')
const { readFileDescription } = require('../enforcement/exe-metadata')
const { extractWin32Icons } = require('../enforcement/icon-extractor')
const { DEFAULT_MAP } = require('../enforcement/exe-map')
const { SYSTEM_EXEMPT_BASENAMES } = require('../enforcement/block-evaluator')
const { OverlayManager } = require('./overlay')
const { ensureRegistered: ensureWatchdogRegistered } = require('./watchdog')
const { TamperDetector } = require('./tamper-detector')

// How often we hand usage telemetry to bare for replication to the parent.
// Matches Android's UsageFlushWorker cadence (15 min).
const USAGE_FLUSH_INTERVAL_MS = 15 * 60 * 1000

// Icon used in toast notifications. Same .ico the tray uses; electron-builder
// whitelists build/icon.ico in the asar so this path resolves in both dev and
// packaged runs.
const NOTIFICATION_ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.ico')

// Windows derives the toast's "app name" header from the AppUserModelID.
// electron-builder's NSIS stamps the Start Menu shortcut with build.appId
// (com.peerloomllc.pearguard), so setting the same AUMID here makes Windows
// show "PearGuard" in toasts instead of the default "electron.app.PearGuard".
if (process.platform === 'win32') {
  app.setAppUserModelId('com.peerloomllc.pearguard')
}

if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
}

let mainWindow = null
let tray = null
// Set on before-quit so the window's close handler knows to let the window go
// rather than hiding it. Without this, app.quit() triggers close → hide and
// the process never actually exits.
let isQuitting = false
let bare = null
let pendingCalls = new Map()  // id -> { resolve, reject }
let nextId = 1
let enforcement = null  // lazily constructed in app.whenReady so tests can stub active-win
let usageFlushTimer = null
let heartbeatTimer = null
let tamperDetector = null

// Install the BareKit shim BEFORE requiring bare.js so its module-top
// `BareKit.IPC.on('data', ...)` binds to our EventEmitter.
const shim = createBareKitShim()

// Route lines emitted by bare.js (responses, events, native:*) back to the
// appropriate destination.
shim.onBareOut((buf) => {
  const text = buf.toString()
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch (e) { continue }

    // native:* methods are enforcement directives. Mobile routes them to RN
    // which calls Android/iOS APIs; Windows routes them into the enforcement
    // controller. grantOverride and getEnforcementState arrive in PR 2.
    if (msg.method === 'native:setPolicy') {
      if (enforcement) enforcement.setPolicyJson(msg.args && msg.args.json)
      else console.warn('[main] native:setPolicy received before enforcement init')
      return
    }
    if (msg.method === 'native:grantOverride') {
      if (enforcement) enforcement.applyGrant(msg.args || {})
      else console.warn('[main] native:grantOverride received before enforcement init')
      return
    }
    if (msg.method === 'native:showDecisionNotification') {
      const { appName, decision } = msg.args || {}
      new Notification({
        title: 'PearGuard',
        body: `${appName || 'App'}: ${decision || ''}`,
        icon: NOTIFICATION_ICON_PATH,
      }).show()
      return
    }
    if (msg.method && msg.method.startsWith('native:')) {
      console.log('[main] native directive (stub):', msg.method, msg.args)
      return
    }

    // dispatch response -> resolve pending callBare promise
    if (msg.type === 'response' && msg.id != null) {
      const pending = pendingCalls.get(msg.id)
      if (pending) {
        pendingCalls.delete(msg.id)
        if (msg.error) pending.reject(new Error(msg.error))
        else pending.resolve(msg.result)
      }
      return
    }

    // event -> forward to renderer (buffer until renderer exists)
    if (msg.type === 'event') {
      if (msg.event === 'ready') {
        bareReady = true
        flushReadyQueue()
      }
      // apps:syncRequested + usageFlushRequested are shell-side concerns —
      // the Android shell handles these in app/index.tsx; on Electron they
      // don't need to reach the renderer. Intercept and fulfill locally.
      if (msg.event === 'apps:syncRequested') {
        runAppsSync().catch((e) => console.warn('[main] apps:sync failed:', e.message))
        return
      }
      if (msg.event === 'usageFlushRequested') {
        flushUsageOnce().catch((e) => console.warn('[main] usage:flush failed:', e.message))
        return
      }
      // First parent pairing flips the device into "supervised" mode. Until
      // this fires we leave enforcement dormant so a fresh install on a new
      // PC doesn't block apps the parent has never seen. Idempotent — re-pair
      // and reconnect both refire peer:paired and the start helpers no-op.
      if (msg.event === 'peer:paired') {
        startEnforcementIfNeeded()
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bare-event', msg)
      } else {
        bufferedEvents.push(msg)
      }
    }
  }
})

async function runAppsSync() {
  console.log('[main] apps:sync starting')
  const apps = await enumerateInstalledApps()
  if (!apps.length) {
    console.log('[main] apps:sync enumerator returned 0 apps')
    return
  }
  console.log('[main] apps:sync reporting', apps.length, 'apps; sample=', apps.slice(0, 3))
  try {
    await callBare('apps:sync', { apps })
    console.log('[main] apps:sync callBare returned ok')
  } catch (e) {
    console.warn('[main] apps:sync callBare rejected:', e.message)
    return
  }
  // Seed the ExeMap so the foreground monitor can resolve apps the enumerator
  // reported with an exe path. Without this, a freshly-synced Windows-only
  // app (packageName=win.<slug>) wouldn't enforce because its exe wasn't in
  // the starter DEFAULT_MAP. Also mark those basenames as seen so the kid's
  // first launch after pairing doesn't re-notify the parent with app:installed
  // for an app they already have in their Apps tab from the sync.
  if (enforcement) {
    const basenames = []
    for (const a of apps) {
      if (a.exeBasename && a.packageName) {
        enforcement.exeMap.learn(a.exeBasename, a.packageName)
        basenames.push(a.exeBasename)
      }
      // Register UWP rows by their display title so ApplicationFrameHost
      // foreground ticks can resolve the hosted UWP. exeBasename is passed
      // through when the enumerator fuzzy-merged a Win32 twin (Calculator),
      // so a direct-exe launch gets the same packageName via ExeMap.resolve.
      if (a.packageName && a.packageName.startsWith('uwp.') && a.appName) {
        enforcement.exeMap.learnUwp({
          title: a.appName,
          packageName: a.packageName,
          exeBasename: a.exeBasename || null,
        })
      }
    }
    enforcement.monitor.markSeen(basenames)
  }
}

let bareReady = false
const bufferedEvents = []
const pendingRendererCalls = []
const readyWaiters = []

function flushReadyQueue() {
  // Drain any bare-call requests that arrived before init completed.
  while (pendingRendererCalls.length > 0) {
    const { method, args, resolve, reject } = pendingRendererCalls.shift()
    callBare(method, args).then(resolve, reject)
  }
  // Fire any app.whenReady waiters that needed bareReady.
  while (readyWaiters.length > 0) {
    const waiter = readyWaiters.shift()
    waiter()
  }
}

function sendToBare(msg) {
  shim.sendToBare(Buffer.from(JSON.stringify(msg) + '\n'))
}

function callBare(method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    pendingCalls.set(id, { resolve, reject })
    sendToBare({ id, method, args: args || [] })
  })
}

// Methods handled on mobile by the RN shell (app/index.tsx) rather than bare.
// On Electron we intercept them here and provide a desktop-appropriate path.
const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp',
}

async function handleShellMethod(method, args) {
  if (method === 'qr:scan') {
    // Desktop has no camera. The parent already copies the invite link via the
    // "Share Link" button; the child pastes that to their clipboard and taps
    // Pair, at which point we read it back here.
    const text = clipboard.readText().trim()
    if (!text || !text.startsWith('pear://pearguard/join')) {
      throw new Error('Copy the invite link from the parent device, then try again.')
    }
    return text
  }
  if (method === 'avatar:pickPhoto') {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a profile photo',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
    })
    if (canceled || !filePaths[0]) return null
    const data = await fs.promises.readFile(filePaths[0])
    const mime = IMAGE_MIME[path.extname(filePaths[0]).toLowerCase()] || 'image/jpeg'
    return { base64: data.toString('base64'), mime }
  }
  if (method === 'share:text') {
    // Desktop has no native share sheet — copy to clipboard so the user can paste it anywhere.
    const text = (args && args.text) || ''
    if (text) clipboard.writeText(text)
    return null
  }
  if (method === 'haptic:tap') return null  // no-op on desktop
  return undefined  // not a shell method
}

ipcMain.handle('bare-call', async (_event, { method, args }) => {
  const shellResult = await handleShellMethod(method, args)
  if (shellResult !== undefined) return shellResult

  if (!bareReady) {
    return new Promise((resolve, reject) => {
      pendingRendererCalls.push({ method, args, resolve, reject })
    })
  }
  return callBare(method, args)
})

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray() {
  if (tray && !tray.isDestroyed()) return
  // build/icon.ico is whitelisted in package.json's "files" so it lives inside
  // the asar. In dev (electron .), the path resolves against the project root.
  const iconPath = path.join(__dirname, '..', '..', 'build', 'icon.ico')
  try {
    tray = new Tray(iconPath)
  } catch (e) {
    console.error('[main] tray create failed:', e.message, 'path=', iconPath)
    return
  }
  tray.setToolTip('PearGuard')
  const menu = Menu.buildFromTemplate([
    { label: 'Open PearGuard', click: showMainWindow },
  ])
  tray.setContextMenu(menu)
  tray.on('click', showMainWindow)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 760,
    minWidth: 360,
    minHeight: 640,
    title: 'PearGuard',
    webPreferences: {
      preload: path.join(__dirname, '..', 'renderer', 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
    },
  })
  const entry = process.env.PEARGUARD_SMOKE ? 'smoke.html' : 'index.html'
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', entry))

  // Clicking X should hide the window, not terminate the process. Enforcement
  // needs to keep running in the background. before-quit flips isQuitting when
  // a real shutdown (app.quit, OS shutdown) is underway so we actually close.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  // Mirror renderer console to the main process stdout when logging is on.
  if (process.env.PEARGUARD_SMOKE || process.env.PEARGUARD_UI_SMOKE || process.env.PEARGUARD_LOG_RENDERER) {
    mainWindow.webContents.on('console-message', (_e, _level, message) => {
      console.log('[renderer]', message)
    })
  }

  if (process.env.PEARGUARD_SMOKE) {
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const rows = await mainWindow.webContents.executeJavaScript(
            `Array.from(document.querySelectorAll('.row')).map(r => r.innerText).join('\\n')`
          )
          console.log('=== SMOKE RESULTS ===\n' + rows + '\n=== END ===')
        } catch (e) {
          console.error('smoke dump failed:', e.message)
        }
        app.quit()
      }, 3000)
    })
  }

  if (process.env.PEARGUARD_UI_SMOKE) {
    // Load index.html (real UI), wait for the React tree to mount and call
    // `identity:getMode`, then dump a summary of the DOM so we can confirm
    // the bundle booted correctly without opening a GUI. Also exercises the
    // `qr:scan` shell-method intercept by seeding the clipboard with a fake
    // invite URL and round-tripping via window.callBare.
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          clipboard.writeText('pear://pearguard/join?t=smoketest')
          const info = await mainWindow.webContents.executeJavaScript(`(async () => {
            const out = {
              rootHTMLLength: document.getElementById('root')?.innerHTML.length || 0,
              hasRoot: !!document.getElementById('root'),
              title: document.title,
              bodyText: document.body.innerText.slice(0, 500),
              hasCallBare: typeof window.callBare === 'function',
              hasOnBareEvent: typeof window.onBareEvent === 'function',
              qrScanResult: null,
              qrScanError: null,
            };
            try { out.qrScanResult = await window.callBare('qr:scan'); }
            catch (e) { out.qrScanError = e.message; }
            return out;
          })()`)
          console.log('=== UI SMOKE ===\n' + JSON.stringify(info, null, 2) + '\n=== END ===')
        } catch (e) {
          console.error('ui smoke dump failed:', e.message)
        }
        app.quit()
      }, 4000)
    })
  }
}

app.whenReady().then(() => {
  // Autostart on user login. No user-facing toggle: this is a parental-control
  // app and the child shouldn't be able to disable it. Dev launches (app.isPackaged
  // === false) skip this so running `npm start` doesn't register the dev binary.
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true })
  }

  // Watchdog: register a scheduled task that relaunches PearGuard every two
  // minutes if it isn't running. Registering from the app (rather than NSIS)
  // means the task runs under the interactive user's account, so the relaunched
  // process is visible in their session. Re-registered on every startup so a
  // deleted task comes back as soon as the child opens the app.
  if (app.isPackaged && process.platform === 'win32') {
    const vbsPath = path.join(process.resourcesPath, 'watchdog.vbs')
    ensureWatchdogRegistered(vbsPath).then(
      ({ created }) => { if (created) console.log('[main] watchdog scheduled task registered') },
      (e) => console.warn('[main] watchdog register failed:', e.message)
    )
  }

  // Load bare AFTER shim is installed so its module-top IPC.on('data') binds
  // to our EventEmitter rather than throwing on undefined BareKit.
  bare = require('../../vendor/src/bare.js')

  // active-win is required lazily so unit tests can run without the native
  // prebuild and so a missing module degrades to "no enforcement" rather than
  // crashing the child app.
  try {
    const activeWin = require('active-win')
    const sodium = require('sodium-native')
    const overridesStore = new OverridesStore({
      filePath: path.join(app.getPath('userData'), 'overrides.json'),
    })
    const usageTracker = new UsageTracker({
      filePath: path.join(app.getPath('userData'), 'usage.json'),
    })
    const overlay = new OverlayManager({
      rendererDir: path.join(__dirname, '..', 'renderer'),
    })
    // Ignore foreground events from any window we own. Without this, clicking
    // a button on the overlay focuses the overlay's renderer (electron.exe)
    // and the controller thinks "electron is now in the foreground" — which,
    // under an active lock or schedule, would re-show the overlay and reset
    // the PIN view back to main. Worse, an unmapped focus event from one of
    // our own helper processes (GPU, utility) returns evaluate() === null and
    // dismisses the overlay outright; the kid clicking Cancel on the time grid
    // could trigger a transient focus blip that hides the overlay until the
    // next foreground tick re-creates it. Also match by exePath so any of our
    // child processes get filtered regardless of which pid active-win reports.
    const ownExePath = process.execPath ? process.execPath.toLowerCase() : ''
    const isOwnWindow = (info) => {
      if (!info || typeof info.pid !== 'number') return false
      if (info.pid === process.pid) return true
      const overlayPid = overlay.getRendererPid()
      if (overlayPid && info.pid === overlayPid) return true
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          const mainPid = mainWindow.webContents.getOSProcessId()
          if (mainPid && info.pid === mainPid) return true
        } catch (_) {}
      }
      if (ownExePath && info.exePath && info.exePath.toLowerCase() === ownExePath) return true
      return false
    }
    enforcement = new EnforcementController({
      activeWin,
      seenExesPath: path.join(app.getPath('userData'), 'seen-exes.json'),
      overridesStore,
      usageTracker,
      overlay,
      sodium,
      isOwnWindow,
    })

    // Countdown notifications for daily limits and approaching schedules.
    // Mirrors Android's pre-expiry warnings (EnforcementService.check*Warnings)
    // at the configured thresholds (policy.settings.warningMinutes, default
    // 10/5/1 min). Dedupe lives in the WarningChecker so a toast fires once
    // per threshold per day even though the 5s tick revisits it constantly.
    enforcement.on('warning', (event) => {
      try {
        new Notification({
          title: event.title,
          body: event.body,
          icon: NOTIFICATION_ICON_PATH,
        }).show()
      } catch (e) {
        console.warn('[main] warning notification failed:', e.message)
      }
    })

    // Suppress first-sighting for our own running process, the starter
    // DEFAULT_MAP, and Windows system/host processes. Without this, the very
    // first foreground tick would fire app:installed for electron.exe (our
    // window just took focus); the first chrome launch after pairing would
    // re-notify the parent for a well-known mapped app; and every session
    // would leak app:installed events for host processes like
    // ApplicationFrameHost.exe and RuntimeBroker.exe that briefly steal focus.
    enforcement.monitor.loadSeen()
    const selfBasename = (process.execPath || '').split(/[\\/]/).pop()
    enforcement.monitor.markSeen([
      selfBasename,
      ...Object.keys(DEFAULT_MAP),
      ...SYSTEM_EXEMPT_BASENAMES,
    ])

    // New-exe sightings on the desktop are the closest analogue to Android's
    // PACKAGE_ADDED broadcast: we can't observe installs directly, so we treat
    // "first time we ever see this exe in the foreground" as "newly installed"
    // and relay it to the parent with enough metadata to show a meaningful
    // Activity notification.
    enforcement.monitor.on('app-first-seen', async ({ exePath, exeBasename, title }) => {
      try {
        const [fileDescription, iconMap] = await Promise.all([
          readFileDescription(exePath),
          extractWin32Icons([exePath]),
        ])
        const packageName = enforcement.exeMap.resolve(exePath) || ('win.' + slugify(fileDescription || exeBasename))
        const appName = fileDescription || exeBasename || packageName
        const iconBase64 = iconMap.get(exePath) || null
        console.log('[main] app:installed first-sighting', { exeBasename, packageName, appName, hasIcon: !!iconBase64 })
        await callBare('app:installed', {
          packageName,
          appName,
          exeBasename,
          exePath,
          windowTitle: title || '',
          fileDescription: fileDescription || '',
          ...(iconBase64 && { iconBase64 }),
        })
        // Without this, the next foreground tick of the same exe would
        // resolve to null again (ExeMap is in-memory only, apps:sync is the
        // only other path that populates it) and block-evaluator would allow
        // the app regardless of the pending policy entry we just created.
        if (exeBasename && packageName) {
          enforcement.exeMap.learn(exeBasename, packageName)
        }
      } catch (e) {
        console.warn('[main] app:installed first-sighting relay failed:', e.message)
      }
    })

    // Forward overlay button clicks. Time-request grants come back from the
    // parent via `native:grantOverride`, which is already wired to
    // controller.applyGrant. PIN overrides apply locally inside
    // enforcement.applyPinOverride once the kid picks a duration.
    overlay.on('request-time', async (payload) => {
      try {
        await callBare('time:request', payload)
        overlay.notifyResult('overlay:time-request-result', { ok: true })
      } catch (e) {
        overlay.notifyResult('overlay:time-request-result', { ok: false, error: e.message })
      }
    })
    overlay.on('verify-pin', async (payload) => {
      // Bare's pin:verify only checks the legacy policy.pinHash field which is
      // stripped on the child by handlePolicyUpdate. Verify locally against
      // the per-parent pinHashes map (mirroring AppBlockerModule on Android),
      // then route a pin:used audit through bare for parent-side logging.
      const { pin } = payload || {}
      const result = enforcement.verifyPinOnly({ pin })
      if (result.ok) {
        overlay.notifyResult('overlay:pin-verify-result', {
          ok: true,
          durationSeconds: enforcement.getPinDurationSeconds(),
        })
      } else {
        const reason = result.reason === 'wrong-pin' ? 'Wrong PIN.'
          : result.reason === 'no-pin' ? 'No PIN set on this device.'
          : result.reason === 'no-policy' ? 'Policy not loaded yet.'
          : result.reason === 'no-sodium' ? 'PIN verification unavailable.'
          : 'Could not verify PIN.'
        overlay.notifyResult('overlay:pin-verify-result', { ok: false, error: reason })
      }
    })
    overlay.on('apply-pin-override', async (payload) => {
      const { packageName, durationSeconds } = payload || {}
      const result = enforcement.applyPinOverride({ packageName, durationSeconds })
      if (result.ok) {
        overlay.notifyResult('overlay:pin-override-result', { ok: true })
        try {
          await callBare('pin:used', {
            packageName: packageName || null,
            timestamp: Date.now(),
            durationSeconds: result.durationSeconds,
          })
        } catch (e) {
          console.warn('[main] pin:used audit relay failed:', e.message)
        }
      } else {
        const reason = result.reason === 'pin-not-verified' ? 'PIN verification expired. Try again.'
          : result.reason === 'invalid-duration' ? 'Unsupported duration.'
          : 'Could not apply override.'
        overlay.notifyResult('overlay:pin-override-result', { ok: false, error: reason })
      }
    })
  } catch (e) {
    console.error('[main] enforcement disabled, active-win failed to load:', e.message)
  }

  // Kick off bare.js init with Electron's per-user data dir. The window is
  // created as soon as `ready` fires from bare, so UI calls made during
  // component mount land after dispatch is wired up.
  const dataDir = app.getPath('userData')
  sendToBare({ method: 'init', dataDir })

  const onReady = async () => {
    // This Windows client is child-only. If no mode is persisted yet, pin it
    // to 'child' so the UI skips the (mobile-only) mode-select shell screen
    // and lands on ChildApp directly.
    try {
      const { mode } = await callBare('identity:getMode')
      if (!mode) {
        await callBare('setMode', ['child'])
      }
    } catch (e) {
      console.error('[main] mode bootstrap failed:', e.message)
    }

    createWindow()
    createTray()
    // Flush any buffered events to the renderer once it's loaded.
    mainWindow.webContents.once('did-finish-load', () => {
      for (const ev of bufferedEvents) {
        mainWindow.webContents.send('bare-event', ev)
      }
      bufferedEvents.length = 0
    })

    // Start the foreground monitor only after bare is ready, we know we're in
    // child mode, AND at least one parent is paired. Without the pairing gate,
    // a fresh install on a new PC would mark every newly-sighted exe as
    // 'pending' in the local policy (see bare-dispatch app:installed) and the
    // overlay would block apps the parent has never seen. peer:paired (handled
    // in the bare-out router above) starts enforcement on the first pair.
    if (!process.env.PEARGUARD_SMOKE && !process.env.PEARGUARD_UI_SMOKE) {
      try {
        const { hasPeers } = await callBare('peers:hasParent')
        if (hasPeers) startEnforcementIfNeeded()
        else console.log('[main] enforcement deferred: no paired parent yet')
      } catch (e) {
        console.warn('[main] peers:hasParent check failed, deferring enforcement:', e.message)
      }
    }

    // Tamper detection: compare the previous runtime-state marker against
    // now; if we were killed (no clean-quit flag, recent heartbeat), tell
    // bare so it logs an alert and notifies every paired parent. Must run
    // after bare is ready so callBare resolves. Skip during smoke runs so
    // the state file doesn't accumulate spurious markers.
    if (!process.env.PEARGUARD_SMOKE && !process.env.PEARGUARD_UI_SMOKE) {
      try {
        tamperDetector = new TamperDetector({
          userDataDir: dataDir,
          onTamper: ({ reason, age }) => {
            console.warn('[main] tamper detected:', reason, 'heartbeat age ms:', age)
            callBare('bypass:detected', { reason }).catch((e) => {
              console.warn('[main] bypass:detected dispatch failed:', e.message)
            })
          },
        })
        tamperDetector.checkOnStartup()
        tamperDetector.startHeartbeat()
      } catch (e) {
        console.warn('[main] tamper detector init failed:', e.message)
      }
    }
  }

  if (bareReady) onReady()
  else readyWaiters.push(onReady)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && bareReady) createWindow()
  })
})

async function flushUsageOnce() {
  if (!enforcement || !bareReady) return
  const usage = enforcement.usage.getDailyUsageAll()
  const weekly = enforcement.usage.getWeeklyUsageAll()
  const sessions = enforcement.usage.takeSessions()
  const foregroundPackage = enforcement.usage.getLastForegroundPackage()
  if (usage.length === 0 && sessions.length === 0) return
  try {
    await callBare('usage:flush', { usage, weekly, foregroundPackage, sessions })
  } catch (e) {
    console.warn('[main] usage:flush failed:', e.message)
  }
}

async function pushHeartbeatDataOnce() {
  if (!enforcement || !bareReady) return
  const usage = enforcement.usage.getDailyUsageAll()
  const currentAppPackage = enforcement.usage.getLastForegroundPackage()
  const todayScreenTimeSeconds = usage.reduce((sum, a) => sum + (a.secondsToday || 0), 0)
  const foregroundEntry = currentAppPackage ? usage.find((a) => a.packageName === currentAppPackage) : null
  const currentApp = foregroundEntry ? (foregroundEntry.appName || foregroundEntry.displayName) : null
  try {
    await callBare('heartbeat:updateData', { currentApp, currentAppPackage: currentAppPackage || null, todayScreenTimeSeconds })
  } catch (e) {
    console.warn('[main] heartbeat:updateData failed:', e.message)
  }
}

// Idempotent: safe to call from both the startup path and the peer:paired
// listener. enforcement.start() guards its own internal timer, the timer
// helpers below do too.
let enforcementStarted = false
function startEnforcementIfNeeded() {
  if (enforcementStarted || !enforcement) return
  enforcementStarted = true
  console.log('[main] starting enforcement (parent paired)')
  enforcement.start()
  startUsageFlushTimer()
  startHeartbeatTimer()
}

function startUsageFlushTimer() {
  if (usageFlushTimer) return
  usageFlushTimer = setInterval(flushUsageOnce, USAGE_FLUSH_INTERVAL_MS)
  if (typeof usageFlushTimer.unref === 'function') usageFlushTimer.unref()
}

function stopUsageFlushTimer() {
  if (usageFlushTimer) {
    clearInterval(usageFlushTimer)
    usageFlushTimer = null
  }
}

function startHeartbeatTimer() {
  if (heartbeatTimer) return
  pushHeartbeatDataOnce()
  heartbeatTimer = setInterval(pushHeartbeatDataOnce, 60 * 1000)
  if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()
}

function stopHeartbeatTimer() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

app.on('before-quit', () => {
  isQuitting = true
  stopUsageFlushTimer()
  stopHeartbeatTimer()
  // Close the active session so its seconds land in takeSessions() before we
  // try to flush one last time.
  if (enforcement) enforcement.usage.endActive()
  flushUsageOnce()
  // Stamp the runtime-state file so the next launch knows this was a clean
  // quit (user chose Quit from tray / system shutdown) rather than a kill.
  if (tamperDetector) tamperDetector.markCleanQuit()
})

// No window-all-closed handler: the main window's close event is intercepted
// to hide instead of destroy, so this would only fire if something explicitly
// destroyed the window. Even then, we want the process to survive so tray
// menu + enforcement stay alive. An explicit quit path goes through the tray.
