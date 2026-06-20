import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../App.jsx';

// Mock ParentApp and ChildApp so they render something recognizable without needing the full component tree
jest.mock('../components/ParentApp.jsx', () => () => <div>Dashboard</div>);
jest.mock('../components/ChildApp.jsx', () => () => <div>Child mode</div>);

beforeEach(() => {
  window.callBare = jest.fn();
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

test('renders setup placeholder (not Parent/Child) while waiting for identity:getMode', () => {
  window.callBare.mockReturnValue(new Promise(() => {})); // never resolves
  render(<App />);
  // Mode is still unresolved (null) so the setup placeholder is shown and
  // neither the parent nor child app is mounted prematurely.
  expect(screen.getByText(/waiting for setup/i)).toBeInTheDocument();
  expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  expect(screen.queryByText(/child mode/i)).not.toBeInTheDocument();
});

test('renders ParentApp when mode is parent', async () => {
  window.callBare.mockResolvedValue({ mode: 'parent' });
  render(<App />);
  await waitFor(() => {
    // ParentApp renders a tab bar — check for a known tab label
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });
});

test('renders ChildApp stub when mode is child', async () => {
  window.callBare.mockResolvedValue({ mode: 'child' });
  render(<App />);
  await waitFor(() => {
    expect(screen.getByText(/child mode/i)).toBeInTheDocument();
  });
});

test('renders setup screen when mode is null', async () => {
  window.callBare.mockResolvedValue({ mode: null });
  render(<App />);
  await waitFor(() => {
    expect(screen.getByText(/waiting for setup/i)).toBeInTheDocument();
  });
  expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  expect(screen.queryByText(/child mode/i)).not.toBeInTheDocument();
});

test('renders setup screen when callBare rejects', async () => {
  window.callBare.mockRejectedValue(new Error('not ready'));
  render(<App />);
  await waitFor(() => {
    expect(screen.getByText(/waiting for setup/i)).toBeInTheDocument();
  });
  expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  expect(screen.queryByText(/child mode/i)).not.toBeInTheDocument();
});
