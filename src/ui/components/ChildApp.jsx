import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import TabBar from './TabBar.jsx';
import FAB from './FAB.jsx';
import ChildHome from './ChildHome.jsx';
import ChildRequests from './ChildRequests.jsx';
import Profile from './Profile.jsx';

const TABS = [
  { key: 'home', label: 'Home', icon: 'House', Component: ChildHome },
  { key: 'requests', label: 'Requests', icon: 'Bell', Component: ChildRequests },
  { key: 'profile', label: 'Profile', icon: 'User', Component: () => <Profile mode="child" /> },
];

export default function ChildApp() {
  const { colors, typography } = useTheme();
  const [tab, setTab] = useState('home');

  useEffect(() => {
    const unsub = window.onBareEvent('navigate:child:requests', () => setTab('requests'));
    return unsub;
  }, []);

  const ActiveTab = TABS.find((t) => t.key === tab)?.Component || ChildHome;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      backgroundColor: colors.surface.base, ...typography.body,
    }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <ActiveTab />
      </div>
      {tab === 'home' && (
        <FAB icon="Clock" onPress={() => setTab('requests')} />
      )}
      <TabBar tabs={TABS} activeTab={tab} onTabChange={setTab} />
    </div>
  );
}
