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

// Mount React app
const root = createRoot(document.getElementById('root'));
root.render(<App />);
