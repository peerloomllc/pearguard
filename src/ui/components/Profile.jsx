import React, { useState, useEffect, useRef } from 'react'

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
  const [pairState, setPairState] = useState('idle') // 'idle' | 'connecting' | 'success' | 'error'
  const [pairError, setPairError] = useState(null)
  const [parents, setParents] = useState([]) // child mode: list of paired parents
  const [pairedBanner, setPairedBanner] = useState(false)
  const pairDoneRef = useRef(false) // true once peer:paired fires; prevents acceptInvite overriding state

  useEffect(() => {
    window.callBare('identity:getName')
      .then(({ displayName }) => {
        const n = displayName || ''
        setName(n)
        setSavedName(n)
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

  async function handlePair() {
    pairDoneRef.current = false
    setPairError(null)
    try {
      const url = await window.callBare('qr:scan')  // camera opens natively; wait for scan
      setPairState('connecting')                      // show connecting only after scan
      await window.callBare('acceptInvite', [url])
      // Only show "Pairing in progress" if peer:paired hasn't already fired and
      // reset the state (race condition on fast LAN: hello exchange completes before
      // swarm.flush() resolves and acceptInvite returns).
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

      {mode === 'child' && pairedBanner && (
        <div style={styles.banner}>Successfully paired with parent!</div>
      )}

      {mode === 'child' && (
        <div style={styles.section}>
          <h3 style={styles.sectionHeading}>Parents</h3>

          {parents.length > 0 && (
            <div style={styles.parentsList}>
              {parents.map((p) => (
                <div key={p.publicKey} style={styles.parentRow}>
                  <span style={{ ...styles.onlineDot, backgroundColor: p.isOnline ? '#34a853' : '#bbb' }} />
                  <span style={styles.parentName}>{p.displayName || 'Parent Device'}</span>
                  <span style={styles.parentStatus}>{p.isOnline ? 'Connected' : 'Offline'}</span>
                </div>
              ))}
            </div>
          )}

          {pairState === 'idle' && (
            <button style={styles.btn} onClick={handlePair}>
              {parents.length > 0 ? 'Pair Another Parent' : 'Pair to Parent'}
            </button>
          )}

          {pairState === 'connecting' && (
            <p style={styles.hint}>Connecting to parent…</p>
          )}

          {pairState === 'success' && (
            <p style={styles.success}>Pairing in progress…</p>
          )}

          {pairState === 'error' && (
            <>
              <p style={styles.error}>{pairError}</p>
              <button style={styles.btn} onClick={() => setPairState('idle')}>
                Try Again
              </button>
            </>
          )}
        </div>
      )}
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
  banner: {
    backgroundColor: '#e6f4ea', color: '#1e7e34', border: '1px solid #a8d5b5',
    borderRadius: '6px', padding: '10px 14px', marginTop: '16px', fontSize: '14px', fontWeight: '500',
  },
  section:        { marginTop: '32px' },
  sectionHeading: { fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: '#333' },
  hint:           { color: '#888', fontSize: '14px' },
  parentsList:    { marginBottom: '16px' },
  parentRow:      { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 0', borderBottom: '1px solid #eee' },
  onlineDot:      { width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0 },
  parentName:     { fontSize: '15px', fontWeight: '500', flex: 1 },
  parentStatus:   { fontSize: '12px', color: '#888' },
}
