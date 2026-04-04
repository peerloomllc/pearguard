# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 85 | Contacts overrides not working | Can't add contacts on Parent device; untested on Child device |
| 93 | Time request sometimes dismisses overlay and unblocks app | Child submits time request but overlay disappears and app becomes usable before parent responds |

## Features

| # | Title | Where |
|---|-------|-------|
| 83 | Animation/feedback on approve/deny in Apps list | `AppsTab.jsx` — animate transition when app moves between Pending/Allowed/Blocked groups |
| 95 | Interactable Screen Time-style usage reports | High-level summary (total screen time, top apps, daily/weekly trends) with drill-down into per-app details and session history — a generic usage report independent of limits, like iOS Screen Time |
| 97 | Block overlay UI update | Block overlay buttons (Request Approval/Request Time/Enter PIN), PIN entry overlay, and time selection overlays need themed to match the new UI (colors, spacing, typography, Phosphor icons) |
