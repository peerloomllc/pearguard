// A parent must be able to tell whether the rules it holds actually reached the
// child. Edits made while the child is offline are stored and silently not sent,
// so before this the parent showed "All good" over a change that had not landed.
module.exports = {
  name: 'policy-ack',
  async run (lib, log) {
    const { spawnInstance, respawn, call, waitEvent, init, kill, teardown } = lib
    const parent = spawnInstance('parent')
    let child = spawnInstance('child')
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
      await call(child, 'apps:sync', { apps: [{ packageName: 'com.a', appName: 'A' }], installedAll: ['com.a'] })
      await new Promise((r) => setTimeout(r, 3000))

      const state = async () => {
        const kid = (await call(parent, 'children:list')).find((x) => x.publicKey === childPub) || {}
        return { held: kid.policyVersion, confirmed: kid.ackedPolicyVersion, waiting: kid.policyPending }
      }

      const edit = async (status) => {
        const p = await call(parent, 'policy:get', { childPublicKey: childPub })
        p.apps['com.a'] = { ...(p.apps['com.a'] || {}), status }
        await call(parent, 'policy:update', { childPublicKey: childPub, policy: p })
      }

      // 1. An edit while the child is up must be confirmed on its own.
      await edit('blocked')
      let s
      const online = Date.now() + 15000
      do { await new Promise((r) => setTimeout(r, 400)); s = await state() } while (s.waiting !== false && Date.now() < online)
      log('child online:', JSON.stringify(s))
      if (s.waiting !== false || s.confirmed !== s.held) throw new Error('an edit to a connected child was never confirmed')

      // 2. An edit while the child is off must show as waiting.
      await kill(child)
      log('child OFFLINE')
      await edit('allowed')
      s = await state()
      log('edited while offline:', JSON.stringify(s))
      if (s.waiting !== true) throw new Error('the parent does not show it is waiting for the phone')
      if (s.confirmed >= s.held) throw new Error('confirmed version should lag the held version')

      // 3. It must clear itself once the child is back, with no parent action.
      child = respawn(child)
      await init(child, true)
      await call(child, 'setMode', ['child'])
      const back = Date.now() + 30000
      do { await new Promise((r) => setTimeout(r, 500)); s = await state() } while (s.waiting !== false && Date.now() < back)
      log('child back:', JSON.stringify(s))
      if (s.waiting !== false) throw new Error('still waiting after the child reconnected')
      if (s.confirmed !== s.held) throw new Error('confirmed ' + s.confirmed + ' but holding ' + s.held)
      const childPolicy = (await call(child, 'policy:getCurrent')).policy || {}
      if (childPolicy.apps['com.a'].status !== 'allowed') throw new Error('the child is not actually enforcing the edit it confirmed')
    } finally {
      teardown([parent, child])
    }
  },
}
