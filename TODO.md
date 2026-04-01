# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 69 | Notification tap (warm start) doesn't navigate to child's Requests tab — lands on Dashboard | `app/index.tsx` — `navigate:child:alerts` event still not reaching Dashboard handler; buffering may need revisit |
| 71 | Some notifications show package name instead of app name | `UsageStatsModule.java`, `ParentConnectionService.java` — resolve label via `pm.getApplicationLabel` |
| 78 | FCM push for force-stopped parent (enhancement to #76 soft fix) | Add Firebase Messaging SDK; child stores parent FCM token (exchanged at pairing); child POSTs to FCM HTTP v1 API when parent is unreachable; parent `FirebaseMessagingService` shows native notification — survives force-stop on Android ≤12 |
| 77 | Cold-start notification tap still shows "Connecting..." and lands on Dashboard instead of Requests tab | `app/index.tsx` — `_pendingAlertsNav` set correctly but WebView still shows brief connecting state; navigation doesn't reach ChildDetail |

## Features

| # | Title | Where |
|---|-------|-------|
| 3 | Avatar customization | `Profile.jsx`, `app/setup.tsx`; base64 in Hyperbee `profile`, thumbnail in `hello` |
| 12 | Persistent parent identity key — decision needed | `documentDirectory` keypair survives data clear; keep vs. force fresh? |
| 16 | Approve All / Deny All per category (requires #15) | `AppsTab.jsx` — batch `app:decide` |
| 17 | Haptic feedback | `AppBlockerModule.java` (`Vibrator`); WebView (`navigator.vibrate()`) |
| 44 | Child: warn at 10/5/1 min before schedule or time-limit starts | `EnforcementService.java` — poll upcoming windows, heads-up notification |
| 49 | Grant specific apps permission to bypass schedule rules | `ScheduleTab.jsx` — "Exempt apps" picker; `AppBlockerModule.java` — skip schedule check |
| 50 | Clarify schedule rule UI text — rules are blackout windows, not permitted times | `ScheduleTab.jsx` — update heading, labels, placeholders |
| 53 | Child "Home" tab is a placeholder | `src/ui/components/ChildHome.jsx` — status, today's usage, active blocks, pending requests |
| 61 | Track and display active overrides in UI | New `overrides:list` bare method; child My Requests + parent ChildDetail |
