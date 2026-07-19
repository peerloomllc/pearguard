// 06-new-app-approval.js — a newly installed app on the child surfaces to the parent
// as an inbox item; the parent's decision propagates back. Guards the
// new-app-approval-inbox feature.
module.exports = {
  name: 'new-app-approval',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, pair, teardown } = lib // waitEvent used for inbox
    const PKG = 'com.example.newgame'
    const parent = spawnInstance('parent')
    const child = spawnInstance('child')
    try {
      const [, c] = await Promise.all([init(parent), init(child)])
      const childPub = c.data.publicKey
      await pair(parent, child)
      log('paired')

      // Child detects a freshly installed app -> lands in the parent's inbox.
      const inbox = waitEvent(parent, (m) => m.event === 'app:installed' && m.data.packageName === PKG, 30000)
      await call(child, 'app:installed', { packageName: PKG, appName: 'New Game', category: 'games' })
      const item = await inbox
      log('parent inbox received app:installed for', item.data.appName)

      // Parent approves. The child emits policy:updated both when it first registers
      // the app (pending) and again when the approval lands, so poll the actual
      // status rather than matching the event, which could be the earlier one.
      await call(parent, 'app:decide', { childPublicKey: childPub, packageName: PKG, decision: 'approve' })
      const deadline = Date.now() + 30000
      let status = null
      while (Date.now() < deadline) {
        const { policy } = await call(child, 'policy:getCurrent')
        status = policy && policy.apps && policy.apps[PKG] && policy.apps[PKG].status
        if (status === 'allowed') break
        await new Promise((r) => setTimeout(r, 500))
      }
      if (status !== 'allowed') throw new Error(`child did not apply the approval (status=${status})`)
      log('child applied approval: ' + PKG + ' = allowed')
    } finally {
      teardown([parent, child])
    }
  },
}
