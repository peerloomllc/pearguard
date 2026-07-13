const fs = require('fs')
const path = require('path')

// Tracks per-package foreground time for the Windows child client. Mirrors the
// shape of Android's UsageStatsModule but driven by the Electron-side
// ForegroundMonitor instead of UsageEvents.
//
// Accrual model: the tracker holds one active session at a time. When the
// foreground package changes, the previous session's elapsed time is folded
// into daily and weekly counters. Reads virtually extend the active session to
// "now" so getDailyUsageSeconds returns up-to-date numbers without waiting for
// the next foreground change.
//
// Rollovers are resolved lazily on any accrue/read. Daily counters zero at
// local midnight; weekly counters zero at Sunday 00:00 local. Note: Android's
// getWeeklyUsageAll now returns a rolling-7-day window (midnight of today-6 to now);
// the Windows tracker still reports "since Sunday" until per-day buckets are
// added. Affects the Usage tab "Last 7 days: …" label for Windows children.
// How long the tracker will keep extending an open session without a fresh
// observation from the foreground monitor. The monitor polls every 1s, so this
// tolerates ~15 missed polls (a slow active-win call, GC pause, heavy load)
// while bounding the damage from a genuine observation gap to a few seconds.
const DEFAULT_MAX_OBSERVATION_GAP_MS = 15000

class UsageTracker {
  constructor({
    filePath = null,
    now = () => Date.now(),
    logger = console,
    maxObservationGapMs = DEFAULT_MAX_OBSERVATION_GAP_MS,
  } = {}) {
    this._filePath = filePath
    this._now = now
    this._logger = logger
    this._maxObservationGapMs = maxObservationGapMs

    const t = now()
    this._dayStart = localDayStart(t)
    this._weekStart = localWeekStart(t)
    this._daily = new Map()    // packageName -> seconds
    this._weekly = new Map()   // packageName -> seconds

    // Active session state. `pkg` is null when the foreground isn't mapped or
    // nothing has been reported yet. `appName` is remembered so takeSessions()
    // can attach a display name even if the policy entry lags.
    this._activePkg = null
    this._activeAppName = null
    this._activeStartedAt = null   // ms

    // Wall-clock of the last time the monitor actually observed the foreground.
    // Reads virtually extend the active session to "now", so without this the
    // tracker cannot tell "the app is still open" from "we stopped looking".
    // A suspended machine, a locked screen or a stalled poll loop would credit
    // the entire unobserved gap as foreground usage (hours, overnight).
    this._lastObservedAt = null

    // Display-name cache so getDailyUsageAll can surface a friendly name even
    // after the kid switches away from the app (the active session's appName
    // vanishes once the session closes).
    this._appNames = new Map()

    // Buffered sessions since the last takeSessions() call.
    this._sessions = []

    this._lastForegroundPkg = null

    if (filePath) this._load()
  }

  // --- Foreground events ---------------------------------------------------

  // Record that the foreground switched to this package. `packageName` may be
  // null (unmapped exe); in that case we close any active session and record
  // no new one, but still remember the exe for diagnostics.
  noteForeground({ packageName, appName = null, ts = this._now() }) {
    this._syncTo(ts)
    this._closeActive(ts)
    if (packageName) {
      this._openActive(packageName, appName, ts)
    } else {
      this._lastForegroundPkg = null
    }
    this._lastObservedAt = ts
  }

  // Heartbeat from the foreground monitor, fired on EVERY poll rather than only
  // when the focused app changes. This is what lets the tracker distinguish "the
  // app is still in the foreground" from "we stopped observing" — see
  // _closeStaleSession. `packageName` is null when nothing mapped is focused
  // (locked screen, screen off, unmapped exe), which closes the active session.
  noteObserved({ packageName = null, appName = null, ts = this._now() } = {}) {
    this._syncTo(ts)
    if (!packageName) {
      // Nothing focused we can attribute time to — stop accruing.
      if (this._activePkg) this._closeActive(ts)
      this._lastForegroundPkg = null
    } else if (this._activePkg == null) {
      // The stale guard (or a lock) closed the session while the app stayed
      // focused. Resume accrual now instead of waiting for the kid to switch
      // apps — foreground-changed only fires on a *change*, so nothing else
      // would ever reopen it.
      this._openActive(packageName, appName, ts)
    } else if (this._activePkg !== packageName) {
      // Defensive: monitor and tracker disagree about what's focused.
      this._closeActive(ts)
      this._openActive(packageName, appName, ts)
    }
    this._lastObservedAt = ts
  }

  // Close the in-flight session (used on app quit / flush-on-exit, and on
  // system suspend / screen lock so the boundary is exact rather than relying
  // on the stale-observation guard). Idempotent.
  endActive(ts = this._now()) {
    this._syncTo(ts)
    this._closeActive(ts)
    this._persist()
  }

  // --- Reads ---------------------------------------------------------------

