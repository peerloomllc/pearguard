// src/bare-dispatch.js
//
// Pure method dispatch table for the Bare worklet.
// Separated from IPC wiring so it can be unit tested in Node/jest.
// src/bare.js imports this and wires it to BareKit.IPC.

// Gated by the host on init (see src/log.js); warn/error stay unconditional.
const { log } = require('./log')
const { nextScheduleWindow } = require('./policy')
const { validatePin } = require('./pin-rules')
const { describeBypassReason } = require('./bypass-reasons')
const { pendingUninstalls } = require('./package-reconcile')

// One write at a time per child's policy record on the parent.
//
// Every parent-side handler that touches policy:{child} is a read-modify-write
// with awaits in between, and several of them fire together: the child's
// apps:sync relay and its app:installed relay for the same install, a settings
// save while a child reports an app, an approve tap while a sync lands. Without
// this, the later writer's stale read discarded the earlier writer's apps and
// pushed that regressed copy to the child (2026-09-03: two handlers each wrote an
// alert and an approval card for the same package at the same second, and one
// of them dropped the app the other had added). Callers wrap the whole
// read-modify-write, and re-read inside the lock rather than reuse a value
// fetched before it.
// How long an undelivered extra-time grant stays worth delivering. The child
// only starts its window when the grant arrives, so an offline child must still
// get the full grant on reconnect; past this the grant is stale (yesterday's
// 15-minute ask) and handing it over would surprise everyone.
const UNDELIVERED_GRANT_MAX_AGE_MS = 24 * 60 * 60 * 1000

// How long a request the child raised waits for an answer before it stops
// counting as outstanding. A pending request is not free: it disables the child's
// "ask for more time" button (child:homeData -> generalTimeRequestPending) and
// dedupes further asks about the same app, and both prunes then DELETED it at 7
// days regardless of status. So a parent who simply never looked left the child
// unable to ask again for a week, after which the question disappeared with no
// answer either way. A day is long enough for a parent to get to their phone and
// short enough that the child is not stuck waiting on a question nobody will
// answer.
const REQUEST_ANSWER_WINDOW_MS = 24 * 60 * 60 * 1000

const policyLocks = new Map()
function withPolicyLock (childPublicKey, fn) {
  const key = String(childPublicKey)
  const prev = policyLocks.get(key) || Promise.resolve()
  const run = prev.then(fn, fn)
  const settled = run.then(() => {}, () => {})
  policyLocks.set(key, settled)
  settled.then(() => { if (policyLocks.get(key) === settled) policyLocks.delete(key) })
  return run
}

// Dispatch methods whose whole body is a read-modify-write of one child's policy.
// createDispatch runs these under withPolicyLock keyed on the child in args.
const POLICY_WRITE_METHODS = new Set([
  'app:decide', 'apps:decideBatch', 'policy:update', 'policy:setLock', 'policy:setPause',
  'rules:import:apply', 'child:unpair',
])

