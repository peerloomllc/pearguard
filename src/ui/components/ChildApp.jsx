import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import TabBar from './TabBar.jsx';
import ChildHome from './ChildHome.jsx';
import Profile from './Profile.jsx';

const TABS = [
  { key: 'home', label: 'Home', icon: 'House', Component: () => <ChildHome openDetail /> },
  { key: 'profile', label: 'Profile', icon: 'User', Component: () => <Profile mode="child" /> },
];

export default function ChildApp() {
  const { colors, typography } = useTheme();
  const [tab, setTab] = useState(() => (typeof window !== 'undefined' && window.__pearScreenshotChildTab) || 'home');

  useEffect(() => {
    // Notification tap: switch to home so ChildHome can open the requests modal
    const unsub = window.onBareEvent('navigate:child:requests', () => setTab('home'));
    return unsub;
  }, []);

  const ActiveTab = TABS.find((t) => t.key === tab)?.Component || TABS[0].Component;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      backgroundColor: colors.surface.base, ...typography.body,
    }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <ActiveTab />
      </div>
      <TabBar tabs={TABS} activeTab={tab} onTabChange={setTab} />
    </div>
  );
}
