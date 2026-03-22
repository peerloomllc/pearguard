import React, { useState, useEffect, useCallback } from 'react';

function AppRow({ childPublicKey, packageName, appData, onUpdate }) {
  const [limitInput, setLimitInput] = useState(
    appData.dailyLimitSeconds ? String(Math.round(appData.dailyLimitSeconds / 60)) : ''
  );

  function setStatus(newStatus) {
    onUpdate(packageName, { ...appData, status: newStatus });
  }

  function handleLimitBlur() {
    const mins = parseInt(limitInput, 10);
    if (!isNaN(mins) && mins >= 0) {
      onUpdate(packageName, { ...appData, dailyLimitSeconds: mins * 60 });
    }
  }

  function handleApprove() {
    window.callBare('app:decide', { childPublicKey, packageName, decision: 'approve' });
    onUpdate(packageName, { ...appData, status: 'allowed' });
  }

  function handleDeny() {
    window.callBare('app:decide', { childPublicKey, packageName, decision: 'deny' });
    onUpdate(packageName, { ...appData, status: 'blocked' });
  }

  const isPending = appData.status === 'pending';
  const addedDate = appData.addedAt
    ? new Date(appData.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div style={styles.appRow}>
      <div style={styles.appInfo}>
        <div style={styles.appNameBlock}>
          <span style={styles.appName}>{appData.appName || packageName}</span>
          {appData.appName && <span style={styles.pkgName}>{packageName}</span>}
          {addedDate && <span style={styles.addedDate}>Added {addedDate}</span>}
        </div>
      </div>
      {isPending ? (
        <div style={styles.actions}>
          <button style={styles.approveBtn} onClick={handleApprove} aria-label={`Approve ${appData.appName || packageName}`}>
            Approve
          </button>
          <button style={styles.denyBtn} onClick={handleDeny} aria-label={`Deny ${appData.appName || packageName}`}>
            Deny
          </button>
        </div>
      ) : (
        <div style={styles.controls}>
          <label style={styles.toggle}>
            <input
              type="checkbox"
              checked={appData.status === 'allowed'}
              onChange={(e) => setStatus(e.target.checked ? 'allowed' : 'blocked')}
              aria-label={`Toggle ${appData.appName || packageName}`}
            />
            <span style={{ marginLeft: '4px' }}>{appData.status === 'allowed' ? 'Allowed' : 'Blocked'}</span>
          </label>
          <label style={styles.limitLabel}>
            Limit:
            <input
              type="number"
              min="0"
              value={limitInput}
              onChange={(e) => setLimitInput(e.target.value)}
              onBlur={handleLimitBlur}
              style={styles.limitInput}
              aria-label={`Daily limit for ${appData.appName || packageName} in minutes`}
              placeholder="∞"
            />
            min/day
          </label>
        </div>
      )}
    </div>
  );
}

export default function AppsTab({ childPublicKey }) {
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sortOrder, setSortOrder] = useState('alpha'); // 'alpha' | 'date'

  const loadPolicy = useCallback(() => {
    window.callBare('policy:get', { childPublicKey })
      .then((p) => { setPolicy(p); setLoading(false); })
      .catch(() => setLoading(false));
  }, [childPublicKey]);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  useEffect(() => {
    const unsub = window.onBareEvent('apps:synced', (data) => {
      if (data.childPublicKey === childPublicKey) loadPolicy()
    })
    return unsub
  }, [childPublicKey, loadPolicy]);

  function handleUpdate(packageName, newAppData) {
    const newApps = { ...policy.apps, [packageName]: newAppData };
    const newPolicy = { ...policy, apps: newApps };
    setPolicy(newPolicy);
    window.callBare('policy:update', { childPublicKey, policy: newPolicy });
  }

  if (loading) return <div style={styles.msg}>Loading apps...</div>;
  if (!policy || !policy.apps || Object.keys(policy.apps).length === 0) {
    return <div style={styles.msg}>No apps found. Apps appear here after they are installed on the child device.</div>;
  }

  const sortedEntries = Object.entries(policy.apps).slice().sort((a, b) => {
    if (sortOrder === 'alpha') {
      const nameA = (a[1].appName || a[0]).toLowerCase();
      const nameB = (b[1].appName || b[0]).toLowerCase();
      return nameA.localeCompare(nameB);
    }
    // date: newest first — most useful for "what did my kid just install?"
    return (b[1].addedAt || 0) - (a[1].addedAt || 0);
  });

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.appCount}>{sortedEntries.length} app{sortedEntries.length !== 1 ? 's' : ''}</span>
        <button
          style={styles.sortBtn}
          onClick={() => setSortOrder(s => s === 'alpha' ? 'date' : 'alpha')}
          aria-label="Toggle sort order"
        >
          {sortOrder === 'alpha' ? '🔤 A–Z' : '🕐 Date'}
        </button>
      </div>
      {sortedEntries.map(([pkg, data]) => (
        <AppRow
          key={pkg}
          childPublicKey={childPublicKey}
          packageName={pkg}
          appData={data}
          onUpdate={handleUpdate}
        />
      ))}
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  msg: { padding: '16px', color: '#666', fontSize: '14px' },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '8px',
    paddingBottom: '8px',
    borderBottom: '2px solid #eee',
  },
  appCount: { fontSize: '13px', color: '#888' },
  sortBtn: {
    padding: '4px 10px',
    fontSize: '12px',
    border: '1px solid #ccc',
    borderRadius: '12px',
    background: '#f5f5f5',
    cursor: 'pointer',
    color: '#444',
  },
  appRow: {
    padding: '12px 0',
    borderBottom: '1px solid #eee',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  appInfo: { display: 'flex', alignItems: 'center', gap: '8px' },
  appNameBlock: { display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 },
  appName: { fontSize: '14px', color: '#111', fontWeight: '500' },
  pkgName: { fontSize: '11px', fontFamily: 'monospace', color: '#888' },
  addedDate: { fontSize: '11px', color: '#aaa', marginTop: '1px' },
  actions: { display: 'flex', gap: '8px' },
  approveBtn: {
    padding: '6px 14px', border: 'none', borderRadius: '6px',
    backgroundColor: '#34a853', color: '#fff', cursor: 'pointer', fontSize: '13px',
  },
  denyBtn: {
    padding: '6px 14px', border: 'none', borderRadius: '6px',
    backgroundColor: '#ea4335', color: '#fff', cursor: 'pointer', fontSize: '13px',
  },
  controls: { display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' },
  toggle: { display: 'flex', alignItems: 'center', fontSize: '13px', cursor: 'pointer' },
  limitLabel: { fontSize: '13px', color: '#555', display: 'flex', alignItems: 'center', gap: '6px' },
  limitInput: { width: '60px', padding: '4px', border: '1px solid #ccc', borderRadius: '4px', fontSize: '13px' },
};