// Return YYYY-MM-DD in local time (not UTC) so session date keys
// match the user's calendar day regardless of timezone.
function localDateStr(ts) {
  const d = new Date(ts || Date.now())
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/**
 * The same date, but in a zone that is `offsetMinutes` from UTC.
 *
 * A day of screen time belongs to the CHILD's calendar: it is their evening, and
 * it is their midnight that resets the daily budget. The parent may be in a
 * different zone, so it cannot use its own clock to decide which day a child's
 * usage lands on. `offsetMinutes` is what `new Date().getTimezoneOffset()`
 * returns on the child, negated, i.e. UTC+2 is +120.
 *
 * With no offset this is exactly localDateStr, so every caller that has not been
 * told the child's zone behaves as it always did.
 */
function dateStrInZone(ts, offsetMinutes) {
  if (typeof offsetMinutes !== 'number' || !Number.isFinite(offsetMinutes)) return localDateStr(ts)
  const d = new Date((ts || Date.now()) + offsetMinutes * 60000)
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
}

/**
 * The child's own UTC offset in minutes, as last reported. Parent-side.
 * Returns null when we have never been told, which every caller reads as
 * "use our own clock", the behaviour before this existed.
 */
async function childZoneOffset(db, childPublicKey) {
  const raw = await db.get('childZone:' + childPublicKey).catch(() => null)
  const off = raw && raw.value && raw.value.offsetMinutes
  return typeof off === 'number' && Number.isFinite(off) ? off : null
}

// General-time grants (#179) are stamped with the local date they were issued
// on, so they lapse at midnight and a rolled-back clock discards them rather
// than extending the budget. Mirrors bonusSecondsForToday in src/policy.js.
function bonusSecondsForToday(bonus, ts) {
  if (!bonus || typeof bonus.seconds !== 'number' || bonus.seconds <= 0) return 0
  if (bonus.date !== localDateStr(ts)) return 0
  return bonus.seconds
}

// Child side: accumulate a granted top-up into today's bonus. Stored outside
// `policy` because the parent replaces that object wholesale on every
// policy:update, which would otherwise wipe the grant.
async function applyScreenTimeBonus(db, extraSeconds, ts) {
  const today = localDateStr(ts)
  const raw = await db.get('screenTimeBonus').catch(() => null)
  const prev = raw ? raw.value : null
  const carried = bonusSecondsForToday(prev, ts)
  const bonus = { date: today, seconds: carried + extraSeconds, updatedAt: ts }
  await db.put('screenTimeBonus', bonus)
  return bonus
}

// Filter out system-level packages that aren't user-facing apps.
// Must match the UI-side isSystemPackage() filter in UsageReports.jsx.
const SYSTEM_PACKAGES = new Set([
  'com.android.launcher', 'com.android.launcher3', 'com.google.android.apps.nexuslauncher',
  'com.android.packageinstaller', 'com.google.android.packageinstaller',
  'com.android.permissioncontroller', 'com.google.android.permissioncontroller',
  'com.android.settings', 'com.android.systemui', 'com.android.vending',
  'com.android.inputmethod.latin', 'com.google.android.inputmethod.latin',
  'com.android.providers.downloads.ui', 'com.android.documentsui',
])

function isSystemPackage(pkg) {
  if (SYSTEM_PACKAGES.has(pkg)) return true
  if (pkg.startsWith('com.android.') && !pkg.startsWith('com.android.chrome')) return true
  if (pkg.includes('.launcher')) return true
  return false
}

// Parent-local per-child package exclusion list. Hidden packages are filtered
// out of Dashboard totals, the Usage tab list, and Usage Reports. Storage only
// persists the packages the user explicitly hid — the set is empty by default.
async function getExclusions(db, childPublicKey) {
  if (!db || !childPublicKey) return new Set()
  const raw = await db.get('usageExclusions:' + childPublicKey).catch(() => null)
  const map = raw?.value?.packages || {}
  const s = new Set()
  for (const pkg of Object.keys(map)) if (map[pkg]) s.add(pkg)
  return s
}

// Apply an exclusion set to a usage report payload, stripping hidden packages
// from apps and sessions and recomputing the per-day total so every consumer
// (Dashboard event, usage:getLatest response, children:list) sees one number.
function applyExclusionsToReport(report, exclusions) {
  if (!report || !exclusions || exclusions.size === 0) return report
  const apps = Array.isArray(report.apps) ? report.apps.filter((a) => !exclusions.has(a.packageName)) : report.apps
  const sessions = Array.isArray(report.sessions) ? report.sessions.filter((s) => !exclusions.has(s.packageName)) : report.sessions
  const todayScreenTimeSeconds = Array.isArray(apps) ? apps.reduce((sum, a) => sum + (a.todaySeconds || 0), 0) : report.todayScreenTimeSeconds
  return { ...report, apps, sessions, todayScreenTimeSeconds }
}

// Re-derive an alert's parent-facing label and type from its `reason`.
//
// Applied on read so alerts already in Hyperbee are shown correctly: the rows
// written before this existed are labelled with the raw reason slug and are all
// typed 'bypass', which paints "PearGuard's extension didn't load" as a red
// Bypass Attempt by the child. describeBypassReason owns both decisions.
function relabelAlert(alert) {
  const described = describeBypassReason(alert.reason, alert.childDisplayName)
  return {
    ...alert,
    type: described.tamper ? 'bypass' : 'enforcement_off',
    appDisplayName: described.title,
    body: described.body,
  }
}

// Pick the friendliest name we have for a package.
//
// Usage rows carry whatever display name the child had to hand at flush time,
// and that is not always a name: usage:flush falls back to `appName ||
// packageName`, so a row can arrive displaying the raw slug ('linux.firefox_esr',
// 'win.notepad'). The desktop child hits this routinely because its tracker
// keeps friendly names in memory only, so every package it restores from disk
// after a restart has counters but no name.
//
// The parent never has to accept that: apps:sync already handed it
// policy.apps[pkg].appName ('Firefox ESR') for every installed app. Prefer the
// policy name, fall back to whatever the child sent, and only show the slug when
// neither side has anything better. Resolving at the read boundary (rather than
// rewriting rows) also fixes reports already sitting in Hyperbee.
function resolveAppName(packageName, policyName, reportedName) {
  const usable = (s) => typeof s === 'string' && s && s !== packageName
  if (usable(policyName)) return policyName
  if (usable(reportedName)) return reportedName
  return packageName
}

function applyPolicyNamesToReport(report, policyApps) {
  if (!report || !policyApps) return report
  const named = (rows) => (Array.isArray(rows)
    ? rows.map((r) => (r && r.packageName
      ? { ...r, displayName: resolveAppName(r.packageName, policyApps[r.packageName]?.appName, r.displayName) }
      : r))
    : rows)
  const out = { ...report, apps: named(report.apps), sessions: named(report.sessions) }
  if (out.currentAppPackage) {
    out.currentApp = resolveAppName(
      out.currentAppPackage,
      policyApps[out.currentAppPackage]?.appName,
      out.currentApp,
    )
  }
  return out
}

// Zero out today-scoped fields on a stored usage report if its timestamp is
// from a previous local day. The Hyperbee row is not mutated — this runs at
// the IPC read boundary so every consumer of the latest-report snapshot sees
// 0 until a new sync arrives for the current local date. `stale` is set so
// callers can distinguish "no data today yet" from "today, zero usage".
function dateGateReport(report) {
  if (!report || !report.timestamp) return report
  if (localDateStr(report.timestamp) === localDateStr()) return report
  const apps = Array.isArray(report.apps)
    ? report.apps.map((a) => ({ ...a, todaySeconds: 0 }))
    : report.apps
  return { ...report, apps, sessions: [], todayScreenTimeSeconds: 0, stale: true }
}

// Merge two session arrays, keying on (packageName, startedAt) and preferring
// the snapshot with the longest durationSeconds. Used by usage:flush on the
// child and the parent's usage:report handler so a single overwriting key per
// (child, date) can accumulate incoming sessions from either an Android full
// list or a Windows drained buffer.
function mergeSessions(existing, incoming) {
  const byKey = new Map()
  const add = (s) => {
    if (!s || !s.packageName) return
    const k = s.packageName + ':' + s.startedAt
    const prev = byKey.get(k)
    if (!prev || (s.durationSeconds || 0) > (prev.durationSeconds || 0)) byKey.set(k, s)
  }
  if (Array.isArray(existing)) for (const s of existing) add(s)
  if (Array.isArray(incoming)) for (const s of incoming) add(s)
  return Array.from(byKey.values())
}

// Delete every key under `prefix` whose value[tsField] is older than cutoffMs. Used by
// the periodic cleanup sweep to bound growth of write-only history keys that read paths
// otherwise never prune (auto-reclaim only removes tombstones, not live rows). Returns
// the number of keys removed.
async function pruneStaleKeys(db, prefix, tsField, cutoffMs) {
  let removed = 0
  for await (const { key, value } of db.createReadStream({ gt: prefix, lt: prefix + '~' })) {
    if (value && (value[tsField] || 0) < cutoffMs) {
      await db.del(key).catch(() => {})
      removed++
    }
  }
  return removed
}

// Bucket sessions by the local calendar day of each session's OWN startedAt, falling
// back to fallbackTs when a session lacks a startedAt. The parent's usage:report used
// to file every session in a flush under one key derived from the flush timestamp, so
// a session begun before local midnight (or a flush that arrived on the next day)
// landed on the wrong day, and a flush spanning midnight lumped both days together.
// Keying by startedAt matches the one-time migrateSessionDatesToLocal re-keying.
// Returns Map<'YYYY-MM-DD', session[]>.
function groupSessionsByLocalDate(sessions, fallbackTs, offsetMinutes) {
  const byDate = new Map()
  for (const s of sessions || []) {
    const ts = (s && typeof s.startedAt === 'number') ? s.startedAt : fallbackTs
    const date = dateStrInZone(ts, offsetMinutes)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push(s)
  }
  return byDate
}

// Order-independent content signature of a day's per-app totals. The parent uses
// it to skip re-writing an unchanged dailyTotals row: the child re-sends the full
// multi-day window every flush, but past-day totals are static, so a naive write
// produced thousands of redundant Hypercore appends per day. Native may return
// apps in a different order between flushes, so sort before comparing. Excludes
// updatedAt (which changes every flush) — that churn is exactly what we avoid.
function dailyTotalsSignature(apps) {
  if (!Array.isArray(apps)) return ''
  return apps
    .map(a => ((a && a.packageName) || '') + '=' + ((a && a.secondsToday) || 0) + ':' + ((a && a.displayName) || ''))
    .sort()
    .join('|')
}

// RN shells push fresh app/usage values into this cache via 'heartbeat:updateData'
// whenever the JS thread is alive. bare.js's native-thread setInterval calls
// 'heartbeat:send', which reads from this cache so heartbeats stay reliable
// even when the RN JS thread is suspended (backgrounded child on Android).
const heartbeatCache = {
  currentApp: null,
  currentAppPackage: null,
  todayScreenTimeSeconds: null,
  // { limitSeconds, bonusSeconds, usedSeconds, remainingSeconds } from native (#179)
  screenTime: null,
  // [{ packageName, appName, limitSeconds, usedSeconds, remainingSeconds }] from native
  appLimits: null,
}

/**
 * Create a dispatch function bound to the given context (db, swarm, etc.)
 * @param {object} ctx — { db, identity, swarm, peers }
 * @returns {(method: string, args: any[]) => Promise<any>}
 */
function createDispatch (ctx) {
  // Tell the child a request of theirs ran out of time: refresh whatever screen
  // they are on, and post the notification saying they can ask again.
  function announceExpired (request) {
    ctx.send({ type: 'event', event: 'request:updated', data: { requestId: request.id, packageName: request.packageName, appName: request.appName, status: 'expired' } })
    ctx.send({ method: 'native:showDecisionNotification', args: { appName: request.appName || request.packageName || 'the app', decision: 'expired' } })
  }

  async function dispatchInner (method, args) {
    switch (method) {
      case 'ping':
        return 'pong'

      case 'pref:set': {
        const { key, value } = args
        await ctx.db.put('pref:' + key, value)
        // Some prefs have a live in-memory counterpart in bare.js (the relay opt-out
        // is read synchronously per dial and cannot re-read Hyperbee). Tell it.
        if (ctx.onPrefChange) ctx.onPrefChange(key, value)
        return { ok: true }
      }

      case 'pref:get': {
        const entry = await ctx.db.get('pref:' + args.key)
        return entry ? entry.value : null
      }

      case 'setMode': {
        const newMode = args[0]
        if (newMode !== 'parent' && newMode !== 'child') {
          throw new Error('invalid mode: must be "parent" or "child"')
        }
        await ctx.db.put('mode', newMode)
        ctx.mode = newMode
        if (ctx.onModeChange) ctx.onModeChange(newMode)
        return newMode
      }

      case 'identity:getMode':
      case 'getMode': {
        const stored = await ctx.db.get('mode')
        return { mode: stored ? stored.value : null }
      }

      case 'connectToPeer': {
        // args[0]: swarmTopic (hex string)
        const topic = args[0]
        if (!topic || typeof topic !== 'string' || !/^[0-9a-f]{64}$/i.test(topic)) {
          throw new Error('invalid swarmTopic')
        }
        await ctx.joinTopic(topic)
        return { joined: true, topic }
      }

      case 'sendPeerMessage': {
        // args[0]: remoteKeyHex, args[1]: { type, payload }
        ctx.sendToPeer(args[0], args[1])
        return { sent: true }
      }

      case 'children:list': {
        // NOTE: there used to be a child-mode auto-dedup here that grouped parent
        // records by normalized displayName and db.del'd all but the "best" one
        // (#151). That silently DELETED a genuine co-parent whenever two parents
        // shared a name (or the default) — displayName is not an identity, and
        // since the swarm keyPair IS the identity (bare.js: `new Hyperswarm({
        // keyPair: identity })`), a re-paired parent gets a brand-new noiseKey
        // too, so no key-based signal can even distinguish "same parent re-paired"
        // from "different co-parent". Removed to stop the data loss.
        //
        // Consequence: a re-paired parent now leaves a visible stale entry. The
        // read-time noiseKey dedup below does NOT collapse it — that dedup only
        // merges entries that share the SAME noiseKey (handleHello races), and
        // the re-paired parent has a different noiseKey and is offline. Showing a
        // harmless duplicate is the accepted cost of never deleting a real
        // co-parent, since no reliable signal tells the two cases apart.
        const children = []
        const seenKeys = new Set()
        const seenNoiseKeys = new Set()
        let streamCount = 0
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          streamCount++
          // Skip any peer that also has a blocked: entry — stale record from a race
          // between handleHello and child:unpair.
          const isBlocked = await ctx.db.get('blocked:' + value.publicKey).catch(() => null)
          if (isBlocked) continue
          const isOnline = value.noiseKey ? ctx.peers.has(value.noiseKey) : false
          // Deduplicate: if two entries claim the same noise key, keep only the online one.
          // This guards against stale Hyperbee entries that weren't pruned by handleHello.
          if (isOnline && value.noiseKey) {
            if (seenNoiseKeys.has(value.noiseKey)) continue
            seenNoiseKeys.add(value.noiseKey)
          }
          // Merge latest usage report so Dashboard has currentApp/todayScreenTimeSeconds on mount
          let usageFields = {}
          const policyRaw = await ctx.db.get('policy:' + value.publicKey).catch(() => null)
          const policyApps = policyRaw?.value?.apps || {}
          // A timed lock that has run out reads as unlocked everywhere, without
          // anyone rewriting the policy to say so.
          const lockedField = {
            locked: isLockActive(policyRaw?.value, Date.now()),
            lockMessage: policyRaw?.value?.lockMessage || '',
            lockUntil: policyRaw?.value?.lockUntil || 0,
            pauseUntil: policyRaw?.value?.pauseUntil || 0,
          }
          // What this child has confirmed it is enforcing, against what we hold.
          // policyVersion null means we have never pushed anything, so there is
          // nothing to be behind on.
          const ackRaw = await ctx.db.get('policyAck:' + value.publicKey).catch(() => null)
          const policyVersion = typeof policyRaw?.value?.version === 'number' ? policyRaw.value.version : null
          const ackedPolicyVersion = typeof ackRaw?.value?.version === 'number' ? ackRaw.value.version : null
          const leaveRaw = await ctx.db.get('leavePending:' + value.publicKey).catch(() => null)
          const leaveField = { leaveEffectiveAt: (leaveRaw && leaveRaw.value && leaveRaw.value.effectiveAt) || 0 }
          const policySyncField = {
            policyVersion,
            ackedPolicyVersion,
            // Older children never ack, so treat "no ack at all" as unknown
            // rather than as behind: a red flag on every existing pairing would
            // be worse than saying nothing.
            policyPending: policyVersion !== null && ackedPolicyVersion !== null && ackedPolicyVersion < policyVersion,
          }
          const exclusions = await getExclusions(ctx.db, value.publicKey)
          for await (const { value: report } of ctx.db.createReadStream({
            gt: 'usageReport:' + value.publicKey + ':',
            lt: 'usageReport:' + value.publicKey + ':~',
            reverse: true,
            limit: 1,
          })) {
            const filtered = dateGateReport(applyExclusionsToReport(report, exclusions))
            // If the currently foregrounded app is excluded, drop it from the
            // Dashboard surface so the exclusion is consistent everywhere.
            const currentAppPackage = filtered.currentAppPackage && !exclusions.has(filtered.currentAppPackage)
              ? filtered.currentAppPackage
              : null
            const currentApp = currentAppPackage ? filtered.currentApp : null
            let currentAppIcon = null
            if (currentAppPackage) {
              currentAppIcon = policyApps[currentAppPackage]?.iconBase64 || null
            }
            usageFields = {
              currentApp,
              currentAppPackage,
              currentAppIcon,
              todayScreenTimeSeconds: filtered.todayScreenTimeSeconds || 0,
            }
          }
          seenKeys.add(value.publicKey)
          children.push({ ...value, isOnline, ...lockedField, ...leaveField, ...policySyncField, ...usageFields })
        }
        // Fallback: Hyperbee createReadStream range queries can miss recently-stored
        // records due to B-tree snapshot timing. Use db.get for any known peer keys
        // that the range scan missed.
        if (ctx.knownPeerKeys) {
          for (const key of ctx.knownPeerKeys) {
            if (seenKeys.has(key)) continue
            const record = await ctx.db.get('peers:' + key).catch(() => null)
            log('[bare] children:list fallback for', key.slice(0, 12), ':', record ? 'FOUND' : 'NOT FOUND',
              'streamCount=' + streamCount, 'knownKeys=' + ctx.knownPeerKeys.size)
            if (!record) { ctx.knownPeerKeys.delete(key); continue }
            const isBlocked = await ctx.db.get('blocked:' + key).catch(() => null)
            if (isBlocked) continue
            const value = record.value
            const isOnline = value.noiseKey ? ctx.peers.has(value.noiseKey) : false
            const policyRaw = await ctx.db.get('policy:' + key).catch(() => null)
            const locked = !!(policyRaw?.value?.locked)
            const lockMessage = policyRaw?.value?.lockMessage || ''
            children.push({ ...value, isOnline, locked, lockMessage })
          }
        }
        if (children.length === 0 && ctx.knownPeerKeys && ctx.knownPeerKeys.size > 0) {
          log('[bare] children:list returned 0 but knownPeerKeys has', ctx.knownPeerKeys.size, 'keys:', [...ctx.knownPeerKeys].map(k => k.slice(0, 12)).join(', '))
        }
        return children
      }

      case 'peers:hasParent': {
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          if (value) return { hasPeers: true }
        }
        return { hasPeers: false }
      }

      case 'child:unpair': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('child:unpair requires childPublicKey')

        // Get noise key and swarm topic before deleting the peer record
        const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
        const noiseKey = peerRecord?.value?.noiseKey
        const swarmTopic = peerRecord?.value?.swarmTopic

        // Write the block entry FIRST so any rapid reconnect is rejected by handleHello
        // before we destroy the connection (Hyperswarm reconnects in <1s).
        await ctx.db.put('blocked:' + childPublicKey, { childPublicKey, blockedAt: Date.now() })

        // Keep the rules before dropping them. Unpairing to clear up a glitch
        // used to throw away every schedule, limit and block with no warning and
        // no way back, and the re-paired device then looks like a first pairing,
        // so everything is auto-allowed. The child rotates its identity on
        // reset, so it returns under a NEW public key and this cannot be
        // restored automatically: the archive carries the name and date for the
        // parent to choose from (rules:archives / rules:restoreArchive).
        const outgoingPolicy = await ctx.db.get('policy:' + childPublicKey).catch(() => null)
        if (outgoingPolicy && outgoingPolicy.value && Object.keys(outgoingPolicy.value.apps || {}).length > 0) {
          const peerForName = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          await ctx.db.put('policyArchive:' + Date.now() + ':' + childPublicKey, {
            childPublicKey,
            displayName: (peerForName && peerForName.value && peerForName.value.displayName) || 'Child',
            archivedAt: Date.now(),
            policy: stripAppIcons(outgoingPolicy.value),
          })
          await pruneRuleArchives(ctx.db)
        }

        // Remove parent-side records.
        // Collect keys first, then delete — avoids deadlocking Hyperbee's internal lock
        // (createReadStream + del cannot interleave).
        await ctx.db.del('peers:' + childPublicKey).catch(() => {})
        if (ctx.knownPeerKeys) ctx.knownPeerKeys.delete(childPublicKey)
        await ctx.db.del('policy:' + childPublicKey).catch(() => {})
        const alertKeys = []
        for await (const { key } of ctx.db.createReadStream({ gt: 'alert:' + childPublicKey + ':', lt: 'alert:' + childPublicKey + ':~' })) {
          alertKeys.push(key)
        }
        for (const key of alertKeys) await ctx.db.del(key).catch(() => {})
        const usageKeys = []
        for await (const { key } of ctx.db.createReadStream({ gt: 'usageReport:' + childPublicKey + ':', lt: 'usageReport:' + childPublicKey + ':~' })) {
          usageKeys.push(key)
        }
        for (const key of usageKeys) await ctx.db.del(key).catch(() => {})
        // Remove parent-side request records for this child so a re-pair starts clean.
        const requestKeys = []
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value.childPublicKey === childPublicKey) requestKeys.push(key)
        }
        for (const key of requestKeys) await ctx.db.del(key).catch(() => {})

        // Remove the persisted swarm topic for this child so it is not rejoined on
        // next startup. Also leave the topic on the live swarm so we stop advertising
        // on a topic no peer will ever use again.
        if (swarmTopic) {
          await ctx.db.del('topics:' + swarmTopic).catch(() => {})
          if (ctx.swarm) {
            try { ctx.swarm.leave(ctx.b4a.from(swarmTopic, 'hex')) } catch (_e) {}
          }
        } else {
          // swarmTopic was not stored in the peer record (can happen if info.topics was
          // empty on the Hyperswarm connection). Fall back: remove any topic not associated
          // with a remaining paired peer so the parent stops advertising on stale topics.
          const remainingTopics = new Set()
          for await (const { key, value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
            if (key !== 'peers:' + childPublicKey && value.swarmTopic) {
              remainingTopics.add(value.swarmTopic)
            }
          }
          const orphanedTopics = []
          for await (const { key, value } of ctx.db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
            if (!remainingTopics.has(value.topicHex)) orphanedTopics.push({ key, topicHex: value.topicHex })
          }
          for (const { key, topicHex } of orphanedTopics) {
            await ctx.db.del(key).catch(() => {})
            if (ctx.swarm) {
              try { ctx.swarm.leave(ctx.b4a.from(topicHex, 'hex')) } catch (_e) {}
            }
          }
        }

        // Notify child and gracefully close the connection AFTER deleting records.
        // Don't call conn.destroy() — that's a hard close that drops buffered writes
        // before the child receives the unpair message. Let the child close its end on receipt.
        if (noiseKey && ctx.peers.has(noiseKey)) {
          try {
            await ctx.sendToPeer(noiseKey, { type: 'unpair', payload: {} })
          } catch (_e) { /* offline or send failed */ }
        }

        ctx.send({ type: 'event', event: 'child:unpaired', data: { childPublicKey } })
        return { ok: true }
      }

      case 'child:clearBlocked': {
        // Clear a blocked: entry so a previously-unpaired child can re-pair without
        // rotating its identity. Needed when the child missed the original 'unpair'
        // message (e.g. offline during unpair, or connection dropped before wipe ran).
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('child:clearBlocked requires childPublicKey')
        const existed = await ctx.db.get('blocked:' + childPublicKey).catch(() => null)
        await ctx.db.del('blocked:' + childPublicKey).catch(() => {})
        return { ok: true, cleared: !!existed }
      }

      case 'child:listBlocked': {
        const blocked = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'blocked:', lt: 'blocked:~' })) {
          if (value) blocked.push(value)
        }
        return { blocked }
      }

      case 'invite:generate': {
        // Generate a random 32-byte swarm topic
        const topicBuf = Buffer.allocUnsafe(32)
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          crypto.getRandomValues(topicBuf)
        } else {
          require('sodium-native').randombytes_buf(topicBuf)
        }
        const topicHex = topicBuf.toString('hex')
        const parentPublicKey = Buffer.from(ctx.identity.publicKey).toString('hex')

        // Leave and delete any topics not associated with a currently paired peer — BEFORE
        // joining the new topic. Running this after joinTopic would sweep the new topic too
        // (no peer is paired on it yet), causing the parent to immediately leave its own invite.
        const activePeerTopics = new Set()
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          if (value.swarmTopic) activePeerTopics.add(value.swarmTopic)
        }
        const staleTopicEntries = []
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
          if (!activePeerTopics.has(value.topicHex)) staleTopicEntries.push({ key, topicHex: value.topicHex })
        }
        for (const { key, topicHex: staleTopicHex } of staleTopicEntries) {
          await ctx.db.del(key).catch(() => {})
          if (ctx.swarm) {
            try { ctx.swarm.leave(ctx.b4a.from(staleTopicHex, 'hex')) } catch (_e) {}
          }
        }

        // Record this topic as a pending invite so handleHello can bind it to the
        // child's peer record even if Hyperswarm delivers an empty info.topics[] on
        // the accepted connection (#147 follow-up).
        await ctx.db.put('pendingInviteTopic:' + topicHex, { topicHex, createdAt: Date.now() }).catch(() => {})

        // Join the swarm topic (parent listens for child connections)
        await ctx.joinTopic(topicHex)

        // NOTE: we intentionally do NOT clear blocked: entries here. Clearing them while
        // Hyperswarm DHT propagation is still settling creates a race: the old child can
        // reconnect on a lingering connection before the old topic fully departs, pass the
        // handleHello blocked check, and re-write their peers: entry — causing duplicate
        // children on the dashboard. The block is harmless once the child processes unpair
        // (they wipe their DB and get a new identity keypair), so it never matches them again.

        // Build and return the invite link
        const { buildInviteLink } = require('./invite')
        const inviteLink = buildInviteLink({ parentPublicKey, swarmTopic: topicHex, role: 'p' })

        return { inviteLink, inviteString: inviteLink, qrData: inviteLink, swarmTopic: topicHex, parentPublicKey }
      }

      case 'child-invite:generate': {
        // Child-hosted pairing invite: the child generates a topic and publishes a QR
        // the parent can scan. Inverse of 'invite:generate'. Runs in child mode only.
        const liveMode = ctx.getMode ? ctx.getMode() : ctx.mode
        if (liveMode && liveMode !== 'child') {
          throw new Error('child-invite:generate requires child mode')
        }
        const topicBuf = Buffer.allocUnsafe(32)
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          crypto.getRandomValues(topicBuf)
        } else {
          require('sodium-native').randombytes_buf(topicBuf)
        }
        const topicHex = topicBuf.toString('hex')
        const childPublicKey = Buffer.from(ctx.identity.publicKey).toString('hex')

        await ctx.db.put('pendingInviteTopic:' + topicHex, { topicHex, createdAt: Date.now(), role: 'c' }).catch(() => {})

        await ctx.joinTopic(topicHex)

        const { buildInviteLink } = require('./invite')
        const inviteLink = buildInviteLink({ childPublicKey, swarmTopic: topicHex, role: 'c' })

        return { inviteLink, inviteString: inviteLink, qrData: inviteLink, swarmTopic: topicHex, childPublicKey }
      }

      case 'acceptInvite': {
        // args[0]: full pear://pearguard/join?t=... URL
        const { parseInviteLink } = require('./invite')
        const parsed = parseInviteLink(args[0])
        if (!parsed.ok) throw new Error('invalid invite: ' + parsed.error)
        if (parsed.role === 'c') {
          throw new Error('This is a child device QR code. Use the Add Child → Scan option on the parent device.')
        }

        const { parentPublicKey, swarmTopic } = parsed

        // Store/refresh the pendingParent entry so handleHello can bind the
        // incoming connection to the new invite's topic even if we already have
        // a peers: entry from a prior pair.
        await ctx.db.put('pendingParent:' + parentPublicKey, { publicKey: parentPublicKey, swarmTopic, ts: Date.now() })

        // Always join the new swarm topic. A parent that issued a fresh invite
        // after rotating topics won't be reachable on the old one, so even when
        // we already have a peers: entry we need to rejoin on the new topic for
        // Hyperswarm to rediscover them.
        await ctx.joinTopic(swarmTopic)

        // If we already have a confirmed peers: entry for this parent, surface
        // an explicit alreadyPaired signal so the UI can stop waiting on a
        // peer:paired event that won't fire a second time.
        const existing = await ctx.db.get('peers:' + parentPublicKey)
        if (existing) {
          return { ok: true, alreadyPaired: true, parentPublicKey, swarmTopic }
        }

        return { ok: true, swarmTopic, parentPublicKey }
      }

      case 'acceptChildInvite': {
        const liveMode = ctx.getMode ? ctx.getMode() : ctx.mode
        if (liveMode && liveMode !== 'parent') {
          throw new Error('acceptChildInvite requires parent mode')
        }
        const { parseInviteLink } = require('./invite')
        const parsed = parseInviteLink(args[0])
        if (!parsed.ok) throw new Error('invalid invite: ' + parsed.error)
        if (parsed.role !== 'c') {
          throw new Error('This is a parent device QR code. Use Profile → Pair to Parent on the child device.')
        }

        const { childPublicKey, swarmTopic } = parsed

        await ctx.db.put('pendingChild:' + childPublicKey, { publicKey: childPublicKey, swarmTopic, ts: Date.now() })

        await ctx.joinTopic(swarmTopic)

        const existing = await ctx.db.get('peers:' + childPublicKey)
        if (existing) {
          return { ok: true, alreadyPaired: true, childPublicKey, swarmTopic }
        }

        return { ok: true, swarmTopic, childPublicKey }
      }

      case 'policy:getCurrent': {
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : null
        return { policy }
      }

      case 'identity:setName': {
        const { name } = args
        if (!name || typeof name !== 'string') throw new Error('invalid name')
        const raw = await ctx.db.get('profile')
        const profile = raw ? raw.value : {}
        profile.displayName = name.trim()
        await ctx.db.put('profile', profile)
        // Broadcast updated hello to all connected peers (#73).
        const myIdentityHex = ctx.b4a.toString(ctx.identity.publicKey, 'hex')
        const avatarThumb = profile.avatar
          ? (profile.avatar.type === 'preset' ? 'preset:' + profile.avatar.id
            : profile.avatar.mime ? 'mime:' + profile.avatar.mime + ';' + (profile.avatar.base64 || profile.avatar.thumb64 || '')
            : profile.avatar.thumb64 || null)
          : null
        const helloMsg = { type: 'hello', payload: { publicKey: myIdentityHex, displayName: name.trim(), avatarThumb } }
        for (const [noiseKey] of ctx.peers) {
          try { ctx.sendToPeer(noiseKey, helloMsg) } catch (_e) {}
        }
        return { ok: true }
      }

      case 'identity:getName': {
        const raw = await ctx.db.get('profile')
        const profile = raw ? raw.value : {}
        return { displayName: profile.displayName || null, avatar: profile.avatar || null }
      }

      case 'identity:setAvatar': {
        const { avatar } = args
        // avatar: { type: 'preset', id } | { type: 'custom', base64, thumb64 } | null
        const raw = await ctx.db.get('profile')
        const profile = raw ? raw.value : {}
        profile.avatar = avatar || null
        await ctx.db.put('profile', profile)
        // Broadcast updated hello to all connected peers
        const myIdHex = ctx.b4a.toString(ctx.identity.publicKey, 'hex')
        const thumb = avatar
          ? (avatar.type === 'preset' ? 'preset:' + avatar.id
            : avatar.mime ? 'mime:' + avatar.mime + ';' + (avatar.base64 || avatar.thumb64 || '')
            : avatar.thumb64 || null)
          : null
        const helloPayload = { publicKey: myIdHex, displayName: profile.displayName || '', avatarThumb: thumb }
        const helloUpdate = { type: 'hello', payload: helloPayload }
        for (const [noiseKey] of ctx.peers) {
          try { ctx.sendToPeer(noiseKey, helloUpdate) } catch (_e) {}
        }
        return { ok: true }
      }

      case 'pin:set': {
        const { pin } = args
        // Validate here as well as in the UI: this is the only write path, and a
        // caller that skipped the form could otherwise store a 1-digit PIN.
        const pinError = validatePin(pin)
        if (pinError) throw new Error(pinError)

        // Hash the PIN using BLAKE2b (crypto_generichash) — a core libsodium primitive
        // that is reliably available in all builds including Android/Bare.
        // crypto_pwhash_str (argon2id) is intentionally NOT used here because its
        // availability in the Android libsodium build is not guaranteed.
        const hashBuf = Buffer.alloc(ctx.sodium.crypto_generichash_BYTES)
        ctx.sodium.crypto_generichash(hashBuf, Buffer.from(pin))
        const hashStr = hashBuf.toString('hex')
        if (!hashStr) throw new Error('PIN hashing failed — crypto_generichash returned empty result')

        // Store in parent's own policy key (unchanged - for local use).
        // pinPlain is kept ONLY in the parent's local policy so the parent
        // can reveal it on the Settings page if they forget. It is never
        // placed into per-child policies or sent over the wire.
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : {}
        policy.pinHash = hashStr
        policy.pinPlain = pin
        await ctx.db.put('policy', policy)

        // Propagate pinHashes into every child's policy and push to connected children
        const myPublicKey = Buffer.from(ctx.identity.publicKey).toString('hex')
        for await (const { value: peerRecord } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          const childPK = peerRecord.publicKey
          await withPolicyLock(childPK, async () => {
            const childPolicyRaw = await ctx.db.get('policy:' + childPK).catch(() => null)
            const childPolicy = childPolicyRaw
              ? childPolicyRaw.value
              : { apps: {}, childPublicKey: childPK, version: 0 }
            // Write per-parent pinHash into pinHashes map; remove legacy field
            if (!childPolicy.pinHashes) childPolicy.pinHashes = {}
            childPolicy.pinHashes[myPublicKey] = hashStr
            delete childPolicy.pinHash
            childPolicy.version = (childPolicy.version || 0) + 1
            await ctx.db.put('policy:' + childPK, childPolicy)
            try {
              const noiseKey = peerRecord.noiseKey
              if (noiseKey) {
                ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: childPolicy })
              }
            } catch (_e) {
              // child offline — pinHashes stored; will be pushed on next hello
            }
          })
        }

        return { ok: true }
      }

      case 'pin:get': {
        // Returns the parent's own plaintext PIN (stored locally only) so
        // they can reveal it on the Settings page. Returns null if unset
        // or if this device was set before plaintext was stored.
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : null
        return { pin: policy && policy.pinPlain ? policy.pinPlain : null }
      }

      case 'pin:verify': {
        const { pin, packageName } = args
        const raw = await ctx.db.get('policy')
        if (!raw) { return { granted: false, reason: 'no-policy' } }
        const policy = raw.value  // Hyperbee uses valueEncoding:'json' so raw.value is already parsed
        // Co-parents each hold their own PIN in policy.pinHashes, and
        // handlePolicyUpdate strips the pre-co-parent policy.pinHash from the
        // child's copy. This used to compare against that stripped field alone,
        // so on any child paired since then it denied every PIN, including the
        // right one. Both real enforcement paths had already routed around it
        // (AppBlockerModule, and desktop/src/enforcement/pin-verify.js, each
        // reimplementing the check), which is why nothing looked broken.
        const hasAnyPin = !!(policy.pinHash || (policy.pinHashes && Object.keys(policy.pinHashes).length))
        if (!hasAnyPin) { return { granted: false, reason: 'no-pin' } }

        // Same BLAKE2b hash pin:set uses, matched against every parent's PIN.
        const verified = verifyParentPin(policy, pin, ctx.sodium)

        if (!verified) {
          ctx.send({ type: 'event', event: 'override:denied', data: { packageName, reason: 'wrong-pin' } })
          return { granted: false, reason: 'wrong-pin' }
        }

        const now = Date.now()
        const expiresAt = now + (policy.overrideDurationSeconds || 3600) * 1000
        // Resolve appName from policy so override displays show the label
        const appEntry = policy.apps && policy.apps[packageName]
        const appName = (appEntry && appEntry.appName) || packageName
        const grant = { packageName, appName, grantedAt: now, expiresAt, source: 'pin-verified' }

        // Store grant to Hyperbee for audit log and overrides:list
        await ctx.db.put('override:' + packageName + ':' + now, grant)

        // Log to usage report
        await appendPinUseLog({ packageName, grantedAt: now, expiresAt }, ctx.db)

        // Notify native to allow app temporarily
        ctx.send({ method: 'native:grantOverride', args: grant })

        ctx.send({ type: 'event', event: 'override:granted', data: grant })
        return { granted: true, expiresAt }
      }

      case 'pin:isSet': {
        // Reads the parent's own 'policy' key — NOT a per-child 'policy:{childPK}' key.
        // pin:set stores pinHash here (ctx.db.put('policy', policy)).
        // valueEncoding: 'json' means raw.value is already a parsed JS object.
        const raw = await ctx.db.get('policy')
        return { isSet: !!(raw && raw.value && raw.value.pinHash) }
      }

      case 'time:request': {
        const { packageName, appName, requestType, extraSeconds } = args
        // requestType: 'approval'     (blocked/pending — parent changes policy)
        //              'extra_time'   (approved but hit limit/schedule — parent grants timed override)
        //              'general_time' (device-wide screen-time cap spent — parent tops up
        //                              today's budget; packageName is kept only as context
        //                              for the parent, the grant is not app-scoped) (#179)
        // Defaults to 'approval' for backward compatibility with older clients.
        const resolvedType = (requestType === 'extra_time' || requestType === 'general_time')
          ? requestType
          : 'approval'
        const carriesSeconds = resolvedType === 'extra_time' || resolvedType === 'general_time'
        const requestId = 'req:' + Date.now() + ':' + packageName
        const request = {
          id: requestId,
          packageName,
          appName: appName || packageName,
          requestedAt: Date.now(),
          status: 'pending',
          requestType: resolvedType,
          ...(carriesSeconds && typeof extraSeconds === 'number' ? { extraSeconds } : {}),
        }

        await ctx.db.put(requestId, request)

        // Notify parent (emit event to RN for relay)
        ctx.send({ type: 'event', event: 'time:request:sent', data: { packageName, requestId, requestedAt: request.requestedAt } })

        // Notify WebView that request was submitted
        ctx.send({ type: 'event', event: 'request:submitted', data: request })

        if (ctx.sendToAllParents) {
          const p2pPayload = { requestId, packageName, appName: request.appName, requestedAt: request.requestedAt, requestType: resolvedType }
          if (carriesSeconds && typeof extraSeconds === 'number') p2pPayload.extraSeconds = extraSeconds
          await ctx.sendToAllParents({ type: 'time:request', payload: p2pPayload })
        }

        return { requestId, status: 'pending' }
      }

      case 'time:grant': {
        // Parent approves an extra-time request — sends time:extend P2P to child.
        const { childPublicKey, requestId, packageName, extraSeconds } = args
        if (!childPublicKey || !requestId || !packageName || typeof extraSeconds !== 'number') {
          throw new Error('invalid time:grant args')
        }
        const existing = await ctx.db.get('request:' + requestId).catch(() => null)
        const appName = (existing && existing.value && (existing.value.appDisplayName || existing.value.appName)) || packageName
        if (existing) {
          await ctx.db.put('request:' + requestId, { ...existing.value, status: 'approved' })
        }

        const grantedAt = Date.now()
        let sent = false
        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'time:extend', payload: { requestId, packageName, extraSeconds } })
            sent = true
          }
        } catch (_e) {
          // child offline — stored below as awaiting delivery, re-sent from handleHello
        }

        // Store the grant parent-side so the parent UI can show active overrides
        // (#61). The child starts the clock when the grant ARRIVES (handleTimeExtend
        // stamps its own expiresAt), so until the child confirms, this grant has no
        // expiry. Stamping grantedAt + extraSeconds regardless made the parent count
        // down a window the child was never in, and replayActiveGrants then refused
        // to re-send the grant once that phantom window had passed: 15 minutes
        // approved while the child was on the bus were silently lost while both
        // devices still called the request approved.
        //
        // `sent` deliberately does NOT count as delivery. Writing to a peer that has
        // just gone away succeeds silently (proved by harness scenario 12: the child
        // process was killed and the write still did not throw), so only the child's
        // own request:resolved settles this record.
        await ctx.db.put('override:' + childPublicKey + ':' + grantedAt, {
          packageName, appName, childPublicKey, grantedAt, source: 'parent-approved',
          expiresAt: null, awaitingDelivery: true, ...(sent && { sentAt: grantedAt }),
          // requestId + extraSeconds let handleHello re-send this grant to a child
          // that was offline when it was approved (grants were otherwise lost).
          requestId, extraSeconds,
        })
        ctx.send({ type: 'event', event: 'request:updated', data: { requestId, status: 'approved' } })
        return { ok: true }
      }

      case 'time:grantGeneral': {
        // Parent approves a general-time request (#179) — tops up the child's
        // screen-time budget for today. Unlike time:grant this creates no
        // per-app override: schedules, per-app limits and blocked apps all
        // still apply, the child simply gets a bigger daily budget.
        const { childPublicKey, requestId, extraSeconds } = args
        if (!childPublicKey || typeof extraSeconds !== 'number' || extraSeconds <= 0) {
          throw new Error('invalid time:grantGeneral args')
        }
        // Parent-side record so the UI can show what was granted today.
        const grantedAt = Date.now()
        // A proactive grant (parent hands out time with no pending request) carries
        // no requestId; synthesize a unique one so the child still dedups the grant
        // and it replays correctly to an offline child via replayActiveGrants. The
        // child uses requestId only as an idempotency key, not as a real request.
        const rid = requestId || 'grant:' + childPublicKey + ':' + grantedAt

        // Only a real pending request needs its status flipped to approved.
        if (requestId) {
          const existing = await ctx.db.get('request:' + requestId).catch(() => null)
          if (existing) {
            await ctx.db.put('request:' + requestId, { ...existing.value, status: 'approved' })
          }
        }

        await ctx.db.put('screentime:grant:' + childPublicKey + ':' + grantedAt, {
          // requestId lets handleHello re-send this grant to a child that was
          // offline when it was approved (grants were otherwise lost).
          childPublicKey, grantedAt, extraSeconds, source: 'parent-approved', requestId: rid,
        })

        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'time:extendGeneral', payload: { requestId: rid, extraSeconds } })
          }
        } catch (_e) {
          // child offline — grant stored; replayed on reconnect via handleHello
        }
        // Only signal a request state change when there actually was a request.
        if (requestId) {
          ctx.send({ type: 'event', event: 'request:updated', data: { requestId, status: 'approved' } })
        }
        return { ok: true }
      }

      case 'time:deny': {
        // Parent denies an extra-time request — marks it denied and notifies child.
        const { childPublicKey, requestId, packageName, appName } = args
        if (!childPublicKey || !requestId || !packageName) {
          throw new Error('invalid time:deny args')
        }
        const existing = await ctx.db.get('request:' + requestId).catch(() => null)
        if (existing) {
          await ctx.db.put('request:' + requestId, { ...existing.value, status: 'denied' })
        }
        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'request:denied', payload: { requestId, packageName, appName } })
          }
        } catch (_e) { /* child offline */ }
        ctx.send({ type: 'event', event: 'request:updated', data: { requestId, status: 'denied' } })
        return { ok: true }
      }

      case 'request:markNotified': {
        // Mark a pending request as having had its notification shown, so it isn't
        // re-fired during the reconnect backfill scan (see handleHello in bare.js).
        const { requestId } = args || {}
        if (requestId) {
          const existing = await ctx.db.get('request:' + requestId).catch(() => null)
          if (existing) await ctx.db.put('request:' + requestId, { ...existing.value, notified: true })
        }
        return { ok: true }
      }

      case 'requests:list': {
        // Sweep first so the list says "No answer" even if the heartbeat tick has
        // not run since the window lapsed.
        await expireUnansweredRequests(ctx.db, 'req:', Date.now(), announceExpired)
        // Scan Hyperbee for all keys matching 'req:*'; auto-expire entries older than 7 days
        const requests = []
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
          if (value.requestedAt < cutoff) {
            await ctx.db.del(key)
          } else {
            requests.push(value)
          }
        }
        // Sort by requestedAt descending
        requests.sort((a, b) => b.requestedAt - a.requestedAt)
        return { requests }
      }

      case 'requests:clear': {
        // Delete all resolved (approved or denied) req:* entries
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
          if (value.status === 'approved' || value.status === 'denied' || value.status === 'expired') {
            await ctx.db.del(key)
          }
        }
        return { ok: true }
      }

      case 'leave:request': {
        // The child device asks to be freed. Only makes sense on a child, and
        // only with a PIN one of its parents set.
        if (ctx.getMode && ctx.getMode() !== 'child') throw new Error('leave:request is child-only')
        const { pin } = args || {}
        const raw = await ctx.db.get('policy').catch(() => null)
        const policy = raw && raw.value
        if (!policy) return { ok: false, reason: 'not-paired' }
        if (!policy.pinHash && !(policy.pinHashes && Object.keys(policy.pinHashes).length)) {
          return { ok: false, reason: 'no-pin' }
        }
        // Throttle before checking, so a locked-out screen costs nothing to
        // guess at and the wait cannot be reset by trying again.
        const attemptsRaw = await ctx.db.get('leaveAttempts').catch(() => null)
        const attempts = (attemptsRaw && attemptsRaw.value) || { failCount: 0 }
        const lockedFor = leaveLockRemainingMs(attempts, Date.now())
        if (lockedFor > 0) {
          ctx.send({ type: 'event', event: 'leave:denied', data: { reason: 'locked', lockedForMs: lockedFor } })
          return { ok: false, reason: 'locked', lockedForMs: lockedFor }
        }
        if (!verifyParentPin(policy, pin, ctx.sodium)) {
          const failCount = (attempts.failCount || 0) + 1
          const delay = leaveLockoutForFailCount(failCount)
          const now = Date.now()
          const updated = { failCount, ...(delay > 0 ? { lockedAt: now, lockedUntil: now + delay } : {}) }
          await ctx.db.put('leaveAttempts', updated)
          // Tell the parent someone is trying, through the same alert the block
          // overlay raises. Only on a fresh lockout, mirroring the native side,
          // so a burst of guesses is one alert rather than one per attempt.
          if (delay > 0 && ctx.sendToAllParents) {
            await ctx.sendToAllParents({
              type: 'pin:failure',
              payload: { packageName: null, appName: 'Remove supervision', failedAt: now, failCount, lockoutMs: delay },
            })
          }
          ctx.send({ type: 'event', event: 'leave:denied', data: { reason: 'wrong-pin', failCount, lockedForMs: delay } })
          return { ok: false, reason: 'wrong-pin', lockedForMs: delay }
        }
        // A correct PIN clears the record, exactly as the keypad does on success.
        if (attempts.failCount) await ctx.db.del('leaveAttempts').catch(() => {})
        const existing = await ctx.db.get('leaveScheduled').catch(() => null)
        if (existing && existing.value) return { ok: true, ...existing.value }
        const requestedAt = Date.now()
        const record = { requestedAt, effectiveAt: requestedAt + LEAVE_DELAY_MS, observedMs: 0, lastTickAt: requestedAt }
        await ctx.db.put('leaveScheduled', record)
        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'leave:scheduled', payload: { effectiveAt: record.effectiveAt, requestedAt } })
        }
        ctx.send({ type: 'event', event: 'leave:scheduled', data: record })
        return { ok: true, ...record }
      }

      case 'leave:cancel': {
        // Cancelling from the child needs the PIN too, so a child cannot undo a
        // parent's cancel and re-arm without knowing it.
        if (ctx.getMode && ctx.getMode() !== 'child') throw new Error('leave:cancel is child-only')
        const { pin } = args || {}
        const raw = await ctx.db.get('policy').catch(() => null)
        const policy = raw && raw.value
        if (policy && !verifyParentPin(policy, pin, ctx.sodium)) return { ok: false, reason: 'wrong-pin' }
        await ctx.db.del('leaveScheduled').catch(() => {})
        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'leave:cancelled', payload: { cancelledAt: Date.now(), by: 'child' } })
        }
        ctx.send({ type: 'event', event: 'leave:cancelled', data: { by: 'child' } })
        return { ok: true }
      }

      case 'leave:status': {
        const attemptsRaw = await ctx.db.get('leaveAttempts').catch(() => null)
        const lockedForMs = leaveLockRemainingMs(attemptsRaw && attemptsRaw.value, Date.now())
        const raw = await ctx.db.get('leaveScheduled').catch(() => null)
        if (!raw || !raw.value) return { scheduled: false, lockedForMs }
        const rec = raw.value
        return {
          scheduled: true,
          lockedForMs,
          requestedAt: rec.requestedAt,
          effectiveAt: rec.effectiveAt,
          msRemaining: Math.max(0, rec.effectiveAt - Date.now()),
          observedMs: rec.observedMs || 0,
          observedRequiredMs: LEAVE_MIN_OBSERVED_MS,
        }
      }

      case 'child:cancelLeave': {
        // Parent side: call off a leave the child scheduled.
        const { childPublicKey } = args || {}
        if (!childPublicKey) throw new Error('child:cancelLeave requires childPublicKey')
        await ctx.db.del('leavePending:' + childPublicKey).catch(() => {})
        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) ctx.sendToPeer(noiseKey, { type: 'leave:cancel', payload: {} })
        } catch (_e) {
          // child offline: our own record is cleared, and the child is told the
          // next time it connects (handleHello re-sends the cancel).
        }
        ctx.send({ type: 'event', event: 'child:leaveCancelled', data: { childPublicKey } })
        return { ok: true }
      }

      case 'overrides:list': {
        // Scan Hyperbee for active override grants (PIN or parent-approved).
        // Returns only non-expired entries so the UI shows what's currently active.
        // Optional childPublicKey filter for parent-side queries.
        const filterChild = args && args.childPublicKey
        const overrides = []
        const now = Date.now()
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'override:', lt: 'override:~' })) {
          // A grant the child has not received yet has no expiry, because the child
          // starts the clock on arrival. Keep it listed so the parent sees it is
          // still waiting on the phone instead of seeing nothing at all.
          if (value.awaitingDelivery !== true && !(value.expiresAt > now)) continue
          if (filterChild && value.childPublicKey !== filterChild) continue
          // Resolve appName from policy if not already on the record
          if (!value.appName) {
            const policyKey = filterChild ? ('policy:' + filterChild) : 'policy'
            const raw = await ctx.db.get(policyKey)
            const apps = raw && raw.value && raw.value.apps
            value.appName = (apps && apps[value.packageName] && apps[value.packageName].appName) || value.packageName
          }
          overrides.push(value)
        }
        // Undelivered grants first (they have no expiry to sort by), then by
        // whichever runs out soonest.
        overrides.sort((a, b) => (a.expiresAt || 0) - (b.expiresAt || 0))
        return { overrides }
      }

      case 'child:homeData': {
        // Aggregated data for the child Home tab: status summary, usage, blocks, requests
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : null
        const apps = (policy && policy.apps) || {}

        // Collect blocked and pending app lists
        const blockedApps = []
        const pendingApps = []
        for (const pkg of Object.keys(apps)) {
          const entry = apps[pkg]
          const item = { packageName: pkg, appName: entry.appName || pkg }
          if (entry.status === 'blocked') blockedApps.push(item)
          if (entry.status === 'pending') pendingApps.push(item)
        }
        blockedApps.sort((a, b) => a.appName.localeCompare(b.appName))
        pendingApps.sort((a, b) => a.appName.localeCompare(b.appName))
        const blockedCount = blockedApps.length
        const pendingCount = pendingApps.length

        // Sweep before counting, so a request nobody answered stops disabling the
        // child's ask button the moment its window lapses.
        await expireUnansweredRequests(ctx.db, 'req:', Date.now(), announceExpired)
        if (await advanceScheduledLeave(ctx.db, Date.now()) === 'commit' && ctx.onLeaveDue) await ctx.onLeaveDue()
        // Collect pending requests with app name resolution
        const pendingRequestsList = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
          if (value.status === 'pending') {
            const appEntry = apps[value.packageName]
            pendingRequestsList.push({
              ...value,
              appName: value.appName || (appEntry && appEntry.appName) || value.packageName,
            })
          }
        }
        pendingRequestsList.sort((a, b) => b.requestedAt - a.requestedAt)
        const pendingRequests = pendingRequestsList.length

        // Count active overrides
        const now = Date.now()
        const activeOverrides = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'override:', lt: 'override:~' })) {
          if (value.expiresAt > now) {
            const appEntry = apps[value.packageName]
            activeOverrides.push({
              ...value,
              appName: value.appName || (appEntry && appEntry.appName) || value.packageName,
            })
          }
        }

        // Locked state and names for lock banner / greeting
        const locked = isLockActive(policy, Date.now())
        const lockMessage = (policy && policy.lockMessage) || ''
        const lockUntil = (policy && policy.lockUntil) || 0
        let parentName = null
        let childName = null
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          if (value && value.displayName) { parentName = value.displayName; break }
        }
        const identRaw = await ctx.db.get('identity')
        if (identRaw && identRaw.value && identRaw.value.name) childName = identRaw.value.name

        // Screen-time budget context for the "ask for more time" button (#179).
        // The button is pointless with no cap, and asking twice is just noise.
        // The remaining-time figure itself comes from screentime:status (native truth).
        const hasScreenTimeLimit = !!(policy && typeof policy.dailyScreenTimeLimitSeconds === 'number' && policy.dailyScreenTimeLimitSeconds > 0)
        const generalTimeRequestPending = pendingRequestsList.some(r => r.requestType === 'general_time')

        // Warn about the next scheduled blackout — otherwise a blanket lock at
        // bedtime arrives with no in-app warning at all.
        const win = nextScheduleWindow((policy && policy.schedules) || [], new Date(now))
        const nextSchedule = win ? { active: win.active, label: win.label, at: win.at.getTime() } : null

        // Which apps don't spend the shared budget (#178), so "why is Chrome still
        // working?" has an answer on the child's own screen.
        const screenTimeExemptApps = (policy && Array.isArray(policy.screenTimeExemptApps)) ? policy.screenTimeExemptApps : []
        const screenTimeExemptAppNames = screenTimeExemptApps
          .map(pkg => (apps[pkg] && apps[pkg].appName) || pkg)
          .sort((a, b) => a.localeCompare(b))

        return { blockedCount, pendingCount, pendingRequests, blockedApps, pendingApps, pendingRequestsList, activeOverrides, hasPolicy: !!policy, locked, lockMessage, lockUntil, parentName, childName, hasScreenTimeLimit, generalTimeRequestPending, nextSchedule, screenTimeExemptAppNames }
      }

      case 'app:installed': {
        const { packageName, appName, category, exeBasename, iconBase64 } = args

        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : { apps: {} }
        if (!policy.apps) policy.apps = {}

        // Mark as pending if not already in policy. Persisting exeBasename on
        // the entry lets the child re-seed its in-memory ExeMap from policy at
        // startup, so block-evaluator can still match the exe after a restart
        // when seen-exes.json has already deduped away the first-sighting.
        if (!policy.apps[packageName]) {
          policy.apps[packageName] = {
            // The parent's auto-approve setting rides along in policy.settings, so
            // the child can allow the app straight away instead of blocking it for
            // the round trip until the parent's policy:update arrives.
            status: autoApprovesNewApps(policy) ? 'allowed' : 'pending',
            appName: appName || packageName,
            addedAt: Date.now(),
            ...(category && { category }),
            ...(exeBasename && { exeBasename }),
            // No iconBase64 here: the icon goes to the parents below, the child's
            // own policy never needs it (see stripAppIcons).
          }
          await ctx.db.put('policy', policy)

          // Notify native enforcement of updated policy
          ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })

          // Notify parent (event carries appName for notification label)
          ctx.send({ type: 'event', event: 'app:installed', data: { packageName, appName: appName || packageName, detectedAt: Date.now() } })

          // Notify WebView
          ctx.send({ type: 'event', event: 'policy:updated', data: policy })

          if (ctx.sendToAllParents) {
            await ctx.sendToAllParents({ type: 'app:installed', payload: { packageName, appName: appName || packageName, category, exeBasename, iconBase64, detectedAt: Date.now() } })
          }
        }

        return { status: policy.apps[packageName].status }
      }

      case 'app:uninstalled': {
        // Child device: an app was removed. Strip it from local child policy,
        // update native enforcement, and relay to parent so their Apps list stays clean.
        const { packageName } = args
        if (!packageName) return { ok: false }

        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : { apps: {} }
        if (!policy.apps || !policy.apps[packageName]) return { ok: true } // already absent

        // Grab the display name before deleting so notifications show a readable label (#71)
        const appName = policy.apps[packageName].appName || packageName

        delete policy.apps[packageName]
        await ctx.db.put('policy', policy)

        // Keep native enforcement in sync
        ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })

        // Emit local event so the child's own notification shows the app name
        ctx.send({ type: 'event', event: 'app:uninstalled', data: { packageName, appName } })

        // Relay to parent so they can prune their Apps list
        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'app:uninstalled', payload: { packageName, appName } })
        }

        return { ok: true }
      }

      case 'apps:sync': {
        // Batch version of app:installed — receives all installed apps at once.
        // Avoids the race condition where concurrent individual app:installed messages
        // all read the same policy key before any write completes.
        const { apps, installedAll } = args
        if (!Array.isArray(apps) || apps.length === 0) return { count: 0 }

        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : { apps: {} }
        if (!policy.apps) policy.apps = {}

        // If no apps are in the policy yet, this is the initial sync at first pairing —
        // auto-approve everything so enforcement doesn't immediately block all apps on a
        // freshly paired device. Apps installed after pairing start as 'pending'.
        const isInitialSync = Object.keys(policy.apps).length === 0
        const autoApprove = autoApprovesNewApps(policy)

        let newCount = 0
        for (const { packageName, appName, isLauncher, category } of apps) {
          if (!policy.apps[packageName]) {
            const status = (isInitialSync || isLauncher || autoApprove) ? 'allowed' : 'pending'
            policy.apps[packageName] = { status, appName: appName || packageName, addedAt: Date.now(), ...(category && { category }) }
            newCount++
          } else if (category && !policy.apps[packageName].category) {
            // Backfill category for apps already in policy
            policy.apps[packageName].category = category
          }
        }

        // Prune apps that have been uninstalled since the last sync. The real-time
        // PackageMonitor receiver never fires on Android 8+, so a removed app would
        // otherwise linger forever (apps:sync only ever adds). `installedAll` is the
        // FULL installed package set — reconcile the policy against it. Never prune on
        // the initial sync (nothing to remove yet) or when installedAll is absent/empty
        // (treated as "unknown" — fail safe rather than wipe the whole policy).
        const removed = []
        if (!isInitialSync && Array.isArray(installedAll) && installedAll.length > 0) {
          for (const packageName of pendingUninstalls(Object.keys(policy.apps), installedAll)) {
            removed.push({ packageName, appName: policy.apps[packageName].appName || packageName })
            delete policy.apps[packageName]
          }
        }

        if (newCount > 0 || removed.length > 0) {
          await ctx.db.put('policy', policy)
          ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })
          ctx.send({ type: 'event', event: 'policy:updated', data: policy })
        }

        // Relay each pruned app to parents so their Apps list drops the stale entry —
        // the parent's apps:sync is add-only, so a fresh full list would not remove it;
        // app:uninstalled is the message its handler prunes on.
        if (ctx.sendToAllParents) {
          for (const { packageName, appName } of removed) {
            ctx.send({ type: 'event', event: 'app:uninstalled', data: { packageName, appName } })
            await ctx.sendToAllParents({ type: 'app:uninstalled', payload: { packageName, appName } })
          }
        }

        // The full catalogue used to go to every parent on every scan, and a scan
        // runs on every reconnect, so a phone on a flaky train re-sent every app
        // it has (with an icon each) many times a day to a parent that already
        // had them. It cannot simply be dropped: a co-parent who pairs later
        // finds the child's own policy already complete, so nothing here counts
        // as new and they would never learn the app list at all (#109).
        //
        // So it is sent per parent, and only when that parent's picture of the
        // installed set differs from what is on this device. A parent we have
        // never sent to has no stored signature and gets the list once; after
        // that they get nothing until an app appears or disappears. Offline
        // parents are skipped rather than queued, because a scan runs on every
        // reconnect anyway and a queued catalogue is exactly the bulk worth not
        // storing.
        const signature = appsSignature(apps)
        let relayedTo = 0
        for await (const { value: parent } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          if (!parent || !parent.publicKey || !parent.noiseKey) continue
          const seen = await ctx.db.get('appsSig:' + parent.publicKey).catch(() => null)
          if (seen && seen.value && seen.value.signature === signature) continue
          try {
            ctx.sendToPeer(parent.noiseKey, { type: 'apps:sync', payload: { apps } })
          } catch (_e) {
            continue // parent offline; the scan on their next reconnect covers it
          }
          await ctx.db.put('appsSig:' + parent.publicKey, { signature, at: Date.now() })
          relayedTo++
        }

        return { count: newCount, removed: removed.length, relayedTo }
      }

      case 'swarm:reconnect': {
        if (!ctx.swarm) return { rejoined: 0 }
        // Re-announce on every paired peer's topic. swarm.flush() alone is not
        // enough: after long background, network change, or Android doze the
        // DHT announce can go stale and peers stop discovering each other (#147).
        // Mirror the cold-start rejoin loop in init() so foreground recovery
        // matches a fresh launch.
        const activePeerTopics = new Set()
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          if (value && value.swarmTopic) activePeerTopics.add(value.swarmTopic)
        }
        const topicHexSet = new Set(activePeerTopics)
        for await (const { value } of ctx.db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
          if (value && value.topicHex) topicHexSet.add(value.topicHex)
        }
        const topicHexes = [...topicHexSet]
        await Promise.all(topicHexes.map(t =>
          ctx.joinTopic(t).catch(e => console.warn('[bare] swarm:reconnect rejoin failed:', e.message))
        ))
        return { rejoined: topicHexes.length }
      }

      case 'heartbeat:updateData': {
        if (args && typeof args === 'object') {
          if ('currentApp' in args) heartbeatCache.currentApp = args.currentApp
          if ('currentAppPackage' in args) heartbeatCache.currentAppPackage = args.currentAppPackage
          if (typeof args.todayScreenTimeSeconds === 'number') {
            heartbeatCache.todayScreenTimeSeconds = args.todayScreenTimeSeconds
          }
          // Enforced screen-time budget from native (#179). Null on platforms or
          // builds where the native method is absent — callers treat that as unknown.
          if ('screenTime' in args) heartbeatCache.screenTime = args.screenTime || null
          if ('appLimits' in args) heartbeatCache.appLimits = args.appLimits || null
        }
        return { ok: true }
      }

      case 'screentime:status': {
        // Child UI: the budget and per-app limits exactly as native enforcement sees them.
        return {
          screenTime: heartbeatCache.screenTime || null,
          appLimits: heartbeatCache.appLimits || [],
        }
      }

      case 'heartbeat:send': {
        // The child already ticks once a minute, so this is the sweep: no new
        // timer, and the child hears about an unanswered request within a minute
        // of the window lapsing rather than whenever it next opens a screen.
        await expireUnansweredRequests(ctx.db, 'req:', Date.now(), announceExpired)
        // The countdown for a scheduled leave is checked, never timed: a live
        // timer would not survive a force-stop or a reboot, and this has to.
        if (await advanceScheduledLeave(ctx.db, Date.now()) === 'commit' && ctx.onLeaveDue) await ctx.onLeaveDue()
        const identityRaw = await ctx.db.get('identity')
        const childPublicKey = identityRaw ? identityRaw.value.publicKey : null

        const heartbeat = {
          type: 'heartbeat',
          payload: {
            childPublicKey,
            isOnline: true,
            // TODO: enforcementActive should come from native:getEnforcementState via RN.
            // Since we lack a synchronous callRN helper, default to null (unknown) for now.
            enforcementActive: null,
            currentApp: heartbeatCache.currentApp,
            currentAppPackage: heartbeatCache.currentAppPackage,
            todayScreenTimeSeconds: heartbeatCache.todayScreenTimeSeconds,
            // Enforced budget so the parent can show time left (#179).
            screenTime: heartbeatCache.screenTime,
            timestamp: Date.now(),
          },
        }

        ctx.send({ type: 'event', event: 'heartbeat:send', data: heartbeat })

        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'heartbeat', payload: heartbeat.payload })
        }

        return heartbeat.payload
      }

      case 'pin:used': {
        // Native overlay verified PIN and granted override — store to Hyperbee
        // so overrides:list can find it, and relay to parent as an alert (#61).
        const { packageName, timestamp, durationSeconds } = args
        const grantedAt = timestamp || Date.now()
        const expiresAt = grantedAt + (durationSeconds || 3600) * 1000

        // Resolve appName from policy
        const policyRaw = await ctx.db.get('policy')
        const policyApps = policyRaw && policyRaw.value && policyRaw.value.apps
        const appName = (policyApps && policyApps[packageName] && policyApps[packageName].appName) || packageName

        const grant = { packageName, appName, grantedAt, expiresAt, source: 'pin-verified' }

        await ctx.db.put('override:' + packageName + ':' + grantedAt, grant)
        await appendPinUseLog({ packageName, grantedAt, expiresAt }, ctx.db)

        // Emit event so child UI updates immediately
        ctx.send({ type: 'event', event: 'override:granted', data: grant })

        // Relay to parent so they see PIN usage in alerts
        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'pin:override', payload: { packageName, appName, grantedAt, expiresAt } })
        }

        return { logged: true }
      }

      case 'pin:failed': {
        // Native overlay reported a PIN lockout (child guessing). Relay to the
        // parent as an alert. Nothing is stored child-side — the parent owns the
        // alert record, same division as bypass:detected.
        const { packageName, timestamp, failCount, lockoutMs } = args
        const failedAt = timestamp || Date.now()

        const policyRaw = await ctx.db.get('policy')
        const policyApps = policyRaw && policyRaw.value && policyRaw.value.apps
        const appName = (policyApps && policyApps[packageName] && policyApps[packageName].appName) || packageName || null

        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({
            type: 'pin:failure',
            payload: { packageName: packageName || null, appName, failedAt, failCount: failCount || 0, lockoutMs: lockoutMs || 0 },
          })
        }

        return { logged: true }
      }

      case 'bypass:detected': {
        const { reason } = args
        const entry = { reason, detectedAt: Date.now() }

        await ctx.db.put('bypass:' + entry.detectedAt, entry)

        ctx.send({ type: 'event', event: 'alert:bypass', data: { reason, detectedAt: entry.detectedAt } })
        ctx.send({ type: 'event', event: 'enforcement:offline', data: { reason } })

        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'bypass:alert', payload: { reason, detectedAt: entry.detectedAt } })
        }

        return { logged: true }
      }

      case 'usage:flush': {
        // Build usage report from PIN log, identity, and native usage stats
        const pinLog = await getPinUseLog(ctx.db)
        const identityRaw = await ctx.db.get('identity')
        const childPublicKey = identityRaw ? identityRaw.value.publicKey : null

        // Build weekly lookup: packageName → secondsThisWeek
        const weeklyMap = {}
        for (const w of args.weekly || []) {
          weeklyMap[w.packageName] = w.secondsThisWeek || 0
        }

        // Load policy to attach daily limits per app
        const policyRaw = await ctx.db.get('policy')
        const policyApps = policyRaw?.value?.apps || {}

        // args.usage is [{ packageName, appName, secondsToday }] from getDailyUsageAllEvents()
        const apps = (args.usage || []).map((a) => ({
          packageName: a.packageName,
          displayName: a.appName || a.packageName,
          todaySeconds: a.secondsToday || 0,
          weekSeconds: weeklyMap[a.packageName] || 0,
          dailyLimitSeconds: policyApps[a.packageName]?.dailyLimitSeconds || null,
        }))

        // Skip storing/sending if no usage data — avoids overwriting a valid
        // report with an empty one when the native stats aren't available yet
        if (apps.length === 0) {
          return { flushed: false, reason: 'no data' }
        }

        // Resolve display name of the current foreground app
        const foregroundPkg = args.foregroundPackage || null
        const foregroundEntry = foregroundPkg ? apps.find((a) => a.packageName === foregroundPkg) : null
        const currentApp = foregroundEntry ? foregroundEntry.displayName : null
        const currentAppPackage = foregroundEntry ? foregroundPkg : null
        const todayScreenTimeSeconds = apps.reduce((sum, a) => sum + (a.todaySeconds || 0), 0)

        const now = Date.now()

        // Store today's full session list under a single overwriting key per
        // (child, date). Android returns today's full list each flush; Windows'
        // takeSessions() drains new events only, so we merge incoming with any
        // existing snapshot (dedup on packageName+startedAt, keep longest
        // duration) before writing. Sending the full list downstream means a
        // parent that missed earlier flushes still gets the complete day on
        // reconnect.
        const incomingSessions = args.sessions || []
        const dateStr = localDateStr(now)
        const sessionKey = 'sessions:' + (childPublicKey || 'local') + ':' + dateStr + ':full'
        const existingRaw = await ctx.db.get(sessionKey).catch(() => null)
        const mergedSessions = mergeSessions(existingRaw?.value, incomingSessions)
        if (mergedSessions.length > 0) {
          await ctx.db.put(sessionKey, mergedSessions)
        }

        // Piggyback resolved request statuses so co-parents get updates (#122).
        // Collect all non-pending req: entries from child's Hyperbee.
        const resolvedRequests = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
          if (value.status && value.status !== 'pending') {
            resolvedRequests.push({
              requestId: value.id,
              status: value.status,
              packageName: value.packageName,
              resolvedAt: value.resolvedAt || value.requestedAt,
            })
          }
        }
        if (resolvedRequests.length > 0) log('[bare] usage:flush piggyback:', resolvedRequests.length, 'resolved requests')

        // dailyTotals: per-day per-app aggregates from the native UsageStatsManager
        // for the last N days. Carries the full window each flush so the parent
        // backfills any days it missed automatically. Empty array on platforms
        // that don't supply it (e.g. iOS, older Windows builds).
        const dailyTotals = Array.isArray(args.dailyTotals) ? args.dailyTotals : []

        const report = {
          type: 'usage:report',
          timestamp: now,
          // Which day this device thinks it is on, and by how much its clock is
          // offset from UTC. Without these the parent files a child's evening
          // under whatever date the PARENT's clock says, so a family split
          // across zones loses the child's newest day entirely and misfiles the
          // rest by one.
          localDate: dateStr,
          tzOffsetMinutes: -new Date().getTimezoneOffset(),
          lastSynced: now,
          apps,
          sessions: mergedSessions,
          pinOverrides: pinLog,
          childPublicKey,
          currentApp,
          currentAppPackage,
          todayScreenTimeSeconds,
          resolvedRequests,
          dailyTotals,
        }

        // Persist report to Hyperbee (single overwriting key per child's own copy).
        await ctx.db.put('usage:latest', report)

        ctx.send({ type: 'event', event: 'usage:report', data: report })

        if (ctx.sendToAllParents) {
          await ctx.sendToAllParents({ type: 'usage:report', payload: report })
        }

        // Clear PIN log for next reporting period
        await ctx.db.put('pinLog', [])

        return { flushed: true, timestamp: report.timestamp }
      }

      case 'usage:getExclusions': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid usage:getExclusions args')
        const raw = await ctx.db.get('usageExclusions:' + childPublicKey).catch(() => null)
        const map = raw?.value?.packages || {}
        return Object.keys(map).filter((p) => map[p]).map((p) => {
          const entry = map[p]
          return { packageName: p, displayName: (entry && entry.displayName) || p }
        })
      }

      case 'usage:setExclusion': {
        const { childPublicKey, packageName, displayName, excluded } = args
        if (!childPublicKey || !packageName) throw new Error('invalid usage:setExclusion args')
        const raw = await ctx.db.get('usageExclusions:' + childPublicKey).catch(() => null)
        const map = { ...(raw?.value?.packages || {}) }
        if (excluded) map[packageName] = { displayName: displayName || packageName, excludedAt: Date.now() }
        else delete map[packageName]
        await ctx.db.put('usageExclusions:' + childPublicKey, { packages: map, updatedAt: Date.now() })
        // Re-emit the latest usage report with the new exclusion applied so
        // Dashboard and Usage tab update without waiting for the next flush.
        const latestRaw = await ctx.db.get('usageReport:' + childPublicKey + ':latest').catch(() => null)
        if (latestRaw?.value) {
          const exclusions = await getExclusions(ctx.db, childPublicKey)
          const filtered = dateGateReport(applyExclusionsToReport(latestRaw.value, exclusions))
          ctx.send({ type: 'event', event: 'usage:report', data: { ...filtered, childPublicKey } })
        }
        return { packages: Object.keys(map).filter((p) => map[p]) }
      }

      case 'usage:getLatest': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid usage:getLatest args')
        const exclusions = await getExclusions(ctx.db, childPublicKey)
        // The stored report may name apps by slug (see resolveAppName); the
        // policy we hold for this child has the friendly names.
        const policyRaw = await ctx.db.get('policy:' + childPublicKey).catch(() => null)
        const policyApps = policyRaw?.value?.apps || {}
        const present = (r) => dateGateReport(applyPolicyNamesToReport(applyExclusionsToReport(r, exclusions), policyApps))
        // Fast path: single overwriting key.
        const direct = await ctx.db.get('usageReport:' + childPublicKey + ':latest').catch(() => null)
        if (direct?.value) return present(direct.value)
        // Fallback for pre-migration data that still uses timestamped keys.
        let latest = null
        for await (const { value } of ctx.db.createReadStream({
          gt: 'usageReport:' + childPublicKey + ':',
          lt: 'usageReport:' + childPublicKey + ':~',
          reverse: true,
          limit: 1,
        })) {
          latest = value
        }
        return latest ? present(latest) : null
      }

      case 'usage:getSessions': {
        const { childPublicKey, date } = args
        if (!childPublicKey || !date) throw new Error('invalid usage:getSessions args')
        const exclusions = await getExclusions(ctx.db, childPublicKey)
        // Sessions from the desktop child can carry displayName: null, so the
        // Reports drill-down would label them with the slug. Same policy join.
        const policyRaw = await ctx.db.get('policy:' + childPublicKey).catch(() => null)
        const policyApps = policyRaw?.value?.apps || {}
        const bestByKey = new Map()
        for await (const { value } of ctx.db.createReadStream({
          gt: 'sessions:' + childPublicKey + ':' + date + ':',
          lt: 'sessions:' + childPublicKey + ':' + date + ':~',
        })) {
          if (!Array.isArray(value)) continue
          for (const s of value) {
            if (exclusions.has(s.packageName)) continue
            // Dedup prefers the longest snapshot for a given (pkg, startedAt):
            // open-session snapshots from earlier flushes get replaced once the
            // closed version arrives.
            const key = s.packageName + ':' + s.startedAt
            const existing = bestByKey.get(key)
            if (!existing || (s.durationSeconds || 0) > (existing.durationSeconds || 0)) {
              bestByKey.set(key, s)
            }
          }
        }
        return Array.from(bestByKey.values()).map((s) => ({
          ...s,
          displayName: resolveAppName(s.packageName, policyApps[s.packageName]?.appName, s.displayName),
        }))
      }

      case 'usage:getDailySummaries': {
        const { childPublicKey, days, packageName } = args
        if (!childPublicKey || !days) throw new Error('invalid usage:getDailySummaries args')
        const exclusions = await getExclusions(ctx.db, childPublicKey)
        const summaries = []
        // Walk the CHILD's days, not ours. A parent nine hours behind used to ask
        // for three dates that did not include the child's newest one at all.
        const zoneOffset = await childZoneOffset(ctx.db, childPublicKey)
        const now = Date.now()
        const todayStr = dateStrInZone(now, zoneOffset)
        for (let i = 0; i < days; i++) {
          const dateStr = dateStrInZone(now - i * 86400000, zoneOffset)

          // For the current calendar day, always read from sessions: -
          // Android's INTERVAL_DAILY active bucket is not midnight-aligned
          // (it rolls over ~24h after device boot/reset), so today's
          // foreground time gets attributed to yesterday's date string in
          // dailyTotals. sessions: is captured live from RESUMED/PAUSED
          // events with proper midnight handling, so it's the calendar-
          // accurate source for today.
          //
          // For past days, prefer dailyTotals (covers days the parent
          // missed live) and fall back to sessions if the row is missing
          // or empty.
          const totalsRaw = dateStr === todayStr
            ? null
            : await ctx.db.get('dailyTotals:' + childPublicKey + ':' + dateStr).catch(() => null)
          if (totalsRaw?.value && Array.isArray(totalsRaw.value.apps) && totalsRaw.value.apps.length > 0) {
            let totalSeconds = 0
            let appCount = 0
            for (const a of totalsRaw.value.apps) {
              if (!a || !a.packageName) continue
              if (packageName && a.packageName !== packageName) continue
              if (isSystemPackage(a.packageName)) continue
              if (exclusions.has(a.packageName)) continue
              totalSeconds += a.secondsToday || 0
              appCount += 1
            }
            summaries.push({ date: dateStr, totalSeconds, sessionCount: appCount })
            continue
          }

          // Legacy fallback: rebuild from sessions with per-(pkg, startedAt)
          // dedup so open-session deltas collapse into their closed counterparts
          // before we sum.
          const bestByKey = new Map()
          for await (const { value } of ctx.db.createReadStream({
            gt: 'sessions:' + childPublicKey + ':' + dateStr + ':',
            lt: 'sessions:' + childPublicKey + ':' + dateStr + ':~',
          })) {
            if (!Array.isArray(value)) continue
            for (const s of value) {
              if (packageName && s.packageName !== packageName) continue
              if (isSystemPackage(s.packageName)) continue
              if (exclusions.has(s.packageName)) continue
              const key = s.packageName + ':' + s.startedAt
              const existing = bestByKey.get(key)
              if (!existing || (s.durationSeconds || 0) > (existing.durationSeconds || 0)) {
                bestByKey.set(key, s)
              }
            }
          }
          let totalSeconds = 0
          for (const s of bestByKey.values()) totalSeconds += s.durationSeconds || 0
          summaries.push({ date: dateStr, totalSeconds, sessionCount: bestByKey.size })
        }
        return summaries
      }

      case 'usage:debugSessions': {
        const { childPublicKey, date } = args
        if (!childPublicKey || !date) throw new Error('invalid args')
        const exclusions = await getExclusions(ctx.db, childPublicKey)
        let entryCount = 0
        let rawCount = 0
        let rawSeconds = 0
        const bestByKey = new Map()
        const samples = []
        for await (const { key, value } of ctx.db.createReadStream({
          gt: 'sessions:' + childPublicKey + ':' + date + ':',
          lt: 'sessions:' + childPublicKey + ':' + date + ':~',
        })) {
          entryCount++
          if (!Array.isArray(value)) continue
          for (const s of value) {
            if (exclusions.has(s.packageName)) continue
            rawCount++
            rawSeconds += s.durationSeconds || 0
            const dk = s.packageName + ':' + s.startedAt
            const existing = bestByKey.get(dk)
            if (!existing || (s.durationSeconds || 0) > (existing.durationSeconds || 0)) {
              bestByKey.set(dk, s)
            }
            if (samples.length < 20) samples.push({ pkg: s.packageName, startedAt: s.startedAt, dur: s.durationSeconds, startType: typeof s.startedAt })
          }
        }
        let dedupSeconds = 0
        for (const s of bestByKey.values()) dedupSeconds += s.durationSeconds || 0
        return { entryCount, rawCount, rawSeconds, dedupCount: bestByKey.size, dedupSeconds, samples }
      }

      case 'usage:getCategorySummary': {
        const { childPublicKey, date, days } = args
        if (!childPublicKey || (!date && !days)) throw new Error('invalid usage:getCategorySummary args')
        const policyRaw = await ctx.db.get('policy:' + childPublicKey)
        const policyApps = policyRaw?.value?.apps || {}
        const exclusions = await getExclusions(ctx.db, childPublicKey)

        // Build the list of dates we'll aggregate over.
        const dates = []
        const zoneOffset = await childZoneOffset(ctx.db, childPublicKey)
        const nowMs = Date.now()
        if (days && days > 1) {
          for (let i = 0; i < days; i++) {
            dates.push(dateStrInZone(nowMs - i * 86400000, zoneOffset))
          }
        } else {
          dates.push(date || dateStrInZone(nowMs, zoneOffset))
        }

        // For each date, prefer dailyTotals (native aggregates) for past
        // days and sessions: for the current calendar day - INTERVAL_DAILY's
        // active bucket isn't midnight-aligned, so today's foreground time
        // gets misattributed to yesterday's date string in dailyTotals.
        // sessions: tracks midnight boundaries correctly.
        const perAppSeconds = new Map()
        const perAppDisplayName = new Map()
        // "Is this the current day" is the child's question too: their midnight
        // is the one the native daily bucket is misaligned against.
        const todayStr = dateStrInZone(nowMs, zoneOffset)
        for (const dateStr of dates) {
          const totalsRaw = dateStr === todayStr
            ? null
            : await ctx.db.get('dailyTotals:' + childPublicKey + ':' + dateStr).catch(() => null)
          if (totalsRaw?.value && Array.isArray(totalsRaw.value.apps) && totalsRaw.value.apps.length > 0) {
            for (const a of totalsRaw.value.apps) {
              if (!a || !a.packageName) continue
              const prev = perAppSeconds.get(a.packageName) || 0
              perAppSeconds.set(a.packageName, prev + (a.secondsToday || 0))
              if (a.displayName) perAppDisplayName.set(a.packageName, a.displayName)
            }
            continue
          }
          // Legacy fallback: rebuild from sessions with longest-duration dedup.
          const bestByKey = new Map()
          for await (const { value } of ctx.db.createReadStream({
            gt: 'sessions:' + childPublicKey + ':' + dateStr + ':',
            lt: 'sessions:' + childPublicKey + ':' + dateStr + ':~',
          })) {
            if (!Array.isArray(value)) continue
            for (const s of value) {
              const k = s.packageName + ':' + s.startedAt
              const existing = bestByKey.get(k)
              if (!existing || (s.durationSeconds || 0) > (existing.durationSeconds || 0)) {
                bestByKey.set(k, s)
              }
            }
          }
          for (const s of bestByKey.values()) {
            const prev = perAppSeconds.get(s.packageName) || 0
            perAppSeconds.set(s.packageName, prev + (s.durationSeconds || 0))
            if (s.displayName) perAppDisplayName.set(s.packageName, s.displayName)
          }
        }

        const categories = {}
        for (const [pkg, seconds] of perAppSeconds.entries()) {
          if (exclusions.has(pkg)) continue
          const appInfo = policyApps[pkg]
          // Skip apps not in policy (system apps that slipped through)
          if (!appInfo) continue
          const category = appInfo.category || 'Other'
          if (!categories[category]) {
            categories[category] = { category, totalSeconds: 0, apps: {} }
          }
          categories[category].totalSeconds += seconds
          categories[category].apps[pkg] = {
            packageName: pkg,
            // Policy name first: stored totals/sessions can carry the slug as
            // their displayName (see resolveAppName).
            displayName: resolveAppName(pkg, appInfo.appName, perAppDisplayName.get(pkg)),
            totalSeconds: seconds,
            iconBase64: appInfo?.iconBase64 || null,
          }
        }
        const result = Object.values(categories).map((cat) => ({
          ...cat,
          apps: Object.values(cat.apps).sort((a, b) => b.totalSeconds - a.totalSeconds),
        }))
        result.sort((a, b) => b.totalSeconds - a.totalSeconds)
        return result
      }

      case 'policy:get': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid policy:get args')
        const raw = await ctx.db.get('policy:' + childPublicKey)
        return raw ? raw.value : { apps: {} }
      }

      case 'app:decide': {
        const { childPublicKey, packageName, decision } = args
        if (!childPublicKey || !packageName || !['approve', 'deny'].includes(decision)) {
          throw new Error('invalid app:decide args')
        }
        const raw = await ctx.db.get('policy:' + childPublicKey)
        const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
        if (!policy.apps) policy.apps = {}
        const d = decision === 'approve' ? 'allowed' : 'blocked'
        policy.apps[packageName] = { ...(policy.apps[packageName] || {}), status: d }
        policy.version = (policy.version || 0) + 1
        await ctx.db.put('policy:' + childPublicKey, policy)
        try {
          // sendToPeer requires the Hyperswarm noise key, not the identity key.
          // The stored peer record contains noiseKey for this cross-lookup.
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'app:decision', payload: { packageName, decision: d } })
          }
        } catch (_e) {
          // child offline — policy stored; will be sent on next reconnect
        }

        // Mark matching pending requests for this child+package as resolved in Hyperbee
        // so ActivityTab shows the correct status after navigating away and back.
        const reqStatus = d === 'allowed' ? 'approved' : 'denied'
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value.childPublicKey === childPublicKey && value.packageName === packageName && value.status === 'pending') {
            await ctx.db.put(key, { ...value, status: reqStatus })
          }
        }

        // Notify AppsTab to reload so the status change is reflected immediately (#70).
        ctx.send({ type: 'event', event: 'apps:synced', data: { childPublicKey } })
        return { ok: true, decision: d }
      }

      case 'apps:decideBatch': {
        const { childPublicKey, packageNames, decision } = args
        if (!childPublicKey || !Array.isArray(packageNames) || packageNames.length === 0 || !['approve', 'deny'].includes(decision)) {
          throw new Error('invalid apps:decideBatch args')
        }
        const raw = await ctx.db.get('policy:' + childPublicKey)
        const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
        if (!policy.apps) policy.apps = {}
        const d = decision === 'approve' ? 'allowed' : 'blocked'

        for (const packageName of packageNames) {
          policy.apps[packageName] = { ...(policy.apps[packageName] || {}), status: d }
        }
        policy.version = (policy.version || 0) + 1
        await ctx.db.put('policy:' + childPublicKey, policy)

        // Push full policy to child in one shot — avoids per-app notifications
        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
          }
        } catch (_e) {}

        // Mark matching pending requests as resolved
        const reqStatus = d === 'allowed' ? 'approved' : 'denied'
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value.childPublicKey === childPublicKey && packageNames.includes(value.packageName) && value.status === 'pending') {
            await ctx.db.put(key, { ...value, status: reqStatus })
          }
        }

        ctx.send({ type: 'event', event: 'apps:synced', data: { childPublicKey } })
        return { ok: true, decision: d, count: packageNames.length }
      }

      case 'policy:update': {
        const { childPublicKey, policy } = args
        if (!childPublicKey || !policy || typeof policy !== 'object') {
          throw new Error('invalid policy:update args')
        }
        // Merge parent settings into policy so they reach the child device
        const settingsRaw = await ctx.db.get('parentSettings')
        const parentSettings = settingsRaw ? settingsRaw.value : {}
        const newPolicy = { ...policy, childPublicKey, settings: parentSettings, version: (policy.version || 0) + 1 }
        await ctx.db.put('policy:' + childPublicKey, newPolicy)
        try {
          // sendToPeer requires the Hyperswarm noise key, not the identity key.
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: newPolicy })
          }
        } catch (_e) {
          // child offline — policy stored; will be sent on reconnect
        }
        return { ok: true }
      }

      case 'policy:setLock': {
        const { childPublicKey, locked, lockMessage, lockUntil } = args
        if (!childPublicKey) throw new Error('invalid policy:setLock args')
        const raw = await ctx.db.get('policy:' + childPublicKey)
        const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
        policy.locked = !!locked
        if (locked) {
          const msg = typeof lockMessage === 'string' ? lockMessage.trim() : ''
          policy.lockMessage = msg ? msg.slice(0, 280) : ''
          // Lock and free-time pause are opposites — locking cancels any pause.
          delete policy.pauseUntil
          // An end time only counts if it is actually ahead of us; anything else
          // means "until I unlock", which is the lock we have always had.
          const until = Number(lockUntil)
          if (Number.isFinite(until) && until > Date.now()) policy.lockUntil = until
          else delete policy.lockUntil
        } else {
          policy.lockMessage = ''
          delete policy.lockUntil
        }
        policy.version = (policy.version || 0) + 1
        await ctx.db.put('policy:' + childPublicKey, policy)
        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
          }
        } catch (_e) {
          // child offline — policy stored; will be sent on reconnect
        }
        return { ok: true }
      }

      case 'policy:setPause': {
        // Free-time / holiday mode: suspend ALL enforcement until `pauseUntil`
        // (epoch ms). The inverse of policy:setLock. A non-future value clears the
        // pause (resume protection now). Mutually exclusive with a device lock.
        const { childPublicKey, pauseUntil } = args
        if (!childPublicKey) throw new Error('invalid policy:setPause args')
        const raw = await ctx.db.get('policy:' + childPublicKey)
        const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
        const until = Number(pauseUntil)
        if (Number.isFinite(until) && until > Date.now()) {
          policy.pauseUntil = until
          policy.locked = false
          policy.lockMessage = ''
        } else {
          delete policy.pauseUntil
        }
        policy.version = (policy.version || 0) + 1
        await ctx.db.put('policy:' + childPublicKey, policy)
        try {
          const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) {
            ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
          }
        } catch (_e) {
          // child offline — policy stored; will be sent on reconnect
        }
        return { ok: true, pauseUntil: policy.pauseUntil || 0 }
      }

      case 'settings:get': {
        const raw = await ctx.db.get('parentSettings')
        return raw ? raw.value : {}
      }

      case 'settings:save': {
        const { settings } = args
        if (!settings || typeof settings !== 'object') throw new Error('invalid settings:save args')
        await ctx.db.put('parentSettings', settings)

        // Push updated settings into all child policies. Collect the keys first,
        // then re-read each record under its lock: the streamed value may be
        // stale by the time this loop reaches it.
        const childKeys = []
        for await (const { key } of ctx.db.createReadStream({ gt: 'policy:', lt: 'policy:~' })) {
          childKeys.push(key.replace(/^policy:/, ''))
        }
        for (const childKey of childKeys) {
          await withPolicyLock(childKey, async () => {
            const raw = await ctx.db.get('policy:' + childKey).catch(() => null)
            if (!raw || !raw.value) return
            const updated = { ...raw.value, settings, version: (raw.value.version || 0) + 1 }
            await ctx.db.put('policy:' + childKey, updated)
            try {
              const peerRecord = await ctx.db.get('peers:' + childKey).catch(() => null)
              const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
              if (noiseKey) ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: updated })
            } catch (_e) {}
          })
        }
        return { ok: true }
      }

      case 'relay:status': {
        // Read-only diagnostics for Settings -> Connection. Null when the worklet
        // predates the relay (an older vendored bare.js on desktop), which the UI
        // renders as "unavailable" rather than as "off".
        return ctx.relayStatus ? ctx.relayStatus() : null
      }

      case 'settings:setTheme': {
        const { theme } = args
        if (!theme || typeof theme !== 'string') throw new Error('invalid settings:setTheme args')
        await ctx.db.put('settings:theme', theme)
        return {}
      }

      case 'settings:getTheme': {
        const entry = await ctx.db.get('settings:theme')
        return { theme: entry ? entry.value.toString() : 'dark' }
      }

      case 'donation:check': {
        const identityRaw = await ctx.db.get('identity')
        const createdAt = identityRaw && identityRaw.value && identityRaw.value.createdAt
        const dismissedRaw = await ctx.db.get('donationReminderDismissed')
        const dismissed = !!(dismissedRaw && dismissedRaw.value)
        return { createdAt: createdAt || null, dismissed }
      }

      case 'donation:dismiss': {
        await ctx.db.put('donationReminderDismissed', true)
        return { ok: true }
      }

      // Let the parent clear alert history. Deliberately scoped to `alert:` rows
      // only: the Activity feed is also fed from `request:` rows, and those are
      // ACTIONABLE (a pending approval or time request). Deleting one of those
      // here would silently drop a child's request instead of dismissing a piece
      // of history, so requests are untouchable from this path — the child would
      // wait forever for an answer that was thrown away.
      case 'alerts:dismiss': {
        const { childPublicKey, timestamp } = args
        if (!childPublicKey || !timestamp) throw new Error('invalid alerts:dismiss args')
        await ctx.db.del('alert:' + childPublicKey + ':' + timestamp)
        return { dismissed: 1 }
      }

      case 'alerts:clear': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid alerts:clear args')
        const keys = []
        for await (const { key } of ctx.db.createReadStream({
          gt: 'alert:' + childPublicKey + ':',
          lt: 'alert:' + childPublicKey + ':~',
        })) {
          keys.push(key)
        }
        // Collect first, delete after: mutating a Hyperbee while streaming it is
        // asking for a skipped row.
        for (const key of keys) await ctx.db.del(key)
        log('[bare] cleared', keys.length, 'alerts for', childPublicKey.slice(0, 8))
        return { dismissed: keys.length }
      }

      case 'alerts:list': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid alerts:list args')
        const results = []
        // Same sweep on the parent's own copies, so the Activity row reads "No
        // answer" instead of the bare "Resolved" an expired request would get.
        await expireUnansweredRequests(ctx.db, 'request:', Date.now())
        const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000 // 7 days

        // Bypass alerts stored when a bypass:alert P2P message was received from this child
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'alert:' + childPublicKey + ':', lt: 'alert:' + childPublicKey + ':~' })) {
          if ((value.timestamp || 0) < cutoff) {
            await ctx.db.del(key) // auto-expire stale alerts
            continue
          }
          // Rows written before the label fix carry the raw reason slug as their
          // display text ("linux:extension-disabled") and are all typed 'bypass',
          // which badges a PearGuard failure as a red Bypass Attempt. Re-derive
          // both from the reason on read, so history reads correctly too.
          results.push(value.reason ? relabelAlert(value) : value)
        }

        // Time requests received from this child
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
          if (value.childPublicKey !== childPublicKey) continue
          if ((value.requestedAt || 0) < cutoff) {
            await ctx.db.del(key)
            continue
          }
          const entry = {
            id: value.id,
            type: 'time_request',
            timestamp: value.requestedAt,
            packageName: value.packageName,
            appDisplayName: value.appName,
            status: value.status,
            resolved: value.status !== 'pending',
            childPublicKey,
            requestType: value.requestType || 'approval',
            // 'install' => the app just appeared and needs a decision; absent =>
            // the child actively asked. The UI must not imply the child begged
            // for an app they merely installed.
            ...(value.origin && { origin: value.origin }),
          }
          // extra_time and general_time both carry a requested duration.
          if (value.requestType !== 'approval' && typeof value.extraSeconds === 'number') {
            entry.extraSeconds = value.extraSeconds
          }
          results.push(entry)
        }

        results.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))

        // Always ask the child for resolution updates when opening Activity tab (#122).
        // iOS may drop P2P messages when backgrounded or during Hyperswarm dedup;
        // this pull-based sync ensures the parent gets updated statuses.
        if (ctx.getMode() === 'parent') {
          try {
            const peerRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
            const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
            if (noiseKey) {
              ctx.sendToPeer(noiseKey, { type: 'requests:syncResolved', payload: { childPublicKey } })
              log('[bare] alerts:list triggered syncResolved for', childPublicKey?.slice(0, 8))
            }
          } catch (e) { console.warn('[bare] alerts:list syncResolved failed:', e.message) }
        }

        return results
      }

      case 'rules:export': {
        const { childPubKey } = args
        if (!childPubKey) throw new Error('invalid rules:export args')
        const policyRaw = await ctx.db.get('policy:' + childPubKey)
        if (!policyRaw) throw new Error('no policy for child ' + childPubKey.slice(0, 8))
        const identityRaw = await ctx.db.get('identity')
        if (!identityRaw) throw new Error('no identity')
        const { buildRulesExport } = require('./backup')
        const json = buildRulesExport(policyRaw.value, childPubKey, identityRaw.value)
        return { json }
      }

      case 'rules:import:preview': {
        const { jsonString, targetChildPubKey } = args
        if (!jsonString || !targetChildPubKey) throw new Error('invalid rules:import:preview args')
        const { parseAndVerify, diffPolicies, KIND_RULES } = require('./backup')
        const { payload } = parseAndVerify(jsonString, KIND_RULES)
        const targetRaw = await ctx.db.get('policy:' + targetChildPubKey).catch(() => null)
        const targetApps = (targetRaw && targetRaw.value && targetRaw.value.apps) || {}
        const sourceApps = (payload.policy && payload.policy.apps) || {}
        const installedSet = new Set(Object.keys(targetApps))
        const diff = diffPolicies(targetRaw?.value, payload.policy, installedSet)
        const nameOf = (pkg) => (sourceApps[pkg]?.appName) || (targetApps[pkg]?.appName) || pkg
        return {
          sourceChildPubKey: payload.sourceChildPubKey,
          targetChildPubKey,
          appsAdded: diff.appsAdded.map(p => ({ packageName: p, appName: nameOf(p) })),
          appsRemoved: diff.appsRemoved.map(p => ({ packageName: p, appName: nameOf(p) })),
          appsChanged: diff.appsChanged.map(p => ({ packageName: p, appName: nameOf(p) })),
          appsSkipped: (diff.appsSkipped || []).map(p => ({ packageName: p, appName: nameOf(p) })),
          schedulesChanged: diff.schedulesChanged
        }
      }

      case 'rules:archives': {
        // Rule sets kept from children that were unpaired, newest first.
        const archives = []
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'policyArchive:', lt: 'policyArchive:~' })) {
          if (!value || !value.policy) continue
          archives.push({
            key,
            displayName: value.displayName || 'Child',
            archivedAt: value.archivedAt || 0,
            appCount: Object.keys(value.policy.apps || {}).length,
            scheduleCount: Array.isArray(value.policy.schedules) ? value.policy.schedules.length : 0,
            hasScreenTimeLimit: !!(value.policy.dailyScreenTimeLimitSeconds > 0),
          })
        }
        archives.sort((a, b) => b.archivedAt - a.archivedAt)
        return { archives }
      }

      case 'rules:restoreArchive': {
        // Apply a kept rule set to a child paired now. Same merge the rules
        // import uses, in intersect mode: only rules for apps this device
        // actually has, and anything it has that the archive never mentioned
        // keeps whatever it has now.
        const { archiveKey, targetChildPubKey } = args || {}
        if (!archiveKey || !targetChildPubKey) throw new Error('invalid rules:restoreArchive args')
        const archiveRaw = await ctx.db.get(archiveKey).catch(() => null)
        if (!archiveRaw || !archiveRaw.value || !archiveRaw.value.policy) return { ok: false, reason: 'not-found' }
        const { mergeRulesIntoPolicy } = require('./backup')
        return await withPolicyLock(targetChildPubKey, async () => {
          const targetRaw = await ctx.db.get('policy:' + targetChildPubKey).catch(() => null)
          const installedSet = new Set(Object.keys((targetRaw && targetRaw.value && targetRaw.value.apps) || {}))
          const merged = mergeRulesIntoPolicy(targetRaw?.value, archiveRaw.value.policy, targetChildPubKey, installedSet)
          merged.version = ((targetRaw && targetRaw.value && targetRaw.value.version) || 0) + 1
          await ctx.db.put('policy:' + targetChildPubKey, merged)
          try {
            const peerRecord = await ctx.db.get('peers:' + targetChildPubKey).catch(() => null)
            const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
            if (noiseKey) ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: stripAppIcons(merged) })
          } catch (_e) {
            // child offline; the stored policy goes out on its next hello
          }
          ctx.send({ type: 'event', event: 'policy:updated', data: merged })
          return { ok: true, appCount: Object.keys(merged.apps || {}).length }
        })
      }

      case 'rules:forgetArchive': {
        const { archiveKey } = args || {}
        if (!archiveKey || !archiveKey.startsWith('policyArchive:')) throw new Error('invalid rules:forgetArchive args')
        await ctx.db.del(archiveKey).catch(() => {})
        return { ok: true }
      }

      case 'rules:import:apply': {
        const { jsonString, targetChildPubKey } = args
        if (!jsonString || !targetChildPubKey) throw new Error('invalid rules:import:apply args')
        const { parseAndVerify, mergeRulesIntoPolicy, KIND_RULES } = require('./backup')
        const { payload } = parseAndVerify(jsonString, KIND_RULES)
        const targetRaw = await ctx.db.get('policy:' + targetChildPubKey).catch(() => null)
        const installedSet = new Set(Object.keys((targetRaw && targetRaw.value && targetRaw.value.apps) || {}))
        const merged = mergeRulesIntoPolicy(targetRaw?.value, payload.policy, targetChildPubKey, installedSet)
        await ctx.db.put('policy:' + targetChildPubKey, merged)
        try {
          const peerRecord = await ctx.db.get('peers:' + targetChildPubKey).catch(() => null)
          const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
          if (noiseKey) ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: merged })
        } catch (_e) {}
        return { ok: true }
      }

      case 'backup:export': {
        const identityRaw = await ctx.db.get('identity')
        if (!identityRaw) throw new Error('no identity')
        const profileRaw = await ctx.db.get('profile').catch(() => null)
        const settingsRaw = await ctx.db.get('parentSettings').catch(() => null)
        const parentPolicyRaw = await ctx.db.get('policy').catch(() => null)
        const peers = []
        for await (const { value } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          peers.push(value)
        }
        const policies = {}
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'policy:', lt: 'policy:~' })) {
          policies[key.replace(/^policy:/, '')] = value
        }
        const { buildBackup } = require('./backup')
        const json = buildBackup({
          identity: identityRaw.value,
          profile: profileRaw ? profileRaw.value : null,
          parentSettings: settingsRaw ? settingsRaw.value : null,
          parentPolicy: parentPolicyRaw ? parentPolicyRaw.value : null,
          peers,
          policies
        })
        return { json, peerCount: peers.length, policyCount: Object.keys(policies).length }
      }

      case 'backup:import': {
        const { jsonString, allowOverwrite } = args
        if (!jsonString) throw new Error('invalid backup:import args')
        const { parseAndVerify, KIND_BACKUP } = require('./backup')
        const { payload } = parseAndVerify(jsonString, KIND_BACKUP)
        const existingIdentity = await ctx.db.get('identity').catch(() => null)
        if (existingIdentity && !allowOverwrite) {
          throw new Error('Device not fresh: identity already exists. Clear app data before importing.')
        }
        await ctx.db.put('identity', payload.identity)
        if (payload.profile) await ctx.db.put('profile', payload.profile)
        if (payload.parentSettings) await ctx.db.put('parentSettings', payload.parentSettings)
        if (payload.parentPolicy) await ctx.db.put('policy', payload.parentPolicy)
        await ctx.db.put('mode', 'parent')
        const paired = []
        for (const peer of payload.peers || []) {
          if (!peer || !peer.publicKey) continue
          await ctx.db.put('peers:' + peer.publicKey, peer)
          paired.push(peer.publicKey)
        }
        for (const [childKey, policy] of Object.entries(payload.policies || {})) {
          await ctx.db.put('policy:' + childKey, policy)
        }
        return { ok: true, paired, restartRequired: true }
      }

      case 'storage:breakdown': {
        if (!ctx.storageBreakdown) throw new Error('storageBreakdown unavailable')
        return await ctx.storageBreakdown()
      }

      case 'storage:analyze': {
        if (!ctx.analyzeStorage) throw new Error('analyzeStorage unavailable')
        return await ctx.analyzeStorage()
      }

      case 'storage:rebuild': {
        if (!ctx.rebuildLocalDb) throw new Error('rebuildLocalDb unavailable')
        // This handler itself is counted in _inflightHandlers; tell rebuild
        // to exclude 1 from its drain target so it doesn't time out waiting
        // on its own caller.
        return await ctx.rebuildLocalDb({ selfInflight: 1 })
      }

      default:
        throw new Error('unknown method: ' + method)
    }
  }

  return async function dispatch (method, args) {
    const childKey = POLICY_WRITE_METHODS.has(method) && args && typeof args === 'object'
      ? (args.childPublicKey || args.targetChildPubKey)
      : null
    if (childKey) return withPolicyLock(childKey, () => dispatchInner(method, args))
    return dispatchInner(method, args)
  }
}

