import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import App from '../App.jsx';

// Mock ParentApp so it renders something recognizable without needing the full component tree
jest.mock('../components/ParentApp.jsx', () => () => <div>Dashboard</div>);

beforeEach(() => {
  window.callBare = jest.fn();
});

test('renders Loading... while waiting for identity:getMode', () => {
  window.callBare.mockReturnValue(new Promise(() => {})); // never resolves
  render(<App />);
  expect(screen.getByText('Loading...')).toBeInTheDocument();
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
    expect(screen.getByText(/welcome to pearguard/i)).toBeInTheDocument();
  });
});

test('renders setup screen when callBare rejects', async () => {
  window.callBare.mockRejectedValue(new Error('not ready'));
  render(<App />);
  await waitFor(() => {
    expect(screen.getByText(/welcome to pearguard/i)).toBeInTheDocument();
  });
});
