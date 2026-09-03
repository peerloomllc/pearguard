// A day of screen time belongs to the child's calendar. This runs the child in a
// zone whose date differs from the parent's right now, and checks the parent
// files and reads that day as the child's, not its own.
module.exports = {
  name: 'child-calendar',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, teardown } = lib
    const dateIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
    const parentDate = dateIn(Intl.DateTimeFormat().resolvedOptions().timeZone)
    // Pick a zone that is genuinely on a different date from this machine.
    const childTz = ['Pacific/Kiritimati', 'Pacific/Niue', 'Pacific/Auckland', 'America/Los_Angeles']
      .find((tz) => dateIn(tz) !== parentDate)
    if (!childTz) { log('SKIPPED: no candidate zone is on a different date right now'); return }
    const childDate = dateIn(childTz)
    log('parent is on', parentDate, '| child will run in', childTz, 'which is on', childDate)

    const parent = spawnInstance('parent')
    const savedTz = process.env.TZ
    process.env.TZ = childTz
    const child = spawnInstance('child')
    process.env.TZ = savedTz
    try {
      const [, c] = await Promise.all([init(parent, true), init(child, true)])
      const childPub = c.data.publicKey
      await call(parent, 'setMode', ['parent'])
      await call(child, 'setMode', ['child'])
      await call(parent, 'identity:setName', { name: 'Daddy' })
      await call(child, 'identity:setName', { name: 'Sam' })
      const invite = await call(parent, 'invite:generate')
      const paired = Promise.all([
        waitEvent(parent, (m) => m.event === 'peer:paired', 90000),
        waitEvent(child, (m) => m.event === 'peer:paired', 90000),
      ])
      await call(child, 'acceptInvite', [invite.inviteLink])
      await paired
      await new Promise((r) => setTimeout(r, 2000))

      // The category view groups by the parent's app catalogue, so the app has
      // to be known before it can be categorised.
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.game', appName: 'Game', category: 'Games' }], installedAll: ['com.game'] })
      await new Promise((r) => setTimeout(r, 2500))

      const now = Date.now()
      await call(child, 'usage:flush', {
        usage: [{ packageName: 'com.game', appName: 'Game', todaySeconds: 1800 }],
        weekly: [],
        sessions: [{ packageName: 'com.game', startedAt: now - 1800000, durationSeconds: 1800 }],
        dailyTotals: [{ date: childDate, apps: [{ packageName: 'com.game', displayName: 'Game', secondsToday: 1800 }] }],
        foregroundPackage: 'com.game',
      })
      await new Promise((r) => setTimeout(r, 3000))

      const summaries = await call(parent, 'usage:getDailySummaries', { childPublicKey: childPub, days: 3 })
      const rows = (summaries.summaries || summaries || [])
      log('parent sees days:', rows.map((s) => s.date + '=' + (s.totalSeconds || 0) + 's').join('  '))
      const dates = rows.map((s) => s.date)
      if (!dates.includes(childDate)) {
        throw new Error("the parent's window does not include the child's own day " + childDate + ': ' + dates.join(','))
      }
      const childRow = rows.find((s) => s.date === childDate)
      if (!(childRow.totalSeconds > 0)) throw new Error("the child's day is in the window but empty")
      log("the child's day", childDate, 'carries', childRow.totalSeconds + 's')

      const cat = await call(parent, 'usage:getCategorySummary', { childPublicKey: childPub, days: 3 })
      const catTotal = (cat.categories || cat || []).reduce((n, x) => n + (x.totalSeconds || 0), 0)
      log('category summary total across the same window:', catTotal + 's')
      if (!(catTotal > 0)) throw new Error('the category view lost the day the daily view found')
    } finally {
      teardown([parent, child])
    }
  },
}
