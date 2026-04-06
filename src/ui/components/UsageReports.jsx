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

// --- Weekly Trends View ---

function WeeklyTrends({ childPublicKey, colors, spacing, radius }) {
  const [period, setPeriod] = useState(7);
  const [summaries, setSummaries] = useState([]);
  const [prevSummaries, setPrevSummaries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    setLoading(true);
    setAnimated(false);
    Promise.all([
      window.callBare('usage:getDailySummaries', { childPublicKey, days: period }),
      window.callBare('usage:getDailySummaries', { childPublicKey, days: period * 2 }),
    ]).then(([current, extended]) => {
      setSummaries((current || []).reverse());
      setPrevSummaries((extended || []).slice(period).reverse());
      setLoading(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setAnimated(true));
      });
    }).catch(() => { setSummaries([]); setPrevSummaries([]); setLoading(false); });
  }, [childPublicKey, period]);

  if (loading) return <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>Loading...</div>;

  const maxSeconds = Math.max(...summaries.map((s) => s.totalSeconds), 1);
  const avgSeconds = summaries.length > 0 ? summaries.reduce((sum, s) => sum + s.totalSeconds, 0) / summaries.length : 0;
  const prevAvg = prevSummaries.length > 0 ? prevSummaries.reduce((sum, s) => sum + s.totalSeconds, 0) / prevSummaries.length : 0;
  const changePct = prevAvg > 0 ? Math.round(((avgSeconds - prevAvg) / prevAvg) * 100) : null;

  const chartW = 300;
  const chartH = 140;
  const gap = period <= 7 ? 4 : 1;
  const barW = (chartW - (summaries.length - 1) * gap) / Math.max(summaries.length, 1);
  const avgY = maxSeconds > 0 ? chartH - (avgSeconds / maxSeconds) * chartH : chartH;

  return (
    <div>
      {/* Period toggle */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: `${spacing.xs}px`, marginBottom: `${spacing.base}px` }}>
        {[7, 30].map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            style={{
              padding: `${spacing.xs}px ${spacing.md}px`,
              border: 'none',
              borderRadius: `${radius.md}px`,
              cursor: 'pointer',
              fontSize: '13px',
              fontWeight: period === p ? '600' : '400',
              backgroundColor: period === p ? colors.primary : colors.surface.elevated,
              color: period === p ? '#fff' : colors.text.muted,
              transition: 'background-color 0.2s ease, color 0.2s ease',
            }}
          >
            {p} days
          </button>
        ))}
      </div>

      {/* Stats row */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: `${spacing.xl}px`, marginBottom: `${spacing.base}px` }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: '20px', fontWeight: '700', color: colors.text.primary }}>{formatSeconds(Math.round(avgSeconds))}</div>
          <div style={{ fontSize: '12px', color: colors.text.muted }}>Daily Average</div>
        </div>
        {changePct !== null && (
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '20px', fontWeight: '700', color: changePct > 0 ? colors.error : colors.success }}>
              {changePct > 0 ? '+' : ''}{changePct}%
            </div>
            <div style={{ fontSize: '12px', color: colors.text.muted }}>vs Previous</div>
          </div>
        )}
      </div>

      {/* Bar chart */}
      {summaries.length > 0 && (
        <svg viewBox={`0 0 ${chartW} ${chartH + 20}`} style={{ width: '100%', maxWidth: '400px', display: 'block', margin: '0 auto' }}>
          {/* Average line */}
          <line x1={0} y1={avgY} x2={chartW} y2={avgY} stroke={colors.text.muted} strokeDasharray="4 3" strokeWidth={1} opacity={0.5} />

          {/* Bars */}
          {summaries.map((s, i) => {
            const barH = maxSeconds > 0 ? (s.totalSeconds / maxSeconds) * chartH : 0;
            const x = i * (barW + gap);
            return (
              <rect
                key={i}
                x={x}
                y={animated ? chartH - barH : chartH}
                width={barW}
                height={animated ? barH : 0}
                rx={period <= 7 ? 3 : 1}
                fill={colors.primary}
                style={{
                  transition: `y 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.03}s, height 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.03}s`,
                }}
              />
            );
          })}

          {/* Date labels (only for 7-day view) */}
          {period <= 7 && summaries.map((s, i) => (
            <text
              key={i}
              x={i * (barW + gap) + barW / 2}
              y={chartH + 14}
              textAnchor="middle"
              fill={colors.text.muted}
              fontSize="9"
            >
              {new Date(s.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2)}
            </text>
          ))}
        </svg>
      )}

      {summaries.length === 0 && (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>No trend data available yet.</div>
      )}
    </div>
  );
}

