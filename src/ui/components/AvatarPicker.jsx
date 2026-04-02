import React, { useState } from 'react'
import { PRESETS, PRESET_IDS } from './presetAvatars.js'
import Avatar from './Avatar.jsx'

function compressImage(base64, size, quality) {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      // Center-crop to square
      const min = Math.min(img.width, img.height)
      const sx = (img.width - min) / 2
      const sy = (img.height - min) / 2
      ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size)
      const dataUrl = canvas.toDataURL('image/jpeg', quality)
      resolve(dataUrl.split(',')[1])
    }
    img.src = 'data:image/jpeg;base64,' + base64
  })
}

export default function AvatarPicker({ currentAvatar, name, onSave, onCancel }) {
  const [selected, setSelected] = useState(currentAvatar)
  const [customPreview, setCustomPreview] = useState(
    currentAvatar && currentAvatar.type === 'custom' ? currentAvatar : null
  )
  const [loading, setLoading] = useState(false)

  async function pickImage(method) {
    setLoading(true)
    try {
      const result = await window.callBare(method)
      if (!result || !result.base64) { setLoading(false); return }
      const base64 = await compressImage(result.base64, 256, 0.8)
      const thumb64 = await compressImage(result.base64, 48, 0.6)
      const avatar = { type: 'custom', base64, thumb64 }
      setCustomPreview(avatar)
      setSelected(avatar)
    } catch (e) {
      // User cancelled or error
    }
    setLoading(false)
  }

  function selectPreset(id) {
    setSelected({ type: 'preset', id })
  }

  const isPresetSelected = selected && selected.type === 'preset'
  const selectedPresetId = isPresetSelected ? selected.id : null

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        <div style={styles.header}>
          <span style={styles.title}>Choose Avatar</span>
          <button style={styles.closeBtn} onClick={onCancel}>&times;</button>
        </div>

        <div style={styles.currentWrap}>
          <Avatar avatar={selected} name={name} size={80} />
        </div>

        <div style={styles.section}>Presets</div>
        <div style={styles.grid}>
          {PRESET_IDS.map((id) => (
            <div
              key={id}
              style={{
                ...styles.gridItem,
                border: selectedPresetId === id ? '3px solid #1a73e8' : '3px solid transparent',
                borderRadius: '50%',
              }}
              onClick={() => selectPreset(id)}
            >
              <Avatar avatar={{ type: 'preset', id }} name="" size={48} />
            </div>
          ))}
        </div>

        <div style={styles.section}>Custom Photo</div>
        <div style={styles.photoRow}>
          <button
            style={styles.photoBtn}
            onClick={() => pickImage('avatar:pickCamera')}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Take Photo'}
          </button>
          <button
            style={styles.photoBtn}
            onClick={() => pickImage('avatar:pickGallery')}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Choose from Gallery'}
          </button>
        </div>

        {customPreview && (
          <div
            style={{
              ...styles.gridItem,
              border: selected === customPreview ? '3px solid #1a73e8' : '3px solid transparent',
              borderRadius: '50%',
              marginTop: '8px',
              alignSelf: 'center',
            }}
            onClick={() => setSelected(customPreview)}
          >
            <Avatar avatar={customPreview} name="" size={64} />
          </div>
        )}

        <div style={styles.actions}>
          <button style={styles.cancelBtn} onClick={onCancel}>Cancel</button>
          <button
            style={styles.saveBtn}
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

const styles = {
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '16px',
  },
  modal: {
    backgroundColor: '#FFF', borderRadius: '16px', padding: '20px',
    width: '100%', maxWidth: '400px', maxHeight: '90vh', overflowY: 'auto',
    display: 'flex', flexDirection: 'column',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: '16px',
  },
  title: { fontSize: '18px', fontWeight: '700', color: '#333' },
  closeBtn: {
    background: 'none', border: 'none', fontSize: '24px', color: '#666',
    cursor: 'pointer', padding: '0 4px',
  },
  currentWrap: {
    display: 'flex', justifyContent: 'center', marginBottom: '16px',
  },
  section: {
    fontSize: '13px', fontWeight: '600', color: '#666',
    textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '8px',
  },
  grid: {
    display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '8px',
    marginBottom: '16px', justifyItems: 'center',
  },
  gridItem: {
    cursor: 'pointer', padding: '2px', display: 'flex',
    alignItems: 'center', justifyContent: 'center',
  },
  photoRow: {
    display: 'flex', gap: '8px', marginBottom: '8px',
  },
  photoBtn: {
    flex: 1, padding: '10px', border: '1px solid #DDD', borderRadius: '8px',
    backgroundColor: '#F5F5F5', fontSize: '13px', fontWeight: '600',
    color: '#333', cursor: 'pointer',
  },
  actions: {
    display: 'flex', gap: '8px', marginTop: '16px',
  },
  cancelBtn: {
    flex: 1, padding: '12px', border: '1px solid #DDD', borderRadius: '8px',
    backgroundColor: '#FFF', fontSize: '14px', fontWeight: '600',
    color: '#666', cursor: 'pointer',
  },
  saveBtn: {
    flex: 1, padding: '12px', border: 'none', borderRadius: '8px',
    backgroundColor: '#1a73e8', fontSize: '14px', fontWeight: '600',
    color: '#FFF', cursor: 'pointer',
  },
}
