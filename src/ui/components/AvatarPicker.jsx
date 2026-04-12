import React, { useState } from 'react'
import { useTheme } from '../theme.js'
import { PRESETS, PRESET_IDS } from './presetAvatars.js'
import Avatar from './Avatar.jsx'

export default function AvatarPicker({ currentAvatar, name, onSave, onCancel }) {
  const { colors, spacing, radius } = useTheme()
  const [selected, setSelected] = useState(currentAvatar)

  function selectPreset(id) {
    setSelected({ type: 'preset', id })
  }

  const isPresetSelected = selected && selected.type === 'preset'
  const selectedPresetId = isPresetSelected ? selected.id : null

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: `${spacing.base}px`,
    }}>
      <div style={{
        backgroundColor: colors.surface.card,
        borderRadius: `${radius.xl}px`,
        padding: `${spacing.lg}px`,
        width: '100%', maxWidth: '400px', maxHeight: '90vh', overflowY: 'auto',
        display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: `${spacing.base}px` }}>
          <span style={{ fontSize: '18px', fontWeight: '700', color: colors.text.primary }}>Choose Avatar</span>
          <button
            style={{ background: 'none', border: 'none', fontSize: '24px', color: colors.text.muted, cursor: 'pointer', padding: '0 4px' }}
            onClick={onCancel}
          >
            &times;
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: `${spacing.base}px` }}>
          <Avatar avatar={selected} name={name} size={80} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: `${spacing.sm}px`, marginBottom: `${spacing.base}px`, justifyItems: 'center' }}>
          {PRESET_IDS.map((id) => (
            <div
              key={id}
              style={{
                cursor: 'pointer',
                padding: '2px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: selectedPresetId === id ? `3px solid ${colors.primary}` : '3px solid transparent',
                borderRadius: '50%',
              }}
              onClick={() => selectPreset(id)}
            >
              <Avatar avatar={{ type: 'preset', id }} name="" size={48} />
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: `${spacing.sm}px`, marginTop: `${spacing.base}px` }}>
          <button
            style={{ flex: 1, padding: `${spacing.md}px`, border: `1px solid ${colors.border}`, borderRadius: `${radius.md}px`, backgroundColor: colors.surface.card, fontSize: '14px', fontWeight: '600', color: colors.text.secondary, cursor: 'pointer' }}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            style={{ flex: 1, padding: `${spacing.md}px`, border: 'none', borderRadius: `${radius.md}px`, backgroundColor: colors.primary, fontSize: '14px', fontWeight: '600', color: '#FFFFFF', cursor: 'pointer' }}
            onClick={() => onSave(selected)}
            disabled={!selected}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
