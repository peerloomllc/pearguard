// 08-child-hosted-pair.js — the child publishes the invite (desktop QR flow) and the
// parent scans/pastes it. Inverse of 01-pair.js, which is parent-hosted.
module.exports = {
  name: 'child-hosted-pair',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, teardown } = lib
    const parent = spawnInstance('parent')
    const child = spawnInstance('child')
    try {
      const [p, c] = await Promise.all([init(parent), init(child)])
      await call(parent, 'setMode', ['parent'])
      await call(child, 'setMode', ['child'])
      await call(parent, 'identity:setName', { name: 'Daddy' })
      await call(child, 'identity:setName', { name: 'PC' })

      const invite = await call(child, 'child-invite:generate')
      log('child invite: ' + invite.inviteLink.slice(0, 48) + '...')

      const paired = Promise.all([
        waitEvent(parent, (m) => m.event === 'child:connected', 60000),
        waitEvent(child, (m) => m.event === 'peer:paired', 60000),
      ])
      const t0 = Date.now()
      const accepted = await call(parent, 'acceptChildInvite', [invite.inviteLink])
      log('acceptChildInvite -> ' + JSON.stringify(accepted))
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
