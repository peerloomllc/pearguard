#!/usr/bin/env node
// run.js — run the headless bare P2P scenarios sequentially and report.
//
//   node test/harness/run.js            # run all scenarios
//   node test/harness/run.js pair       # run scenarios whose name matches "pair"
//
// Each scenario spawns real bare.js instances that pair over the live Hyperswarm
// DHT, so this needs outbound network and is intentionally NOT part of `npm test`.
const fs = require('fs')
const path = require('path')

const SCEN_DIR = path.join(__dirname, 'scenarios')
const filter = process.argv[2]

async function main () {
  const files = fs.readdirSync(SCEN_DIR).filter((f) => f.endsWith('.js')).sort()
  const scenarios = files
    .map((f) => require(path.join(SCEN_DIR, f)))
    .filter((s) => !filter || s.name.includes(filter))

  const results = []
  for (const s of scenarios) {
    const log = (...a) => console.log(`  [${s.name}]`, ...a)
    process.stdout.write(`\n▶ ${s.name}\n`)
    const t0 = Date.now()
    try {
      await s.run(require('./harness-lib'), log)
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`✔ PASS ${s.name} (${secs}s)`)
      results.push({ name: s.name, ok: true })
    } catch (e) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1)
      console.log(`✗ FAIL ${s.name} (${secs}s): ${e.message}`)
      results.push({ name: s.name, ok: false, error: e.message })
    }
  }

  const passed = results.filter((r) => r.ok).length
  console.log(`\n${'─'.repeat(48)}`)
  console.log(`${passed}/${results.length} scenarios passed`)
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL ${r.name}: ${r.error}`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
