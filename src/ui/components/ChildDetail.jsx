import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import Avatar from './Avatar.jsx';
import UsageTab from './UsageTab.jsx';
import AppsTab from './AppsTab.jsx';
import ActivityTab from './ActivityTab.jsx';
import RulesTab from './RulesTab.jsx';
import UsageReports from './UsageReports.jsx';
import Modal from './primitives/Modal.jsx';

const TABS = [
  { key: 'usage', label: 'Usage', icon: 'ChartBar' },
  { key: 'apps', label: 'Apps', icon: 'SquaresFour' },
  { key: 'activity', label: 'Activity', icon: 'ListBullets' },
  { key: 'rules', label: 'Rules', icon: 'Shield' },
];

const TAB_COMPONENTS = { usage: UsageTab, apps: AppsTab, activity: ActivityTab, rules: RulesTab };

export default function ChildDetail({ child, initialTab, onBack }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [tab, setTab] = useState(initialTab || 'usage');
  // Listen for notification deep link events directly so we always switch tab,
  // even when the same tab value is requested consecutively (prop wouldn't change).
  useEffect(() => {
    const unsub = window.onBareEvent('navigate:child:alerts', (data) => {
      if (data?.tab) setTab(data.tab);
    });
    return () => unsub();
  }, []);
  const [showReports, setShowReports] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmLock, setConfirmLock] = useState(false);
  const [locked, setLocked] = useState(child.locked || false);

  async function handleRemove() {
    window.callBare('haptic:tap');
    await window.callBare('child:unpair', { childPublicKey: child.publicKey });
    onBack();
  }

  function onLockButtonClick() {
    window.callBare('haptic:tap');
    if (locked) {
      applyLock(false);
    } else {
      setConfirmLock(true);
    }
  }

  async function applyLock(newLocked) {
    await window.callBare('policy:setLock', { childPublicKey: child.publicKey, locked: newLocked });
    setLocked(newLocked);
  }

  async function handleConfirmLock() {
    window.callBare('haptic:tap');
    setConfirmLock(false);
    await applyLock(true);
  }

  // Android back gesture: close UsageReports sub-view
  const backHandler = useCallback(() => {
    if (showReports) {
      setShowReports(false);
      return true;
    }
    return false;
  }, [showReports]);

  useEffect(() => {
    window.__registerBackHandler?.(backHandler);
    return () => window.__unregisterBackHandler?.(backHandler);
  }, [backHandler]);

  if (showReports) {
    return <UsageReports childPublicKey={child.publicKey} onBack={() => setShowReports(false)} />;
  }

  const ActiveComponent = TAB_COMPONENTS[tab] || UsageTab;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.surface.base }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: `${spacing.md}px`,
        padding: `${spacing.md}px ${spacing.base}px`,
        borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}>
          <Icon name="CaretLeft" size={20} color={colors.primary} />
        </button>
        <Avatar avatar={child.avatarThumb} name={child.displayName} size={32} />
        <span style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', flex: 1 }}>
          {child.displayName}
        </span>
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          backgroundColor: child.isOnline ? colors.success : colors.text.muted,
        }} />

        <button
          onClick={onLockButtonClick}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}
          aria-label={locked ? 'Unlock device' : 'Lock device'}
        >
          <Icon name={locked ? 'LockSimple' : 'LockSimpleOpen'} size={20} color={locked ? colors.error : colors.text.muted} />
        </button>

        <button
          onClick={() => { window.callBare('haptic:tap'); setConfirmRemove(true); }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}
          aria-label="Remove child"
        >
          <Icon name="Trash" size={18} color={colors.text.muted} />
        </button>
      </div>

      {/* Sub-tabs */}
      <div style={{
        display: 'flex', overflowX: 'auto',
        borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
      }}>
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              onClick={() => { window.callBare('haptic:tap'); setTab(t.key); }}
              style={{
                flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`,
                padding: `${spacing.sm + 2}px ${spacing.md + 2}px`,
                border: 'none', background: 'none', cursor: 'pointer',
                borderBottom: `2px solid ${active ? colors.primary : 'transparent'}`,
                ...typography.caption,
                color: active ? colors.primary : colors.text.muted,
                fontWeight: active ? '600' : '400',
                whiteSpace: 'nowrap',
              }}
            >
              <Icon name={t.icon} size={16} color={active ? colors.primary : colors.text.muted} weight={active ? 'fill' : 'regular'} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'usage' ? (
          <UsageTab childPublicKey={child.publicKey} onShowReports={() => setShowReports(true)} />
        ) : (
          <ActiveComponent childPublicKey={child.publicKey} />
        )}
      </div>

      <Modal
        visible={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Unpair from ${child.displayName}?`}
        footer={<>
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); setConfirmRemove(false); }} style={{ flex: 1 }}>Cancel</Button>
          <Button variant="danger" icon="Trash" onClick={handleRemove} style={{ flex: 1 }}>Unpair</Button>
        </>}
      >
        This will remove {child.displayName} from your dashboard. You'll need to re-pair to monitor this device again.
      </Modal>

      <Modal
        visible={confirmLock}
        onClose={() => setConfirmLock(false)}
        title={`Lock ${child.displayName}'s device?`}
        footer={<>
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); setConfirmLock(false); }} style={{ flex: 1 }}>Cancel</Button>
          <Button variant="danger" icon="LockSimple" onClick={handleConfirmLock} style={{ flex: 1 }}>Lock</Button>
        </>}
      >
        <div style={{ textAlign: 'center' }}>
          This will immediately block all apps on {child.displayName}'s device until you unlock it.
        </div>
      </Modal>
    </div>
  );
}