// --- Sparkline ---

function Sparkline({ data, colors, width = 120, height = 30 }) {
  if (!data || data.length === 0) return null;
  const max = Math.max(...data.map((d) => d.totalSeconds), 1);
  const step = width / Math.max(data.length - 1, 1);
  const points = data.map((d, i) => {
    const x = i * step;
    const y = height - (d.totalSeconds / max) * height;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: `${width}px`, height: `${height}px` }}>
      <polyline points={points} fill="none" stroke={colors.primary} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

// --- Per-App Drill-Down View ---

function AppDrillDown({ childPublicKey, colors, spacing, radius }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);
  const [sparkData, setSparkData] = useState({});

  const today = new Date().toISOString().slice(0, 10);
  const minDate = dateOffset(today, -29);

  useEffect(() => {
    setLoading(true);
    window.callBare('usage:getSessions', { childPublicKey, date })
      .then((data) => { setSessions(data || []); setLoading(false); })
      .catch(() => { setSessions([]); setLoading(false); });
  }, [childPublicKey, date]);

  // Aggregate by app
  const appMap = {};
  for (const s of sessions) {
    if (!appMap[s.packageName]) {
      appMap[s.packageName] = { packageName: s.packageName, displayName: s.displayName || s.packageName, totalSeconds: 0, sessions: [] };
    }
    appMap[s.packageName].totalSeconds += s.durationSeconds || 0;
    appMap[s.packageName].sessions.push(s);
  }
  const apps = Object.values(appMap).sort((a, b) => b.totalSeconds - a.totalSeconds);

  function handleExpand(pkg) {
    if (expanded === pkg) { setExpanded(null); return; }
    setExpanded(pkg);
    if (!sparkData[pkg]) {
      window.callBare('usage:getDailySummaries', { childPublicKey, days: 7, packageName: pkg })
        .then((data) => setSparkData((prev) => ({ ...prev, [pkg]: (data || []).reverse() })))
        .catch(() => {});
    }
  }

  const canGoBack = dateOffset(date, -1) >= minDate;
  const canGoForward = date < today;

  return (
    <div>
      {/* Day selector */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: `${spacing.md}px`, marginBottom: `${spacing.base}px` }}>
        <button
          onClick={() => { if (canGoBack) setDate(dateOffset(date, -1)); }}
          disabled={!canGoBack}
          style={{ background: 'none', border: 'none', cursor: canGoBack ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoBack ? 1 : 0.3 }}
        >
          <Icon name="CaretLeft" size={20} color={colors.text.primary} />
        </button>
        <span style={{ fontSize: '15px', fontWeight: '600', color: colors.text.primary, minWidth: '140px', textAlign: 'center' }}>
          {formatDate(date)}
        </span>
        <button
          onClick={() => { if (canGoForward) setDate(dateOffset(date, 1)); }}
          disabled={!canGoForward}
          style={{ background: 'none', border: 'none', cursor: canGoForward ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoForward ? 1 : 0.3 }}
        >
          <Icon name="CaretRight" size={20} color={colors.text.primary} />
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>Loading...</div>
      ) : apps.length === 0 ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>No app usage for this day.</div>
      ) : (
        apps.map((app) => {
          const isExpanded = expanded === app.packageName;
          const appSessions = app.sessions.sort((a, b) => a.startedAt - b.startedAt);
          const longestSession = Math.max(...appSessions.map((s) => s.durationSeconds || 0));
          const avgSession = Math.round(app.totalSeconds / appSessions.length);

          return (
            <div
              key={app.packageName}
              style={{
                marginBottom: `${spacing.xs}px`,
                backgroundColor: colors.surface.card,
                borderRadius: `${radius.md}px`,
                overflow: 'hidden',
                transition: 'background-color 0.2s ease',
              }}
            >
              {/* App row */}
              <button
                onClick={() => handleExpand(app.packageName)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: `${spacing.sm + 2}px ${spacing.md}px`,
                  border: 'none', background: 'none', cursor: 'pointer',
                }}
              >
                <span style={{ fontSize: '14px', fontWeight: '500', color: colors.text.primary }}>{app.displayName}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
                  <span style={{ fontSize: '13px', color: colors.text.muted }}>{formatSeconds(app.totalSeconds)}</span>
                  <Icon name={isExpanded ? 'CaretUp' : 'CaretDown'} size={14} color={colors.text.muted} />
                </div>
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div style={{
                  padding: `0 ${spacing.md}px ${spacing.md}px`,
                  borderTop: `1px solid ${colors.border}`,
                }}>
                  {/* Stats */}
                  <div style={{ display: 'flex', gap: `${spacing.md}px`, padding: `${spacing.sm}px 0`, flexWrap: 'wrap' }}>
                    <div>
                      <div style={{ fontSize: '11px', color: colors.text.muted }}>Sessions</div>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: colors.text.primary }}>{appSessions.length}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: colors.text.muted }}>Longest</div>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: colors.text.primary }}>{formatSeconds(longestSession)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '11px', color: colors.text.muted }}>Average</div>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: colors.text.primary }}>{formatSeconds(avgSession)}</div>
                    </div>
                  </div>

                  {/* Sparkline */}
                  {sparkData[app.packageName] && (
                    <div style={{ padding: `${spacing.xs}px 0` }}>
                      <div style={{ fontSize: '11px', color: colors.text.muted, marginBottom: '4px' }}>Last 7 days</div>
                      <Sparkline data={sparkData[app.packageName]} colors={colors} />
                    </div>
                  )}

                  {/* Session list */}
                  <div style={{ marginTop: `${spacing.sm}px` }}>
                    <div style={{ fontSize: '11px', color: colors.text.muted, marginBottom: '4px' }}>Sessions</div>
                    {appSessions.map((s, i) => {
                      const start = new Date(s.startedAt);
                      const end = s.endedAt ? new Date(s.endedAt) : null;
                      const fmt = (d) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                      return (
                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: '13px' }}>
                          <span style={{ color: colors.text.secondary }}>{fmt(start)} - {end ? fmt(end) : 'now'}</span>
                          <span style={{ color: colors.text.muted }}>{formatSeconds(s.durationSeconds)}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// --- Category Breakdown View ---

const CATEGORY_COLORS = {
  'Games': '#FF6B6B',
  'Social': '#4ECDC4',
  'Video & Music': '#45B7D1',
  'Communication': '#96CEB4',
  'Education': '#FFEAA7',
  'News': '#DDA0DD',
  'Productivity': '#98D8C8',
  'System': '#778899',
  'Other': '#B0B0B0',
};

function DonutChart({ categories, colors, totalSeconds }) {
  const [animated, setAnimated] = useState(false);
  useEffect(() => {
    setAnimated(false);
    const t = requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimated(true));
    });
    return () => cancelAnimationFrame(t);
  }, [categories]);

  const size = 160;
  const cx = size / 2;
  const cy = size / 2;
  const outerR = 70;
  const innerR = 45;
  const midR = (outerR + innerR) / 2;
  const circumference = 2 * Math.PI * midR;

  let currentAngle = 0;
  const segments = categories.map((cat) => {
    const fraction = totalSeconds > 0 ? cat.totalSeconds / totalSeconds : 0;
    const dashLen = circumference * fraction;
    const dashOff = animated ? 0 : dashLen;
    const rotation = currentAngle;
    currentAngle += fraction * 360;
    return { ...cat, fraction, dashLen, dashOff, rotation };
  });

  return (
    <svg viewBox={`0 0 ${size} ${size}`} style={{ width: `${size}px`, height: `${size}px`, display: 'block', margin: '0 auto' }}>
      <circle cx={cx} cy={cy} r={midR} fill="none" stroke={colors.surface.elevated} strokeWidth={outerR - innerR} />
      {segments.map((seg, i) => (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={midR}
          fill="none"
          stroke={CATEGORY_COLORS[seg.category] || CATEGORY_COLORS['Other']}
          strokeWidth={outerR - innerR}
          strokeDasharray={`${seg.dashLen} ${circumference - seg.dashLen}`}
          strokeDashoffset={seg.dashOff}
          transform={`rotate(${seg.rotation - 90} ${cx} ${cy})`}
          style={{
            transition: `stroke-dashoffset 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94) ${i * 0.1}s`,
          }}
        />
      ))}
      <text x={cx} y={cy - 6} textAnchor="middle" fill={colors.text.primary} fontSize="16" fontWeight="700">
        {formatSeconds(totalSeconds)}
      </text>
      <text x={cx} y={cy + 10} textAnchor="middle" fill={colors.text.muted} fontSize="9">
        Total
      </text>
    </svg>
  );
}

