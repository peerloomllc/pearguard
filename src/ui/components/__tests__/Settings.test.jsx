import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Settings from '../Settings.jsx';

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue({});
});

test('renders PIN form and display name section', () => {
  render(<Settings />);
  expect(screen.getByLabelText('New PIN')).toBeInTheDocument();
  expect(screen.getByLabelText('Confirm PIN')).toBeInTheDocument();
  expect(screen.getByLabelText('Parent Name')).toBeInTheDocument();
});

test('shows error when PINs do not match', async () => {
  render(<Settings />);
  fireEvent.change(screen.getByLabelText('New PIN'), { target: { value: '1234' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: '5678' } });
  fireEvent.click(screen.getByLabelText('Save PIN'));
  expect(await screen.findByText(/pins do not match/i)).toBeInTheDocument();
  expect(window.callBare).not.toHaveBeenCalledWith('pin:set', expect.anything());
});

test('shows error when PIN is shorter than 4 digits', async () => {
  render(<Settings />);
  fireEvent.change(screen.getByLabelText('New PIN'), { target: { value: '12' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: '12' } });
  fireEvent.click(screen.getByLabelText('Save PIN'));
  expect(await screen.findByText(/PIN must be 4 to 10 digits/i)).toBeInTheDocument();
});

test('shows error when PIN is longer than 10 digits', async () => {
  render(<Settings />);
  // maxLength caps typing at 10, so drive the value directly to prove the
  // validator rejects an over-long PIN rather than relying on the input alone.
  fireEvent.change(screen.getByLabelText('New PIN'), { target: { value: '12345678901' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: '12345678901' } });
  fireEvent.click(screen.getByLabelText('Save PIN'));
  expect(await screen.findByText(/PIN must be 4 to 10 digits/i)).toBeInTheDocument();
  expect(window.callBare).not.toHaveBeenCalledWith('pin:set', expect.anything());
});

test('accepts a PIN longer than 4 digits', async () => {
  render(<Settings />);
  fireEvent.change(screen.getByLabelText('New PIN'), { target: { value: '839201' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: '839201' } });
  fireEvent.click(screen.getByLabelText('Save PIN'));
  await waitFor(() => expect(window.callBare).toHaveBeenCalledWith('pin:set', { pin: '839201' }));
});

test('shows error when PIN contains non-digits', async () => {
  render(<Settings />);
  fireEvent.change(screen.getByLabelText('New PIN'), { target: { value: 'abcd' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: 'abcd' } });
  fireEvent.click(screen.getByLabelText('Save PIN'));
  expect(await screen.findByText(/only digits/i)).toBeInTheDocument();
});

test('calls pin:set when PIN is valid and PINs match', async () => {
  render(<Settings />);
  fireEvent.change(screen.getByLabelText('New PIN'), { target: { value: '4321' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: '4321' } });
  fireEvent.click(screen.getByLabelText('Save PIN'));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('pin:set', { pin: '4321' });
  });
});

test('shows success message after PIN is saved', async () => {
  render(<Settings />);
  fireEvent.change(screen.getByLabelText('New PIN'), { target: { value: '4321' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: '4321' } });
  fireEvent.click(screen.getByLabelText('Save PIN'));
  expect(await screen.findByText(/pin updated successfully/i)).toBeInTheDocument();
});

test('clears PIN fields after successful save', async () => {
  render(<Settings />);
  const newPin = screen.getByLabelText('New PIN');
  const confirmPin = screen.getByLabelText('Confirm PIN');
  fireEvent.change(newPin, { target: { value: '4321' } });
  fireEvent.change(confirmPin, { target: { value: '4321' } });
  fireEvent.click(screen.getByLabelText('Save PIN'));
  await waitFor(() => {
    expect(newPin.value).toBe('');
    expect(confirmPin.value).toBe('');
  });
});

