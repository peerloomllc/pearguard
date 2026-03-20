import React, { useState, useEffect } from 'react'

function getInitials(name) {
  return name.trim()
    ? name.trim().split(/\s+/).map((w) => w[0].toUpperCase()).slice(0, 2).join('')
    : '?'
}

export default function Profile({ mode }) {
  const [name, setName] = useState('')
  const [savedName, setSavedName] = useState('')
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState(null) // null | 'success' | 'error'

  useEffect(() => {
    window.callBare('identity:getName')
      .then(({ displayName }) => {
        const n = displayName || ''
        setName(n)
        setSavedName(n)
      })
      .catch(() => {})
  }, [])

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

  const label = mode === 'parent' ? 'Parent Name' : 'Your Name'
  const placeholder = mode === 'parent' ? 'e.g. Mom' : 'e.g. Alex'
  const unchanged = name.trim() === savedName || !name.trim()

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Profile</h2>

      <div style={styles.avatarWrap}>
        <div style={styles.avatar}>
          <span style={styles.initials}>{getInitials(savedName)}</span>
        </div>
      </div>

      <div style={styles.field}>
        <label style={styles.label}>
          {label}
          <input
            type="text"
            value={name}
            onChange={(e) => { setName(e.target.value); setStatus(null) }}
            placeholder={placeholder}
            style={styles.input}
          />
        </label>

        {status === 'success' && <p style={styles.success}>Name saved.</p>}
        {status === 'error' && <p style={styles.error}>Failed to save name.</p>}

        <button
          onClick={handleSave}
          disabled={saving || unchanged}
          style={{ ...styles.btn, ...(saving || unchanged ? styles.btnDisabled : {}) }}
        >
          {saving ? 'Saving…' : 'Save Name'}
        </button>
      </div>
    </div>
  )
}

const styles = {
  container: { padding: '16px', fontFamily: 'sans-serif' },
  heading: { fontSize: '20px', fontWeight: '700', marginBottom: '24px' },
  avatarWrap: { display: 'flex', justifyContent: 'center', marginBottom: '24px' },
  avatar: {
    width: '80px', height: '80px', borderRadius: '50%',
    backgroundColor: '#1a73e8',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  initials: { color: '#fff', fontSize: '28px', fontWeight: '700' },
  field: { display: 'flex', flexDirection: 'column', gap: '8px' },
  label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '14px', color: '#444' },
  input: {
    padding: '10px', border: '1px solid #ccc', borderRadius: '6px',
    fontSize: '15px', marginTop: '4px',
  },
  btn: {
    padding: '12px', border: 'none', borderRadius: '6px',
    backgroundColor: '#1a73e8', color: '#fff', cursor: 'pointer',
    fontSize: '15px', fontWeight: '600', marginTop: '4px',
  },
  btnDisabled: { backgroundColor: '#ccc', cursor: 'not-allowed' },
  success: { color: '#34a853', fontSize: '13px', margin: 0 },
  error: { color: '#ea4335', fontSize: '13px', margin: 0 },
}
