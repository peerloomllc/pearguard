import React, { useState, useEffect } from 'react'
import { useTheme } from '../theme.js'

function statusBadge(status, colors) {
  switch (status) {
    case 'approved': return { label: 'Approved!', color: colors.success }
    case 'denied':   return { label: 'Denied',    color: colors.error }
    default:         return { label: 'Pending...', color: colors.text.muted }
  }
}

export default function ChildRequests() {
  const { colors, typography, spacing, radius } = useTheme()
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

  if (loading) {
    return (
      <div style={{ padding: `${spacing.xl}px`, color: colors.text.muted, ...typography.body }}>
        Loading...
      </div>
    )
  }

  const hasResolved = requests.some((r) => r.status === 'approved' || r.status === 'denied')

  return (
    <div style={{ padding: `${spacing.xl}px`, ...typography.body, color: colors.text.primary }}>
      <div style={{
        marginBottom: `${spacing.base}px`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <h2 style={{ ...typography.display, color: colors.text.primary, margin: 0 }}>My Requests</h2>
        {hasResolved && (
          <button
            onClick={() => { window.callBare('haptic:tap'); handleClearResolved(); }}
            disabled={clearing}
            style={{
              ...typography.caption,
              padding: `${spacing.xs}px ${spacing.md}px`,
              border: `1px solid ${colors.border}`,
              borderRadius: `${radius.md}px`,
              background: colors.surface.card,
              color: colors.text.secondary,
              cursor: clearing ? 'not-allowed' : 'pointer',
            }}
          >
            {clearing ? 'Clearing...' : 'Clear resolved'}
          </button>
        )}
      </div>

      {requests.length === 0 && (
        <p style={{ ...typography.body, color: colors.text.muted }}>No requests yet.</p>
      )}

      {requests.map((req) => {
        const badge = statusBadge(req.status, colors)
        return (
          <div
            key={req.id}
            style={{
              padding: `${spacing.base}px`,
              marginBottom: `${spacing.md}px`,
              borderRadius: `${radius.md}px`,
              backgroundColor: colors.surface.card,
              border: `1px solid ${colors.border}`,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <div style={{ ...typography.body, fontWeight: '600', color: colors.text.primary }}>
                {req.appName || req.packageName}
              </div>
              <div style={{ ...typography.caption, color: colors.text.muted, marginTop: `${spacing.xs}px` }}>
                {new Date(req.requestedAt).toLocaleTimeString()}
              </div>
            </div>
            <div style={{ ...typography.caption, fontWeight: '700', color: badge.color }}>
              {badge.label}
            </div>
          </div>
        )
      })}
    </div>
  )
}
