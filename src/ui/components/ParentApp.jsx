import React, { useState, useEffect } from 'react';
import Dashboard from './Dashboard.jsx';
import Settings from './Settings.jsx';
import AboutTab from './AboutTab.jsx';
import TabBar from './TabBar.jsx';
import Button from './primitives/Button.jsx';
import Input from './primitives/Input.jsx';
import Icon from '../icons.js';
import { useTheme } from '../theme.js';

const TWO_WEEKS = 14 * 24 * 60 * 60 * 1000;

function DonationReminderModal({ onDonate, onDismiss }) {
  const { colors, typography, spacing, radius } = useTheme();

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: `${spacing.xl}px`, zIndex: 490,
    }}>
      <div style={{
        backgroundColor: colors.surface.card,
        border: `1px solid ${colors.border}`,
        borderRadius: '20px',
        padding: `${spacing.xxl}px`,
        width: '100%', maxWidth: '360px',
        textAlign: 'center',
      }}>
        <div style={{ fontSize: '32px', marginBottom: `${spacing.md}px` }}>
          <Icon name="Lightning" size={32} color={colors.primary} />
        </div>
        <h2 style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.sm}px`, marginTop: 0 }}>
          Enjoying PearGuard?
        </h2>
        <p style={{ ...typography.body, color: colors.text.secondary, marginBottom: `${spacing.xl}px`, marginTop: 0, lineHeight: '1.6' }}>
          PearGuard is free and open source with no ads or subscriptions.
          If you've received value from it, consider returning value to support development.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
          <Button onClick={onDonate} style={{ width: '100%' }}>
            <Icon name="Lightning" size={16} color="#FFFFFF" /> Donate
          </Button>
          <Button variant="secondary" onClick={onDismiss} style={{ width: '100%' }}>
            Maybe later
          </Button>
          <button
            onClick={onDismiss}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              color: colors.text.muted, fontSize: '13px', padding: `${spacing.sm}px`,
            }}
          >
            Already donated &#10003;
          </button>
        </div>
      </div>
    </div>
  );
}

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'House', Component: Dashboard },
  { key: 'settings', label: 'Settings', icon: 'GearSix', Component: Settings },
  { key: 'about', label: 'About', icon: 'Info', Component: AboutTab },
];

function PinSetupOverlay({ onDone }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState(null);

  function handleSubmit(e) {
    e.preventDefault();
    if (pin.length !== 4) { setError('PIN must be exactly 4 digits.'); return; }
    if (!/^\d+$/.test(pin)) { setError('PIN must contain only digits.'); return; }
    if (pin !== confirmPin) { setError('PINs do not match.'); setConfirmPin(''); return; }
    setError(null);
    window.callBare('pin:set', { pin })
      .then(onDone)
      .catch((err) => setError(err.message || 'Failed to set PIN. Please try again.'));
  }

  return (
    <div style={{
      position: 'absolute',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: colors.surface.base,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'flex-start',
      padding: `${spacing.xl}px`,
      paddingTop: '10vh',
      overflowY: 'auto',
      WebkitOverflowScrolling: 'touch',
    }}>
      <div style={{
        backgroundColor: colors.surface.card,
        border: `1px solid ${colors.border}`,
        borderRadius: `${radius.xl}px`,
        padding: `${spacing.xxl}px`,
        width: '100%',
        maxWidth: '360px',
        marginBottom: `${spacing.xxl}px`,
      }}>
        <h2 style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.sm}px`, marginTop: 0 }}>
          Set Override PIN
        </h2>
        <p style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.xl}px`, marginTop: 0 }}>
          Children enter this PIN on the block screen to request temporary access.
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.base}px` }}>
          <Input
            label="Set PIN"
            value={pin}
            onChange={(e) => {
              setPin(e.target.value);
              setError(null);
              if (e.target.value.length === 4) {
                document.getElementById('pin-confirm-input')?.focus();
              }
            }}
            placeholder="e.g. 1234"
            inputMode="numeric"
            maxLength={4}
            aria-label="Set PIN"
          />
          <Input
            id="pin-confirm-input"
            label="Confirm PIN"
            value={confirmPin}
            onChange={(e) => { setConfirmPin(e.target.value); setError(null); }}
            placeholder="Repeat PIN"
            inputMode="numeric"
            maxLength={4}
            aria-label="Confirm PIN"
          />
          {error && (
            <p style={{ ...typography.caption, color: colors.error, margin: 0 }} role="alert">
              {error}
            </p>
          )}
          <Button type="submit" variant="primary" aria-label="Save PIN" style={{ width: '100%', padding: `${spacing.md}px` }}>
            Save PIN
          </Button>
        </form>
      </div>
    </div>
  );
}

