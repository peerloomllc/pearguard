import React, { useState, useEffect, useRef } from 'react';
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

function PinSetupOverlay({ onDone }) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState(null);
  const confirmRef = useRef(null);

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
    <div style={styles.overlay}>
      <div style={styles.overlayCard}>
        <h2 style={styles.overlayTitle}>Set Override PIN</h2>
        <p style={styles.overlayHint}>
          Children enter this PIN on the block screen to request temporary access.
        </p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>
            Set PIN
            <input
              type="text"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value);
                setError(null);
                if (e.target.value.length === 4) confirmRef.current?.focus();
              }}
              placeholder="e.g. 1234"
              inputMode="numeric"
              maxLength={4}
              style={styles.input}
              aria-label="Set PIN"
            />
          </label>
          <label style={styles.label}>
            Confirm PIN
            <input
              type="text"
              ref={confirmRef}
              value={confirmPin}
              onChange={(e) => { setConfirmPin(e.target.value); setError(null); }}
              placeholder="Repeat PIN"
              inputMode="numeric"
              maxLength={4}
              style={styles.input}
              aria-label="Confirm PIN"
            />
          </label>
          {error && <p style={styles.errorText} role="alert">{error}</p>}
          <button type="submit" style={styles.submitBtn} aria-label="Save PIN">
            Save PIN
          </button>
        </form>
      </div>
    </div>
  );
}

export default function ParentApp() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [pairedName, setPairedName] = useState(null);
  const [pinCheckState, setPinCheckState] = useState('loading'); // 'loading' | 'needed' | 'done'

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
    const unsub = window.onBareEvent('child:connected', (data) => {
      setPairedName(data?.displayName || 'Child');
      setTimeout(() => {
        setPairedName(null);
        setActiveTab('dashboard');
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
            onClick={() => { navigator.vibrate(30); setActiveTab(tab.key); }}
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
    display: 'flex', flexDirection: 'column', height: '100vh',
    fontFamily: 'sans-serif', backgroundColor: '#fff',
  },
  checking: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888', fontSize: '14px' },
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '24px',
  },
  overlayCard: {
    backgroundColor: '#1a1a1a', borderRadius: '16px', padding: '32px',
    width: '100%', maxWidth: '360px', border: '1px solid #333',
  },
  overlayTitle: { color: '#fff', fontSize: '22px', fontWeight: '700', marginBottom: '8px' },
  overlayHint: { color: '#888', fontSize: '13px', marginBottom: '24px' },
  form: { display: 'flex', flexDirection: 'column', gap: '16px' },
  label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '14px', color: '#aaa' },
  input: {
    padding: '12px', border: '1px solid #444', borderRadius: '8px',
    fontSize: '16px', marginTop: '4px', backgroundColor: '#222', color: '#fff',
  },
  errorText: { color: '#ea4335', fontSize: '13px', margin: 0 },
  submitBtn: {
    padding: '14px', border: 'none', borderRadius: '8px',
    backgroundColor: '#6FCF97', color: '#111', cursor: 'pointer',
    fontSize: '16px', fontWeight: '700',
  },
  banner: {
    backgroundColor: '#e6f4ea', color: '#1e7e34', border: '1px solid #a8d5b5',
    padding: '12px 16px', fontSize: '14px', fontWeight: '500', textAlign: 'center',
    flexShrink: 0,
  },
  content: { flex: 1, overflowY: 'auto' },
  tabBar: { display: 'flex', borderTop: '1px solid #ddd', backgroundColor: '#fff' },
  tabButton: {
    flex: 1, padding: '12px 0', border: 'none', background: 'none',
    cursor: 'pointer', fontSize: '14px', fontWeight: '500',
  },
  tabActive: { color: '#1a73e8', borderTop: '2px solid #1a73e8' },
  tabInactive: { color: '#666' },
};
