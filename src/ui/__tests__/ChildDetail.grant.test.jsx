import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The tab bodies fetch their own data on mount; stub them so the test focuses on
// ChildDetail's own "grant bonus time" affordance.
jest.mock('../components/UsageTab.jsx', () => () => null);
jest.mock('../components/AppsTab.jsx', () => () => null);
jest.mock('../components/ActivityTab.jsx', () => () => null);
jest.mock('../components/RulesTab.jsx', () => () => null);
jest.mock('../components/AdvancedTab.jsx', () => () => null);
jest.mock('../components/UsageReports.jsx', () => () => null);

import ChildDetail from '../components/ChildDetail.jsx';

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue({ ok: true });
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
  window.__registerBackHandler = jest.fn();
  window.__unregisterBackHandler = jest.fn();
});

const child = { publicKey: 'childpk', displayName: 'Kiddo' };

test('proactively grants bonus time with no requestId and confirms', async () => {
  render(<ChildDetail child={child} onBack={() => {}} />);

  // Open the grant sheet from the header button.
  fireEvent.click(screen.getByLabelText('Grant bonus time'));
  expect(screen.getByText(/Grant bonus time to Kiddo\?/i)).toBeInTheDocument();

  // Pick 30m.
  fireEvent.click(screen.getByRole('button', { name: '30m' }));

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('time:grantGeneral', {
      childPublicKey: 'childpk',
      extraSeconds: 1800,
    });
  });
  // The grant carries no requestId — it is not a reply to a child request.
  const call = window.callBare.mock.calls.find((c) => c[0] === 'time:grantGeneral');
  expect(call[1]).not.toHaveProperty('requestId');

  // Confirmation replaces the picker.
  expect(await screen.findByText(/Bonus time granted/i)).toBeInTheDocument();
  expect(screen.getByText(/Added/i)).toHaveTextContent('30m');
});

test('offers multiple durations and maps each to the right seconds', async () => {
  render(<ChildDetail child={child} onBack={() => {}} />);
  fireEvent.click(screen.getByLabelText('Grant bonus time'));

  for (const [label, seconds] of [['15m', 900], ['1h', 3600], ['2h', 7200]]) {
    expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    void seconds;
  }

  fireEvent.click(screen.getByRole('button', { name: '1h' }));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('time:grantGeneral', {
      childPublicKey: 'childpk',
      extraSeconds: 3600,
    });
  });
});
