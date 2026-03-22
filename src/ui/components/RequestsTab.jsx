import React, { useState, useEffect } from 'react';

function formatTime(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function RequestRow({ req, childPublicKey, onResolved }) {
  const [acting, setActing] = useState(false);

  async function decide(decision) {
    setActing(true);
    try {
      await window.callBare('app:decide', { childPublicKey, packageName: req.packageName, decision });
      onResolved();
    } catch (e) {
      console.error('app:decide failed:', e);
    } finally {
      setActing(false);
    }
  }

  const isPending = !req.resolved;

  return (
    <div style={styles.row}>
      <div style={styles.rowBody}>
        <div style={styles.appName}>{req.appDisplayName || req.packageName}</div>
        {req.appDisplayName && (
          <div style={styles.pkgName}>{req.packageName}</div>
        )}
        <div style={styles.time}>{formatTime(req.timestamp)}</div>
      </div>
      <div style={styles.rowRight}>
        {isPending ? (
          <div style={styles.actions}>
            <button
              style={styles.approveBtn}
              onClick={() => decide('approve')}
              disabled={acting}
              aria-label={`Approve request for ${req.packageName}`}
            >
              Approve
            </button>
            <button
              style={styles.denyBtn}
              onClick={() => decide('deny')}
              disabled={acting}
              aria-label={`Deny request for ${req.packageName}`}
            >
              Deny
            </button>
          </div>
        ) : (
          <div style={{ ...styles.statusLabel, color: req.status === 'approved' ? '#34a853' : '#ea4335' }}>
            {req.status === 'approved' ? 'Approved' : req.status === 'denied' ? 'Denied' : 'Resolved'}
          </div>
        )}
      </div>
    </div>
  );
}

export default function RequestsTab({ childPublicKey }) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);

  function reload() {
    window.callBare('alerts:list', { childPublicKey })
      .then((list) => {
        const reqs = (list || []).filter((a) => a.type === 'time_request');
        // Pending first, then resolved; within each group newest first
        reqs.sort((a, b) => {
          if (!a.resolved && b.resolved) return -1;
          if (a.resolved && !b.resolved) return 1;
          return b.timestamp - a.timestamp;
        });
        setRequests(reqs);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    const unsub = window.onBareEvent('time:request:received', reload);
    return unsub;
  }, [childPublicKey]);

  if (loading) return <div style={styles.msg}>Loading...</div>;
  if (requests.length === 0) return <div style={styles.msg}>No requests yet.</div>;

  return (
    <div style={styles.container}>
      {requests.map((req) => (
        <RequestRow
          key={req.id}
          req={req}
          childPublicKey={childPublicKey}
          onResolved={reload}
        />
      ))}
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  msg: { padding: '16px', color: '#666', fontSize: '14px' },
  row: {
    display: 'flex', alignItems: 'flex-start', gap: '12px',
    padding: '12px 0', borderBottom: '1px solid #eee',
  },
  rowBody: { flex: 1 },
  rowRight: { flexShrink: 0, paddingTop: '2px' },
  appName: { fontSize: '14px', fontWeight: '600', color: '#333' },
  pkgName: { fontSize: '11px', color: '#888', fontFamily: 'monospace', marginTop: '2px' },
  time: { fontSize: '11px', color: '#888', marginTop: '4px' },
  actions: { display: 'flex', gap: '8px' },
  approveBtn: {
    padding: '6px 14px', border: 'none', borderRadius: '6px',
    backgroundColor: '#34a853', color: '#fff', cursor: 'pointer', fontSize: '13px',
  },
  denyBtn: {
    padding: '6px 14px', border: 'none', borderRadius: '6px',
    backgroundColor: '#ea4335', color: '#fff', cursor: 'pointer', fontSize: '13px',
  },
  statusLabel: { fontSize: '13px', fontWeight: '600' },
};
