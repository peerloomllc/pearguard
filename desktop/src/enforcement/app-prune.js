// Which programs has the installed-programs scan stopped reporting?
//
// Android prunes uninstalled apps by passing bare the full installed set
// (installedAll). The desktop cannot do that: its policy also holds apps it
// only ever saw in the foreground (portable exes, games run from a folder;
// see 'app-first-seen' in main/index.js), which no scan will list. Pruning
// against the scan would delete the parent's rules for every one of them.
//
// So a program is pruned only when an earlier scan reported it and this one
// does not. And a scan that suddenly drops a lot at once (a PowerShell call
// that timed out, a desktop directory that failed to read) is treated as a bad
// scan rather than a mass uninstall: nothing is pruned, and the dropped
// programs stay remembered so a later good scan can still prune them.

const MAX_REMOVED = 10
const MAX_REMOVED_FRACTION = 0.2

/**
 * @param {string[]|null} previous  package names the last scan reported, or null on the first run
 * @param {string[]} current        package names this scan reported
 * @returns {{ removed: string[], remember: string[], suspect: boolean }}
 *   removed: names to prune; remember: names to store for next time
 */
function computePrune(previous, current) {
  const now = new Set(current)
  if (!Array.isArray(previous)) return { removed: [], remember: [...now], suspect: false }
  const removed = previous.filter((p) => !now.has(p))
  const suspect = removed.length > MAX_REMOVED || removed.length > previous.length * MAX_REMOVED_FRACTION
  if (suspect) return { removed: [], remember: [...new Set([...previous, ...current])], suspect: true }
  return { removed, remember: [...now], suspect: false }
}

module.exports = { computePrune, MAX_REMOVED, MAX_REMOVED_FRACTION }
