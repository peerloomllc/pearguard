import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import AppWindowModal, { summarizeWindow, fmt12 } from '../components/AppWindowModal.jsx';

beforeEach(() => { window.callBare = jest.fn(); });

describe('summarizeWindow / fmt12', () => {
  test('fmt12 converts 24h to 12h', () => {
    expect(fmt12('16:00')).toBe('4:00 PM');
    expect(fmt12('08:05')).toBe('8:05 AM');
    expect(fmt12('00:30')).toBe('12:30 AM');
    expect(fmt12('12:00')).toBe('12:00 PM');
  });

  test('summarizeWindow labels allow vs block', () => {
    expect(summarizeWindow({ mode: 'allow', days: [1], start: '16:00', end: '18:00' })).toBe('Only 4:00 PM-6:00 PM');
    expect(summarizeWindow({ mode: 'block', days: [1], start: '08:00', end: '15:00' })).toBe('Blocked 8:00 AM-3:00 PM');
    expect(summarizeWindow(null)).toBeNull();
    expect(summarizeWindow({ mode: 'allow', days: [] })).toBeNull();
  });
});

describe('AppWindowModal', () => {
  test('composes an allow-only window and saves it', () => {
    const onSave = jest.fn();
    render(<AppWindowModal appName="Games" window={null} visible={true} onClose={() => {}} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: 'Allowed only' }));
    // Default days are weekdays; set 4pm-6pm.
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '16:00' } });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '18:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(onSave).toHaveBeenCalledWith({ mode: 'allow', days: [1, 2, 3, 4, 5], start: '16:00', end: '18:00' });
  });

  test('rejects an empty day selection', () => {
    const onSave = jest.fn();
    render(<AppWindowModal appName="Social" window={null} visible={true} onClose={() => {}} onSave={onSave} />);
    // Clear all default weekdays.
    for (const label of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) fireEvent.click(screen.getByRole('button', { name: label }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/Pick at least one day/i)).toBeInTheDocument();
  });

  test('Remove clears the window (saves null)', () => {
    const onSave = jest.fn();
    render(<AppWindowModal appName="Games" window={{ mode: 'block', days: [1], start: '08:00', end: '15:00' }} visible={true} onClose={() => {}} onSave={onSave} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onSave).toHaveBeenCalledWith(null);
  });

  test('rejects identical start and end', () => {
    const onSave = jest.fn();
    render(<AppWindowModal appName="Games" window={null} visible={true} onClose={() => {}} onSave={onSave} />);
    fireEvent.change(screen.getByLabelText('Start time'), { target: { value: '09:00' } });
    fireEvent.change(screen.getByLabelText('End time'), { target: { value: '09:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText(/can't be the same/i)).toBeInTheDocument();
  });
});
