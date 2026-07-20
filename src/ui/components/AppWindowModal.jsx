import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';

// Per-app time-of-day window editor. Composes appData.window =
// { mode:'allow'|'block', days:[0-6], start:'HH:MM', end:'HH:MM' }, enforced by
// isBlockedByAppWindow (src/policy.js) + the native/desktop evaluators.

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmt12(hhmm) {
  try {
    const [h, m] = String(hhmm).split(':').map(Number);
    const ap = h < 12 ? 'AM' : 'PM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
  } catch { return hhmm; }
}

// Short label for the row button, e.g. "Only 4:00 PM-6:00 PM" or "Blocked 8:00 AM-3:00 PM".
export function summarizeWindow(win) {
  if (!win || (win.mode !== 'allow' && win.mode !== 'block') || !win.days || !win.days.length) return null;
  const range = `${fmt12(win.start)}-${fmt12(win.end)}`;
  return win.mode === 'allow' ? `Only ${range}` : `Blocked ${range}`;
}

export default function AppWindowModal({ appName, window: win, visible, onClose, onSave }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [mode, setMode] = useState('block');
  const [days, setDays] = useState([1, 2, 3, 4, 5]);
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('15:00');
  const [err, setErr] = useState('');

  useEffect(() => {
    if (!visible) return;
    if (win && win.mode) {
      setMode(win.mode); setDays(win.days || []); setStart(win.start || '08:00'); setEnd(win.end || '15:00');
    } else {
      setMode('block'); setDays([1, 2, 3, 4, 5]); setStart('08:00'); setEnd('15:00');
    }
    setErr('');
  }, [visible]);

  function toggleDay(d) {
    setDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);
  }

  function save() {
    if (!days.length) { setErr('Pick at least one day.'); return; }
    if (!start || !end) { setErr('Set a start and end time.'); return; }
    if (start === end) { setErr("Start and end can't be the same."); return; }
    onSave({ mode, days: [...days].sort((a, b) => a - b), start, end });
    onClose();
  }

  function clear() { onSave(null); onClose(); }

  const modeBtn = (m, label) => (
    <button
      onClick={() => { window.callBare('haptic:tap'); setMode(m); }}
      style={{
        flex: 1, padding: `${spacing.sm}px`, cursor: 'pointer',
        border: `1px solid ${mode === m ? colors.primary : colors.border}`,
        borderRadius: `${radius.md}px`,
        background: mode === m ? colors.primary : colors.surface.card,
        color: mode === m ? '#FFFFFF' : colors.text.primary,
        ...typography.caption, fontWeight: '600',
      }}
    >
      {label}
    </button>
  );

  const inputStyle = {
    padding: `${spacing.sm}px`, border: `1px solid ${colors.border}`, borderRadius: `${radius.md}px`,
    background: colors.surface.input, color: colors.text.primary, ...typography.body,
  };

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={`Time window - ${appName}`}
      footer={<>
        {win && win.mode && <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); clear(); }} style={{ flex: 1 }}>Remove</Button>}
        <Button onClick={() => { window.callBare('haptic:tap'); save(); }} style={{ flex: 1 }}>Save</Button>
      </>}
    >
      <div style={{ display: 'flex', gap: `${spacing.sm}px`, marginBottom: `${spacing.md}px` }}>
        {modeBtn('block', 'Blocked during')}
        {modeBtn('allow', 'Allowed only')}
      </div>
      <div style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.md}px` }}>
        {mode === 'allow'
          ? `${appName} is blocked except during this window.`
          : `${appName} is blocked during this window.`}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', marginBottom: `${spacing.md}px` }}>
        {DAY_LABELS.map((label, d) => (
          <button
            key={d}
            aria-label={label}
            aria-pressed={days.includes(d)}
            onClick={() => { window.callBare('haptic:tap'); toggleDay(d); }}
            style={{
              flex: 1, padding: `${spacing.sm}px 0`, cursor: 'pointer',
              border: `1px solid ${days.includes(d) ? colors.primary : colors.border}`,
              borderRadius: `${radius.md}px`,
              background: days.includes(d) ? colors.primary : colors.surface.card,
              color: days.includes(d) ? '#FFFFFF' : colors.text.muted,
              ...typography.micro, fontWeight: '600',
            }}
          >
            {label[0]}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`, justifyContent: 'center' }}>
        <label style={{ ...typography.caption, color: colors.text.secondary }}>
          From <input type="time" aria-label="Start time" value={start} onChange={(e) => setStart(e.target.value)} style={inputStyle} />
        </label>
        <label style={{ ...typography.caption, color: colors.text.secondary }}>
          to <input type="time" aria-label="End time" value={end} onChange={(e) => setEnd(e.target.value)} style={inputStyle} />
        </label>
      </div>

      {err && <div style={{ ...typography.caption, color: colors.error, textAlign: 'center', marginTop: `${spacing.sm}px` }}>{err}</div>}
    </Modal>
  );
}
