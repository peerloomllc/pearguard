const path = require('path')
const { EventEmitter } = require('events')
const { BrowserWindow, ipcMain, screen, globalShortcut } = require('electron')

// Accelerators that would dismiss / inspect / minimize the overlay. We
// disable them at two layers: a window-local before-input-event filter and
// system-wide globalShortcut registrations active only while the overlay
// is visible. Alt+F4 is the obvious one — on fullscreen BrowserWindows in
// Electron 33, closable:false alone doesn't reliably veto WM_CLOSE, so
// without these the kid can dismiss the block screen with one key combo.
const BLOCKED_GLOBAL_SHORTCUTS = [
  'Alt+F4',           // Win32 close-window accelerator
  'CommandOrControl+W',  // Chromium close-tab; harmless but consistent
  'CommandOrControl+R',  // Reload — must not refresh past the PIN gate
  'CommandOrControl+Shift+R',
  'F11',              // Toggle fullscreen — kid could un-fullscreen us
  'F12',              // DevTools (already disabled in webPreferences, defense in depth)
  'CommandOrControl+Shift+I',  // DevTools alternative binding
]

// True when the key chord would dismiss / inspect / minimize the overlay.
// Keep narrow: PIN digits, Backspace, Enter, arrow keys etc. must NOT match
// so the kid can still type the PIN. Module-level so tests can call it
// without instantiating OverlayManager (which needs the Electron ipcMain).
function isDismissShortcut(input) {
  if (!input) return false
  const key = (input.key || '').toLowerCase()
  if (input.alt && key === 'f4') return true
  if (input.control || input.meta) {
    if (key === 'w' || key === 'r') return true
    if (input.shift && key === 'r') return true
    if (input.shift && key === 'i') return true
  }
  if (key === 'f11' || key === 'f12') return true
  return false
}

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

    // Defense in depth against the kid Alt+F4'ing or F11'ing out of the
    // overlay. The before-input-event filter runs first and is window-local;
    // globalShortcut is the system-wide fallback for when Chromium's
    // accelerator path skips the renderer entirely (Win32 sends WM_CLOSE on
    // Alt+F4 before keyboard input reaches the page). Only specific window-
    // control combos are filtered — PIN digits still flow through normally.
    this._win.webContents.on('before-input-event', (event, input) => {
      if (isDismissShortcut(input)) event.preventDefault()
    })
    this._registerGlobalShortcuts()

    this._win.on('closed', () => {
      this._unregisterGlobalShortcuts()
      this._win = null
    })
  }

  _registerGlobalShortcuts() {
    for (const accel of BLOCKED_GLOBAL_SHORTCUTS) {
      try {
        // No-op callback; registration alone is enough to swallow the key
        // chord at the OS level while the overlay is up.
        globalShortcut.register(accel, () => {})
      } catch (e) {
        // Another app may already hold this shortcut. Not fatal — the
        // before-input-event filter still catches keys that reach the
        // renderer. Log so a debugger has a breadcrumb.
        try { console.warn('[overlay] globalShortcut register failed for', accel, ':', e.message) } catch (_) {}
      }
    }
  }

  _unregisterGlobalShortcuts() {
    for (const accel of BLOCKED_GLOBAL_SHORTCUTS) {
      try { globalShortcut.unregister(accel) } catch (_) {}
    }
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

module.exports = { OverlayManager, BLOCKED_GLOBAL_SHORTCUTS, isDismissShortcut }
