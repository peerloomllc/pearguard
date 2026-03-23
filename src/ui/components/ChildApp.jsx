import React, { useState, useEffect } from 'react'
import ChildHome from './ChildHome'
import ChildRequests from './ChildRequests'
import Profile from './Profile.jsx'

const ChildProfile = () => <Profile mode="child" />

const TABS = [
  { id: 'home', label: 'Home', Component: ChildHome },
  { id: 'requests', label: 'Requests', Component: ChildRequests },
  { id: 'profile', label: 'Profile', Component: ChildProfile },
]

export default function ChildApp() {
  const [activeTab, setActiveTab] = useState('home')
  const ActiveComponent = TABS.find((t) => t.id === activeTab).Component

  useEffect(() => {
    const unsub = window.onBareEvent('navigate:child:requests', () => {
      setActiveTab('requests')
    })
    return unsub
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#fff' }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <ActiveComponent />
      </div>

      {/* Bottom tab bar */}
      <div
        style={{
          display: 'flex',
          borderTop: '1px solid #DDD',
          backgroundColor: '#FFF',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1,
              padding: '12px 0',
              border: 'none',
              backgroundColor: activeTab === tab.id ? '#F0F0F0' : '#FFF',
              fontWeight: activeTab === tab.id ? 'bold' : 'normal',
              cursor: 'pointer',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}
