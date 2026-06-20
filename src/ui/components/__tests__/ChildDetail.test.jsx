import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ChildDetail from '../ChildDetail.jsx';

// Mock all child-specific tabs
jest.mock('../UsageTab.jsx', () => ({ childPublicKey }) => <div>Usage content {childPublicKey}</div>);
jest.mock('../AppsTab.jsx', () => ({ childPublicKey }) => <div>Apps content</div>);
jest.mock('../ActivityTab.jsx', () => ({ childPublicKey }) => <div>Activity content</div>);
jest.mock('../RulesTab.jsx', () => ({ childPublicKey }) => <div>Rules content</div>);
jest.mock('../AdvancedTab.jsx', () => ({ child }) => <div>Advanced content</div>);

const MOCK_CHILD = { publicKey: 'pk-alice', displayName: 'Alice' };

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue(undefined);
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});

// Tabs are plain <button>s whose accessible name is the label text.
function getTab(label) {
  return screen.getByRole('button', { name: new RegExp(`^${label}$`) });
}

test('renders child display name in header', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  expect(screen.getByText('Alice')).toBeInTheDocument();
});

test('renders all tab buttons', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  ['Usage', 'Apps', 'Activity', 'Rules', 'Advanced'].forEach((label) => {
    expect(getTab(label)).toBeInTheDocument();
  });
});

test('Usage tab is active by default and passes childPublicKey', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  expect(screen.getByText('Usage content pk-alice')).toBeInTheDocument();
});

test('clicking Apps tab shows Apps content', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  fireEvent.click(getTab('Apps'));
  expect(screen.getByText('Apps content')).toBeInTheDocument();
});

test('clicking Rules tab shows Rules content', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  fireEvent.click(getTab('Rules'));
  expect(screen.getByText('Rules content')).toBeInTheDocument();
});

test('clicking Activity tab shows Activity content', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  fireEvent.click(getTab('Activity'));
  expect(screen.getByText('Activity content')).toBeInTheDocument();
});

test('clicking Advanced tab shows Advanced content', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  fireEvent.click(getTab('Advanced'));
  expect(screen.getByText('Advanced content')).toBeInTheDocument();
});

test('back button calls onBack', () => {
  const onBack = jest.fn();
  render(<ChildDetail child={MOCK_CHILD} onBack={onBack} />);
  // The back button is the first button in the header (icon-only, before the lock button).
  const backButton = screen.getAllByRole('button')[0];
  fireEvent.click(backButton);
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('active tab is bold while others are not', () => {
  render(<ChildDetail child={MOCK_CHILD} onBack={() => {}} />);
  expect(getTab('Usage')).toHaveStyle({ fontWeight: '600' });
  expect(getTab('Rules')).toHaveStyle({ fontWeight: '400' });

  fireEvent.click(getTab('Rules'));
  expect(getTab('Rules')).toHaveStyle({ fontWeight: '600' });
  expect(getTab('Usage')).toHaveStyle({ fontWeight: '400' });
});
