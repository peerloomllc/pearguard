import React, { useState, useEffect, useCallback } from 'react';

const TYPE_META = {
  bypass:          { label: 'Bypass Attempt',  color: '#ea4335', icon: '⚠'  },
  pin_use:         { label: 'PIN Used',         color: '#fbbc04', icon: '🔑' },
  time_request:    { label: 'Time Request',     color: '#1a73e8', icon: '⏱' },
  app_installed:   { label: 'App Installed',    color: '#34a853', icon: '📲' },
  app_uninstalled: { label: 'App Uninstalled',  color: '#ff6d00', icon: '🗑' },
};

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatSeconds(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function AlertRow({ alert, onApprove, onDeny }) {
  const [resolving, setResolving] = useState(false);
  const [resolved, setResolved] = useState(alert.resolved || false);
  const meta = TYPE_META[alert.type] || { label: alert.type, color: '#888', icon: '•' };
  const isRequest = alert.type === 'time_request';

  async function handleApprove() {
    setResolving(true);
    try {
      await onApprove(alert);
      setResolved(true);
    } catch (e) {
      console.error('Approve failed:', e);
    } finally {
      setResolving(false);
    }
  }

  async function handleDeny() {
    setResolving(true);
    try {
      await onDeny(alert);
      setResolved(true);
    } catch (e) {
      console.error('Deny failed:', e);
    } finally {
      setResolving(false);
    }
  }

  return (
    <div style={styles.alertRow}>
      <div style={{ ...styles.typeBadge, backgroundColor: meta.color }}>
        {meta.label}
      </div>
      <div style={styles.alertBody}>
        <div style={styles.alertDesc}>
          {alert.appDisplayName || alert.packageName || 'Unknown app'}
          {isRequest && alert.requestedSeconds
            ? ` — requesting ${formatSeconds(alert.requestedSeconds)}`
            : ''}
        </div>
        <div style={styles.alertTime}>{formatTime(alert.timestamp)}</div>
        {isRequest && !resolved && (
          <div style={styles.actions}>
            <button
              style={styles.approveBtn}
              onClick={handleApprove}
              disabled={resolving}
              aria-label={`Approve time request for ${alert.packageName}`}
            >
              Approve
            </button>
            <button
              style={styles.denyBtn}
              onClick={handleDeny}
              disabled={resolving}
              aria-label={`Deny time request for ${alert.packageName}`}
            >
              Deny
            </button>
          </div>
        )}
        {isRequest && resolved && (
          <div style={styles.resolvedLabel}>Resolved</div>
        )}
      </div>
    </div>
  );
}

export default function AlertsTab({ childPublicKey }) {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  function reload() {
    window.callBare('alerts:list', { childPublicKey })
      .then((list) => { setAlerts(list || []); setLoading(false); })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    // Refresh when a new bypass alert, time request, or app install/uninstall arrives
    const unsubBypass       = window.onBareEvent('alert:bypass',          reload);
    const unsubRequest      = window.onBareEvent('time:request:received', reload);
    const unsubInstalled    = window.onBareEvent('app:installed',         reload);
    const unsubUninstalled  = window.onBareEvent('app:uninstalled',       reload);
    return () => { unsubBypass(); unsubRequest(); unsubInstalled(); unsubUninstalled(); };
  }, [childPublicKey]);

  async function handleApprove(alert) {
    await window.callBare('app:decide', {
      childPublicKey,
      packageName: alert.packageName,
      decision: 'approve',
    });
  }

  async function handleDeny(alert) {
    await window.callBare('app:decide', {
      childPublicKey,
      packageName: alert.packageName,
      decision: 'deny',
    });
  }

  if (loading) return <div style={styles.msg}>Loading alerts...</div>;
  if (alerts.length === 0) return <div style={styles.msg}>No alerts. All quiet!</div>;

  return (
    <div style={styles.container}>
      {alerts.map((alert) => (
        <AlertRow
          key={alert.id}
          alert={alert}
          onApprove={handleApprove}
          onDeny={handleDeny}
        />
      ))}
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  msg: { padding: '16px', color: '#666', fontSize: '14px' },
  alertRow: {
    display: 'flex', gap: '10px', padding: '12px 0', borderBottom: '1px solid #eee',
  },
  typeBadge: {
    color: '#fff', fontSize: '10px', fontWeight: '700', borderRadius: '4px',
    padding: '3px 6px', height: 'fit-content', whiteSpace: 'nowrap',
  },
  alertBody: { flex: 1 },
  alertDesc: { fontSize: '14px', color: '#333', marginBottom: '4px' },
  alertTime: { fontSize: '11px', color: '#888', marginBottom: '8px' },
  actions: { display: 'flex', gap: '8px' },
  approveBtn: {
    padding: '6px 14px', border: 'none', borderRadius: '6px',
    backgroundColor: '#34a853', color: '#fff', cursor: 'pointer', fontSize: '13px',
  },
  denyBtn: {
    padding: '6px 14px', border: 'none', borderRadius: '6px',
    backgroundColor: '#ea4335', color: '#fff', cursor: 'pointer', fontSize: '13px',
  },
  resolvedLabel: { fontSize: '12px', color: '#888', fontStyle: 'italic' },
};