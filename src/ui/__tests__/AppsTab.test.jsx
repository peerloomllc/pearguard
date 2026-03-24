import React from 'react';
import { render, screen } from '@testing-library/react';
import AppsTab from '../components/AppsTab.jsx';

// We test AppRow behaviour by rendering AppsTab with a mocked policy response,
// since AppRow is an internal component not exported separately.

beforeEach(() => {
  window.callBare = jest.fn();
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

// Minimal appData shared across tests
const baseAppData = {
  appName: 'Google Chrome',
  status: 'allowed',
  addedAt: null,
};

const policyWithIcon = {
  apps: {
    'com.android.chrome': {
      ...baseAppData,
      iconBase64: 'iVBORw0KGgo=', // minimal fake PNG base64
    },
  },
};

const policyWithoutIcon = {
  apps: {
    'com.android.chrome': { ...baseAppData },
  },
};

test('AppRow renders an <img> when iconBase64 is present', async () => {
  window.callBare.mockResolvedValue(policyWithIcon);
  render(<AppsTab childPublicKey="abc123" />);
  const img = await screen.findByRole('img', { name: /google chrome icon/i });
  expect(img).toHaveAttribute('src', expect.stringContaining('data:image/png;base64,'));
});

test('AppRow renders initials circle when iconBase64 is absent', async () => {
  window.callBare.mockResolvedValue(policyWithoutIcon);
  render(<AppsTab childPublicKey="abc123" />);
  // Initials circle renders the first letters of the app name
  const initials = await screen.findByText('GC');
  expect(initials).toBeInTheDocument();
});

test('AppRow initials fall back to first char of package name when appName is absent', async () => {
  window.callBare.mockResolvedValue({
    apps: { 'com.android.chrome': { status: 'allowed', addedAt: null } },
  });
  render(<AppsTab childPublicKey="abc123" />);
  // Package name 'com.android.chrome' → first word 'com' → initials 'C'
  const initials = await screen.findByText('C');
  expect(initials).toBeInTheDocument();
});
