// src/ui/main.jsx
//
// WebView entry point. Bundled by esbuild into assets/app-ui.bundle.
// Runs inside a WebView — no React Native APIs available here.

import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'

// ── IPC bridge ────────────────────────────────────────────────────────────────

let _nextId = 1
const _pending = new Map()   // id → { resolve, reject }
const _eventHandlers = new Map()  // event name → [fn, ...]

/**
 * Call a method in the Bare worklet.
 * Returns a Promise that resolves/rejects with the response.
 */
window.__pearCall = function (method, ...args) {
  return new Promise((resolve, reject) => {
    const id = _nextId++
    _pending.set(id, { resolve, reject })
    window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args }))
  })
}

/**
 * Called by RN when a response arrives from Bare.
 */
window.__pearResponse = function (msg) {
  const p = _pending.get(msg.id)
  if (!p) return
  _pending.delete(msg.id)
  if (msg.error) p.reject(new Error(msg.error))
  else p.resolve(msg.result)
}

/**
 * Called by RN to push unsolicited events from Bare.
 */
window.__pearEvent = function (event, data) {
  ;(_eventHandlers.get(event) ?? []).forEach(fn => fn(data))
}

/**
 * Subscribe to an event from Bare.
 */
window.__pearOn = function (event, fn) {
  const handlers = _eventHandlers.get(event) ?? []
  handlers.push(fn)
  _eventHandlers.set(event, handlers)
}

// ── Render ────────────────────────────────────────────────────────────────────

const root = createRoot(document.getElementById('root'))
root.render(<App />)
