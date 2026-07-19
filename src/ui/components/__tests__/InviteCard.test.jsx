import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import InviteCard from '../InviteCard.jsx';

let connectedCb;

beforeEach(() => {
  jest.useFakeTimers();
  connectedCb = null;
  window.onBareEvent = jest.fn((evt, cb) => {
    if (evt === 'child:connected') connectedCb = cb;
    return () => {};
  });
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

// Drive the card into the 'connecting' state via the scan flow.
async function startConnecting() {
  window.callBare = jest.fn((method) => {
    if (method === 'qr:scan') return Promise.resolve('pear://pearguard/coparent?t=abc');
    if (method === 'acceptChildInvite') return Promise.resolve({ alreadyPaired: false });
    return Promise.resolve();
  });
  render(<InviteCard onConnected={jest.fn()} onDismiss={jest.fn()} />);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Scan QR Code/i }));
  });
  // Flush the awaited qr:scan + acceptChildInvite promises.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

test('shows "Connecting to child..." after a scan resolves to a new pair', async () => {
  await startConnecting();
  expect(screen.getByText('Connecting to child...')).toBeInTheDocument();
});

test('falls out of the connecting state with an error after the timeout', async () => {
  await startConnecting();
  expect(screen.getByText('Connecting to child...')).toBeInTheDocument();
  await act(async () => { jest.advanceTimersByTime(30000); });
  expect(screen.getByText(/Timed out waiting for the child/i)).toBeInTheDocument();
  expect(screen.queryByText('Connecting to child...')).not.toBeInTheDocument();
});

test('a child:connected event invokes onConnected', async () => {
  const onConnected = jest.fn();
  window.callBare = jest.fn().mockResolvedValue(undefined);
  render(<InviteCard onConnected={onConnected} onDismiss={jest.fn()} />);
  expect(typeof connectedCb).toBe('function');
  act(() => connectedCb({ publicKey: 'child-1' }));
  expect(onConnected).toHaveBeenCalledWith({ publicKey: 'child-1' });
});
