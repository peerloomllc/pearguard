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
