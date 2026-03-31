# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 60 | Parent PIN not carried over to child after Remove + re-pair | `bare-dispatch.js` `handleHello` — inject `pinHash` from parent `'policy'` key |
| 65 | Ghost child device reappears after Remove + force-stop/reinstall | `bare.js` `handleHello` — detect/re-unpair stale `blocked:` peers |
| 73 | Profile name change does not propagate to paired devices | `bare.js` / `bare-dispatch.js` — broadcast updated `hello` or new `profile:update` message on name change |
| 69 | App opens to "Connecting..." screen after tapping a notification | `app/index.tsx` — `dbReady` / deep-link sequencing race |
| 71 | Some notifications show package name instead of app name | `UsageStatsModule.java`, `ParentConnectionService.java` — resolve label via `pm.getApplicationLabel` |

## Features

| # | Title | Where |
|---|-------|-------|
| 3 | Avatar customization | `Profile.jsx`, `app/setup.tsx`; base64 in Hyperbee `profile`, thumbnail in `hello` |
| 12 | Persistent parent identity key — decision needed | `documentDirectory` keypair survives data clear; keep vs. force fresh? |
| 15 | Apps list: categories, expandable/collapsible sections, search | `AppsTab.jsx` |
| 16 | Approve All / Deny All per category (requires #15) | `AppsTab.jsx` — batch `app:decide` |
| 17 | Haptic feedback | `AppBlockerModule.java` (`Vibrator`); WebView (`navigator.vibrate()`) |
| 44 | Child: warn at 10/5/1 min before schedule or time-limit starts | `EnforcementService.java` — poll upcoming windows, heads-up notification |
| 49 | Grant specific apps permission to bypass schedule rules | `ScheduleTab.jsx` — "Exempt apps" picker; `AppBlockerModule.java` — skip schedule check |
| 50 | Clarify schedule rule UI text — rules are blackout windows, not permitted times | `ScheduleTab.jsx` — update heading, labels, placeholders |
| 53 | Child "Home" tab is a placeholder | `src/ui/components/ChildHome.jsx` — status, today's usage, active blocks, pending requests |
| 61 | Track and display active overrides in UI | New `overrides:list` bare method; child My Requests + parent ChildDetail |
