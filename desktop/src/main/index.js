// Electron's Linux sandbox fails under Fedora Wayland and some other distros
// because the chrome-sandbox helper isn't setuid. Disable it before requiring
// electron so the setting propagates to child processes. Windows ignores this.
if (process.platform === 'linux') {
  process.env.ELECTRON_DISABLE_SANDBOX = '1'
}

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, Tray, Menu, ipcMain, Notification, clipboard, dialog, powerMonitor } = require('electron')

// Tee console output to a rolling log file. Desktop shortcuts launch
// electron.exe directly with no stdout redirection, so without this the only
// way to see logs is to run `npm start > pearguard.log`. File lives under
// app.getPath('userData') + '/logs/', matching the electron-log convention
// and keeping logs next to the Hyperbee store (same backup/deletion boundary).
// Windows: %APPDATA%\pearguard-desktop\logs\pearguard.log
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
const { PinLockoutStore, formatLockRemaining } = require('../enforcement/pin-lockout')
const { UsageTracker } = require('../enforcement/usage-tracker')
const { enumerateInstalledApps, slugify } = require('../enforcement/apps-enumerator')
const { readFileDescription } = require('../enforcement/exe-metadata')
const { extractWin32Icons } = require('../enforcement/icon-extractor')
const { ExeMap, DEFAULT_MAP, ALIAS_MAP, LINUX_DEFAULT_MAP, LINUX_ALIAS_MAP } = require('../enforcement/exe-map')
const { SYSTEM_EXEMPT_BASENAMES, LINUX_SYSTEM_EXEMPT_BASENAMES } = require('../enforcement/block-evaluator')

// Pick the right exe map and shell-exemption set for the running platform.
// Kept here so EnforcementController stays platform-agnostic: the host knows
// which OS the binary is running on and hands the controller the seeds it
// needs, instead of the controller branching on process.platform internally.
const PLATFORM_DEFAULT_MAP = process.platform === 'linux' ? LINUX_DEFAULT_MAP : DEFAULT_MAP
const PLATFORM_ALIAS_MAP = process.platform === 'linux' ? LINUX_ALIAS_MAP : ALIAS_MAP
const PLATFORM_SYSTEM_EXEMPT = process.platform === 'linux' ? LINUX_SYSTEM_EXEMPT_BASENAMES : SYSTEM_EXEMPT_BASENAMES
const { OverlayManager } = require('./overlay')
const { ensureRegistered: ensureWatchdogRegistered } = require('./watchdog')
const { TamperDetector } = require('./tamper-detector')
const { initAutoUpdater } = require('./updater')
const { ensureAutostart: ensureLinuxAutostart } = require('./autostart-linux')
const { ensureExtensionInstalled: ensureGnomeExtension } = require('./gnome-extension-installer')
const { GnomeExtensionWatchdog } = require('./gnome-extension-watchdog')
const { migrateUserData } = require('./userdata-migrate')

// How often we hand usage telemetry to bare for replication to the parent.
// Matches Android's UsageFlushWorker cadence (15 min).
const USAGE_FLUSH_INTERVAL_MS = 15 * 60 * 1000