/**
 * Handle a verified `app:decision` P2P message from a parent peer.
 * Extracted for testability — called from bare.js handlePeerMessage.
 *
 * @param {object} payload — { packageName, decision }
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare→RN IPC send function
 */
async function handleAppDecision (payload, db, send, sendToAllParents) {
  const { packageName, decision } = payload
  if (!packageName || !['allowed', 'blocked'].includes(decision)) {
    console.warn('[bare] app:decision: malformed payload')
    return
  }

  const raw = await db.get('policy')
  if (!raw) return
  const policy = raw.value

  if (!policy.apps) policy.apps = {}
  policy.apps[packageName] = { ...(policy.apps[packageName] || {}), status: decision }

  await db.put('policy', policy)
  send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })
  send({ type: 'event', event: 'policy:updated', data: policy })

  // Relay the updated policy to all OTHER parents so co-parents stay in sync.
  if (sendToAllParents) {
    sendToAllParents({ type: 'policy:update', payload: policy })
  }

  // Update any pending time requests for this package so the child's request
  // list reflects the parent's decision ('allowed' -> 'approved', 'blocked' -> 'denied').
  const requestStatus = decision === 'allowed' ? 'approved' : 'denied'
  // Only emit request:updated (which triggers a child notification) when a
  // pending request actually exists. Proactive parent decisions (approve/deny
  // from the Apps tab without a child request) should NOT notify the child.
  for await (const { key, value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
    if (value.packageName === packageName && value.status === 'pending') {
      const updated = { ...value, status: requestStatus }
      await db.put(key, updated)
      send({ type: 'event', event: 'request:updated', data: { requestId: value.id, status: requestStatus, packageName: value.packageName, appName: value.appName || value.packageName } })
      // Broadcast resolution to all parents so co-parent activity lists update (#122)
      if (sendToAllParents) {
        sendToAllParents({ type: 'request:resolved', payload: { requestId: value.id, status: requestStatus, packageName: value.packageName, appName: value.appName, resolvedAt: Date.now() } })
      }
    }
  }
}

