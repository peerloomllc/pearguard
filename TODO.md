# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 78 | FCM push for force-stopped parent (enhancement to #76 soft fix) | Add Firebase Messaging SDK; child stores parent FCM token (exchanged at pairing); child POSTs to FCM HTTP v1 API when parent is unreachable; parent `FirebaseMessagingService` shows native notification — survives force-stop on Android ≤12 |
| 85 | Contacts overrides not working | Can't add contacts on Parent device; untested on Child device |
| 93 | Time request sometimes dismisses overlay and unblocks app | Child submits time request but overlay disappears and app becomes usable before parent responds |

## Features

| # | Title | Where |
|---|-------|-------|
| 12 | Persistent parent identity key — decision needed | `documentDirectory` keypair survives data clear; keep vs. force fresh? |
| 79 | About page on Parent device | Match PearCal's `AboutTab` — app name/tagline, "How It Works" (P2P explainer + pears.com link), Support Development (Bitcoin Lightning `pearloomllc@strike.me`, Buy Me a Coffee), Learn About Bitcoin (Nakamoto Institute), Share the App, Contact (email `peerloomllc@proton.me`, GitHub Issues), version number. Reference: `~/peerloomllc/pearcal-native/src/ui/App.jsx` lines 3975-4141 |
| 83 | Animation/feedback on approve/deny in Apps list | `AppsTab.jsx` — animate transition when app moves between Pending/Allowed/Blocked groups |
| 87 | UI overhaul session | Full review and refresh of visual design across all screens — colors, spacing, typography, consistency |
| 92 | More reliable/accurate usage metrics | Investigate options for improving usage stats reliability and accuracy |
| 95 | Interactable Screen Time-style usage reports | High-level summary (total screen time, top apps, daily/weekly trends) with drill-down into per-app details and session history — a generic usage report independent of limits, like iOS Screen Time |
