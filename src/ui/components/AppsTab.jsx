import React, { useState, useEffect, useCallback } from 'react';

const ICON_COLORS = ['#4285f4','#ea4335','#fbbc05','#34a853','#ff6d00','#46bdc6','#7b1fa2','#c62828'];

const APP_CATEGORIES = ['Games', 'Social', 'Video & Music', 'Communication', 'Education', 'Productivity', 'News', 'System', 'Other'];

const CATEGORY_COLORS = {
  Games: '#ea4335',
  Social: '#4285f4',
  'Video & Music': '#7b1fa2',
  Communication: '#34a853',
  Education: '#fbbc05',
  Productivity: '#46bdc6',
  News: '#ff6d00',
  System: '#888',
  Other: '#aaa',
};

function getInitials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function getIconColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length];
}

function AppRow({ childPublicKey, packageName, appData, onUpdate, onDecide }) {
  const [limitInput, setLimitInput] = useState(
    appData.dailyLimitSeconds ? String(Math.round(appData.dailyLimitSeconds / 60)) : ''
  );

  function setStatus(newStatus) {
    onUpdate(packageName, { ...appData, status: newStatus });
  }

  function handleLimitBlur() {
    const mins = parseInt(limitInput, 10);
    if (!isNaN(mins) && mins > 0) {
      onUpdate(packageName, { ...appData, dailyLimitSeconds: mins * 60 });
    } else {
      // Empty or zero — remove the daily limit
      const { dailyLimitSeconds, ...rest } = appData;
      setLimitInput('');
      onUpdate(packageName, rest);
    }
  }

  function handleApprove() {
    window.callBare('app:decide', { childPublicKey, packageName, decision: 'approve' });
    onDecide(packageName, 'allowed');
  }

  function handleDeny() {
    window.callBare('app:decide', { childPublicKey, packageName, decision: 'deny' });
    onDecide(packageName, 'blocked');
  }

  const isPending = appData.status === 'pending';
  const addedDate = appData.addedAt
    ? new Date(appData.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div style={styles.appRow}>
      <div style={styles.appInfo}>
        {appData.iconBase64 ? (
          <img
            src={`data:image/png;base64,${appData.iconBase64}`}
            alt={`${appData.appName || packageName} icon`}
            style={styles.appIcon}
          />
        ) : (
          <div
            style={{
              ...styles.initialsCircle,
              backgroundColor: getIconColor(appData.appName || packageName),
            }}
            aria-hidden="true"
          >
            {getInitials(appData.appName || packageName)}
          </div>
        )}
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

const STATUS_CATEGORIES = [
  { key: 'pending', label: 'Pending Approval', color: '#f59e0b' },
  { key: 'allowed', label: 'Allowed',          color: '#34a853' },
  { key: 'blocked', label: 'Blocked',           color: '#ea4335' },
];

function StatusSection({ category, entries, childPublicKey, onUpdate, onDecide, collapsed, onToggle }) {
  return (
    <div style={styles.section}>
      <button
        style={{ ...styles.sectionHeader, borderLeft: `4px solid ${category.color}` }}
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span style={styles.sectionLabel}>{category.label}</span>
        <span style={{ ...styles.sectionBadge, backgroundColor: category.color }}>{entries.length}</span>
        <span style={styles.chevron}>{collapsed ? '›' : '⌄'}</span>
      </button>
      {!collapsed && entries.map(([pkg, data]) => (
        <AppRow
          key={pkg}
          childPublicKey={childPublicKey}
          packageName={pkg}
          appData={data}
          onUpdate={onUpdate}
          onDecide={onDecide}
        />
      ))}
    </div>
  );
}

function CategorySection({ categoryName, entries, childPublicKey, onUpdate, onDecide, onBatchDecide, collapsed, onToggle }) {
  const color = CATEGORY_COLORS[categoryName] || '#aaa';
  const pendingCount = entries.filter(([, d]) => d.status === 'pending').length;
  const allowedCount = entries.filter(([, d]) => d.status === 'allowed').length;
  const blockedCount = entries.filter(([, d]) => d.status !== 'pending' && d.status !== 'allowed').length;

  function handleApproveAll() {
    const pkgs = entries.map(([pkg]) => pkg);
    onBatchDecide(pkgs, 'approve');
  }

  function handleDenyAll() {
    const pkgs = entries.map(([pkg]) => pkg);
    onBatchDecide(pkgs, 'deny');
  }

  return (
    <div style={styles.section}>
      <button
        style={{ ...styles.sectionHeader, borderLeft: `4px solid ${color}` }}
        onClick={onToggle}
        aria-expanded={!collapsed}
      >
        <span style={styles.sectionLabel}>{categoryName}</span>
        <div style={styles.badgeRow}>
          {pendingCount > 0 && <span style={{ ...styles.sectionBadge, backgroundColor: '#f59e0b' }}>{pendingCount}</span>}
          {allowedCount > 0 && <span style={{ ...styles.sectionBadge, backgroundColor: '#34a853' }}>{allowedCount}</span>}
          {blockedCount > 0 && <span style={{ ...styles.sectionBadge, backgroundColor: '#ea4335' }}>{blockedCount}</span>}
        </div>
        <span style={{ ...styles.sectionBadge, backgroundColor: color }}>{entries.length}</span>
        <span style={styles.chevron}>{collapsed ? '›' : '⌄'}</span>
      </button>
      {!collapsed && (
        <>
          <div style={styles.batchActions}>
            <button style={styles.approveAllBtn} onClick={handleApproveAll}>
              Approve All
            </button>
            <button style={styles.denyAllBtn} onClick={handleDenyAll}>
              Deny All
            </button>
          </div>
          {entries.map(([pkg, data]) => (
            <AppRow
              key={pkg}
              childPublicKey={childPublicKey}
              packageName={pkg}
              appData={data}
              onUpdate={onUpdate}
              onDecide={onDecide}
            />
          ))}
        </>
      )}
    </div>
  );
}

export default function AppsTab({ childPublicKey }) {
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sortOrder, setSortOrder] = useState('alpha'); // 'alpha' | 'date'
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState('category'); // 'status' | 'category'
  const [collapsed, setCollapsed] = useState({});

  const loadPolicy = useCallback(() => {
    window.callBare('policy:get', { childPublicKey })
      .then((p) => { setPolicy(p); setLoading(false); })
      .catch(() => setLoading(false));
  }, [childPublicKey]);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  useEffect(() => {
    const unsub = window.onBareEvent('apps:synced', (data) => {
      if (data.childPublicKey === childPublicKey) loadPolicy();
    });
    return unsub;
  }, [childPublicKey, loadPolicy]);

  function handleUpdate(packageName, newAppData) {
    const newApps = { ...policy.apps, [packageName]: newAppData };
    const newPolicy = { ...policy, apps: newApps };
    setPolicy(newPolicy);
    window.callBare('policy:update', { childPublicKey, policy: newPolicy });
  }

  // Updates local state only — used by approve/deny which already send app:decide.
  // Avoids a redundant policy:update P2P alongside app:decision, preventing double
  // notifications on the child device (#68).
  function handleDecide(packageName, newStatus) {
    setPolicy(prev => ({
      ...prev,
      apps: { ...prev.apps, [packageName]: { ...prev.apps[packageName], status: newStatus } },
    }));
  }

  function handleBatchDecide(packageNames, decision) {
    const newStatus = decision === 'approve' ? 'allowed' : 'blocked';
    // Optimistic local update
    setPolicy(prev => {
      const apps = { ...prev.apps };
      for (const pkg of packageNames) {
        apps[pkg] = { ...apps[pkg], status: newStatus };
      }
      return { ...prev, apps };
    });
    window.callBare('apps:decideBatch', { childPublicKey, packageNames, decision });
  }

  function toggleSection(key) {
    setCollapsed(prev => ({ ...prev, [key]: !(prev[key] ?? true) }));
  }

  if (loading) return <div style={styles.msg}>Loading apps...</div>;
  if (!policy || !policy.apps || Object.keys(policy.apps).length === 0) {
    return <div style={styles.msg}>No apps found. Apps appear here after they are installed on the child device.</div>;
  }

  const q = search.trim().toLowerCase();
  const filtered = Object.entries(policy.apps).filter(([pkg, data]) => {
    if (!q) return true;
    return (data.appName || '').toLowerCase().includes(q) || pkg.toLowerCase().includes(q);
  });

  const sorted = filtered.slice().sort((a, b) => {
    if (sortOrder === 'alpha') {
      return (a[1].appName || a[0]).toLowerCase().localeCompare((b[1].appName || b[0]).toLowerCase());
    }
    return (b[1].addedAt || 0) - (a[1].addedAt || 0);
  });

  const totalCount = Object.keys(policy.apps).length;
  const visibleCount = filtered.length;

  return (
    <div style={styles.container}>
      <div style={styles.toolbar}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search apps..."
          style={styles.searchInput}
          aria-label="Search apps"
        />
        <button
          style={styles.sortBtn}
          onClick={() => setSortOrder(s => s === 'alpha' ? 'date' : 'alpha')}
          aria-label="Toggle sort order"
        >
          {sortOrder === 'alpha' ? 'A-Z' : 'Date'}
        </button>
        <button
          style={{ ...styles.sortBtn, ...(viewMode === 'category' ? styles.viewBtnActive : {}) }}
          onClick={() => setViewMode(v => v === 'status' ? 'category' : 'status')}
          aria-label="Toggle view mode"
        >
          {viewMode === 'status' ? 'By Status' : 'By Category'}
        </button>
      </div>
      <div style={styles.appCountRow}>
        <span style={styles.appCount}>
          {q ? `${visibleCount} of ${totalCount}` : totalCount} app{totalCount !== 1 ? 's' : ''}
        </span>
        {q && (
          <button style={styles.clearSearch} onClick={() => setSearch('')}>
            Clear
          </button>
        )}
      </div>
      {viewMode === 'status' ? (
        STATUS_CATEGORIES.map(cat => {
          const entries = cat.key === 'blocked'
            ? sorted.filter(([, d]) => d.status !== 'pending' && d.status !== 'allowed')
            : sorted.filter(([, d]) => d.status === cat.key);
          if (entries.length === 0) return null;
          return (
            <StatusSection
              key={cat.key}
              category={cat}
              entries={entries}
              childPublicKey={childPublicKey}
              onUpdate={handleUpdate}
              onDecide={handleDecide}
              collapsed={collapsed[cat.key] ?? true}
              onToggle={() => toggleSection(cat.key)}
            />
          );
        })
      ) : (
        APP_CATEGORIES.map(catName => {
          const entries = sorted.filter(([, d]) => (d.category || 'Other') === catName);
          if (entries.length === 0) return null;
          return (
            <CategorySection
              key={catName}
              categoryName={catName}
              entries={entries}
              childPublicKey={childPublicKey}
              onUpdate={handleUpdate}
              onDecide={handleDecide}
              onBatchDecide={handleBatchDecide}
              collapsed={collapsed[catName] ?? true}
              onToggle={() => toggleSection(catName)}
            />
          );
        })
      )}
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  msg: { padding: '16px', color: '#666', fontSize: '14px' },
  toolbar: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    marginBottom: '8px',
  },
  searchInput: {
    flex: 1,
    padding: '7px 10px',
    fontSize: '13px',
    border: '1px solid #ccc',
    borderRadius: '8px',
    outline: 'none',
    color: '#111',
  },
  sortBtn: {
    padding: '6px 10px',
    fontSize: '12px',
    border: '1px solid #ccc',
    borderRadius: '12px',
    background: '#f5f5f5',
    cursor: 'pointer',
    color: '#444',
    whiteSpace: 'nowrap',
  },
  viewBtnActive: {
    background: '#e8f0fe',
    borderColor: '#4285f4',
    color: '#1a73e8',
  },
  appCountRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '12px',
  },
  appCount: { fontSize: '13px', color: '#888' },
  clearSearch: {
    fontSize: '12px',
    padding: '2px 8px',
    border: '1px solid #ccc',
    borderRadius: '10px',
    background: 'none',
    cursor: 'pointer',
    color: '#666',
  },
  section: { marginBottom: '8px' },
  sectionHeader: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px',
    background: '#f9f9f9',
    border: '1px solid #eee',
    borderRadius: '8px',
    cursor: 'pointer',
    textAlign: 'left',
    marginBottom: '4px',
  },
  sectionLabel: { flex: 1, fontSize: '13px', fontWeight: '600', color: '#333' },
  badgeRow: { display: 'flex', gap: '4px' },
  sectionBadge: {
    fontSize: '11px',
    color: '#fff',
    borderRadius: '10px',
    padding: '1px 7px',
    fontWeight: '700',
  },
  chevron: { fontSize: '16px', color: '#888', lineHeight: 1 },
  batchActions: {
    display: 'flex',
    gap: '8px',
    padding: '8px 0',
    borderBottom: '1px solid #eee',
  },
  approveAllBtn: {
    flex: 1,
    padding: '8px 12px',
    border: 'none',
    borderRadius: '6px',
    backgroundColor: '#34a853',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: '600',
  },
  denyAllBtn: {
    flex: 1,
    padding: '8px 12px',
    border: 'none',
    borderRadius: '6px',
    backgroundColor: '#ea4335',
    color: '#fff',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: '600',
  },
  appRow: {
    padding: '12px 0',
    borderBottom: '1px solid #eee',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  appInfo: { display: 'flex', alignItems: 'center', gap: '8px' },
  appIcon: {
    width: '40px',
    height: '40px',
    borderRadius: '8px',
    objectFit: 'contain',
    flexShrink: 0,
  },
  initialsCircle: {
    width: '40px',
    height: '40px',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: '14px',
    fontWeight: '700',
    flexShrink: 0,
  },
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
