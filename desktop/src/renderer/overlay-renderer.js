// Renderer for the blocking overlay. Talks to the main process through the
// preload-exposed `window.overlay` bridge — no node access here.

const els = {
  appName: document.getElementById('app-name'),
  reason: document.getElementById('reason'),
  main: document.getElementById('main-actions'),
  time: document.getElementById('time-actions'),
  timeGrid: document.getElementById('time-grid'),
  timeStatus: document.getElementById('time-status'),
  timeBack: document.getElementById('time-back'),
  pin: document.getElementById('pin-actions'),
  pinInput: document.getElementById('pin-input'),
  pinSubmit: document.getElementById('btn-pin-submit'),
  pinStatus: document.getElementById('pin-status'),
  pinBack: document.getElementById('pin-back'),
  pinDuration: document.getElementById('pin-duration-actions'),
  pinDurationGrid: document.getElementById('pin-duration-grid'),
  pinDurationStatus: document.getElementById('pin-duration-status'),
  pinDurationBack: document.getElementById('pin-duration-back'),
  btnRequest: document.getElementById('btn-request'),
  btnPin: document.getElementById('btn-pin'),
}

// Time-request grid defaults (asking parent for more time).
const DEFAULT_TIME_OPTIONS = [15, 30, 60, 120]
let current = null  // { packageName, appName, reason, category, timeRequestMinutes? }

function showView(view) {
  els.main.classList.toggle('hidden', view !== 'main')
  els.time.classList.toggle('hidden', view !== 'time')
  els.pin.classList.toggle('hidden', view !== 'pin')
  els.pinDuration.classList.toggle('hidden', view !== 'pin-duration')
  if (view === 'pin') {
    els.pinInput.value = ''
    els.pinStatus.textContent = ''
    els.pinStatus.className = 'status'
    setTimeout(() => els.pinInput.focus(), 50)
  }
  if (view === 'time') {
    els.timeStatus.textContent = ''
    els.timeStatus.className = 'status'
  }
  if (view === 'pin-duration') {
    els.pinDurationStatus.textContent = ''
    els.pinDurationStatus.className = 'status'
  }
}

function renderTimeGrid(minutes) {
  els.timeGrid.innerHTML = ''
  // A screen-time block means the shared daily budget is spent, not that this one
  // app is restricted — ask for general time so the parent tops the budget up
  // instead of granting a per-app override (#179). Mirrors AppBlockerModule.
  const requestType = current && current.category === 'screen_time' ? 'general_time' : 'extra_time'
  for (const m of minutes) {
    const btn = document.createElement('button')
    btn.textContent = m + ' min'
    btn.addEventListener('click', () => sendTimeRequest(m * 60, requestType))
    els.timeGrid.appendChild(btn)
  }
}

function sendTimeRequest(extraSeconds, requestType) {
  if (!current) return
  for (const b of els.timeGrid.querySelectorAll('button')) b.disabled = true
  els.btnRequest.disabled = true
  els.timeStatus.textContent = 'Sending request...'
  els.timeStatus.className = 'status'
  window.overlay.requestTime({
    packageName: current.packageName,
    appName: current.appName,
    requestType,
    extraSeconds,
  })
}

function sendApprovalRequest() {
  if (!current) return
  els.btnRequest.disabled = true
  window.overlay.requestTime({
    packageName: current.packageName,
    appName: current.appName,
    requestType: 'approval',
  })
}

function configureForCategory(category, packageName) {
  // 'lock' has no recovery — parent must unlock from their device.
  if (category === 'lock') {
    els.btnRequest.classList.add('hidden')
    els.btnPin.classList.add('hidden')
    return
  }
  // Unmapped exes (no packageName) can't be granted an override — the override
  // store keys by packageName — and the parent's request list won't render an
  // entry without one. Hide both actions so the kid isn't presented with
  // controls that can't actually unlock the app.
  if (!packageName) {
    els.btnRequest.classList.add('hidden')
    els.btnPin.classList.add('hidden')
    return
  }
  els.btnRequest.classList.remove('hidden')
  els.btnPin.classList.remove('hidden')

  // Status blocks (blocked / pending) need parent approval, not a time grant.
  if (category === 'status') {
    els.btnRequest.textContent = 'Request Approval'
  } else {
    els.btnRequest.textContent = 'Request More Time'
  }
}

window.overlay.onPayload((payload) => {
  current = payload
  els.appName.textContent = payload.appName || 'App blocked'
  els.reason.textContent = payload.reason || 'This app is blocked.'
  configureForCategory(payload.category, payload.packageName)
  renderTimeGrid(payload.timeRequestMinutes || DEFAULT_TIME_OPTIONS)
  showView('main')
})

