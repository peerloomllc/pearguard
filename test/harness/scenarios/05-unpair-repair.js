// 05-unpair-repair.js — parent unpairs the child, then the two re-pair cleanly.
// Exercises the block-entry + child-side reset/identity-rotation logic that has
// caused duplicate-peer and re-pair bugs.
module.exports = {
  name: 'unpair-repair',
  async run (lib, log) {
    const { spawnInstance, respawn, call, waitEvent, init, kill, pair, teardown } = lib
    const parent = spawnInstance('parent')
    let child = spawnInstance('child')
    try {
      const [, c] = await Promise.all([init(parent), init(child)])
      const childPub = c.data.publicKey
      await pair(parent, child)
      log('paired; child pubkey', childPub.slice(0, 8))

      // Parent unpairs. Child is the only parent's peer, so the child fully resets
      // and rotates its identity keypair.
      const reset = waitEvent(child, (m) => m.event === 'child:reset', 30000)
      await call(parent, 'child:unpair', { childPublicKey: childPub })
      await reset
      log('child received unpair -> child:reset (identity rotated)')

      const afterUnpair = await call(parent, 'children:list')
      if (afterUnpair.some((x) => x.publicKey === childPub)) {
        throw new Error('parent still lists the child after unpair')
      }
      log('parent no longer lists the child')

      // Child comes back fresh (reset wiped its db incl. mode) and re-pairs. Its
      // identity has rotated, so it presents a NEW pubkey the old block does not cover.
      // Kill the reset (but still-running) process first so it releases the Hypercore
      // lock before the respawn reopens the same data dir.
      await kill(child)
      child = respawn(child)
      const c2 = await init(child)
      const newChildPub = c2.data.publicKey
      if (newChildPub === childPub) throw new Error('identity did not rotate on reset')
      await pair(parent, child)
      log('re-paired with new child pubkey', newChildPub.slice(0, 8))

      const afterRepair = await call(parent, 'children:list')
      if (!afterRepair.some((x) => x.publicKey === newChildPub)) {
        throw new Error('parent does not list the child after re-pair')
      }
      log('parent lists the re-paired child')
    } finally {
      teardown([parent, child])
    }
  },
}
