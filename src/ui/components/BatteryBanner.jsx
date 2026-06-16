import React, { useState, useEffect, useCallback } from 'react';
import Button from './primitives/Button.jsx';
import Icon from '../icons.js';
import { useTheme } from '../theme.js';

const AMBER = '#F5A623';

// Generic, manufacturer-agnostic guidance. We deliberately do not deep-link into
// per-OEM autostart screens (those intents are undocumented and break across OS
// updates); instead we point the user at the system battery prompt and tell them
// where some makers hide the extra toggles.
function BatteryHelpModal({ onAllow, onClose }) {
  const { colors, typography, spacing, radius } = useTheme();
  return (
    <div style={{
      position: 'fixed', inset: 0,
      backgroundColor: 'rgba(0,0,0,0.75)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: `${spacing.xl}px`, zIndex: 610,
    }}>
      <div style={{
        backgroundColor: colors.surface.card,
        border: `1px solid ${colors.border}`,
        borderRadius: `${radius.lg}px`,
        padding: `${spacing.xxl}px ${spacing.xl}px`,
        width: '100%', maxWidth: '380px',
        maxHeight: '80vh', overflowY: 'auto', WebkitOverflowScrolling: 'touch',
      }}>
        <div style={{ textAlign: 'center' }}>
          <Icon name="Warning" size={32} color={AMBER} />
          <h2 style={{ ...typography.heading, color: colors.text.primary, marginTop: `${spacing.md}px`, marginBottom: `${spacing.sm}px` }}>
            Keep PearGuard running
          </h2>
        </div>
        <p style={{ ...typography.body, color: colors.text.secondary, lineHeight: '1.6', marginTop: 0, marginBottom: `${spacing.md}px` }}>
          To keep monitoring your child's device, PearGuard needs to stay
          connected in the background. Battery saver and power management can
          shut it down.
        </p>
        <p style={{ ...typography.body, color: colors.text.primary, fontWeight: '600', marginBottom: `${spacing.xs}px` }}>
          1. Allow background activity
        </p>
        <p style={{ ...typography.body, color: colors.text.secondary, lineHeight: '1.6', marginTop: 0, marginBottom: `${spacing.md}px` }}>
          Tap the button below and choose Allow when asked to let PearGuard run
          without battery restrictions.
        </p>
        <p style={{ ...typography.body, color: colors.text.primary, fontWeight: '600', marginBottom: `${spacing.xs}px` }}>
          2. Check your phone's extra settings
        </p>
        <p style={{ ...typography.body, color: colors.text.secondary, lineHeight: '1.6', marginTop: 0, marginBottom: `${spacing.md}px` }}>
          Some manufacturers add their own controls that you have to enable by
          hand:
        </p>
        <ul style={{ ...typography.body, color: colors.text.secondary, lineHeight: '1.6', marginTop: 0, marginBottom: `${spacing.xl}px`, paddingLeft: `${spacing.xl}px` }}>
          <li>Samsung: Settings &gt; Battery &gt; Background usage limits &gt; remove PearGuard from "Sleeping apps".</li>
          <li>Xiaomi / Redmi / POCO: Settings &gt; Apps &gt; PearGuard &gt; Autostart on, and set Battery saver to "No restrictions".</li>
          <li>OnePlus / Oppo / Realme: Settings &gt; Battery &gt; allow background activity / disable "Sleep standby optimization".</li>
          <li>Huawei: Settings &gt; Apps &gt; PearGuard &gt; Battery &gt; turn off "Manage automatically" and allow background.</li>
        </ul>
        <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
          <Button onClick={onAllow} style={{ width: '100%' }}>
            Allow background activity
          </Button>
          <Button variant="secondary" onClick={onClose} style={{ width: '100%' }}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function BatteryBanner() {
  const { colors, typography, spacing, radius } = useTheme();
  const [whitelisted, setWhitelisted] = useState(true); // assume ok until checked
  const [dismissed, setDismissed] = useState(false);
  const [showHelp, setShowHelp] = useState(false);

  const refresh = useCallback(() => {
    window.callBare('battery:status')
      .then((s) => setWhitelisted(s?.whitelisted !== false))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Re-check when the user returns from the system settings screen.
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const requestAllow = useCallback(() => {
    window.callBare('battery:request')
      .then((r) => {
        if (r?.granted) setWhitelisted(true);
        // Not granted yet usually means the system prompt is open; visibilitychange
        // will re-check when the user comes back.
      })
      .catch(() => {});
  }, []);

  if (whitelisted || dismissed) return null;

  return (
    <>
      <div style={{
        backgroundColor: `${AMBER}1A`,
        borderBottom: `1px solid ${AMBER}55`,
        padding: `${spacing.md}px ${spacing.base}px`,
        display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`,
      }}>
        <Icon name="Warning" size={20} color={AMBER} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{ ...typography.body, color: colors.text.primary, margin: 0, fontWeight: '600' }}>
            Battery saver may stop monitoring
          </p>
          <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0 }}>
            Allow PearGuard to run in the background so it keeps reporting.
          </p>
        </div>
        <button
          onClick={() => setShowHelp(true)}
          style={{
            background: AMBER, border: 'none', borderRadius: `${radius.sm}px`,
            color: '#1A1206', fontWeight: '600', fontSize: '13px',
            padding: `${spacing.xs}px ${spacing.md}px`, cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          Fix
        </button>
        <button
          onClick={() => setDismissed(true)}
          aria-label="Dismiss"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.text.muted, padding: `${spacing.xs}px`, lineHeight: 1 }}
        >
          <Icon name="X" size={16} color={colors.text.muted} />
        </button>
      </div>
      {showHelp && (
        <BatteryHelpModal
          onAllow={() => { requestAllow(); setShowHelp(false); }}
          onClose={() => setShowHelp(false)}
        />
      )}
    </>
  );
}
