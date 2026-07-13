// Install (or refresh) the PearGuard GNOME Shell extension into the running
// user's local extensions directory so the Wayland foreground adapter has a
// D-Bus partner to query.
//
// We could ship to /usr/share/gnome-shell/extensions/ as part of the .deb
// (system-wide install) but that has two strikes against it:
//   1. GNOME 45+ still requires the user to enable per-uuid, so system-wide
//      doesn't avoid the enable step.
//   2. dpkg's postinst runs as root and can't see the interactive user's
//      DBus session to enable on their behalf.
// Per-user copy keeps install + enable in PearGuard's runtime where we have
// the user's session bus.
//
// Two limitations we accept:
//   - GNOME Shell can't load a new extension without a Shell restart. On X11
//     that's `Alt+F2 r`; on Wayland it requires a logout/login. The first
//     install therefore lights up the next session, not the current one. We
//     log the requirement and continue.
//   - The child can disable the extension via Settings -> Extensions. That's
//     a parental-control tamper concern, not addressed here.
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { execFile } = require('child_process')

const EXTENSION_UUID = 'pearguard-focus@peerloomllc.com'

function localExtensionsDir() {
  return path.join(os.homedir(), '.local/share/gnome-shell/extensions')
}

function localExtensionDir() {
  return path.join(localExtensionsDir(), EXTENSION_UUID)
}

// Compare two trees by CONTENT HASH.
//
// This used to compare file sizes only (despite a comment claiming size+mtime),
// which was wrong in both directions: a changed file that happened to keep its
// size was never copied, so a stale — possibly broken or incompatible —
// extension would run forever; and any size wobble triggered a full re-copy.
// Getting "are these the same?" right matters more than usual here, because the
// answer decides whether we disturb a *loaded* GNOME extension (see below).
function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function hashTree(dir, base = dir, acc = {}) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return null }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    const rel = path.relative(base, p)
    if (e.isDirectory()) hashTree(p, base, acc)
    else acc[rel] = hashFile(p)
  }
  return acc
}

function treesEqual(srcDir, destDir) {
  const a = hashTree(srcDir)
  const b = hashTree(destDir)
  if (!a || !b) return false
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  if (ka.length !== kb.length || ka.join('|') !== kb.join('|')) return false
  return ka.every((k) => a[k] === b[k])
}

// Sync src -> dest WITHOUT deleting the destination directory first.
//
// The old code did `fs.rmSync(destDir, { recursive: true })` before re-copying,
// which is needlessly destructive: if the copy then failed, the child was left
// with NO extension at all. Overwriting in place (and pruning only what we no
// longer ship) keeps the tree usable throughout.
//
// To be clear about what this does NOT fix: writing here still knocks a LOADED
// extension offline — GNOME unloads on any file change and Wayland can't reload.
// Avoiding that is the caller's job (see the deferral in ensureExtensionInstalled);
// syncTree is only ever meant to run when the extension isn't live, or at quit.
function syncTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const keep = new Set()
  for (const name of fs.readdirSync(srcDir)) {
    const sp = path.join(srcDir, name)
    const dp = path.join(destDir, name)
    keep.add(name)
    if (fs.statSync(sp).isDirectory()) {
      syncTree(sp, dp)
    } else {
      // Only rewrite files that actually differ, so an unchanged file's mtime
      // isn't churned (GNOME watches these paths).
      let same = false
      try { same = fs.existsSync(dp) && hashFile(sp) === hashFile(dp) } catch (_) {}
      if (!same) fs.copyFileSync(sp, dp)
    }
  }
  // Remove anything we no longer ship, so a renamed/removed file doesn't linger.
  for (const name of fs.readdirSync(destDir)) {
    if (keep.has(name)) continue
    fs.rmSync(path.join(destDir, name), { recursive: true, force: true })
  }
}

function runGnomeExtensions(args, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    execFile('gnome-extensions', args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        // ENOENT: gnome-extensions tool missing (non-GNOME session, e.g.
        // KDE Wayland). Caller treats as "best-effort skip".
        resolve({ ok: false, error: err.message, stdout, stderr })
        return
      }
      resolve({ ok: true, stdout, stderr })
    })
  })
}

