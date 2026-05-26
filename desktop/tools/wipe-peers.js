// One-off diagnostic/repair tool. Opens the child's Hyperbee and deletes any
// peers:{publicKey} and pendingParent:{publicKey} entries so the next
// acceptInvite can take the full pair path. Leaves the identity keypair and
// joined topics alone.
//
// Usage:
//   1. Close the Electron app on the child device (otherwise the cores are
//      locked and this will hang on acquiring the writable session).
//   2. node desktop/tools/wipe-peers.js
//
// Expects Electron's default userData layout at
// %APPDATA%/pearguard-windows/pearguard/core on Windows.

const path = require('path')
const os = require('os')
const Hypercore = require('hypercore')
const Hyperbee = require('hyperbee')

function userDataRoot(name) {
  return process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming', name)
    : path.join(os.homedir(), '.config', name)
}

async function main() {
  // Prefer the renamed package's root; fall back to the legacy name for an
  // un-migrated install.
  const candidates = [userDataRoot('pearguard-desktop'), userDataRoot('pearguard-windows')]
  const fs = require('fs')
  const userData = candidates.find((p) => fs.existsSync(path.join(p, 'pearguard', 'core'))) || candidates[0]
  const coreDir = path.join(userData, 'pearguard', 'core')
  console.log('[wipe-peers] opening', coreDir)

  const core = new Hypercore(coreDir)
  const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()

  const targets = []
  for await (const { key } of db.createReadStream({ gte: 'peers:', lt: 'peers;' })) {
    targets.push(key)
  }
  for await (const { key } of db.createReadStream({ gte: 'pendingParent:', lt: 'pendingParent;' })) {
    targets.push(key)
  }
  console.log('[wipe-peers] found', targets.length, 'key(s):', targets)

  for (const key of targets) {
    await db.del(key)
    console.log('[wipe-peers] deleted', key)
  }

  await core.close()
  console.log('[wipe-peers] done')
}

main().catch((e) => {
  console.error('[wipe-peers] failed:', e)
  process.exit(1)
})
