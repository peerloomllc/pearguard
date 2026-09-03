// The dangerous half: when the countdown really runs out, the child must tell
// its parents, wipe itself, come back with a new identity, and the parent must
// drop it WITHOUT blocking it, so the family can pair again.
//
// Needs a build with LEAVE_DELAY_MS / LEAVE_MIN_OBSERVED_MS shortened, since a
// real run waits a day. Skips itself on a normal build rather than hanging.
module.exports = {
  name: 'child-leave-commits',
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
      await call(child, 'identity:setName', { name: 'Sam' })
      const invite = await call(parent, 'invite:generate')
      const paired = Promise.all([
        waitEvent(parent, (m) => m.event === 'peer:paired', 90000),
        waitEvent(child, (m) => m.event === 'peer:paired', 90000),
      ])
      await call(child, 'acceptInvite', [invite.inviteLink])
      await paired
      await call(parent, 'pin:set', { pin: '4321' })
      await new Promise((r) => setTimeout(r, 3000))

      const req = await call(child, 'leave:request', { pin: '4321' })
      const window = req.effectiveAt - req.requestedAt
      if (window > 60000) {
        log('SKIPPED: this build waits ' + Math.round(window / 3600000) + 'h; run it against a shortened build')
        return
      }
      log('countdown is ' + Math.round(window / 1000) + 's on this build')

      const left = waitEvent(parent, (m) => m.event === 'child:left', 60000)
      const wiped = waitEvent(child, (m) => m.event === 'child:reset', 60000)
      // The child ticks on its own heartbeat; nudge it the way the shell does.
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        await call(child, 'heartbeat:send').catch(() => {})
        await new Promise((r) => setTimeout(r, 1500))
        const st = await call(child, 'leave:status').catch(() => null)
        if (!st || !st.scheduled) break
      }
      const ev = await left
      log('parent was told the child left:', ev.data.childDisplayName)
      await wiped
      log('child wiped itself')

      // The parent keeps no records for it, and crucially did NOT block it.
      const children = await call(parent, 'children:list')
      if (children.some((x) => x.publicKey === childPub)) throw new Error('the parent still lists the child')
      const policy = await call(parent, 'policy:get', { childPublicKey: childPub }).catch(() => null)
      if (policy && policy.apps && Object.keys(policy.apps).length) throw new Error('the parent kept the rules for a child that left')

      // The child is genuinely unpaired and has a new identity.
      const home = await call(child, 'child:homeData').catch(() => null)
      if (home && home.hasPolicy) throw new Error('the child is still enforcing something')
      const ident = await call(child, 'identity:get').catch(() => null)
      if (ident && ident.publicKey === childPub) throw new Error('the child kept its old identity')
      log('child came back with a new identity')

      // And it can pair again, which blocking would have prevented.
      const invite2 = await call(parent, 'invite:generate')
      const repaired = Promise.all([
        waitEvent(parent, (m) => m.event === 'peer:paired', 90000),
        waitEvent(child, (m) => m.event === 'peer:paired', 90000),
      ])
      await call(child, 'acceptInvite', [invite2.inviteLink])
      await repaired
      log('re-paired to the same parent')
    } finally {
      teardown([parent, child])
    }
  },
}
