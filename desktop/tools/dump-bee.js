// Dump all key/value pairs from the child's Hyperbee. Read-only.
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
  // Prefer the renamed package's root; fall back to the legacy name so this
  // tool can still inspect a kid's machine that hasn't been migrated yet.
  const candidates = [userDataRoot('pearguard-desktop'), userDataRoot('pearguard-windows')]
  const fs = require('fs')
  const userData = candidates.find((p) => fs.existsSync(path.join(p, 'pearguard', 'core'))) || candidates[0]
  const coreDir = path.join(userData, 'pearguard', 'core')
  const core = new Hypercore(coreDir)
  const db = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await db.ready()
  for await (const { key, value } of db.createReadStream()) {
    const val = typeof value === 'object' ? JSON.stringify(value) : String(value)
    console.log(key, '=', val.length > 200 ? val.slice(0, 200) + '...' : val)
  }
  await core.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
