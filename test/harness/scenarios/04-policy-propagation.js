// 04-policy-propagation.js — parent pushes a policy; child receives and stores it.
// Guards the core parent->child config path (app limits, blocks, schedules).
module.exports = {
  name: 'policy-propagation',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, pair, teardown } = lib
    const parent = spawnInstance('parent')
    const child = spawnInstance('child')
    try {
      const [, c] = await Promise.all([init(parent), init(child)])
      const childPub = c.data.publicKey
      await pair(parent, child)
      log('paired')

      const policy = { apps: { 'com.example.chat': { status: 'blocked', appName: 'Chat' } } }
      const updated = waitEvent(child, (m) => m.event === 'policy:updated', 30000)
      await call(parent, 'policy:update', { childPublicKey: childPub, policy })
      await updated
      log('child received policy:updated')

      const { policy: current } = await call(child, 'policy:getCurrent')
      const app = current && current.apps && current.apps['com.example.chat']
      if (!app || app.status !== 'blocked') {
        throw new Error(`child policy:getCurrent did not reflect the push: ${JSON.stringify(current)}`)
      }
      log('child policy:getCurrent shows com.example.chat = blocked (v' + current.version + ')')
    } finally {
      teardown([parent, child])
    }
  },
}
