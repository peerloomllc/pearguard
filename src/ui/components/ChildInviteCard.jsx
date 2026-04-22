import React, { useEffect, useState, useRef } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import QRCode from 'qrcode';

export default function ChildInviteCard({ onConnected, onDismiss }) {
  const { colors, typography, spacing, radius, shadow } = useTheme();
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    window.callBare('child-invite:generate')
      .then(setInvite)
      .catch(() => setError('Failed to generate invite. Please try again.'));

    const unsub = window.onBareEvent('peer:paired', (data) => {
      onConnected(data);
    });
    return unsub;
  }, [onConnected]);

  useEffect(() => {
    if (invite?.inviteLink && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, invite.inviteLink, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch(console.error);
    }
  }, [invite]);

  const handleShare = () => {
    if (!invite?.inviteLink) return;
    window.callBare('haptic:tap');
    window.callBare('share:text', {
      text: `Tap this link on the parent device to pair with PearGuard:\n\n${invite.inviteLink}`,
    });
  };

  const cardStyle = {
    position: 'relative',
    backgroundColor: colors.surface.card,
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.lg}px`,
    padding: `${spacing.base}px`,
    marginBottom: `${spacing.md}px`,
    boxShadow: shadow,
  };

  if (error) {
    return (
      <div style={{ ...cardStyle, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <p style={{ ...typography.body, color: colors.error, margin: 0, marginBottom: `${spacing.md}px`, textAlign: 'center' }}>{error}</p>
        <Button variant="secondary" onClick={onDismiss}>Dismiss</Button>
      </div>
    );
  }

  if (!invite) {
    return (
      <div style={cardStyle}>
        <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0, textAlign: 'center' }}>Generating invite...</p>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
        Pair with Parent
      </h3>
      <button
        onClick={onDismiss}
        style={{
          position: 'absolute', top: `${spacing.base}px`, right: `${spacing.base}px`,
          background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        aria-label="Dismiss invite"
      >
        <Icon name="X" size={20} color={colors.text.muted} />
      </button>

      <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0, marginBottom: `${spacing.base}px`, textAlign: 'center' }}>
        Scan this QR code on the parent's device.
      </p>

      <div style={{
        display: 'flex', justifyContent: 'center',
        marginBottom: `${spacing.base}px`, padding: `${spacing.md}px`,
        backgroundColor: '#ffffff', borderRadius: `${radius.md}px`,
      }}>
        <canvas ref={canvasRef} />
      </div>

      <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
        Or share the link directly (for devices without a camera):
      </p>

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: `${spacing.base}px` }}>
        <Button variant="secondary" icon="ShareNetwork" onClick={handleShare}>Share Link</Button>
      </div>

      <p style={{ ...typography.caption, color: colors.text.muted, fontStyle: 'italic', margin: 0, textAlign: 'center' }}>
        Waiting for parent to scan...
      </p>
    </div>
  );
}
