import React from 'react';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import Dashboard from '../Dashboard.jsx';

jest.mock('../ChildCard.jsx', () => ({ child, onPress }) => (
  <button onClick={onPress} data-testid={`child-${child.publicKey}`}>
    {child.displayName} — badges: {child.pendingTimeRequests},{child.bypassAlerts}
  </button>
));
jest.mock('../ChildDetail.jsx', () => ({ child, onBack }) => (
  <div>Detail: {child.displayName} <button onClick={onBack}>Back</button></div>
));
jest.mock('../InviteCard.jsx', () => ({ onDismiss }) => (
  <div>Invite Card <button onClick={onDismiss}>Dismiss</button></div>
));

const MOCK_CHILDREN = [
  { publicKey: 'pk1', displayName: 'Alice', isOnline: true, lastSeen: null },
  { publicKey: 'pk2', displayName: 'Bob', isOnline: false, lastSeen: null },
];

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue(MOCK_CHILDREN);
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

test('shows loading state then renders child cards', async () => {
  render(<Dashboard />);
  expect(screen.getByText('Loading...')).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByTestId('child-pk1')).toBeInTheDocument();
    expect(screen.getByTestId('child-pk2')).toBeInTheDocument();
  });
});

test('shows welcome message and add child button when no children', async () => {
  window.callBare.mockResolvedValue([]);
  render(<Dashboard />);
  await waitFor(() => {
    expect(screen.getByText(/Welcome to PearGuard/)).toBeInTheDocument();
  });
  expect(screen.getByRole('button', { name: /Add Child/ })).toBeInTheDocument();
});

test('clicking Add Child shows InviteCard', async () => {
  window.callBare.mockResolvedValue([]);
  render(<Dashboard />);
  await waitFor(() => screen.getByRole('button', { name: /Add Child/ }));
  fireEvent.click(screen.getByRole('button', { name: /Add Child/ }));
  expect(screen.getByText('Invite Card')).toBeInTheDocument();
});

test('subscribes to usage:report, child:timeRequest, alert:bypass events', async () => {
  render(<Dashboard />);
  await waitFor(() => screen.getByTestId('child-pk1'));
  expect(window.onBareEvent).toHaveBeenCalledWith('usage:report', expect.any(Function));
  expect(window.onBareEvent).toHaveBeenCalledWith('child:timeRequest', expect.any(Function));
  expect(window.onBareEvent).toHaveBeenCalledWith('alert:bypass', expect.any(Function));
});

test('updates pendingTimeRequests badge on child:timeRequest event', async () => {
  let timeRequestHandler;
  window.onBareEvent = jest.fn((event, handler) => {
    if (event === 'child:timeRequest') timeRequestHandler = handler;
    return () => {};
  });

  render(<Dashboard />);
  await waitFor(() => screen.getByTestId('child-pk1'));

  act(() => timeRequestHandler({ childPublicKey: 'pk1' }));

  await waitFor(() => {
    expect(screen.getByTestId('child-pk1').textContent).toContain('1');
  });
});

test('updates bypassAlerts badge on alert:bypass event', async () => {
  let bypassHandler;
  window.onBareEvent = jest.fn((event, handler) => {
    if (event === 'alert:bypass') bypassHandler = handler;
    return () => {};
  });

  render(<Dashboard />);
  await waitFor(() => screen.getByTestId('child-pk1'));

  act(() => bypassHandler({ childPublicKey: 'pk2' }));

  await waitFor(() => {
    expect(screen.getByTestId('child-pk2').textContent).toContain('1');
  });
});

// ── Lock or pause every child at once ───────────────────────────────────────
const setLockCalls = () => window.callBare.mock.calls.filter(([m]) => m === 'policy:setLock');

test('no "All children" row with only one child', async () => {
  window.callBare.mockResolvedValue([MOCK_CHILDREN[0]]);
  render(<Dashboard />);
  await waitFor(() => screen.getByTestId('child-pk1'));
  expect(screen.queryByText('Lock all children')).not.toBeInTheDocument();
});

test('Lock all asks once, then locks every child with the same message', async () => {
  render(<Dashboard />);
  fireEvent.click(await screen.findByText('Lock all children'));
  expect(screen.getByText("Lock every child's device?")).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /^Lock$/ }));
  await waitFor(() => expect(setLockCalls()).toHaveLength(2));
  expect(setLockCalls().map(([, a]) => a.childPublicKey).sort()).toEqual(['pk1', 'pk2']);
  expect(setLockCalls().every(([, a]) => a.locked === true)).toBe(true);
  // Both are locked now, so the same button unlocks them.
  expect(await screen.findByText('Unlock all children')).toBeInTheDocument();
});

test('Unlock all unlocks every child without asking', async () => {
  window.callBare.mockResolvedValue(MOCK_CHILDREN.map((c) => ({ ...c, locked: true })));
  render(<Dashboard />);
  fireEvent.click(await screen.findByText('Unlock all children'));
  await waitFor(() => expect(setLockCalls()).toHaveLength(2));
  expect(setLockCalls().every(([, a]) => a.locked === false)).toBe(true);
});

test('Pause all pauses every child for the chosen time', async () => {
  render(<Dashboard />);
  fireEvent.click(await screen.findByText('Pause all children'));
  fireEvent.click(await screen.findByText('1 hour'));
  await waitFor(() => {
    const pauses = window.callBare.mock.calls.filter(([m]) => m === 'policy:setPause');
    expect(pauses.map(([, a]) => a.childPublicKey).sort()).toEqual(['pk1', 'pk2']);
  });
});
