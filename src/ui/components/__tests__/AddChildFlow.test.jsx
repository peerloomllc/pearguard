import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import AddChildFlow from '../AddChildFlow.jsx';

const MOCK_INVITE = {
  inviteString: 'pear-invite-abc123',
  qrData: 'QR_ENCODED_DATA_PLACEHOLDER',
};

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue(MOCK_INVITE);
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

test('renders "Generating invite..." while loading', () => {
  window.callBare = jest.fn().mockReturnValue(new Promise(() => {}));
  render(<AddChildFlow onConnected={() => {}} onCancel={() => {}} />);
  expect(screen.getByText(/generating invite/i)).toBeInTheDocument();
});

test('renders QR placeholder and invite link after invite loads', async () => {
  render(<AddChildFlow onConnected={() => {}} onCancel={() => {}} />);
  await waitFor(() => {
    expect(screen.getByLabelText(/qr code placeholder/i)).toBeInTheDocument();
    expect(screen.getByTestId('invite-link')).toBeInTheDocument();
  });
});

test('invite link contains encoded invite string', async () => {
  render(<AddChildFlow onConnected={() => {}} onCancel={() => {}} />);
  await waitFor(() => {
    const link = screen.getByTestId('invite-link');
    expect(link.textContent).toContain('pear-invite-abc123');
  });
});

test('shows waiting message', async () => {
  render(<AddChildFlow onConnected={() => {}} onCancel={() => {}} />);
  await waitFor(() => {
    expect(screen.getByText(/waiting for child to connect/i)).toBeInTheDocument();
  });
});

test('calls onConnected when child:connected event fires', async () => {
  let connectedHandler;
  window.onBareEvent = jest.fn((event, handler) => {
    if (event === 'child:connected') connectedHandler = handler;
    return () => {};
  });

  const onConnected = jest.fn();
  render(<AddChildFlow onConnected={onConnected} onCancel={() => {}} />);
  await waitFor(() => screen.getByTestId('invite-link'));

  act(() => connectedHandler({ publicKey: 'pk-child', displayName: 'Alice' }));
  expect(onConnected).toHaveBeenCalledWith({ publicKey: 'pk-child', displayName: 'Alice' });
});

test('shows error message when invite:generate fails', async () => {
  window.callBare = jest.fn().mockRejectedValue(new Error('network'));
  render(<AddChildFlow onConnected={() => {}} onCancel={() => {}} />);
  await waitFor(() => {
    expect(screen.getByText(/failed to generate invite/i)).toBeInTheDocument();
  });
});
