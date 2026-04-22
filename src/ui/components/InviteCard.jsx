import React, { useEffect, useState, useRef } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import QRCode from 'qrcode';

export default function InviteCard({ onConnected, onDismiss }) {
  const { colors, typography, spacing, radius, shadow } = useTheme();
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [uiMode, setUiMode] = useState('methodPicker'); // 'methodPicker' | 'showQr' | 'scan' | 'paste'
  const [scanState, setScanState] = useState('idle'); // 'idle' | 'scanning' | 'connecting' | 'error'
  const [scanError, setScanError] = useState(null);
  const [pasteUrl, setPasteUrl] = useState('');
  const [sharing, setSharing] = useState(false);
  const canvasRef = useRef(null);

  useEffect(() => {
    const unsub = window.onBareEvent('child:connected', (data) => {
      onConnected(data);
    });
    return unsub;
  }, [onConnected]);

  useEffect(() => {
    if (uiMode !== 'showQr') return;
    if (invite) return;
    window.callBare('invite:generate')
      .then(setInvite)
      .catch(() => setError('Failed to generate invite. Please try again.'));
  }, [uiMode, invite]);

  useEffect(() => {
    if (uiMode === 'showQr' && invite?.inviteLink && canvasRef.current) {
      QRCode.toCanvas(canvasRef.current, invite.inviteLink, {
        width: 200,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
      }).catch(console.error);
    }
  }, [uiMode, invite]);

  async function ensureInvite() {
    if (invite?.inviteLink) return invite;
    const generated = await window.callBare('invite:generate');
    setInvite(generated);
    return generated;
  }

  async function handleShare() {
    if (sharing) return;
    window.callBare('haptic:tap');
    setSharing(true);
    try {
      const inv = await ensureInvite();
      if (!inv?.inviteLink) return;
      await window.callBare('share:text', {
        text: `Tap this link on the child device to pair with PearGuard:\n\n${inv.inviteLink}`,
      });
    } catch {
      setError('Failed to generate invite. Please try again.');
    } finally {
      setSharing(false);
    }
  }

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
        setUiMode('methodPicker');
      } else {
        setScanState('error');
        setScanError(e.message);
      }
    }
  }

  async function handlePasteAndPair() {
    const url = pasteUrl.trim();
    if (!url) return;
    window.callBare('haptic:tap');
    setScanError(null);
    setScanState('connecting');
    try {
      const result = await window.callBare('acceptChildInvite', [url]);
      if (result && result.alreadyPaired) {
        onConnected(result);
      }
    } catch (e) {
      setScanState('error');
      setScanError(e.message);
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

  const inputStyle = {
    padding: '10px',
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.md}px`,
    fontSize: '15px',
    backgroundColor: colors.surface.input,
    color: colors.text.primary,
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
            onClick={() => { setScanState('idle'); setScanError(null); setUiMode('methodPicker'); }}
            style={{ background: 'none', border: 'none', color: colors.text.secondary, fontSize: '13px', cursor: 'pointer', padding: 0 }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  if (uiMode === 'paste') {
    return (
      <div style={cardStyle}>
        <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
          Paste Invite Link
        </h3>
        {dismissButton}

        {scanState === 'idle' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
            <input
              type="text"
              value={pasteUrl}
              onChange={(e) => setPasteUrl(e.target.value)}
              placeholder="pear://pearguard/join?..."
              style={inputStyle}
              autoFocus
            />
            <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
              <Button style={{ flex: 1 }} variant="secondary" onClick={() => { setUiMode('methodPicker'); setPasteUrl(''); }}>Cancel</Button>
              <Button style={{ flex: 1 }} onClick={handlePasteAndPair} disabled={!pasteUrl.trim()}>Pair</Button>
            </div>
          </div>
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
      </div>
    );
  }

  if (uiMode === 'showQr') {
    return (
      <div style={cardStyle}>
        <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
          Add a Child Device
        </h3>
        {dismissButton}

        {!invite ? (
          <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0, textAlign: 'center' }}>Generating invite...</p>
        ) : (
          <>
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

            <p style={{ ...typography.caption, color: colors.text.muted, fontStyle: 'italic', margin: 0, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
              Waiting for child to connect...
            </p>
          </>
        )}

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: `${spacing.base}px` }}>
          <button
            onClick={() => setUiMode('methodPicker')}
            style={{ background: 'none', border: 'none', color: colors.text.secondary, fontSize: '13px', cursor: 'pointer', padding: 0 }}
          >
            Back
          </button>
        </div>
      </div>
    );
  }

  // uiMode === 'methodPicker'
  return (
    <div style={cardStyle}>
      <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0, marginBottom: `${spacing.base}px`, textAlign: 'center' }}>
        Add a Child Device
      </h3>
      {dismissButton}

      <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
        <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
          <Button style={{ flex: 1 }} icon="QrCode" onClick={() => { window.callBare('haptic:tap'); setUiMode('scan'); setScanState('idle'); handleScan(); }}>
            Scan QR Code
          </Button>
          <Button style={{ flex: 1 }} icon="QrCode" onClick={() => { window.callBare('haptic:tap'); setUiMode('showQr'); }}>
            Show QR Code
          </Button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: `${spacing.sm}px`, marginTop: `${spacing.xs}px` }}>
          <button
            onClick={handleShare}
            disabled={sharing}
            style={{ background: 'none', border: 'none', color: colors.primary, fontSize: '13px', cursor: sharing ? 'wait' : 'pointer', padding: 0, opacity: sharing ? 0.6 : 1 }}
          >
            {sharing ? 'Generating...' : 'Share Link'}
          </button>
          <span style={{ color: colors.text.muted, fontSize: '13px' }}>·</span>
          <button
            onClick={() => { window.callBare('haptic:tap'); setUiMode('paste'); setScanState('idle'); }}
            style={{ background: 'none', border: 'none', color: colors.primary, fontSize: '13px', cursor: 'pointer', padding: 0 }}
          >
            Paste Link
          </button>
        </div>
        <button
          onClick={onDismiss}
          style={{ background: 'none', border: 'none', color: colors.text.secondary, fontSize: '13px', cursor: 'pointer', padding: 0, alignSelf: 'center' }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