test('shows error message when pin:set IPC call fails', async () => {
  window.callBare.mockRejectedValue(new Error('storage error'));
  render(<Settings />);
  fireEvent.change(screen.getByLabelText('New PIN'), { target: { value: '4321' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: '4321' } });
  fireEvent.click(screen.getByLabelText('Save PIN'));
  expect(await screen.findByText(/storage error/i)).toBeInTheDocument();
});

test('display name input onBlur calls identity:setName', async () => {
  render(<Settings />);
  const input = screen.getByLabelText('Parent Name');
  fireEvent.change(input, { target: { value: 'Mom' } });
  fireEvent.blur(input);
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('identity:setName', { name: 'Mom' });
  });
});

// ── Connection / blind relay ─────────────────────────────────────────────────
// The toggle is parent-only by design. There is deliberately no child-side switch:
// on a child device an "opt out of the relay" control is a bypass - it would let the
// child make itself unreachable to the parent on exactly the networks where the
// relay is the only thing keeping enforcement working.

const RELAY_LABEL = 'Use the relay when a direct connection fails';

function mockBare(overrides = {}) {
  window.callBare = jest.fn((method) => {
    if (method in overrides) return Promise.resolve(overrides[method]);
    if (method === 'relay:status') {
      return Promise.resolve({ enabled: true, configured: true, randomized: false, relaying: { attempts: 0, successes: 0, aborts: 0 } });
    }
    return Promise.resolve({});
  });
}

test('Connection section renders with the relay on by default', async () => {
  mockBare();
  render(<Settings />);
  const toggle = await screen.findByLabelText(RELAY_LABEL);
  expect(toggle).toHaveAttribute('aria-checked', 'true');
});

test('reflects a stored opt-out rather than always showing on', async () => {
  mockBare({ 'relay:status': { enabled: false, configured: true, randomized: false, relaying: { attempts: 0, successes: 0, aborts: 0 } } });
  render(<Settings />);
  const toggle = await screen.findByLabelText(RELAY_LABEL);
  expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('turning the relay off persists the pref', async () => {
  mockBare();
  render(<Settings />);
  fireEvent.click(await screen.findByLabelText(RELAY_LABEL));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('pref:set', { key: 'relay:enabled', value: false });
  });
});

test('turning it back on persists the pref too', async () => {
  mockBare({ 'relay:status': { enabled: false, configured: true, randomized: false, relaying: { attempts: 0, successes: 0, aborts: 0 } } });
  render(<Settings />);
  fireEvent.click(await screen.findByLabelText(RELAY_LABEL));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('pref:set', { key: 'relay:enabled', value: true });
  });
});

test('a failed write puts the switch back instead of lying about the state', async () => {
  window.callBare = jest.fn((method) => {
    if (method === 'relay:status') {
      return Promise.resolve({ enabled: true, configured: true, randomized: false, relaying: { attempts: 0, successes: 0, aborts: 0 } });
    }
    if (method === 'pref:set') return Promise.reject(new Error('disk full'));
    return Promise.resolve({});
  });
  render(<Settings />);
  const toggle = await screen.findByLabelText(RELAY_LABEL);
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'));
});

test('no Connection section on a worklet that has no relay', async () => {
  mockBare({ 'relay:status': null });
  render(<Settings />);
  // Wait for something that always renders, so we are asserting on a settled tree
  // rather than on one that simply has not got there yet.
  await screen.findByLabelText('Parent Name');
  expect(screen.queryByLabelText(RELAY_LABEL)).not.toBeInTheDocument();
});

test('surfaces the relay counters so an escalation is observable', async () => {
  mockBare({ 'relay:status': { enabled: true, configured: true, randomized: false, relaying: { attempts: 4, successes: 3, aborts: 1 } } });
  render(<Settings />);
  expect(await screen.findByText('4')).toBeInTheDocument();
  expect(await screen.findByText('3')).toBeInTheDocument();
});

const AUTO_APPROVE_LABEL = 'Allow new apps automatically';

