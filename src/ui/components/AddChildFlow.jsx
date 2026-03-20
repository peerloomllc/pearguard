import React, { useEffect, useState, useRef } from 'react';
import QRCode from 'qrcode';

export default function AddChildFlow({ onConnected, onCancel }) {
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
      <div style={styles.container}>
        <p style={styles.error}>{error}</p>
        <button style={styles.cancelBtn} onClick={onCancel}>Go Back</button>
      </div>
    );
  }

  if (!invite) {
    return (
      <div style={styles.container}>
        <p style={styles.hint}>Generating invite…</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h3 style={styles.heading}>Add a Child Device</h3>
      <p style={styles.hint}>Ask the child to scan this QR code, or share the link below via SMS or a messaging app.</p>

      <div style={styles.qrWrap}>
        <canvas ref={canvasRef} />
      </div>

      <p style={styles.linkLabel}>Or share this link:</p>
      <div style={styles.linkRow}>
        <span style={styles.link}>{invite.inviteLink}</span>
        <button style={styles.copyBtn} onClick={handleShare} disabled={sharing}>
          Share
        </button>
      </div>

      <p style={styles.waiting}>Waiting for child to connect…</p>
      <button style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  heading: { fontSize: '18px', fontWeight: '700', marginBottom: '8px' },
  hint: { color: '#555', fontSize: '13px', marginBottom: '16px' },
  qrWrap: {
    display: 'flex',
    justifyContent: 'center',
    marginBottom: '16px',
    padding: '12px',
    backgroundColor: '#fff',
    borderRadius: '8px',
    border: '1px solid #ddd',
  },
  linkLabel: { fontSize: '13px', color: '#555', marginBottom: '4px' },
  linkRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '24px',
    padding: '10px',
    backgroundColor: '#f5f5f5',
    borderRadius: '6px',
    border: '1px solid #ddd',
  },
  link: {
    flex: 1,
    fontSize: '11px',
    color: '#333',
    wordBreak: 'break-all',
  },
  copyBtn: {
    flexShrink: 0,
    padding: '6px 12px',
    border: 'none',
    borderRadius: '4px',
    backgroundColor: '#1a73e8',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
  },
  waiting: { fontSize: '14px', color: '#888', fontStyle: 'italic', marginBottom: '16px' },
  cancelBtn: {
    padding: '10px 20px',
    border: '1px solid #ccc',
    borderRadius: '6px',
    background: '#fff',
    cursor: 'pointer',
    fontSize: '14px',
  },
  error: { color: '#ea4335', marginBottom: '12px' },
};
