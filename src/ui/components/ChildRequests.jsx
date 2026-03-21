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
  const [lastBlockedPackage, setLastBlockedPackage] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function loadRequests() {
    setLoading(true)
    const { requests } = await window.callBare('requests:list')
    setRequests(requests || [])
    setLoading(false)
  }

  useEffect(() => {
    let isMounted = true

    loadRequests().then(() => {
      if (!isMounted) return
    })

    const unsubSubmit = window.onBareEvent('request:submitted', () => { if (isMounted) loadRequests() })
    const unsubUpdated = window.onBareEvent('request:updated', () => { if (isMounted) loadRequests() })
    const unsubBlock = window.onBareEvent('block:occurred', (data) => {
      if (isMounted) setLastBlockedPackage(data.packageName)
    })

    return () => {
      isMounted = false
      unsubSubmit()
      unsubUpdated()
      unsubBlock()
    }
  }, [])

  async function handleNewRequest() {
    if (submitting || !lastBlockedPackage) return
    setSubmitting(true)
    try {
      await window.callBare('time:request', { packageName: lastBlockedPackage })
      setSubmitted(true)
      setLastBlockedPackage(null) // prevent duplicate requests
      await loadRequests()
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div style={{ padding: 24 }}>Loading...</div>

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>My Requests</h2>
        <button
          onClick={handleNewRequest}
          disabled={!lastBlockedPackage || submitting || submitted}
          style={{ padding: '8px 16px', opacity: (!lastBlockedPackage || submitting || submitted) ? 0.4 : 1 }}
        >
          {submitting ? 'Sending…' : 'New Request'}
        </button>
      </div>

      {submitted && (
        <p style={{ color: '#34a853', fontSize: 14, marginBottom: 12 }}>
          Request sent! Your parent will be notified.
        </p>
      )}

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
              {req.appName && (
                <div style={{ color: '#888', fontSize: 11, fontFamily: 'monospace', marginTop: 2 }}>
                  {req.packageName}
                </div>
              )}
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
