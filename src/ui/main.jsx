import React from 'react';
import { createRoot } from 'react-dom/client';
import { injectFonts } from './fonts.js';
import App from './App.jsx';

injectFonts();

// Pending IPC calls: id → { resolve, reject }
const pending = {};
let nextId = 1;

// Called by RN shell when bare responds to a request
window.__pearResponse = function (id, result, error) {
  const p = pending[id];
  if (!p) return;
  delete pending[id];
  if (error) p.reject(new Error(error));
  else p.resolve(result);
};

// Event listeners registered by components
const eventListeners = {};

// Navigation events that may fire before Dashboard has mounted. Buffer the last
// occurrence so it can be replayed the moment a handler registers.
const BUFFERED_EVENTS = new Set(['navigate:child:alerts', 'navigate:child:requests']);
const bufferedEvents = {};

// Called by RN shell to push bare→UI events
window.__pearEvent = function (eventName, data) {
  const handlers = eventListeners[eventName];
  if (handlers && handlers.length > 0) {
    handlers.forEach((fn) => fn(data));
  } else if (BUFFERED_EVENTS.has(eventName)) {
    // No handler registered yet — buffer so the next subscriber gets it
    bufferedEvents[eventName] = data;
  }
};

// Subscribe to a bare event; returns an unsubscribe function
window.onBareEvent = function (eventName, handler) {
  if (!eventListeners[eventName]) eventListeners[eventName] = [];
  eventListeners[eventName].push(handler);
  // Replay any buffered navigation event immediately (via microtask so the
  // component finishes mounting before the handler runs)
  if (BUFFERED_EVENTS.has(eventName) && bufferedEvents[eventName] !== undefined) {
    const data = bufferedEvents[eventName];
    delete bufferedEvents[eventName];
    Promise.resolve().then(() => handler(data));
  }
  return function () {
    eventListeners[eventName] = eventListeners[eventName].filter((h) => h !== handler);
  };
};

// Send a request to the bare worklet; returns a Promise
window.callBare = function (method, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending[id] = { resolve, reject };
    window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args: args || {} }));
  });
};

// Back handler stack — deepest view registers last, gets first crack.
// Each handler returns true if it consumed the back gesture.
const backHandlers = [];

window.__registerBackHandler = function (handler) {
  backHandlers.push(handler);
};

window.__unregisterBackHandler = function (handler) {
  const idx = backHandlers.indexOf(handler);
  if (idx !== -1) backHandlers.splice(idx, 1);
};

// Called by RN shell via injectJavaScript when Android back gesture fires.
// Walks the handler stack top-down (deepest first). Posts 'back:result'
// so RN knows whether the WebView consumed the gesture.
window.__pearBack = function () {
  for (let i = backHandlers.length - 1; i >= 0; i--) {
    if (backHandlers[i]()) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ method: 'back:result', args: { handled: true } }));
      return;
    }
  }
  window.ReactNativeWebView.postMessage(JSON.stringify({ method: 'back:result', args: { handled: false } }));
};

// Mount React app
const root = createRoot(document.getElementById('root'));
root.render(<App />);
