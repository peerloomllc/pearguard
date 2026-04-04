import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '../theme.js'
import LockOverlay from './LockOverlay.jsx'

function timeRemaining(expiresAt) {
  const diff = Math.max(0, expiresAt - Date.now())
  const mins = Math.ceil(diff / 60000)
  if (mins >= 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm'
  return mins + 'm'
}

export default function ChildHome() {
  const { colors, typography, spacing, radius } = useTheme()
  const [homeData, setHomeData] = useState(null)

  const loadHomeData = useCallback(() => {
    window.callBare('child:homeData').then(setHomeData).catch(() => {})
  }, [])

  useEffect(() => {
    let isMounted = true

    loadHomeData()

    function onPearEvent(event) {
      if (!isMounted) return
      const { name } = event.detail
      if (name === 'policy:updated' || name === 'override:granted' || name === 'request:updated' || name === 'request:submitted') {
        loadHomeData()
      }
    }

    window.addEventListener('__pearEvent', onPearEvent)

    // Refresh overrides every 30s so countdowns stay accurate
    const timer = setInterval(loadHomeData, 30000)

    return () => {
      isMounted = false
      window.removeEventListener('__pearEvent', onPearEvent)
      clearInterval(timer)
    }
  }, [loadHomeData])

  if (!homeData) return <div style={{ padding: `${spacing.xl}px`, color: colors.text.muted }}>Loading...</div>

  if (homeData.locked) {
    return <LockOverlay parentName={homeData.parentName} />
  }

  return (
    <div style={{ padding: `${spacing.xl}px` }}>
      <h2 style={{ ...typography.display, color: colors.text.primary, marginBottom: `${spacing.base}px` }}>
        Hi, {homeData.childName || 'there'}
      </h2>

      {/* Summary row */}
      <div style={{ display: 'flex', gap: `${spacing.md}px` }}>
        <div style={{
          flex: 1, padding: '14px', borderRadius: `${radius.lg}px`,
          backgroundColor: colors.surface.elevated, textAlign: 'center',
        }}>
          <div style={{ fontSize: '22px', fontWeight: '700', color: colors.error }}>{homeData.blockedCount}</div>
          <div style={{ fontSize: '11px', color: colors.text.muted, marginTop: `${spacing.xs}px` }}>Blocked</div>
        </div>
        <div style={{
          flex: 1, padding: '14px', borderRadius: `${radius.lg}px`,
          backgroundColor: colors.surface.elevated, textAlign: 'center',
        }}>
          <div style={{ fontSize: '22px', fontWeight: '700', color: colors.secondary }}>{homeData.pendingCount}</div>
          <div style={{ fontSize: '11px', color: colors.text.muted, marginTop: `${spacing.xs}px` }}>Awaiting approval</div>
        </div>
        <div style={{
          flex: 1, padding: '14px', borderRadius: `${radius.lg}px`,
          backgroundColor: colors.surface.elevated, textAlign: 'center',
        }}>
          <div style={{ fontSize: '22px', fontWeight: '700', color: colors.primary }}>{homeData.pendingRequests}</div>
          <div style={{ fontSize: '11px', color: colors.text.muted, marginTop: `${spacing.xs}px` }}>Pending requests</div>
        </div>
      </div>

      {/* Active overrides */}
      {homeData.activeOverrides.length > 0 && (
        <div style={{ marginTop: `${spacing.xl}px` }}>
          <h3 style={{ fontSize: '15px', fontWeight: '700', marginBottom: '10px', color: colors.text.primary }}>Active overrides</h3>
          {homeData.activeOverrides.map((o, i) => (
            <div key={i} style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              padding: `${spacing.md}px 14px`,
              marginBottom: `${spacing.sm}px`,
              borderRadius: `${radius.md}px`,
              backgroundColor: colors.surface.card,
              border: `1px solid ${colors.primary}44`,
            }}>
              <div>
                <div style={{ fontWeight: '600', fontSize: '14px', color: colors.text.primary }}>{o.appName}</div>
                <div style={{ fontSize: '12px', color: colors.text.muted, marginTop: '2px' }}>
                  {o.source === 'parent-approved' ? 'Granted by parent' : 'PIN override'}
                </div>
              </div>
              <div style={{ fontSize: '13px', fontWeight: '600', color: colors.primary }}>{timeRemaining(o.expiresAt)} left</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
