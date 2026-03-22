import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ParentApp from '../ParentApp.jsx';

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue({});
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

// Stub child panels to avoid cascading IPC calls in this unit test
jest.mock('../Dashboard.jsx', () => () => <div>Dashboard panel</div>);
jest.mock('../ChildrenList.jsx', () => () => <div>Children panel</div>);
jest.mock('../Settings.jsx', () => () => <div>Settings panel</div>);

test('renders all three tab buttons', () => {
  render(<ParentApp />);
  expect(screen.getByText('Dashboard')).toBeInTheDocument();
  expect(screen.getByText('Children')).toBeInTheDocument();
  expect(screen.getByText('Settings')).toBeInTheDocument();
});

test('Dashboard panel is shown by default', () => {
  render(<ParentApp />);
  expect(screen.getByText('Dashboard panel')).toBeInTheDocument();
});

test('clicking Children tab shows Children panel', () => {
  render(<ParentApp />);
  fireEvent.click(screen.getByText('Children'));
  expect(screen.getByText('Children panel')).toBeInTheDocument();
});

test('clicking Settings tab shows Settings panel', () => {
  render(<ParentApp />);
  fireEvent.click(screen.getByText('Settings'));
  expect(screen.getByText('Settings panel')).toBeInTheDocument();
});

test('active tab has aria-selected=true', () => {
  render(<ParentApp />);
  const dashTab = screen.getByRole('tab', { name: 'Dashboard' });
  expect(dashTab).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByText('Children'));
  expect(screen.getByRole('tab', { name: 'Children' })).toHaveAttribute('aria-selected', 'true');
  expect(dashTab).toHaveAttribute('aria-selected', 'false');
});
