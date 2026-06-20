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

test('prefers appName over packageName when displaying a request', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', appName: 'YouTube', packageName: 'com.example.youtube', requestedAt: Date.now(), status: 'pending' },
    ],
  })
  render(<ChildRequests />)
  await waitFor(() => {
    expect(screen.getByText('YouTube')).toBeInTheDocument()
  })
  expect(screen.queryByText('com.example.youtube')).not.toBeInTheDocument()
})

test('clicking "Clear resolved" fires a haptic:tap', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.app', requestedAt: Date.now(), status: 'approved' },
    ],
  })
  render(<ChildRequests />)
  const btn = await screen.findByRole('button', { name: 'Clear resolved' })

  window.callBare.mockClear()
  window.callBare.mockResolvedValue({ requests: [] })
  act(() => { btn.click() })

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('haptic:tap')
  })
})

test('"Clear resolved" button shows "Clearing..." and is disabled while clearing', async () => {
  window.callBare.mockResolvedValue({
    requests: [
      { id: 'req:1', packageName: 'com.example.app', requestedAt: Date.now(), status: 'approved' },
    ],
  })
  render(<ChildRequests />)
  const btn = await screen.findByRole('button', { name: 'Clear resolved' })

  // Make requests:clear hang so the clearing state stays visible
  let resolveClear
  window.callBare.mockImplementation((method) => {
    if (method === 'requests:clear') return new Promise((res) => { resolveClear = res })
    return Promise.resolve({ requests: [] })
  })

  act(() => { btn.click() })

  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Clearing...' })).toBeDisabled()
  })

  act(() => { resolveClear({ ok: true }) })
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
