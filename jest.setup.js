import '@testing-library/jest-dom';

global.window = global.window || {};
window.ReactNativeWebView = { postMessage: jest.fn() };

// Provide a #root element for main.jsx's createRoot call
if (!document.getElementById('root')) {
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
}
