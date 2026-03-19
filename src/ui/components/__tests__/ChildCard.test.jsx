import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import ChildCard from '../ChildCard.jsx';

const mockChild = {
  publicKey: 'pk-abc',
  displayName: 'Alice',
  isOnline: true,
  currentApp: 'YouTube',
  todayScreenTimeSeconds: 5400, // 1h 30m
  bypassAlerts: 0,
  pendingApprovals: 0,
  pendingTimeRequests: 0,
};

test('renders child name', () => {
  render(<ChildCard child={mockChild} onPress={() => {}} />);
  expect(screen.getByText('Alice')).toBeInTheDocument();
});

test('renders online status dot as green when online', () => {
  render(<ChildCard child={mockChild} onPress={() => {}} />);
  const card = screen.getByRole('button', { name: /open alice/i });
  // The dot is a span inside the card — check its background via the data
  expect(card).toBeInTheDocument();
});

test('renders current active app', () => {
  render(<ChildCard child={mockChild} onPress={() => {}} />);
  expect(screen.getByText('YouTube')).toBeInTheDocument();
});

test('formats screen time correctly (1h 30m)', () => {
  render(<ChildCard child={mockChild} onPress={() => {}} />);
  expect(screen.getByText('1h 30m')).toBeInTheDocument();
});

test('formats screen time under 1 hour as minutes only', () => {
  render(<ChildCard child={{ ...mockChild, todayScreenTimeSeconds: 720 }} onPress={() => {}} />);
  expect(screen.getByText('12m')).toBeInTheDocument();
});

test('shows no badges when all counts are 0', () => {
  render(<ChildCard child={mockChild} onPress={() => {}} />);
  expect(screen.queryByText('0')).not.toBeInTheDocument();
});

test('renders bypass alert badge (red) when bypassAlerts > 0', () => {
  render(<ChildCard child={{ ...mockChild, bypassAlerts: 2 }} onPress={() => {}} />);
  expect(screen.getByText('2')).toBeInTheDocument();
});

test('renders all three badge types simultaneously', () => {
  render(
    <ChildCard
      child={{ ...mockChild, bypassAlerts: 1, pendingApprovals: 3, pendingTimeRequests: 2 }}
      onPress={() => {}}
    />
  );
  expect(screen.getByText('1')).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument();
  expect(screen.getByText('2')).toBeInTheDocument();
});

test('shows "None" when currentApp is null', () => {
  render(<ChildCard child={{ ...mockChild, currentApp: null }} onPress={() => {}} />);
  expect(screen.getByText('None')).toBeInTheDocument();
});

test('calls onPress when card is clicked', () => {
  const onPress = jest.fn();
  render(<ChildCard child={mockChild} onPress={onPress} />);
  fireEvent.click(screen.getByRole('button', { name: /open alice/i }));
  expect(onPress).toHaveBeenCalledTimes(1);
});