  // Return today's seconds for one package, inclusive of the in-flight
  // session. Used by block-evaluator's getUsageSeconds callback.
  getDailyUsageSeconds(packageName) {
    if (!packageName) return 0
    const ts = this._now()
    this._syncTo(ts)
    const stored = this._daily.get(packageName) || 0
    if (this._activePkg === packageName && this._activeStartedAt != null) {
      return stored + secondsBetween(this._activeStartedAt, ts)
    }
    return stored
  }

  // [{ packageName, appName, secondsToday }] — appName is best-effort.
  getDailyUsageAll() {
    const ts = this._now()
    this._syncTo(ts)
    const out = []
    // Fold the active session so in-flight time is reflected.
    const active = this._activePkg
    for (const [pkg, seconds] of this._daily.entries()) {
      let secondsToday = seconds
      if (pkg === active && this._activeStartedAt != null) {
        secondsToday += secondsBetween(this._activeStartedAt, ts)
      }
      out.push({ packageName: pkg, appName: this._displayName(pkg), secondsToday })
    }
    if (active && !this._daily.has(active) && this._activeStartedAt != null) {
      out.push({
        packageName: active,
        appName: this._displayName(active),
        secondsToday: secondsBetween(this._activeStartedAt, ts),
      })
    }
    return out
  }

  // [{ packageName, secondsThisWeek }].
  getWeeklyUsageAll() {
    const ts = this._now()
    this._syncTo(ts)
    const out = []
    const active = this._activePkg
    for (const [pkg, seconds] of this._weekly.entries()) {
      let secondsThisWeek = seconds
      if (pkg === active && this._activeStartedAt != null) {
        secondsThisWeek += secondsBetween(this._activeStartedAt, ts)
      }
      out.push({ packageName: pkg, secondsThisWeek })
    }
    if (active && !this._weekly.has(active) && this._activeStartedAt != null) {
      out.push({ packageName: active, secondsThisWeek: secondsBetween(this._activeStartedAt, ts) })
    }
    return out
  }

  // Drain the sessions buffer. Mirrors
  // NativeModules.UsageStatsModule.getSessionsSinceLastFlush() — each entry is
  // { packageName, displayName, startedAt, endedAt, durationSeconds }. The
  // active session is closed at `now` and re-opened with the same package so
  // it continues to accrue.
  takeSessions() {
    const ts = this._now()
    this._syncTo(ts)
    // Snapshot an in-flight session into the buffer, then restart it so
    // accrual continues against the same package.
    if (this._activePkg && this._activeStartedAt != null && this._activeStartedAt < ts) {
      this._pushSession(this._activePkg, this._activeAppName, this._activeStartedAt, ts)
      this._foldSeconds(this._activePkg, secondsBetween(this._activeStartedAt, ts))
      this._activeStartedAt = ts
      this._persist()
    }
    const out = this._sessions
    this._sessions = []
    return out
  }

  getLastForegroundPackage() {
    return this._lastForegroundPkg
  }

  // --- Internals -----------------------------------------------------------

  _openActive(packageName, appName, ts) {
    this._activePkg = packageName
    this._activeAppName = appName
    this._activeStartedAt = ts
    this._lastForegroundPkg = packageName
    if (appName) this._appNames.set(packageName, appName)
  }

  // Bring tracker state up to `ts` before any read or accrual. Order matters:
  // a stale session has to be retired at the time it actually ended (which may
  // be in a previous day) BEFORE rollovers advance the day/week windows,
  // otherwise its seconds would land in the wrong bucket — or be wiped.
  _syncTo(ts) {
    this._closeStaleSession(ts)
    this._resolveRollovers(ts)
  }

  // The monitor stopped reporting for longer than the grace window: the machine
  // suspended, the screen locked, or the poll loop stalled/crashed. Whatever the
  // cause, we did not observe the foreground during that gap, so we cannot claim
  // the app was being used. Close the session at the last observation instead of
  // letting reads extend it to `now` — that extension is what turned an
  // overnight sleep into ~8h of phantom usage (and blew through screen-time
  // limits, since block-evaluator reads the same counters).
  _closeStaleSession(ts) {
    if (!this._activePkg || this._activeStartedAt == null) return
    if (this._lastObservedAt == null) return
    if (ts - this._lastObservedAt <= this._maxObservationGapMs) return

    const end = Math.max(this._lastObservedAt, this._activeStartedAt)
    const pkg = this._activePkg
    // Roll over relative to when the session ENDED, so a session that died
    // before midnight is credited to that day, not to today.
    this._resolveRollovers(end)
    this._closeActive(end)
    if (this._logger && typeof this._logger.log === 'function') {
      this._logger.log(
        '[usage-tracker] closed stale session for', pkg,
        '- unobserved for', Math.round((ts - this._lastObservedAt) / 1000), 's (suspend/lock/stall)'
      )
    }
  }

