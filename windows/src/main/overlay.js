const path = require('path')
const { EventEmitter } = require('events')
const { BrowserWindow, ipcMain, screen } = require('electron')

// Manages the blocking-overlay BrowserWindow. The window is intentionally
// disposable: show() creates it on demand, hide() destroys it. Holding state
// across show/hide cycles isn't worth the complexity, and a fresh window
// guarantees the renderer state is clean.
//
// Hardening for kid-bypass attempts (best-effort; full anti-bypass is Phase 5):
//  - frameless, fullscreen, alwaysOnTop at screen-saver level
//  - closable: false (Alt+F4 is still possible on Windows but the window
//    immediately reopens on the next foreground tick, since enforcement keeps
//    re-evaluating)
//  - skipTaskbar so the overlay doesn't show as a separate task
class OverlayManager extends EventEmitter {
  constructor({ rendererDir }) {
    super()
    this._rendererDir = rendererDir
    this._win = null
    this._currentPayload = null

    ipcMain.on('overlay:request-time', (_e, payload) => {
      this.emit('request-time', payload)
    })
    ipcMain.on('overlay:verify-pin', (_e, payload) => {
      this.emit('verify-pin', payload)
    })
    ipcMain.on('overlay:apply-pin-override', (_e, payload) => {
      this.emit('apply-pin-override', payload)
    })
  }

  // payload: { packageName, appName, reason, category }
  show(payload) {
    this._currentPayload = payload
    if (this._win && !this._win.isDestroyed()) {
      this._win.webContents.send('overlay:payload', payload)
      this._win.show()
      this._win.focus()
      return
    }

    const display = screen.getPrimaryDisplay()
    const { width, height } = display.workAreaSize

    this._win = new BrowserWindow({
      width,
      height,
      x: 0,
      y: 0,
      frame: false,
      fullscreen: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      closable: false,
      minimizable: false,
      maximizable: false,
      resizable: false,
      title: 'PearGuard',
      webPreferences: {
        preload: path.join(this._rendererDir, 'overlay-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    })
    this._win.setAlwaysOnTop(true, 'screen-saver')
    this._win.setMenuBarVisibility(false)

    this._win.loadFile(path.join(this._rendererDir, 'overlay.html'))
    this._win.webContents.once('did-finish-load', () => {
      if (this._currentPayload) {
        this._win.webContents.send('overlay:payload', this._currentPayload)
      }
    })

    // Block Alt+F4 / WM_CLOSE. closable:false is unreliable on fullscreen Win32
    // windows in Electron 33, so we also veto the close event here. hide() goes
    // through destroy() which skips the close event entirely, so this veto only
    // catches kid-initiated closes.
    this._win.on('close', (event) => {
      event.preventDefault()
    })

    this._win.on('closed', () => {
      this._win = null
    })
  }

  hide() {
    this._currentPayload = null
    if (this._win && !this._win.isDestroyed()) {
      this._win.destroy()
    }
    this._win = null
  }

  // Push a transient result back to the renderer so it can show success/error
  // (e.g., wrong PIN). result: { ok: bool, error?: string }
  notifyResult(channel, result) {
    if (this._win && !this._win.isDestroyed()) {
      this._win.webContents.send(channel, result)
    }
  }

  // OS pid of the renderer process backing the overlay window, or null when
  // no overlay is currently shown. Used by the enforcement controller to
  // ignore the overlay's own foreground events.
  getRendererPid() {
    if (!this._win || this._win.isDestroyed()) return null
    try { return this._win.webContents.getOSProcessId() } catch (_) { return null }
  }
}

module.exports = { OverlayManager }