// Icon used in toast notifications. Same image the tray uses; electron-builder
// whitelists build/icon.* in the asar so this path resolves in both dev and
// packaged runs. Linux's libnotify can't read .ico — use the PNG there.
const NOTIFICATION_ICON_PATH = process.platform === 'win32'
  ? path.join(__dirname, '..', '..', 'build', 'icon.ico')
  : path.join(__dirname, '..', '..', 'build', 'icon.png')

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
let gnomeExtensionWatchdog = null

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
    if (msg.method === 'native:setScreenTimeBonus') {
      if (enforcement) enforcement.setScreenTimeBonus(msg.args || {})
      else console.warn('[main] native:setScreenTimeBonus received before enforcement init')
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
  // Buffer until bare has finished init. bare.js only assigns its dispatch table
  // at the END of init(), so anything sent before that comes back as "dispatch is
  // not a function" and is silently lost. The renderer path already buffered
  // (ipcMain 'bare-call'), but main-process callers did not — so a tamper or
  // enforcement-offline alert raised during startup (the GNOME extension watchdog
  // runs its first check immediately) was dropped and the PARENT WAS NEVER TOLD.
  // For a parental-control app, losing exactly the alerts that fire at boot is
  // the worst possible thing to drop. Observed live on the Debian child:
  //   [bare] dispatch error: bypass:detected dispatch is not a function
  // flushReadyQueue() drains this the moment bare emits 'ready'.
  if (!bareReady) {
    return new Promise((resolve, reject) => {
      pendingRendererCalls.push({ method, args, resolve, reject })
    })
  }
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
  // build/icon.* is whitelisted in package.json's "files" so it lives inside
  // the asar. In dev (electron .), the path resolves against the project root.
  // AppIndicator/Ayatana on Linux only renders PNG tray icons.
  const iconPath = process.platform === 'win32'
    ? path.join(__dirname, '..', '..', 'build', 'icon.ico')
    : path.join(__dirname, '..', '..', 'build', 'icon.png')
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
  // Migrate the userData root if we're running on top of an old install that
  // used the legacy package name (`pearguard-windows`). Must happen BEFORE
  // bare.js init (Hypercore opens locks) and before any other on-disk state
  // file is touched. Idempotent: a sentinel inside the new dir guards
  // repeated runs. Safe on fresh installs (no-old-dir branch).
  try {
    const result = migrateUserData()
    if (result.migrated) {
      console.log('[main] userData migrated from pearguard-windows ->', result.files, 'entries copied')
    } else if (result.reason !== 'sentinel-present' && result.reason !== 'no-old-dir') {
      console.warn('[main] userData migration skipped:', result.reason, result.error || '')
    }
  } catch (e) {
    console.warn('[main] userData migration threw:', e.message)
  }

  // Autostart on user login. No user-facing toggle: this is a parental-control
  // app and the child shouldn't be able to disable it. Dev launches (app.isPackaged
  // === false) skip this so running `npm start` doesn't register the dev binary.
  // Linux's setLoginItemSettings is a no-op; we hand-roll a .desktop file under
  // ~/.config/autostart/ instead. Re-asserted on every startup so a kid
  // deleting the entry sees it return as soon as they re-open PearGuard.
  if (app.isPackaged) {
    if (process.platform === 'linux') {
      try {
        const { wrote, path: entryPath } = ensureLinuxAutostart({ execPath: process.execPath })
        if (wrote) console.log('[main] linux autostart entry written:', entryPath)
      } catch (e) {
        console.warn('[main] linux autostart failed:', e.message)
      }
      // Install/refresh the GNOME Shell extension that backs the Wayland
      // foreground adapter. No-op on non-GNOME sessions (gnome-extensions
      // tool absent). First install requires a Shell restart to pick up.
      const gnomeExtensionSourceDir = path.join(process.resourcesPath, 'gnome-extension')
      ensureGnomeExtension({ sourceDir: gnomeExtensionSourceDir }).then(async (r) => {
        if (r.reason === 'not-linux') return
        if (!r.installed) console.warn('[main] gnome extension install skipped:', r.reason)
        else if (r.enabled && !r.requiresShellRestart) console.log('[main] gnome extension installed and enabled')
        else if (r.requiresShellRestart) console.log('[main] gnome extension installed/updated; Shell may not have loaded it yet')
        else if (!r.enabled) console.warn('[main] gnome extension enable failed')

        // Whatever the installer did, the question that actually matters is:
        // CAN we enforce on this session? Previously this was only asked when the
        // extension had just been installed — so a non-GNOME Wayland session (KDE,
        // sway) fell out at the `!r.installed` early-return above with nothing but
        // a console.warn, and the child sat in front of a parental-control app
        // that blocked nothing while the parent's dashboard looked perfectly
        // healthy. Ask it every launch, on every path.
        try {
          // 3s settle: `gnome-extensions enable` can return before the Shell has
          // finished registering the bus name on a fresh install.
          await new Promise((resolve) => setTimeout(resolve, 3000))
          await reportLinuxEnforcementCapability()
        } catch (e) {
          console.warn('[main] linux capability check failed:', e.message)
        }
      }, (e) => console.warn('[main] gnome extension install failed:', e.message))

      // Watch the extension state and re-enable + alert the parent if the
      // child toggles it off. Without this, a kid can defeat Wayland
      // enforcement in 30 seconds via Settings → Extensions.
      gnomeExtensionWatchdog = new GnomeExtensionWatchdog({
        onTamper: ({ reason }) => {
          console.warn('[main] gnome extension tamper detected:', reason)
          // Re-run the installer so a deleted directory comes back too;
          // the installer also re-issues `gnome-extensions enable` which
          // covers the toggle-off case.
          ensureGnomeExtension({ sourceDir: gnomeExtensionSourceDir })
            .catch((e) => console.warn('[main] tamper repair install failed:', e.message))
          // Relay to the parent via bare. callBare is fire-and-forget here;
          // bare-dispatch records the event and forwards bypass:alert.
          callBare('bypass:detected', { reason: 'linux:' + reason })
            .catch((e) => console.warn('[main] bypass:detected relay failed:', e.message))
        },
      })
      gnomeExtensionWatchdog.start()
    } else {
      app.setLoginItemSettings({ openAtLogin: true })
    }
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

  // vendor/src/ is a gitignored COPY of the repo's src/, and the line below is
  // what actually runs the worklet. If someone edits src/ and launches without
  // re-running prepack, the desktop app silently executes the OLD protocol code
  // while the source they're reading says otherwise — a genuinely nasty class of
  // bug we've hit before. npm start/smoke now re-vendor automatically, but a bare
  // `electron .` bypasses those hooks, so shout here too. Dev-only: a packaged
  // app has no src/ to compare against and the check no-ops.
  if (!app.isPackaged) {
    try {
      const { checkVendorFreshness } = require('../../scripts/check-vendor')
      const r = checkVendorFreshness()
      if (!r.ok && !r.skipped) {
        console.error('[main] *** vendor/src is STALE — running OLD worklet code ***')
        for (const f of r.drifted) console.error('[main]     drifted: src/' + f)
        for (const f of r.missing) console.error('[main]     missing: src/' + f)
        console.error('[main] Fix with: node scripts/prepack.js')
      }
    } catch (e) {
      console.warn('[main] vendor freshness check failed:', e.message)
    }
  }

  // Load bare AFTER shim is installed so its module-top IPC.on('data') binds
  // to our EventEmitter rather than throwing on undefined BareKit.
  bare = require('../../vendor/src/bare.js')

  // active-win is required lazily so unit tests can run without the native
  // prebuild and so a missing module degrades to "no enforcement" rather than
  // crashing the child app.
  try {
    const baseActiveWin = require('active-win')
    // On Wayland sessions, xprop (active-win's Linux backend) is blind to
    // Wayland-native windows — GNOME Calculator, Files, Firefox-on-Wayland,
    // and friends all return "Failed to parse process ID". We bridge via our
    // GNOME Shell extension over D-Bus; the wrapper falls back to active-win
    // for Xwayland-hosted apps (Steam, legacy X11 launchers) automatically.
    const { isWaylandSession, makeWaylandActiveWin } = require('../enforcement/foreground-wayland')
    const activeWin = isWaylandSession() ? makeWaylandActiveWin(baseActiveWin) : baseActiveWin
    if (isWaylandSession()) console.log('[main] wayland session detected; using gnome-shell-extension foreground adapter')
    const sodium = require('sodium-native')
    const overridesStore = new OverridesStore({
      filePath: path.join(app.getPath('userData'), 'overrides.json'),
    })
    const pinLockoutStore = new PinLockoutStore({
      filePath: path.join(app.getPath('userData'), 'pin-lockout.json'),
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
      pinLockoutStore,
      usageTracker,
      overlay,
      sodium,
      isOwnWindow,
      // Seed the exe-map with platform-appropriate defaults. On Linux that means
      // firefox/steam/discord-style basenames instead of the Windows .exe set,
      // so a foreground tick against /usr/bin/firefox resolves through the
      // built-in mapping before apps:sync hands us a learned entry. The
      // persist path keeps every learned mapping across restarts so the first
      // foreground tick after a reboot/relaunch doesn't race apps:sync.
      exeMap: new ExeMap(
        PLATFORM_DEFAULT_MAP,
        PLATFORM_ALIAS_MAP,
        path.join(app.getPath('userData'), 'exemap.json'),
      ),
    })

    // Close the in-flight usage session the moment the machine suspends or the
    // screen locks. The foreground monitor's poll timer simply stops firing
    // while suspended, so without this the session stays open and the next read
    // after wake credits the entire sleep as foreground usage — an overnight
    // suspend with a browser focused showed up as ~8h of usage and burned
    // through the screen-time cap. UsageTracker's stale-observation guard also
    // catches this, but these events give an exact boundary instead of losing
    // the grace window. Accrual resumes on the next poll after resume/unlock.
    for (const event of ['suspend', 'lock-screen']) {
      powerMonitor.on(event, () => {
        console.log('[main] power event:', event, '- closing active usage session')
        try {
          enforcement.usage.endActive()
        } catch (e) {
          console.warn('[main] endActive on', event, 'failed:', e.message)
        }
      })
    }

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
      ...Object.keys(PLATFORM_DEFAULT_MAP),
      ...PLATFORM_SYSTEM_EXEMPT,
    ])

    // markSeen() only covers our stable running binary (pearguard.exe /
    // pearguard). Our update installer and updater binaries are version-stamped
    // (pearguard-v<version>.exe, pearguard-v<version>.AppImage — the build's
    // artifactName), so their basename changes every release and is never in the
    // seen-set. When one briefly takes foreground during a self-update it would
    // otherwise fire app-first-seen and relay app:installed for PearGuard itself,
    // surfacing PearGuard in the parent's (and child's) approval list. Match the
    // whole family by prefix so any version is suppressed. No third-party app is
    // named "pearguard", so this can't over-suppress.
    const SELF_EXE_RE = /^pearguard([-_. ]|$)/i

    // New-exe sightings on the desktop are the closest analogue to Android's
    // PACKAGE_ADDED broadcast: we can't observe installs directly, so we treat
    // "first time we ever see this exe in the foreground" as "newly installed"
    // and relay it to the parent with enough metadata to show a meaningful
    // Activity notification.
    enforcement.monitor.on('app-first-seen', async ({ exePath, exeBasename, title }) => {
      // Never relay a sighting of PearGuard's own running app, update installer
      // or updater binary (version-stamped, so markSeen can't pre-cover them).
      if (exeBasename && SELF_EXE_RE.test(exeBasename)) {
        console.log('[main] app:installed suppressed for PearGuard self/updater binary', { exeBasename })
        return
      }
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
      const { pin, packageName } = payload || {}
      const result = enforcement.verifyPinOnly({ pin })
      if (result.ok) {
        overlay.notifyResult('overlay:pin-verify-result', {
          ok: true,
          durationSeconds: enforcement.getPinDurationSeconds(),
        })
      } else if (result.reason === 'locked') {
        // Relay to the parent only on a freshly triggered lockout, not on every
        // submit that arrives while already locked (mirrors Android, where the
        // keypad is hidden during a lockout so this can't repeat).
        if (result.justLocked) {
          callBare('pin:failed', {
            packageName: packageName || null,
            timestamp: Date.now(),
            failCount: result.failCount || 0,
            lockoutMs: result.retryAfterMs || 0,
          }).catch((e) => console.warn('[main] pin:failed relay failed:', e.message))
        }
        overlay.notifyResult('overlay:pin-verify-result', {
          ok: false,
          locked: true,
          retryAfterMs: result.retryAfterMs,
          error: 'Too many attempts. Try again in ' + formatLockRemaining(result.retryAfterMs) + '.',
        })
      } else {
        const tries = result.attemptsRemaining
        const reason = result.reason === 'wrong-pin'
          ? (tries === 1 ? 'Wrong PIN. 1 try left.' : 'Wrong PIN. ' + tries + ' tries left.')
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
  // Gate the worklet's verbose logs in packaged builds. They're tee'd to the
  // rolling 5 MB pearguard.log, where per-heartbeat chatter otherwise evicts the
  // crash forensics the rotation exists to keep. warn/error still come through.
  sendToBare({ method: 'init', dataDir, debug: !app.isPackaged })

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

    // Auto-update from GitHub releases. Skips in dev (app.isPackaged is false)
    // and in smoke runs since the dialog needs a real focusable window.
    if (!process.env.PEARGUARD_SMOKE && !process.env.PEARGUARD_UI_SMOKE) {
      initAutoUpdater({ getMainWindow: () => mainWindow })
    }

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

// Has this launch already told the parent enforcement is dead? One alert per
// run: the check is cheap but the parent doesn't need it on a loop.
let linuxCapabilityReported = false

// Answer "can we actually enforce on this Linux session?" and, if not, say so to
// BOTH sides. The child gets an honest desktop notification (the old code told
// every failing session to "log out and log back in" — advice that can never work
// on KDE/sway); the parent gets a bypass:detected alert, because a parent who
// believes they're protected and isn't is the worst outcome this app can produce.
//
// Signals are gathered from configuration, not liveness, so a locked screen can't
// masquerade as a broken session — see linux-capability.js for why that matters.
async function reportLinuxEnforcementCapability() {
  if (process.platform !== 'linux' || linuxCapabilityReported) return

  const { execFile } = require('child_process')
  const run = (cmd, args) => new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve(err ? null : String(stdout)))
  })

  const { isWaylandSession, callGdbus } = require('../enforcement/foreground-wayland')
  const { assessLinuxEnforcement } = require('../enforcement/linux-capability')

  const isWayland = isWaylandSession()
  // X11 needs no extension at all — don't probe, don't alarm.
  if (!isWayland) {
    console.log('[main] X11 session; active-win handles the foreground (no extension needed)')
    return
  }

  const enabledList = await run('gnome-extensions', ['list', '--enabled'])
  const hasGnome = enabledList !== null   // tool absent => not a GNOME session
  const extensionEnabled = !!enabledList && enabledList.includes('pearguard-focus@peerloomllc.com')

  const lockedHint = await run('loginctl', ['show-session', process.env.XDG_SESSION_ID || 'self', '-p', 'LockedHint', '--value'])
  const sessionLocked = !!lockedHint && lockedHint.trim() === 'yes'

  // Only meaningful when enabled AND unlocked; assess() enforces that itself.
  const dbusLive = extensionEnabled && !sessionLocked
    ? (await callGdbus({ timeoutMs: 2000 })) !== null
    : null

  const verdict = assessLinuxEnforcement({
    isLinux: true, isWayland, hasGnome, extensionEnabled, dbusLive, sessionLocked,
  })

  if (verdict.ok) {
    console.log('[main] linux enforcement capability OK (wayland + extension live)')
    return
  }

  linuxCapabilityReported = true
  console.error('[main] *** ENFORCEMENT IS NOT WORKING ***', verdict.reason,
    { hasGnome, extensionEnabled, sessionLocked, dbusLive })

  try {
    new Notification({
      title: verdict.childMessage.title,
      body: verdict.childMessage.body,
      icon: NOTIFICATION_ICON_PATH,
      urgency: 'critical',
    }).show()
  } catch (e) {
    console.warn('[main] capability notification failed:', e.message)
  }

  // Don't re-notify the parent on every launch. A broken session usually stays
  // broken until the user logs out, and the app restarts on every login (plus
  // whenever the child reopens it) — without this the parent would get the same
  // push over and over and learn to ignore it, which defeats the point. Re-alert
  // at most once per REALERT_MS per reason, persisted so it survives restarts.
  const REALERT_MS = 12 * 60 * 60 * 1000
  const statePath = path.join(app.getPath('userData'), 'capability-alert.json')
  let last = {}
  try { last = JSON.parse(fs.readFileSync(statePath, 'utf8')) } catch (_e) {}
  const now = Date.now()
  if (last.reason === verdict.reason && typeof last.at === 'number' && now - last.at < REALERT_MS) {
    console.log('[main] parent already alerted for', verdict.reason,
      Math.round((now - last.at) / 60000), 'min ago; not re-notifying')
    return
  }

  // Tell the parent. Reuses the existing bypass pipeline (persisted + relayed to
  // every paired parent); src/bypass-reasons.js maps these reasons to wording
  // that does NOT accuse the child, since an unsupported compositor is our
  // limitation, not their tampering.
  try {
    await callBare('bypass:detected', { reason: verdict.reason })
    try { fs.writeFileSync(statePath, JSON.stringify({ reason: verdict.reason, at: now })) } catch (_e) {}
    console.log('[main] parent notified that enforcement is unavailable:', verdict.reason)
  } catch (e) {
    console.warn('[main] failed to notify parent of enforcement failure:', e.message)
  }
}

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
  if (gnomeExtensionWatchdog) gnomeExtensionWatchdog.stop()
  // Flush pending exemap writes synchronously so we don't lose the last
  // 500ms of learn() calls on a clean quit (the debounce timer is unref'd).
  if (enforcement && enforcement.exeMap && typeof enforcement.exeMap._flushPersist === 'function') {
    enforcement.exeMap._flushPersist()
  }
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
