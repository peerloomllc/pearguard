const { execFile } = require('child_process')

// Read VersionInfo.FileDescription for a given exe path. Used to label
// first-seen apps with something human-readable ("Roblox" rather than
// "RobloxPlayerBeta"). Returns '' on any failure — the caller falls back
// to the exe basename.
function defaultPowershellExec(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { maxBuffer: 1 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout || '')
      },
    )
  })
}

async function readFileDescription(exePath, { exec = defaultPowershellExec, logger = console } = {}) {
  if (!exePath || typeof exePath !== 'string') return ''
  if (process.platform !== 'win32' && exec === defaultPowershellExec) return ''
  const escaped = exePath.replace(/'/g, "''")
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $item = Get-Item -LiteralPath '${escaped}'
  if ($item -and $item.VersionInfo) { $item.VersionInfo.FileDescription }
} catch { '' }
`.trim()
  let stdout
  try {
    stdout = await exec(script)
  } catch (e) {
    logger.warn('[exe-metadata] powershell invocation failed:', e.message)
    return ''
  }
  return String(stdout || '').replace(/^\uFEFF/, '').trim()
}

module.exports = { readFileDescription }
