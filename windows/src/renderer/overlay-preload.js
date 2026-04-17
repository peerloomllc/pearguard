const { contextBridge, ipcRenderer } = require('electron')

// Narrow surface — the renderer can only do what enforcement explicitly
// allows. No nodeIntegration, no remote, no fs.
contextBridge.exposeInMainWorld('overlay', {
  onPayload: (cb) => {
    ipcRenderer.on('overlay:payload', (_e, payload) => cb(payload))
  },
  onTimeRequestResult: (cb) => {
    ipcRenderer.on('overlay:time-request-result', (_e, result) => cb(result))
  },
  onPinVerifyResult: (cb) => {
    ipcRenderer.on('overlay:pin-verify-result', (_e, result) => cb(result))
  },
  requestTime: (payload) => ipcRenderer.send('overlay:request-time', payload),
  verifyPin: (payload) => ipcRenderer.send('overlay:verify-pin', payload),
})
