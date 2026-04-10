import React, { useState } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';

export default function JoinCoparentCard({ onConnected, onDismiss }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [state, setState] = useState('idle'); // 'idle' | 'connecting' | 'success' | 'error'
  const [error, setError] = useState(null);
  const [linkInput, setLinkInput] = useState('');

  async function handleScan() {
    setState('idle');
    setError(null);
    try {
      const url = await window.callBare('qr:scan');
      setState('connecting');
      await window.callBare('coparent:acceptInvite', [url]);
      setState('success');
      setTimeout(() => onConnected(), 1500);
    } catch (e) {
      if (e.message === 'cancelled') {
        setState('idle');
      } else {
        setState('error');
        setError(e.message);
      }
    }
  }

  async function handlePaste() {
    const url = linkInput.trim();
    if (!url.startsWith('pear://pearguard/coparent?t=')) {
      setState('error');
      setError('Not a valid co-parent invite link');
      return;
    }
    setState('connecting');
    setError(null);
    try {
      await window.callBare('coparent:acceptInvite', [url]);
      setState('success');
      setTimeout(() => onConnected(), 1500);
    } catch (e) {
      setState('error');
      setError(e.message);
    }
  }

  const cardStyle = {
    backgroundColor: colors.surface.card,
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.lg}px`,
    padding: `${spacing.base}px`,
    marginBottom: `${spacing.md}px`,
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: `${spacing.sm}px` }}>
        <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0 }}>
          Join as Co-Parent
        </h3>
        <button
          onClick={onDismiss}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label="Dismiss"
        >
          <Icon name="X" size={20} color={colors.text.muted} />
        </button>
      </div>

      <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0, marginBottom: `${spacing.base}px` }}>
        If another parent already set up your child's device, ask them to share a co-parent invite. This lets you both manage the same child with shared policies.
      </p>

      {state === 'idle' && (
        <>
          <div style={{ display: 'flex', gap: `${spacing.sm}px`, marginBottom: `${spacing.md}px` }}>
            <Button variant="primary" icon="QrCode" onClick={() => { window.callBare('haptic:tap'); handleScan(); }} style={{ flex: 1 }}>
              Scan QR Code
            </Button>
          </div>

          <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
            <input
              type="text"
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              placeholder="Paste invite link"
              style={{
                flex: 1, padding: `${spacing.sm}px ${spacing.md}px`,
                backgroundColor: colors.surface.elevated, color: colors.text.primary,
                border: `1px solid ${colors.border}`, borderRadius: `${radius.md}px`,
                ...typography.body, outline: 'none',
              }}
            />
            <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); handlePaste(); }} disabled={!linkInput.trim()}>
              Join
            </Button>
          </div>
        </>
      )}

      {state === 'connecting' && (
        <p style={{ ...typography.caption, color: colors.text.muted, fontStyle: 'italic', margin: 0, textAlign: 'center' }}>
          Connecting to co-parent...
        </p>
      )}

      {state === 'success' && (
        <p style={{ ...typography.caption, color: colors.success, margin: 0, textAlign: 'center' }}>
          Connected! Loading child...
        </p>
      )}

      {state === 'error' && (
        <div>
          <p style={{ ...typography.caption, color: colors.error, margin: 0, marginBottom: `${spacing.sm}px` }}>{error}</p>
          <Button variant="secondary" onClick={() => { setState('idle'); setError(null); }}>
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}
