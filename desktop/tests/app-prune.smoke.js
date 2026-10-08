#!/usr/bin/env node
// Stand-alone test for desktop app pruning (src/enforcement/app-prune.js).
// Run from desktop/: `node tests/app-prune.smoke.js`.
const assert = require('assert')
const { computePrune } = require('../src/enforcement/app-prune')

let passed = 0
function ok(name) { console.log('  ok -', name); passed++ }
const apps = (n) => Array.from({ length: n }, (_, i) => 'win.app' + i)

console.log('app-prune')
{
  const r = computePrune(null, ['win.a', 'win.b'])
  assert.deepStrictEqual(r.removed, [])
  assert.deepStrictEqual(r.remember.sort(), ['win.a', 'win.b'])
  ok('the first scan prunes nothing and remembers what it saw')
}
{
  const r = computePrune(apps(20), apps(20).slice(1))
  assert.deepStrictEqual(r.removed, ['win.app0'])
  assert.strictEqual(r.remember.includes('win.app0'), false)
  ok('a program the last scan reported and this one does not is pruned')
}
{
  // A foreground-only program (never in any scan) is not in either list, so it
  // can never be named for pruning.
  const r = computePrune(['win.a', 'win.b'], ['win.a', 'win.b'])
  assert.deepStrictEqual(r.removed, [])
  ok('nothing changed, nothing pruned')
}
{
  const r = computePrune(apps(20), apps(20).slice(0, 10))
  assert.deepStrictEqual(r.removed, [])
  assert.strictEqual(r.suspect, true)
  assert.strictEqual(r.remember.length, 20)
  ok('a scan that suddenly loses half the list prunes nothing and forgets nothing')
}
{
  const r = computePrune(apps(100), apps(100).slice(11))
  assert.strictEqual(r.suspect, true)
  ok('more than 10 at once is treated as a bad scan even on a long list')
}
console.log(passed + ' checks passed')
