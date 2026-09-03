// Unpairing to clear up a glitch used to throw away every schedule, limit and
// block. The re-paired device is a genuinely new peer (the child rotates its
// identity on reset), so the rules cannot be reattached automatically: they are
// kept, and the parent puts them back.
module.exports = {
  name: 'rules-survive-unpair',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, teardown } = lib
    const parent = spawnInstance('parent')
    const child = spawnInstance('child')
    try {
      const [, c] = await Promise.all([init(parent, true), init(child, true)])
      const firstKey = c.data.publicKey
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
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.game', appName: 'Game' }, { packageName: 'com.chat', appName: 'Chat' }], installedAll: ['com.game', 'com.chat'] })
      await new Promise((r) => setTimeout(r, 2500))

      // Rules worth losing: a block, an app limit, a schedule and a daily cap.
      const p = await call(parent, 'policy:get', { childPublicKey: firstKey })
      p.apps['com.game'] = { ...p.apps['com.game'], status: 'blocked' }
      p.apps['com.chat'] = { ...p.apps['com.chat'], dailyLimitSeconds: 1800 }
      p.schedules = [{ name: 'Bedtime', days: ['Monday'], start: '21:00', end: '07:00', exemptApps: [] }]
      p.dailyScreenTimeLimitSeconds = 7200
      await call(parent, 'policy:update', { childPublicKey: firstKey, policy: p })
      await new Promise((r) => setTimeout(r, 2000))
      log('set a block, an app limit, a schedule and a 2h daily cap')

      const wiped = waitEvent(child, (m) => m.event === 'child:reset', 60000)
      await call(parent, 'child:unpair', { childPublicKey: firstKey })
      await wiped
      log('unpaired; the child wiped itself')

      const { archives } = await call(parent, 'rules:archives')
      log('kept rule sets:', archives.map((a) => a.displayName + ' (' + a.appCount + ' apps, ' + a.scheduleCount + ' schedule)').join(', ') || 'none')
      if (archives.length !== 1) throw new Error('expected exactly one kept rule set, got ' + archives.length)
      if (archives[0].appCount !== 2 || archives[0].scheduleCount !== 1 || !archives[0].hasScreenTimeLimit) {
        throw new Error('the kept set is missing rules: ' + JSON.stringify(archives[0]))
      }

      // Re-pair. The child comes back under a new identity.
      // waitEvent returns an already-buffered match, so the first pairing would
      // answer this one: only look at events raised from here on.
      const mark = parent.events.length
      const invite2 = await call(parent, 'invite:generate')
      await call(child, 'acceptInvite', [invite2.inviteLink])
      const deadline = Date.now() + 90000
      let pev = null
      while (!pev && Date.now() < deadline) {
        pev = parent.events.slice(mark).find((m) => m.event === 'peer:paired')
        if (!pev) await new Promise((r) => setTimeout(r, 300))
      }
      if (!pev) throw new Error('the parent never saw the re-pair')
      const newKey = pev.data.publicKey
      if (newKey === firstKey) throw new Error('the child came back with its old identity')
      await call(child, 'identity:setName', { name: 'Sam' })
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.chat', appName: 'Chat' }, { packageName: 'com.new', appName: 'New' }], installedAll: ['com.chat', 'com.new'] })
      await new Promise((r) => setTimeout(r, 3000))

      const fresh = await call(parent, 'policy:get', { childPublicKey: newKey })
      log('after re-pairing, before restoring:', JSON.stringify({ chat: fresh.apps['com.chat'].status, limit: fresh.apps['com.chat'].dailyLimitSeconds, cap: fresh.dailyScreenTimeLimitSeconds, schedules: (fresh.schedules || []).length }))
      if (fresh.apps['com.chat'].dailyLimitSeconds) throw new Error('the fresh pairing already had rules')

      const res = await call(parent, 'rules:restoreArchive', { archiveKey: archives[0].key, targetChildPubKey: newKey })
      if (!res.ok) throw new Error('restore refused: ' + JSON.stringify(res))
      await new Promise((r) => setTimeout(r, 2500))

      const back = await call(parent, 'policy:get', { childPublicKey: newKey })
      log('after restoring:', JSON.stringify({ chat: back.apps['com.chat'].status, limit: back.apps['com.chat'].dailyLimitSeconds, cap: back.dailyScreenTimeLimitSeconds, schedules: (back.schedules || []).length, hasGame: !!back.apps['com.game'], newApp: back.apps['com.new'] && back.apps['com.new'].status }))
      if (back.apps['com.chat'].dailyLimitSeconds !== 1800) throw new Error("the app limit did not come back")
      if (back.dailyScreenTimeLimitSeconds !== 7200) throw new Error('the daily cap did not come back')
      if ((back.schedules || []).length !== 1) throw new Error('the schedule did not come back')
      if (back.apps['com.game']) throw new Error('an app this device does not have was invented')
      if (!back.apps['com.new']) throw new Error("the device's own new app was dropped")

      // And the child is actually enforcing it.
      const childPolicy = (await call(child, 'policy:getCurrent')).policy || {}
      if (childPolicy.dailyScreenTimeLimitSeconds !== 7200) throw new Error('the child did not receive the restored rules')
      log('the child is enforcing the restored rules')
    } finally {
      teardown([parent, child])
    }
  },
}
