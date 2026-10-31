#!/usr/bin/env node
// Release check: does the GNOME focus extension accept the newest GNOME Shell?
//
// GNOME refuses to load an extension whose metadata.json "shell-version" list
// lacks the running Shell's major version (state OUT_OF_DATE). When that happens
// on a child's PC, PearGuard can't see the focused window, so nothing is blocked
// and no screen time is counted. Ubuntu 26.04 shipped GNOME 50 while we listed
// 45-48 (#313).
//
// Reads gnome-shell's release list from download.gnome.org and compares the
// newest major that has an rc or stable tarball (an rc gives a few weeks'
// warning before distros ship it). Exit 0 = covered, 1 = missing,
// 0 with a warning when the list can't be fetched (offline releases still work).

const fs = require('fs')
const path = require('path')
const https = require('https')

const METADATA = path.join(__dirname, '..', 'desktop', 'build', 'gnome-extension', 'metadata.json')
const CACHE_URL = 'https://download.gnome.org/sources/gnome-shell/cache.json'

function fetchJson (url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)) }
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')) })
  })
}

// "50.6" and "51.rc" count; "51.alpha" and "51.beta" don't.
function newestReleasedMajor (versions) {
  let newest = 0
  for (const v of versions) {
    const m = /^(\d+)\.(rc|\d+)/.exec(v)
    if (m && Number(m[1]) > newest) newest = Number(m[1])
  }
  return newest
}

async function main () {
  const listed = JSON.parse(fs.readFileSync(METADATA, 'utf8'))['shell-version'].map(String)
  let cache
  try {
    cache = await fetchJson(CACHE_URL)
  } catch (e) {
    console.warn('    WARNING: could not check the newest GNOME version (' + e.message + '). Skipping.')
    return 0
  }
  const newest = newestReleasedMajor(Object.keys(cache[1]['gnome-shell'] || {}))
  if (!newest) {
    console.warn('    WARNING: no GNOME Shell versions found at ' + CACHE_URL + '. Skipping.')
    return 0
  }
  if (listed.includes(String(newest))) {
    console.log('    GNOME extension lists shell-version ' + newest + ' (newest GNOME). OK.')
    return 0
  }
  console.error('    The GNOME extension does not list GNOME ' + newest + '.')
  console.error('    Listed: ' + listed.join(', ') + '. Children on GNOME ' + newest + ' would get no app blocking.')
  console.error('    Test the extension on GNOME ' + newest + ', then add "' + newest + '" to ' + path.relative(process.cwd(), METADATA) + '.')
  return 1
}

if (require.main === module) main().then((code) => process.exit(code))

module.exports = { newestReleasedMajor }
