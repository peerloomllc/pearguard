import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AppsTab from '../AppsTab.jsx';

const MOCK_POLICY = {
  version: 1,
  childPublicKey: 'pk1',
  apps: {
    'com.google.android.youtube': { status: 'allowed', dailyLimitSeconds: 3600 },
    'com.example.game': { status: 'blocked', dailyLimitSeconds: 0 },
    'com.shady.app': { status: 'pending', dailyLimitSeconds: null },
  },
  schedules: [],
  allowedContacts: [],
};

beforeEach(() => {
  // Per-method mock so policy:get returns the policy while overrides:list /
  // pref:get return shapes the component expects (avoids viewMode becoming the
  // policy object, which would otherwise force the 'category' branch).
  window.callBare = jest.fn((method) => {
    if (method === 'policy:get') return Promise.resolve(MOCK_POLICY);
    if (method === 'overrides:list') return Promise.resolve({ overrides: [] });
    if (method === 'pref:get') return Promise.resolve(null);
    return Promise.resolve(undefined);
  });
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

// Apps now render inside collapsible accordions that start collapsed. Expand
// every accordion so the underlying app rows are present in the DOM.
async function expandAllSections() {
  await waitFor(() => {
    expect(screen.getAllByRole('button', { expanded: false }).length).toBeGreaterThan(0);
  });
  // Re-query after each click since expanding can change the set of collapsed sections.
  let guard = 0;
  let collapsed = screen.queryAllByRole('button', { expanded: false });
  while (collapsed.length > 0 && guard < 20) {
    fireEvent.click(collapsed[0]);
    collapsed = screen.queryAllByRole('button', { expanded: false });
    guard += 1;
  }
}

test('renders loading then app list', async () => {
  render(<AppsTab childPublicKey="pk1" />);
  expect(screen.getByText(/loading apps/i)).toBeInTheDocument();
  await expandAllSections();
  expect(screen.getByText('com.google.android.youtube')).toBeInTheDocument();
});

test('renders pending app with Approve and Deny buttons', async () => {
  render(<AppsTab childPublicKey="pk1" />);
  await expandAllSections();
  expect(screen.getByLabelText('Approve com.shady.app')).toBeInTheDocument();
  expect(screen.getByLabelText('Deny com.shady.app')).toBeInTheDocument();
});

test('Approve button calls app:decide with decision approve', async () => {
  render(<AppsTab childPublicKey="pk1" />);
  await expandAllSections();
  fireEvent.click(screen.getByLabelText('Approve com.shady.app'));
  expect(window.callBare).toHaveBeenCalledWith('app:decide', {
    childPublicKey: 'pk1',
    packageName: 'com.shady.app',
    decision: 'approve',
  });
});

test('Deny button calls app:decide with decision deny', async () => {
  render(<AppsTab childPublicKey="pk1" />);
  await expandAllSections();
  fireEvent.click(screen.getByLabelText('Deny com.shady.app'));
  expect(window.callBare).toHaveBeenCalledWith('app:decide', {
    childPublicKey: 'pk1',
    packageName: 'com.shady.app',
    decision: 'deny',
  });
});

test('toggling allowed app to blocked calls policy:update', async () => {
  render(<AppsTab childPublicKey="pk1" />);
  await expandAllSections();
  fireEvent.click(screen.getByLabelText('Toggle com.google.android.youtube'));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith(
      'policy:update',
      expect.objectContaining({
        childPublicKey: 'pk1',
        policy: expect.objectContaining({
          apps: expect.objectContaining({
            'com.google.android.youtube': expect.objectContaining({ status: 'blocked' }),
          }),
        }),
      })
    );
  });
});

test('shows empty message when no apps in policy', async () => {
  window.callBare.mockResolvedValue({ ...MOCK_POLICY, apps: {} });
  render(<AppsTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText(/no apps found/i)).toBeInTheDocument();
  });
});