window.overlay.onTimeRequestResult((result) => {
  if (result.ok) {
    els.timeStatus.textContent = 'Request sent. Waiting for parent.'
    els.timeStatus.className = 'status ok'
  } else {
    els.timeStatus.textContent = result.error || 'Request failed.'
    els.timeStatus.className = 'status error'
    els.btnRequest.disabled = false
    for (const b of els.timeGrid.querySelectorAll('button')) b.disabled = false
  }
})

// Mirrors formatLockRemaining in enforcement/pin-lockout.js. The renderer can't
// require() into the enforcement tree, so the format is duplicated here.
function formatLockRemaining(ms) {
  const totalSeconds = Math.ceil(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (hours > 0) return `${hours}h ${pad(minutes)}m`
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`
  return `${seconds}s`
}

let pinLockTimer = null

// Cosmetic only — the main process re-checks the lockout on every submit, so a
// child who tampers with the renderer gains nothing by clearing this early.
function startPinLockCountdown(retryAfterMs) {
  if (pinLockTimer) clearInterval(pinLockTimer)
  let remaining = retryAfterMs
  els.pinInput.value = ''
  els.pinInput.disabled = true
  els.pinSubmit.disabled = true

  const render = () => {
    els.pinStatus.textContent = 'Too many attempts. Try again in ' + formatLockRemaining(remaining) + '.'
    els.pinStatus.className = 'status error'
  }
  render()

  pinLockTimer = setInterval(() => {
    remaining -= 1000
    if (remaining <= 0) {
      clearInterval(pinLockTimer)
      pinLockTimer = null
      els.pinInput.disabled = false
      els.pinSubmit.disabled = false
      els.pinStatus.textContent = ''
      els.pinStatus.className = 'status'
      els.pinInput.focus()
      return
    }
    render()
  }, 1000)
}

window.overlay.onPinVerifyResult((result) => {
  if (result.ok) {
    if (pinLockTimer) { clearInterval(pinLockTimer); pinLockTimer = null }
    renderPinDurationGrid(result.durationSeconds)
    showView('pin-duration')
  } else if (result.locked) {
    startPinLockCountdown(result.retryAfterMs)
  } else {
    els.pinStatus.textContent = result.error || 'Wrong PIN.'
    els.pinStatus.className = 'status error'
    els.pinSubmit.disabled = false
    els.pinInput.value = ''
    els.pinInput.focus()
  }
})

window.overlay.onPinOverrideResult((result) => {
  if (result.ok) {
    els.pinDurationStatus.textContent = 'Unlocked.'
    els.pinDurationStatus.className = 'status ok'
  } else {
    els.pinDurationStatus.textContent = result.error || 'Could not apply override.'
    els.pinDurationStatus.className = 'status error'
    for (const b of els.pinDurationGrid.querySelectorAll('button')) b.disabled = false
  }
})

function renderPinDurationGrid(seconds) {
  els.pinDurationGrid.innerHTML = ''
  const options = Array.isArray(seconds) && seconds.length ? seconds : [900, 1800, 3600, 7200]
  for (const s of options) {
    const btn = document.createElement('button')
    btn.textContent = formatDuration(s)
    btn.addEventListener('click', () => sendPinOverride(s))
    els.pinDurationGrid.appendChild(btn)
  }
}

function formatDuration(seconds) {
  const mins = Math.round(seconds / 60)
  if (mins >= 60 && mins % 60 === 0) {
    const h = mins / 60
    return h + (h === 1 ? ' hour' : ' hours')
  }
  return mins + ' min'
}

function sendPinOverride(durationSeconds) {
  if (!current) return
  for (const b of els.pinDurationGrid.querySelectorAll('button')) b.disabled = true
  els.pinDurationStatus.textContent = 'Applying...'
  els.pinDurationStatus.className = 'status'
  window.overlay.applyPinOverride({
    packageName: current.packageName,
    durationSeconds,
  })
}

els.btnRequest.addEventListener('click', () => {
  if (current && current.category === 'status') {
    sendApprovalRequest()
  } else {
    showView('time')
  }
})

els.btnPin.addEventListener('click', () => showView('pin'))
els.timeBack.addEventListener('click', () => showView('main'))
els.pinBack.addEventListener('click', () => showView('main'))
els.pinDurationBack.addEventListener('click', () => showView('main'))

els.pinSubmit.addEventListener('click', () => {
  const pin = (els.pinInput.value || '').trim()
  if (!pin) {
    els.pinStatus.textContent = 'Enter the PIN.'
    els.pinStatus.className = 'status error'
    return
  }
  els.pinSubmit.disabled = true
  els.pinStatus.textContent = 'Verifying...'
  els.pinStatus.className = 'status'
  window.overlay.verifyPin({ pin, packageName: current && current.packageName })
})

els.pinInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.pinSubmit.click()
})

// Swallow Alt+F4 at the renderer level so Chromium doesn't translate it into
// a WM_CLOSE the main process never sees. Paired with the close-event veto in
// overlay.js for defense in depth.
window.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'F4') {
    e.preventDefault()
    e.stopPropagation()
  }
}, true)
