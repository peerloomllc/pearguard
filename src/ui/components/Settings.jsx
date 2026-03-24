import React, { useState, useRef } from 'react';

export default function Settings() {
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinStatus, setPinStatus] = useState(null); // null | 'success' | Error string
  const confirmPinRef = useRef(null);
  function handlePinSubmit(e) {
    e.preventDefault();
    if (newPin.length !== 4) {
      setPinStatus('PIN must be exactly 4 digits.');
      return;
    }
    if (!/^\d+$/.test(newPin)) {
      setPinStatus('PIN must contain only digits.');
      return;
    }
    if (newPin !== confirmPin) {
      setPinStatus('PINs do not match.');
      return;
    }
    setPinStatus(null);
    window.callBare('pin:set', { pin: newPin })
      .then(() => {
        setPinStatus('success');
        setNewPin('');
        setConfirmPin('');
      })
      .catch((err) => {
        setPinStatus(err.message || 'Failed to set PIN. Please try again.');
      });
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.pageHead}>Settings</h2>

      <section style={styles.section}>
        <h3 style={styles.sectionHead}>Override PIN</h3>
        <p style={styles.hint}>
          Children enter this PIN on the block overlay to get temporary access. The PIN is hashed before leaving this device.
        </p>
        <form onSubmit={handlePinSubmit} style={styles.form} aria-label="Change PIN form">
          <label style={styles.label}>
            New PIN
            <input
              type="text"
              value={newPin}
              onChange={(e) => {
                setNewPin(e.target.value);
                setPinStatus(null);
                if (e.target.value.length === 4) confirmPinRef.current?.focus();
              }}
              placeholder="e.g. 1234"
              style={styles.input}
              aria-label="New PIN"
              inputMode="numeric"
              maxLength={4}
            />
          </label>
          <label style={styles.label}>
            Confirm PIN
            <input
              ref={confirmPinRef}
              type="text"
              value={confirmPin}
              onChange={(e) => { setConfirmPin(e.target.value); setPinStatus(null); }}
              placeholder="Repeat PIN"
              style={styles.input}
              aria-label="Confirm PIN"
              inputMode="numeric"
              maxLength={4}
            />
          </label>
          {pinStatus && pinStatus !== 'success' && (
            <p style={styles.errorText} role="alert">{pinStatus}</p>
          )}
          {pinStatus === 'success' && (
            <p style={styles.successText} role="status">PIN updated successfully.</p>
          )}
          <button type="submit" style={styles.submitBtn} aria-label="Save PIN">
            Save PIN
          </button>
        </form>
      </section>

    </div>
  );
}

const styles = {
  container: { padding: '16px', fontFamily: 'sans-serif' },
  pageHead: { fontSize: '20px', fontWeight: '700', marginBottom: '20px' },
  section: { marginBottom: '32px' },
  sectionHead: { fontSize: '16px', fontWeight: '700', marginBottom: '8px' },
  hint: { fontSize: '12px', color: '#888', marginBottom: '12px' },
  form: { display: 'flex', flexDirection: 'column', gap: '12px' },
  label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '14px', color: '#444' },
  input: {
    padding: '10px', border: '1px solid #ccc', borderRadius: '6px',
    fontSize: '15px', marginTop: '4px',
  },
  submitBtn: {
    padding: '12px', border: 'none', borderRadius: '6px',
    backgroundColor: '#1a73e8', color: '#fff', cursor: 'pointer',
    fontSize: '15px', fontWeight: '600',
  },
  errorText: { color: '#ea4335', fontSize: '13px', margin: 0 },
  successText: { color: '#34a853', fontSize: '13px', margin: 0 },
};
