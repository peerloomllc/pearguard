import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

test('starts a free-time pause with a future pauseUntil', async () => {
  const before = Date.now();
  render(<ChildDetail child={child} onBack={() => {}} />);

  fireEvent.click(screen.getByLabelText('Pause protection'));
  expect(screen.getByText(/Pause protection for Kiddo\?/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: '2 hours' }));

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('policy:setPause', expect.objectContaining({
      childPublicKey: 'childpk',
    }));
  });
  const call = window.callBare.mock.calls.find((c) => c[0] === 'policy:setPause');
  const until = call[1].pauseUntil;
  // ~2h in the future.
  expect(until).toBeGreaterThan(before + 2 * 60 * 60 * 1000 - 5000);
  expect(until).toBeLessThan(before + 2 * 60 * 60 * 1000 + 5000);
});

test('when already paused, offers to resume protection (pauseUntil 0)', async () => {
  const paused = { ...child, pauseUntil: Date.now() + 60 * 60 * 1000 };
  render(<ChildDetail child={paused} onBack={() => {}} />);

  // The header affordance reflects the active pause.
  fireEvent.click(screen.getByLabelText('Free time active'));
  expect(screen.getByText(/Kiddo is on free time/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /Resume protection now/i }));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('policy:setPause', { childPublicKey: 'childpk', pauseUntil: 0 });
  });
});
