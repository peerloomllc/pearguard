import React from 'react';
import Avatar from './Avatar.jsx';

function formatSeconds(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Badge({ count, color }) {
  if (!count || count === 0) return null;
  return (
    <span style={{ ...styles.badge, backgroundColor: color }}>
      {count}
    </span>
  );
}

export default function ChildCard({ child, onPress }) {
  const {
    displayName,
    isOnline,
    currentApp,
    todayScreenTimeSeconds,
    bypassAlerts,
    pendingApprovals,
    pendingTimeRequests,
  } = child;

  const hasAlerts = bypassAlerts > 0 || pendingApprovals > 0 || pendingTimeRequests > 0;

  return (
    <button style={styles.card} onClick={onPress} aria-label={`Open ${displayName}`}>
      <div style={styles.header}>
        <Avatar avatar={child.avatarThumb} name={displayName} size={32} />
        <span style={{ ...styles.statusDot, backgroundColor: isOnline ? '#34a853' : '#bbb' }} />
        <span style={styles.name}>{displayName}</span>
        {hasAlerts && (
          <div style={styles.badges}>
            <Badge count={bypassAlerts} color="#ea4335" />
            <Badge count={pendingApprovals} color="#fbbc04" />
            <Badge count={pendingTimeRequests} color="#1a73e8" />
          </div>
        )}
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Active:</span>
        <span style={styles.value}>{currentApp || 'None'}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Today:</span>
        <span style={styles.value}>{formatSeconds(todayScreenTimeSeconds || 0)}</span>
      </div>
    </button>
  );
}

const styles = {
  card: {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    backgroundColor: '#fff',
    border: '1px solid #e0e0e0',
    borderRadius: '8px',
    padding: '16px',
    marginBottom: '12px',
    cursor: 'pointer',
    boxShadow: '0 1px 3px rgba(0,0,0,0.1)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    marginBottom: '8px',
  },
  statusDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    marginRight: '8px',
    flexShrink: 0,
  },
  name: {
    fontSize: '16px',
    fontWeight: '600',
    flex: 1,
  },
  badges: {
    display: 'flex',
    gap: '4px',
  },
  badge: {
    display: 'inline-block',
    color: '#fff',
    fontSize: '11px',
    fontWeight: '700',
    borderRadius: '10px',
    padding: '2px 7px',
    minWidth: '20px',
    textAlign: 'center',
  },
  row: {
    display: 'flex',
    gap: '8px',
    fontSize: '13px',
    marginTop: '4px',
  },
  label: { color: '#888', minWidth: '50px' },
  value: { color: '#333' },
};
