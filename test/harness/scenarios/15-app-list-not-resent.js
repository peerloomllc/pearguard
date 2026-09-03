// The child re-scans its installed apps on every parent reconnect. It must not
// re-send the whole catalogue to a parent that already has it, but a co-parent
// who pairs later must still get it (#109).
module.exports = {
  name: 'app-list-not-resent',
  async run (lib, log) {
    const { spawnInstance, respawn, call, waitEvent, init, kill, teardown } = lib
    const parent = spawnInstance('parent')
    const coparent = spawnInstance('coparent')
    let child = spawnInstance('child')
    const APPS = Array.from({ length: 40 }, (_, i) => ({ packageName: 'com.app' + i, appName: 'App ' + i }))
    const ALL = APPS.map((a) => a.packageName)
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

      const first = await call(child, 'apps:sync', { apps: APPS, installedAll: ALL })
      log('first scan relayed to', first.relayedTo, 'parent(s)')
      if (first.relayedTo !== 1) throw new Error('the first scan must send the catalogue')
      await new Promise((r) => setTimeout(r, 2000))
      const parentApps = () => call(parent, 'policy:get', { childPublicKey: childPub }).then((p) => Object.keys(p.apps || {}).length)
      if (await parentApps() !== APPS.length) throw new Error('the parent did not receive the catalogue')

      // Reconnects re-scan. Nothing changed, so nothing should go out.
      for (let i = 0; i < 3; i++) {
        const again = await call(child, 'apps:sync', { apps: APPS, installedAll: ALL })
        if (again.relayedTo !== 0) throw new Error('re-sent an unchanged catalogue on scan ' + i)
      }
      log('three further scans sent nothing')

      // A real reconnect, which is what actually triggers this in the field.
      await kill(child)
      child = respawn(child)
      await init(child, true)
      await call(child, 'setMode', ['child'])
      await new Promise((r) => setTimeout(r, 4000))
      const afterReconnect = await call(child, 'apps:sync', { apps: APPS, installedAll: ALL })
      log('scan after a real reconnect relayed to', afterReconnect.relayedTo)
      if (afterReconnect.relayedTo !== 0) throw new Error('a reconnect re-sent the whole catalogue')

      // A co-parent pairing later still needs it, even though nothing changed.
      await init(coparent, true)
      await call(coparent, 'setMode', ['parent'])
      await call(coparent, 'identity:setName', { name: 'Mummy' })
      const coInvite = await call(coparent, 'invite:generate')
      const coPaired = waitEvent(coparent, (m) => m.event === 'peer:paired', 90000)
      await call(child, 'acceptInvite', [coInvite.inviteLink])
      await coPaired
      await new Promise((r) => setTimeout(r, 3000))
      const forCoparent = await call(child, 'apps:sync', { apps: APPS, installedAll: ALL })
      log('scan after a co-parent paired relayed to', forCoparent.relayedTo)
      if (forCoparent.relayedTo !== 1) throw new Error('the co-parent was left without the catalogue (#109)')
      await new Promise((r) => setTimeout(r, 2500))
      const coCount = Object.keys(((await call(coparent, 'policy:get', { childPublicKey: childPub })) || {}).apps || {}).length
      log('co-parent now holds', coCount, 'apps')
      if (coCount !== APPS.length) throw new Error('co-parent holds ' + coCount + ' apps, expected ' + APPS.length)

      // And an app appearing still reaches everyone.
      const grown = [...APPS, { packageName: 'com.new', appName: 'New' }]
      const afterInstall = await call(child, 'apps:sync', { apps: grown, installedAll: [...ALL, 'com.new'] })
      log('scan after an install relayed to', afterInstall.relayedTo)
      if (afterInstall.relayedTo !== 2) throw new Error('an install did not reach both parents')
    } finally {
      teardown([parent, coparent, child])
    }
  },
}