/**
 * Handle a verified `policy:update` P2P message from a parent peer.
 * Extracted for testability — called from bare.js handlePeerMessage.
 *
 * @param {object} payload — the policy object from msg.payload
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare→RN IPC send function
 */
async function handlePolicyUpdate (payload, db, send, sendToAllParents, senderKey, replyToSender) {
  if (typeof payload.version !== 'number' || !payload.childPublicKey) {
    console.warn('[bare] policy:update ignored: invalid payload (missing version or childPublicKey)')
    return
  }

  // Merge pinHashes so that each parent's PIN survives the other parent's policy push.
  // If the incoming payload has legacy pinHash but no pinHashes (sender running old code),
  // convert it using the sender's identity key.
  if (payload.pinHash && (!payload.pinHashes || Object.keys(payload.pinHashes).length === 0) && senderKey) {
    payload.pinHashes = { [senderKey]: payload.pinHash }
  }
  const existing = await db.get('policy').catch(() => null)
  const existingVersion = (existing && existing.value && typeof existing.value.version === 'number')
    ? existing.value.version
    : -1
  // Reject pushes older than what we already have. A parent reconnecting with
  // stale local state (its co-parent edited while it was offline) would otherwise
  // overwrite the newer policy and the relay would propagate the rollback to
  // every other parent.
  if (payload.version < existingVersion) {
    console.warn('[bare] policy:update ignored: stale version', payload.version, '<', existingVersion, 'from', senderKey?.slice(0, 8))
    // Dropping the push silently left the parent behind: its copy is older than
    // ours, so every further edit it makes is also rejected until its counter
    // happens to overtake, and it never finds out (2026-09-03, "7 < 9"). Hand it
    // our current copy instead. It is strictly newer, so the parent's
    // shouldAcceptRelayedPolicy takes it and the parent is current in one round
    // trip; its rejected edit shows up as reverted in its own UI rather than as
    // silently lost.
    if (replyToSender && senderKey && existing && existing.value) {
      try {
        replyToSender(senderKey, { type: 'policy:update', payload: stripAppIcons(existing.value) })
      } catch (e) {
        console.warn('[bare] could not send current policy back to parent', senderKey.slice(0, 8), e.message)
      }
    }
    return
  }
  const existingPinHashes = (existing && existing.value && existing.value.pinHashes) || {}
  const incomingPinHashes = payload.pinHashes || {}
  payload.pinHashes = { ...existingPinHashes, ...incomingPinHashes }
  delete payload.pinHash  // ensure legacy field is cleaned up

  // A parent on current code never sends icons, but an older parent does, and
  // they would otherwise be stored, parsed by native on every check and relayed
  // to every co-parent.
  payload = stripAppIcons(payload)

  await db.put('policy', payload)
  // Use method format (not event) so the RN shell routes this to
  // NativeModules.UsageStatsModule.setPolicy() via the msg.method === 'native:setPolicy' branch
  // in the bare IPC data handler (app/index.tsx ~line 162).
  // Sending as a type:'event' would only forward it to the WebView, never to the native module.
  send({ method: 'native:setPolicy', args: { json: JSON.stringify(payload) } })
  send({ type: 'event', event: 'policy:updated', data: payload })

  // Relay the policy to all OTHER parents so co-parents stay in sync.
  // The child is the policy sync hub - when any parent pushes a policy, the
  // child stores it, enforces it, and relays it to the other parent(s).
  if (sendToAllParents && senderKey) {
    sendToAllParents({ type: 'policy:update', payload }, senderKey)
  }

  // Then tell every parent which version this device is actually enforcing.
  // Until now a parent stored its edit, skipped the send when the child was
  // offline and showed nothing either way, so "did that rule reach the phone?"
  // had no answer anywhere in the app. The relay above cannot serve as the
  // answer: it excludes the parent that sent the policy, which is exactly the
  // one waiting to hear.
  if (sendToAllParents) {
    sendToAllParents({ type: 'policy:ack', payload: { version: payload.version, at: Date.now() } })
  }

  // Sync pending req:* entries with the new policy so ChildRequests shows the correct status.
  // This handles the case where app:decision was not delivered directly (e.g., child was offline
  // and the parent's decision arrives via the policy:update pushed on reconnect).
  // Only resolve a pending request if the app's status ACTUALLY CHANGED vs. the prior policy.
  // Otherwise a parent re-pushing its cached policy on reconnect would auto-deny any pending
  // request whose app was already blocked (#137).
  const apps = payload.apps || {}
  const prevApps = (existing && existing.value && existing.value.apps) || {}
  for await (const { key, value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
    if (value.status !== 'pending') continue
    const appEntry = apps[value.packageName]
    const appStatus = appEntry && appEntry.status
    const prevStatus = prevApps[value.packageName] && prevApps[value.packageName].status
    if (appStatus === prevStatus) continue
    if (appStatus === 'allowed' || appStatus === 'blocked') {
      const newStatus = appStatus === 'allowed' ? 'approved' : 'denied'
      await db.put(key, { ...value, status: newStatus })
      send({ type: 'event', event: 'request:updated', data: {
        requestId: value.id, status: newStatus,
        packageName: value.packageName, appName: value.appName || value.packageName,
      } })
      // Broadcast resolution to all parents so co-parent activity lists update (#122)
      if (sendToAllParents) {
        sendToAllParents({ type: 'request:resolved', payload: { requestId: value.id, status: newStatus, packageName: value.packageName, appName: value.appName, resolvedAt: Date.now() } })
      }
    }
  }
}

/**
 * Handle a verified `time:extendGeneral` P2P message from a parent peer (#179).
 * Tops up today's device-wide screen-time budget. Creates no override, so
 * schedules, per-app limits and blocked apps are unaffected.
 *
 * @param {object} payload — { requestId, extraSeconds }
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare→RN IPC send function
 */
/**
 * Re-send active grants to a child that just reconnected, so a grant approved
 * while the child was offline is not lost. Replays unexpired per-app overrides
 * and today's device-wide (general) grants. The child dedups by request status,
 * so an already-applied grant is ignored (no double-credit). Returns the number
 * of messages sent. Extracted from bare.js handleHello for direct testing.
 *
 * @param {object} db — parent Hyperbee
 * @param {string} childPublicKey — reconnecting child's identity key (hex)
 * @param {function} sendToPeer — (remoteKeyHex, msg) => void
 * @param {string} remoteKeyHex — the child connection's noise key
 * @param {number} now — current epoch ms
 */
// Kept rule sets are small and rarely wanted, but they must not grow without
// bound on a parent who re-pairs often. Newest few only.
const MAX_RULE_ARCHIVES = 5
async function pruneRuleArchives (db) {
  const keys = []
  for await (const { key } of db.createReadStream({ gt: 'policyArchive:', lt: 'policyArchive:~' })) keys.push(key)
  // The key carries the archive timestamp, so lexical order is chronological.
  keys.sort()
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_RULE_ARCHIVES))) {
    await db.del(key).catch(() => {})
  }
}

