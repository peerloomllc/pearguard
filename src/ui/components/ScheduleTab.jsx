import React, { useState, useEffect, useCallback } from 'react';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const BLANK_RULE = { label: '', days: [], start: '21:00', end: '07:00', exemptApps: [] };

function RuleRow({ rule, appNames, onEdit, onDelete }) {
  const activeDays = DAY_LABELS.filter((_, i) => rule.days.includes(i)).join(', ');
  const exemptCount = (rule.exemptApps || []).length;
  const exemptLabel = exemptCount > 0
    ? (rule.exemptApps || []).map(pkg => appNames[pkg] || pkg).join(', ')
    : null;
  return (
    <div style={styles.ruleRow}>
      <div style={styles.ruleInfo}>
        <span style={styles.ruleLabel}>{rule.label || '(no label)'}</span>
        <span style={styles.ruleDetails}>
          {activeDays || 'No days'} • {rule.start}–{rule.end}
        </span>
        {exemptLabel && (
          <span style={styles.exemptBadge}>Exempt: {exemptLabel}</span>
        )}
      </div>
      <button style={styles.editBtn} onClick={onEdit} aria-label={`Edit rule ${rule.label}`}>
        Edit
      </button>
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
  const [editingIndex, setEditingIndex] = useState(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);

  const loadPolicy = useCallback(() => {
    window.callBare('policy:get', { childPublicKey })
      .then((p) => { setPolicy(p); setLoading(false); })
      .catch(() => setLoading(false));
  }, [childPublicKey]);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  // Build packageName→appName map from policy.apps
  const appNames = {};
  const appList = [];
  if (policy && policy.apps) {
    for (const [pkg, data] of Object.entries(policy.apps)) {
      appNames[pkg] = data.appName || pkg;
      appList.push({ packageName: pkg, appName: data.appName || pkg });
    }
    appList.sort((a, b) => a.appName.localeCompare(b.appName));
  }

  function saveSchedules(schedules) {
    const updated = { ...policy, schedules };
    setPolicy(updated);
    window.callBare('policy:update', { childPublicKey, policy: updated });
  }

  function handleDeleteRule(index) {
    const schedules = policy.schedules.filter((_, i) => i !== index);
    saveSchedules(schedules);
  }

  function handleEditRule(index) {
    setEditingIndex(index);
    setNewRule({ ...policy.schedules[index], exemptApps: policy.schedules[index].exemptApps || [] });
    setSubmitAttempted(false);
  }

  function handleCancelEdit() {
    setEditingIndex(null);
    setNewRule(BLANK_RULE);
    setSubmitAttempted(false);
  }

  function handleSaveRule() {
    setSubmitAttempted(true);
    if (!newRule.label.trim() || newRule.days.length === 0) return;
    let schedules;
    if (editingIndex !== null) {
      schedules = policy.schedules.map((r, i) => i === editingIndex ? newRule : r);
    } else {
      schedules = [...(policy.schedules || []), newRule];
    }
    saveSchedules(schedules);
    setNewRule(BLANK_RULE);
    setEditingIndex(null);
    setSubmitAttempted(false);
  }

  function toggleDay(dayIndex) {
    const days = newRule.days.includes(dayIndex)
      ? newRule.days.filter((d) => d !== dayIndex)
      : [...newRule.days, dayIndex].sort((a, b) => a - b);
    setNewRule({ ...newRule, days });
  }

  function toggleExemptApp(packageName) {
    const exempt = newRule.exemptApps || [];
    const updated = exempt.includes(packageName)
      ? exempt.filter((p) => p !== packageName)
      : [...exempt, packageName];
    setNewRule({ ...newRule, exemptApps: updated });
  }

  if (loading) return <div style={styles.msg}>Loading schedule...</div>;

  const schedules = (policy && policy.schedules) || [];

  return (
    <div style={styles.container}>
      <p style={styles.hint}>
        Schedule rules define <strong>blackout windows</strong> — times when apps are blocked.
        Apps are allowed outside these windows.
      </p>

      <h3 style={styles.sectionHead}>Active Rules</h3>
      {schedules.length === 0 && <p style={styles.empty}>No blackout rules yet.</p>}
      {schedules.map((rule, i) => (
        <RuleRow key={i} rule={rule} appNames={appNames} onEdit={() => handleEditRule(i)} onDelete={() => handleDeleteRule(i)} />
      ))}

      <h3 style={{ ...styles.sectionHead, marginTop: '24px' }}>{editingIndex !== null ? 'Edit Rule' : 'Add Rule'}</h3>
      <div style={styles.form}>
        <label style={styles.formLabel}>
          Label
          <input
            type="text"
            value={newRule.label}
            onChange={(e) => setNewRule({ ...newRule, label: e.target.value })}
            placeholder="e.g. Bedtime"
            style={{ ...styles.textInput, ...(submitAttempted && !newRule.label.trim() ? styles.inputError : {}) }}
            aria-label="Rule label"
          />
          {submitAttempted && !newRule.label.trim() && (
            <span style={styles.errorMsg}>Label is required</span>
          )}
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
        {submitAttempted && newRule.days.length === 0 && (
          <span style={styles.errorMsg}>Select at least one day</span>
        )}

        <div style={styles.timeRow}>
          <label style={styles.formLabel}>
            Blocked from
            <input
              type="time"
              value={newRule.start}
              onChange={(e) => setNewRule({ ...newRule, start: e.target.value })}
              style={styles.timeInput}
              aria-label="Blocked from time"
            />
          </label>
          <label style={styles.formLabel}>
            Blocked until
            <input
              type="time"
              value={newRule.end}
              onChange={(e) => setNewRule({ ...newRule, end: e.target.value })}
              style={styles.timeInput}
              aria-label="Blocked until time"
            />
          </label>
        </div>

        {appList.length > 0 && (
          <div>
            <label style={styles.formLabel}>Exempt apps</label>
            <p style={styles.exemptHint}>These apps will not be blocked during this window.</p>
            <div style={styles.exemptList}>
              {appList.map(({ packageName, appName }) => (
                <label key={packageName} style={styles.exemptCheck}>
                  <input
                    type="checkbox"
                    checked={(newRule.exemptApps || []).includes(packageName)}
                    onChange={() => toggleExemptApp(packageName)}
                    aria-label={`Exempt ${appName}`}
                  />
                  {appName}
                </label>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            style={styles.addBtn}
            onClick={handleSaveRule}
            aria-label={editingIndex !== null ? 'Save schedule rule' : 'Add schedule rule'}
          >
            {editingIndex !== null ? 'Save Changes' : 'Add Rule'}
          </button>
          {editingIndex !== null && (
            <button style={styles.cancelBtn} onClick={handleCancelEdit} aria-label="Cancel edit">
              Cancel
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  msg: { padding: '16px', color: '#666', fontSize: '14px' },
  hint: { color: '#666', fontSize: '13px', marginBottom: '16px', lineHeight: '1.4' },
  sectionHead: { fontSize: '15px', fontWeight: '700', marginBottom: '10px' },
  empty: { color: '#888', fontSize: '14px' },
  ruleRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '10px 0', borderBottom: '1px solid #eee',
  },
  ruleInfo: { flex: 1 },
  ruleLabel: { fontSize: '14px', fontWeight: '600', display: 'block' },
  ruleDetails: { fontSize: '12px', color: '#666' },
  exemptBadge: { fontSize: '11px', color: '#1a73e8', display: 'block', marginTop: '2px' },
  editBtn: {
    padding: '5px 12px', border: '1px solid #1a73e8', borderRadius: '6px',
    color: '#1a73e8', background: '#fff', cursor: 'pointer', fontSize: '12px',
  },
  deleteBtn: {
    padding: '5px 12px', border: '1px solid #ea4335', borderRadius: '6px',
    color: '#ea4335', background: '#fff', cursor: 'pointer', fontSize: '12px',
  },
  cancelBtn: {
    padding: '10px', border: '1px solid #ccc', borderRadius: '6px',
    background: '#fff', cursor: 'pointer', fontSize: '14px', color: '#555',
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
  exemptHint: { color: '#888', fontSize: '12px', margin: '2px 0 6px' },
  exemptList: {
    display: 'flex', flexDirection: 'column', gap: '6px',
    maxHeight: '160px', overflowY: 'auto',
    border: '1px solid #eee', borderRadius: '6px', padding: '8px',
  },
  exemptCheck: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' },
  inputError: { borderColor: '#ea4335' },
  errorMsg: { color: '#ea4335', fontSize: '12px', marginTop: '2px' },
};
