import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';

const VIEWS = [
  { key: 'daily', label: 'Daily' },
  { key: 'trends', label: 'Trends' },
  { key: 'apps', label: 'Apps' },
  { key: 'categories', label: 'Categories' },
];

function formatSeconds(s) {
  if (!s || s <= 0) return '0m';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);
  if (dateStr === todayStr) return 'Today';
  if (dateStr === yesterdayStr) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function dateOffset(dateStr, offset) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
}

// --- Hourly Bar Chart (SVG) ---

function HourlyChart({ sessions, colors }) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    setAnimated(false);
    const t = requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimated(true));
    });
    return () => cancelAnimationFrame(t);
  }, [sessions]);

  const hours = new Array(24).fill(0);
  for (const s of sessions) {
    const hour = new Date(s.startedAt).getHours();
    hours[hour] += s.durationSeconds || 0;
  }
  const maxSeconds = Math.max(...hours, 1);

  const chartW = 300;
  const chartH = 120;
  const barW = (chartW - 23 * 2) / 24;
  const labels = [0, 6, 12, 18, 23];

  return (
    <svg viewBox={`0 0 ${chartW} ${chartH + 20}`} style={{ width: '100%', maxWidth: '400px', display: 'block', margin: '0 auto' }}>
      {hours.map((sec, i) => {
        const pct = sec / maxSeconds;
        const barH = pct * chartH;
        const x = i * (barW + 2);
        return (
          <rect
            key={i}
            x={x}
            y={animated ? chartH - barH : chartH}
            width={barW}
            height={animated ? barH : 0}
            rx={2}
            fill={sec > 0 ? colors.primary : colors.surface.elevated}
            style={{
              transition: `y 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.02}s, height 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.02}s`,
            }}
          />
        );
      })}
      {labels.map((h) => (
        <text
          key={h}
          x={h * (barW + 2) + barW / 2}
          y={chartH + 14}
          textAnchor="middle"
          fill={colors.text.muted}
          fontSize="9"
        >
          {h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
        </text>
      ))}
    </svg>
  );
}

// --- Top Apps List ---

function TopApps({ sessions, colors, spacing }) {
  const appMap = {};
  for (const s of sessions) {
    if (!appMap[s.packageName]) {
      appMap[s.packageName] = { displayName: s.displayName || s.packageName, totalSeconds: 0 };
    }
    appMap[s.packageName].totalSeconds += s.durationSeconds || 0;
  }
  const sorted = Object.values(appMap).sort((a, b) => b.totalSeconds - a.totalSeconds).slice(0, 5);
  if (sorted.length === 0) return null;

  return (
    <div style={{ marginTop: `${spacing.base}px` }}>
      <div style={{ fontSize: '13px', fontWeight: '600', color: colors.text.secondary, marginBottom: `${spacing.sm}px` }}>Top Apps</div>
      {sorted.map((app, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: `${spacing.xs}px 0` }}>
          <span style={{ fontSize: '14px', color: colors.text.primary }}>{app.displayName}</span>
          <span style={{ fontSize: '13px', color: colors.text.muted }}>{formatSeconds(app.totalSeconds)}</span>
        </div>
      ))}
    </div>
  );
}

// --- Daily Summary View ---

