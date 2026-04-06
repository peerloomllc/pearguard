import React, { useEffect, useState, useRef } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import QRCode from 'qrcode';

export default function InviteCard({ onConnected, onDismiss }) {
  const { colors, typography, spacing, radius, shadow } = useTheme();
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    window.callBare('invite:generate')
      .then(setInvite)
      .catch(() => setError('Failed to generate invite. Please try again.'));

    const unsub = window.onBareEvent('child:connected', (data) => {
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

  function handleShare() {
    if (!invite?.inviteLink || sharing) return;
    setSharing(true);
    window.callBare('share:text', { text: invite.inviteLink })
      .finally(() => setSharing(false));
  }

  function handleCopy() {
    if (!invite?.inviteLink) return;
    window.callBare('clipboard:copy', { text: invite.inviteLink }).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  const cardStyle = {
    backgroundColor: colors.surface.card,
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.lg}px`,
    padding: `${spacing.base}px`,
    marginBottom: `${spacing.md}px`,
    boxShadow: shadow,
  };

  if (error) {
    return (
      <div style={cardStyle}>
        <p style={{ ...typography.body, color: colors.error, margin: 0, marginBottom: `${spacing.md}px` }}>{error}</p>
        <Button variant="secondary" onClick={onDismiss}>Dismiss</Button>
      </div>
    );
  }

  if (!invite) {
    return (
      <div style={cardStyle}>
        <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0 }}>Generating invite...</p>
      </div>
    );
  }

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: `${spacing.sm}px` }}>
        <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0 }}>
          Add a Child Device
        </h3>
        <button
          onClick={onDismiss}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label="Dismiss invite"
        >
          <Icon name="X" size={20} color={colors.text.muted} />
        </button>
      </div>

      <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0, marginBottom: `${spacing.base}px` }}>
        Scan this QR code on the child's device, or share the link.
      </p>

      <div style={{
        display: 'flex', justifyContent: 'center',
        marginBottom: `${spacing.base}px`, padding: `${spacing.md}px`,
        backgroundColor: '#ffffff', borderRadius: `${radius.md}px`,
      }}>
        <canvas ref={canvasRef} />
      </div>

      <div style={{ display: 'flex', gap: `${spacing.sm}px`, marginBottom: `${spacing.md}px` }}>
        <Button variant="primary" icon="ShareNetwork" onClick={handleShare} disabled={sharing} style={{ flex: 1 }}>
          Share Link
        </Button>
        <Button variant="secondary" icon="Copy" onClick={handleCopy} style={{ flex: 1 }}>
          {copied ? 'Copied!' : 'Copy Link'}
        </Button>
      </div>

      <p style={{ ...typography.caption, color: colors.text.muted, fontStyle: 'italic', margin: 0, textAlign: 'center' }}>
        Waiting for child to connect...
      </p>
    </div>
  );
}
