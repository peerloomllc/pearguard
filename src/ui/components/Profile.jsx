import React, { useState, useEffect, useRef } from 'react'
import { useTheme } from '../theme.js'
import Icon from '../icons.js'
import Avatar from './Avatar.jsx'
import AvatarPicker from './AvatarPicker.jsx'

export default function Profile({ mode }) {
  const { colors, typography, spacing, radius } = useTheme()
  const [name, setName] = useState('')
  const [savedName, setSavedName] = useState('')
  const [avatar, setAvatar] = useState(null)
  const [showPicker, setShowPicker] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null) // null | 'success' | 'error'
  const [pairState, setPairState] = useState('idle') // 'idle' | 'connecting' | 'success' | 'error'
  const [pairError, setPairError] = useState(null)
  const [parents, setParents] = useState([]) // child mode: list of paired parents
  const [pairedBanner, setPairedBanner] = useState(false)
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
    window.callBare('children:list').then(setParents).catch(() => {})
    const unsub = window.onBareEvent('peer:paired', () => {
      pairDoneRef.current = true
      window.callBare('children:list').then(setParents).catch(() => {})
      setPairState('idle')
      setPairedBanner(true)
      setTimeout(() => setPairedBanner(false), 3000)
    })
    return unsub
  }, [mode])

  async function handleSave() {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    setStatus(null)
    try {
      await window.callBare('identity:setName', { name: trimmed })
      setSavedName(trimmed)
      setStatus('success')
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
  const unchanged = name.trim() === savedName || !name.trim()

  const inputStyle = {
    padding: '10px',
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.md}px`,
    fontSize: '15px',
    marginTop: `${spacing.xs}px`,
    backgroundColor: colors.surface.input,
    color: colors.text.primary,
  }

  const btnStyle = {
    padding: `${spacing.md}px`,
    border: 'none',
    borderRadius: `${radius.md}px`,
    backgroundColor: colors.primary,
    color: '#FFFFFF',
    cursor: 'pointer',
    fontSize: '15px',
    fontWeight: '600',
    marginTop: `${spacing.xs}px`,
  }

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <h2 style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.xl}px` }}>Profile</h2>

      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: `${spacing.xl}px` }}>
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <Avatar avatar={avatar} name={savedName} size={80} onClick={() => setShowPicker(true)} />
          <div
            style={{
              position: 'absolute', bottom: '0', right: '0',
              width: '26px', height: '26px', borderRadius: '50%',
              backgroundColor: colors.primary, border: '2px solid #FFF',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
            }}
            onClick={() => { window.callBare('haptic:tap'); setShowPicker(true); }}
          >
            <Icon name="PencilSimple" size={13} color="#FFFFFF" />
          </div>
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
            placeholder={placeholder}
            style={inputStyle}
          />
        </label>

        {status === 'success' && <p style={{ color: colors.success, fontSize: '13px', margin: 0 }}>Name saved.</p>}
        {status === 'error' && <p style={{ color: colors.error, fontSize: '13px', margin: 0 }}>Failed to save name.</p>}

        <button
          onClick={() => { window.callBare('haptic:tap'); handleSave(); }}
          disabled={saving || unchanged}
          style={{ ...btnStyle, alignSelf: 'center', ...(saving || unchanged ? { backgroundColor: colors.surface.elevated, color: colors.text.muted, cursor: 'not-allowed' } : {}) }}
        >
          {saving ? 'Saving\u2026' : 'Save Name'}
        </button>
      </div>

      {mode === 'child' && pairedBanner && (
        <div style={{
          backgroundColor: `${colors.success}22`,
          color: colors.success,
          border: `1px solid ${colors.success}44`,
          borderRadius: `${radius.md}px`,
          padding: `10px 14px`,
          marginTop: `${spacing.base}px`,
          fontSize: '14px',
          fontWeight: '500',
        }}>
          Successfully paired with parent!
        </div>
      )}

      {mode === 'child' && (
        <div style={{ marginTop: `${spacing.xxl}px` }}>
          <h3 style={{ fontSize: '16px', fontWeight: '600', marginBottom: `${spacing.md}px`, color: colors.text.primary }}>Parents</h3>

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
            <button style={btnStyle} onClick={() => { window.callBare('haptic:tap'); handlePair(); }}>
              {parents.length > 0 ? 'Pair Another Parent' : 'Pair to Parent'}
            </button>
          )}

          {pairState === 'connecting' && (
            <p style={{ color: colors.text.muted, fontSize: '14px' }}>Connecting to parent\u2026</p>
          )}

          {pairState === 'success' && (
            <p style={{ color: colors.success, fontSize: '13px', margin: 0 }}>Pairing in progress\u2026</p>
          )}

          {pairState === 'error' && (
            <>
              <p style={{ color: colors.error, fontSize: '13px', margin: 0 }}>{pairError}</p>
              <button style={btnStyle} onClick={() => { window.callBare('haptic:tap'); setPairState('idle'); }}>
                Try Again
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
