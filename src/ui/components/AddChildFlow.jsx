import React, { useEffect, useState } from 'react';

export default function AddChildFlow({ onConnected, onCancel }) {
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    window.callBare('invite:generate')
      .then(setInvite)
      .catch(() => setError('Failed to generate invite. Please try again.'));

    const unsub = window.onBareEvent('child:connected', (data) => {
      onConnected(data);
    });
    return unsub;
  }, [onConnected]);

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
        <p style={styles.hint}>Generating invite...</p>
      </div>
    );
  }

  const deepLink = `pearguard://join?invite=${encodeURIComponent(invite.inviteString)}`;

  return (
    <div style={styles.container}>
      <h3 style={styles.heading}>Add a Child Device</h3>
      <p style={styles.hint}>Ask the child to scan this QR code or open the link below.</p>

      {/* QR placeholder — replace with real QR rendering once a library is bundled */}
      <div style={styles.qrBox} aria-label="QR code placeholder">
        <pre style={styles.qrData}>{invite.qrData}</pre>
      </div>

      <p style={styles.linkLabel}>Or share this link:</p>
      <a href={deepLink} style={styles.link} data-testid="invite-link">
        {deepLink}
      </a>

      <p style={styles.waiting}>Waiting for child to connect...</p>
      <button style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  heading: { fontSize: '18px', fontWeight: '700', marginBottom: '8px' },
  hint: { color: '#555', fontSize: '13px', marginBottom: '16px' },
  qrBox: {
    border: '1px solid #ccc',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '16px',
    backgroundColor: '#f8f8f8',
    overflowX: 'auto',
  },
  qrData: { fontSize: '11px', wordBreak: 'break-all', margin: 0 },
  linkLabel: { fontSize: '13px', color: '#555', marginBottom: '4px' },
  link: {
    display: 'block',
    fontSize: '12px',
    color: '#1a73e8',
    wordBreak: 'break-all',
    marginBottom: '24px',
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
