import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
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
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

test('renders loading then activity list', async () => {
  render(<AlertsTab childPublicKey="pk1" />);
  expect(screen.getByText(/loading activity/i)).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByText(/My Game/)).toBeInTheDocument();
  });
});

test('shows type badges for each alert', async () => {
  render(<AlertsTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByText('Settings'));
  expect(screen.getByText('Bypass Attempt')).toBeInTheDocument();
  expect(screen.getByText('PIN Used')).toBeInTheDocument();
  expect(screen.getByText('Time Request')).toBeInTheDocument();
});

test('does not show Approve or Deny buttons (Activity is informational only)', async () => {
  render(<AlertsTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByText(/My Game/));
  expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /deny/i })).not.toBeInTheDocument();
});

test('shows quiet message when no activity', async () => {
  window.callBare.mockResolvedValue([]);
  render(<AlertsTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText(/no activity yet/i)).toBeInTheDocument();
  });
});
