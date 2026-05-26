// Preload script: wires the existing src/ui/ React bundle to Electron's
// ipcRenderer by providing the same globals the RN shell injects on mobile.
// Since contextIsolation is false (see main/index.js), we can set window.*
// directly and the UI bundle sees them after DOMContentLoaded.

const { ipcRenderer } = require('electron')

// The existing UI calls window.ReactNativeWebView.postMessage with a JSON
// string containing { id, method, args }. We mirror that contract and route
// through ipcRenderer.invoke to the main process bare bridge.
window.ReactNativeWebView = {
  postMessage(jsonStr) {
    let msg
    try { msg = JSON.parse(jsonStr) } catch (e) { return }
    const { id, method, args } = msg
    ipcRenderer.invoke('bare-call', { method, args })
      .then((result) => {
        if (typeof window.__pearResponse === 'function') {
          window.__pearResponse(id, result, null)
        }
      })
      .catch((err) => {
        if (typeof window.__pearResponse === 'function') {
          window.__pearResponse(id, null, err.message || String(err))
        }
      })
  },
}

// Forward bare events to the UI's __pearEvent handler.
ipcRenderer.on('bare-event', (_event, msg) => {
  if (msg && msg.type === 'event' && typeof window.__pearEvent === 'function') {
    window.__pearEvent(msg.event, msg.data)
  }
})
