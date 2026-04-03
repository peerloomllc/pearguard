import React, { useState, useEffect } from 'react'

function statusBadge(status) {
  switch (status) {
    case 'approved': return { label: 'Approved!', color: '#007733' }
    case 'denied':   return { label: 'Denied', color: '#CC0000' }
    default:         return { label: 'Pending...', color: '#888' }
  }
}

export default function ChildRequests() {
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [clearing, setClearing] = useState(false)

  async function loadRequests() {
    setLoading(true)
    const { requests } = await window.callBare('requests:list')
    setRequests(requests || [])
    setLoading(false)
  }

  async function handleClearResolved() {
    setClearing(true)
    await window.callBare('requests:clear')
    await loadRequests()
    setClearing(false)
  }

  useEffect(() => {
    let isMounted = true

    loadRequests().then(() => { if (!isMounted) return })

    const unsubSubmit = window.onBareEvent('request:submitted', () => { if (isMounted) loadRequests() })
    const unsubUpdated = window.onBareEvent('request:updated', () => { if (isMounted) loadRequests() })

    return () => {
      isMounted = false
      unsubSubmit()
      unsubUpdated()
    }
  }, [])

  if (loading) return <div style={{ padding: 24 }}>Loading...</div>

  return (
    <div style={{ padding: 24 }}>
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>My Requests</h2>
        {requests.some((r) => r.status === 'approved' || r.status === 'denied') && (
          <button
            onClick={() => { window.callBare('haptic:tap'); handleClearResolved(); }}
            disabled={clearing}
            style={{ fontSize: 13, padding: '6px 12px', border: '1px solid #ccc', borderRadius: 6, background: '#fff', cursor: clearing ? 'not-allowed' : 'pointer', color: '#555' }}
          >
            {clearing ? 'Clearing…' : 'Clear resolved'}
          </button>
        )}
      </div>

      {requests.length === 0 && (
        <p style={{ color: '#888' }}>No requests yet.</p>
      )}

      {requests.map((req) => {
        const badge = statusBadge(req.status)
        return (
          <div
            key={req.id}
            style={{
              padding: 16,
              marginBottom: 12,
              borderRadius: 8,
              backgroundColor: '#F5F5F5',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <div style={{ fontWeight: 'bold' }}>{req.appName || req.packageName}</div>
              <div style={{ color: '#888', fontSize: 12, marginTop: 4 }}>
                {new Date(req.requestedAt).toLocaleTimeString()}
              </div>
            </div>
            <div style={{ color: badge.color, fontWeight: 'bold' }}>{badge.label}</div>
          </div>
        )
      })}
    </div>
  )
}
