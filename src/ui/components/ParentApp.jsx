import React, { useState, useEffect, useRef } from 'react';
import Dashboard from './Dashboard.jsx';
import Settings from './Settings.jsx';
import AboutTab from './AboutTab.jsx';
import TabBar from './TabBar.jsx';
import FAB from './FAB.jsx';
import Button from './primitives/Button.jsx';
import Input from './primitives/Input.jsx';
import { useTheme } from '../theme.js';

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
      position: 'fixed',
      top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: colors.surface.base,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: `${spacing.xl}px`,
    }}>
      <div style={{
        backgroundColor: colors.surface.card,
        border: `1px solid ${colors.border}`,
        borderRadius: `${radius.xl}px`,
        padding: `${spacing.xxl}px`,
        width: '100%',
        maxWidth: '360px',
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
  const [navTrigger, setNavTrigger] = useState(null);
  const dashRef = useRef(null);

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

  // Listen for notification-tap navigation at this level (always mounted).
  // Switches to Dashboard tab and passes the payload down so Dashboard can
  // navigate to the correct child + tab -- fixes #69 and #77.
  useEffect(() => {
    const pending = window.__pendingAlertsNav;
    if (pending) {
      window.__pendingAlertsNav = null;
      setTab('dashboard');
      setNavTrigger({ ...pending, tab: 'activity', _ts: Date.now() });
    }
    const unsub = window.onBareEvent('navigate:child:alerts', (data) => {
      window.__pendingAlertsNav = null;
      setTab('dashboard');
      setNavTrigger({ ...data, tab: 'activity', _ts: Date.now() });
    });
    return unsub;
  }, []);

  useEffect(() => {
    const unsub = window.onBareEvent('navigate:child:requests', (data) => {
      setTab('dashboard');
      setNavTrigger({ ...data, tab: 'activity', _ts: Date.now() });
    });
    return unsub;
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
          ? <Dashboard ref={dashRef} navTrigger={navTrigger} onNavConsumed={() => setNavTrigger(null)} />
          : <ActiveTab />}
      </div>
      {tab === 'dashboard' && (
        <FAB icon="Plus" onPress={() => dashRef.current?.showAddChild?.()} />
      )}
      <TabBar tabs={TABS} activeTab={tab} onTabChange={setTab} />
    </div>
  );
}
