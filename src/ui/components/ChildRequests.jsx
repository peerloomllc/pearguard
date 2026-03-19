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

    function onPearEvent(event) {
      if (!isMounted) return
      const { name, data } = event.detail
      if (name === 'request:submitted' || name === 'request:updated') {
        loadRequests()
      }
      if (name === 'block:occurred') {
        setLastBlockedPackage(data.packageName)
      }
    }

    window.addEventListener('__pearEvent', onPearEvent)
    return () => {
      isMounted = false
      window.removeEventListener('__pearEvent', onPearEvent)
    }
  }, [])

  function handleNewRequest() {
    window.callBare('time:request', { packageName: lastBlockedPackage }).then(loadRequests)
  }

  if (loading) return <div style={{ padding: 24 }}>Loading...</div>

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>My Requests</h2>
        <button
          onClick={handleNewRequest}
          disabled={!lastBlockedPackage}
          style={{ padding: '8px 16px', opacity: lastBlockedPackage ? 1 : 0.4 }}
        >
          New Request
        </button>
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
              <div style={{ fontWeight: 'bold' }}>{req.packageName}</div>
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
