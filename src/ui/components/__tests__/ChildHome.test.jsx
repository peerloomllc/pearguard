import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import ChildHome from '../ChildHome.jsx'

let bareEventHandlers
beforeEach(() => {
  bareEventHandlers = {}
  window.onBareEvent = jest.fn((event, handler) => {
    if (!bareEventHandlers[event]) bareEventHandlers[event] = []
    bareEventHandlers[event].push(handler)
    return () => {
      bareEventHandlers[event] = bareEventHandlers[event].filter((h) => h !== handler)
    }
  })
  window.callBare = jest.fn().mockResolvedValue({
    blockedCount: 0,
    pendingCount: 0,
    pendingRequests: 0,
    activeOverrides: [],
    hasPolicy: true,
    locked: false,
    parentName: null,
    childName: null,
  })
})

test('renders "Loading..." initially', () => {
  render(<ChildHome />)
  expect(screen.getByText('Loading...')).toBeInTheDocument()
})

test('shows greeting after data loads', async () => {
  window.callBare.mockResolvedValue({
    blockedCount: 2,
    pendingCount: 1,
    pendingRequests: 3,
    activeOverrides: [],
    hasPolicy: true,
    locked: false,
    parentName: null,
    childName: 'Alex',
  })
  render(<ChildHome />)
  await waitFor(() => {
    expect(screen.getByText('Hi, Alex')).toBeInTheDocument()
  })
  expect(screen.getByText('2')).toBeInTheDocument()
})

test('shows LockOverlay when locked', async () => {
  window.callBare.mockResolvedValue({
    blockedCount: 0,
    pendingCount: 0,
    pendingRequests: 0,
    activeOverrides: [],
    hasPolicy: true,
    locked: true,
    parentName: 'Mom',
    childName: 'Alex',
  })
  render(<ChildHome />)
  await waitFor(() => {
    expect(screen.getByText(/Device locked by Mom/)).toBeInTheDocument()
  })
})

test('subscribes to bare events', async () => {
  render(<ChildHome />)
  await waitFor(() => {
    expect(window.onBareEvent).toHaveBeenCalledWith('policy:updated', expect.any(Function))
    expect(window.onBareEvent).toHaveBeenCalledWith('override:granted', expect.any(Function))
    expect(window.onBareEvent).toHaveBeenCalledWith('request:updated', expect.any(Function))
    expect(window.onBareEvent).toHaveBeenCalledWith('request:submitted', expect.any(Function))
  })
})
