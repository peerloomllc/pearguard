// 07-offline-message-queue.js — the child sends to the parent while the parent is
// OFFLINE; the message is queued and delivered when the parent reconnects.
// Guards the offline message-queue collapse/flush behaviour.
module.exports = {
  name: 'offline-message-queue',
  async run (lib, log) {
    const { spawnInstance, respawn, call, waitEvent, init, kill, pair, teardown } = lib
    const PKG = 'com.example.queued'
    let parent = spawnInstance('parent')
    const child = spawnInstance('child')
    try {
      await Promise.all([init(parent), init(child)])
      await pair(parent, child)
      log('paired')

      // Parent goes offline. Wait until the child actually notices the disconnect —
      // only then is no parent "connected", so sendToAllParents queues instead of
      // writing to a dead socket.
      await kill(parent)
      const td = Date.now()
      await waitEvent(child, (m) => m.event === 'peer:disconnected', 60000)
      log(`parent OFFLINE (child saw disconnect in ${((Date.now() - td) / 1000).toFixed(1)}s)`)

      // Child submits a time request while no parent is connected -> it queues.
      const req = await call(child, 'time:request', { packageName: PKG, appName: 'Queued', requestType: 'extra_time', extraSeconds: 300 })
      log('child queued time:request', req.requestId.slice(0, 24))

      // Parent comes back and reconnects; the child flushes its queue on reconnect,
      // and the parent surfaces the delivered request via time:request:received.
      parent = respawn(parent)
      const received = waitEvent(parent, (m) => m.event === 'time:request:received' && m.data.packageName === PKG, 90000)
      await init(parent)
      await call(parent, 'setMode', ['parent'])
      log('parent back ONLINE, waiting for the flushed request...')
      await received
      log('parent received the queued request via flush')
    } finally {
      teardown([parent, child])
    }
  },
}
