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
  expect(screen.getByLabelText('Display name')).toBeInTheDocument();
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
  expect(await screen.findByText(/exactly 4 digits/i)).toBeInTheDocument();
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
  const input = screen.getByLabelText('Display name');
  fireEvent.change(input, { target: { value: 'Mom' } });
  fireEvent.blur(input);
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('identity:setName', { name: 'Mom' });
  });
});
