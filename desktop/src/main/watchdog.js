// Scheduled-task watchdog registration. Raises the bar against a child who
// ends PearGuard.exe from Task Manager: the task reruns watchdog.vbs every
// two minutes, which relaunches the exe if it isn't running. Registered at
// user level (not SYSTEM) so the launched process lands in the interactive
// session with tray/UI. Uninstallation removes the task via the NSIS
// customUnInstall hook; the app re-registers on startup if it's ever missing.
const { execFile } = require('child_process')

const TASK_NAME = 'PearGuardWatchdog'

function runSchtasks(args) {
  return new Promise((resolve, reject) => {
    execFile('schtasks.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout
        err.stderr = stderr
        return reject(err)
      }
      resolve({ stdout, stderr })
    })
  })
}

async function isRegistered() {
  try {
    await runSchtasks(['/query', '/tn', TASK_NAME])
    return true
  } catch (_e) {
    return false
  }
}

async function register(vbsPath) {
  const tr = `wscript.exe "${vbsPath}"`
  await runSchtasks([
    '/create',
    '/tn', TASK_NAME,
    '/sc', 'MINUTE',
    '/mo', '2',
    '/tr', tr,
    '/rl', 'LIMITED',
    '/f',
  ])
}

async function ensureRegistered(vbsPath) {
  if (await isRegistered()) return { created: false }
  await register(vbsPath)
  return { created: true }
}

module.exports = { ensureRegistered, TASK_NAME }
