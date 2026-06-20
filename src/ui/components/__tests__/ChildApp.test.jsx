import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import ChildApp from '../ChildApp'

jest.mock('../ChildHome', () => () => <div>ChildHome</div>)
jest.mock('../Profile', () => () => <div>ProfileScreen</div>)

const ACTIVE_COLOR = '#4CAF50' // colors.primary

beforeEach(() => {
  window.onBareEvent = jest.fn().mockReturnValue(() => {})
  // ChildApp reads onboarding prefs on mount; resolve them so no welcome card shows.
  window.callBare = jest.fn().mockResolvedValue(true)
})

describe('ChildApp', () => {
  it('renders Home and Profile tab buttons', () => {
    render(<ChildApp />)
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.getByText('Profile')).toBeInTheDocument()
  })

  it('renders ChildHome by default (initial tab is home)', () => {
    render(<ChildApp />)
    expect(screen.getByText('ChildHome')).toBeInTheDocument()
  })

  it('renders Profile when Profile tab is clicked', () => {
    render(<ChildApp />)

    const profileTab = screen.getByText('Profile')
    fireEvent.click(profileTab)

    expect(screen.getByText('ProfileScreen')).toBeInTheDocument()
  })

  it('renders ChildHome again when Home tab is clicked after switching', () => {
    render(<ChildApp />)

    const profileTab = screen.getByText('Profile')
    fireEvent.click(profileTab)
    expect(screen.getByText('ProfileScreen')).toBeInTheDocument()

    const homeTab = screen.getByText('Home')
    fireEvent.click(homeTab)
    expect(screen.getByText('ChildHome')).toBeInTheDocument()
  })

  it('active tab label is highlighted with the primary color', () => {
    render(<ChildApp />)

    const homeLabel = screen.getByText('Home')
    const profileLabel = screen.getByText('Profile')

    // Home tab should be active initially: its label uses the primary color.
    expect(homeLabel).toHaveStyle({ color: ACTIVE_COLOR })
    expect(profileLabel).not.toHaveStyle({ color: ACTIVE_COLOR })

    // Click Profile tab
    fireEvent.click(profileLabel)

    // Profile tab should now be active.
    expect(profileLabel).toHaveStyle({ color: ACTIVE_COLOR })
    expect(homeLabel).not.toHaveStyle({ color: ACTIVE_COLOR })
  })
})
