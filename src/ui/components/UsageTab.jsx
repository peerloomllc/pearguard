import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import Button from './primitives/Button.jsx';

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

function UsageBar({ appName, todaySeconds, weekSeconds, dailyLimitSeconds, index }) {
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
      <div style={{ fontSize: '14px', fontWeight: '600', marginBottom: '6px', color: colors.text.primary }}>{appName}</div>
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
  const { colors, spacing } = useTheme();
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.callBare('usage:getLatest', { childPublicKey })
      .then((data) => {
        setReport(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    const unsub = window.onBareEvent('usage:report', (data) => {
      if (data && data.childPublicKey === childPublicKey && data.apps && data.apps.length > 0) {
        setReport(data);
        setLoading(false);
      }
    });
    return unsub;
  }, [childPublicKey]);

  if (loading) return <div style={{ padding: `${spacing.base}px`, color: colors.text.muted, fontSize: '14px' }}>Loading usage data...</div>;
  if (!report || !report.apps || report.apps.length === 0) {
    return <div style={{ padding: `${spacing.base}px`, color: colors.text.muted, fontSize: '14px' }}>No usage data yet. Data syncs every 15 minutes.</div>;
  }

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${spacing.xs}px`, marginBottom: `${spacing.base}px` }}>
        {onShowReports && (
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); onShowReports(); }} style={{ fontSize: '12px', padding: '4px 12px' }}>See Reports</Button>
        )}
        <p style={{ fontSize: '12px', color: colors.text.muted, margin: 0 }}>Last synced: {timeAgo(report.lastSynced || report.timestamp)}</p>
      </div>
      {[...report.apps].sort((a, b) => b.todaySeconds - a.todaySeconds).map((app, i) => (
        <UsageBar
          key={app.packageName}
          appName={app.displayName || app.packageName}
          todaySeconds={app.todaySeconds}
          weekSeconds={app.weekSeconds}
          dailyLimitSeconds={app.dailyLimitSeconds}
          index={i}
        />
      ))}
    </div>
  );
}
