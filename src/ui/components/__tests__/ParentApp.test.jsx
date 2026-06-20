import React from 'react';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import ParentApp from '../ParentApp.jsx';

beforeEach(() => {
  window.callBare = jest.fn().mockImplementation((method) => {
    if (method === 'pin:isSet') return Promise.resolve({ isSet: true });
    return Promise.resolve({});
  });
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

// Stub child panels to avoid cascading IPC calls in this unit test
jest.mock('../Dashboard.jsx', () => () => <div>Dashboard panel</div>);
jest.mock('../Settings.jsx', () => () => <div>Settings panel</div>);

test('renders all three tab buttons', async () => {
  render(<ParentApp />);
  expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  expect(screen.getByText('Settings')).toBeInTheDocument();
  expect(screen.getByText('About')).toBeInTheDocument();
});

test('Dashboard panel is shown by default', async () => {
  render(<ParentApp />);
  expect(await screen.findByText('Dashboard panel')).toBeInTheDocument();
});

test('clicking Settings tab shows Settings panel', async () => {
  render(<ParentApp />);
  await screen.findByText('Dashboard panel');
  fireEvent.click(screen.getByText('Settings'));
  expect(screen.getByText('Settings panel')).toBeInTheDocument();
});

test('shows pairing banner when child:connected fires', async () => {
  let connectedHandler;
  window.onBareEvent = jest.fn((event, handler) => {
    if (event === 'child:connected') connectedHandler = handler;
    return () => {};
  });
  render(<ParentApp />);
  await screen.findByText('Dashboard panel');
  expect(screen.queryByText(/successfully paired/i)).not.toBeInTheDocument();
  act(() => connectedHandler({ displayName: 'Alice' }));
  expect(screen.getByText(/successfully paired with alice/i)).toBeInTheDocument();
});

test('does not subscribe to child:reconnected (banner is first-pairing only)', async () => {
  const subscribedEvents = [];
  window.onBareEvent = jest.fn((event) => {
    subscribedEvents.push(event);
    return () => {};
  });
  render(<ParentApp />);
  await screen.findByText('Dashboard panel');
  expect(subscribedEvents).not.toContain('child:reconnected');
});

test('active tab label is highlighted with the primary color', async () => {
  const PRIMARY = 'rgb(76, 175, 80)'; // #4CAF50
  render(<ParentApp />);
  const dashLabel = await screen.findByText('Dashboard');
  const settingsLabel = screen.getByText('Settings');

  // Dashboard is the default active tab.
  expect(dashLabel).toHaveStyle({ color: PRIMARY });
  expect(settingsLabel).not.toHaveStyle({ color: PRIMARY });

  fireEvent.click(settingsLabel);

  // Active highlight moves to Settings.
  expect(screen.getByText('Settings')).toHaveStyle({ color: PRIMARY });
  expect(screen.getByText('Dashboard')).not.toHaveStyle({ color: PRIMARY });
});

test('shows PIN setup overlay when pin:isSet returns false', async () => {
  window.callBare = jest.fn().mockImplementation((method) => {
    if (method === 'pin:isSet') return Promise.resolve({ isSet: false });
    return Promise.resolve({});
  });
  render(<ParentApp />);
  await waitFor(() => {
    expect(screen.getByLabelText('Set PIN')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm PIN')).toBeInTheDocument();
  });
  expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
});

test('dismisses PIN overlay and shows dashboard after pin:set succeeds', async () => {
  window.callBare = jest.fn().mockImplementation((method) => {
    if (method === 'pin:isSet') return Promise.resolve({ isSet: false });
    return Promise.resolve({});
  });
  render(<ParentApp />);
  await waitFor(() => screen.getByLabelText('Set PIN'));

  fireEvent.change(screen.getByLabelText('Set PIN'), { target: { value: '1234' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: /save pin/i }));

  await waitFor(() => {
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });
});
