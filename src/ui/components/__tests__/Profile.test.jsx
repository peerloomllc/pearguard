import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Profile from '../Profile.jsx';

// Dispatch-based mock: buttons call haptic:tap on every click, so a queue of
// mockResolvedValueOnce calls would get consumed out of order. Route by method
// name and pass per-test overrides for the methods whose outcome matters.
function setupCallBare(overrides = {}) {
  window.callBare = jest.fn((method, args) => {
    if (method in overrides) {
      const resp = overrides[method];
      if (typeof resp === 'function') return resp(args);
      if (resp instanceof Error) return Promise.reject(resp);
      return Promise.resolve(resp);
    }
    if (method === 'identity:getName') return Promise.resolve({});
    if (method === 'children:list') return Promise.resolve([]);
    if (method === 'haptic:tap') return Promise.resolve(null);
    return Promise.resolve({});
  });
}

beforeEach(() => {
  setupCallBare();
  // onBareEvent is defined in main.jsx (not loaded in tests) — provide a no-op stub
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

// Click the initial "Pair to Parent" button, then the "Scan QR Code" button
// in the method picker. Matches the new three-mode pair UI.
function openQrFlow() {
  fireEvent.click(screen.getByText(/pair to parent/i));
  fireEvent.click(screen.getByText(/scan qr code/i));
}

// ── Parent mode ───────────────────────────────────────────────────────────────

test('parent mode: does not show Pair to Parent button', () => {
  render(<Profile mode="parent" />);
  expect(screen.queryByText(/pair to parent/i)).not.toBeInTheDocument();
});

// ── Child mode — idle state ───────────────────────────────────────────────────

test('child mode: shows Pair to Parent button', () => {
  render(<Profile mode="child" />);
  expect(screen.getByText(/pair to parent/i)).toBeInTheDocument();
});

test('child mode: Pair to Parent opens method picker with QR and Paste options', () => {
  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));
  expect(screen.getByText(/scan qr code/i)).toBeInTheDocument();
  expect(screen.getByText(/paste link/i)).toBeInTheDocument();
});

// ── Child mode — QR happy path ────────────────────────────────────────────────

test('child mode: Scan QR Code calls qr:scan then acceptInvite', async () => {
  setupCallBare({
    'qr:scan': 'pear://pearguard/join?t=abc123',
    'acceptInvite': {},
  });

  render(<Profile mode="child" />);
  openQrFlow();

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('qr:scan');
    expect(window.callBare).toHaveBeenCalledWith('acceptInvite', ['pear://pearguard/join?t=abc123']);
  });
  expect(await screen.findByText(/pairing in progress/i)).toBeInTheDocument();
});

test('child mode: shows connecting state after scan, while acceptInvite is pending', async () => {
  let resolveAccept;
  setupCallBare({
    'qr:scan': 'pear://pearguard/join?t=abc123',
    'acceptInvite': () => new Promise(res => { resolveAccept = res; }),
  });

  render(<Profile mode="child" />);
  openQrFlow();

  expect(await screen.findByText(/connecting to parent/i)).toBeInTheDocument();
  resolveAccept({});
  expect(await screen.findByText(/pairing in progress/i)).toBeInTheDocument();
});

// ── Child mode — alreadyPaired ────────────────────────────────────────────────

test('child mode: alreadyPaired result shows banner and returns to idle', async () => {
  setupCallBare({
    'qr:scan': 'pear://pearguard/join?t=abc123',
    'acceptInvite': { ok: true, alreadyPaired: true },
  });

  render(<Profile mode="child" />);
  openQrFlow();

  expect(await screen.findByText(/already paired with this parent/i)).toBeInTheDocument();
  // UI returns to idle, not stuck on "Pairing in progress..."
  expect(screen.queryByText(/pairing in progress/i)).not.toBeInTheDocument();
  expect(screen.getByText(/pair to parent/i)).toBeInTheDocument();
});

// ── Child mode — cancel ───────────────────────────────────────────────────────

test('child mode: cancel returns to idle silently', async () => {
  setupCallBare({ 'qr:scan': new Error('cancelled') });

  render(<Profile mode="child" />);
  openQrFlow();

  expect(await screen.findByText(/pair to parent/i)).toBeInTheDocument();
  expect(screen.queryByText(/cancelled/i)).not.toBeInTheDocument();
});

test('child mode: method picker Cancel link returns to initial idle', () => {
  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));
  // Cancel link under the two method buttons
  fireEvent.click(screen.getByText(/^cancel$/i));
  expect(screen.getByText(/pair to parent/i)).toBeInTheDocument();
  expect(screen.queryByText(/scan qr code/i)).not.toBeInTheDocument();
});

// ── Child mode — error ────────────────────────────────────────────────────────

test('child mode: non-cancel error shows message and retry button', async () => {
  setupCallBare({ 'qr:scan': new Error('invalid invite') });

  render(<Profile mode="child" />);
  openQrFlow();

  expect(await screen.findByText(/invalid invite/i)).toBeInTheDocument();
  expect(screen.getByText(/try again/i)).toBeInTheDocument();
});

test('child mode: Try Again resets to idle', async () => {
  setupCallBare({ 'qr:scan': new Error('invalid invite') });

  render(<Profile mode="child" />);
  openQrFlow();
  await screen.findByText(/try again/i);

  fireEvent.click(screen.getByText(/try again/i));
  expect(screen.getByText(/pair to parent/i)).toBeInTheDocument();
});

test('child mode: permission denied shows error message', async () => {
  setupCallBare({
    'qr:scan': new Error('Camera permission denied. Please enable in Settings.'),
  });

  render(<Profile mode="child" />);
  openQrFlow();

  expect(await screen.findByText(/camera permission denied/i)).toBeInTheDocument();
  expect(screen.getByText(/try again/i)).toBeInTheDocument();
});

// ── Child mode — paste flow ───────────────────────────────────────────────────

test('child mode: Paste from Clipboard opens paste input', () => {
  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));
  fireEvent.click(screen.getByText(/paste link/i));
  expect(screen.getByPlaceholderText(/pear:\/\/pearguard\/join/i)).toBeInTheDocument();
});

test('child mode: paste + Pair calls acceptInvite with pasted URL', async () => {
  setupCallBare({ 'acceptInvite': {} });

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));
  fireEvent.click(screen.getByText(/paste link/i));

  const input = screen.getByPlaceholderText(/pear:\/\/pearguard\/join/i);
  fireEvent.change(input, { target: { value: 'pear://pearguard/join?t=pasted' } });
  fireEvent.click(screen.getByRole('button', { name: /^pair$/i }));

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('acceptInvite', ['pear://pearguard/join?t=pasted']);
  });
  expect(await screen.findByText(/pairing in progress/i)).toBeInTheDocument();
});

test('child mode: paste Pair button is disabled when input is empty', () => {
  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));
  fireEvent.click(screen.getByText(/paste link/i));
  const pairBtn = screen.getByRole('button', { name: /^pair$/i });
  expect(pairBtn).toBeDisabled();
});