export default function ParentApp() {
  const { colors, typography, spacing } = useTheme();
  const [tab, setTab] = useState('dashboard');
  const [banner, setBanner] = useState(null);
  const [pinCheckState, setPinCheckState] = useState('loading'); // 'loading' | 'needed' | 'done'
  const [showDonation, setShowDonation] = useState(false);

  useEffect(() => {
    function checkPin() {
      window.callBare('pin:isSet', {})
        .then(({ isSet }) => setPinCheckState(isSet ? 'done' : 'needed'))
        .catch(() => setPinCheckState('needed'));
    }
    checkPin();
    // Re-check when worklet re-initializes (e.g. returning from setup) so a PIN
    // set during the setup flow is picked up without requiring a full remount.
    return window.onBareEvent('ready', checkPin);
  }, []);

  useEffect(() => {
    if (pinCheckState !== 'done') return;
    window.callBare('donation:check')
      .then(({ createdAt, dismissed }) => {
        if (dismissed) return;
        if (!createdAt || Date.now() - createdAt >= TWO_WEEKS) setShowDonation(true);
      })
      .catch(() => {});
  }, [pinCheckState]);

  // Listen for notification-tap navigation at this level (always mounted).
  // Ensure Dashboard tab is visible when notification deep links fire.
  // Dashboard itself listens for the events and handles child navigation.
  useEffect(() => {
    if (window.__pendingAlertsNav) setTab('dashboard');
    const unsub1 = window.onBareEvent('navigate:child:alerts', () => setTab('dashboard'));
    const unsub2 = window.onBareEvent('navigate:child:requests', () => setTab('dashboard'));
    return () => { unsub1(); unsub2(); };
  }, []);

  useEffect(() => {
    const unsub = window.onBareEvent('child:connected', (data) => {
      setBanner(`Successfully paired with ${data?.displayName || 'Child'}!`);
      setTimeout(() => {
        setBanner(null);
        setTab('dashboard');
      }, 3000);
    });
    return unsub;
  }, []);

  if (pinCheckState === 'loading') {
    return null;
  }

  if (pinCheckState === 'needed') {
    return <PinSetupOverlay onDone={() => setPinCheckState('done')} />;
  }

  const active = TABS.find((t) => t.key === tab);
  const ActiveTab = active.Component;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      backgroundColor: colors.surface.base,
      ...typography.body,
    }}>
      {banner && (
        <div style={{
          backgroundColor: `${colors.success}22`,
          color: colors.success,
          border: `1px solid ${colors.success}44`,
          padding: `${spacing.md}px ${spacing.base}px`,
          textAlign: 'center',
          ...typography.body,
          fontWeight: '500',
        }}>
          {banner}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'dashboard'
          ? <Dashboard />
          : <ActiveTab />}
      </div>
      <TabBar tabs={TABS} activeTab={tab} onTabChange={setTab} />
      {showDonation && (
        <DonationReminderModal
          onDonate={() => {
            window.callBare('donation:dismiss').catch(() => {});
            setShowDonation(false);
            setTab('about');
          }}
          onDismiss={() => {
            window.callBare('donation:dismiss').catch(() => {});
            setShowDonation(false);
          }}
        />
      )}
    </div>
  );
}
