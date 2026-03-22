import React, { useState, useEffect } from 'react';
import Dashboard from './Dashboard.jsx';
import ChildrenList from './ChildrenList.jsx';
import Settings from './Settings.jsx';
import Profile from './Profile.jsx';

const ParentProfile = () => <Profile mode="parent" />;

const TABS = [
  { key: 'dashboard', label: 'Dashboard', Component: Dashboard },
  { key: 'children', label: 'Children', Component: ChildrenList },
  { key: 'settings', label: 'Settings', Component: Settings },
  { key: 'profile', label: 'Profile', Component: ParentProfile },
];

export default function ParentApp() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [pairedName, setPairedName] = useState(null);

  useEffect(() => {
    const unsub = window.onBareEvent('child:connected', (data) => {
      setPairedName(data?.displayName || 'Child');
      setTimeout(() => {
        setPairedName(null);
        setActiveTab('dashboard');
      }, 3000);
    });
    return unsub;
  }, []);

  const active = TABS.find((t) => t.key === activeTab);
  const ActiveComponent = active.Component;

  return (
    <div style={styles.container}>
      {pairedName && (
        <div style={styles.banner}>Successfully paired with {pairedName}!</div>
      )}
      <div style={styles.content}>
        <ActiveComponent />
      </div>
      <nav style={styles.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              ...styles.tabButton,
              ...(activeTab === tab.key ? styles.tabActive : styles.tabInactive),
            }}
            aria-selected={activeTab === tab.key}
            role="tab"
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    height: '100vh',
    fontFamily: 'sans-serif',
    backgroundColor: '#fff',
  },
  banner: {
    backgroundColor: '#e6f4ea', color: '#1e7e34', border: '1px solid #a8d5b5',
    padding: '12px 16px', fontSize: '14px', fontWeight: '500', textAlign: 'center',
    flexShrink: 0,
  },
  content: {
    flex: 1,
    overflowY: 'auto',
  },
  tabBar: {
    display: 'flex',
    borderTop: '1px solid #ddd',
    backgroundColor: '#fff',
  },
  tabButton: {
    flex: 1,
    padding: '12px 0',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: '500',
  },
  tabActive: {
    color: '#1a73e8',
    borderTop: '2px solid #1a73e8',
  },
  tabInactive: {
    color: '#666',
  },
};
