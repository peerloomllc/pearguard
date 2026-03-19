// src/ui/App.jsx
//
// Root React component rendered inside the WebView.
// Handles both parent and child pairing flows.
// Parent: shows "Generate Invite" button, displays QR/link when ready.
// Child: shows "Ready — waiting for parent" after pairing.

import React, { useState, useEffect } from 'react'

const s = {
  root:    { display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
             height:'100dvh', background:'#111', color:'#fff', fontFamily:'sans-serif', gap:16, padding:24 },
  title:   { fontSize:28, fontWeight:700, color:'#6FCF97' },
  status:  { fontSize:14, color:'#aaa', textAlign:'center' },
  btn:     { padding:'12px 28px', borderRadius:12, background:'#1a2e1a', border:'1px solid #6FCF97',
             color:'#6FCF97', fontSize:16, cursor:'pointer' },
  link:    { fontSize:11, color:'#555', wordBreak:'break-all', maxWidth:320, textAlign:'center' },
  badge:   { fontSize:11, color:'#555' },
}

export default function App () {
  const [status,     setStatus]     = useState('Initializing…')
  const [pubkey,     setPubkey]     = useState(null)
  const [mode,       setMode]       = useState(null)
  const [inviteLink, setInviteLink] = useState(null)
  const [paired,     setPaired]     = useState(false)

  useEffect(() => {
    window.__pearOn('ready', (data) => {
      setPubkey(data.publicKey)
      setMode(data.mode)
      setStatus(data.mode ? 'Ready' : 'Select mode…')
    })

    window.__pearOn('peer:paired', (data) => {
      setPaired(true)
      setStatus('Paired with ' + (data.displayName ?? 'peer'))
    })

    window.__pearOn('peer:connected', () => setStatus('Peer connected — handshaking…'))
  }, [])

  async function generateInvite () {
    setStatus('Generating invite…')
    try {
      const result = await window.__pearCall('generateInvite')
      setInviteLink(result.inviteLink)
      setStatus('Share this link with your child:')
    } catch (e) {
      setStatus('Error: ' + e.message)
    }
  }

  return (
    <div style={s.root}>
      <div style={s.title}>PearGuard</div>
      <div style={s.status}>{status}</div>

      {mode === 'parent' && !paired && !inviteLink && (
        <button style={s.btn} onClick={generateInvite}>Generate Invite</button>
      )}

      {inviteLink && (
        <div style={s.link}>{inviteLink}</div>
      )}

      {paired && <div style={{ color:'#6FCF97', fontSize:16 }}>Paired!</div>}

      {pubkey && <div style={s.badge}>Key: {pubkey.slice(0,12)}…</div>}
      {mode   && <div style={s.badge}>Mode: {mode}</div>}
    </div>
  )
}
