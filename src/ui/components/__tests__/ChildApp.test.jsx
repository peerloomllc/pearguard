import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import ChildApp from '../ChildApp'

jest.mock('../ChildHome', () => () => <div>ChildHome</div>)
jest.mock('../ChildRequests', () => () => <div>ChildRequests</div>)

beforeEach(() => {
  window.onBareEvent = jest.fn().mockReturnValue(() => {})
})

describe('ChildApp', () => {
  it('renders Home and Requests tab buttons', () => {
    render(<ChildApp />)
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Requests')).toBeInTheDocument()
  })

  it('renders ChildHome by default (initial tab is home)', () => {
    render(<ChildApp />)
    expect(screen.getByText('ChildHome')).toBeInTheDocument()
  })

  it('renders ChildRequests when Requests tab is clicked', () => {
    render(<ChildApp />)

    const requestsTab = screen.getByText('Requests')
    fireEvent.click(requestsTab)

    expect(screen.getByText('ChildRequests')).toBeInTheDocument()
  })

  it('renders ChildHome again when Home tab is clicked after switching', () => {
    render(<ChildApp />)

    const requestsTab = screen.getByText('Requests')
    fireEvent.click(requestsTab)
    expect(screen.getByText('ChildRequests')).toBeInTheDocument()

    const homeTab = screen.getByText('Home')
    fireEvent.click(homeTab)
    expect(screen.getByText('ChildHome')).toBeInTheDocument()
  })

  it('active tab has bold fontWeight and different background', () => {
    render(<ChildApp />)

    const homeTab = screen.getByText('Home')
    const requestsTab = screen.getByText('Requests')

    // Home tab should be active initially
    expect(homeTab).toHaveStyle({
      backgroundColor: '#F0F0F0',
      fontWeight: 'bold',
    })
    expect(requestsTab).toHaveStyle({
      backgroundColor: '#FFF',
      fontWeight: 'normal',
    })

    // Click Requests tab
    fireEvent.click(requestsTab)

    // Requests tab should now be active
    expect(requestsTab).toHaveStyle({
      backgroundColor: '#F0F0F0',
      fontWeight: 'bold',
    })
  })
})
