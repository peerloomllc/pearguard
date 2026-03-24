import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ScheduleTab from '../ScheduleTab.jsx';

const MOCK_POLICY = {
  version: 1,
  childPublicKey: 'pk1',
  apps: {},
  schedules: [
    { label: 'Bedtime', days: [0, 1, 2, 3, 4, 5, 6], start: '21:00', end: '07:00' },
  ],
  allowedContacts: [],
};

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue(MOCK_POLICY);
});

test('renders existing schedule rules', async () => {
  render(<ScheduleTab childPublicKey="pk1" />);
  await waitFor(() => {
    expect(screen.getByText('Bedtime')).toBeInTheDocument();
    expect(screen.getByText(/21:00–07:00/)).toBeInTheDocument();
  });
});

test('delete rule calls policy:update without that rule', async () => {
  render(<ScheduleTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Delete rule Bedtime'));
  fireEvent.click(screen.getByLabelText('Delete rule Bedtime'));
  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith(
      'policy:update',
      expect.objectContaining({
        policy: expect.objectContaining({ schedules: [] }),
      })
    );
  });
});

test('add rule form updates list and calls policy:update', async () => {
  render(<ScheduleTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Rule label'));

  fireEvent.change(screen.getByLabelText('Rule label'), { target: { value: 'School Hours' } });
  fireEvent.click(screen.getByLabelText('Mon')); // select Monday
  fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '08:00' } });
  fireEvent.change(screen.getByLabelText('End time'), { target: { value: '15:00' } });
  fireEvent.click(screen.getByLabelText('Add schedule rule'));

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith(
      'policy:update',
      expect.objectContaining({
        policy: expect.objectContaining({
          schedules: expect.arrayContaining([
            expect.objectContaining({ label: 'School Hours', days: [1], start: '08:00', end: '15:00' }),
          ]),
        }),
      })
    );
  });
});

test('Add Rule button shows validation errors when label or days are missing', async () => {
  render(<ScheduleTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Add schedule rule'));

  // Button should be enabled (errors shown on tap, not via disabled)
  expect(screen.getByLabelText('Add schedule rule')).not.toBeDisabled();

  // Tap with empty label and no days — should show both error messages
  fireEvent.click(screen.getByLabelText('Add schedule rule'));
  expect(screen.getByText('Label is required')).toBeInTheDocument();
  expect(screen.getByText('Select at least one day')).toBeInTheDocument();
});

test('clears form after adding a rule', async () => {
  render(<ScheduleTab childPublicKey="pk1" />);
  await waitFor(() => screen.getByLabelText('Rule label'));

  fireEvent.change(screen.getByLabelText('Rule label'), { target: { value: 'Nap Time' } });
  fireEvent.click(screen.getByLabelText('Sat'));
  fireEvent.click(screen.getByLabelText('Add schedule rule'));

  await waitFor(() => {
    expect(screen.getByLabelText('Rule label').value).toBe('');
  });
});
