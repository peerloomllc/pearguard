import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTheme } from '../theme.js';
import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';
import { APP_CATEGORIES, CATEGORY_COLORS } from './appCategories.js';

const ANIMATION_STYLES = `
@keyframes pgFadeSlideOut {
  from { opacity: 1; transform: translateX(0); }
  to   { opacity: 0; transform: translateX(-20px); }
}
@keyframes pgFadeSlideIn {
  from { opacity: 0; transform: translateX(20px); }
  to   { opacity: 1; transform: translateX(0); }
}
@keyframes pgFadeOut {
  from { opacity: 1; }
  to   { opacity: 0; }
}
@keyframes pgFadeIn {
  from { opacity: 0; }
  to   { opacity: 1; }
}
`;

const ICON_COLORS = ['#4285f4','#ea4335','#fbbc05','#34a853','#ff6d00','#46bdc6','#7b1fa2','#c62828'];

function getInitials(name) {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

function getIconColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return ICON_COLORS[Math.abs(hash) % ICON_COLORS.length];
}

function timeRemaining(expiresAt) {
  const diff = Math.max(0, expiresAt - Date.now());
  const mins = Math.ceil(diff / 60000);
  if (mins >= 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  return mins + 'm';
}

function AppRow({ childPublicKey, packageName, appData, onUpdate, onDecide, override, animationStyle, categoryLimitSeconds }) {
  const { colors, spacing, radius } = useTheme();
  const hasOwnLimit = typeof appData.dailyLimitSeconds === 'number';
  const inherits = !hasOwnLimit && typeof categoryLimitSeconds === 'number';
  const savedMinutes = hasOwnLimit ? String(Math.round(appData.dailyLimitSeconds / 60)) : '';
  const [limitInput, setLimitInput] = useState(savedMinutes);
  const [editingLimit, setEditingLimit] = useState(false);
  const limitDirty = limitInput !== savedMinutes;

  useEffect(() => { setLimitInput(savedMinutes); }, [savedMinutes]);
  useEffect(() => { if (hasOwnLimit) setEditingLimit(false); }, [hasOwnLimit]);

  function revertToCategory() {
    const { dailyLimitSeconds, ...rest } = appData;
    onUpdate(packageName, rest);
  }

  function setStatus(newStatus) {
    onUpdate(packageName, { ...appData, status: newStatus });
  }

  function saveLimit() {
    const mins = parseInt(limitInput, 10);
    if (!isNaN(mins) && mins > 0) {
      onUpdate(packageName, { ...appData, dailyLimitSeconds: mins * 60 });
    } else {
      const { dailyLimitSeconds, ...rest } = appData;
      setLimitInput('');
      onUpdate(packageName, rest);
    }
  }

  function handleApprove() {
    window.callBare('haptic:tap');
    window.callBare('app:decide', { childPublicKey, packageName, decision: 'approve' });
    onDecide(packageName, 'allowed');
  }

  function handleDeny() {
    window.callBare('haptic:tap');
    window.callBare('app:decide', { childPublicKey, packageName, decision: 'deny' });
    onDecide(packageName, 'blocked');
  }

  const isPending = appData.status === 'pending';
  const addedDate = appData.addedAt
    ? new Date(appData.addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  return (
    <div style={{
      padding: '12px 0',
      borderBottom: `1px solid ${colors.divider}`,
      display: 'flex',
      flexDirection: 'column',
      gap: `${spacing.sm}px`,
      ...animationStyle,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
        {appData.iconBase64 ? (
          <img
            src={`data:image/png;base64,${appData.iconBase64}`}
            alt={`${appData.appName || packageName} icon`}
            style={{ width: '40px', height: '40px', borderRadius: `${radius.md}px`, objectFit: 'contain', flexShrink: 0 }}
          />
        ) : (
          <div
            style={{
              width: '40px',
              height: '40px',
              borderRadius: `${radius.md}px`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#FFFFFF',
              fontSize: '14px',
              fontWeight: '700',
              flexShrink: 0,
              backgroundColor: getIconColor(appData.appName || packageName),
            }}
            aria-hidden="true"
          >
            {getInitials(appData.appName || packageName)}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', flex: 1 }}>
          <span style={{ fontSize: '14px', color: colors.text.primary, fontWeight: '500' }}>{appData.appName || packageName}</span>
          {appData.appName && <span style={{ fontSize: '11px', fontFamily: 'monospace', color: colors.text.muted }}>{packageName}</span>}
          {addedDate && <span style={{ fontSize: '11px', color: colors.text.muted, marginTop: '1px' }}>Added {addedDate}</span>}
        </div>
        {override && (
          <span style={{
            fontSize: '11px',
            fontWeight: '600',
            color: colors.primary,
            backgroundColor: `${colors.primary}22`,
            padding: '2px 8px',
            borderRadius: `${radius.full}px`,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}>
            {timeRemaining(override.expiresAt)} left
          </span>
        )}
      </div>
      {isPending ? (
        <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
          <button
            style={{ padding: '6px 14px', border: 'none', borderRadius: `${radius.md}px`, backgroundColor: colors.success, color: '#FFFFFF', cursor: 'pointer', fontSize: '13px' }}
            onClick={handleApprove}
            aria-label={`Approve ${appData.appName || packageName}`}
          >
            Approve
          </button>
          <button
            style={{ padding: '6px 14px', border: 'none', borderRadius: `${radius.md}px`, backgroundColor: colors.error, color: '#FFFFFF', cursor: 'pointer', fontSize: '13px' }}
            onClick={handleDeny}
            aria-label={`Deny ${appData.appName || packageName}`}
          >
            Deny
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.base}px`, flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', fontSize: '13px', cursor: 'pointer', color: colors.text.primary }}>
            <input
              type="checkbox"
              checked={appData.status === 'allowed'}
              onChange={(e) => { window.callBare('haptic:tap'); setStatus(e.target.checked ? 'allowed' : 'blocked'); }}
              aria-label={`Toggle ${appData.appName || packageName}`}
            />
            <span style={{ marginLeft: '4px' }}>{appData.status === 'allowed' ? 'Allowed' : 'Blocked'}</span>
          </label>
          {inherits && !editingLimit ? (
            <span style={{ fontSize: '13px', color: colors.text.secondary, display: 'flex', alignItems: 'center', gap: '6px' }}>
              Inherits: {Math.round(categoryLimitSeconds / 60)} min/day
              <button
                style={{ padding: '3px 8px', border: `1px solid ${colors.border}`, borderRadius: `${radius.sm}px`, background: 'none', color: colors.primary, cursor: 'pointer', fontSize: '12px' }}
                onClick={() => { window.callBare('haptic:tap'); setEditingLimit(true); }}
              >
                Override
              </button>
            </span>
          ) : (
            <label style={{ fontSize: '13px', color: colors.text.secondary, display: 'flex', alignItems: 'center', gap: '6px' }}>
              Limit:
              <input
                type="number"
                min="0"
                value={limitInput}
                onChange={(e) => setLimitInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') saveLimit(); }}
                style={{ width: '60px', padding: '4px', border: `1px solid ${colors.border}`, borderRadius: `${radius.sm}px`, fontSize: '13px', backgroundColor: colors.surface.input, color: colors.text.primary }}
                aria-label={`Daily limit for ${appData.appName || packageName} in minutes`}
                placeholder="&#8734;"
                autoFocus={editingLimit && !hasOwnLimit}
              />
              min/day
              {limitDirty && (
                <button
                  style={{ padding: '3px 10px', border: 'none', borderRadius: `${radius.sm}px`, backgroundColor: colors.primary, color: '#FFFFFF', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }}
                  onClick={() => { window.callBare('haptic:tap'); saveLimit(); }}
                >
                  Save
                </button>
              )}
              {hasOwnLimit && typeof categoryLimitSeconds === 'number' && !limitDirty && (
                <button
                  style={{ padding: '3px 8px', border: `1px solid ${colors.border}`, borderRadius: `${radius.sm}px`, background: 'none', color: colors.text.muted, cursor: 'pointer', fontSize: '12px' }}
                  onClick={() => { window.callBare('haptic:tap'); revertToCategory(); }}
                  title={`Revert to category limit (${Math.round(categoryLimitSeconds / 60)} min/day)`}
                >
                  Revert
                </button>
              )}
            </label>
          )}
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

function StatusSection({ category, entries, childPublicKey, onUpdate, onDecide, onBatchDecide, overrideMap, collapsed, onToggle, animatingItems, batchAnimationStyle }) {
  const { colors, spacing, radius } = useTheme();
  const batchAction = category.key === 'allowed' ? 'deny' : category.key === 'blocked' ? 'approve' : null;
  const isPending = category.key === 'pending';

  function handleBatchAll() {
    if (batchAction && onBatchDecide) {
      onBatchDecide(entries.map(([pkg]) => pkg), batchAction);
    }
  }

  function handleBatchPending(decision) {
    if (onBatchDecide) onBatchDecide(entries.map(([pkg]) => pkg), decision);
  }

  return (
    <div style={{ marginBottom: `${spacing.sm}px` }}>
      <button
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: `${spacing.sm}px`,
          padding: `10px ${spacing.md}px`,
          background: colors.surface.elevated,
          border: `1px solid ${colors.border}`,
          borderLeft: `4px solid ${category.color}`,
          borderRadius: `${radius.md}px`,
          cursor: 'pointer',
          textAlign: 'left',
          marginBottom: '4px',
        }}
        onClick={() => { window.callBare('haptic:tap'); onToggle(); }}
        aria-expanded={!collapsed}
      >
        <span style={{ flex: 1, fontSize: '13px', fontWeight: '600', color: colors.text.primary }}>{category.label}</span>
        <span style={{ fontSize: '11px', color: '#FFFFFF', borderRadius: '10px', padding: '1px 7px', fontWeight: '700', backgroundColor: category.color }}>{entries.length}</span>
        <span style={{ fontSize: '16px', color: colors.text.muted, lineHeight: 1 }}>{collapsed ? '›' : '⌄'}</span>
      </button>
      {!collapsed && (
        <div style={batchAnimationStyle}>
          {batchAction && (
            <div style={{ display: 'flex', gap: `${spacing.sm}px`, padding: `${spacing.sm}px 0`, borderBottom: `1px solid ${colors.divider}` }}>
              <button
                style={{ flex: 1, padding: `${spacing.sm}px ${spacing.md}px`, border: 'none', borderRadius: `${radius.md}px`, backgroundColor: batchAction === 'approve' ? colors.success : colors.error, color: '#FFFFFF', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
                onClick={() => { window.callBare('haptic:tap'); handleBatchAll(); }}
              >
                {batchAction === 'approve' ? 'Approve All' : 'Deny All'}
              </button>
            </div>
          )}
          {isPending && entries.length > 0 && (
            <div style={{ display: 'flex', gap: `${spacing.sm}px`, padding: `${spacing.sm}px 0`, borderBottom: `1px solid ${colors.divider}` }}>
              <button
                style={{ flex: 1, padding: `${spacing.sm}px ${spacing.md}px`, border: 'none', borderRadius: `${radius.md}px`, backgroundColor: colors.success, color: '#FFFFFF', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
                onClick={() => { window.callBare('haptic:tap'); handleBatchPending('approve'); }}
              >
                Approve All
              </button>
              <button
                style={{ flex: 1, padding: `${spacing.sm}px ${spacing.md}px`, border: 'none', borderRadius: `${radius.md}px`, backgroundColor: colors.error, color: '#FFFFFF', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
                onClick={() => { window.callBare('haptic:tap'); handleBatchPending('deny'); }}
              >
                Deny All
              </button>
            </div>
          )}
          {entries.map(([pkg, data]) => (
            <AppRow
              key={pkg}
              childPublicKey={childPublicKey}
              packageName={pkg}
              appData={data}
              onUpdate={onUpdate}
              onDecide={onDecide}
              override={overrideMap[pkg]}
              animationStyle={animatingItems?.[pkg]}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryLimitControls({ categoryName, savedSeconds, onSave, onApplyToAll, onClear }) {
  const { colors, spacing, radius } = useTheme();
  const savedMinutes = typeof savedSeconds === 'number' ? String(Math.round(savedSeconds / 60)) : '';
  const [input, setInput] = useState(savedMinutes);
  const dirty = input !== savedMinutes;

  useEffect(() => { setInput(savedMinutes); }, [savedMinutes]);

  function commit() {
    const mins = parseInt(input, 10);
    if (!isNaN(mins) && mins > 0) onSave(mins * 60);
    else { setInput(''); onSave(null); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px`, padding: `${spacing.sm}px 0`, borderBottom: `1px solid ${colors.divider}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: `${spacing.sm}px` }}>
        <label style={{ fontSize: '13px', color: colors.text.secondary, display: 'flex', alignItems: 'center', gap: '6px' }}>
          {categoryName} limit:
          <input
            type="number"
            min="0"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
            style={{ width: '60px', padding: '4px', border: `1px solid ${colors.border}`, borderRadius: `${radius.sm}px`, fontSize: '13px', backgroundColor: colors.surface.input, color: colors.text.primary }}
            placeholder="&#8734;"
            aria-label={`Daily limit for ${categoryName} category in minutes`}
          />
          min/day
        </label>
        {dirty && (
          <button
            style={{ padding: '4px 12px', border: 'none', borderRadius: `${radius.sm}px`, backgroundColor: colors.primary, color: '#FFFFFF', cursor: 'pointer', fontSize: '12px', fontWeight: '600' }}
            onClick={() => { window.callBare('haptic:tap'); commit(); }}
          >
            Save
          </button>
        )}
      </div>
      {typeof savedSeconds === 'number' && (
        <div style={{ display: 'flex', justifyContent: 'center', gap: '6px' }}>
          <button
            style={{ flex: 1, maxWidth: '140px', padding: '4px 10px', border: `1px solid ${colors.border}`, borderRadius: `${radius.sm}px`, background: colors.surface.elevated, color: colors.text.secondary, cursor: 'pointer', fontSize: '12px' }}
            onClick={() => { window.callBare('haptic:tap'); onApplyToAll(); }}
            title="Copy this limit onto every app in the category"
          >
            Apply to All
          </button>
          <button
            style={{ flex: 1, maxWidth: '140px', padding: '4px 10px', border: `1px solid ${colors.border}`, borderRadius: `${radius.sm}px`, background: colors.surface.elevated, color: colors.text.secondary, cursor: 'pointer', fontSize: '12px' }}
            onClick={() => { window.callBare('haptic:tap'); onClear(); }}
            title="Remove category limit and clear per-app limits in this category"
          >
            Clear All
          </button>
        </div>
      )}
    </div>
  );
}

function CategorySection({ categoryName, entries, childPublicKey, onUpdate, onDecide, onBatchDecide, onCategoryLimit, onCategoryApply, onCategoryClear, categoryLimitSeconds, overrideMap, collapsed, onToggle, animatingItems, batchAnimationStyle }) {
  const { colors, spacing, radius } = useTheme();
  const color = CATEGORY_COLORS[categoryName] || '#aaa';
  const pendingCount = entries.filter(([, d]) => d.status === 'pending').length;
  const allowedCount = entries.filter(([, d]) => d.status === 'allowed').length;
  const blockedCount = entries.filter(([, d]) => d.status !== 'pending' && d.status !== 'allowed').length;

  function handleApprovePending() {
    const pkgs = entries.filter(([, d]) => d.status === 'pending').map(([pkg]) => pkg);
    onBatchDecide(pkgs, 'approve');
  }

  function handleDenyPending() {
    const pkgs = entries.filter(([, d]) => d.status === 'pending').map(([pkg]) => pkg);
    onBatchDecide(pkgs, 'deny');
  }

  return (
    <div style={{ marginBottom: `${spacing.sm}px` }}>
      <button
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: `${spacing.sm}px`,
          padding: `10px ${spacing.md}px`,
          background: colors.surface.elevated,
          border: `1px solid ${colors.border}`,
          borderLeft: `4px solid ${color}`,
          borderRadius: `${radius.md}px`,
          cursor: 'pointer',
          textAlign: 'left',
          marginBottom: '4px',
        }}
        onClick={() => { window.callBare('haptic:tap'); onToggle(); }}
        aria-expanded={!collapsed}
      >
        <span style={{ flex: 1, fontSize: '13px', fontWeight: '600', color: colors.text.primary }}>{categoryName}</span>
        <span style={{ fontSize: '12px', color: colors.text.muted }}>{entries.length}</span>
        {pendingCount > 0 && (
          <span style={{ fontSize: '11px', color: '#FFFFFF', borderRadius: '10px', padding: '1px 7px', fontWeight: '700', backgroundColor: '#f59e0b' }}>{pendingCount}</span>
        )}
        <span style={{ fontSize: '16px', color: colors.text.muted, lineHeight: 1 }}>{collapsed ? '›' : '⌄'}</span>
      </button>
      {!collapsed && (
        <div style={batchAnimationStyle}>
          {pendingCount > 0 && (
            <div style={{ display: 'flex', gap: `${spacing.sm}px`, padding: `${spacing.sm}px 0`, borderBottom: `1px solid ${colors.divider}` }}>
              <button
                style={{ flex: 1, padding: `${spacing.sm}px ${spacing.md}px`, border: 'none', borderRadius: `${radius.md}px`, backgroundColor: colors.success, color: '#FFFFFF', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
                onClick={() => { window.callBare('haptic:tap'); handleApprovePending(); }}
              >
                Approve all {pendingCount} pending
              </button>
              <button
                style={{ flex: 1, padding: `${spacing.sm}px ${spacing.md}px`, border: 'none', borderRadius: `${radius.md}px`, backgroundColor: colors.error, color: '#FFFFFF', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
                onClick={() => { window.callBare('haptic:tap'); handleDenyPending(); }}
              >
                Deny all {pendingCount} pending
              </button>
            </div>
          )}
          <CategoryLimitControls
            categoryName={categoryName}
            savedSeconds={categoryLimitSeconds}
            onSave={(seconds) => onCategoryLimit(categoryName, seconds)}
            onApplyToAll={() => onCategoryApply(categoryName)}
            onClear={() => onCategoryClear(categoryName)}
          />
          {entries.map(([pkg, data]) => (
            <AppRow
              key={pkg}
              childPublicKey={childPublicKey}
              packageName={pkg}
              appData={data}
              onUpdate={onUpdate}
              onDecide={onDecide}
              override={overrideMap[pkg]}
              animationStyle={animatingItems?.[pkg]}
              categoryLimitSeconds={categoryLimitSeconds}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AppsTab({ childPublicKey }) {
  const { colors, spacing, radius } = useTheme();
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sortOrder, setSortOrder] = useState('alpha'); // 'alpha' | 'date'
  const [search, setSearch] = useState('');
  const [viewMode, setViewMode] = useState('category'); // 'status' | 'category'
  const [collapsed, setCollapsed] = useState({});
  const [overrides, setOverrides] = useState([]);
  const [animatingItems, setAnimatingItems] = useState({});
  const [animatingSection, setAnimatingSection] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null); // { kind, categoryName, message, action }
  const timersRef = useRef([]);

  const loadPolicy = useCallback(() => {
    window.callBare('policy:get', { childPublicKey })
      .then((p) => { setPolicy(p); setLoading(false); })
      .catch(() => setLoading(false));
  }, [childPublicKey]);

  const loadOverrides = useCallback(() => {
    window.callBare('overrides:list', { childPublicKey })
      .then(({ overrides }) => setOverrides(overrides || []))
      .catch(() => {});
  }, [childPublicKey]);

  useEffect(() => { loadPolicy(); loadOverrides(); }, [loadPolicy, loadOverrides]);

  useEffect(() => {
    window.callBare('pref:get', { key: 'appsTab:viewMode' })
      .then(v => { if (v) setViewMode(v); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unsub = window.onBareEvent('apps:synced', (data) => {
      if (data.childPublicKey === childPublicKey) { loadPolicy(); loadOverrides(); }
    });
    const unsub2 = window.onBareEvent('request:updated', loadOverrides);
    const unsub3 = window.onBareEvent('policy:updated', (data) => {
      if (data.childPublicKey === childPublicKey) { loadPolicy(); loadOverrides(); }
    });
    const timer = setInterval(loadOverrides, 30000);
    return () => { unsub(); unsub2(); unsub3(); clearInterval(timer); };
  }, [childPublicKey, loadPolicy, loadOverrides]);

  useEffect(() => {
    return () => timersRef.current.forEach(clearTimeout);
  }, []);

  function scheduleTimer(fn, ms) {
    const id = setTimeout(() => {
      timersRef.current = timersRef.current.filter(t => t !== id);
      fn();
    }, ms);
    timersRef.current.push(id);
  }

  function handleUpdate(packageName, newAppData) {
    const statusChanged = policy.apps[packageName]?.status !== newAppData.status;
    if (statusChanged && viewMode === 'status') {
      // Animate: exit, then update, then enter
      setAnimatingItems(prev => ({ ...prev, [packageName]: { animation: 'pgFadeSlideOut 300ms ease forwards' } }));
      scheduleTimer(() => {
        setPolicy(prev => {
          const newApps = { ...prev.apps, [packageName]: newAppData };
          const updated = { ...prev, apps: newApps };
          window.callBare('policy:update', { childPublicKey, policy: updated });
          return updated;
        });
        setAnimatingItems(prev => ({ ...prev, [packageName]: { animation: 'pgFadeSlideIn 300ms ease forwards' } }));
        scheduleTimer(() => {
          setAnimatingItems(prev => {
            const next = { ...prev };
            delete next[packageName];
            return next;
          });
        }, 300);
      }, 300);
    } else {
      const newApps = { ...policy.apps, [packageName]: newAppData };
      const newPolicy = { ...policy, apps: newApps };
      setPolicy(newPolicy);
      window.callBare('policy:update', { childPublicKey, policy: newPolicy });
    }
  }

  // Updates local state only - used by approve/deny which already send app:decide.
  // Avoids a redundant policy:update P2P alongside app:decision, preventing double
  // notifications on the child device (#68).
  function handleDecide(packageName, newStatus) {
    if (viewMode === 'status') {
      setAnimatingItems(prev => ({ ...prev, [packageName]: { animation: 'pgFadeSlideOut 300ms ease forwards' } }));
      scheduleTimer(() => {
        setPolicy(prev => ({
          ...prev,
          apps: { ...prev.apps, [packageName]: { ...prev.apps[packageName], status: newStatus } },
        }));
        setAnimatingItems(prev => ({ ...prev, [packageName]: { animation: 'pgFadeSlideIn 300ms ease forwards' } }));
        scheduleTimer(() => {
          setAnimatingItems(prev => {
            const next = { ...prev };
            delete next[packageName];
            return next;
          });
        }, 300);
      }, 300);
    } else {
      setPolicy(prev => ({
        ...prev,
        apps: { ...prev.apps, [packageName]: { ...prev.apps[packageName], status: newStatus } },
      }));
    }
  }

  function handleBatchDecide(packageNames, decision) {
    const newStatus = decision === 'approve' ? 'allowed' : 'blocked';
    if (viewMode === 'status') {
      setAnimatingSection({ phase: 'exiting' });
      scheduleTimer(() => {
        setPolicy(prev => {
          const apps = { ...prev.apps };
          for (const pkg of packageNames) {
            apps[pkg] = { ...apps[pkg], status: newStatus };
          }
          return { ...prev, apps };
        });
        window.callBare('apps:decideBatch', { childPublicKey, packageNames, decision });
        setAnimatingSection({ phase: 'entering' });
        scheduleTimer(() => {
          setAnimatingSection(null);
        }, 250);
      }, 250);
    } else {
      setPolicy(prev => {
        const apps = { ...prev.apps };
        for (const pkg of packageNames) {
          apps[pkg] = { ...apps[pkg], status: newStatus };
        }
        return { ...prev, apps };
      });
      window.callBare('apps:decideBatch', { childPublicKey, packageNames, decision });
    }
  }

  function persistPolicy(updater) {
    setPolicy(prev => {
      const next = updater(prev);
      window.callBare('policy:update', { childPublicKey, policy: next });
      return next;
    });
  }

  function handleCategoryLimit(categoryName, seconds) {
    persistPolicy(prev => {
      const categories = { ...(prev.categories || {}) };
      if (seconds == null) {
        delete categories[categoryName];
      } else {
        categories[categoryName] = { ...(categories[categoryName] || {}), dailyLimitSeconds: seconds };
      }
      return { ...prev, categories };
    });
  }

  function handleCategoryApply(categoryName) {
    const catLimit = policy.categories && policy.categories[categoryName];
    if (!catLimit || typeof catLimit.dailyLimitSeconds !== 'number') return;
    const affected = Object.values(policy.apps).filter(a => (a.category || 'Other') === categoryName).length;
    const mins = Math.round(catLimit.dailyLimitSeconds / 60);
    setConfirmDialog({
      kind: 'apply',
      categoryName,
      title: `Apply ${mins} min/day to ${categoryName}?`,
      message: `This will overwrite per-app limits on ${affected} app${affected === 1 ? '' : 's'} in the ${categoryName} category.`,
      confirmLabel: 'Apply',
      action: () => {
        persistPolicy(prev => {
          const seconds = catLimit.dailyLimitSeconds;
          const apps = { ...prev.apps };
          for (const pkg of Object.keys(apps)) {
            if ((apps[pkg].category || 'Other') === categoryName) {
              apps[pkg] = { ...apps[pkg], dailyLimitSeconds: seconds };
            }
          }
          return { ...prev, apps };
        });
      },
    });
  }

  function handleCategoryClear(categoryName) {
    const affected = Object.entries(policy.apps).filter(([, a]) => (a.category || 'Other') === categoryName && typeof a.dailyLimitSeconds === 'number').length;
    setConfirmDialog({
      kind: 'clear',
      categoryName,
      title: `Clear ${categoryName} limits?`,
      message: affected > 0
        ? `This removes the category limit and clears limits on ${affected} app${affected === 1 ? '' : 's'}.`
        : `This removes the ${categoryName} category limit.`,
      confirmLabel: 'Clear',
      action: () => {
        persistPolicy(prev => {
          const categories = { ...(prev.categories || {}) };
          delete categories[categoryName];
          const apps = { ...prev.apps };
          for (const pkg of Object.keys(apps)) {
            if ((apps[pkg].category || 'Other') === categoryName && 'dailyLimitSeconds' in apps[pkg]) {
              const { dailyLimitSeconds, ...rest } = apps[pkg];
              apps[pkg] = rest;
            }
          }
          return { ...prev, categories, apps };
        });
      },
    });
  }

  function runConfirm() {
    if (confirmDialog) confirmDialog.action();
    setConfirmDialog(null);
  }

  function toggleSection(key) {
    setCollapsed(prev => ({ ...prev, [key]: !(prev[key] ?? true) }));
  }

  if (loading) return <div style={{ padding: `${spacing.base}px`, color: colors.text.muted, fontSize: '14px' }}>Loading apps...</div>;
  if (!policy || !policy.apps || Object.keys(policy.apps).length === 0) {
    return <div style={{ padding: `${spacing.base}px`, color: colors.text.muted, fontSize: '14px' }}>No apps found. Apps appear here after they are installed on the child device.</div>;
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

  // Build packageName -> override lookup for active overrides
  const overrideMap = {};
  for (const o of overrides) {
    if (o.packageName) overrideMap[o.packageName] = o;
  }

  const batchStyle = animatingSection
    ? { animation: animatingSection.phase === 'exiting' ? 'pgFadeOut 250ms ease forwards' : 'pgFadeIn 250ms ease forwards' }
    : undefined;

  return (
    <div style={{ padding: `0 ${spacing.base}px ${spacing.base}px` }}>
      <style>{ANIMATION_STYLES}</style>
      <div style={{ position: 'sticky', top: 0, zIndex: 10, backgroundColor: colors.surface.base, paddingTop: `${spacing.base}px`, paddingBottom: `${spacing.sm}px`, display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search apps..."
          style={{
            width: '100%',
            padding: '7px 10px',
            fontSize: '13px',
            border: `1px solid ${colors.border}`,
            borderRadius: `${radius.md}px`,
            outline: 'none',
            color: colors.text.primary,
            backgroundColor: colors.surface.input,
            boxSizing: 'border-box',
          }}
          aria-label="Search apps"
        />
        <div style={{ display: 'flex', gap: `${spacing.md}px`, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: colors.text.muted }}>
            Sort by:
            <button
              style={{
                width: '100px',
                padding: '6px 10px',
                fontSize: '12px',
                border: `1px solid ${colors.border}`,
                borderRadius: `${radius.full}px`,
                background: colors.surface.elevated,
                cursor: 'pointer',
                color: colors.text.secondary,
                whiteSpace: 'nowrap',
                textAlign: 'center',
              }}
              onClick={() => { window.callBare('haptic:tap'); setSortOrder(s => s === 'alpha' ? 'date' : 'alpha'); }}
              aria-label="Toggle sort order"
            >
              {sortOrder === 'alpha' ? 'Name' : 'Install Date'}
            </button>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: colors.text.muted }}>
            Filter by:
            <button
              style={{
                width: '100px',
                padding: '6px 10px',
                fontSize: '12px',
                border: `1px solid ${colors.border}`,
                borderRadius: `${radius.full}px`,
                background: colors.surface.elevated,
                cursor: 'pointer',
                color: colors.text.secondary,
                whiteSpace: 'nowrap',
                textAlign: 'center',
              }}
              onClick={() => {
                window.callBare('haptic:tap');
                setViewMode(v => {
                  const next = v === 'status' ? 'category' : 'status';
                  window.callBare('pref:set', { key: 'appsTab:viewMode', value: next }).catch(() => {});
                  return next;
                });
              }}
              aria-label="Toggle view mode"
            >
              {viewMode === 'status' ? 'Status' : 'Category'}
            </button>
          </label>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`, marginBottom: `${spacing.md}px` }}>
        <span style={{ fontSize: '13px', color: colors.text.muted }}>
          {q ? `${visibleCount} of ${totalCount}` : totalCount} app{totalCount !== 1 ? 's' : ''}
        </span>
        {q && (
          <button
            style={{ fontSize: '12px', padding: '2px 8px', border: `1px solid ${colors.border}`, borderRadius: '10px', background: 'none', cursor: 'pointer', color: colors.text.secondary }}
            onClick={() => { window.callBare('haptic:tap'); setSearch(''); }}
          >
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
              onBatchDecide={handleBatchDecide}
              overrideMap={overrideMap}
              collapsed={q ? false : (collapsed[cat.key] ?? true)}
              onToggle={() => toggleSection(cat.key)}
              animatingItems={animatingItems}
              batchAnimationStyle={batchStyle}
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
              onCategoryLimit={handleCategoryLimit}
              onCategoryApply={handleCategoryApply}
              onCategoryClear={handleCategoryClear}
              categoryLimitSeconds={policy.categories && policy.categories[catName] && policy.categories[catName].dailyLimitSeconds}
              overrideMap={overrideMap}
              collapsed={q ? false : (collapsed[catName] ?? true)}
              onToggle={() => toggleSection(catName)}
              animatingItems={animatingItems}
              batchAnimationStyle={batchStyle}
            />
          );
        })
      )}
      <Modal
        visible={!!confirmDialog}
        onClose={() => setConfirmDialog(null)}
        title={confirmDialog?.title || ''}
        footer={<>
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); setConfirmDialog(null); }} style={{ flex: 1 }}>Cancel</Button>
          <Button variant="danger" onClick={() => { window.callBare('haptic:tap'); runConfirm(); }} style={{ flex: 1 }}>{confirmDialog?.confirmLabel || 'Confirm'}</Button>
        </>}
      >
        <div style={{ textAlign: 'center' }}>{confirmDialog?.message}</div>
      </Modal>
    </div>
  );
}
