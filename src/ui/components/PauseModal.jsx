import React, { useState } from 'react';
import { useTheme } from '../theme.js';
import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';

// Free-time / holiday mode — the inverse of a device lock. Suspends ALL
// enforcement (schedules, limits, blocks) until a chosen time. Synced to the
// child over the existing policy:update path and checked first in every block
// gate (src/policy.js isAppBlocked, native AppBlockerModule, desktop evaluator).

const DURATIONS = [
  { label: '1 hour', ms: 60 * 60 * 1000 },
  { label: '2 hours', ms: 2 * 60 * 60 * 1000 },
  { label: '4 hours', ms: 4 * 60 * 60 * 1000 },
];

function endOfToday() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

function formatUntil(ts) {
  try {
    const d = new Date(ts);
    const sameDay = d.toDateString() === new Date().toDateString();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
  } catch {
    return '';
  }
}

export default function PauseModal({ child, pauseUntil, visible, onClose, onChanged }) {
  const { colors, typography, spacing } = useTheme();
  const [busy, setBusy] = useState(false);

  const isPaused = pauseUntil && Date.now() < pauseUntil;

  async function setPause(until) {
    window.callBare('haptic:tap');
    setBusy(true);
    try {
      await window.callBare('policy:setPause', { childPublicKey: child.publicKey, pauseUntil: until });
      onChanged?.(until > Date.now() ? until : 0);
      onClose();
    } catch (e) {
      console.error('set pause failed:', e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={isPaused ? `${child?.displayName} is on free time` : `Pause protection for ${child?.displayName}?`}
      footer={<Button variant="secondary" disabled={busy} onClick={() => { window.callBare('haptic:tap'); onClose(); }} style={{ flex: 1 }}>Close</Button>}
    >
      {isPaused ? (
        <>
          <div style={{ textAlign: 'center', marginBottom: `${spacing.md}px`, ...typography.body, color: colors.text.primary }}>
            All limits, schedules and blocks are suspended until <strong>{formatUntil(pauseUntil)}</strong>.
          </div>
          <Button variant="danger" icon="LockSimple" disabled={busy} onClick={() => setPause(0)} style={{ width: '100%' }}>
            Resume protection now
          </Button>
        </>
      ) : (
        <>
          <div style={{ textAlign: 'center', marginBottom: `${spacing.md}px`, ...typography.caption, color: colors.text.secondary }}>
            Temporarily allow every app - no limits, schedules or blocks - for a sick day, trip or reward. Protection resumes automatically.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
            {DURATIONS.map((d) => (
              <Button key={d.label} variant="secondary" disabled={busy} onClick={() => setPause(Date.now() + d.ms)} style={{ width: '100%' }}>
                {d.label}
              </Button>
            ))}
            <Button variant="secondary" disabled={busy} onClick={() => setPause(endOfToday())} style={{ width: '100%' }}>
              Rest of today
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