function CategoryBreakdown({ childPublicKey, colors, spacing, radius }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  const today = new Date().toISOString().slice(0, 10);
  const minDate = dateOffset(today, -29);

  useEffect(() => {
    setLoading(true);
    window.callBare('usage:getCategorySummary', { childPublicKey, date })
      .then((data) => { setCategories(data || []); setLoading(false); })
      .catch(() => { setCategories([]); setLoading(false); });
  }, [childPublicKey, date]);

  const totalSeconds = categories.reduce((sum, c) => sum + c.totalSeconds, 0);
  const canGoBack = dateOffset(date, -1) >= minDate;
  const canGoForward = date < today;

  return (
    <div>
      {/* Day selector */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: `${spacing.md}px`, marginBottom: `${spacing.base}px` }}>
        <button
          onClick={() => { if (canGoBack) setDate(dateOffset(date, -1)); }}
          disabled={!canGoBack}
          style={{ background: 'none', border: 'none', cursor: canGoBack ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoBack ? 1 : 0.3 }}
        >
          <Icon name="CaretLeft" size={20} color={colors.text.primary} />
        </button>
        <span style={{ fontSize: '15px', fontWeight: '600', color: colors.text.primary, minWidth: '140px', textAlign: 'center' }}>
          {formatDate(date)}
        </span>
        <button
          onClick={() => { if (canGoForward) setDate(dateOffset(date, 1)); }}
          disabled={!canGoForward}
          style={{ background: 'none', border: 'none', cursor: canGoForward ? 'pointer' : 'default', padding: `${spacing.xs}px`, opacity: canGoForward ? 1 : 0.3 }}
        >
          <Icon name="CaretRight" size={20} color={colors.text.primary} />
        </button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>Loading...</div>
      ) : categories.length === 0 ? (
        <div style={{ textAlign: 'center', color: colors.text.muted, fontSize: '14px', padding: `${spacing.lg}px 0` }}>No category data for this day.</div>
      ) : (
        <>
          <DonutChart categories={categories} colors={colors} totalSeconds={totalSeconds} />

          <div style={{ marginTop: `${spacing.base}px` }}>
            {categories.map((cat) => {
              const isExpanded = expanded === cat.category;
              const pct = totalSeconds > 0 ? Math.round((cat.totalSeconds / totalSeconds) * 100) : 0;
              return (
                <div key={cat.category} style={{
                  marginBottom: `${spacing.xs}px`,
                  backgroundColor: colors.surface.card,
                  borderRadius: `${radius.md}px`,
                  overflow: 'hidden',
                }}>
                  <button
                    onClick={() => setExpanded(isExpanded ? null : cat.category)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center',
                      padding: `${spacing.sm + 2}px ${spacing.md}px`,
                      border: 'none', background: 'none', cursor: 'pointer', gap: `${spacing.sm}px`,
                    }}
                  >
                    <span style={{
                      width: '10px', height: '10px', borderRadius: '50%',
                      backgroundColor: CATEGORY_COLORS[cat.category] || CATEGORY_COLORS['Other'],
                      flexShrink: 0,
                    }} />
                    <span style={{ fontSize: '14px', fontWeight: '500', color: colors.text.primary, flex: 1, textAlign: 'left' }}>{cat.category}</span>
                    <span style={{ fontSize: '13px', color: colors.text.muted }}>{formatSeconds(cat.totalSeconds)} ({pct}%)</span>
                    <Icon name={isExpanded ? 'CaretUp' : 'CaretDown'} size={14} color={colors.text.muted} />
                  </button>

                  {isExpanded && (
                    <div style={{ padding: `0 ${spacing.md}px ${spacing.md}px`, borderTop: `1px solid ${colors.border}` }}>
                      {cat.apps.map((app) => (
                        <div key={app.packageName} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                          <span style={{ fontSize: '13px', color: colors.text.secondary }}>{app.displayName}</span>
                          <span style={{ fontSize: '13px', color: colors.text.muted }}>{formatSeconds(app.totalSeconds)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
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
        {view === 'trends' && <WeeklyTrends childPublicKey={childPublicKey} colors={colors} spacing={spacing} radius={radius} />}
        {view === 'apps' && <AppDrillDown childPublicKey={childPublicKey} colors={colors} spacing={spacing} radius={radius} />}
        {view === 'categories' && <CategoryBreakdown childPublicKey={childPublicKey} colors={colors} spacing={spacing} radius={radius} />}
      </div>
    </div>
  );
}
