import React, { useState, useEffect } from 'react'

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

export default function ChildHome() {
  const [status, setStatus] = useState(STATUS.LOADING)
  const [scheduleLabel, setScheduleLabel] = useState(null)

  useEffect(() => {
    let isMounted = true

    window.callBare('policy:getCurrent').then(({ policy }) => {
      if (!isMounted) return
      if (!policy) {
        setStatus(STATUS.GOOD)
        return
      }
      setStatus(STATUS.GOOD)
    })

    function onPearEvent(event) {
      if (!isMounted) return
      const { name, data } = event.detail
      if (name === 'enforcement:offline') {
        setStatus(STATUS.OFFLINE)
      }
      if (name === 'policy:updated') {
        setStatus(STATUS.GOOD)
      }
      if (name === 'enforcement:status') {
        if (data.scheduleActive) {
          setStatus(STATUS.BEDTIME)
          setScheduleLabel(data.scheduleLabel || 'Bedtime mode')
        } else {
          setStatus(STATUS.GOOD)
        }
      }
    }

    window.addEventListener('__pearEvent', onPearEvent)
    return () => {
      isMounted = false
      window.removeEventListener('__pearEvent', onPearEvent)
    }
  }, [])

  const isOffline = status === STATUS.OFFLINE

  return (
    <div style={{ padding: 24 }}>
      <div
        style={{
          padding: 20,
          borderRadius: 12,
          backgroundColor: isOffline ? '#FFEDED' : '#EDFFF2',
          borderWidth: 1,
          borderColor: isOffline ? '#FF4444' : '#44CC66',
          borderStyle: 'solid',
        }}
      >
        <h2 style={{ color: isOffline ? '#CC0000' : '#007733', margin: 0 }}>
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
    </div>
  )
}
