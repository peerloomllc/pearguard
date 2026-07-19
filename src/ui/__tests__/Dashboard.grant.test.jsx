import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Dashboard from '../components/Dashboard.jsx';

const CHILD = { publicKey: 'childpk', displayName: 'Kiddo', isOnline: true };

function mockCallBare() {
  return jest.fn((method) => {
    if (method === 'children:list') return Promise.resolve([CHILD]);
    return Promise.resolve({ ok: true });
  });
}

beforeEach(() => {
  window.callBare = mockCallBare();
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
  window.__registerBackHandler = jest.fn();
  window.__unregisterBackHandler = jest.fn();
});

test('a dashboard card grants bonus time without opening the child', async () => {
  render(<Dashboard />);

  // Card renders for the loaded child.
  await screen.findByText('Kiddo');

  // The card exposes a grant affordance separate from opening the child.
  fireEvent.click(screen.getByLabelText('Grant bonus time to Kiddo'));

  // The shared grant sheet opens; pick 30m.
  expect(await screen.findByText(/Grant bonus time to Kiddo\?/i)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '30m' }));

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('time:grantGeneral', {
      childPublicKey: 'childpk',
      extraSeconds: 1800,
    });
  });
  const call = window.callBare.mock.calls.find((c) => c[0] === 'time:grantGeneral');
  expect(call[1]).not.toHaveProperty('requestId');

  // Confirmation shown; the child detail view was never opened.
  expect(await screen.findByText(/Bonus time granted/i)).toBeInTheDocument();
});

test('grant affordance does not trigger opening the child detail', async () => {
  render(<Dashboard />);
  await screen.findByText('Kiddo');

  fireEvent.click(screen.getByLabelText('Grant bonus time to Kiddo'));
  await screen.findByText(/Grant bonus time to Kiddo\?/i);

  // Opening the child would navigate away and unmount the card's name into a
  // header; the tab bar (Usage/Apps/…) must not be present.
  expect(screen.queryByText('Advanced')).not.toBeInTheDocument();
});
