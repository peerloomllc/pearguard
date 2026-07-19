// 01-pair.js — two headless bare.js instances pair over Hyperswarm, bidirectionally.
module.exports = {
  name: 'pair',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, teardown } = lib
    const parent = spawnInstance('parent')
    const child = spawnInstance('child')
    try {
      const [p, c] = await Promise.all([init(parent), init(child)])
      await call(parent, 'setMode', ['parent'])
      await call(child, 'setMode', ['child'])
      await call(parent, 'identity:setName', { name: 'Daddy' })
      await call(child, 'identity:setName', { name: 'Kiddo' })

      const invite = await call(parent, 'invite:generate')
      const paired = Promise.all([
        waitEvent(parent, (m) => m.event === 'peer:paired', 90000),
        waitEvent(child, (m) => m.event === 'peer:paired', 90000),
      ])
      const t0 = Date.now()
      await call(child, 'acceptInvite', [invite.inviteLink])
      await paired
      log(`paired in ${((Date.now() - t0) / 1000).toFixed(1)}s`)

      const pList = await call(parent, 'children:list')
      const cList = await call(child, 'children:list')
      const ok = pList.some((x) => x.publicKey === c.data.publicKey) &&
                 cList.some((x) => x.publicKey === p.data.publicKey)
      if (!ok) throw new Error('pairing not reflected in children:list on both sides')
      log('bidirectional pairing confirmed')
    } finally {
      teardown([parent, child])
    }
  },
}
