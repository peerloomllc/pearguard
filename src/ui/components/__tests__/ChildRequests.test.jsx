import React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import ChildRequests from '../ChildRequests.jsx'

// Capture onBareEvent handlers so tests can fire them
const bareEventHandlers = {}
beforeEach(() => {
  window.callBare = jest.fn()
  window.onBareEvent = jest.fn((eventName, handler) => {
    bareEventHandlers[eventName] = handler
    return () => { delete bareEventHandlers[eventName] }
  })
})

function fireBareEvent(name, data) {
  if (bareEventHandlers[name]) bareEventHandlers[name](data)
}

test('shows "Loading..." while requests:list is loading', () => {
  // Don't resolve the promise yet
  window.callBare.mockImplementation(() => new Promise(() => {}))
  render(<ChildRequests />)
  expect(screen.getByText('Loading...')).toBeInTheDocument()
})

test('shows "No requests yet." when list is empty', async () => {
  window.callBare.mockResolvedValue({ requests: [] })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('No requests yet.')).toBeInTheDocument()
  })
})

test('shows "Pending..." badge for pending requests', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.pending', requestedAt: Date.now(), status: 'pending' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('Pending...')).toBeInTheDocument()
  })
})

test('shows "Approved!" badge for approved requests', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:2', packageName: 'com.example.youtube', requestedAt: Date.now(), status: 'approved' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('Approved!')).toBeInTheDocument()
  })
})

test('shows "Denied" badge for denied requests', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:3', packageName: 'com.example.snapchat', requestedAt: Date.now(), status: 'denied' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('Denied')).toBeInTheDocument()
  })
})

test('shows all three status badges together', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.tiktok', requestedAt: Date.now(), status: 'pending' },
      { id: 'req:2', packageName: 'com.example.youtube', requestedAt: Date.now(), status: 'approved' },
      { id: 'req:3', packageName: 'com.example.snapchat', requestedAt: Date.now(), status: 'denied' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('Pending...')).toBeInTheDocument()
    expect(screen.getByText('Approved!')).toBeInTheDocument()
    expect(screen.getByText('Denied')).toBeInTheDocument()
  })
})

test('"New Request" button is disabled when no lastBlockedPackage (initial state)', async () => {
  window.callBare.mockResolvedValue({ requests: [] })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('No requests yet.')).toBeInTheDocument()
  })

  const button = screen.getByRole('button', { name: 'New Request' })
  expect(button).toBeDisabled()
})

test('after block:occurred event, "New Request" button is enabled', async () => {
  window.callBare.mockResolvedValue({ requests: [] })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('No requests yet.')).toBeInTheDocument()
  })

  const button = screen.getByRole('button', { name: 'New Request' })
  expect(button).toBeDisabled()

  act(() => {
    fireBareEvent('block:occurred', { packageName: 'com.example.app' })
  })

  await waitFor(() => {
    expect(button).not.toBeDisabled()
  })
})

test('after block:occurred event, clicking "New Request" calls callBare with correct args', async () => {
  window.callBare.mockResolvedValue({ requests: [] })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('No requests yet.')).toBeInTheDocument()
  })

  act(() => {
    fireBareEvent('block:occurred', { packageName: 'com.example.testapp' })
  })

  const button = screen.getByRole('button', { name: 'New Request' })
  await waitFor(() => {
    expect(button).not.toBeDisabled()
  })

  // Reset mock to isolate the time:request call
  window.callBare.mockClear()
  window.callBare.mockResolvedValue({ requests: [] })

  act(() => {
    button.click()
  })

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('time:request', { packageName: 'com.example.testapp' })
  })
})

test('after request:submitted event, list re-fetches', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.app1', requestedAt: Date.now(), status: 'pending' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('com.example.app1')).toBeInTheDocument()
  })

  window.callBare.mockClear()
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.app1', requestedAt: Date.now(), status: 'pending' },
      { id: 'req:2', packageName: 'com.example.app2', requestedAt: Date.now(), status: 'pending' },
    ],
  })

  act(() => {
    fireBareEvent('request:submitted', {})
  })

  await waitFor(() => {
    expect(screen.getByText('com.example.app2')).toBeInTheDocument()
  })
})

test('after request:updated event, list re-fetches', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.app1', requestedAt: Date.now(), status: 'pending' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('Pending...')).toBeInTheDocument()
  })

  window.callBare.mockClear()
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.app1', requestedAt: Date.now(), status: 'approved' },
    ],
  })

  act(() => {
    fireBareEvent('request:updated', {})
  })

  await waitFor(() => {
    expect(screen.getByText('Approved!')).toBeInTheDocument()
  })
})

test('"Clear resolved" button is hidden when all requests are pending', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.app', requestedAt: Date.now(), status: 'pending' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('Pending...')).toBeInTheDocument()
  })
  expect(screen.queryByRole('button', { name: 'Clear resolved' })).not.toBeInTheDocument()
})

test('"Clear resolved" button appears when a resolved request exists and calls requests:clear', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.app', requestedAt: Date.now(), status: 'approved' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Clear resolved' })).toBeInTheDocument()
  })

  // After clicking, requests:clear is called followed by a reload
  window.callBare.mockClear()
  window.callBare.mockResolvedValue({ ok: true })
  const btn = screen.getByRole('button', { name: 'Clear resolved' })
  act(() => { btn.click() })

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('requests:clear')
  })
})

test('displays package names and formatted timestamps', async () => {
  const now = Date.now()
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.myapp', requestedAt: now, status: 'pending' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('com.example.myapp')).toBeInTheDocument()
  })
  // Verify timestamp is formatted
  const timestamp = new Date(now).toLocaleTimeString()
  expect(screen.getByText(timestamp)).toBeInTheDocument()
})