// Idempotent: copies the extension dir from the packaged resources to the
// user's extensions dir if missing or stale, then enables it if disabled.
// Returns { installed, enabled, requiresShellRestart, reason? } so the caller
// can log appropriately. Safe to call from app.whenReady before any of the
// enforcement controller exists.
async function ensureExtensionInstalled({ sourceDir, logger = console, isLive = false } = {}) {
  if (process.platform !== 'linux') return { installed: false, enabled: false, reason: 'not-linux' }
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    return { installed: false, enabled: false, reason: 'source-missing' }
  }
  const destDir = localExtensionDir()
  let copied = false
  const needsUpdate = !treesEqual(sourceDir, destDir)

  // THE UPDATE BLACKOUT.
  //
  // GNOME unloads an extension the moment its files change on disk — verified on
  // a real GNOME 48 Wayland session: a single `echo >> extension.js` flipped a
  // live extension to `State: INACTIVE` instantly. And on Wayland the Shell
  // cannot reload it (GNOME 45+ removed ReloadExtension); only a logout will.
  //
  // So writing an updated extension while it is LOADED destroys enforcement for
  // the rest of the session — every PearGuard update left the Linux child with
  // no app blocking at all until they next logged out, which could be days. In
  // place vs rm -rf makes no difference; the write itself is what does it.
  //
  // The only safe moment to write is when the Shell isn't holding it. So if the
  // extension is currently live, DEFER the write to quit: the session keeps its
  // working (old) extension, and the next login reads the new files and loads
  // them cleanly. If it isn't live, there's nothing to lose — write now.
  if (needsUpdate && isLive) {
    logger.log('[gnome-ext] update pending, but the extension is LIVE — deferring the write to quit '
      + 'so enforcement is not knocked offline for the rest of this session')
    return { installed: true, enabled: true, requiresShellRestart: false, deferredUpdate: true }
  }

  if (needsUpdate) {
    try {
      fs.mkdirSync(localExtensionsDir(), { recursive: true })
      // In-place sync, not rm -rf + copy: never delete a directory the Shell may
      // still be holding open (see syncTree).
      syncTree(sourceDir, destDir)
      copied = true
      logger.log('[gnome-ext] extension files updated in', destDir, '(was not live; safe to write now)')
    } catch (e) {
      logger.warn('[gnome-ext] copy failed:', e.message)
      return { installed: false, enabled: false, reason: 'copy-failed' }
    }
  } else {
    // Identical content: touch NOTHING. Rewriting files GNOME is watching would
    // knock the loaded extension offline for no reason at all.
    logger.log('[gnome-ext] extension already up to date; leaving files untouched')
  }

  // gnome-extensions enable is idempotent for an already-enabled extension.
  // Failure modes here: non-GNOME session (tool missing) or DBus not reachable.
  const enableResult = await runGnomeExtensions(['enable', EXTENSION_UUID])
  if (!enableResult.ok) {
    logger.warn('[gnome-ext] enable failed:', enableResult.error)
    return { installed: true, enabled: false, requiresShellRestart: copied, reason: 'enable-failed' }
  }
  // If we just copied a fresh tree, GNOME Shell still has the old copy in
  // memory. The new copy lights up only after a Shell restart.
  return { installed: true, enabled: true, requiresShellRestart: copied }
}

// Apply an update that was deferred because the extension was live. Called from
// before-quit: the session is ending anyway, so knocking the (about to die)
// Shell copy offline costs nothing, and the next login loads the new code.
function applyDeferredUpdate({ sourceDir, logger = console } = {}) {
  try {
    if (!sourceDir || !fs.existsSync(sourceDir)) return false
    const destDir = localExtensionDir()
    if (treesEqual(sourceDir, destDir)) return false
    fs.mkdirSync(localExtensionsDir(), { recursive: true })
    syncTree(sourceDir, destDir)
    logger.log('[gnome-ext] deferred extension update written at quit; next login picks it up')
    return true
  } catch (e) {
    logger.warn('[gnome-ext] deferred update failed:', e.message)
    return false
  }
}

module.exports = {
  ensureExtensionInstalled,
  applyDeferredUpdate,
  treesEqual,
  syncTree,
  localExtensionDir,
  EXTENSION_UUID,
}
