import React, { useEffect, useState, useRef } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import QRCode from 'qrcode';

export default function InviteCard({ onConnected, onDismiss }) {
  const { colors, typography, spacing, radius, shadow } = useTheme();
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [uiMode, setUiMode] = useState('show'); // 'show' | 'scan'
  const [scanState, setScanState] = useState('idle'); // 'idle' | 'scanning' | 'connecting' | 'error'
  const [scanError, setScanError] = useState(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    if (uiMode !== 'show') return;
    window.callBare('invite:generate')
      .then(setInvite)
      .catch(() => setError('Failed to generate invite. Please try again.'));

    const unsub = window.onBareEvent('child:connected', (data) => {
      onConnected(data);
    });
    return unsub;
  }, [uiMode, onConnected]);

  useEffect(() => {
    if (uiMode !== 'scan') return;
    const unsub = window.onBareEvent('child:connected', (data) => {
      onConnected(data);
    });
    return unsub;
  }, [uiMode, onConnected]);

  useEffect(() => {
    if (uiMode === 'show' && invite?.inviteLink && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, invite.inviteLink, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch(console.error);
    }
  }, [uiMode, invite]);

  const handleShare = () => {
    if (!invite?.inviteLink) return;
    window.callBare('haptic:tap');
    window.callBare('share:text', {
      text: `Tap this link on the child device to pair with PearGuard:\n\n${invite.inviteLink}`,
    });
  };

  async function handleScan() {
    setScanError(null);
    setScanState('scanning');
    try {
      const url = await window.callBare('qr:scan');
      setScanState('connecting');
      const result = await window.callBare('acceptChildInvite', [url]);
      if (result && result.alreadyPaired) {
        onConnected(result);
      }
      // On new pair, wait for child:connected event (subscribed above)
    } catch (e) {
      if (e.message === 'cancelled') {
        setScanState('idle');
      } else {
        setScanState('error');
        setScanError(e.message);
      }
    }
  }

  const cardStyle = {
    position: 'relative',
    backgroundColor: colors.surface.card,
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.lg}px`,
    padding: `${spacing.base}px`,
    marginBottom: `${spacing.md}px`,
    boxShadow: shadow,
  };

  const dismissButton = (
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
  );

  if (error) {
    return (
      <div style={cardStyle}>
        <p style={{ ...typography.body, color: colors.error, margin: 0, marginBottom: `${spacing.md}px` }}>{error}</p>
        <Button variant="secondary" onClick={onDismiss}>Dismiss</Button>
      </div>
    );
  }

  if (uiMode === 'scan') {
    return (
      <div style={cardStyle}>
        <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
          Scan Child's QR Code
        </h3>
        {dismissButton}

        {scanState === 'idle' && (
          <>
            <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0, marginBottom: `${spacing.base}px`, textAlign: 'center' }}>
              Ask your child to open PearGuard and tap "Show My QR Code", then scan it here.
            </p>
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: `${spacing.sm}px` }}>
              <Button icon="QrCode" onClick={() => { window.callBare('haptic:tap'); handleScan(); }}>
                Scan QR Code
              </Button>
            </div>
          </>
        )}

        {scanState === 'scanning' && (
          <p style={{ color: colors.text.muted, fontSize: '14px', textAlign: 'center', margin: 0 }}>
            Opening camera...
          </p>
        )}

        {scanState === 'connecting' && (
          <p style={{ color: colors.text.muted, fontSize: '14px', textAlign: 'center', margin: 0 }}>
            Connecting to child...
          </p>
        )}

        {scanState === 'error' && (
          <>
            <p style={{ color: colors.error, fontSize: '13px', margin: 0, textAlign: 'center' }}>{scanError}</p>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: `${spacing.sm}px` }}>
              <Button onClick={() => { window.callBare('haptic:tap'); setScanState('idle'); }}>Try Again</Button>
            </div>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: `${spacing.base}px` }}>
          <button
            onClick={() => { setScanState('idle'); setScanError(null); setUiMode('show'); }}
            style={{ background: 'none', border: 'none', color: colors.primary, fontSize: '13px', cursor: 'pointer', padding: 0 }}
          >
            Show my QR instead
          </button>
        </div>
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
      <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
        Add a Child Device
      </h3>
      {dismissButton}

      <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0, marginBottom: `${spacing.base}px`, textAlign: 'center' }}>
        Scan this QR code on the child's device.
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

      <p style={{ ...typography.caption, color: colors.text.muted, fontStyle: 'italic', margin: 0, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
        Waiting for child to connect...
      </p>

      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <button
          onClick={() => setUiMode('scan')}
          style={{ background: 'none', border: 'none', color: colors.primary, fontSize: '13px', cursor: 'pointer', padding: 0 }}
        >
          Or scan child's QR instead
        </button>
      </div>
    </div>
  );
}
