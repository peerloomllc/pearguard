import React, { useState, useEffect, useRef } from 'react';
import Avatar from './Avatar.jsx';
import AvatarPicker from './AvatarPicker.jsx';

export default function Settings() {
  // Profile state
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [avatar, setAvatar] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [nameStatus, setNameStatus] = useState(null);

  // PIN state
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinStatus, setPinStatus] = useState(null);
  const confirmPinRef = useRef(null);

  useEffect(() => {
    window.callBare('identity:getName')
      .then(({ displayName, avatar: av }) => {
        const n = displayName || '';
        setName(n);
        setSavedName(n);
        if (av) setAvatar(av);
      })
      .catch(() => {});
  }, []);

  async function handleNameSave() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setSavingName(true);
    setNameStatus(null);
    try {
      await window.callBare('identity:setName', { name: trimmed });
      setSavedName(trimmed);
      setNameStatus('success');
    } catch {
      setNameStatus('error');
    } finally {
      setSavingName(false);
    }
  }

  async function handleAvatarSave(newAvatar) {
    setShowPicker(false);
    try {
      await window.callBare('identity:setAvatar', { avatar: newAvatar });
      setAvatar(newAvatar);
    } catch {
      // silently fail
    }
  }

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

  const nameUnchanged = name.trim() === savedName || !name.trim();

  return (
    <div style={styles.container}>
      <h2 style={styles.pageHead}>Settings</h2>

      {/* Profile section */}
      <section style={styles.section}>
        <h3 style={styles.sectionHead}>Profile</h3>

        <div style={styles.avatarWrap}>
          <div style={styles.avatarContainer}>
            <Avatar avatar={avatar} name={savedName} size={80} onClick={() => setShowPicker(true)} />
            <div style={styles.editBadge} onClick={() => { window.callBare('haptic:tap'); setShowPicker(true); }}>
              <span style={styles.editIcon}>&#9998;</span>
            </div>
          </div>
        </div>

        {showPicker && (
          <AvatarPicker
            currentAvatar={avatar}
            name={savedName}
            onSave={handleAvatarSave}
            onCancel={() => setShowPicker(false)}
          />
        )}

        <div style={styles.field}>
          <label style={styles.label}>
            Parent Name
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameStatus(null); }}
              placeholder="e.g. Mom"
              style={styles.input}
            />
          </label>
          {nameStatus === 'success' && <p style={styles.successText}>Name saved.</p>}
          {nameStatus === 'error' && <p style={styles.errorText}>Failed to save name.</p>}
          <button
            onClick={() => { window.callBare('haptic:tap'); handleNameSave(); }}
            disabled={savingName || nameUnchanged}
            style={{ ...styles.submitBtn, ...(savingName || nameUnchanged ? styles.btnDisabled : {}) }}
          >
            {savingName ? 'Saving...' : 'Save Name'}
          </button>
        </div>
      </section>

      {/* Override PIN section */}
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
  field: { display: 'flex', flexDirection: 'column', gap: '8px' },
  label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '14px', color: '#444' },
  input: {
    padding: '10px', border: '1px solid #ccc', borderRadius: '6px',
    fontSize: '15px', marginTop: '4px',
  },
  avatarWrap: { display: 'flex', justifyContent: 'center', marginBottom: '20px' },
  avatarContainer: { position: 'relative', display: 'inline-block' },
  editBadge: {
    position: 'absolute', bottom: '0', right: '0',
    width: '26px', height: '26px', borderRadius: '50%',
    backgroundColor: '#1a73e8', border: '2px solid #FFF',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer',
  },
  editIcon: { color: '#FFF', fontSize: '13px' },
  submitBtn: {
    padding: '12px', border: 'none', borderRadius: '6px',
    backgroundColor: '#1a73e8', color: '#fff', cursor: 'pointer',
    fontSize: '15px', fontWeight: '600',
  },
  btnDisabled: { backgroundColor: '#ccc', cursor: 'not-allowed' },
  errorText: { color: '#ea4335', fontSize: '13px', margin: 0 },
  successText: { color: '#34a853', fontSize: '13px', margin: 0 },
};