/**
 * Parent-side: remember the highest policy version a child has confirmed it is
 * enforcing. Kept out of policy:{child} on purpose - that record is what gets
 * pushed to the child, and an ack field riding along in the push would be both
 * noise and a source of false differences.
 */
async function recordPolicyAck (db, childPublicKey, version, now) {
  if (typeof version !== 'number') return false
  const raw = await db.get('policyAck:' + childPublicKey).catch(() => null)
  const known = raw && raw.value && typeof raw.value.version === 'number' ? raw.value.version : -1
  if (version <= known) return false
  await db.put('policyAck:' + childPublicKey, { version, at: now })
  return true
}

/**
 * Mark the parent-side record for one extra-time grant as delivered, once the
 * child has confirmed it. Returns true when a record was settled.
 */
async function settleDeliveredGrant (db, childPublicKey, requestId, now) {
  for await (const { key, value } of db.createReadStream({ gt: 'override:' + childPublicKey + ':', lt: 'override:' + childPublicKey + ':~' })) {
    if (!value || value.requestId !== requestId || value.awaitingDelivery !== true) continue
    const extraSeconds = typeof value.extraSeconds === 'number' ? value.extraSeconds : 0
    await db.put(key, { ...value, awaitingDelivery: false, deliveredAt: now, expiresAt: now + extraSeconds * 1000 })
    return true
  }
  return false
}

