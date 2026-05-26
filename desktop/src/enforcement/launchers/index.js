// Entry point that runs every launcher scanner in parallel and returns a
// flat array of rows. One bad launcher (e.g. a Steam install whose
// libraryfolders.vdf is malformed) cannot break the other scanners or the
// rest of apps-enumerator; each result is Promise.allSettled so partial
// data still flows through.

const { scanSteam } = require('./steam')
const { scanEpic } = require('./epic')
const { enumerateRegistryLaunchers } = require('./registry-scanner')

async function enumerateLauncherApps({ exec, logger = console, fs } = {}) {
  const jobs = [
    ['steam', scanSteam({ exec, fs, logger })],
    ['epic', scanEpic({ fs, logger })],
    ['registry', enumerateRegistryLaunchers({ exec, fs, logger })],
  ]
  const results = await Promise.allSettled(jobs.map(([, p]) => p))
  const counts = {}
  const rows = []
  for (let i = 0; i < jobs.length; i++) {
    const [label] = jobs[i]
    const result = results[i]
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      counts[label] = result.value.length
      for (const r of result.value) if (r) rows.push(r)
    } else {
      counts[label] = 0
      if (result.status === 'rejected') {
        logger.warn('[launchers] ' + label + ' scanner rejected:', result.reason && result.reason.message)
      }
    }
  }
  if (typeof logger.log === 'function') {
    logger.log('[launchers] enumerated rows: steam=%d epic=%d registry=%d',
      counts.steam || 0, counts.epic || 0, counts.registry || 0)
  }
  return rows
}

module.exports = { enumerateLauncherApps }
