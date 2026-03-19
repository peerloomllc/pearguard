import React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import ChildHome from '../ChildHome.jsx'

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue({ policy: null })
})

test('renders "Loading..." initially (before callBare resolves)', () => {
  render(<ChildHome />)
  expect(screen.getByText('Loading...')).toBeInTheDocument()
})

test('after callBare resolves with { policy: null }, shows "All good"', async () => {
  render(<ChildHome />)
  await waitFor(() => {
    expect(screen.getByText('All good')).toBeInTheDocument()
  })
})

test('after callBare resolves with a policy, shows "All good"', async () => {
  window.callBare.mockResolvedValue({ policy: { rules: [] } })
  render(<ChildHome />)
  await waitFor(() => {
    expect(screen.getByText('All good')).toBeInTheDocument()
  })
})

test('dispatch __pearEvent with name "enforcement:offline" → shows "Enforcement offline" with red background', async () => {
  render(<ChildHome />)
  await waitFor(() => {
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  act(() => {
    const event = new CustomEvent('__pearEvent', {
      detail: { name: 'enforcement:offline', data: {} },
    })
    window.dispatchEvent(event)
  })

  await waitFor(() => {
    expect(screen.getByText('Enforcement offline')).toBeInTheDocument()
  })

  const heading = screen.getByText('Enforcement offline')
  const container = heading.closest('div')
  expect(container).toHaveStyle({ backgroundColor: '#FFEDED', borderColor: '#FF4444' })
})

test('dispatch __pearEvent with name "enforcement:status" and scheduleActive:true → shows "Bedtime mode" with label', async () => {
  render(<ChildHome />)
  await waitFor(() => {
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  act(() => {
    const event = new CustomEvent('__pearEvent', {
      detail: {
        name: 'enforcement:status',
        data: { scheduleActive: true, scheduleLabel: 'Bedtime' },
      },
    })
    window.dispatchEvent(event)
  })

  await waitFor(() => {
    expect(screen.getByText('Bedtime mode')).toBeInTheDocument()
    expect(screen.getByText('Bedtime')).toBeInTheDocument()
  })
})

test('dispatch __pearEvent with name "policy:updated" → resets to "All good"', async () => {
  render(<ChildHome />)
  await waitFor(() => {
    expect(screen.getByText('All good')).toBeInTheDocument()
  })

  act(() => {
    const event = new CustomEvent('__pearEvent', {
      detail: { name: 'enforcement:offline', data: {} },
    })
    window.dispatchEvent(event)
  })

  await waitFor(() => {
    expect(screen.getByText('Enforcement offline')).toBeInTheDocument()
  })

  act(() => {
    const event = new CustomEvent('__pearEvent', {
      detail: { name: 'policy:updated', data: {} },
    })
    window.dispatchEvent(event)
  })

  await waitFor(() => {
    expect(screen.getByText('All good')).toBeInTheDocument()
  })
})
