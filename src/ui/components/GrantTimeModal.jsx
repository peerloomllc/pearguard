import React, { useState } from 'react';
import { useTheme } from '../theme.js';
import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';

// Bonus-time durations offered when a parent hands out screen time.
const GRANT_OPTIONS = [
  { label: '15m', seconds: 15 * 60 },
  { label: '30m', seconds: 30 * 60 },
  { label: '1h', seconds: 60 * 60 },
  { label: '2h', seconds: 120 * 60 },
];

function grantLabel(seconds) {
  const m = seconds / 60;
  return m >= 60 ? `${m / 60}h` : `${m}m`;
}

// Proactive "grant bonus time" sheet, shared by the dashboard cards and the
// child-detail header. Grants a device-wide screen-time top-up for today with no
// pending request (bare's time:grantGeneral synthesizes an id for child-side
// idempotency). Schedules, per-app limits and blocked apps are unaffected.
export default function GrantTimeModal({ child, visible, onClose }) {
  const { colors, typography, spacing } = useTheme();
  const [granting, setGranting] = useState(false);
  const [grantedSeconds, setGrantedSeconds] = useState(null);

  function close() {
    setGranting(false);
    setGrantedSeconds(null);
    onClose();
  }

  async function handleGrant(seconds) {
    window.callBare('haptic:tap');
    setGranting(true);
    try {
      await window.callBare('time:grantGeneral', { childPublicKey: child.publicKey, extraSeconds: seconds });
      setGrantedSeconds(seconds);
    } catch (e) {
      console.error('grant bonus time failed:', e);
    } finally {
      setGranting(false);
    }
  }

  return (
    <Modal
      visible={visible}
      onClose={close}
      title={grantedSeconds ? 'Bonus time granted' : `Grant bonus time to ${child?.displayName}?`}
      footer={grantedSeconds
        ? <Button onClick={() => { window.callBare('haptic:tap'); close(); }} style={{ flex: 1 }}>Done</Button>
        : <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); close(); }} style={{ flex: 1 }}>Cancel</Button>}
    >
      {grantedSeconds ? (
        <div style={{ textAlign: 'center', ...typography.body, color: colors.text.primary }}>
          Added <strong>{grantLabel(grantedSeconds)}</strong> to {child?.displayName}'s screen time for today.
        </div>
      ) : (
        <>
          <div style={{ textAlign: 'center', marginBottom: `${spacing.md}px`, ...typography.caption, color: colors.text.secondary }}>
            Tops up today's screen-time budget. Schedules, per-app limits and blocked apps still apply.
          </div>
          <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
            {GRANT_OPTIONS.map((opt) => (
              <Button
                key={opt.seconds}
                variant="secondary"
                disabled={granting}
                onClick={() => handleGrant(opt.seconds)}
                style={{ flex: 1 }}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
