import React, { useEffect, useState, useRef } from 'react';
import { useTheme } from '../theme.js';
import QRCode from 'qrcode';

export default function AddChildFlow({ onConnected, onCancel }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [sharing, setSharing] = useState(false);
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

  // Render QR code to canvas once invite arrives
  useEffect(() => {
    if (invite?.inviteLink && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, invite.inviteLink, {
        width: 240,
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

  if (error) {
    return (
      <div style={{ padding: `${spacing.base}px` }}>
        <p style={{ color: colors.error, marginBottom: `${spacing.md}px` }}>{error}</p>
        <button
          style={{ padding: '10px 20px', border: `1px solid ${colors.border}`, borderRadius: `${radius.md}px`, background: colors.surface.card, cursor: 'pointer', fontSize: '14px', color: colors.text.primary }}
          onClick={onCancel}
        >
          Go Back
        </button>
      </div>
    );
  }

  if (!invite) {
    return (
      <div style={{ padding: `${spacing.base}px` }}>
        <p style={{ color: colors.text.secondary, fontSize: '13px', marginBottom: `${spacing.base}px` }}>Generating invite&#8230;</p>
      </div>
    );
  }

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <h3 style={{ fontSize: '18px', fontWeight: '700', marginBottom: `${spacing.sm}px`, color: colors.text.primary }}>Add a Child Device</h3>
      <p style={{ color: colors.text.secondary, fontSize: '13px', marginBottom: `${spacing.base}px` }}>
        Ask the child to scan this QR code, or share the link below via SMS or a messaging app.
      </p>

      <div style={{
        display: 'flex',
        justifyContent: 'center',
        marginBottom: `${spacing.base}px`,
        padding: `${spacing.md}px`,
        backgroundColor: colors.surface.card,
        borderRadius: `${radius.md}px`,
        border: `1px solid ${colors.border}`,
      }}>
        <canvas ref={canvasRef} />
      </div>

      <p style={{ fontSize: '13px', color: colors.text.secondary, marginBottom: '4px' }}>Or share this link:</p>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: `${spacing.sm}px`,
        marginBottom: `${spacing.xl}px`,
        padding: '10px',
        backgroundColor: colors.surface.elevated,
        borderRadius: `${radius.md}px`,
        border: `1px solid ${colors.border}`,
      }}>
        <span style={{ flex: 1, fontSize: '11px', color: colors.text.primary, wordBreak: 'break-all' }}>{invite.inviteLink}</span>
        <button
          style={{
            flexShrink: 0,
            padding: '6px 12px',
            border: 'none',
            borderRadius: `${radius.sm}px`,
            backgroundColor: colors.primary,
            color: '#FFFFFF',
            cursor: 'pointer',
            fontSize: '13px',
          }}
          onClick={handleShare}
          disabled={sharing}
        >
          Share
        </button>
      </div>

      <p style={{ fontSize: '14px', color: colors.text.muted, fontStyle: 'italic', marginBottom: `${spacing.base}px` }}>Waiting for child to connect&#8230;</p>
      <button
        style={{
          padding: '10px 20px',
          border: `1px solid ${colors.border}`,
          borderRadius: `${radius.md}px`,
          background: colors.surface.card,
          cursor: 'pointer',
          fontSize: '14px',
          color: colors.text.primary,
        }}
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}
