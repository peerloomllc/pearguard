// 02-coparent-dedup.js — regression test for PR #211.
// Two DIFFERENT parents sharing the display name "Daddy" pair with one child. The
// child must keep BOTH parent records; the old displayName-grouping dedup in
// children:list deleted one of them (a real co-parent lost to a name collision).
module.exports = {
  name: 'coparent-dedup',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, teardown } = lib
    const parent1 = spawnInstance('parent1')
    const parent2 = spawnInstance('parent2')
    const child = spawnInstance('child')
    try {
      const [p1, p2] = await Promise.all([init(parent1), init(parent2), init(child)])
      await call(child, 'setMode', ['child'])
      await call(child, 'identity:setName', { name: 'Kiddo' })

      for (const [parent, ready, tag] of [[parent1, p1, '#1'], [parent2, p2, '#2']]) {
        await call(parent, 'setMode', ['parent'])
        await call(parent, 'identity:setName', { name: 'Daddy' }) // deliberately identical
        const invite = await call(parent, 'invite:generate')
        const paired = waitEvent(child, (m) => m.event === 'peer:paired' && m.data.publicKey === ready.data.publicKey, 90000)
        await call(child, 'acceptInvite', [invite.inviteLink])
        await paired
        log(`child paired to Daddy ${tag} (${ready.data.publicKey.slice(0, 8)})`)
      }

      // children:list is where the (removed) dedup used to run.
      const list = await call(child, 'children:list')
      log('child sees parents ->', list.map((x) => `${x.displayName}(${x.publicKey.slice(0, 8)})`).join(', '))
      const keys = new Set(list.map((x) => x.publicKey))
      if (!(keys.has(p1.data.publicKey) && keys.has(p2.data.publicKey))) {
        throw new Error(`co-parent deleted: child lists ${list.length} parent(s), expected both`)
      }
      log('both same-named co-parents retained')
    } finally {
      teardown([parent1, parent2, child])
    }
  },
}
