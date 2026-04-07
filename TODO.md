# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 85 | Contacts overrides not working | Can't add contacts on Parent device; untested on Child device |
| 98 | Investigate Tailscale VPN compatibility | Tailscale breaks Hyperswarm P2P connections; need to investigate split tunneling or relay options |
| 109 | App list not syncing to second parent | Second parent paired via QR code; usage stats sync but app list stays empty permanently, not just initial sync |

## Features

| # | Title | Where |
|---|-------|-------|
| 102 | iOS parent-only version | Feasible as parent-only device; enforcement can't port (no Accessibility/DeviceAdmin APIs). P2P pairing, policy sync, and UI all work. Child device stays Android. Only limitation: no background connectivity on iOS, parent must open app to sync. |
| 103 | Adapt PearCal release script to PearGuard | Port the PearCal build/release script for PearGuard releases |
| 108 | Multi-parent pairing: on-device validation | Backend implemented on feature/multi-parent-108; needs 3rd device to test multi-parent flows; co-parent invite UI not yet built |
| 110 | Co-parent invite UI | Add button on parent dashboard to generate co-parent invite link; currently only regular QR pairing works for adding a second parent |
