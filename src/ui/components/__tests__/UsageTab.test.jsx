import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import UsageTab from '../UsageTab.jsx';

const MOCK_REPORT = {
  lastSynced: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 mins ago
  apps: [
    {
      packageName: 'com.google.android.youtube',
      displayName: 'YouTube',
      todaySeconds: 3600,
      weekSeconds: 18000,
      dailyLimitSeconds: 7200,
    },
    {
      packageName: 'com.instagram.android',
      displayName: 'Instagram',
      todaySeconds: 7500,  // over the 3600 limit
      weekSeconds: 25000,
      dailyLimitSeconds: 3600,
    },
  ],
};

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue(MOCK_REPORT);
});

test('shows loading state initially', () => {
  window.callBare = jest.fn().mockReturnValue(new Promise(() => {}));
  render(<UsageTab childPublicKey="pk1" />);
  expect(screen.getByText(/loading usage/i)).toBeInTheDocument();
});

test('renders app usage bars from mock data', async () => {
  render(<UsageTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText('YouTube')).toBeInTheDocument();
    expect(screen.getByText('Instagram')).toBeInTheDocument();
  });
});

test('renders last synced timestamp', async () => {
  render(<UsageTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText(/last synced/i)).toBeInTheDocument();
    expect(screen.getByText(/5m ago/)).toBeInTheDocument();
  });
});

test('formats today usage correctly', async () => {
  render(<UsageTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText('Today: 1h 0m')).toBeInTheDocument();
  });
});

test('shows no usage data message when apps array is empty', async () => {
  window.callBare.mockResolvedValue({ lastSynced: null, apps: [] });
  render(<UsageTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText(/no usage data/i)).toBeInTheDocument();
  });
});

test('shows no usage data message when report is null', async () => {
  window.callBare.mockResolvedValue(null);
  render(<UsageTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText(/no usage data/i)).toBeInTheDocument();
  });
});

test('calls usage:getLatest with the correct childPublicKey', async () => {
  render(<UsageTab childPublicKey="pk-abc" />);
  await waitFor(() => screen.getByText('YouTube'));
  expect(window.callBare).toHaveBeenCalledWith('usage:getLatest', { childPublicKey: 'pk-abc' });
});