async function replayActiveGrants (db, childPublicKey, sendToPeer, remoteKeyHex, now) {
  let replayed = 0
  for await (const { key, value } of db.createReadStream({ gt: 'override:' + childPublicKey + ':', lt: 'override:' + childPublicKey + ':~' })) {
    if (!value || !value.requestId || !value.packageName || typeof value.extraSeconds !== 'number') continue
    // Records written before delivery tracking existed carry neither field; they
    // keep the old expiry rule rather than being resurrected retroactively.
    const undelivered = value.awaitingDelivery === true && !value.deliveredAt
    if (undelivered) {
      if (now - (value.grantedAt || 0) > UNDELIVERED_GRANT_MAX_AGE_MS) {
        // Too old to spring on the child now. Clear the flag so the parent's Apps
        // tab stops promising time that is never coming.
        await db.put(key, { ...value, awaitingDelivery: false, expiresAt: value.grantedAt || 0 })
        continue
      }
    } else if ((value.expiresAt || 0) <= now) {
      continue
    }
    try {
      sendToPeer(remoteKeyHex, { type: 'time:extend', payload: { requestId: value.requestId, packageName: value.packageName, extraSeconds: value.extraSeconds } })
    } catch (e) {
      console.warn('[bare] could not replay grant to child', childPublicKey.slice(0, 8) + ':', e.message)
      continue
    }
    // The record stays awaiting delivery until the child's request:resolved
    // settles it (see settleDeliveredGrant), so a grant written into a socket
    // that was already dead is re-sent on the next reconnect rather than
    // counted as delivered. The child dedupes a re-send it has already applied
    // and re-confirms it, so this settles on the following reconnect at worst.
    replayed++
  }
  const todayStr = localDateStr(now)
  for await (const { value } of db.createReadStream({ gt: 'screentime:grant:' + childPublicKey + ':', lt: 'screentime:grant:' + childPublicKey + ':~' })) {
    if (value && value.requestId && typeof value.extraSeconds === 'number' &&
        localDateStr(value.grantedAt) === todayStr) {
      sendToPeer(remoteKeyHex, { type: 'time:extendGeneral', payload: { requestId: value.requestId, extraSeconds: value.extraSeconds } })
      replayed++
    }
  }
  return replayed
}

