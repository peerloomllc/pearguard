// The Android services call swarm:reconnect every 30 s (#147). On a child that
// is already connected the rejoin must be a no-op for the parent connection: no
// disconnect/reconnect, no second hello, and the parent still reachable.
module.exports = {
  name: 'reconnect-churn',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, teardown } = lib
    const parent = spawnInstance('parent')
    const child = spawnInstance('child')
    try {
      await Promise.all([init(parent, true), init(child, true)])
      await call(parent, 'setMode', ['parent'])
      await call(child, 'setMode', ['child'])
      await call(parent, 'identity:setName', { name: 'Daddy' })
      await call(child, 'identity:setName', { name: 'Kiddo' })
      const invite = await call(parent, 'invite:generate')
      const paired = Promise.all([
        waitEvent(parent, (m) => m.event === 'peer:paired', 90000),
        waitEvent(child, (m) => m.event === 'peer:paired', 90000),
      ])
      await call(child, 'acceptInvite', [invite.inviteLink])
      await paired
      log('paired; settling')
      // The parent only pushes settings into an existing policy:{child}, which
      // the first app list sync creates.
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.a', appName: 'A' }], installedAll: ['com.a'] })
      await new Promise((r) => setTimeout(r, 4000))
      const mark = child.events.length
      const pmark = parent.events.length
      for (let i = 1; i <= 4; i++) {
        const r = await call(child, 'swarm:reconnect')
        if (r.rejoined < 1) throw new Error('swarm:reconnect rejoined ' + r.rejoined + ' topics; the dispatcher cannot see the swarm')
        await call(parent, 'settings:save', { settings: { timeRequestMinutes: [5], warningMinutes: [1], autoApproveNewApps: i % 2 === 0 } })
        await new Promise((r) => setTimeout(r, 3000))
      }
      const churn = child.events.slice(mark).filter((m) => m.event === 'peer:connected' || m.event === 'peer:disconnected').map((m) => m.event)
      const pchurn = parent.events.slice(pmark).filter((m) => m.event === 'peer:connected' || m.event === 'peer:disconnected' || m.event === 'child:reconnected').map((m) => m.event)
      log('child connection events after rejoins:', churn.length ? churn.join(',') : 'none', '| parent:', pchurn.length ? pchurn.join(',') : 'none')
      if (churn.length || pchurn.length) throw new Error('rejoin churned the parent connection')
      const hbMark = parent.events.length
      const hb = new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 8000)
        const check = () => {
          if (parent.events.slice(hbMark).some((m) => m.event === 'heartbeat:received')) { clearTimeout(t); resolve(true) } else setTimeout(check, 200)
        }
        check()
      })
      await call(child, 'heartbeat:send')
      const delivered = await hb
      const cur = (await call(child, 'policy:getCurrent')).policy || {}
      log('heartbeat delivered directly:', delivered, '| child policy v' + cur.version, 'auto', cur.settings && cur.settings.autoApproveNewApps)
      if (!delivered) throw new Error('heartbeat was queued although the parent is connected')
      if (!cur.settings || cur.settings.autoApproveNewApps !== true) throw new Error('last settings push (auto=true) did not reach the child')
    } finally {
      teardown([parent, child])
    }
  },
}
