#!/usr/bin/env node
// Guards against desktop/vendor/src/ silently drifting from the repo's src/.
//
// vendor/src/ is a gitignored COPY of pearguard/src/, made by scripts/prepack.js,
// and it is what the desktop app actually runs (main/index.js requires
// ../../vendor/src/bare.js). Nothing re-copied it on a dev launch, so editing
// src/bare.js and running the desktop app would silently execute the OLD worklet.
// Two peers then speak subtly different versions of the same protocol — which is
// exactly the kind of bug that costs a day to find, because the source you're
// reading is not the source that's running.
//
// This module is deliberately dependency-free and sync so it can be called from
// Electron's main process at startup as well as from the CLI.
//
// Usage:
//   node scripts/check-vendor.js     -> exits 1 and names the drifted files
//   require('./check-vendor').checkVendorFreshness()

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Must match prepack.js: it copies every top-level .js from src/, minus EXCLUDE.
const EXCLUDE = new Set(['policy.test.js'])

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Compare desktop/vendor/src/ against the repo's src/.
 *
 * Returns { ok, skipped, reason, drifted[], missing[] }.
 * `skipped` is true when there's no src/ to compare against — a packaged app, or
 * a build tree that only received desktop/. That's not a failure: we simply have
 * no ground truth, and claiming freshness we can't verify would be worse.
 */
function checkVendorFreshness({
  srcDir = path.resolve(__dirname, '..', '..', 'src'),
  vendorSrc = path.resolve(__dirname, '..', 'vendor', 'src'),
} = {}) {
  if (!fs.existsSync(srcDir)) {
    return { ok: true, skipped: true, reason: 'no src/ to compare against', drifted: [], missing: [] }
  }
  if (!fs.existsSync(vendorSrc)) {
    return { ok: false, skipped: false, reason: 'vendor/src does not exist — run prepack', drifted: [], missing: ['(all)'] }
  }

  const drifted = []
  const missing = []
  for (const name of fs.readdirSync(srcDir)) {
    if (!name.endsWith('.js')) continue
    if (EXCLUDE.has(name)) continue
    const from = path.join(srcDir, name)
    if (!fs.statSync(from).isFile()) continue
    const to = path.join(vendorSrc, name)
    if (!fs.existsSync(to)) { missing.push(name); continue }
    if (sha256(from) !== sha256(to)) drifted.push(name)
  }

  const ok = drifted.length === 0 && missing.length === 0
  return { ok, skipped: false, reason: ok ? 'fresh' : 'stale', drifted, missing }
}

module.exports = { checkVendorFreshness }

if (require.main === module) {
  const r = checkVendorFreshness()
  if (r.skipped) {
    console.log('[check-vendor] skipped:', r.reason)
    process.exit(0)
  }
  if (r.ok) {
    console.log('[check-vendor] vendor/src is in sync with src/')
    process.exit(0)
  }
  console.error('')
  console.error('  desktop/vendor/src/ is STALE — the desktop app would run OLD code.')
  console.error('')
  for (const f of r.drifted) console.error('    drifted : src/' + f)
  for (const f of r.missing) console.error('    missing : src/' + f)
  console.error('')
  console.error('  vendor/src/ is a copy of src/, and it is what the desktop app actually')
  console.error('  runs. Refresh it with:   node scripts/prepack.js')
  console.error('')
  process.exit(1)
}