async function handleTimeExtendGeneral (payload, db, send) {
  const { requestId, extraSeconds } = payload || {}
  if (!requestId || typeof extraSeconds !== 'number' || extraSeconds <= 0) {
    console.warn('[bare] time:extendGeneral: malformed payload, dropping')
    return
  }

  // Idempotency: the parent re-sends unexpired grants on every reconnect (so a
  // grant approved while this child was offline is not lost). applyScreenTimeBonus
  // is additive, so without this guard a re-delivered grant would top up the
  // budget again. A request we already marked 'approved' has been applied.
  const existing = await db.get(requestId).catch(() => null)
  if (existing && existing.value && existing.value.status === 'approved') return

  const now = Date.now()
  const bonus = await applyScreenTimeBonus(db, extraSeconds, now)

  // Record the request as approved (creating it if the child never had it) so a
  // later re-send is deduped by the guard above.
  const base = (existing && existing.value) || { id: requestId, requestType: 'general_time' }
  await db.put(requestId, { ...base, status: 'approved', grantedSeconds: extraSeconds })

  // Push the new budget to native enforcement, then tell the child UI.
  send({ method: 'native:setScreenTimeBonus', args: { date: bonus.date, seconds: bonus.seconds } })
  send({ type: 'event', event: 'screentime:granted', data: { extraSeconds, totalBonusSeconds: bonus.seconds } })
}

/**
 * Handle a verified `time:extend` P2P message from a parent peer.
 * Extracted for testability — called from bare.js handlePeerMessage.
 *
 * @param {object} payload — { requestId, packageName, extraSeconds }
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare→RN IPC send function
 */
async function handleTimeExtend (payload, db, send, sendToAllParents) {
  const { requestId, packageName, extraSeconds } = payload
  if (!requestId || !packageName || typeof extraSeconds !== 'number') {
    console.warn('[bare] time:extend: malformed payload, dropping')
    return
  }

  // Idempotency: the parent re-sends unexpired grants on every reconnect (so a
  // grant approved while this child was offline is not lost). Re-applying would
  // create a second override and re-grant native time with a fresh expiry, so
  // skip a request we already marked 'approved'.
  const existing = await db.get(requestId).catch(() => null)
  if (existing && existing.value && existing.value.status === 'approved') {
    // Already applied. Re-confirm it anyway: the parent keeps its copy marked
    // awaiting delivery until it hears this, and the first confirmation can be
    // lost with the connection that carried the grant.
    if (sendToAllParents) {
      sendToAllParents({ type: 'request:resolved', payload: { requestId, status: 'approved', packageName, appName: existing.value.appName || packageName, resolvedAt: existing.value.expiresAt ? existing.value.expiresAt - extraSeconds * 1000 : Date.now() } })
    }
    return
  }

  const expiresAt = Date.now() + extraSeconds * 1000
  const grant = { packageName, grantedAt: Date.now(), expiresAt, source: 'parent-approved' }

  // Update request status in Hyperbee (creating it if the child never had the
  // request, so a later re-send is deduped by the guard above).
  let appName = null
  if (existing && existing.value) {
    const req = existing.value
    appName = req.appName || null
    req.status = 'approved'
    req.expiresAt = expiresAt
    await db.put(requestId, req)
  } else {
    await db.put(requestId, { id: requestId, packageName, requestType: 'extra_time', status: 'approved', expiresAt })
  }

  // Store grant to Hyperbee so overrides:list can find it (#61)
  grant.appName = appName || packageName
  await db.put('override:' + packageName + ':' + grant.grantedAt, grant)

  // Notify native to grant override
  send({ method: 'native:grantOverride', args: grant })

  // Notify WebView — include appName/packageName so the decision notification (#67 fix)
  // can show the real app name instead of "an app".
  send({ type: 'event', event: 'override:granted', data: grant })
  send({ type: 'event', event: 'request:updated', data: { requestId, packageName, appName, status: 'approved', expiresAt } })

  // Broadcast resolution to all parents so co-parent activity lists update (#122)
  if (sendToAllParents) {
    sendToAllParents({ type: 'request:resolved', payload: { requestId, status: 'approved', packageName, appName: appName || packageName, resolvedAt: Date.now() } })
  }
}

/**
 * Append an entry to the `pinLog` array in Hyperbee.
 * Creates the log if it doesn't exist yet.
 *
 * @param {object} entry — { packageName, grantedAt, expiresAt }
 * @param {object} db — Hyperbee instance
 */
// pinLog is normally drained to empty on each successful usage:flush, but a flush
// that early-returns (no app data) skips that clear, so cap the array as a backstop
// against unbounded growth from PIN activity on an otherwise-idle device.
const PIN_LOG_MAX = 500

async function appendPinUseLog (entry, db) {
  const raw = await db.get('pinLog')
  const log = raw ? raw.value : []  // Hyperbee json encoding returns parsed value
  log.push(entry)
  if (log.length > PIN_LOG_MAX) log.splice(0, log.length - PIN_LOG_MAX)
  await db.put('pinLog', log)
}

/**
 * Retrieve the PIN usage log from Hyperbee.
 * Returns an empty array if no log exists yet.
 *
 * @param {object} db — Hyperbee instance
 * @returns {Promise<array>} — array of PIN override entries
 */
async function getPinUseLog (db) {
  const raw = await db.get('pinLog')
  return raw ? raw.value : []
}

// Message types where each new message fully supersedes any older queued copy,
// so the offline queue keeps only the most recent one instead of growing
// unbounded (one heartbeat per minute, one usage:report per flush) while a
// child is disconnected.
// A usage report is a complete snapshot of the day, so an older queued copy is
// pure noise on reconnect: keep only the newest.
const COLLAPSIBLE_MESSAGE_TYPES = new Set(['usage:report'])

// Queued messages live one per key rather than in a single array. The array had
// to be read, rewritten and appended to Hypercore in full for every message,
// and an offline child queues one a minute, so a night offline rewrote a
// payload containing the whole day's usage report several hundred times.
// Deliberately not 'pending:', which would sort together with pendingParent:
// and pendingInviteTopic:.
const PENDING_MSG_PREFIX = 'pendingMsg:'
// Never queued, and dropped on flush if an older build queued them:
//  - heartbeat is presence, and presence an hour stale is worse than none: the
//    parent already knows the child is online from the connection itself, and a
//    replayed heartbeat would hand it the app the child had open an hour ago.
//  - policy:update / policy:ack are for co-parents connected right now. Queued,
//    a relay went back to the parent that authored it and rolled that parent's
//    own copy back (2026-09-03: five old versions replayed at reconnect, the
//    parent regressed, re-announced apps as newly installed and had its next
//    pushes rejected as stale). The hello push already brings a reconnecting
//    parent current.
const NEVER_QUEUED_MESSAGE_TYPES = new Set(['heartbeat', 'policy:update', 'policy:ack'])
// Monotonic within a process; the timestamp orders across restarts.
let _pendingMsgSeq = 0
function pendingMessageKey (now) {
  _pendingMsgSeq = (_pendingMsgSeq + 1) % 10000
  return PENDING_MSG_PREFIX + String(now).padStart(13, '0') + ':' + String(_pendingMsgSeq).padStart(4, '0')
}

/**
 * Queue a message for later delivery when no parent connection is available.
 * Appends to the `pendingMessages` array in Hyperbee. Collapsible message types
 * (see COLLAPSIBLE_MESSAGE_TYPES) replace any prior queued copy of themselves.
 *
 * @param {object} message — the message object to queue
 * @param {object} db — Hyperbee instance
 */
async function queueMessage (message, db) {
  if (!message || NEVER_QUEUED_MESSAGE_TYPES.has(message.type)) return
  const now = Date.now()
  // A newer snapshot supersedes any queued older one. Other types (time:request,
  // pin:override and so on) are distinct events and are never collapsed.
  if (COLLAPSIBLE_MESSAGE_TYPES.has(message.type)) {
    const stale = []
    for await (const { key, value } of db.createReadStream({ gt: PENDING_MSG_PREFIX, lt: PENDING_MSG_PREFIX + '~' })) {
      if (value && value.message && value.message.type === message.type) stale.push(key)
    }
    for (const key of stale) await db.del(key).catch(() => {})
  }
  await db.put(pendingMessageKey(now), { message, queuedAt: now })
}

/**
 * Flush all queued messages by calling writeMessage for each, then clear the queue.
 *
 * @param {object} db — Hyperbee instance
 * @param {function} writeMessage — async function called with each queued message
 * @returns {Promise<number>} — number of messages flushed
 */
async function flushMessageQueue (db, writeMessage) {
  const entries = []
  // Anything an older build left in the single-array queue goes first, in the
  // order it was queued, and the key is dropped once it has been drained.
  const legacyRaw = await db.get('pendingMessages').catch(() => null)
  const legacy = legacyRaw && Array.isArray(legacyRaw.value) ? legacyRaw.value : []
  for (const entry of legacy) entries.push({ key: null, message: entry && entry.message })
  // Keys sort by queued timestamp, so this stream is already in order.
  for await (const { key, value } of db.createReadStream({ gt: PENDING_MSG_PREFIX, lt: PENDING_MSG_PREFIX + '~' })) {
    entries.push({ key, message: value && value.message })
  }
  let sent = 0
  for (const { key, message } of entries) {
    // An older build queued heartbeats and policy relays; drop rather than
    // replay them, for the reasons on NEVER_QUEUED_MESSAGE_TYPES.
    if (message && !NEVER_QUEUED_MESSAGE_TYPES.has(message.type)) {
      await writeMessage(message)
      sent++
    }
    if (key) await db.del(key).catch(() => {})
  }
  if (legacy.length > 0) await db.del('pendingMessages').catch(() => {})
  return sent
}

/**
 * Parent-side: should a policy relayed by the child replace the parent's own
 * copy? Only when it is strictly newer. The child relays every push it accepts
 * (for co-parents) and pushes its current copy at every hello, so a parent
 * routinely hears its own edits back, and a child that is behind (the parent
 * edited while it was offline) pushes an older copy at reconnect. Storing
 * either wholesale rolled the parent back, dropped apps it already knew and
 * left its next pushes rejected by the child as stale.
 */
function shouldAcceptRelayedPolicy (local, incoming) {
  if (!incoming || typeof incoming.version !== 'number') return false
  if (!local || typeof local.version !== 'number') return true
  return incoming.version > local.version
}

/**
 * Handle an incoming `app:installed` P2P message from a child peer.
 * Runs on the PARENT device.
 */
async function handleIncomingAppInstalledUnlocked (payload, childPublicKey, db, send, sendToPeer) {
  const { packageName, appName, iconBase64, category, exeBasename } = payload
  if (!packageName) {
    console.warn('[bare] app:installed from child: missing packageName')
    return
  }

  const raw = await db.get('policy:' + childPublicKey)
  const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
  if (!policy.apps) policy.apps = {}

  // Ensure pinHash is present — same gap as handleIncomingAppsSync after a re-pair.
  if (!policy.pinHash) {
    const parentPolicy = await db.get('policy').catch(() => null)
    if (parentPolicy?.value?.pinHash) policy.pinHash = parentPolicy.value.pinHash
  }

  if (!policy.apps[packageName]) {
    const now = Date.now()
    const autoApproved = await parentAutoApprovesNewApps(db)
    policy.apps[packageName] = { status: autoApproved ? 'allowed' : 'pending', appName: appName || packageName, addedAt: now, ...(iconBase64 && { iconBase64 }), ...(category && { category }), ...(exeBasename && { exeBasename }) }
    policy.version = (policy.version || 0) + 1
    await db.put('policy:' + childPublicKey, policy)

    const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
    const childDisplayName = peerRecord?.value?.displayName || 'Your child'

    // Push updated policy to child so overlay fires immediately when they open the new app
    if (sendToPeer) {
      try {
        const noiseKey = peerRecord && peerRecord.value && peerRecord.value.noiseKey
        if (noiseKey) sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
      } catch (_e) {
        // child offline — stored policy will be pushed on next reconnect via handleHello
      }
    }

    // Write an informational alert entry so it appears in the parent's Alerts tab
    const alertEntry = {
      id: 'app_installed:' + now,
      type: 'app_installed',
      timestamp: now,
      packageName,
      appDisplayName: appName || packageName,
      childPublicKey,
      childDisplayName,
      ...(autoApproved && { autoApproved: true }),
    }
    await db.put('alert:' + childPublicKey + ':' + now, alertEntry)

    // ...and an actionable one, so the parent can decide from the Activity inbox
    // instead of hunting for the app in the Apps tab. An auto-approved app has
    // nothing to decide, so it gets the informational alert only.
    if (!autoApproved) {
      await createInstallApprovalRequest(db, send, {
        childPublicKey, childDisplayName, packageName, appName, now,
      })
    }

    // apps:synced refreshes the Apps tab; app:installed carries data for the notification
    send({ type: 'event', event: 'apps:synced', data: { childPublicKey, totalApps: Object.keys(policy.apps).length } })
    send({ type: 'event', event: 'app:installed', data: { packageName, appName: appName || packageName, childPublicKey, childDisplayName, autoApproved } })
  }
}

// App icons belong to the parent's Apps tab and nowhere else. They are the bulk of
// a policy once a child has a few dozen apps (tens of KB each as base64 PNG until
// they were shrunk), and the child has no use for them: it has the real apps. So
// no icon ever rides in a policy push, in the child's stored policy or in the JSON
// handed to native enforcement. Returns the same object when there is nothing to
// strip, so callers that compare by identity are unaffected.
function stripAppIcons (policy) {
  if (!policy || typeof policy !== 'object' || !policy.apps) return policy
  let stripped = null
  for (const [pkg, app] of Object.entries(policy.apps)) {
    if (app && app.iconBase64 !== undefined) {
      if (!stripped) stripped = { ...policy, apps: { ...policy.apps } }
      const { iconBase64, ...rest } = app
      stripped.apps[pkg] = rest
    }
  }
  return stripped || policy
}

// A child device can free itself when the parent's phone is gone for good, but
// not on the spot: a correct PIN starts a countdown the parent is told about and
// can cancel. See proposals/2026-09-03-child-initiated-leave.md.
// Guessing at the leave screen costs the same as guessing at the block overlay.
//
// The overlay's ladder lives in AppBlockerModule and is driven by native code,
// so a WebView screen cannot feed it: the leave screen shipped with no throttle
// at all, on Android and desktop alike, while its own comment and the proposal
// both claimed otherwise. This is that ladder, kept in the worklet so both
// platforms behave identically. Values mirror PIN_FREE_ATTEMPTS and
// PIN_LOCKOUT_LADDER_MS exactly.
const LEAVE_FREE_ATTEMPTS = 5
const LEAVE_LOCKOUT_LADDER_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000]

/** Milliseconds owed after `fails` consecutive wrong PINs; 0 while attempts remain. */
function leaveLockoutForFailCount (fails) {
  if (fails <= LEAVE_FREE_ATTEMPTS) return 0
  const idx = Math.min(fails - LEAVE_FREE_ATTEMPTS - 1, LEAVE_LOCKOUT_LADDER_MS.length - 1)
  return LEAVE_LOCKOUT_LADDER_MS[idx]
}

/**
 * Remaining lockout in ms, or 0 if the leave screen is usable.
 *
 * A clock rolled back to before the lock was applied serves the FULL remaining
 * duration rather than reading as expired, the same rule the native keypad uses:
 * the device's clock belongs to the child, so it must not be a way out.
 */
function leaveLockRemainingMs (rec, now) {
  if (!rec || !rec.lockedUntil) return 0
  const lockedAt = rec.lockedAt || 0
  if (now < lockedAt) return rec.lockedUntil - lockedAt
  if (now >= rec.lockedUntil) return 0
  return rec.lockedUntil - now
}

const LEAVE_DELAY_MS = 24 * 60 * 60 * 1000
// ...and the countdown has to be lived through, not just waited out on paper.
// Winding the device clock forward a day is the obvious attack, so the commit
// also requires this much time actually observed passing while the app ran.
// Ticks are the child's existing 60 s heartbeat, so this is an hour of real
// running, spread over as many sessions as it takes.
const LEAVE_MIN_OBSERVED_MS = 60 * 60 * 1000
// No single tick may contribute more than this, so one clock jump cannot fill
// the observed budget by itself.
const LEAVE_TICK_CAP_MS = 5 * 60 * 1000

/**
 * Does this PIN belong to any parent of this device? Co-parents each hold their
 * own PIN in policy.pinHashes; pinHash is the pre-#122 single-parent field, kept
 * because a child paired before that upgrade still has one.
 */
function verifyParentPin (policy, pin, sodium) {
  if (!policy || typeof pin !== 'string' || pin.length === 0) return false
  const hashBuf = Buffer.alloc(sodium.crypto_generichash_BYTES)
  sodium.crypto_generichash(hashBuf, Buffer.from(pin))
  const entered = hashBuf.toString('hex')
  const known = Object.values(policy.pinHashes || {})
  if (policy.pinHash) known.push(policy.pinHash)
  return known.some((h) => h === entered)
}

/**
 * Move a scheduled leave along by one tick and say what should happen now.
 *
 * Returns 'commit' when the device should free itself, 'pending' while the
 * countdown runs, and null when no leave is scheduled. The caller owns the
 * actual reset, because wiping the store and rotating the identity belongs to
 * bare.js where the swarm lives.
 */
