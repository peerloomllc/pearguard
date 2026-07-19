// src/package-reconcile.js
//
// Reconcile a child's policy app list against the packages actually installed on
// the device, returning the packages that should be pruned (uninstalled).
//
// Why this exists: the real-time PackageMonitor receiver never fires on Android
// 8+ (manifest receivers are banned from ACTION_PACKAGE_ADDED/REMOVED), so an app
// uninstalled on the child is never signalled and its policy entry lingers as
// stale "pending"/"blocked" clutter on both child and parent. apps:sync already
// re-adds any installed app on each full scan, but only ever adds - it never
// prunes. This computes the prune set for the apps:sync handler.
//
// `installedPackages` MUST be the full installed set (every package), not just
// launcher apps, so an installed-but-non-launchable app the parent explicitly
// blocked is never wrongly stripped. Entries may be plain package-name strings
// or objects with a `packageName` field (the getInstalledPackages shape).

function pendingUninstalls (policyPackages, installedPackages) {
  if (!Array.isArray(policyPackages)) return []
  const installed = new Set(
    (Array.isArray(installedPackages) ? installedPackages : [])
      .map((a) => (typeof a === 'string' ? a : a && a.packageName))
      .filter(Boolean)
  )
  const out = []
  const seen = new Set()
  for (const pkg of policyPackages) {
    if (typeof pkg !== 'string' || !pkg) continue
    if (installed.has(pkg)) continue // still installed — keep it
    if (seen.has(pkg)) continue
    seen.add(pkg)
    out.push(pkg)
  }
  return out
}

module.exports = { pendingUninstalls }
