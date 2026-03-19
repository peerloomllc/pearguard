import React, { useState, useEffect, useCallback } from 'react';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const BLANK_RULE = { label: '', days: [], start: '21:00', end: '07:00' };

function RuleRow({ rule, onDelete }) {
  const activeDays = DAY_LABELS.filter((_, i) => rule.days.includes(i)).join(', ');
  return (
    <div style={styles.ruleRow}>
      <div style={styles.ruleInfo}>
        <span style={styles.ruleLabel}>{rule.label || '(no label)'}</span>
        <span style={styles.ruleDetails}>
          {activeDays || 'No days'} • {rule.start}–{rule.end}
        </span>
      </div>
      <button style={styles.deleteBtn} onClick={onDelete} aria-label={`Delete rule ${rule.label}`}>
        Delete
      </button>
    </div>
  );
}

export default function ScheduleTab({ childPublicKey }) {
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newRule, setNewRule] = useState(BLANK_RULE);

  const loadPolicy = useCallback(() => {
    window.callBare('policy:get', { childPublicKey })
      .then((p) => { setPolicy(p); setLoading(false); })
      .catch(() => setLoading(false));
  }, [childPublicKey]);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  function saveSchedules(schedules) {
    const updated = { ...policy, schedules };
    setPolicy(updated);
    window.callBare('policy:update', { childPublicKey, policy: updated });
  }

  function handleDeleteRule(index) {
    const schedules = policy.schedules.filter((_, i) => i !== index);
    saveSchedules(schedules);
  }

  function handleAddRule() {
    if (!newRule.label.trim() || newRule.days.length === 0) return;
    const schedules = [...(policy.schedules || []), newRule];
    saveSchedules(schedules);
    setNewRule(BLANK_RULE);
  }

  function toggleDay(dayIndex) {
    const days = newRule.days.includes(dayIndex)
      ? newRule.days.filter((d) => d !== dayIndex)
      : [...newRule.days, dayIndex].sort((a, b) => a - b);
    setNewRule({ ...newRule, days });
  }

  if (loading) return <div style={styles.msg}>Loading schedule...</div>;

  const schedules = (policy && policy.schedules) || [];

  return (
    <div style={styles.container}>
      <h3 style={styles.sectionHead}>Active Rules</h3>
      {schedules.length === 0 && <p style={styles.empty}>No schedule rules yet.</p>}
      {schedules.map((rule, i) => (
        <RuleRow key={i} rule={rule} onDelete={() => handleDeleteRule(i)} />
      ))}

      <h3 style={{ ...styles.sectionHead, marginTop: '24px' }}>Add Rule</h3>
      <div style={styles.form}>
        <label style={styles.formLabel}>
          Label
          <input
            type="text"
            value={newRule.label}
            onChange={(e) => setNewRule({ ...newRule, label: e.target.value })}
            placeholder="e.g. Bedtime"
            style={styles.textInput}
            aria-label="Rule label"
          />
        </label>

        <div style={styles.daysRow}>
          {DAY_LABELS.map((day, i) => (
            <label key={i} style={styles.dayCheck}>
              <input
                type="checkbox"
                checked={newRule.days.includes(i)}
                onChange={() => toggleDay(i)}
                aria-label={day}
              />
              {day}
            </label>
          ))}
        </div>

        <div style={styles.timeRow}>
          <label style={styles.formLabel}>
            Start
            <input
              type="time"
              value={newRule.start}
              onChange={(e) => setNewRule({ ...newRule, start: e.target.value })}
              style={styles.timeInput}
              aria-label="Start time"
            />
          </label>
          <label style={styles.formLabel}>
            End
            <input
              type="time"
              value={newRule.end}
              onChange={(e) => setNewRule({ ...newRule, end: e.target.value })}
              style={styles.timeInput}
              aria-label="End time"
            />
          </label>
        </div>

        <button
          style={styles.addBtn}
          onClick={handleAddRule}
          disabled={!newRule.label.trim() || newRule.days.length === 0}
          aria-label="Add schedule rule"
        >
          Add Rule
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  msg: { padding: '16px', color: '#666', fontSize: '14px' },
  sectionHead: { fontSize: '15px', fontWeight: '700', marginBottom: '10px' },
  empty: { color: '#888', fontSize: '14px' },
  ruleRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '10px 0', borderBottom: '1px solid #eee',
  },
  ruleInfo: { flex: 1 },
  ruleLabel: { fontSize: '14px', fontWeight: '600', display: 'block' },
  ruleDetails: { fontSize: '12px', color: '#666' },
  deleteBtn: {
    padding: '5px 12px', border: '1px solid #ea4335', borderRadius: '6px',
    color: '#ea4335', background: '#fff', cursor: 'pointer', fontSize: '12px',
  },
  form: { display: 'flex', flexDirection: 'column', gap: '12px' },
  formLabel: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px', color: '#555' },
  textInput: {
    padding: '8px', border: '1px solid #ccc', borderRadius: '6px',
    fontSize: '14px', marginTop: '4px',
  },
  daysRow: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  dayCheck: { display: 'flex', alignItems: 'center', gap: '4px', fontSize: '13px', cursor: 'pointer' },
  timeRow: { display: 'flex', gap: '16px' },
  timeInput: {
    padding: '8px', border: '1px solid #ccc', borderRadius: '6px',
    fontSize: '14px', marginTop: '4px',
  },
  addBtn: {
    padding: '10px', border: 'none', borderRadius: '6px',
    backgroundColor: '#1a73e8', color: '#fff', cursor: 'pointer', fontSize: '14px',
  },
};
