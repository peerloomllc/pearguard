import React, { useState } from 'react';
import { useTheme } from '../theme.js';
import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';
import { PRESET_LIST, composePreset } from '../../presets.js';

// Onboarding setup presets. Composes a starting policy (daily cap + category
// limits + bedtime by age, or a strict allowlist-only mode) and pushes it over
// the existing policy:update path. Reachable from RulesTab.
export default function PresetModal({ childPublicKey, policy, visible, onClose, onApplied }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [selected, setSelected] = useState(null);
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState(null);

  function close() {
    setSelected(null);
    setApplying(false);
    setApplied(null);
    onClose();
  }

  async function apply(preset) {
    window.callBare('haptic:tap');
    setApplying(true);
    try {
      const composed = composePreset(preset.id, policy || {});
      await window.callBare('policy:update', { childPublicKey, policy: composed });
      setApplied(preset);
      onApplied?.();
    } catch (e) {
      console.error('apply preset failed:', e);
    } finally {
      setApplying(false);
    }
  }

  const cardStyle = {
    width: '100%', textAlign: 'left', cursor: 'pointer',
    background: colors.surface.card, border: `1px solid ${colors.border}`,
    borderRadius: `${radius.md}px`, padding: `${spacing.md}px`,
    marginBottom: `${spacing.sm}px`,
  };

  let title = 'Quick setup';
  if (applied) title = 'Preset applied';
  else if (selected) title = `Apply the ${selected.label} preset?`;

  return (
    <Modal
      visible={visible}
      onClose={close}
      title={title}
      footer={applied
        ? <Button onClick={() => { window.callBare('haptic:tap'); close(); }} style={{ flex: 1 }}>Done</Button>
        : selected
          ? <>
              <Button variant="secondary" disabled={applying} onClick={() => { window.callBare('haptic:tap'); setSelected(null); }} style={{ flex: 1 }}>Back</Button>
              <Button disabled={applying} onClick={() => apply(selected)} style={{ flex: 1 }}>Apply</Button>
            </>
          : <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); close(); }} style={{ flex: 1 }}>Cancel</Button>}
    >
      {applied ? (
        <div style={{ textAlign: 'center', ...typography.body, color: colors.text.primary }}>
          The <strong>{applied.label}</strong> preset is now active. Fine-tune limits, bedtime and per-app approvals any time from Rules and Apps.
        </div>
      ) : selected ? (
        <div style={{ ...typography.body, color: colors.text.secondary }}>
          <p style={{ marginTop: 0 }}>{selected.description}</p>
          <p style={{ ...typography.caption, color: colors.text.muted }}>
            {selected.id === 'allowlist'
              ? 'This blocks every app now and clears limits and bedtime. You then approve the apps you want in the Apps tab.'
              : 'This replaces the daily limit, category limits and bedtime with the preset. Your per-app approvals are kept.'}
          </p>
        </div>
      ) : (
        <>
          <div style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.md}px` }}>
            Start from a sensible baseline, then adjust. You can re-apply or change everything later.
          </div>
          {PRESET_LIST.map((preset) => (
            <button key={preset.id} style={cardStyle} onClick={() => { window.callBare('haptic:tap'); setSelected(preset); }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: `${spacing.sm}px` }}>
                <span style={{ ...typography.body, color: colors.text.primary, fontWeight: '600' }}>{preset.label}</span>
                <span style={{ ...typography.caption, color: colors.text.muted }}>{preset.ageHint}</span>
              </div>
              <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: '2px' }}>{preset.description}</div>
            </button>
          ))}
        </>
      )}
    </Modal>
  );
}
