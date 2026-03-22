import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ChildDetail from '../ChildDetail.jsx';

// Mock all child-specific tabs
jest.mock('../UsageTab.jsx', () => ({ childPublicKey }) => <div>Usage content {childPublicKey}</div>);
jest.mock('../AppsTab.jsx', () => ({ childPublicKey }) => <div>Apps content</div>);
jest.mock('../RequestsTab.jsx', () => ({ childPublicKey }) => <div>Requests content</div>);
jest.mock('../ScheduleTab.jsx', () => ({ childPublicKey }) => <div>Schedule content</div>);
jest.mock('../ContactsTab.jsx', () => ({ childPublicKey }) => <div>Contacts content</div>);
jest.mock('../AlertsTab.jsx', () => ({ childPublicKey }) => <div>Activity content</div>);

const MOCK_CHILD = { publicKey: 'pk-alice', displayName: 'Alice' };

test('renders child display name in header', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  expect(screen.getByText('Alice')).toBeInTheDocument();
});

test('renders all six tab buttons', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  ['Usage', 'Apps', 'Requests', 'Schedule', 'Contacts', 'Activity'].forEach((label) => {
    expect(screen.getByRole('tab', { name: label })).toBeInTheDocument();
  });
});

test('Usage tab is active by default and passes childPublicKey', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  expect(screen.getByText('Usage content pk-alice')).toBeInTheDocument();
});

test('clicking Apps tab shows Apps content', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Apps' }));
  expect(screen.getByText('Apps content')).toBeInTheDocument();
});

test('clicking Requests tab shows Requests content', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Requests' }));
  expect(screen.getByText('Requests content')).toBeInTheDocument();
});

test('clicking Activity tab shows Activity content', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  fireEvent.click(screen.getByRole('tab', { name: 'Activity' }));
  expect(screen.getByText('Activity content')).toBeInTheDocument();
});

test('back button calls onBack', () => {
  const onBack = jest.fn();
  render(<ChildDetail child={MOCK_CHILD} onBack={onBack} />);
  fireEvent.click(screen.getByLabelText('Back to Dashboard'));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('active tab has aria-selected=true', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  expect(screen.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true');
  fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
  expect(screen.getByRole('tab', { name: 'Schedule' })).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'false');
});
