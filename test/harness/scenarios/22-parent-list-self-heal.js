// A child once had an empty parent list for a whole session while the parent
// stayed connected and kept pushing, so every relay and alert queued instead of
// sending. The cause was never found. The child now re-registers a paired parent
// as soon as a verified message arrives from it on a live connection, so an
// alert raised afterwards reaches the parent straight away.
module.exports = {
  name: 'parent-list-self-heal',
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
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.a', appName: 'A' }], installedAll: ['com.a'] })
      await new Promise((r) => setTimeout(r, 3000))

      await call(child, 'harness:dropParentPeers')
      log('child forgot its parent; connection left open')

      // Any verified message from the parent should put it back on the list.
      await call(parent, 'settings:save', { settings: { timeRequestMinutes: [5], warningMinutes: [1], autoApproveNewApps: true } })
      await new Promise((r) => setTimeout(r, 3000))

      const mark = parent.events.length
      await call(child, 'bypass:detected', { reason: 'accessibility_disabled' })
      const deadline = Date.now() + 8000
      let got = false
      while (!got && Date.now() < deadline) {
        got = parent.events.slice(mark).some((m) => m.event === 'alert:bypass')
        if (!got) await new Promise((r) => setTimeout(r, 200))
      }
      log('alert reached the parent without a reconnect:', got)
      if (!got) throw new Error('child did not re-register its connected parent; the alert was queued')
    } finally {
      teardown([parent, child])
    }
  },
}
