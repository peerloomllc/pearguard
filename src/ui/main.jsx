import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

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

// Called by RN shell to push bare→UI events
window.__pearEvent = function (eventName, data) {
  const handlers = eventListeners[eventName];
  if (!handlers) return;
  handlers.forEach((fn) => fn(data));
};

// Subscribe to a bare event; returns an unsubscribe function
window.onBareEvent = function (eventName, handler) {
  if (!eventListeners[eventName]) eventListeners[eventName] = [];
  eventListeners[eventName].push(handler);
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
