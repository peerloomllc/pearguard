import React, { useState, useEffect, useRef } from 'react'
import { useTheme } from '../theme.js'
import Icon from '../icons.js'
import Avatar from './Avatar.jsx'
import AvatarPicker from './AvatarPicker.jsx'
import { pickCameraPhoto } from './avatarUtils.js'
import Button from './primitives/Button.jsx'
import Collapsible from './primitives/Collapsible.jsx'

export default function Profile({ mode }) {
  const { colors, typography, spacing, radius } = useTheme()
  const [name, setName] = useState('')
  const [savedName, setSavedName] = useState('')
  const [avatar, setAvatar] = useState(null)
  const [showPicker, setShowPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [photoLoading, setPhotoLoading] = useState(false)
  const fileInputRef = useRef(null)
  const [status, setStatus] = useState(null) // null | 'success' | 'error'
  const [pairState, setPairState] = useState('idle') // 'idle' | 'connecting' | 'success' | 'error'
  const [pairError, setPairError] = useState(null)
  const [parents, setParents] = useState([]) // child mode: list of paired parents
  const [pairedBanner, setPairedBanner] = useState(false)
  const [parentsOpen, setParentsOpen] = useState(true)
  const pairDoneRef = useRef(false) // true once peer:paired fires; prevents acceptInvite overriding state

  useEffect(() => {
    window.callBare('identity:getName')
      .then(({ displayName, avatar: av }) => {
        const n = displayName || ''
        setName(n)
        setSavedName(n)
        if (av) setAvatar(av)
      })
      .catch(() => {})
  }, [])

  // Child mode: load existing paired parents and listen for new pairings
  useEffect(() => {
    if (mode !== 'child') return
    const refresh = () => window.callBare('children:list').then(setParents).catch(() => {})
    refresh()
    const unsubs = [
      window.onBareEvent('peer:paired', () => {
        pairDoneRef.current = true
        refresh()
        setPairState('idle')
        setPairedBanner(true)
        setTimeout(() => setPairedBanner(false), 3000)
      }),
      window.onBareEvent('peer:connected', (data) => {
        if (!data?.remoteKey) return
        setParents((prev) => prev.map((p) =>
          p.noiseKey === data.remoteKey ? { ...p, isOnline: true } : p
        ))
        refresh()
      }),
      window.onBareEvent('peer:disconnected', (data) => {
        if (!data?.remoteKey) return
        setParents((prev) => prev.map((p) =>
          p.noiseKey === data.remoteKey ? { ...p, isOnline: false } : p
        ))
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, [mode])

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === savedName) return
    setSaving(true)
    setStatus(null)
    try {
      await window.callBare('identity:setName', { name: trimmed })
      setSavedName(trimmed)
      setStatus('success')
      setTimeout(() => setStatus((s) => (s === 'success' ? null : s)), 2000)
    } catch {
      setStatus('error')
    } finally {
      setSaving(false)
    }
  }

  async function handleAvatarSave(newAvatar) {
    setShowPicker(false)
    try {
      await window.callBare('identity:setAvatar', { avatar: newAvatar })
      setAvatar(newAvatar)
    } catch {
      // silently fail
    }
  }

  async function handlePickCamera() {
    setPhotoLoading(true)
    try {
      const av = await pickCameraPhoto()
      if (av) {
        await window.callBare('identity:setAvatar', { avatar: av })
        setAvatar(av)
      }
    } catch { /* cancelled or error */ }
    setPhotoLoading(false)
  }

  async function handleFileInput(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setPhotoLoading(true)
    try {
      const { processFileForAvatar } = await import('./avatarUtils.js')
      const av = await processFileForAvatar(file)
      if (av) {
        await window.callBare('identity:setAvatar', { avatar: av })
        setAvatar(av)
      }
    } catch { /* error */ }
    setPhotoLoading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  async function handleRemovePhoto() {
    setPhotoLoading(true)
    try {
      await window.callBare('identity:setAvatar', { avatar: null })
      setAvatar(null)
    } catch { /* error */ }
    setPhotoLoading(false)
  }

  async function handlePair() {
    pairDoneRef.current = false
    setPairError(null)
    try {
      const url = await window.callBare('qr:scan')  // camera opens natively; wait for scan
      setPairState('connecting')                      // show connecting only after scan
      await window.callBare('acceptInvite', [url])
      if (!pairDoneRef.current) {
        setPairState('success')
      }
    } catch (e) {
      if (e.message === 'cancelled') {
        setPairState('idle')
      } else {
        setPairState('error')
        setPairError(e.message)
      }
    }
  }

  const label = mode === 'parent' ? 'Parent Name' : 'Your Name'
  const placeholder = mode === 'parent' ? 'e.g. Mom' : 'e.g. Alex'

  const inputStyle = {
    padding: '10px',
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.md}px`,
    fontSize: '15px',
    marginTop: `${spacing.xs}px`,
    backgroundColor: colors.surface.input,
    color: colors.text.primary,
  }

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <h2 style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.xl}px`, textAlign: 'center' }}>Profile</h2>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: `${spacing.xl}px` }}>
        <Avatar avatar={avatar} name={savedName} size={80} onClick={() => setShowPicker(true)} />
        <div style={{ display: 'flex', gap: '8px', marginTop: `${spacing.sm}px` }}>
          {window.__pearPlatform === 'ios' ? (
            <button
              onClick={() => { window.callBare('haptic:tap'); handlePickCamera(); }}
              disabled={photoLoading}
              style={{ fontSize: '12px', padding: '5px 14px', borderRadius: `${radius.md}px`, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text.primary, cursor: photoLoading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '5px', opacity: photoLoading ? 0.5 : 1 }}
            >
              <Icon name="Camera" size={14} color={colors.text.primary} /> Camera
            </button>
          ) : (
            <>
              <button
                onClick={() => { window.callBare('haptic:tap'); fileInputRef.current?.click(); }}
                disabled={photoLoading}
                style={{ fontSize: '12px', padding: '5px 14px', borderRadius: `${radius.md}px`, border: `1px solid ${colors.border}`, background: 'transparent', color: colors.text.primary, cursor: photoLoading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '5px', opacity: photoLoading ? 0.5 : 1 }}
              >
                <Icon name="ImageSquare" size={14} color={colors.text.primary} /> Photo
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={handleFileInput} />
            </>
          )}
          {avatar && avatar.type === 'custom' && (
            <button
              onClick={() => { window.callBare('haptic:tap'); handleRemovePhoto(); }}
              disabled={photoLoading}
              style={{ fontSize: '12px', padding: '5px 14px', borderRadius: `${radius.md}px`, border: '1px solid #D45F7A', background: 'transparent', color: '#D45F7A', cursor: photoLoading ? 'wait' : 'pointer', opacity: photoLoading ? 0.5 : 1 }}
            >
              Remove
            </button>
          )}
        </div>
      </div>

      {showPicker && (
        <AvatarPicker
          currentAvatar={avatar}
          name={savedName}
          onSave={handleAvatarSave}
          onCancel={() => setShowPicker(false)}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px`, fontSize: '14px', color: colors.text.secondary }}>
          {label}
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setStatus(null) }}
            onBlur={handleSave}
            placeholder={placeholder}
            style={inputStyle}
          />
        </label>

        {saving && <p style={{ color: colors.text.muted, fontSize: '13px', margin: 0 }}>Saving...</p>}
        {!saving && status === 'success' && <p style={{ color: colors.success, fontSize: '13px', margin: 0 }}>Saved.</p>}
        {status === 'error' && <p style={{ color: colors.error, fontSize: '13px', margin: 0 }}>Failed to save name.</p>}
      </div>

      {mode === 'child' && (
        <div style={{ marginTop: `${spacing.xl}px` }}>
          <Collapsible
            title="Paired Parents"
            icon="User"
            open={parentsOpen}
            onToggle={() => setParentsOpen((o) => !o)}
            maxHeight="600px"
            colors={colors}
            spacing={spacing}
            radius={radius}
          >
            {parents.length > 0 && (
              <div style={{ marginBottom: `${spacing.base}px` }}>
                {parents.map((p) => (
                  <div key={p.publicKey} style={{
                    display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 0', borderBottom: `1px solid ${colors.divider}`,
                  }}>
                    <Avatar avatar={p.avatarThumb} name={p.displayName || 'Parent'} size={32} />
                    <span style={{ width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0, backgroundColor: p.isOnline ? colors.success : colors.border }} />
                    <span style={{ fontSize: '15px', fontWeight: '500', flex: 1, color: colors.text.primary }}>{p.displayName || 'Parent Device'}</span>
                    <span style={{ fontSize: '12px', color: colors.text.muted }}>{p.isOnline ? 'Connected' : 'Offline'}</span>
                  </div>
                ))}
              </div>
            )}

            {pairState === 'idle' && (
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <Button onClick={() => { window.callBare('haptic:tap'); handlePair(); }}>
                  {parents.length > 0 ? 'Pair Another Parent' : 'Pair to Parent'}
                </Button>
              </div>
            )}

            {pairState === 'connecting' && (
              <p style={{ color: colors.text.muted, fontSize: '14px', textAlign: 'center' }}>Connecting to parent...</p>
            )}

            {pairState === 'success' && (
              <p style={{ color: colors.success, fontSize: '13px', margin: 0, textAlign: 'center' }}>Pairing in progress...</p>
            )}

            {pairState === 'error' && (
              <>
                <p style={{ color: colors.error, fontSize: '13px', margin: 0, textAlign: 'center' }}>{pairError}</p>
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: `${spacing.sm}px` }}>
                  <Button onClick={() => { window.callBare('haptic:tap'); setPairState('idle'); }}>
                    Try Again
                  </Button>
                </div>
              </>
            )}
          </Collapsible>

          {pairedBanner && (
            <div style={{
              backgroundColor: `${colors.success}22`,
              color: colors.success,
              border: `1px solid ${colors.success}44`,
              borderRadius: `${radius.md}px`,
              padding: `10px 14px`,
              marginTop: `${spacing.base}px`,
              fontSize: '14px',
              fontWeight: '500',
              textAlign: 'center',
            }}>
              Successfully paired with parent!
            </div>
          )}
        </div>
      )}
    </div>
  )
}
