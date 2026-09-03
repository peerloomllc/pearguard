// A short grant approved while the child is offline must still arrive in full
// when the child comes back, even though the approval is older than the grant
// length by then. Before delivery tracking the parent stamped the expiry at
// approval time and refused to replay a grant whose phantom window had passed,
// so the child got nothing while both sides called the request approved.
module.exports = {
  name: 'grant-outlives-offline',
  async run (lib, log) {
    const { spawnInstance, respawn, call, waitEvent, init, kill, teardown } = lib
    const PKG = 'com.example.game'
    const GRANT_SECONDS = 3
    const parent = spawnInstance('parent')
    let child = spawnInstance('child')
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
      const req = await call(child, 'time:request', { packageName: PKG, appName: 'Game', requestType: 'extra_time', extraSeconds: GRANT_SECONDS })
      await new Promise((r) => setTimeout(r, 1500))

      await kill(child)
      log('child OFFLINE')
      await call(parent, 'time:grant', { childPublicKey: childPub, requestId: req.requestId, packageName: PKG, extraSeconds: GRANT_SECONDS })
      const pending = (await call(parent, 'overrides:list', { childPublicKey: childPub })).overrides
        .filter((o) => o.packageName === PKG)
      log('parent side after an offline approval:', JSON.stringify(pending.map((o) => ({ awaitingDelivery: o.awaitingDelivery, expiresAt: o.expiresAt }))))
      if (pending.length !== 1) throw new Error('expected the pending grant to be listed for the parent, got ' + pending.length)
      if (pending[0].awaitingDelivery !== true) throw new Error('grant should be marked awaiting delivery')

      // Stay offline until the approval is older than the grant itself.
      await new Promise((r) => setTimeout(r, (GRANT_SECONDS + 3) * 1000))
      log('waited past the grant length; the phantom window would have expired by now')

      child = respawn(child)
      const granted = waitEvent(child, (m) => m.event === 'override:granted' && m.data.packageName === PKG, 90000)
      await init(child, true)
      await call(child, 'setMode', ['child'])
      const ev = await granted
      const secondsLeft = Math.round((ev.data.expiresAt - Date.now()) / 1000)
      log('child received the grant on reconnect, window still', secondsLeft + 's')
      if (secondsLeft < 1) throw new Error('the child got a grant that was already over: ' + secondsLeft + 's left')

      const { overrides } = await call(child, 'overrides:list')
      if (!overrides.some((o) => o.packageName === PKG)) throw new Error('override:granted fired but the child has no override stored')

      // The parent's copy must now count down the window the child is really in,
      // which happens when the child's request:resolved confirmation arrives.
      let after = []
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        after = (await call(parent, 'overrides:list', { childPublicKey: childPub })).overrides
          .filter((o) => o.packageName === PKG)
        if (after.length === 1 && after[0].awaitingDelivery === false) break
        await new Promise((r) => setTimeout(r, 400))
      }
      log('parent side after delivery:', JSON.stringify(after.map((o) => ({ awaitingDelivery: o.awaitingDelivery, msLeft: o.expiresAt - Date.now() }))))
      if (after.length !== 1 || after[0].awaitingDelivery !== false) throw new Error('parent still shows the grant as awaiting delivery')
      if (!(after[0].expiresAt > Date.now())) throw new Error('parent expiry was not re-based on delivery')
    } finally {
      teardown([parent, child])
    }
  },
}
