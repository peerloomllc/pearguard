import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import Dashboard from '../Dashboard.jsx';

jest.mock('../ChildCard.jsx', () => ({ child, onPress }) => (
  <button onClick={onPress} data-testid={`child-${child.publicKey}`}>
    {child.displayName} — badges: {child.pendingTimeRequests},{child.bypassAlerts}
  </button>
));
jest.mock('../ChildDetail.jsx', () => ({ child, onBack }) => (
  <div>Detail: {child.displayName} <button onClick={onBack}>Back</button></div>
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

test('shows empty message when no children returned', async () => {
  window.callBare.mockResolvedValue([]);
  render(<Dashboard />);
  await waitFor(() => {
    expect(screen.getByText(/no children paired/i)).toBeInTheDocument();
  });
});

test('subscribes to child:usageReport, child:timeRequest, alert:bypass events', async () => {
  render(<Dashboard />);
  await waitFor(() => screen.getByTestId('child-pk1'));
  expect(window.onBareEvent).toHaveBeenCalledWith('child:usageReport', expect.any(Function));
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
