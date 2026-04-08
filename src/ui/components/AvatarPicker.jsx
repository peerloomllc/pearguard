import React, { useState } from 'react'
import { useTheme } from '../theme.js'
import { PRESETS, PRESET_IDS } from './presetAvatars.js'
import Avatar from './Avatar.jsx'

function compressImage(base64, size, quality, sourceMime) {
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
    img.src = 'data:' + (sourceMime || 'image/jpeg') + ';base64,' + base64
  })
}

const ANIMATED_MIMES = ['image/gif', 'image/webp']
// Max base64 size for animated avatars (~375KB decoded)
const MAX_ANIMATED_BASE64 = 500_000

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => resolve(e.target.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      // Strip data URL prefix to get raw base64
      const dataUrl = e.target.result
      resolve(dataUrl.split(',')[1])
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function AvatarPicker({ currentAvatar, name, onSave, onCancel }) {
  const { colors, spacing, radius } = useTheme()
  const [selected, setSelected] = useState(currentAvatar)
  const [customPreview, setCustomPreview] = useState(
    currentAvatar && currentAvatar.type === 'custom' ? currentAvatar : null
  )
  const [loading, setLoading] = useState(false)
  const fileInputRef = React.useRef(null)

  async function pickCamera() {
    setLoading(true)
    try {
      const result = await window.callBare('avatar:pickCamera')
      if (!result || !result.base64) { setLoading(false); return }
      const base64 = await compressImage(result.base64, 256, 0.8, result.mime)
      const thumb64 = await compressImage(result.base64, 48, 0.6, result.mime)
      const avatar = { type: 'custom', base64, thumb64 }
      setCustomPreview(avatar)
      setSelected(avatar)
    } catch (e) {
      // User cancelled or error
    }
    setLoading(false)
  }

  async function handleFileInput(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setLoading(true)
    try {
      const mime = file.type || 'image/jpeg'
      const isAnimated = ANIMATED_MIMES.includes(mime)
      const raw = await readFileAsBase64(file)

      let avatar
      if (isAnimated && raw.length <= MAX_ANIMATED_BASE64) {
        const thumb64 = await compressImage(raw, 48, 0.6, mime)
        avatar = { type: 'custom', base64: raw, thumb64, mime }
      } else {
        const base64 = await compressImage(raw, 256, 0.8, mime)
        const thumb64 = await compressImage(raw, 48, 0.6, mime)
        avatar = { type: 'custom', base64, thumb64 }
      }
      setCustomPreview(avatar)
      setSelected(avatar)
    } catch (e) {
      // Error reading file
    }
    setLoading(false)
    // Reset so the same file can be re-selected
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

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

        <div style={{ fontSize: '13px', fontWeight: '600', color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: `${spacing.sm}px` }}>Presets</div>
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

        <div style={{ fontSize: '13px', fontWeight: '600', color: colors.text.secondary, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: `${spacing.sm}px` }}>Custom Photo</div>
        <div style={{ display: 'flex', gap: `${spacing.sm}px`, marginBottom: `${spacing.sm}px` }}>
          <button
            style={{ flex: 1, padding: '10px', border: `1px solid ${colors.border}`, borderRadius: `${radius.md}px`, backgroundColor: colors.surface.elevated, fontSize: '13px', fontWeight: '600', color: colors.text.primary, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1 }}
            onClick={pickCamera}
            disabled={loading}
          >
            Take Photo
          </button>
          <button
            style={{ flex: 1, padding: '10px', border: `1px solid ${colors.border}`, borderRadius: `${radius.md}px`, backgroundColor: colors.surface.elevated, fontSize: '13px', fontWeight: '600', color: colors.text.primary, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1 }}
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
          >
            Choose from Gallery
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleFileInput}
          />
        </div>

        {customPreview && (
          <div
            style={{
              cursor: 'pointer',
              padding: '2px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: selected === customPreview ? `3px solid ${colors.primary}` : '3px solid transparent',
              borderRadius: '50%',
              marginTop: `${spacing.sm}px`,
              alignSelf: 'center',
            }}
            onClick={() => setSelected(customPreview)}
          >
            <Avatar avatar={customPreview} name="" size={64} />
          </div>
        )}

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
