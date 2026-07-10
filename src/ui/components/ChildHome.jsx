import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '../theme.js'
import Icon from '../icons.js'
import Modal from './primitives/Modal.jsx'
import Button from './primitives/Button.jsx'

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

const ASK_OPTIONS_MINUTES = [15, 30, 60]

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// "in 2h 15m" / "in 20m" / "in under a minute"
function formatCountdown(ms) {
  const mins = Math.round((ms - Date.now()) / 60000)
  if (mins < 1) return 'in under a minute'
  if (mins < 60) return `in ${mins}m`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`
}

// One visual language for the three always-present sections, so the home screen
// reads as a stable list rather than a stack of cards that appear and vanish.
function Section({ title, children, colors, typography, spacing }) {
  return (
    <div style={{ marginTop: `${spacing.xl}px` }}>
      <h3 style={{ fontSize: '15px', fontWeight: '700', margin: `0 0 ${spacing.sm}px`, color: colors.text.primary, textAlign: 'center' }}>
        {title}
      </h3>
      {children}
    </div>
  )
}

// "Nothing set" rather than a missing section — an empty rule is information too.
function EmptyState({ children, colors, typography, spacing, radius }) {
  return (
    <div style={{
      ...typography.caption, color: colors.text.muted, textAlign: 'center',
      padding: `${spacing.md}px`, borderRadius: `${radius.md}px`,
      backgroundColor: colors.surface.card, border: `1px dashed ${colors.border}`,
    }}>
      {children}
    </div>
  )
}

// A scheduled blackout is the one block that arrives with no warning, so the
// child gets told when it starts (or when the current one lifts).
function BedtimeSection({ nextSchedule, colors, typography, spacing, radius }) {
  return (
    <Section title="Bedtime" colors={colors} typography={typography} spacing={spacing}>
      {!nextSchedule ? (
        <EmptyState colors={colors} typography={typography} spacing={spacing} radius={radius}>
          No bedtime set
        </EmptyState>
      ) : (
        <div style={{
          display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`,
          padding: `${spacing.md}px`, borderRadius: `${radius.md}px`,
          backgroundColor: colors.surface.card,
          border: `1px solid ${nextSchedule.active ? colors.error : colors.border}`,
        }}>
          <Icon name="Clock" size={18} color={nextSchedule.active ? colors.error : colors.text.secondary} />
          <div style={{ ...typography.caption, color: colors.text.primary }}>
            {nextSchedule.active
              ? <>{nextSchedule.label} until <strong>{formatClock(nextSchedule.at)}</strong></>
              : <>{nextSchedule.label} at <strong>{formatClock(nextSchedule.at)}</strong>{' '}
                  <span style={{ color: colors.text.secondary }}>({formatCountdown(nextSchedule.at)})</span></>}
          </div>
        </div>
      )}
    </Section>
  )
}

// "Chrome", "Chrome and Firefox", "Chrome, Firefox and Signal"
function joinNames(names) {
  if (names.length === 1) return names[0]
  return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
}

