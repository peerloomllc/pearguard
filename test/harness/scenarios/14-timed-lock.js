// "Lock until 7 pm": the lock must reach the child, then end by itself with no
// second message from the parent. The parent is often asleep when the moment
// passes, so the child device has to make that call locally.
module.exports = {
  name: 'timed-lock',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, teardown } = lib
    const parent = spawnInstance('parent')
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
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.a', appName: 'A' }], installedAll: ['com.a'] })
      await new Promise((r) => setTimeout(r, 3000))

      const childLocked = async () => (await call(child, 'child:homeData')).locked
      const parentLocked = async () => ((await call(parent, 'children:list')).find((x) => x.publicKey === childPub) || {}).locked

      const until = Date.now() + 6000
      await call(parent, 'policy:setLock', { childPublicKey: childPub, locked: true, lockMessage: 'Dinner', lockUntil: until })
      const deadline = Date.now() + 15000
      while (!(await childLocked()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300))
      log('after the parent locks: child', await childLocked(), '| parent', await parentLocked())
      if (!(await childLocked())) throw new Error('the timed lock never reached the child')
      if (!(await parentLocked())) throw new Error('the parent does not show its own lock')

      const stored = (await call(child, 'policy:getCurrent')).policy || {}
      if (stored.lockUntil !== until) throw new Error('the child stored lockUntil ' + stored.lockUntil + ', expected ' + until)

      // Nothing is sent from here on. The lock has to end on the child's own clock.
      await new Promise((r) => setTimeout(r, Math.max(0, until - Date.now()) + 1500))
      log('after the end time: child', await childLocked(), '| parent', await parentLocked())
      if (await childLocked()) throw new Error('the lock did not end on its own')
      if (await parentLocked()) throw new Error('the parent still shows the child as locked')

      // The record itself is untouched: no write, no version bump, nothing pushed.
      const after = (await call(child, 'policy:getCurrent')).policy || {}
      if (after.locked !== true || after.version !== stored.version) {
        throw new Error('the policy was rewritten (locked ' + after.locked + ', v' + after.version + ' vs v' + stored.version + ')')
      }
    } finally {
      teardown([parent, child])
    }
  },
}
