// 03-offline-time-grant.js — regression test for PR #210.
// The child requests extra time, then goes OFFLINE. The parent approves while the
// child is offline. When the child reconnects, the parent must re-send the grant
// (via handleHello) so it is not lost. Verifies the child ultimately gets it.
module.exports = {
  name: 'offline-time-grant',
  async run (lib, log) {
    const { spawnInstance, respawn, call, waitEvent, init, kill, teardown } = lib
    const PKG = 'com.example.game'
    let parent = spawnInstance('parent')
    let child = spawnInstance('child')
    try {
      const [p, c] = await Promise.all([init(parent), init(child)])
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

      // Child asks for 5 more minutes on a specific app.
      const req = await call(child, 'time:request', { packageName: PKG, appName: 'Game', requestType: 'extra_time', extraSeconds: 300 })
      log('child requested extra_time, requestId', req.requestId.slice(0, 24))
      await new Promise((r) => setTimeout(r, 1500)) // let the request reach the parent

      // Child goes offline.
      await kill(child)
      log('child OFFLINE')

      // Parent approves while the child is offline (grant is stored, not delivered).
      await call(parent, 'time:grant', { childPublicKey: childPub, requestId: req.requestId, packageName: PKG, extraSeconds: 300 })
      log('parent approved while child offline (grant stored)')

      // Child comes back with the SAME identity (same dataDir).
      child = respawn(child)
      const granted = waitEvent(child, (m) => m.event === 'override:granted' && m.data.packageName === PKG, 90000)
      await init(child)
      await call(child, 'setMode', ['child'])
      log('child back ONLINE, waiting for the re-sent grant...')

      const ev = await granted
      log('child received override:granted for', ev.data.packageName)

      // And it is persisted so overrides:list surfaces it.
      const { overrides } = await call(child, 'overrides:list')
      if (!overrides.some((o) => o.packageName === PKG)) {
        throw new Error('override:granted fired but overrides:list is missing the grant')
      }
      log('grant persisted in overrides:list')
    } finally {
      teardown([parent, child])
    }
  },
}
