import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AlertsTab from '../AlertsTab.jsx';

const MOCK_ALERTS = [
  {
    id: 'a1',
    type: 'bypass',
    timestamp: '2026-03-19T08:00:00Z',
    packageName: 'com.android.settings',
    appDisplayName: 'Settings',
    resolved: false,
  },
  {
    id: 'a2',
    type: 'pin_use',
    timestamp: '2026-03-19T09:00:00Z',
    packageName: 'com.google.android.youtube',
    appDisplayName: 'YouTube',
    resolved: false,
  },
  {
    id: 'a3',
    type: 'time_request',
    timestamp: '2026-03-19T10:00:00Z',
    packageName: 'com.example.game',
    appDisplayName: 'My Game',
    requestedSeconds: 1800,
    resolved: false,
  },
];

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue(MOCK_ALERTS);
  window.onBareEvent = jest.fn().mockReturnValue(() => {}); // returns unsubscribe fn
});

test('renders loading then alert list', async () => {
  render(<AlertsTab childPublicKey="pk1" />);
  expect(screen.getByText(/loading alerts/i)).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByText(/My Game/)).toBeInTheDocument();
  });
});

test('renders Approve and Deny buttons only for time_request alerts', async () => {
  render(<AlertsTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByText(/My Game/));
  expect(screen.getByLabelText('Approve time request for com.example.game')).toBeInTheDocument();
  expect(screen.getByLabelText('Deny time request for com.example.game')).toBeInTheDocument();
  // No buttons for bypass or pin_use
  expect(screen.queryByLabelText('Approve time request for com.android.settings')).not.toBeInTheDocument();
});

test('Approve button calls app:decide with decision approve', async () => {
  render(<AlertsTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Approve time request for com.example.game'));
  window.callBare.mockResolvedValue({}); // for the approve call
  fireEvent.click(screen.getByLabelText('Approve time request for com.example.game'));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('app:decide', {
      childPublicKey: 'pk1',
      packageName: 'com.example.game',
      decision: 'approve',
    });
  });
});

test('Deny button calls app:decide with decision deny', async () => {
  render(<AlertsTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Deny time request for com.example.game'));
  window.callBare.mockResolvedValue({});
  fireEvent.click(screen.getByLabelText('Deny time request for com.example.game'));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('app:decide', {
      childPublicKey: 'pk1',
      packageName: 'com.example.game',
      decision: 'deny',
    });
  });
});

test('after approving, shows Resolved label instead of buttons', async () => {
  render(<AlertsTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Approve time request for com.example.game'));
  window.callBare.mockResolvedValue({});
  fireEvent.click(screen.getByLabelText('Approve time request for com.example.game'));
  await waitFor(() => {
    expect(screen.getByText('Resolved')).toBeInTheDocument();
    expect(screen.queryByLabelText('Approve time request for com.example.game')).not.toBeInTheDocument();
  });
});

test('shows quiet message when no alerts', async () => {
  window.callBare.mockResolvedValue([]);
  render(<AlertsTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText(/no alerts/i)).toBeInTheDocument();
  });
});