test('New App Installs toggle is off by default and describes the approval behaviour', async () => {
  mockBare({ 'settings:get': { timeRequestMinutes: [5, 10], warningMinutes: [5] } });
  render(<Settings />);
  const toggle = await screen.findByLabelText(AUTO_APPROVE_LABEL);
  expect(toggle).toHaveAttribute('aria-checked', 'false');
  expect(screen.getByText(/blocked until you approve them/i)).toBeInTheDocument();
});

test('New App Installs toggle reflects a stored on setting', async () => {
  mockBare({ 'settings:get': { timeRequestMinutes: [5], warningMinutes: [5], autoApproveNewApps: true } });
  render(<Settings />);
  const toggle = await screen.findByLabelText(AUTO_APPROVE_LABEL);
  expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(screen.getByText(/allowed right away/i)).toBeInTheDocument();
});

test('flipping the toggle saves immediately and keeps the other settings', async () => {
  mockBare({ 'settings:get': { timeRequestMinutes: [5, 10], warningMinutes: [1, 5] } });
  render(<Settings />);
  fireEvent.click(await screen.findByLabelText(AUTO_APPROVE_LABEL));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('settings:save', {
      settings: { timeRequestMinutes: [5, 10], warningMinutes: [1, 5], autoApproveNewApps: true },
    });
  });
  expect(screen.getByLabelText(AUTO_APPROVE_LABEL)).toHaveAttribute('aria-checked', 'true');
});

test('a failed save puts the toggle back and says so', async () => {
  window.callBare = jest.fn((method) => {
    if (method === 'settings:get') return Promise.resolve({ timeRequestMinutes: [5], warningMinutes: [5] });
    if (method === 'settings:save') return Promise.reject(new Error('nope'));
    if (method === 'relay:status') return Promise.resolve({ enabled: true, configured: true, randomized: false, relaying: { attempts: 0, successes: 0, aborts: 0 } });
    return Promise.resolve({});
  });
  render(<Settings />);
  fireEvent.click(await screen.findByLabelText(AUTO_APPROVE_LABEL));
  expect(await screen.findByRole('alert')).toHaveTextContent(/failed to save/i);
  expect(screen.getByLabelText(AUTO_APPROVE_LABEL)).toHaveAttribute('aria-checked', 'false');
});

// ── Auto-saving settings ─────────────────────────────────────────────────────
// These two settings used to sit behind a "Save Settings" button that looked global
// but persisted only them. A parent who changed a chip and never scrolled to the
// bottom lost the change. They now save on change, debounced, so a burst of taps is
// one sync rather than one per tap.
//
// Chip labels are picked to be unambiguous: the time-request chips run through
// formatMinutes (60 renders as "1 hour"), and both selectors share the "N min" shape
// for 5/10/15/20/30, so those labels match two elements at once.

function mockLoadedSettings(settings = { timeRequestMinutes: [15, 30], warningMinutes: [5, 10] }) {
  window.callBare = jest.fn((method) => {
    if (method === 'settings:get') return Promise.resolve(settings);
    if (method === 'relay:status') {
      return Promise.resolve({ enabled: true, configured: true, randomized: false, relaying: { attempts: 0, successes: 0, aborts: 0 } });
    }
    return Promise.resolve({});
  });
}

const savesOf = () => window.callBare.mock.calls.filter(([m]) => m === 'settings:save');

test('there is no global Save Settings button any more', async () => {
  mockLoadedSettings();
  render(<Settings />);
  await screen.findByLabelText('Parent Name');
  expect(screen.queryByText('Save Settings')).not.toBeInTheDocument();
});

test('changing a time-request option saves without any button press', async () => {
  mockLoadedSettings();
  render(<Settings />);
  fireEvent.click(await screen.findByText('1 hour'));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('settings:save', {
      settings: { timeRequestMinutes: [15, 30, 60], warningMinutes: [5, 10], autoApproveNewApps: false },
    });
  });
});

