// Dump all key/value pairs from the child's Hyperbee. Read-only.
const path = require('path')
const os = require('os')
const Hypercore = require('hypercore')
const Hyperbee = require('hyperbee')

async function main() {
  const userData = process.platform === 'win32'
    ? path.join(os.homedir(), 'AppData', 'Roaming', 'pearguard-windows')
    : path.join(os.homedir(), '.config', 'pearguard-windows')
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
