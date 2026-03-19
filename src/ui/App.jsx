// src/ui/App.jsx
//
// Root React component rendered inside the WebView.
// Minimal UI for now — shows status and runs ping to verify IPC round-trip.

import React, { useState, useEffect } from 'react'

const styles = {
  root: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    justifyContent: 'center', height: '100dvh',
    backgroundColor: '#111', color: '#fff',
    fontFamily: 'sans-serif', gap: 16, padding: 24,
  },
  title: { fontSize: 28, fontWeight: 700, color: '#6FCF97' },
  status: { fontSize: 14, color: '#aaa' },
  badge: { fontSize: 12, color: '#555' },
}

export default function App () {
  const [status, setStatus] = useState('Initializing…')
  const [pubkey, setPubkey] = useState(null)
  const [mode,   setMode]   = useState(null)

  useEffect(() => {
    // Listen for the 'ready' event from Bare
    window.__pearOn('ready', (data) => {
      setPubkey(data.publicKey)
      setMode(data.mode)
      setStatus('Ready')

      // Run a ping to verify IPC round-trip
      window.__pearCall('ping').then(result => {
        console.log('[UI] ping result:', result)
        setStatus('Ready — ping: ' + result)
      }).catch(err => {
        setStatus('Ping failed: ' + err.message)
      })
    })
  }, [])

  return (
    <div style={styles.root}>
      <div style={styles.title}>PearGuard</div>
      <div style={styles.status}>{status}</div>
      {pubkey && <div style={styles.badge}>Key: {pubkey.slice(0, 12)}…</div>}
      {mode   && <div style={styles.badge}>Mode: {mode}</div>}
    </div>
  )
}