async function advanceScheduledLeave (db, now) {
  const raw = await db.get('leaveScheduled').catch(() => null)
  const rec = raw && raw.value
  if (!rec || typeof rec.effectiveAt !== 'number') return null
  const since = now - (rec.lastTickAt || rec.requestedAt || now)
  // A backward jump contributes nothing rather than subtracting: the clock is
  // the child's to move, and this budget only ever goes up.
  const credit = since > 0 ? Math.min(since, LEAVE_TICK_CAP_MS) : 0
  const observedMs = (rec.observedMs || 0) + credit
  const updated = { ...rec, observedMs, lastTickAt: now }
  if (now >= rec.effectiveAt && observedMs >= LEAVE_MIN_OBSERVED_MS) return 'commit'
  await db.put('leaveScheduled', updated)
  return 'pending'
}

/**
 * A stable fingerprint of which apps are installed. Only the package names
 * matter: names, categories and icons for an app the parent already holds are
 * back-filled by the handlers that receive them, and a change in any of those is
 * not a reason to re-send a whole catalogue.
 */
function appsSignature (apps) {
  if (!Array.isArray(apps)) return ''
  const names = apps.map((a) => a && a.packageName).filter(Boolean).sort()
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const joined = names.join(',')
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 + c + i, 0x85ebca6b) >>> 0
  }
  return names.length + ':' + h1.toString(36) + h2.toString(36)
}

/**
 * Is this policy's device-wide lock in force right now?
 *
 * A lock with no lockUntil runs until the parent clears it, which is what the
 * lock has always been. lockUntil is the "lock until 7 pm" case: past that
 * moment the lock is simply over, and every reader has to agree about that
 * without anyone writing a new policy, since the child is often the only device
 * awake when the moment passes.
 */
function isLockActive (policy, now) {
  if (!policy || !policy.locked) return false
  if (typeof policy.lockUntil !== 'number') return true
  return now < policy.lockUntil
}

// Parent-side: does the parent's own setting say new apps skip the approval step?
async function parentAutoApprovesNewApps (db) {
  const raw = await db.get('parentSettings').catch(() => null)
  return !!(raw && raw.value && raw.value.autoApproveNewApps)
}

// Child-side: the same setting as it reaches the child, embedded in the policy the
// parent pushes (settings:save and policy:update both copy parentSettings in).
function autoApprovesNewApps (policy) {
  return !!(policy && policy.settings && policy.settings.autoApproveNewApps)
}

// One pending approval per app, no matter how many times we hear about it.
//
// The same undecided app can be described to us three different ways: an
// `app:installed` relay, a batch `apps:sync` covering apps added while the child
// was offline, and the child tapping "Request access" on the block overlay. Three
// messages, ONE decision to make. Without this the parent gets a stack of
// identical Approve/Deny cards for a single app.
/**
 * Has this request been waiting for an answer longer than anyone should?
 * Pure, so the window is testable without a db.
 */
function isRequestUnanswered (request, now) {
  if (!request || request.status !== 'pending') return false
  // A parent-raised install card is not the child waiting on an answer. The app
  // stays blocked until the parent decides, and expiring the card would remove
  // the only thing prompting that decision while leaving the app blocked.
  if (request.origin === 'install') return false
  return now - (request.requestedAt || 0) > REQUEST_ANSWER_WINDOW_MS
}

/**
 * Flip every request under `prefix` that has gone unanswered to 'expired'.
 * `prefix` is 'req:' on a child and 'request:' on a parent. Returns the records
 * that changed, so callers can tell the child and refresh their own lists.
 */
async function expireUnansweredRequests (db, prefix, now, onExpired) {
  const expired = []
  for await (const { key, value } of db.createReadStream({ gt: prefix, lt: prefix + '~' })) {
    if (!isRequestUnanswered(value, now)) continue
    const updated = { ...value, status: 'expired', expiredAt: now }
    await db.put(key, updated)
    expired.push(updated)
    // Announce from inside the sweep, so whichever call site gets there first is
    // the one that tells the child. Hanging the notification off one particular
    // caller looked fine until the TCL ran it: the home screen's 30 s refresh
    // swept before the 60 s heartbeat did, the record was already 'expired' by
    // the time the heartbeat looked, and the child was never told at all.
    if (onExpired) onExpired(updated)
  }
  return expired
}

async function findPendingApproval (db, childPublicKey, packageName) {
  for await (const { value } of db.createReadStream({ gt: 'request:', lt: 'request:~' })) {
    if (value
      && value.childPublicKey === childPublicKey
      && value.packageName === packageName
      && value.status === 'pending'
      && (value.requestType || 'approval') === 'approval') {
      return value
    }
  }
  return null
}

// A newly installed app lands as 'pending', but nothing ever ASKED the parent to
// decide. All they got was an informational "App Installed" row, while the actual
// approve/deny lived over in the Apps tab, where a parent had to know to go
// looking. Give the install its own inbox item, exactly like a time request:
// same record shape, and the same resolution path (app:decide already resolves
// every pending request for this child+package and pushes the policy to the
// child), so both kinds of ask ride ONE pipeline instead of growing a second.
async function createInstallApprovalRequest (db, send, { childPublicKey, childDisplayName, packageName, appName, now }) {
  if (await findPendingApproval(db, childPublicKey, packageName)) return null

  const request = {
    id: 'install:' + packageName + ':' + now,
    packageName,
    appName: appName || packageName,
    requestedAt: now,
    status: 'pending',
    notified: false,
    childPublicKey,
    childDisplayName,
    requestType: 'approval',
    // The app simply appeared; the child has not asked for it (yet). Lets the UI
    // say "just installed" rather than implying the child requested it.
    origin: 'install',
  }
  await db.put('request:' + request.id, request)
  // Same event the child's own requests fire, so the Activity tab reloads and
  // the parent's pending-request badge counts it without any new wiring.
  send({ type: 'event', event: 'time:request:received', data: request })
  return request
}

/**
 * Handle an incoming `apps:sync` P2P message from a child peer.
 * Receives all installed apps in one batch — avoids read-modify-write races.
 * Runs on the PARENT device.
 */
async function handleIncomingAppsSyncUnlocked (payload, childPublicKey, db, send, sendToPeer) {
  const { apps } = payload
  if (!Array.isArray(apps) || apps.length === 0) return

  const raw = await db.get('policy:' + childPublicKey)
  const isFirstSync = !raw
  const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
  if (!policy.apps) policy.apps = {}

  // Ensure pinHash is always present — it may be missing if the child was removed and
  // re-paired (child policy deleted by unpair, then recreated fresh here with no pinHash).
  if (!policy.pinHash) {
    const parentPolicy = await db.get('policy').catch(() => null)
    if (parentPolicy?.value?.pinHash) policy.pinHash = parentPolicy.value.pinHash
  }

  const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
  const childDisplayName = peerRecord?.value?.displayName || 'Your child'

  let newCount = 0
  let iconUpdateCount = 0
  // Use a single timestamp for the whole batch so apps from the same sync
  // sort together by date rather than getting subtly different millisecond values.
  const batchAddedAt = Date.now()
  const autoApproved = !isFirstSync && await parentAutoApprovesNewApps(db)
  const newApps = []
  for (const { packageName, appName, iconBase64, category } of apps) {
    if (!policy.apps[packageName]) {
      policy.apps[packageName] = { status: (isFirstSync || autoApproved) ? 'allowed' : 'pending', appName: appName || packageName, addedAt: batchAddedAt, ...(iconBase64 && { iconBase64 }), ...(category && { category }) }
      newApps.push({ packageName, appName: appName || packageName })
      newCount++
    } else {
      // Back-fill icon and category for apps already in the policy
      if (iconBase64 && !policy.apps[packageName].iconBase64) {
        policy.apps[packageName].iconBase64 = iconBase64
        iconUpdateCount++
      }
      if (category && !policy.apps[packageName].category) {
        policy.apps[packageName].category = category
        iconUpdateCount++ // reuse counter — any metadata backfill triggers a save
      }
    }
  }

  if (newCount > 0 || iconUpdateCount > 0) {
    if (newCount > 0) policy.version = (policy.version || 0) + 1
    await db.put('policy:' + childPublicKey, policy)

    // Push policy to child on every sync (first AND incremental) so the child
    // immediately receives the allowed/pending status for new apps.
    if (sendToPeer) {
      try {
        const peerRec = await db.get('peers:' + childPublicKey).catch(() => null)
        const noiseKey = peerRec && peerRec.value && peerRec.value.noiseKey
        if (noiseKey) sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
      } catch (_e) {}
    }

    // On first sync only suppress per-app alert entries and app:installed events.
    // (Everything is auto-allowed at first pairing, so there is nothing to decide.)
    if (!isFirstSync) {
      for (const { packageName, appName } of newApps) {
        const now = Date.now()
        const alertEntry = {
          id: 'app_installed:' + now + ':' + packageName,
          type: 'app_installed',
          timestamp: now,
          packageName,
          appDisplayName: appName,
          childPublicKey,
          childDisplayName,
          ...(autoApproved && { autoApproved: true }),
        }
        await db.put('alert:' + childPublicKey + ':' + now + ':' + packageName, alertEntry)
        // Unless auto-approved, these apps were added as 'pending' above, so each
        // one is a decision the parent still owes. A sync that ran while the child
        // was offline can carry several; every one gets its own inbox item, and
        // findPendingApproval keeps it from double-listing an app the child has
        // already asked about.
        if (!autoApproved) {
          await createInstallApprovalRequest(db, send, {
            childPublicKey, childDisplayName, packageName, appName, now,
          })
        }
        send({ type: 'event', event: 'app:installed', data: { packageName, appName, childPublicKey, childDisplayName, autoApproved } })
      }
    }

    send({ type: 'event', event: 'apps:synced', data: { childPublicKey, totalApps: Object.keys(policy.apps).length } })
  }
}

/**
 * Handle an incoming `time:request` P2P message from a child peer.
 * Runs on the PARENT device.
 */
async function handleIncomingTimeRequest (payload, childPublicKey, db, send) {
  const { requestId, packageName, appName: payloadAppName, requestedAt, requestType, extraSeconds } = payload
  if (!requestId || !packageName) {
    console.warn('[bare] time:request from child: missing fields')
    return
  }

  // Deduplicate: re-delivered messages (from queue flush after reconnect) should not
  // fire a second notification or create a duplicate entry.
  const existing = await db.get('request:' + requestId).catch(() => null)
  if (existing) return

  // Look up child display name; prefer app name from payload (sent by child) over policy cache
  const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
  const childDisplayName = peerRecord ? (peerRecord.value.displayName || 'Child') : 'Child'
  const childPolicyRaw = await db.get('policy:' + childPublicKey).catch(() => null)
  const policyAppName = childPolicyRaw && childPolicyRaw.value.apps && childPolicyRaw.value.apps[packageName]
    ? childPolicyRaw.value.apps[packageName].appName
    : null
  const appName = payloadAppName || policyAppName || packageName

  // Keep in step with the time:request dispatch case: an unknown type degrades to
  // 'approval', but extra_time and general_time must survive or the parent UI
  // silently approves the app instead of granting the time that was asked for.
  const resolvedType = (requestType === 'extra_time' || requestType === 'general_time')
    ? requestType
    : 'approval'

  // The parent may already owe a decision on this app: installing it created an
  // approval card, and now the child has hit the block screen and asked for the
  // same app. That is ONE decision, so don't stack a second identical card on the
  // parent — approving either resolves both (app:decide matches on child+package,
  // and the child's own req: row is resolved by the app:decision it gets back).
  // extra_time/general_time are exempt: those are genuinely new asks about an app
  // the parent already allowed.
  if (resolvedType === 'approval' && await findPendingApproval(db, childPublicKey, packageName)) {
    log('[bare] approval already pending for', packageName, '- not duplicating the request')
    return
  }

  const request = { id: requestId, packageName, appName, requestedAt, status: 'pending', notified: false, childPublicKey, childDisplayName, requestType: resolvedType }
  if (resolvedType !== 'approval' && typeof extraSeconds === 'number') request.extraSeconds = extraSeconds
  await db.put('request:' + requestId, request)
  send({ type: 'event', event: 'time:request:received', data: request })
}

/**
 * Handle an incoming `app:uninstalled` P2P message from a child peer.
 * Removes the package from the child's policy on the PARENT device so the
 * Apps list no longer shows stale entries for apps that no longer exist.
 * Runs on the PARENT device.
 */
async function handleIncomingAppUninstalledUnlocked (payload, childPublicKey, db, send) {
  const { packageName, appName: payloadAppName } = payload
  if (!packageName) {
    console.warn('[bare] app:uninstalled from child: missing packageName')
    return
  }

  const raw = await db.get('policy:' + childPublicKey)
  if (!raw) return

  const policy = raw.value
  if (!policy.apps || !policy.apps[packageName]) return

  // Prefer the label the child sent; fall back to parent's cached policy (#71)
  const appName = payloadAppName || policy.apps[packageName].appName || packageName

  delete policy.apps[packageName]
  await db.put('policy:' + childPublicKey, policy)

  const peerRecord = await db.get('peers:' + childPublicKey).catch(() => null)
  const childDisplayName = peerRecord?.value?.displayName || 'Your child'

  // Write an informational alert entry so it appears in the parent's Alerts tab
  const now = Date.now()
  const alertEntry = {
    id: 'app_uninstalled:' + now,
    type: 'app_uninstalled',
    timestamp: now,
    packageName,
    appDisplayName: appName,
    childPublicKey,
    childDisplayName,
  }
  await db.put('alert:' + childPublicKey + ':' + now, alertEntry)

  // apps:synced refreshes the Apps tab; app:uninstalled carries data for the notification
  send({ type: 'event', event: 'apps:synced', data: { childPublicKey } })
  send({ type: 'event', event: 'app:uninstalled', data: { packageName, appName, childPublicKey, childDisplayName } })
}

/**
 * Handle a `request:resolved` P2P message from a child peer.
 * Updates the parent's local request entry so the activity list stays in sync (#122).
 *
 * @param {object} payload - { requestId, status, packageName, resolvedAt }
 * @param {object} db - Hyperbee instance
 * @param {function} send - bare->RN IPC send function
 */
async function handleRequestResolved (payload, db, send, childPublicKey) {
  const { requestId, status, packageName, appName, resolvedAt } = payload
  if (!requestId || !status) return

  // The child broadcasts this when it APPLIES an extra-time grant, which makes it
  // the only trustworthy confirmation the grant landed. Settle our copy on it:
  // clear the awaiting-delivery flag and start the countdown now, so the parent
  // watches roughly the same window the child is enforcing. The parent's own
  // clock is used on purpose - the child's resolvedAt comes from a device whose
  // clock this app already treats as untrusted.
  if (status === 'approved' && childPublicKey) {
    await settleDeliveredGrant(db, childPublicKey, requestId, Date.now())
  }

  const existing = await db.get('request:' + requestId).catch(() => null)

  // If the request already has a non-pending status, nothing to update.
  if (existing && existing.value.status !== 'pending') return

  if (existing) {
    // Normal path: update the existing pending entry. Backfill appName if missing
    // (older entries created via the defence-in-depth path may not have it).
    const merged = { ...existing.value, status, resolvedAt }
    if (!merged.appName && appName) merged.appName = appName
    await db.put('request:' + requestId, merged)
  } else {
    // Defence-in-depth: this parent never received the original time:request
    // (e.g. was offline during submission and reconnect message ordering lost it).
    // Create a minimal entry so the activity list shows the resolved request (#122).
    // Include childPublicKey so alerts:list can filter by child.
    const peerRecord = childPublicKey ? await db.get('peers:' + childPublicKey).catch(() => null) : null
    const childDisplayName = peerRecord?.value?.displayName || 'Child'
    log('[bare] request:resolved creating missing entry for', requestId, 'child:', childPublicKey?.slice(0, 8))
    await db.put('request:' + requestId, {
      id: requestId,
      packageName: packageName || 'unknown',
      appName: appName || packageName || 'unknown',
      status,
      resolvedAt,
      requestedAt: resolvedAt || Date.now(),
      notified: true,
      childPublicKey: childPublicKey || null,
      childDisplayName,
    })
  }
  send({ type: 'event', event: 'request:updated', data: { requestId, status, packageName, appName } })
}

/**
 * Decide whether a blocked peer's hello arrives on a FRESH invite that should clear
 * the block (used by handleHello). A pending invite only counts when it is
 * demonstrably bound to THIS peer:
 *   1. a pendingInviteTopic matching this connection's OWN topic — the peer actually
 *      joined the fresh invite topic, so it is the invited party; or
 *   2. a pendingChild record keyed by this peer's identity — the parent accepted this
 *      specific child's own (QR) invite.
 *
 * It deliberately does NOT clear on "any newer pending invite". Doing so let a
 * previously-unpaired child that reconnects (on a cached connection with empty
 * info.topics[], so no bound topic) match an UNRELATED new-child invite opened for a
 * different child, delete its own blocked: record and re-pair itself — an enforcement
 * bypass triggered just by opening "Add Child". A legitimate re-pair of a still-blocked
 * child instead clears via path 1 once it connects on the actual invite topic (or via
 * the explicit child:clearBlocked escape hatch).
 *
 * @param {object} db — Hyperbee instance
 * @param {object} ctx — { peerIdentityKeyHex, incomingTopic, isChildHello, blockedAt }
 * @returns {Promise<boolean>}
 */
async function isBlockClearedByFreshInvite (db, { peerIdentityKeyHex, incomingTopic, isChildHello, blockedAt }) {
  // 1. pendingInviteTopic matching this connection's topic (parent-hosted invite the
  //    peer actually joined).
  if (incomingTopic) {
    const pending = await db.get('pendingInviteTopic:' + incomingTopic).catch(() => null)
    if (pending && (pending.value?.createdAt || 0) > blockedAt) return true
  }
  // 2. pendingChild bound to THIS peer (parent accepted this child's own QR invite).
  if (isChildHello) {
    const pendingChild = await db.get('pendingChild:' + peerIdentityKeyHex).catch(() => null)
    if (pendingChild && (pendingChild.value?.ts || 0) > blockedAt) return true
  }
  return false
}

// The incoming-relay handlers run under the same per-child lock as the
// dispatch methods, so a sync and an install relay for the same child cannot
// interleave with each other or with a parent edit.
function handleIncomingAppInstalled (payload, childPublicKey, ...rest) {
  return withPolicyLock(childPublicKey, () => handleIncomingAppInstalledUnlocked(payload, childPublicKey, ...rest))
}
function handleIncomingAppsSync (payload, childPublicKey, ...rest) {
  return withPolicyLock(childPublicKey, () => handleIncomingAppsSyncUnlocked(payload, childPublicKey, ...rest))
}
function handleIncomingAppUninstalled (payload, childPublicKey, ...rest) {
  return withPolicyLock(childPublicKey, () => handleIncomingAppUninstalledUnlocked(payload, childPublicKey, ...rest))
}

module.exports = { createDispatch, pruneRuleArchives, leaveLockoutForFailCount, leaveLockRemainingMs, dateStrInZone, childZoneOffset, withPolicyLock, settleDeliveredGrant, recordPolicyAck, isLockActive, appsSignature, verifyParentPin, advanceScheduledLeave, isRequestUnanswered, expireUnansweredRequests, stripAppIcons, shouldAcceptRelayedPolicy, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleTimeExtendGeneral, replayActiveGrants, applyScreenTimeBonus, bonusSecondsForToday, handleIncomingAppInstalled, handleIncomingAppUninstalled, handleIncomingAppsSync, handleIncomingTimeRequest, handleRequestResolved, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue, mergeSessions, groupSessionsByLocalDate, pruneStaleKeys, dailyTotalsSignature, getExclusions, applyExclusionsToReport, resolveAppName, applyPolicyNamesToReport, isBlockClearedByFreshInvite }