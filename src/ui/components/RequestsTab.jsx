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

function timeRemaining(expiresAt) {
  const diff = Math.max(0, expiresAt - Date.now());
  const mins = Math.ceil(diff / 60000);
  if (mins >= 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  return mins + 'm';
}

export default function RequestsTab({ childPublicKey }) {
  const [requests, setRequests] = useState([]);
  const [overrides, setOverrides] = useState([]);
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

  function loadOverrides() {
    window.callBare('overrides:list', { childPublicKey })
      .then(({ overrides }) => setOverrides(overrides || []))
      .catch(() => {});
  }

  useEffect(() => {
    reload();
    loadOverrides();
    const unsub = window.onBareEvent('time:request:received', () => { reload(); loadOverrides(); });
    const unsub2 = window.onBareEvent('request:updated', () => { reload(); loadOverrides(); });
    const timer = setInterval(loadOverrides, 30000);
    return () => { unsub(); unsub2(); clearInterval(timer); };
  }, [childPublicKey]);

  if (loading) return <div style={styles.msg}>Loading...</div>;

  return (
    <div style={styles.container}>
      {overrides.length > 0 && (
        <div style={{ marginBottom: '16px' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: '13px', color: '#555' }}>Active Overrides</h4>
          {overrides.map((o, i) => (
            <div key={i} style={styles.overrideRow}>
              <div>
                <span style={{ fontWeight: '600', fontSize: '13px' }}>{o.appName}</span>
              </div>
              <span style={{ color: '#1a73e8', fontSize: '12px', fontWeight: '600' }}>
                {timeRemaining(o.expiresAt)} left
              </span>
            </div>
          ))}
        </div>
      )}
      {requests.length === 0 && overrides.length === 0 && (
        <div style={styles.msg}>No requests yet.</div>
      )}
      {requests.map((req) => (
        <RequestRow
          key={req.id}
          req={req}
          childPublicKey={childPublicKey}
          onResolved={() => { reload(); loadOverrides(); }}
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
  overrideRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '8px 12px', marginBottom: '6px', borderRadius: '6px',
    backgroundColor: '#F0F7FF', border: '1px solid #D0E3FF',
  },
};
