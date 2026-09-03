// A child with no parent connected must not rewrite its whole queue every
// minute, must not hoard stale presence, and must still deliver the events that
// actually matter once the parent returns.
module.exports = {
  name: 'offline-queue',
  async run (lib, log) {
    const { spawnInstance, respawn, call, waitEvent, init, kill, teardown } = lib
    let parent = spawnInstance('parent')
    const child = spawnInstance('child')
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
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.game', appName: 'Game' }], installedAll: ['com.game'] })
      await new Promise((r) => setTimeout(r, 2500))

      await kill(parent)
      const killedAt = Date.now()
      // Wait until the CHILD has noticed. Until it does, every send goes into a
      // socket nobody is reading and is lost without queuing: writing to a peer
      // that has just gone away does not throw.
      await waitEvent(child, (m) => m.event === 'peer:disconnected', 30000)
      log('parent OFFLINE; the child noticed after', Date.now() - killedAt, 'ms')
      await new Promise((r) => setTimeout(r, 500))

      // A night offline, compressed: many heartbeats, several usage reports and
      // one real event the parent must not lose.
      for (let i = 0; i < 20; i++) await call(child, 'heartbeat:send')
      for (let i = 0; i < 5; i++) {
        await call(child, 'usage:flush', {
          usage: [{ packageName: 'com.game', appName: 'Game', secondsToday: 60 * (i + 1) }],
          sessions: [], dailyTotals: [],
        })
      }
      const req = await call(child, 'time:request', { packageName: 'com.game', appName: 'Game', requestType: 'extra_time', extraSeconds: 300 })
      log('queued 20 heartbeats, 5 usage reports and 1 time request while offline')

      parent = respawn(parent)
      const gotRequest = waitEvent(parent, (m) => m.event === 'time:request:received', 60000)
      await init(parent, true)
      await call(parent, 'setMode', ['parent'])
      const ev = await gotRequest
      if (ev.data.id !== req.requestId) throw new Error('the parent got a different request back: ' + ev.data.id + ' vs ' + req.requestId)
      log('the time request survived the outage and arrived on reconnect')

      await new Promise((r) => setTimeout(r, 3000))
      // The usage the parent ends up with is the LAST snapshot, not the first.
      const latest = await call(parent, 'usage:getLatest', { childPublicKey: childPub }).catch(() => null)
      const secs = latest && latest.apps && (latest.apps.find((a) => a.packageName === 'com.game') || {}).todaySeconds
      log('usage the parent holds after the flush:', secs, 'seconds (last snapshot was 300)')
      if (secs !== 300) throw new Error('expected the newest snapshot (300s), got ' + JSON.stringify(secs) + ' from ' + JSON.stringify((latest || {}).apps))
      log('stale snapshots and presence were dropped rather than replayed')
    } finally {
      teardown([parent, child])
    }
  },
}
