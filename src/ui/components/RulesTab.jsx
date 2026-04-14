import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const BLANK_RULE = { label: '', days: [], start: '21:00', end: '07:00', exemptApps: [] };

function RuleRow({ rule, appNames, onEdit, onDelete, colors, typography, spacing, radius }) {
  const activeDays = DAY_LABELS.filter((_, i) => rule.days.includes(i)).join(', ');
  const exemptCount = (rule.exemptApps || []).length;
  const exemptLabel = exemptCount > 0
    ? (rule.exemptApps || []).map(pkg => appNames[pkg] || pkg).join(', ')
    : null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`,
      padding: `${spacing.sm}px 0`, borderBottom: `1px solid ${colors.divider}`,
    }}>
      <div style={{ flex: 1 }}>
        <span style={{ ...typography.body, fontWeight: '600', display: 'block', color: colors.text.primary }}>
          {rule.label || '(no label)'}
        </span>
        <span style={{ ...typography.caption, color: colors.text.secondary }}>
          {activeDays || 'No days'} &bull; {rule.start}&ndash;{rule.end}
        </span>
        {exemptLabel && (
          <span style={{ ...typography.caption, color: colors.primary, display: 'block', marginTop: '2px' }}>
            Exempt: {exemptLabel}
          </span>
        )}
      </div>
      <button
        onClick={onEdit}
        aria-label={`Edit rule ${rule.label}`}
        style={{
          padding: `${spacing.xs}px ${spacing.sm}px`,
          border: `1px solid ${colors.primary}`,
          borderRadius: `${radius.md}px`,
          color: colors.primary,
          background: 'transparent',
          cursor: 'pointer',
          ...typography.caption,
        }}
      >
        Edit
      </button>
      <button
        onClick={onDelete}
        aria-label={`Delete rule ${rule.label}`}
        style={{
          padding: `${spacing.xs}px ${spacing.sm}px`,
          border: `1px solid ${colors.error}`,
          borderRadius: `${radius.md}px`,
          color: colors.error,
          background: 'transparent',
          cursor: 'pointer',
          ...typography.caption,
        }}
      >
        Delete
      </button>
    </div>
  );
}

function ScheduleSection({ policy, setPolicy, childPublicKey, colors, typography, spacing, radius }) {
  const [newRule, setNewRule] = useState(BLANK_RULE);
  const [editingIndex, setEditingIndex] = useState(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

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
    setShowForm(true);
  }

  function handleCancelEdit() {
    setEditingIndex(null);
    setNewRule(BLANK_RULE);
    setSubmitAttempted(false);
    setShowForm(false);
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
    setShowForm(false);
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

  const schedules = (policy && policy.schedules) || [];
  const inputStyle = {
    padding: `${spacing.sm}px`,
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.md}px`,
    fontSize: '14px',
    marginTop: `${spacing.xs}px`,
    background: colors.surface.input,
    color: colors.text.primary,
    width: '100%',
    boxSizing: 'border-box',
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`, marginBottom: `${spacing.sm}px` }}>
        <h3 style={{ ...typography.subheading, fontWeight: '600', color: colors.text.primary, margin: 0 }}>
          Active Rules
        </h3>
        <button
          onClick={() => { window.callBare('haptic:tap'); setShowInfo((v) => !v); }}
          aria-label="About schedule rules"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px`, display: 'flex', alignItems: 'center' }}
        >
          <Icon name="Info" size={16} color={colors.text.muted} />
        </button>
      </div>
      {showInfo && (
        <p style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.base}px`, lineHeight: '1.4', padding: `${spacing.sm}px`, background: colors.surface.elevated, borderRadius: `${radius.md}px` }}>
          Schedule rules define <strong>blackout windows</strong> - times when apps are blocked. Apps are allowed outside these windows.
        </p>
      )}
      {schedules.length === 0 && (
        <p style={{ ...typography.body, color: colors.text.muted }}>No blackout rules yet.</p>
      )}
      {schedules.map((rule, i) => (
        <RuleRow
          key={i}
          rule={rule}
          appNames={appNames}
          onEdit={() => handleEditRule(i)}
          onDelete={() => handleDeleteRule(i)}
          colors={colors}
          typography={typography}
          spacing={spacing}
          radius={radius}
        />
      ))}

      {!showForm && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: `${spacing.xl}px` }}>
          <button
            onClick={() => { window.callBare('haptic:tap'); setShowForm(true); }}
            aria-label="Add schedule rule"
            style={{
              display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`,
              padding: `${spacing.sm}px ${spacing.base}px`,
              border: 'none',
              borderRadius: `${radius.md}px`,
              backgroundColor: colors.primary,
              color: '#FFFFFF',
              cursor: 'pointer',
              ...typography.body,
            }}
          >
            <Icon name="Plus" size={16} color="#FFFFFF" />
            Add Rule
          </button>
        </div>
      )}

      {showForm && (<>
      <h3 style={{ ...typography.subheading, fontWeight: '600', color: colors.text.primary, marginTop: `${spacing.xl}px`, marginBottom: `${spacing.sm}px` }}>
        {editingIndex !== null ? 'Edit Rule' : 'Add Rule'}
      </h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.md}px` }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px`, ...typography.caption, color: colors.text.secondary }}>
          Label
          <input
            type="text"
            value={newRule.label}
            onChange={(e) => setNewRule({ ...newRule, label: e.target.value })}
            placeholder="e.g. Bedtime"
            style={{ ...inputStyle, ...(submitAttempted && !newRule.label.trim() ? { borderColor: colors.error } : {}) }}
            aria-label="Rule label"
          />
          {submitAttempted && !newRule.label.trim() && (
            <span style={{ ...typography.caption, color: colors.error }}>Label is required</span>
          )}
        </label>

        <div>
          <div style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.xs}px` }}>Days</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${spacing.xs}px` }}>
            {DAY_LABELS.map((day, i) => (
              <button
                key={i}
                onClick={() => toggleDay(i)}
                aria-label={day}
                style={{
                  padding: `${spacing.xs}px ${spacing.sm}px`,
                  borderRadius: `${radius.full}px`,
                  border: `1px solid ${newRule.days.includes(i) ? colors.primary : colors.border}`,
                  backgroundColor: newRule.days.includes(i) ? colors.primary : 'transparent',
                  color: newRule.days.includes(i) ? '#FFFFFF' : colors.text.secondary,
                  ...typography.caption,
                  cursor: 'pointer',
                }}
              >
                {day}
              </button>
            ))}
          </div>
          {submitAttempted && newRule.days.length === 0 && (
            <span style={{ ...typography.caption, color: colors.error, marginTop: `${spacing.xs}px`, display: 'block' }}>
              Select at least one day
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: `${spacing.base}px` }}>
          <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px`, ...typography.caption, color: colors.text.secondary }}>
            Blocked from
            <input
              type="time"
              value={newRule.start}
              onChange={(e) => setNewRule({ ...newRule, start: e.target.value })}
              style={inputStyle}
              aria-label="Blocked from time"
            />
          </label>
          <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px`, ...typography.caption, color: colors.text.secondary }}>
            Blocked until
            <input
              type="time"
              value={newRule.end}
              onChange={(e) => setNewRule({ ...newRule, end: e.target.value })}
              style={inputStyle}
              aria-label="Blocked until time"
            />
          </label>
        </div>

        {appList.length > 0 && (
          <div>
            <div style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.xs}px` }}>Exempt apps</div>
            <p style={{ ...typography.caption, color: colors.text.muted, margin: `2px 0 ${spacing.sm}px` }}>
              These apps will not be blocked during this window.
            </p>
            <div style={{
              display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px`,
              maxHeight: '160px', overflowY: 'auto',
              border: `1px solid ${colors.border}`, borderRadius: `${radius.md}px`, padding: `${spacing.sm}px`,
            }}>
              {appList.map(({ packageName, appName }) => (
                <label key={packageName} style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`, ...typography.caption, color: colors.text.primary, cursor: 'pointer' }}>
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

        <div style={{ display: 'flex', justifyContent: 'center', gap: `${spacing.sm}px` }}>
          <button
            onClick={handleSaveRule}
            aria-label={editingIndex !== null ? 'Save schedule rule' : 'Add schedule rule'}
            style={{
              padding: `${spacing.sm}px ${spacing.base}px`,
              border: 'none',
              borderRadius: `${radius.md}px`,
              backgroundColor: colors.primary,
              color: '#FFFFFF',
              cursor: 'pointer',
              ...typography.body,
            }}
          >
            {editingIndex !== null ? 'Save Changes' : 'Add Rule'}
          </button>
          <button
            onClick={handleCancelEdit}
            aria-label="Cancel"
            style={{
              padding: `${spacing.sm}px ${spacing.base}px`,
              border: `1px solid ${colors.border}`,
              borderRadius: `${radius.md}px`,
              background: 'transparent',
              cursor: 'pointer',
              ...typography.body,
              color: colors.text.secondary,
            }}
          >
            Cancel
          </button>
        </div>
      </div>
      </>)}
    </div>
  );
}

function ContactsSection({ policy, setPolicy, childPublicKey, colors, typography, spacing, radius }) {
  const [picking, setPicking] = useState(false);

  function saveContacts(contacts) {
    const updated = { ...policy, allowedContacts: contacts };
    setPolicy(updated);
    window.callBare('policy:update', { childPublicKey, policy: updated });
  }

  function handleRemove(index) {
    const contacts = policy.allowedContacts.filter((_, i) => i !== index);
    saveContacts(contacts);
  }

  async function handleAddContact() {
    setPicking(true);
    try {
      const contact = await window.callBare('contacts:pick');
      if (contact && contact.phone) {
        const contacts = [...(policy.allowedContacts || []), contact];
        saveContacts(contacts);
      }
    } catch (e) {
      // User cancelled picker or permission denied - silently ignore
    } finally {
      setPicking(false);
    }
  }

  const contacts = (policy && policy.allowedContacts) || [];

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: `${spacing.sm}px` }}>
        <h3 style={{ ...typography.subheading, fontWeight: '600', color: colors.text.primary, margin: 0 }}>
          Allowed Contacts
        </h3>
        <button
          onClick={handleAddContact}
          disabled={picking}
          aria-label="Add contact"
          style={{
            padding: `${spacing.xs}px ${spacing.sm}px`,
            border: 'none',
            borderRadius: `${radius.md}px`,
            backgroundColor: colors.primary,
            color: '#FFFFFF',
            cursor: picking ? 'default' : 'pointer',
            opacity: picking ? 0.6 : 1,
            ...typography.caption,
          }}
        >
          {picking ? 'Picking...' : '+ Add Contact'}
        </button>
      </div>
      <p style={{ ...typography.caption, color: colors.text.muted, marginBottom: `${spacing.base}px` }}>
        These contacts can call and message the child even when the phone app is blocked.
      </p>
      {contacts.length === 0 && (
        <p style={{ ...typography.body, color: colors.text.muted }}>No contacts added yet.</p>
      )}
      {contacts.map((contact, i) => (
        <div key={i} style={{
          display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`,
          padding: `${spacing.sm}px 0`, borderBottom: `1px solid ${colors.divider}`,
        }}>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <span style={{ ...typography.body, fontWeight: '500', color: colors.text.primary }}>{contact.name}</span>
            <span style={{ ...typography.caption, color: colors.text.secondary }}>{contact.phone}</span>
          </div>
          <button
            onClick={() => handleRemove(i)}
            aria-label={`Remove ${contact.name}`}
            style={{
              padding: `${spacing.xs}px ${spacing.sm}px`,
              border: `1px solid ${colors.error}`,
              borderRadius: `${radius.md}px`,
              color: colors.error,
              background: 'transparent',
              cursor: 'pointer',
              ...typography.caption,
            }}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

export default function RulesTab({ childPublicKey }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);

  const loadPolicy = useCallback(() => {
    window.callBare('policy:get', { childPublicKey })
      .then((p) => { setPolicy(p); setLoading(false); })
      .catch(() => setLoading(false));
  }, [childPublicKey]);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  if (loading) {
    return (
      <div style={{ padding: `${spacing.base}px`, ...typography.body, color: colors.text.secondary }}>
        Loading rules...
      </div>
    );
  }

  const sectionProps = { policy, setPolicy, childPublicKey, colors, typography, spacing, radius };

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <ScheduleSection {...sectionProps} />
    </div>
  );
}
