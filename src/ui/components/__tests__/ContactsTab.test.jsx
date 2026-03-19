import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ContactsTab from '../ContactsTab.jsx';

const MOCK_POLICY = {
  version: 1,
  childPublicKey: 'pk1',
  apps: {},
  schedules: [],
  allowedContacts: [
    { name: 'Mom', phone: '+15551234567' },
    { name: 'Dad', phone: '+15559876543' },
  ],
};

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue(MOCK_POLICY);
});

test('renders contact list', async () => {
  render(<ContactsTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText('Mom')).toBeInTheDocument();
    expect(screen.getByText('Dad')).toBeInTheDocument();
    expect(screen.getByText('+15551234567')).toBeInTheDocument();
  });
});

test('remove contact calls policy:update without that contact', async () => {
  render(<ContactsTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Remove Mom'));
  fireEvent.click(screen.getByLabelText('Remove Mom'));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith(
      'policy:update',
      expect.objectContaining({
        policy: expect.objectContaining({
          allowedContacts: [{ name: 'Dad', phone: '+15559876543' }],
        }),
      })
    );
  });
});

test('add contact calls contacts:pick then policy:update', async () => {
  window.callBare = jest.fn()
    .mockResolvedValueOnce(MOCK_POLICY) // initial policy:get
    .mockResolvedValueOnce({ name: 'Grandma', phone: '+15550001111' }); // contacts:pick

  render(<ContactsTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Add contact'));
  fireEvent.click(screen.getByLabelText('Add contact'));

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('contacts:pick');
    expect(window.callBare).toHaveBeenCalledWith(
      'policy:update',
      expect.objectContaining({
        policy: expect.objectContaining({
          allowedContacts: expect.arrayContaining([
            expect.objectContaining({ name: 'Grandma' }),
          ]),
        }),
      })
    );
  });
});

test('shows empty message when no contacts', async () => {
  window.callBare.mockResolvedValue({ ...MOCK_POLICY, allowedContacts: [] });
  render(<ContactsTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText(/no contacts added/i)).toBeInTheDocument();
  });
});

test('handles contacts:pick cancellation gracefully', async () => {
  window.callBare = jest.fn()
    .mockResolvedValueOnce(MOCK_POLICY)
    .mockRejectedValueOnce(new Error('cancelled'));

  render(<ContactsTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Add contact'));
  fireEvent.click(screen.getByLabelText('Add contact'));

  // Should not throw and button should return to normal
  await waitFor(() => {
    expect(screen.getByLabelText('Add contact')).not.toBeDisabled();
  });
});
