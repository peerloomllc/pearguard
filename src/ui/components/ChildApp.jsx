import React, { useState, useEffect, useRef } from 'react';
import { useTheme } from '../theme.js';
import TabBar from './TabBar.jsx';
import ChildHome from './ChildHome.jsx';
import Profile from './Profile.jsx';
import Button from './primitives/Button.jsx';
import Icon from '../icons.js';
import { TourProvider, useTour } from './Tour.jsx';
import { CHILD_TOUR_SLIDES, CHILD_TOUR_AFTER_PAIR_SLIDES } from './childTourSlides.js';

const TABS = [
  { key: 'home', label: 'Home', icon: 'House', Component: () => <ChildHome openDetail /> },
  { key: 'profile', label: 'Profile', icon: 'User', Component: () => <Profile mode="child" /> },
];

function WelcomeCard({ onDismiss }) {
  const { colors, typography, spacing, radius } = useTheme();
  return (
    <div style={{
      position: 'fixed', inset: 0,
      backgroundColor: 'rgba(0,0,0,0.72)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: `${spacing.xl}px`, zIndex: 600,
    }}>
      <div style={{
        backgroundColor: colors.surface.card,
        border: `1px solid ${colors.border}`,
        borderRadius: `${radius.lg}px`,
        padding: `${spacing.xxl}px ${spacing.xl}px`,
        width: '100%', maxWidth: '360px',
        textAlign: 'center',
      }}>
        <Icon name="Shield" size={36} color={colors.primary} />
        <h2 style={{ ...typography.heading, color: colors.text.primary, marginTop: `${spacing.md}px`, marginBottom: `${spacing.sm}px` }}>
          Welcome to PearGuard
        </h2>
        <p style={{ ...typography.body, color: colors.text.secondary, lineHeight: '1.5', marginTop: 0, marginBottom: `${spacing.xl}px` }}>
          Your parent uses PearGuard to help manage screen time on this device. Once you pair with them, we'll show you around.
        </p>
        <Button onClick={onDismiss} style={{ width: '100%' }}>
          Got it
        </Button>
      </div>
    </div>
  );
}

export default function ChildApp() {
  return (
    <TourProvider>
      <ChildAppInner />
    </TourProvider>
  );
}

function ChildAppInner() {
  const { colors, typography } = useTheme();
  const [tab, setTab] = useState(() => (typeof window !== 'undefined' && window.__pearScreenshotChildTab) || 'home');
  const [showWelcome, setShowWelcome] = useState(false);
  const tour = useTour();
  const tourStartedRef = useRef(false);

  useEffect(() => {
    window.__pearTourNavigate = (target) => {
      if (target === 'home' || target === 'profile') setTab(target);
    };
    return () => { delete window.__pearTourNavigate; };
  }, []);

  useEffect(() => {
    // Notification tap: switch to home so ChildHome can open the requests modal
    const unsub = window.onBareEvent('navigate:child:requests', () => setTab('home'));
    return unsub;
  }, []);

  // Welcome card on first launch (gated by pref).
  useEffect(() => {
    window.callBare('pref:get', { key: 'onboarding:welcomeSeen' })
      .then((seen) => { if (!seen) setShowWelcome(true); })
      .catch(() => {});
  }, []);

  // Replay button handler (wired from Profile).
  useEffect(() => {
    function onReplay() {
      tour.start(CHILD_TOUR_SLIDES, {
        onFinish: () => window.callBare('pref:set', { key: 'onboarding:tourSeen', value: true }).catch(() => {}),
      });
    }
    window.__pearReplayTour = onReplay;
    return () => { delete window.__pearReplayTour; };
  }, [tour]);

  // Auto-start tour on first pairing.
  useEffect(() => {
    const unsub = window.onBareEvent('peer:paired', () => {
      if (tourStartedRef.current) return;
      window.callBare('pref:get', { key: 'onboarding:tourSeen' })
        .then((seen) => {
          if (seen || tourStartedRef.current) return;
          tourStartedRef.current = true;
          setTab('home');
          tour.start(CHILD_TOUR_AFTER_PAIR_SLIDES, {
            onFinish: () => window.callBare('pref:set', { key: 'onboarding:tourSeen', value: true }).catch(() => {}),
          });
        })
        .catch(() => {});
    });
    return unsub;
  }, [tour]);

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
      {showWelcome && (
        <WelcomeCard onDismiss={() => {
          window.callBare('pref:set', { key: 'onboarding:welcomeSeen', value: true }).catch(() => {});
          setShowWelcome(false);
        }} />
      )}
    </div>
  );
}
