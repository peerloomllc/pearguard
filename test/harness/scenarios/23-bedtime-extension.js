// 23-bedtime-extension.js - proposal 2026-10-08.
// The child asks for a device-wide bedtime extension (extra_time + scope
// 'device'), then goes OFFLINE. The parent sees the request as a bedtime
// extension and approves while the child is offline. On reconnect the re-sent
// grant must still carry scope 'device', or the child would only unlock the one
// app it was blocked on.
module.exports = {
  name: 'bedtime-extension',
  async run (lib, log) {
    const { spawnInstance, respawn, call, waitEvent, init, kill, teardown } = lib
    const PKG = 'com.example.game'
    let parent = spawnInstance('parent')
    let child = spawnInstance('child')
    try {
      const [, c] = await Promise.all([init(parent), init(child)])
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

      const received = waitEvent(parent, (m) => m.event === 'time:request:received', 30000)
      const req = await call(child, 'time:request', { packageName: PKG, appName: 'Game', requestType: 'extra_time', extraSeconds: 1800, scope: 'device' })
      const got = await received
      if (got.data.scope !== 'device') throw new Error('parent stored the request without scope device')
      log('parent received the request as a bedtime extension')

      await kill(child)
      log('child OFFLINE')

      await call(parent, 'time:grant', { childPublicKey: childPub, requestId: req.requestId, packageName: PKG, extraSeconds: 1800 })
      log('parent approved while child offline')

      child = respawn(child)
      const granted = waitEvent(child, (m) => m.event === 'override:granted' && m.data.packageName === PKG, 90000)
      await init(child)
      await call(child, 'setMode', ['child'])
      log('child back ONLINE, waiting for the re-sent grant...')

      const ev = await granted
      if (ev.data.scope !== 'device') throw new Error('re-sent grant lost scope device: ' + JSON.stringify(ev.data))
      log('child received a device-wide grant')
    } finally {
      teardown([parent, child])
    }
  },
}
