// Parent restarts while the child stays up. After the reconnect the child must
// still know the parent is connected: a heartbeat it sends has to reach the
// parent directly rather than land in the child's offline queue, and a policy
// push from the parent must not leave a queued relay behind. Seen broken on the
// phones on 2026-09-03 (every relay queued while the parent was pushing).
module.exports = {
  name: 'parent-restart-registration',
  async run (lib, log) {
    const { spawnInstance, respawn, call, waitEvent, init, kill, teardown } = lib
    let parent = spawnInstance('parent')
    const child = spawnInstance('child')
    try {
      const [p, c] = await Promise.all([init(parent, true), init(child, true)])
      const childPub = c.data.publicKey
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
      log('paired')
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.a', appName: 'A' }, { packageName: 'com.b', appName: 'B' }], installedAll: ['com.a', 'com.b'] })
      await new Promise((r) => setTimeout(r, 2000))

      for (let round = 1; round <= 3; round++) {
        await kill(parent)
        log('round', round, 'parent OFFLINE')
        await new Promise((r) => setTimeout(r, 1500))
        parent = respawn(parent)
        const reconnected = waitEvent(child, (m) => m.event === 'peer:connected', 90000)
        await init(parent, true)
        await call(parent, 'setMode', ['parent'])
        await reconnected
        log('round', round, 'child saw the parent reconnect; settling')
        await new Promise((r) => setTimeout(r, 4000))

        // A push from the parent right after reconnect, like the phones this morning.
        const got = waitEvent(child, (m) => m.event === 'policy:updated', 15000)
        const policy = await call(parent, 'policy:get', { childPublicKey: childPub })
        policy.apps['com.a'] = { ...(policy.apps['com.a'] || {}), status: round % 2 ? 'blocked' : 'allowed' }
        await call(parent, 'policy:update', { childPublicKey: childPub, policy })
        await got
        log('round', round, 'child accepted the push v' + ((await call(child, 'policy:getCurrent')).policy || {}).version)

        // Does the child still know the parent is connected?
        const hb = waitEvent(parent, (m) => m.event === 'heartbeat:received', 8000).then(() => true, () => false)
        await call(child, 'heartbeat:send')
        const delivered = await hb
        log('round', round, 'heartbeat delivered directly:', delivered)
        if (!delivered) throw new Error('round ' + round + ': child queued its heartbeat although the parent is connected')
      }
    } finally {
      teardown([parent, child])
    }
  },
}