function formatBonus(seconds) {
  const mins = Math.round(seconds / 60)
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60}h`
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  return `${mins}m`
}

// Per-app countdowns. Independent of the device-wide cap — a parent can limit
// one app without setting any overall budget.
function AppLimitsSection({ appLimits, colors, typography, spacing, radius }) {
  return (
    <Section title="Time left per app" colors={colors} typography={typography} spacing={spacing}>
      {appLimits.length === 0 ? (
        <EmptyState colors={colors} typography={typography} spacing={spacing} radius={radius}>
          No app limits set
        </EmptyState>
      ) : appLimits.map((a) => (
        <div key={a.packageName} style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: `${spacing.sm}px ${spacing.md}px`, marginBottom: `${spacing.xs}px`,
          borderRadius: `${radius.md}px`, backgroundColor: colors.surface.card,
          border: `1px solid ${a.remainingSeconds === 0 ? colors.error : colors.border}`,
        }}>
          <span style={{ ...typography.caption, color: colors.text.primary }}>{a.appName}</span>
          <span style={{
            ...typography.caption, fontWeight: '600',
            color: a.remainingSeconds === 0 ? colors.error : colors.primary,
          }}>
            {a.remainingSeconds === 0 ? 'None left' : formatBonus(a.remainingSeconds) + ' left'}
          </span>
        </div>
      ))}
    </Section>
  )
}

// Lets the child ask for more of the shared daily budget rather than for one
// app. The request carries no packageName because the grant is device-wide.
function ScreenTimeSection({ hasLimit, pending, exemptAppNames, screenTime, onSubmitted, colors, typography, spacing, radius }) {
  const [choosing, setChoosing] = useState(false)
  const [sending, setSending] = useState(false)

  // hasLimit comes from the policy; screenTime from native. Early after launch the
  // policy says there's a cap before native has reported one, so trust hasLimit for
  // the empty state and let the figures fill in a moment later.
  const remaining = screenTime ? screenTime.remainingSeconds : null
  const bonusSeconds = screenTime ? screenTime.bonusSeconds : 0

  async function ask(minutes) {
    setSending(true)
    try {
      await window.callBare('time:request', {
        packageName: 'general',
        appName: 'Screen time',
        requestType: 'general_time',
        extraSeconds: minutes * 60,
      })
      setChoosing(false)
      onSubmitted()
    } catch (e) {
      console.error('general time request failed:', e)
    } finally {
      setSending(false)
    }
  }

  if (!hasLimit) {
    return (
      <Section title="Screen time" colors={colors} typography={typography} spacing={spacing}>
        <EmptyState colors={colors} typography={typography} spacing={spacing} radius={radius}>
          No daily screen time limit set
        </EmptyState>
      </Section>
    )
  }

  return (
    <Section title="Screen time" colors={colors} typography={typography} spacing={spacing}>
      <div style={{
        textAlign: 'center', marginBottom: `${spacing.md}px`,
        padding: `${spacing.md}px`, borderRadius: `${radius.md}px`,
        backgroundColor: colors.surface.card,
        border: `1px solid ${remaining === 0 ? colors.error : colors.border}`,
      }}>
        <div style={{ ...typography.display, color: remaining === 0 ? colors.error : colors.primary, fontWeight: '700' }}>
          {remaining === null ? '--' : remaining === 0 ? 'No time left' : formatBonus(remaining)}
        </div>
        <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: `${spacing.xs}px` }}>
          {remaining === 0 ? 'Your screen time is used up for today' : 'left today'}
        </div>
        {bonusSeconds > 0 && (
          <div style={{ ...typography.caption, color: colors.primary, marginTop: `${spacing.xs}px` }}>
            includes +{formatBonus(bonusSeconds)} granted by your parent
          </div>
        )}
        {exemptAppNames.length > 0 && (
          <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: `${spacing.xs}px` }}>
            {joinNames(exemptAppNames)} {exemptAppNames.length === 1 ? "doesn't" : "don't"} use your screen time
          </div>
        )}
      </div>
      {pending ? (
        <div style={{
          ...typography.caption, color: colors.text.secondary, textAlign: 'center',
          padding: `${spacing.md}px`, borderRadius: `${radius.md}px`,
          backgroundColor: colors.surface.card, border: `1px solid ${colors.border}`,
        }}>
          Waiting for your parent to answer your request for more time.
        </div>
      ) : choosing ? (
        <div style={{ display: 'flex', gap: `${spacing.sm}px`, justifyContent: 'center' }}>
          {ASK_OPTIONS_MINUTES.map((m) => (
            <Button
              key={m}
              variant="accent"
              disabled={sending}
              onClick={() => { window.callBare('haptic:tap'); ask(m) }}
              style={{ flex: 1, padding: `${spacing.md}px` }}
            >
              {m}m
            </Button>
          ))}
          <Button
            variant="secondary"
            disabled={sending}
            onClick={() => { window.callBare('haptic:tap'); setChoosing(false) }}
            style={{ padding: `${spacing.md}px` }}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          variant="accent"
          onClick={() => { window.callBare('haptic:tap'); setChoosing(true) }}
          style={{ width: '100%', padding: `${spacing.md}px` }}
        >
          Ask for more screen time
        </Button>
      )}
    </Section>
  )
}

export default function ChildHome({ openDetail }) {
  const { colors, typography, spacing, radius } = useTheme()
  const [homeData, setHomeData] = useState(null)
  const [detail, setDetail] = useState(null) // 'blocked' | 'pending' | 'requests' | null
  const [status, setStatus] = useState(null)

  const loadHomeData = useCallback(() => {
    window.callBare('child:homeData').then(setHomeData).catch(() => {})
  }, [])

  // The budget and per-app limits exactly as native enforcement computes them,
  // so the countdowns can never disagree with what actually blocks.
  const loadStatus = useCallback(() => {
    window.callBare('screentime:status').then(setStatus).catch(() => {})
  }, [])

  useEffect(() => {
    loadStatus()
    const unsub = window.onBareEvent('screentime:granted', loadStatus)
    const timer = setInterval(loadStatus, 30000)
    return () => { unsub(); clearInterval(timer) }
  }, [loadStatus])

  useEffect(() => {
    loadHomeData()
    const unsubs = [
      window.onBareEvent('policy:updated', loadHomeData),
      window.onBareEvent('override:granted', loadHomeData),
      window.onBareEvent('request:updated', loadHomeData),
      window.onBareEvent('request:submitted', loadHomeData),
      window.onBareEvent('screentime:granted', loadHomeData),
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
      <div data-tour-id="child-home-tiles" style={{ display: 'flex', gap: `${spacing.md}px` }}>
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

      {/* The three limit sections always render, saying so when nothing is set,
          so the child sees a stable list instead of cards that come and go. */}
      <ScreenTimeSection
        hasLimit={homeData.hasScreenTimeLimit}
        pending={homeData.generalTimeRequestPending}
        exemptAppNames={homeData.screenTimeExemptAppNames || []}
        screenTime={status && status.screenTime}
        onSubmitted={loadHomeData}
        colors={colors} typography={typography} spacing={spacing} radius={radius}
      />

      <BedtimeSection
        nextSchedule={homeData.nextSchedule}
        colors={colors} typography={typography} spacing={spacing} radius={radius}
      />

      <AppLimitsSection
        appLimits={(status && status.appLimits) || []}
        colors={colors} typography={typography} spacing={spacing} radius={radius}
      />

      {/* Active overrides — conditional, unlike the sections above: it's a
          transient state, not a rule that can be "unset". */}
      {homeData.activeOverrides.length > 0 && (
        <Section title="Active overrides" colors={colors} typography={typography} spacing={spacing}>
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
        </Section>
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
