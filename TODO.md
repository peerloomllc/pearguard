# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 78 | FCM push for force-stopped parent (enhancement to #76 soft fix) | Add Firebase Messaging SDK; child stores parent FCM token (exchanged at pairing); child POSTs to FCM HTTP v1 API when parent is unreachable; parent `FirebaseMessagingService` shows native notification — survives force-stop on Android ≤12 |
| 85 | Contacts overrides not working | Can't add contacts on Parent device; untested on Child device |

## Features

| # | Title | Where |
|---|-------|-------|
| 12 | Persistent parent identity key — decision needed | `documentDirectory` keypair survives data clear; keep vs. force fresh? |
| 79 | About page on Parent device | Match PearCal's `AboutTab` — app name/tagline, "How It Works" (P2P explainer + pears.com link), Support Development (Bitcoin Lightning `pearloomllc@strike.me`, Buy Me a Coffee), Learn About Bitcoin (Nakamoto Institute), Share the App, Contact (email `peerloomllc@proton.me`, GitHub Issues), version number. Reference: `~/peerloomllc/pearcal-native/src/ui/App.jsx` lines 3975-4141 |
| 83 | Animation/feedback on approve/deny in Apps list | `AppsTab.jsx` — animate transition when app moves between Pending/Allowed/Blocked groups |
| 84 | Move overrides on Parent from Requests tab to Apps list | `AppsTab.jsx` — show active override badge/timer per app; remove from `RequestsTab.jsx` |
| 87 | UI overhaul session | Full review and refresh of visual design across all screens — colors, spacing, typography, consistency |
| 91 | Save button for app time limits | Better UX: add a Save button next to per-app time limit inputs instead of auto-saving |
| 92 | More reliable/accurate usage metrics | Investigate options for improving usage stats reliability and accuracy |
