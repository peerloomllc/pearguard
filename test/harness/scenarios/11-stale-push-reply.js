// A parent whose copy of the rules has fallen behind the child's (a stale UI
// snapshot written back, or a regression) pushes an older version. The child
// must answer with its current copy so the parent is brought current in one
// round trip, instead of silently dropping that push and every later one.
module.exports = {
  name: 'stale-push-reply',
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

      const snapshot = await call(parent, 'policy:get', { childPublicKey: childPub })
      log('UI snapshot taken at v' + snapshot.version)
      // Two edits land after the snapshot, so the child moves two versions on.
      for (const status of ['blocked', 'allowed']) {
        const p = await call(parent, 'policy:get', { childPublicKey: childPub })
        p.apps['com.a'] = { ...p.apps['com.a'], status }
        await call(parent, 'policy:update', { childPublicKey: childPub, policy: p })
        await new Promise((r) => setTimeout(r, 1500))
      }
      const childV = ((await call(child, 'policy:getCurrent')).policy || {}).version
      log('child now at v' + childV)

      // The stale snapshot is written back: parent stores snapshot+1 and pushes it.
      const mark = parent.events.length
      snapshot.apps['com.a'] = { ...snapshot.apps['com.a'], status: 'blocked' }
      await call(parent, 'policy:update', { childPublicKey: childPub, policy: snapshot })
      const staleV = (await call(parent, 'policy:get', { childPublicKey: childPub })).version
      log('parent wrote the stale snapshot back as v' + staleV)
      if (!(staleV < childV)) throw new Error('setup: expected the parent to fall behind the child')

      // The child must answer with its current copy and the parent must take it.
      const deadline = Date.now() + 15000
      let parentV = staleV
      while (Date.now() < deadline) {
        parentV = (await call(parent, 'policy:get', { childPublicKey: childPub })).version
        if (parentV === childV) break
        await new Promise((r) => setTimeout(r, 500))
      }
      const updated = parent.events.slice(mark).some((m) => m.event === 'policy:updated')
      log('parent caught up to v' + parentV + ' (child v' + childV + '), policy:updated event:', updated)
      if (parentV !== childV) throw new Error('parent still at v' + parentV + ' while child holds v' + childV)
      if (!updated) throw new Error('parent UI was not told the rules changed')
      const childNow = ((await call(child, 'policy:getCurrent')).policy || {})
      if (childNow.version !== childV) throw new Error('child version moved unexpectedly to v' + childNow.version)
    } finally {
      teardown([parent, child])
    }
  },
}
