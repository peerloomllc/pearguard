import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '../theme.js'
import Icon from '../icons.js'
import Modal from './primitives/Modal.jsx'

function greeting(name) {
  if (name) return `Hi, ${name}`
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function timeRemaining(expiresAt) {
  const diff = Math.max(0, expiresAt - Date.now())
  const mins = Math.ceil(diff / 60000)
  if (mins >= 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm'
  return mins + 'm'
}

function SummaryTile({ value, label, valueColor, onClick, disabled, colors, spacing, radius }) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        flex: 1,
        padding: '14px',
        borderRadius: `${radius.lg}px`,
        backgroundColor: colors.surface.elevated,
        border: 'none',
        textAlign: 'center',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        fontFamily: 'inherit',
      }}
    >
      <div style={{ fontSize: '22px', fontWeight: '700', color: valueColor }}>{value}</div>
      <div style={{ fontSize: '11px', color: colors.text.muted, marginTop: `${spacing.xs}px` }}>{label}</div>
    </button>
  )
}

function AppList({ items, emptyText, colors, typography, spacing, radius }) {
  if (!items || items.length === 0) {
    return <p style={{ ...typography.body, color: colors.text.muted, textAlign: 'center' }}>{emptyText}</p>
  }
  return (
    <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
      {items.map((a) => (
        <div
          key={a.packageName}
          style={{
            padding: `${spacing.md}px ${spacing.base}px`,
            marginBottom: `${spacing.sm}px`,
            borderRadius: `${radius.md}px`,
            backgroundColor: colors.surface.elevated,
            ...typography.body,
            color: colors.text.primary,
            fontWeight: '600',
          }}
        >
          {a.appName}
          <div style={{ ...typography.caption, color: colors.text.muted, fontWeight: '400', marginTop: `${spacing.xs}px` }}>
            {a.packageName}
          </div>
        </div>
      ))}
    </div>
  )
}

function RequestList({ items, colors, typography, spacing, radius }) {
  if (!items || items.length === 0) {
    return <p style={{ ...typography.body, color: colors.text.muted, textAlign: 'center' }}>No pending requests.</p>
  }
  return (
    <div style={{ maxHeight: '50vh', overflowY: 'auto' }}>
      {items.map((r) => (
        <div
          key={r.id}
          style={{
            padding: `${spacing.md}px ${spacing.base}px`,
            marginBottom: `${spacing.sm}px`,
            borderRadius: `${radius.md}px`,
            backgroundColor: colors.surface.elevated,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ ...typography.body, fontWeight: '600', color: colors.text.primary }}>
              {r.appName || r.packageName}
            </div>
            <div style={{ ...typography.caption, color: colors.text.muted, marginTop: `${spacing.xs}px` }}>
              {new Date(r.requestedAt).toLocaleTimeString()}
            </div>
          </div>
          <div style={{ ...typography.caption, fontWeight: '700', color: colors.text.muted }}>Pending...</div>
        </div>
      ))}
    </div>
  )
}

export default function ChildHome({ openDetail }) {
  const { colors, typography, spacing, radius } = useTheme()
  const [homeData, setHomeData] = useState(null)
  const [detail, setDetail] = useState(null) // 'blocked' | 'pending' | 'requests' | null

  const loadHomeData = useCallback(() => {
    window.callBare('child:homeData').then(setHomeData).catch(() => {})
  }, [])

  useEffect(() => {
    loadHomeData()
    const unsubs = [
      window.onBareEvent('policy:updated', loadHomeData),
      window.onBareEvent('override:granted', loadHomeData),
      window.onBareEvent('request:updated', loadHomeData),
      window.onBareEvent('request:submitted', loadHomeData),
    ]
    const timer = setInterval(loadHomeData, 30000)
    return () => {
      unsubs.forEach((fn) => fn())
      clearInterval(timer)
    }
  }, [loadHomeData])

  // Allow parent (ChildApp) to open a detail modal via prop/event
  useEffect(() => {
    if (!openDetail) return
    const unsub = window.onBareEvent('navigate:child:requests', () => setDetail('requests'))
    return unsub
  }, [openDetail])

  if (!homeData) return <div style={{ padding: `${spacing.xl}px`, color: colors.text.muted }}>Loading...</div>

  const detailTitle =
    detail === 'blocked' ? 'Blocked apps' :
    detail === 'pending' ? 'Awaiting approval' :
    detail === 'requests' ? 'Pending requests' : ''

  return (
    <div style={{ padding: `${spacing.xl}px`, paddingTop: `calc(${spacing.xl}px + env(safe-area-inset-top, 0px))` }}>
      {homeData.locked && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`,
          padding: `${spacing.md}px`, borderRadius: `${radius.md}px`,
          backgroundColor: colors.error + '22',
          border: `1px solid ${colors.error}`,
          marginBottom: `${spacing.base}px`,
        }}>
          <Icon name="LockSimple" size={20} color={colors.error} />
          <div style={{ flex: 1 }}>
            <div style={{ ...typography.body, fontWeight: '600', color: colors.error }}>
              Device locked{homeData.parentName ? ` by ${homeData.parentName}` : ''}
            </div>
            {homeData.lockMessage ? (
              <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: `${spacing.xs}px` }}>
                {homeData.lockMessage}
              </div>
            ) : null}
          </div>
        </div>
      )}
      <h2 style={{ ...typography.display, color: colors.text.primary, marginBottom: `${spacing.base}px`, textAlign: 'center' }}>
        {greeting(homeData.childName)}
      </h2>

      {/* Summary row */}
      <div style={{ display: 'flex', gap: `${spacing.md}px` }}>
        <SummaryTile
          value={homeData.blockedCount}
          label="Blocked"
          valueColor={colors.error}
          onClick={() => setDetail('blocked')}
          disabled={homeData.blockedCount === 0}
          colors={colors} spacing={spacing} radius={radius}
        />
        <SummaryTile
          value={homeData.pendingCount}
          label="Awaiting approval"
          valueColor={colors.secondary}
          onClick={() => setDetail('pending')}
          disabled={homeData.pendingCount === 0}
          colors={colors} spacing={spacing} radius={radius}
        />
        <SummaryTile
          value={homeData.pendingRequests}
          label="Pending requests"
          valueColor={colors.primary}
          onClick={() => setDetail('requests')}
          disabled={homeData.pendingRequests === 0}
          colors={colors} spacing={spacing} radius={radius}
        />
      </div>

      {/* Active overrides */}
      {homeData.activeOverrides.length > 0 && (
        <div style={{ marginTop: `${spacing.xl}px` }}>
          <h3 style={{ fontSize: '15px', fontWeight: '700', marginBottom: '10px', color: colors.text.primary, textAlign: 'center' }}>Active overrides</h3>
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

      <Modal visible={!!detail} onClose={() => setDetail(null)} title={detailTitle}>
        {detail === 'blocked' && (
          <AppList items={homeData.blockedApps} emptyText="No blocked apps." colors={colors} typography={typography} spacing={spacing} radius={radius} />
        )}
        {detail === 'pending' && (
          <AppList items={homeData.pendingApps} emptyText="Nothing awaiting approval." colors={colors} typography={typography} spacing={spacing} radius={radius} />
        )}
        {detail === 'requests' && (
          <RequestList items={homeData.pendingRequestsList} colors={colors} typography={typography} spacing={spacing} radius={radius} />
        )}
      </Modal>
    </div>
  )
}
