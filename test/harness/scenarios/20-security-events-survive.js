// A child raises enforcement alerts and PIN uses at whatever parents it thinks
// are connected. A send into a socket whose peer has already gone does not
// throw, and the child takes ~15 s to notice, so anything raised in that window
// used to vanish. Everything else recovers on reconnect; these two must too.
module.exports = {
  name: 'security-events-survive',
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
      await call(parent, 'pin:set', { pin: '4321' })
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.game', appName: 'Game' }], installedAll: ['com.game'] })
      await new Promise((r) => setTimeout(r, 2500))

      // Kill the parent and raise both event types immediately, inside the
      // window where the child still believes it is connected.
      await kill(parent)
      log('parent OFFLINE; raising a bypass alert and a PIN use straight away')
      await call(child, 'bypass:detected', { reason: 'accessibility-disabled', detectedAt: Date.now() })
      await call(child, 'pin:verify', { pin: '4321', packageName: 'com.game' })

      parent = respawn(parent)
      const gotBypass = waitEvent(parent, (m) => m.event === 'alert:bypass', 60000)
      const gotPin = waitEvent(parent, (m) => m.event === 'alert:pin_override', 60000)
      await init(parent, true)
      await call(parent, 'setMode', ['parent'])
      const b = await gotBypass
      log('the enforcement alert reached the parent:', b.data.reason)
      const p = await gotPin
      log('the PIN use reached the parent:', p.data.appDisplayName || p.data.packageName)

      // And a second reconnect must not pile up duplicates: both are filed
      // under a key derived from the event's own timestamp.
      await new Promise((r) => setTimeout(r, 1500))
      const before = (await call(parent, 'alerts:list', { childPublicKey: childPub })).length
      await kill(parent)
      parent = respawn(parent)
      await init(parent, true)
      await call(parent, 'setMode', ['parent'])
      await new Promise((r) => setTimeout(r, 6000))
      const after = (await call(parent, 'alerts:list', { childPublicKey: childPub })).length
      log('alerts after the first reconnect:', before, '| after a second:', after)
      if (after !== before) throw new Error('re-sending duplicated alerts: ' + before + ' became ' + after)
    } finally {
      teardown([parent, child])
    }
  },
}