test('changing a warning threshold saves on its own too', async () => {
  mockLoadedSettings();
  render(<Settings />);
  fireEvent.click(await screen.findByText('2 min'));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('settings:save', {
      settings: { timeRequestMinutes: [15, 30], warningMinutes: [2, 5, 10], autoApproveNewApps: false },
    });
  });
});

test('a burst of taps collapses into a single sync', async () => {
  mockLoadedSettings();
  render(<Settings />);
  fireEvent.click(await screen.findByText('1 hour'));
  fireEvent.click(screen.getByText('1h 30m'));
  fireEvent.click(screen.getByText('4 hours'));
  await waitFor(() => expect(savesOf()).toHaveLength(1));
  // settings:save rewrites and re-pushes every child's policy, so the debounce is
  // protecting the worklet, not just tidying up the call log.
  expect(savesOf()[0][1].settings.timeRequestMinutes).toEqual([15, 30, 60, 90, 240]);
});

test('confirms the save reached the children', async () => {
  mockLoadedSettings();
  render(<Settings />);
  fireEvent.click(await screen.findByText('1 hour'));
  expect(await screen.findByText(/saved and synced to your children/i)).toBeInTheDocument();
});

test('deselecting the last option is refused rather than silently stored', async () => {
  mockLoadedSettings({ timeRequestMinutes: [45], warningMinutes: [5, 10] });
  render(<Settings />);
  fireEvent.click(await screen.findByText('45 min'));
  expect(await screen.findByText(/keep at least one option selected/i)).toBeInTheDocument();
  // The chip must stay selected: showing an empty selector while storage still holds
  // the old value would put the screen and the truth out of step.
  await waitFor(() => expect(savesOf()).toHaveLength(0));
});

test('a pending save is flushed on unmount instead of being dropped', async () => {
  mockLoadedSettings();
  const { unmount } = render(<Settings />);
  fireEvent.click(await screen.findByText('1 hour'));
  // Leave the tab before the debounce fires. The old button had exactly this
  // failure, and re-creating it in a new shape would be no improvement.
  unmount();
  expect(savesOf()).toHaveLength(1);
  expect(savesOf()[0][1].settings.timeRequestMinutes).toEqual([15, 30, 60]);
});

test('a failed save says the children still have the old setting', async () => {
  window.callBare = jest.fn((method) => {
    if (method === 'settings:get') return Promise.resolve({ timeRequestMinutes: [15], warningMinutes: [5] });
    if (method === 'relay:status') return Promise.resolve(null);
    if (method === 'settings:save') return Promise.reject(new Error('offline'));
    return Promise.resolve({});
  });
  render(<Settings />);
  fireEvent.click(await screen.findByText('1 hour'));
  expect(await screen.findByText(/still have the previous setting/i)).toBeInTheDocument();
});

test('a chip save keeps the auto-approve setting instead of wiping it', async () => {
  mockLoadedSettings({ timeRequestMinutes: [15, 30], warningMinutes: [5, 10], autoApproveNewApps: true })
  render(<Settings />)
  fireEvent.click(await screen.findByText('1 hour'))
  await waitFor(() => expect(savesOf()).toHaveLength(1))
  expect(savesOf()[0][1].settings.autoApproveNewApps).toBe(true)
})

test('flipping the toggle while a chip save is pending is not undone by it', async () => {
  mockLoadedSettings()
  render(<Settings />)
  fireEvent.click(await screen.findByText('1 hour'))
  // The chip save is still waiting out its debounce when the toggle saves.
  fireEvent.click(screen.getByLabelText('Allow new apps automatically'))
  await waitFor(() => expect(savesOf()).toHaveLength(2))
  const last = savesOf()[1][1].settings
  expect(last).toEqual({ timeRequestMinutes: [15, 30, 60], warningMinutes: [5, 10], autoApproveNewApps: true })
})
