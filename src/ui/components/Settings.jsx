import React, { useState, useEffect, useRef } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import Toggle from './primitives/Toggle.jsx';
import Avatar from './Avatar.jsx';
import AvatarPicker from './AvatarPicker.jsx';

const DEFAULT_TIME_OPTIONS = [15, 30, 60, 120];
const DEFAULT_WARNING_THRESHOLDS = [10, 5, 1];
const AVAILABLE_TIME_OPTIONS = [5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240];
const AVAILABLE_WARNING_OPTIONS = [1, 2, 3, 5, 10, 15, 20, 30];

function formatMinutes(min) {
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return h + (h === 1 ? ' hour' : ' hours');
  return h + 'h ' + m + 'm';
}

function Collapsible({ title, open, onToggle, maxHeight, children, colors, spacing, radius }) {
  return (
    <div style={{
      backgroundColor: colors.surface.elevated,
      borderRadius: `${radius.lg}px`,
      marginBottom: `${spacing.md}px`,
      overflow: 'hidden',
    }}>
      <div
        onClick={() => { window.callBare('haptic:tap'); onToggle(); }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', cursor: 'pointer',
        }}
      >
        <div style={{ fontSize: '12px', fontWeight: '300', color: colors.text.muted, letterSpacing: '0.06em' }}>
          {title}
        </div>
        <span style={{
          fontSize: '16px', color: colors.text.muted, transition: 'transform 0.3s',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block',
        }}>&rsaquo;</span>
      </div>
      <div style={{
        maxHeight: open ? maxHeight : '0px', overflow: 'hidden',
        transition: 'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        <div style={{ padding: '0 16px 14px' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function ChipSelect({ options, selected, onChange, formatter, colors, spacing, radius }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${spacing.sm}px` }}>
      {options.map((val) => {
        const active = selected.includes(val);
        return (
          <button
            key={val}
            onClick={() => {
              window.callBare('haptic:tap');
              onChange(active ? selected.filter((v) => v !== val) : [...selected, val].sort((a, b) => a - b));
            }}
            style={{
              padding: `${spacing.sm}px 14px`,
              borderRadius: `${radius.full}px`,
              border: `1px solid ${active ? colors.primary : colors.border}`,
              backgroundColor: active ? colors.primary : 'transparent',
              fontSize: '13px',
              color: active ? '#FFFFFF' : colors.text.secondary,
              cursor: 'pointer',
            }}
          >
            {formatter ? formatter(val) : val}
          </button>
        );
      })}
    </div>
  );
}

export default function Settings() {
  const { colors, typography, spacing, radius, theme: currentTheme, setTheme } = useTheme();

  // Collapsible state
  const [pinOpen, setPinOpen] = useState(false);
  const [timeOptsOpen, setTimeOptsOpen] = useState(false);
  const [warningOpen, setWarningOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);

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

  // Settings state
  const [timeRequestMinutes, setTimeRequestMinutes] = useState(DEFAULT_TIME_OPTIONS);
  const [warningMinutes, setWarningMinutes] = useState(DEFAULT_WARNING_THRESHOLDS);
  const [settingsStatus, setSettingsStatus] = useState(null);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    window.callBare('identity:getName')
      .then(({ displayName, avatar: av }) => {
        const n = displayName || '';
        setName(n);
        setSavedName(n);
        if (av) setAvatar(av);
      })
      .catch(() => {});

    window.callBare('settings:get')
      .then((s) => {
        if (s.timeRequestMinutes) setTimeRequestMinutes(s.timeRequestMinutes);
        if (s.warningMinutes) setWarningMinutes(s.warningMinutes);
        setSettingsLoaded(true);
      })
      .catch(() => setSettingsLoaded(true));
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

  async function handleSettingsSave() {
    if (timeRequestMinutes.length === 0 || warningMinutes.length === 0) {
      setSettingsStatus('Select at least one option for each setting.');
      return;
    }
    setSettingsStatus(null);
    try {
      await window.callBare('settings:save', {
        settings: { timeRequestMinutes, warningMinutes },
      });
      setSettingsStatus('success');
    } catch {
      setSettingsStatus('Failed to save settings.');
    }
  }

  const nameUnchanged = name.trim() === savedName || !name.trim();

  const inputStyle = {
    padding: '10px',
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.md}px`,
    fontSize: '15px',
    marginTop: `${spacing.xs}px`,
    backgroundColor: colors.surface.input,
    color: colors.text.primary,
    width: '100%',
    boxSizing: 'border-box',
  };

  const collapsibleProps = { colors, spacing, radius };

  return (
    <div style={{ padding: `${spacing.base}px`, overflowY: 'auto', flex: 1 }}>
      <h2 style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.lg}px` }}>Settings</h2>

      {/* Profile */}
      <section style={{ marginBottom: `${spacing.xxl}px` }}>
        <h3 style={{ fontSize: '16px', fontWeight: '700', marginBottom: `${spacing.sm}px`, color: colors.text.primary }}>Profile</h3>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: `${spacing.lg}px` }}>
          <div style={{ position: 'relative', display: 'inline-block' }}>
            <Avatar avatar={avatar} name={savedName} size={80} onClick={() => setShowPicker(true)} />
            <div
              style={{
                position: 'absolute', bottom: '0', right: '0',
                width: '26px', height: '26px', borderRadius: '50%',
                backgroundColor: colors.primary, border: '2px solid #FFF',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
              }}
              onClick={() => { window.callBare('haptic:tap'); setShowPicker(true); }}
            >
              <Icon name="PencilSimple" size={13} color="#FFFFFF" />
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

        <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px`, fontSize: '14px', color: colors.text.secondary }}>
            Parent Name
            <input
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameStatus(null); }}
              placeholder="e.g. Mom"
              style={inputStyle}
            />
          </label>
          {nameStatus === 'success' && <p style={{ color: colors.success, fontSize: '13px', margin: 0 }}>Name saved.</p>}
          {nameStatus === 'error' && <p style={{ color: colors.error, fontSize: '13px', margin: 0 }}>Failed to save name.</p>}
          <Button
            onClick={() => { window.callBare('haptic:tap'); handleNameSave(); }}
            disabled={savingName || nameUnchanged}
            style={{ alignSelf: 'center' }}
          >
            {savingName ? 'Saving...' : 'Save Name'}
          </Button>
        </div>
      </section>

      {/* Override PIN */}
      <Collapsible title="OVERRIDE PIN" open={pinOpen} onToggle={() => setPinOpen(o => !o)} maxHeight="350px" {...collapsibleProps}>
        <p style={{ fontSize: '12px', color: colors.text.muted, marginBottom: `${spacing.md}px`, marginTop: 0 }}>
          Children enter this PIN on the block overlay to get temporary access. The PIN is hashed before leaving this device.
        </p>
        <form onSubmit={handlePinSubmit} style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.md}px` }} aria-label="Change PIN form">
          <label style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px`, fontSize: '14px', color: colors.text.secondary }}>
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
              style={inputStyle}
              aria-label="New PIN"
              inputMode="numeric"
              maxLength={4}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px`, fontSize: '14px', color: colors.text.secondary }}>
            Confirm PIN
            <input
              ref={confirmPinRef}
              type="text"
              value={confirmPin}
              onChange={(e) => { setConfirmPin(e.target.value); setPinStatus(null); }}
              placeholder="Repeat PIN"
              style={inputStyle}
              aria-label="Confirm PIN"
              inputMode="numeric"
              maxLength={4}
            />
          </label>
          {pinStatus && pinStatus !== 'success' && (
            <p style={{ color: colors.error, fontSize: '13px', margin: 0 }} role="alert">{pinStatus}</p>
          )}
          {pinStatus === 'success' && (
            <p style={{ color: colors.success, fontSize: '13px', margin: 0 }} role="status">PIN updated successfully.</p>
          )}
          <Button type="submit" style={{ width: '100%' }} aria-label="Save PIN">
            Save PIN
          </Button>
        </form>
      </Collapsible>

      {/* Time Request Options */}
      {settingsLoaded && (
        <Collapsible title="TIME REQUEST OPTIONS" open={timeOptsOpen} onToggle={() => setTimeOptsOpen(o => !o)} maxHeight="200px" {...collapsibleProps}>
          <p style={{ fontSize: '12px', color: colors.text.muted, marginBottom: `${spacing.md}px`, marginTop: 0 }}>
            Choose which duration options the child sees when requesting more time from the block overlay.
          </p>
          <ChipSelect
            options={AVAILABLE_TIME_OPTIONS}
            selected={timeRequestMinutes}
            onChange={(v) => { setTimeRequestMinutes(v); setSettingsStatus(null); }}
            formatter={formatMinutes}
            colors={colors}
            spacing={spacing}
            radius={radius}
          />
        </Collapsible>
      )}

      {/* Warning Thresholds */}
      {settingsLoaded && (
        <Collapsible title="WARNING NOTIFICATIONS" open={warningOpen} onToggle={() => setWarningOpen(o => !o)} maxHeight="200px" {...collapsibleProps}>
          <p style={{ fontSize: '12px', color: colors.text.muted, marginBottom: `${spacing.md}px`, marginTop: 0 }}>
            The child will be notified this many minutes before a schedule block starts or a daily time limit runs out.
          </p>
          <ChipSelect
            options={AVAILABLE_WARNING_OPTIONS}
            selected={warningMinutes}
            onChange={(v) => { setWarningMinutes(v); setSettingsStatus(null); }}
            formatter={(v) => v + ' min'}
            colors={colors}
            spacing={spacing}
            radius={radius}
          />
        </Collapsible>
      )}

      {/* Appearance */}
      {settingsLoaded && (
        <Collapsible title="APPEARANCE" open={appearanceOpen} onToggle={() => setAppearanceOpen(o => !o)} maxHeight="200px" {...collapsibleProps}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
              <Icon name={currentTheme === 'dark' ? 'Moon' : 'SunDim'} size={20} color={colors.text.primary} />
              <span style={{ fontSize: '14px', color: colors.text.primary }}>{currentTheme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
            </div>
            <Toggle checked={currentTheme === 'dark'} onChange={(checked) => setTheme(checked ? 'dark' : 'light')} />
          </div>
        </Collapsible>
      )}

      {/* Save settings button */}
      {settingsLoaded && (
        <div style={{ textAlign: 'center', marginTop: `${spacing.md}px`, marginBottom: `${spacing.xxl}px` }}>
          {settingsStatus && settingsStatus !== 'success' && (
            <p style={{ color: colors.error, fontSize: '13px', marginBottom: `${spacing.sm}px` }}>{settingsStatus}</p>
          )}
          {settingsStatus === 'success' && (
            <p style={{ color: colors.success, fontSize: '13px', marginBottom: `${spacing.sm}px` }}>Settings saved and synced to child.</p>
          )}
          <Button
            onClick={() => { window.callBare('haptic:tap'); handleSettingsSave(); }}
          >
            Save Settings
          </Button>
        </div>
      )}
    </div>
  );
}
