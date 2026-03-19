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

  return (
    <div style={styles.appRow}>
      <div style={styles.appInfo}>
        <span style={styles.pkgName}>{packageName}</span>
        {isPending && <span style={styles.pendingBadge}>Pending Approval</span>}
      </div>
      {isPending ? (
        <div style={styles.actions}>
          <button style={styles.approveBtn} onClick={handleApprove} aria-label={`Approve ${packageName}`}>
            Approve
          </button>
          <button style={styles.denyBtn} onClick={handleDeny} aria-label={`Deny ${packageName}`}>
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
              aria-label={`Toggle ${packageName}`}
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
              aria-label={`Daily limit for ${packageName} in minutes`}
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

  const loadPolicy = useCallback(() => {
    window.callBare('policy:get', { childPublicKey })
      .then((p) => { setPolicy(p); setLoading(false); })
      .catch(() => setLoading(false));
  }, [childPublicKey]);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);

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

  return (
    <div style={styles.container}>
      {Object.entries(policy.apps).map(([pkg, data]) => (
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
  appRow: {
    padding: '12px 0',
    borderBottom: '1px solid #eee',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  appInfo: { display: 'flex', alignItems: 'center', gap: '8px' },
  pkgName: { fontSize: '13px', fontFamily: 'monospace', color: '#333', flex: 1 },
  pendingBadge: {
    fontSize: '11px',
    backgroundColor: '#fbbc04',
    color: '#000',
    borderRadius: '4px',
    padding: '2px 6px',
  },
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
