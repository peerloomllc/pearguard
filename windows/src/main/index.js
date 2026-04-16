// Electron's Linux sandbox fails under Fedora Wayland and some other distros
// because the chrome-sandbox helper isn't setuid. Disable it before requiring
// electron so the setting propagates to child processes. Windows ignores this.
if (process.platform === 'linux') {
  process.env.ELECTRON_DISABLE_SANDBOX = '1'
}

const path = require('path')
const fs = require('fs')
const { app, BrowserWindow, ipcMain, Notification, clipboard, dialog } = require('electron')
const { createBareKitShim } = require('../backend/barekit-shim')
const { EnforcementController } = require('../enforcement')
const { OverridesStore } = require('../enforcement/overrides-store')
const { OverlayManager } = require('./overlay')

if (process.platform === 'linux') {
  app.disableHardwareAcceleration()
}

let mainWindow = null
let bare = null
let pendingCalls = new Map()  // id -> { resolve, reject }
let nextId = 1
let enforcement = null  // lazily constructed in app.whenReady so tests can stub active-win

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
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('bare-event', msg)
      } else {
        bufferedEvents.push(msg)
      }
    }
  }
})

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
  // Load bare AFTER shim is installed so its module-top IPC.on('data') binds
  // to our EventEmitter rather than throwing on undefined BareKit.
  bare = require('../../../src/bare.js')

  // active-win is required lazily so unit tests can run without the native
  // prebuild and so a missing module degrades to "no enforcement" rather than
  // crashing the child app.
  try {
    const activeWin = require('active-win')
    const overridesStore = new OverridesStore({
      filePath: path.join(app.getPath('userData'), 'overrides.json'),
    })
    const overlay = new OverlayManager({
      rendererDir: path.join(__dirname, '..', 'renderer'),
    })
    enforcement = new EnforcementController({ activeWin, overridesStore, overlay })

    // Forward overlay button clicks to bare. The grant returned by pin:verify
    // arrives back through `native:grantOverride`, which is already wired to
    // controller.applyGrant — that re-evaluates and dismisses the overlay.
    overlay.on('request-time', async (payload) => {
      try {
        await callBare('time:request', payload)
        overlay.notifyResult('overlay:time-request-result', { ok: true })
      } catch (e) {
        overlay.notifyResult('overlay:time-request-result', { ok: false, error: e.message })
      }
    })
    overlay.on('verify-pin', async (payload) => {
      try {
        const result = await callBare('pin:verify', payload)
        if (result && result.granted) {
          overlay.notifyResult('overlay:pin-verify-result', { ok: true })
        } else {
          const reason = (result && result.reason) === 'wrong-pin' ? 'Wrong PIN.'
            : (result && result.reason) === 'no-pin' ? 'No PIN set on this device.'
            : 'Could not verify PIN.'
          overlay.notifyResult('overlay:pin-verify-result', { ok: false, error: reason })
        }
      } catch (e) {
        overlay.notifyResult('overlay:pin-verify-result', { ok: false, error: e.message })
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
    // Flush any buffered events to the renderer once it's loaded.
    mainWindow.webContents.once('did-finish-load', () => {
      for (const ev of bufferedEvents) {
        mainWindow.webContents.send('bare-event', ev)
      }
      bufferedEvents.length = 0
    })

    // Start the foreground monitor only after bare is ready and we know we're
    // in child mode. Skip during smoke tests so they don't spin up a poller
    // they don't need.
    if (enforcement && !process.env.PEARGUARD_SMOKE && !process.env.PEARGUARD_UI_SMOKE) {
      enforcement.start()
    }
  }

  if (bareReady) onReady()
  else readyWaiters.push(onReady)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && bareReady) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On Windows the child app should stay running in the background for
  // enforcement. For Phase 1 we quit on window close; watchdog arrives in
  // Phase 5.
  if (enforcement) enforcement.stop()
  if (process.platform !== 'darwin') app.quit()
})
