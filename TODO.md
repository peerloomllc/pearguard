# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 85 | Contacts overrides not working | Can't add contacts on Parent device; untested on Child device |
| 98 | Investigate Tailscale VPN compatibility | Tailscale breaks Hyperswarm P2P connections; need to investigate split tunneling or relay options |
| 124 | Android cold start notification tap goes to Dashboard instead of Activity tab | Warm open works correctly; cold start doesn't navigate to child. Rare edge case, non-blocking. |
| 137 | Windows enforcement: packageName mismatch between apps catalog and runtime resolve | `apps-enumerator.parseAndShape` synthesizes `win.<slug>` (e.g. `win.steam`) when the registry row's exe misses `DEFAULT_MAP`, while `exe-map.resolve` maps foreground helpers to the Android-style packageName (e.g. `com.valvesoftware.android.steam.community`). Parent's `policy.apps[pkg]` lookup misses → block never fires. Also bites MSIX apps like Keet: catalog uses `uwp.keet_*`, active-win reports bare `keet.exe` → null. Edge works because both sides land on `com.microsoft.emmx`. Fix: reconcile so one canonical packageName is produced per app on both paths. Verified on Win11 VM 2026-04-17. |

## Features

| # | Title | Where |
|---|-------|-------|
| 133 | Chore list to earn time | Child dashboard shows parent-assigned chores; completing them earns extra screen time |
| 135 | Investigate app storage usage | Likely Hyperbee bloat: append-only means every `put` writes new blocks (value + b-tree nodes), old versions never freed — worst on frequently-rewritten keys with embedded binary payloads. Check local Hyperbee size vs live-key count; if bloated, rebuild via new-core-swap (open `core.new/`, copy must-keep keys, close, `fs.rename` swap). Categorize keys as must-keep (authoritative: profile, group keys, tombstones, config) vs wipeable (re-mirrors from Autobase view). RocksDB `compactRange({FORCE,FORCE})` only helps if keys have been tombstoned/overwritten — near-zero reclaim on pure append-only. See PearCal: 377 MB → 8.7 MB (98%) via rebuild. Wiki: `p2p-wiki/wiki/concepts/hyperbee-bloat-and-reclaim.md` |

## Release Pre-work (before first release)

_All release pre-work complete._
