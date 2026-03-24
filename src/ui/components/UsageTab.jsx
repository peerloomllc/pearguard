import React, { useState, useEffect } from 'react';

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
  return `${m}m`;
}

function UsageBar({ appName, todaySeconds, weekSeconds, dailyLimitSeconds }) {
  const maxSeconds = dailyLimitSeconds || 3600; // fallback to 1h for display
  const todayPct = Math.min(100, (todaySeconds / maxSeconds) * 100);
  const weekPct = Math.min(100, (weekSeconds / (maxSeconds * 7)) * 100);
  const overLimit = dailyLimitSeconds && todaySeconds > dailyLimitSeconds;

  return (
    <div style={styles.usageRow}>
      <div style={styles.appName}>{appName}</div>
      <div style={styles.bars}>
        <div style={styles.barLabel}>Today: {formatSeconds(todaySeconds)}</div>
        <div style={styles.barTrack}>
          <div
            style={{
              ...styles.barFill,
              width: `${todayPct}%`,
              backgroundColor: overLimit ? '#ea4335' : '#1a73e8',
            }}
          />
        </div>
        <div style={styles.barLabel}>This week: {formatSeconds(weekSeconds)}</div>
        <div style={styles.barTrack}>
          <div style={{ ...styles.barFill, width: `${weekPct}%`, backgroundColor: '#34a853' }} />
        </div>
      </div>
    </div>
  );
}

export default function UsageTab({ childPublicKey }) {
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    window.callBare('usage:getLatest', { childPublicKey })
      .then((data) => {
        setReport(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    // Also update when a fresh report arrives over P2P while the tab is open.
    // Only overwrite if the incoming report has actual app data — empty reports
    // (e.g. from a flush that ran before permissions were granted) should not
    // wipe out a previously displayed valid report.
    const unsub = window.onBareEvent('usage:report', (data) => {
      if (data && data.childPublicKey === childPublicKey && data.apps && data.apps.length > 0) {
        setReport(data);
        setLoading(false);
      }
    });
    return unsub;
  }, [childPublicKey]);

  if (loading) return <div style={styles.msg}>Loading usage data...</div>;
  if (!report || !report.apps || report.apps.length === 0) {
    return <div style={styles.msg}>No usage data yet. Data syncs every 5 minutes.</div>;
  }

  return (
    <div style={styles.container}>
      <p style={styles.syncLabel}>Last synced: {timeAgo(report.lastSynced || report.timestamp)}</p>
      {report.apps.map((app) => (
        <UsageBar
          key={app.packageName}
          appName={app.displayName || app.packageName}
          todaySeconds={app.todaySeconds}
          weekSeconds={app.weekSeconds}
          dailyLimitSeconds={app.dailyLimitSeconds}
        />
      ))}
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  msg: { padding: '16px', color: '#666', fontSize: '14px' },
  syncLabel: { fontSize: '12px', color: '#888', marginBottom: '16px' },
  usageRow: { marginBottom: '20px' },
  appName: { fontSize: '14px', fontWeight: '600', marginBottom: '6px' },
  bars: {},
  barLabel: { fontSize: '12px', color: '#555', marginBottom: '3px', marginTop: '6px' },
  barTrack: {
    height: '8px',
    backgroundColor: '#eee',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: '4px',
    transition: 'width 0.3s ease',
  },
};