function DailySummary({ childPublicKey, colors, spacing, radius }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [fadeDir, setFadeDir] = useState(null);

  const today = new Date().toISOString().slice(0, 10);
  const minDate = dateOffset(today, -29);

  const fetchSessions = useCallback((d) => {
    setLoading(true);
    window.callBare('usage:getSessions', { childPublicKey, date: d })
      .then((data) => { setSessions(data || []); setLoading(false); })
      .catch(() => { setSessions([]); setLoading(false); });
  }, [childPublicKey]);

  useEffect(() => { fetchSessions(date); }, [date, fetchSessions]);

  function navigate(dir) {
    const next = dateOffset(date, dir);
    if (next > today || next < minDate) return;
    setFadeDir(dir);
    setTimeout(() => {
      setDate(next);
      setFadeDir(null);
    }, 150);
  }

  const totalSeconds = sessions.reduce((sum, s) => sum + (s.durationSeconds || 0), 0);
  const sessionCount = sessions.length;
  const canGoBack = dateOffset(date, -1) >= minDate;
  const canGoForward = date < today;

  return (
    <div style={{
      opacity: fadeDir !== null ? 0.3 : 1,
      transform: fadeDir !== null ? `translateX(${fadeDir > 0 ? -20 : 20}px)` : 'translateX(0)',
      transition: 'opacity 0.15s ease, transform 0.15s ease',
    }}>
      {/* Day selector */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: `${spacing.md}px`, marginBottom: `${spacing.base}px` }}>
        <button
          onClick={() => navigate(-1)}
          disabled={!canGoBack}
          style={{ background: 'none', border: 'none', cursor: canGoBack ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoBack ? 1 : 0.3 }}
        >
          <Icon name="CaretLeft" size={20} color={colors.text.primary} />
        </button>
        <span style={{ fontSize: '15px', fontWeight: '600', color: colors.text.primary, minWidth: '140px', textAlign: 'center' }}>
          {formatDate(date)}
        </span>
        <button
          onClick={() => navigate(1)}
          disabled={!canGoForward}
          style={{ background: 'none', border: 'none', cursor: canGoForward ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoForward ? 1 : 0.3 }}
        >
          <Icon name="CaretRight" size={20} color={colors.text.primary} />
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>Loading...</div>
      ) : sessions.length === 0 ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>No usage data for this day.</div>
      ) : (
        <>
          {/* Summary stats */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: `${spacing.xl}px`, marginBottom: `${spacing.base}px` }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '24px', fontWeight: '700', color: colors.text.primary }}>{formatSeconds(totalSeconds)}</div>
              <div style={{ fontSize: '12px', color: colors.text.muted }}>Screen Time</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '24px', fontWeight: '700', color: colors.text.primary }}>{sessionCount}</div>
              <div style={{ fontSize: '12px', color: colors.text.muted }}>Sessions</div>
            </div>
          </div>

          <HourlyChart sessions={sessions} colors={colors} />
          <TopApps sessions={sessions} colors={colors} spacing={spacing} />
        </>
      )}
    </div>
  );
}

// --- Main UsageReports Component ---

export default function UsageReports({ childPublicKey, onBack }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [view, setView] = useState('daily');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.surface.base }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: `${spacing.md}px`,
        padding: `${spacing.md}px ${spacing.base}px`,
        borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}>
          <Icon name="CaretLeft" size={20} color={colors.primary} />
        </button>
        <span style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600' }}>Usage Reports</span>
      </div>

      {/* Pill selector */}
      <div style={{
        display: 'flex', gap: `${spacing.xs}px`,
        padding: `${spacing.sm}px ${spacing.base}px`,
        backgroundColor: colors.surface.card,
        borderBottom: `1px solid ${colors.border}`,
      }}>
        {VIEWS.map((v) => {
          const active = v.key === view;
          return (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              style={{
                flex: 1,
                padding: `${spacing.xs + 2}px ${spacing.sm}px`,
                border: 'none',
                borderRadius: `${radius.md}px`,
                cursor: 'pointer',
                fontSize: '13px',
                fontWeight: active ? '600' : '400',
                backgroundColor: active ? colors.primary : 'transparent',
                color: active ? '#fff' : colors.text.muted,
                transition: 'background-color 0.2s ease, color 0.2s ease',
              }}
            >
              {v.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: `${spacing.base}px` }}>
        {view === 'daily' && <DailySummary childPublicKey={childPublicKey} colors={colors} spacing={spacing} radius={radius} />}
        {view === 'trends' && <div style={{ color: colors.text.muted, fontSize: '14px' }}>Weekly trends coming next...</div>}
        {view === 'apps' && <div style={{ color: colors.text.muted, fontSize: '14px' }}>App drill-down coming next...</div>}
        {view === 'categories' && <div style={{ color: colors.text.muted, fontSize: '14px' }}>Category breakdown coming next...</div>}
      </div>
    </div>
  );
}
