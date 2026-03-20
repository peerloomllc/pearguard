import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Profile from '../Profile.jsx';

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue({});
});

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

// ── Child mode — happy path ───────────────────────────────────────────────────

test('child mode: calls qr:scan then acceptInvite on button press', async () => {
  window.callBare = jest.fn()
    .mockResolvedValueOnce({})                               // identity:getName
    .mockResolvedValueOnce('pear://pearguard/join?t=abc123') // qr:scan
    .mockResolvedValueOnce({});                              // acceptInvite

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('qr:scan');
    expect(window.callBare).toHaveBeenCalledWith('acceptInvite', ['pear://pearguard/join?t=abc123']);
  });
  expect(await screen.findByText(/paired!/i)).toBeInTheDocument();
});

test('child mode: shows connecting state after scan, while acceptInvite is pending', async () => {
  let resolveAccept;
  window.callBare = jest.fn()
    .mockResolvedValueOnce({})                               // identity:getName
    .mockResolvedValueOnce('pear://pearguard/join?t=abc123') // qr:scan resolves immediately
    .mockImplementationOnce(() => new Promise(res => { resolveAccept = res; })); // acceptInvite hangs

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  // connecting appears only after qr:scan resolves and acceptInvite is pending
  expect(await screen.findByText(/connecting to parent/i)).toBeInTheDocument();
  resolveAccept({});
  expect(await screen.findByText(/paired!/i)).toBeInTheDocument();
});

// ── Child mode — cancel ───────────────────────────────────────────────────────

test('child mode: cancel returns to idle silently', async () => {
  window.callBare = jest.fn()
    .mockResolvedValueOnce({})                              // identity:getName
    .mockRejectedValueOnce(new Error('cancelled'));          // qr:scan

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  expect(await screen.findByText(/pair to parent/i)).toBeInTheDocument();
  expect(screen.queryByText(/cancelled/i)).not.toBeInTheDocument();
});

// ── Child mode — error ────────────────────────────────────────────────────────

test('child mode: non-cancel error shows message and retry button', async () => {
  window.callBare = jest.fn()
    .mockResolvedValueOnce({})                              // identity:getName
    .mockRejectedValueOnce(new Error('invalid invite'));    // qr:scan

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  expect(await screen.findByText(/invalid invite/i)).toBeInTheDocument();
  expect(screen.getByText(/try again/i)).toBeInTheDocument();
});

test('child mode: Try Again resets to idle', async () => {
  window.callBare = jest.fn()
    .mockResolvedValueOnce({})                              // identity:getName
    .mockRejectedValueOnce(new Error('invalid invite'));    // qr:scan

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));
  await screen.findByText(/try again/i);

  fireEvent.click(screen.getByText(/try again/i));
  expect(screen.getByText(/pair to parent/i)).toBeInTheDocument();
});

test('child mode: permission denied shows error message', async () => {
  window.callBare = jest.fn()
    .mockResolvedValueOnce({})                              // identity:getName
    .mockRejectedValueOnce(
      new Error('Camera permission denied. Please enable in Settings.')
    );                                                       // qr:scan

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  expect(await screen.findByText(/camera permission denied/i)).toBeInTheDocument();
  expect(screen.getByText(/try again/i)).toBeInTheDocument();
});
