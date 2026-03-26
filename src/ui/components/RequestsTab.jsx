import React, { useState, useEffect } from 'react';

function formatTime(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function RequestRow({ req, childPublicKey, onResolved }) {
  const [acting, setActing] = useState(false);

  const isExtraTime = req.requestType === 'extra_time';

  async function handleApprove() {
    setActing(true);
    try {
      if (isExtraTime) {
        await window.callBare('time:grant', {
          childPublicKey,
          requestId: req.id,
          packageName: req.packageName,
          extraSeconds: req.extraSeconds || 1800,
        });
      } else {
        await window.callBare('app:decide', { childPublicKey, packageName: req.packageName, decision: 'approve' });
      }
      onResolved();
    } catch (e) {
      console.error('approve failed:', e);
    } finally {
      setActing(false);
    }
  }

  async function handleDeny() {
    setActing(true);
    try {
      if (isExtraTime) {
        await window.callBare('time:deny', {
          childPublicKey,
          requestId: req.id,
          packageName: req.packageName,
          appName: req.appDisplayName || req.packageName,
        });
      } else {
        await window.callBare('app:decide', { childPublicKey, packageName: req.packageName, decision: 'deny' });
      }
      onResolved();
    } catch (e) {
      console.error('deny failed:', e);
    } finally {
      setActing(false);
    }
  }

  const isPending = !req.resolved;

  function approveLabel() {
    if (!isExtraTime) return 'Approve';
    if (!req.extraSeconds) return 'Grant Time';
    const mins = req.extraSeconds / 60;
    return mins >= 60 ? `Grant ${mins / 60}h` : `Grant ${mins}m`;
  }

  return (
    <div style={styles.row}>
      <div style={styles.rowBody}>
        <div style={styles.appName}>{req.appDisplayName || req.packageName}</div>
        {req.appDisplayName && (
          <div style={styles.pkgName}>{req.packageName}</div>
        )}
        <div style={styles.typeBadge} data-type={req.requestType}>
          {isExtraTime ? 'Extra time' : 'App approval'}
        </div>
        <div style={styles.time}>{formatTime(req.timestamp)}</div>
      </div>
      <div style={styles.rowRight}>
        {isPending ? (
          <div style={styles.actions}>
            <button
              style={styles.approveBtn}
              onClick={handleApprove}
              disabled={acting}
              aria-label={`Approve request for ${req.packageName}`}
            >
              {approveLabel()}
            </button>
            <button
              style={styles.denyBtn}
              onClick={handleDeny}
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
  typeBadge: { fontSize: '10px', color: '#666', marginTop: '2px', textTransform: 'uppercase', letterSpacing: '0.5px' },
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
