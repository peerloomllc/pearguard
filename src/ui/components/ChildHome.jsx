import React, { useState, useEffect, useCallback } from 'react'

const STATUS = {
  GOOD: 'good',
  BEDTIME: 'bedtime',
  OFFLINE: 'offline',
  LOADING: 'loading',
}

function statusLabel(status) {
  switch (status) {
    case STATUS.GOOD: return 'All good'
    case STATUS.BEDTIME: return 'Bedtime mode'
    case STATUS.OFFLINE: return 'Enforcement offline'
    default: return 'Loading...'
  }
}

function timeRemaining(expiresAt) {
  const diff = Math.max(0, expiresAt - Date.now())
  const mins = Math.ceil(diff / 60000)
  if (mins >= 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm'
  return mins + 'm'
}

export default function ChildHome() {
  const [status, setStatus] = useState(STATUS.LOADING)
  const [scheduleLabel, setScheduleLabel] = useState(null)
  const [homeData, setHomeData] = useState(null)

  const loadHomeData = useCallback(() => {
    window.callBare('child:homeData').then(setHomeData).catch(() => {})
  }, [])

  useEffect(() => {
    let isMounted = true

    window.callBare('policy:getCurrent').then(({ policy }) => {
      if (!isMounted) return
      setStatus(policy ? STATUS.GOOD : STATUS.GOOD)
    })

    loadHomeData()

    function onPearEvent(event) {
      if (!isMounted) return
      const { name, data } = event.detail
      if (name === 'enforcement:offline') setStatus(STATUS.OFFLINE)
      if (name === 'policy:updated') { setStatus(STATUS.GOOD); loadHomeData() }
      if (name === 'enforcement:status') {
        if (data.scheduleActive) {
          setStatus(STATUS.BEDTIME)
          setScheduleLabel(data.scheduleLabel || 'Bedtime mode')
        } else {
          setStatus(STATUS.GOOD)
        }
      }
      if (name === 'override:granted' || name === 'request:updated' || name === 'request:submitted') {
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

  const isOffline = status === STATUS.OFFLINE

  return (
    <div style={styles.container}>
      {/* Status card */}
      <div style={{ ...styles.statusCard, backgroundColor: isOffline ? '#FFEDED' : status === STATUS.BEDTIME ? '#FFF8E1' : '#EDFFF2', borderColor: isOffline ? '#FF4444' : status === STATUS.BEDTIME ? '#FFB300' : '#44CC66' }}>
        <h2 style={{ color: isOffline ? '#CC0000' : status === STATUS.BEDTIME ? '#E65100' : '#007733', margin: 0 }}>
          {statusLabel(status)}
        </h2>
        {status === STATUS.BEDTIME && scheduleLabel && (
          <p style={{ marginTop: 8, color: '#555' }}>{scheduleLabel}</p>
        )}
        {isOffline && (
          <p style={{ marginTop: 8, color: '#CC0000' }}>
            Parental controls are not active. Ask a parent to re-enable accessibility access.
          </p>
        )}
      </div>

      {homeData && (
        <>
          {/* Summary row */}
          <div style={styles.summaryRow}>
            <div style={styles.statBox}>
              <div style={styles.statNum}>{homeData.blockedCount}</div>
              <div style={styles.statLabel}>Blocked</div>
            </div>
            <div style={styles.statBox}>
              <div style={styles.statNum}>{homeData.pendingCount}</div>
              <div style={styles.statLabel}>Awaiting approval</div>
            </div>
            <div style={styles.statBox}>
              <div style={styles.statNum}>{homeData.pendingRequests}</div>
              <div style={styles.statLabel}>Pending requests</div>
            </div>
          </div>

          {/* Active overrides */}
          {homeData.activeOverrides.length > 0 && (
            <div style={styles.section}>
              <h3 style={styles.sectionHead}>Active overrides</h3>
              {homeData.activeOverrides.map((o, i) => (
                <div key={i} style={styles.overrideRow}>
                  <div>
                    <div style={styles.overrideName}>{o.appName}</div>
                    <div style={styles.overrideSource}>
                      {o.source === 'parent-approved' ? 'Granted by parent' : 'PIN override'}
                    </div>
                  </div>
                  <div style={styles.overrideTime}>{timeRemaining(o.expiresAt)} left</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

const styles = {
  container: { padding: 24 },
  statusCard: {
    padding: 20,
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'solid',
  },
  summaryRow: {
    display: 'flex',
    gap: 12,
    marginTop: 20,
  },
  statBox: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#F5F5F5',
    textAlign: 'center',
  },
  statNum: { fontSize: 22, fontWeight: '700', color: '#333' },
  statLabel: { fontSize: 11, color: '#888', marginTop: 4 },
  section: { marginTop: 24 },
  sectionHead: { fontSize: 15, fontWeight: '700', marginBottom: 10, color: '#333' },
  overrideRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '12px 14px',
    marginBottom: 8,
    borderRadius: 8,
    backgroundColor: '#F0F7FF',
    border: '1px solid #D0E3FF',
  },
  overrideName: { fontWeight: '600', fontSize: 14 },
  overrideSource: { fontSize: 12, color: '#888', marginTop: 2 },
  overrideTime: { fontSize: 13, fontWeight: '600', color: '#1a73e8' },
}
