import React, { useState, useEffect, useRef } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import Toggle from './primitives/Toggle.jsx';
import Avatar from './Avatar.jsx';
import AvatarPicker from './AvatarPicker.jsx';
import { pickPhoto } from './avatarUtils.js';
import DeviceBackupModal from './DeviceBackupModal.jsx';
import Collapsible from './primitives/Collapsible.jsx';

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

const CATEGORY_LABELS = {
  data: 'Block data',
  tree: 'Tree index',
  bitfield: 'Bitfield',
  header: 'Header / oplog',
  other: 'Other',
};

function Bar({ pct, color, bg }) {
  return (
    <div style={{ height: 6, borderRadius: 3, background: bg, overflow: 'hidden', marginTop: 4 }}>
      <div style={{ height: '100%', width: `${Math.max(1, pct)}%`, background: color }} />
    </div>
  );
}

function StorageModal({ modal, onClose, breakdown, analyze, result, colors, typography, spacing, radius, formatBytes }) {
  if (!modal) return null;

  const title = modal === 'breakdown' ? 'Storage Breakdown'
    : modal === 'analyze' ? 'Reclaimable Analysis'
    : 'Reclaim Complete';

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: `${spacing.lg}px` }}>
      <div onClick={(e) => e.stopPropagation()} style={{ backgroundColor: colors.surface.card, borderRadius: `${radius.lg}px`, padding: `${spacing.lg}px`, maxWidth: 480, width: '100%', maxHeight: '80vh', overflowY: 'auto', border: `1px solid ${colors.border}` }}>
        <h3 style={{ ...typography.subheading, color: colors.text.primary, margin: 0, marginBottom: `${spacing.md}px`, textAlign: 'center' }}>{title}</h3>

        {modal === 'breakdown' && breakdown && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: `${spacing.md}px` }}>
              <span style={{ fontSize: 13, color: colors.text.secondary }}>On disk</span>
              <span style={{ fontSize: 15, fontWeight: 600, color: colors.text.primary }}>{formatBytes(breakdown.total)}</span>
            </div>
            {Object.entries(breakdown.cats).filter(([, v]) => v.count > 0).sort((a, b) => b[1].size - a[1].size).map(([cat, v]) => {
              const pct = breakdown.total > 0 ? (100 * v.size / breakdown.total) : 0;
              return (
                <div key={cat} style={{ marginBottom: `${spacing.sm}px` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: colors.text.secondary }}>
                    <span>{CATEGORY_LABELS[cat] || cat} <span style={{ color: colors.text.muted }}>({v.count})</span></span>
                    <span>{formatBytes(v.size)} ({pct.toFixed(0)}%)</span>
                  </div>
                  <Bar pct={pct} color={colors.primary} bg={colors.border} />
                </div>
              );
            })}
          </div>
        )}

        {modal === 'analyze' && analyze && (
          <div>
            <div style={{ padding: `${spacing.md}px`, backgroundColor: colors.surface.base, borderRadius: `${radius.md}px`, marginBottom: `${spacing.md}px`, textAlign: 'center' }}>
              <div style={{ fontSize: 11, color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Reclaimable</div>
              <div style={{ fontSize: 24, fontWeight: 700, color: analyze.pct > 20 ? colors.error : colors.text.primary, marginTop: 4 }}>
                ~{formatBytes(analyze.reclaimableBytes)} <span style={{ fontSize: 14, color: colors.text.muted }}>({analyze.pct}%)</span>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: `${spacing.sm}px`, marginBottom: `${spacing.md}px`, fontSize: 12, textAlign: 'center' }}>
              <div><div style={{ color: colors.success, fontSize: 18, fontWeight: 600 }}>{analyze.groups.keep || 0}</div><div style={{ color: colors.text.muted }}>keep</div></div>
              <div><div style={{ color: colors.error, fontSize: 18, fontWeight: 600 }}>{analyze.groups.wipe || 0}</div><div style={{ color: colors.text.muted }}>wipe</div></div>
              <div><div style={{ color: colors.text.primary, fontSize: 18, fontWeight: 600 }}>{analyze.groups.request || 0}</div><div style={{ color: colors.text.muted }}>requests</div></div>
            </div>
            <div style={{ fontSize: 12, color: colors.text.muted, marginBottom: `${spacing.sm}px` }}>By prefix (live data)</div>
            {Object.entries(analyze.byPrefix).sort((a, b) => b[1].bytes - a[1].bytes).map(([prefix, v]) => {
              const totalLive = analyze.estLiveBytes || 1;
              const pct = (100 * v.bytes / totalLive);
              const barColor = v.cls === 'wipe' ? colors.error : v.cls === 'keep' ? colors.success : colors.text.muted;
              return (
                <div key={prefix} style={{ marginBottom: `${spacing.sm}px` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, color: colors.text.secondary }}>
                    <span style={{ fontFamily: 'monospace' }}>{prefix} <span style={{ color: colors.text.muted }}>({v.count})</span></span>
                    <span>{formatBytes(v.bytes)}</span>
                  </div>
                  <Bar pct={pct} color={barColor} bg={colors.border} />
                </div>
              );
            })}
          </div>
        )}

        {modal === 'result' && result && (
          <div>
            <div style={{ padding: `${spacing.md}px`, backgroundColor: colors.surface.base, borderRadius: `${radius.md}px`, textAlign: 'center', marginBottom: `${spacing.md}px` }}>
              <div style={{ fontSize: 11, color: colors.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>Freed</div>
              <div style={{ fontSize: 28, fontWeight: 700, color: colors.success, marginTop: 4 }}>{formatBytes(result.freed)}</div>
              <div style={{ fontSize: 13, color: colors.text.muted, marginTop: 4 }}>{formatBytes(result.before)} to {formatBytes(result.after)}</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: `${spacing.sm}px`, fontSize: 13, color: colors.text.secondary, textAlign: 'center' }}>
              <div><div style={{ color: colors.success, fontSize: 18, fontWeight: 600 }}>{result.kept}</div><div>keys kept</div></div>
              <div><div style={{ color: colors.error, fontSize: 18, fontWeight: 600 }}>{result.dropped}</div><div>keys dropped</div></div>
            </div>
          </div>
        )}

        <div style={{ marginTop: `${spacing.lg}px`, display: 'flex', justifyContent: 'center' }}>
          <button onClick={onClose} style={{ padding: `${spacing.sm}px ${spacing.xl}px`, borderRadius: `${radius.md}px`, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text.primary, fontSize: 14, cursor: 'pointer', minWidth: 140 }}>Close</button>
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
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupMode, setBackupMode] = useState(null); // 'export' | 'import' | null
  const [storageOpen, setStorageOpen] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [storageBreakdown, setStorageBreakdown] = useState(null);
  const [storageAnalyze, setStorageAnalyze] = useState(null);
  const [reclaimResult, setReclaimResult] = useState(null);
  const [reclaimConfirm, setReclaimConfirm] = useState(false);
  const [storageError, setStorageError] = useState(null);
  const [storageModal, setStorageModal] = useState(null); // 'breakdown' | 'analyze' | 'result' | null

  // Profile state
  const [name, setName] = useState('');
  const [savedName, setSavedName] = useState('');
  const [avatar, setAvatar] = useState(null);
  const [showPicker, setShowPicker] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [nameStatus, setNameStatus] = useState(null);
  const [photoLoading, setPhotoLoading] = useState(false);

  // PIN state
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinStatus, setPinStatus] = useState(null);
  const [currentPin, setCurrentPin] = useState(null);
  const [pinRevealed, setPinRevealed] = useState(false);
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

    window.callBare('pin:get')
      .then(({ pin }) => { if (pin) setCurrentPin(pin); })
      .catch(() => {});
  }, []);

  // Auto-hide revealed PIN when Override PIN section collapses.
  useEffect(() => {
    if (!pinOpen) setPinRevealed(false);
  }, [pinOpen]);

  async function handleNameSave() {
    const trimmed = name.trim();
    if (!trimmed || trimmed === savedName) return;
    setSavingName(true);
    setNameStatus(null);
    try {
      await window.callBare('identity:setName', { name: trimmed });
      setSavedName(trimmed);
      setNameStatus('success');
      setTimeout(() => setNameStatus((s) => (s === 'success' ? null : s)), 2000);
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

  async function handlePickPhoto() {
    setPhotoLoading(true);
    try {
      const av = await pickPhoto();
      if (av) {
        await window.callBare('identity:setAvatar', { avatar: av });
        setAvatar(av);
      }
    } catch { /* cancelled or error */ }
    setPhotoLoading(false);
  }

  async function handleRemovePhoto() {
    setPhotoLoading(true);
    try {
      await window.callBare('identity:setAvatar', { avatar: null });
      setAvatar(null);
    } catch { /* error */ }
    setPhotoLoading(false);
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
        setCurrentPin(newPin);
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


  function formatBytes(n) {
    if (!n || n < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let u = 0;
    let v = n;
    while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
    return v.toFixed(v < 10 && u > 0 ? 1 : 0) + ' ' + units[u];
  }

  async function handleStorageBreakdown() {
    setStorageError(null);
    setStorageBusy(true);
    try {
      const res = await window.callBare('storage:breakdown');
      setStorageBreakdown(res);
      setStorageModal('breakdown');
    } catch (e) {
      setStorageError(e.message || 'Failed to read storage');
    }
    setStorageBusy(false);
  }

  async function handleStorageAnalyze() {
    setStorageError(null);
    setStorageBusy(true);
    try {
      const res = await window.callBare('storage:analyze');
      setStorageAnalyze(res);
      setStorageModal('analyze');
    } catch (e) {
      setStorageError(e.message || 'Failed to analyze storage');
    }
    setStorageBusy(false);
  }

  async function handleStorageReclaim() {
    setStorageError(null);
    setStorageBusy(true);
    setReclaimConfirm(false);
    try {
      const res = await window.callBare('storage:rebuild');
      setReclaimResult(res);
      try { setStorageBreakdown(await window.callBare('storage:breakdown')); } catch {}
      try { setStorageAnalyze(await window.callBare('storage:analyze')); } catch {}
      setStorageModal('result');
    } catch (e) {
      setStorageError(e.message || 'Reclaim failed');
    }
    setStorageBusy(false);
  }

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
      <h2 style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.lg}px`, textAlign: 'center' }}>Settings</h2>

      {/* Profile */}
      <section style={{ marginBottom: `${spacing.xxl}px` }}>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: `${spacing.lg}px` }}>
          <Avatar avatar={avatar} name={savedName} size={80} onClick={() => setShowPicker(true)} />
          <div style={{ display: 'flex', gap: '8px', marginTop: `${spacing.sm}px` }}>
            <button
              onClick={() => { window.callBare('haptic:tap'); handlePickPhoto(); }}
              disabled={photoLoading}
              style={{ fontSize: '12px', padding: '5px 14px', borderRadius: `${radius.md}px`, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text.primary, cursor: photoLoading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '5px', opacity: photoLoading ? 0.5 : 1 }}
            >
              <Icon name="ImageSquare" size={14} color={colors.text.primary} /> Photo
            </button>
            {avatar && avatar.type === 'custom' && (
              <button
                onClick={() => { window.callBare('haptic:tap'); handleRemovePhoto(); }}
                disabled={photoLoading}
                style={{ fontSize: '12px', padding: '5px 14px', borderRadius: `${radius.md}px`, border: '1px solid #D45F7A', background: 'transparent', color: '#D45F7A', cursor: photoLoading ? 'wait' : 'pointer', opacity: photoLoading ? 0.5 : 1 }}
              >
                Remove
              </button>
            )}
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
              onBlur={handleNameSave}
              placeholder="e.g. Mom"
              style={inputStyle}
            />
          </label>
          {savingName && <p style={{ color: colors.text.muted, fontSize: '13px', margin: 0 }}>Saving...</p>}
          {!savingName && nameStatus === 'success' && <p style={{ color: colors.success, fontSize: '13px', margin: 0 }}>Saved.</p>}
          {nameStatus === 'error' && <p style={{ color: colors.error, fontSize: '13px', margin: 0 }}>Failed to save name.</p>}
        </div>
      </section>

      {/* Override PIN */}
      <div data-tour-id="settings-override-pin">
      <Collapsible title="Override PIN" icon="LockSimple" open={pinOpen} onToggle={() => setPinOpen(o => !o)} maxHeight="350px" {...collapsibleProps}>
        <p style={{ fontSize: '12px', color: colors.text.muted, marginBottom: `${spacing.md}px`, marginTop: 0 }}>
          Children enter this PIN on the block overlay to get temporary access. The PIN is hashed before leaving this device.
        </p>
        {currentPin && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: `${spacing.sm}px`, padding: `${spacing.sm}px ${spacing.md}px`, backgroundColor: colors.surface.base, borderRadius: `${radius.md}px`, marginBottom: `${spacing.md}px` }}>
            <span style={{ fontSize: '14px', color: colors.text.secondary }}>
              Current PIN: <span style={{ fontFamily: 'monospace', fontSize: '16px', color: colors.text.primary, letterSpacing: '2px' }}>{pinRevealed ? currentPin : '••••'}</span>
            </span>
            <button
              type="button"
              onClick={() => { window.callBare('haptic:tap'); setPinRevealed(v => !v); }}
              style={{ display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`, background: 'none', border: 'none', padding: `${spacing.xs}px`, cursor: 'pointer', color: colors.text.muted, fontSize: '13px' }}
              aria-label={pinRevealed ? 'Hide current PIN' : 'Show current PIN'}
            >
              <Icon name={pinRevealed ? 'EyeSlash' : 'Eye'} size={18} color={colors.text.muted} />
              {pinRevealed ? 'Hide' : 'Show'}
            </button>
          </div>
        )}
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
          <Button type="submit" style={{ alignSelf: 'center' }} aria-label="Save PIN">
            Save PIN
          </Button>
        </form>
      </Collapsible>
      </div>

      {/* Appearance */}
      {settingsLoaded && (
        <Collapsible title="Appearance" icon="SunDim" open={appearanceOpen} onToggle={() => setAppearanceOpen(o => !o)} maxHeight="200px" {...collapsibleProps}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
              <Icon name={currentTheme === 'dark' ? 'Moon' : 'SunDim'} size={20} color={colors.text.primary} />
              <span style={{ fontSize: '14px', color: colors.text.primary }}>{currentTheme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
            </div>
            <Toggle checked={currentTheme === 'dark'} onChange={(checked) => setTheme(checked ? 'dark' : 'light')} />
          </div>
        </Collapsible>
      )}

      {/* Time Request Options */}
      {settingsLoaded && (
        <Collapsible title="Time Request Options" icon="Clock" open={timeOptsOpen} onToggle={() => setTimeOptsOpen(o => !o)} maxHeight="200px" {...collapsibleProps}>
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
        <Collapsible title="Warning Notifications" icon="Bell" open={warningOpen} onToggle={() => setWarningOpen(o => !o)} maxHeight="200px" {...collapsibleProps}>
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

      {/* Device Backup */}
      {settingsLoaded && (
        <Collapsible title="Device Backup" icon="Export" open={backupOpen} onToggle={() => setBackupOpen(o => !o)} maxHeight="220px" {...collapsibleProps}>
          <div style={{ fontSize: '13px', color: colors.text.muted, marginBottom: `${spacing.sm}px` }}>
            Save your full parent state (identity, children, policies) to migrate to a new device. To restore a backup, install the app on a fresh device and choose "Restore parent from backup" on the welcome screen.
          </div>
          <div style={{ display: 'flex', justifyContent: 'center' }}>
            <Button variant="secondary" icon="Export" onClick={() => { window.callBare('haptic:tap'); setBackupMode('export'); }}>Export backup</Button>
          </div>
        </Collapsible>
      )}

      <DeviceBackupModal
        visible={backupMode !== null}
        mode={backupMode || 'export'}
        onClose={() => setBackupMode(null)}
      />

      {/* Storage */}
      <Collapsible title="Storage" icon="Trash" open={storageOpen} onToggle={() => setStorageOpen(o => !o)} maxHeight="400px" {...collapsibleProps}>
        <p style={{ fontSize: '12px', color: colors.text.muted, marginBottom: `${spacing.md}px`, marginTop: 0 }}>
          The local database grows over time as telemetry (usage reports, alerts, sessions) accumulates. Check the current footprint and reclaim disk when it gets large.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px`, alignItems: 'center' }}>
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); handleStorageBreakdown(); }} disabled={storageBusy} style={{ minWidth: '200px' }}>Storage Breakdown</Button>
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); handleStorageAnalyze(); }} disabled={storageBusy} style={{ minWidth: '200px' }}>Analyze Reclaimable</Button>
          <Button onClick={() => { window.callBare('haptic:tap'); setReclaimConfirm(true); }} disabled={storageBusy || !storageAnalyze} style={{ minWidth: '200px' }}>Reclaim Storage</Button>
        </div>
        {storageBusy && <p style={{ fontSize: '13px', color: colors.text.muted, margin: `${spacing.md}px 0 0`, textAlign: 'center' }}>Working...</p>}
        {storageError && <p style={{ fontSize: '13px', color: colors.error, margin: `${spacing.md}px 0 0`, textAlign: 'center' }}>{storageError}</p>}
      </Collapsible>

      <StorageModal
        modal={storageModal}
        onClose={() => setStorageModal(null)}
        breakdown={storageBreakdown}
        analyze={storageAnalyze}
        result={reclaimResult}
        colors={colors}
        typography={typography}
        spacing={spacing}
        radius={radius}
        formatBytes={formatBytes}
      />

      {reclaimConfirm && (
        <div onClick={() => setReclaimConfirm(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: `${spacing.lg}px` }}>
          <div onClick={(e) => e.stopPropagation()} style={{ backgroundColor: colors.surface.card, borderRadius: `${radius.lg}px`, padding: `${spacing.lg}px`, maxWidth: 420, width: '100%', border: `1px solid ${colors.border}` }}>
            <h3 style={{ ...typography.subheading, color: colors.text.primary, margin: 0, marginBottom: `${spacing.md}px`, textAlign: 'center' }}>Reclaim Storage?</h3>
            <p style={{ fontSize: '13px', color: colors.text.secondary, margin: 0, marginBottom: `${spacing.lg}px`, lineHeight: 1.5, textAlign: 'center' }}>
              This permanently deletes historical usage reports, alerts, override grants, bypass events and session logs. Identity, children, policies and pending requests are preserved.
            </p>
            <div style={{ display: 'flex', gap: `${spacing.sm}px`, justifyContent: 'center' }}>
              <Button variant="secondary" onClick={() => setReclaimConfirm(false)} style={{ flex: 1, maxWidth: 160 }}>Cancel</Button>
              <Button onClick={() => { window.callBare('haptic:tap'); handleStorageReclaim(); }} style={{ flex: 1, maxWidth: 160 }}>Reclaim now</Button>
            </div>
          </div>
        </div>
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
            style={{ alignSelf: 'center' }}
          >
            Save Settings
          </Button>
        </div>
      )}
    </div>
  );
}
