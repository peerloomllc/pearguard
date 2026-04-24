import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../theme.js';
import Button from './primitives/Button.jsx';
import Icon from '../icons.js';

function timeAgo(timestamp) {
  if (!timestamp) return 'Never';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatSeconds(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function UsageBar({ appName, todaySeconds, weekSeconds, dailyLimitSeconds, index, onHide }) {
  const { colors, spacing, radius } = useTheme();
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setAnimated(true), 80 * index);
    return () => clearTimeout(timer);
  }, [index]);

  const todayScale = dailyLimitSeconds || 86400;
  const weekScale = dailyLimitSeconds ? dailyLimitSeconds * 7 : 604800;
  const todayPct = Math.min(100, (todaySeconds / todayScale) * 100);
  const weekPct = Math.min(100, (weekSeconds / weekScale) * 100);
  const overLimit = dailyLimitSeconds && todaySeconds > dailyLimitSeconds;

  return (
    <div style={{ marginBottom: `${spacing.lg}px` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
        <div style={{ fontSize: '14px', fontWeight: '600', color: colors.text.primary }}>{appName}</div>
        {onHide && (
          <button
            onClick={onHide}
            title="Hide from usage"
            aria-label={`Hide ${appName} from usage`}
            style={{ background: 'none', border: 'none', padding: '4px', cursor: 'pointer', color: colors.text.muted, display: 'flex', alignItems: 'center', borderRadius: `${radius.sm}px` }}
          >
            <Icon name="EyeSlash" size={18} />
          </button>
        )}
      </div>
      <div>
        <div style={{ fontSize: '12px', color: colors.text.secondary, marginBottom: '3px', marginTop: '6px' }}>Today: {formatSeconds(todaySeconds)}{dailyLimitSeconds ? ` of ${formatSeconds(dailyLimitSeconds)}` : ''}</div>
        <div style={{ height: '8px', backgroundColor: colors.surface.elevated, borderRadius: `${radius.sm}px`, overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              borderRadius: `${radius.sm}px`,
              transition: 'width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
              width: animated ? `${todayPct}%` : '0%',
              backgroundColor: overLimit ? colors.error : colors.primary,
            }}
          />
        </div>
        <div style={{ fontSize: '12px', color: colors.text.secondary, marginBottom: '3px', marginTop: '6px' }}>Last 7 days: {formatSeconds(weekSeconds)}</div>
        <div style={{ height: '8px', backgroundColor: colors.surface.elevated, borderRadius: `${radius.sm}px`, overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              borderRadius: `${radius.sm}px`,
              transition: 'width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)',
              transitionDelay: `${0.1 + 0.08 * index}s`,
              width: animated ? `${weekPct}%` : '0%',
              backgroundColor: colors.success,
            }}
          />
        </div>
      </div>
    </div>
  );
}

export default function UsageTab({ childPublicKey, onShowReports }) {
  const { colors, spacing, radius } = useTheme();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [hidden, setHidden] = useState([]);
  const [showHidden, setShowHidden] = useState(false);

  const refreshHidden = useCallback(() => {
    window.callBare('usage:getExclusions', { childPublicKey })
      .then((list) => setHidden(Array.isArray(list) ? list : []))
      .catch(() => setHidden([]));
  }, [childPublicKey]);

  useEffect(() => {
    window.callBare('usage:getLatest', { childPublicKey })
      .then((data) => {
        setReport(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    refreshHidden();

    const unsub = window.onBareEvent('usage:report', (data) => {
      if (data && data.childPublicKey === childPublicKey && data.apps) {
        setReport(data);
        setLoading(false);
      }
    });
    return unsub;
  }, [childPublicKey, refreshHidden]);

  const handleHide = useCallback((packageName, displayName) => {
    window.callBare('haptic:tap');
    window.callBare('usage:setExclusion', { childPublicKey, packageName, displayName, excluded: true })
      .then(refreshHidden)
      .catch((e) => console.error('[UsageTab] hide failed:', e));
  }, [childPublicKey, refreshHidden]);

  const handleUnhide = useCallback((packageName) => {
    window.callBare('haptic:tap');
    window.callBare('usage:setExclusion', { childPublicKey, packageName, excluded: false })
      .then(refreshHidden)
      .catch((e) => console.error('[UsageTab] unhide failed:', e));
  }, [childPublicKey, refreshHidden]);

  if (loading) return <div style={{ padding: `${spacing.base}px`, color: colors.text.muted, fontSize: '14px' }}>Loading usage data...</div>;

  const apps = report && Array.isArray(report.apps) ? report.apps : [];
  const hasApps = apps.length > 0;

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${spacing.xs}px`, marginBottom: `${spacing.base}px` }}>
        {onShowReports && (
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); onShowReports(); }} style={{ fontSize: '12px', padding: '4px 12px' }}>See Reports</Button>
        )}
        {report && <p style={{ fontSize: '12px', color: colors.text.muted, margin: 0 }}>Last synced: {timeAgo(report.lastSynced || report.timestamp)}</p>}
      </div>

      {!hasApps && (
        <div style={{ color: colors.text.muted, fontSize: '14px', textAlign: 'center', marginBottom: `${spacing.base}px` }}>
          No usage data yet. Data syncs every 15 minutes.
        </div>
      )}

      {hasApps && [...apps].sort((a, b) => b.todaySeconds - a.todaySeconds).map((app, i) => (
        <UsageBar
          key={app.packageName}
          appName={app.displayName || app.packageName}
          todaySeconds={app.todaySeconds}
          weekSeconds={app.weekSeconds}
          dailyLimitSeconds={app.dailyLimitSeconds}
          index={i}
          onHide={() => handleHide(app.packageName, app.displayName || app.packageName)}
        />
      ))}

      {hidden.length > 0 && (
        <div style={{ marginTop: `${spacing.lg}px`, paddingTop: `${spacing.base}px`, borderTop: `1px solid ${colors.border}` }}>
          <button
            onClick={() => { window.callBare('haptic:tap'); setShowHidden((s) => !s); }}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: colors.text.secondary, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}
          >
            <Icon name={showHidden ? 'Eye' : 'EyeSlash'} size={16} />
            {hidden.length} hidden {hidden.length === 1 ? 'app' : 'apps'}
          </button>
          {showHidden && (
            <div style={{ marginTop: `${spacing.sm}px`, display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px` }}>
              {hidden.map((h) => (
                <div key={h.packageName} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `${spacing.xs}px ${spacing.sm}px`, backgroundColor: colors.surface.elevated, borderRadius: `${radius.sm}px` }}>
                  <span style={{ fontSize: '13px', color: colors.text.primary }}>{h.displayName}</span>
                  <button
                    onClick={() => handleUnhide(h.packageName)}
                    style={{ background: 'none', border: `1px solid ${colors.border}`, padding: '4px 10px', cursor: 'pointer', color: colors.text.secondary, fontSize: '12px', borderRadius: `${radius.sm}px` }}
                  >
                    Unhide
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
