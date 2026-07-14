import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import ActivityTab from '../ActivityTab.jsx';

const NOW = Date.now();

// One of each shape the feed can hold: a real tamper alert, a capability failure
// (PearGuard's fault, not the child's), a resolved request and a PENDING request.
const MOCK_ACTIVITY = [
  {
    id: 'bypass:1', type: 'bypass', timestamp: NOW - 1000,
    reason: 'accessibility_disabled',
    appDisplayName: "Ben's parental controls disabled",
  },
  {
    id: 'bypass:2', type: 'enforcement_off', timestamp: NOW - 2000,
    reason: 'linux:extension-not-loaded',
    appDisplayName: "Action needed on Ben's PC",
  },
  {
    id: 'req-done', type: 'time_request', timestamp: NOW - 3000,
    appDisplayName: 'Roblox', status: 'approved', resolved: true,
  },
  {
    id: 'req-pending', type: 'time_request', timestamp: NOW - 4000,
    appDisplayName: 'Minecraft', status: 'pending', resolved: false,
    requestType: 'approval', packageName: 'com.mojang',
  },
];

function mockBare(list = MOCK_ACTIVITY) {
  window.callBare = jest.fn((method) => {
    if (method === 'alerts:list') return Promise.resolve(list);
    return Promise.resolve({ dismissed: 1 });
  });
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
}

beforeEach(() => mockBare());

test('a capability failure is not badged as a bypass attempt', async () => {
  render(<ActivityTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText('Protection Off')).toBeInTheDocument();
    expect(screen.getByText('Bypass Attempt')).toBeInTheDocument();
  });
});

test('dismissing a row removes it and tells bare which one', async () => {
  render(<ActivityTab childPublicKey="pk1" />);
  await waitFor(() => expect(screen.getByText("Action needed on Ben's PC")).toBeInTheDocument());

  fireEvent.click(screen.getByLabelText('Dismiss Protection Off'));

  await waitFor(() => {
    expect(screen.queryByText("Action needed on Ben's PC")).not.toBeInTheDocument();
  });
  expect(window.callBare).toHaveBeenCalledWith(
    'alerts:dismiss',
    { childPublicKey: 'pk1', timestamp: NOW - 2000 },
  );
});

// A pending request is an unanswered question from the child. It must not be
// dismissable from the history list, or the parent silently drops it and the
// child waits forever.
test('a pending request has no dismiss button', async () => {
  render(<ActivityTab childPublicKey="pk1" />);
  await waitFor(() => expect(screen.getByText('Pending Requests')).toBeInTheDocument());
  expect(screen.queryByLabelText('Dismiss Time Request')).not.toBeInTheDocument();
});

test('Clear asks first, and says pending requests are kept', async () => {
  render(<ActivityTab childPublicKey="pk1" />);
  await waitFor(() => expect(screen.getByLabelText('Clear activity log')).toBeInTheDocument());

  fireEvent.click(screen.getByLabelText('Clear activity log'));

  // Confirmation, not immediate destruction.
  expect(screen.getByText(/Pending requests are kept/i)).toBeInTheDocument();
  expect(window.callBare).not.toHaveBeenCalledWith('alerts:clear', expect.anything());

  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('alerts:clear', { childPublicKey: 'pk1' });
  });
});

test('Clear can be backed out of', async () => {
  render(<ActivityTab childPublicKey="pk1" />);
  await waitFor(() => expect(screen.getByLabelText('Clear activity log')).toBeInTheDocument());

  fireEvent.click(screen.getByLabelText('Clear activity log'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByText(/Pending requests are kept/i)).not.toBeInTheDocument();
  expect(window.callBare).not.toHaveBeenCalledWith('alerts:clear', expect.anything());
});

// Nothing to clear => no button, rather than a button that does nothing.
test('no Clear button when there is no alert history', async () => {
  mockBare([MOCK_ACTIVITY[3]]);  // pending request only
  render(<ActivityTab childPublicKey="pk1" />);
  await waitFor(() => expect(screen.getByText('Pending Requests')).toBeInTheDocument());
  expect(screen.queryByLabelText('Clear activity log')).not.toBeInTheDocument();
});