  _closeActive(ts) {
    if (!this._activePkg || this._activeStartedAt == null) {
      this._activePkg = null
      this._activeAppName = null
      this._activeStartedAt = null
      return
    }
    const startedAt = this._activeStartedAt
    if (startedAt < ts) {
      this._foldSeconds(this._activePkg, secondsBetween(startedAt, ts))
      this._pushSession(this._activePkg, this._activeAppName, startedAt, ts)
    }
    this._activePkg = null
    this._activeAppName = null
    this._activeStartedAt = null
    this._persist()
  }

  _foldSeconds(packageName, seconds) {
    if (seconds <= 0) return
    this._daily.set(packageName, (this._daily.get(packageName) || 0) + seconds)
    this._weekly.set(packageName, (this._weekly.get(packageName) || 0) + seconds)
  }

  // Emit the same shape as Android's UsageStatsModule so parent-side
  // aggregations (usage:getCategorySummary, usage:getDailySummaries) that sum
  // durationSeconds and read displayName work identically across platforms.
  _pushSession(packageName, appName, startedAt, endedAt) {
    this._sessions.push({
      packageName,
      displayName: appName || null,
      startedAt,
      endedAt,
      durationSeconds: secondsBetween(startedAt, endedAt),
    })
  }

  // If the current wall clock crossed a local midnight or Sunday boundary
  // since our last recorded dayStart/weekStart, flush the active session into
  // the old window, then reset. Handles multi-day gaps by zeroing both maps.
  _resolveRollovers(ts) {
    const today = localDayStart(ts)
    const thisWeek = localWeekStart(ts)
    if (today === this._dayStart && thisWeek === this._weekStart) return
    // Never roll *backwards*. _closeStaleSession replays a past timestamp to
    // retire a session in the window it actually ended in, and a user-rolled
    // clock can also move time back; in neither case should we zero the
    // counters (that would hand the kid a fresh budget).
    if (today < this._dayStart || thisWeek < this._weekStart) return

    // If a session is open across the boundary, split it: credit time up to
    // the boundary to the old window, then restart the session at the
    // boundary so time after the boundary lands in the new window.
    const boundary = Math.min(
      today !== this._dayStart ? today : Infinity,
      thisWeek !== this._weekStart ? thisWeek : Infinity,
    )
    if (this._activePkg && this._activeStartedAt != null && this._activeStartedAt < boundary && boundary <= ts) {
      const seconds = secondsBetween(this._activeStartedAt, boundary)
      if (seconds > 0) {
        this._daily.set(this._activePkg, (this._daily.get(this._activePkg) || 0) + seconds)
        this._weekly.set(this._activePkg, (this._weekly.get(this._activePkg) || 0) + seconds)
      }
      this._pushSession(this._activePkg, this._activeAppName, this._activeStartedAt, boundary)
      this._activeStartedAt = boundary
    }

    if (today !== this._dayStart) {
      this._daily = new Map()
      this._dayStart = today
    }
    if (thisWeek !== this._weekStart) {
      this._weekly = new Map()
      this._weekStart = thisWeek
    }
    this._persist()
  }

  _displayName(pkg) {
    if (this._activePkg === pkg && this._activeAppName) return this._activeAppName
    return this._appNames.get(pkg) || null
  }

  _load() {
    try {
      if (!fs.existsSync(this._filePath)) return
      const raw = fs.readFileSync(this._filePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return
      const ts = this._now()
      const today = localDayStart(ts)
      const thisWeek = localWeekStart(ts)
      if (typeof parsed.dayStart === 'number' && parsed.dayStart === today) {
        this._daily = new Map(Object.entries(parsed.daily || {}).filter(([, v]) => typeof v === 'number' && v > 0))
      }
      if (typeof parsed.weekStart === 'number' && parsed.weekStart === thisWeek) {
        this._weekly = new Map(Object.entries(parsed.weekly || {}).filter(([, v]) => typeof v === 'number' && v > 0))
      }
      this._dayStart = today
      this._weekStart = thisWeek
    } catch (e) {
      this._logger.error('[usage-tracker] load failed:', e.message)
    }
  }

  _persist() {
    if (!this._filePath) return
    try {
      const dir = path.dirname(this._filePath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const payload = {
        dayStart: this._dayStart,
        weekStart: this._weekStart,
        daily: Object.fromEntries(this._daily),
        weekly: Object.fromEntries(this._weekly),
      }
      fs.writeFileSync(this._filePath, JSON.stringify(payload))
    } catch (e) {
      this._logger.error('[usage-tracker] persist failed:', e.message)
    }
  }
}

function localDayStart(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function localWeekStart(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())  // Sunday
  return d.getTime()
}

function secondsBetween(start, end) {
  if (end <= start) return 0
  return Math.floor((end - start) / 1000)
}

module.exports = { UsageTracker, localDayStart, localWeekStart }
