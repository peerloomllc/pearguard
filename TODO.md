# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 85 | Contacts overrides not working | Can't add contacts on Parent device; untested on Child device |
| 98 | Investigate Tailscale VPN compatibility | Tailscale breaks Hyperswarm P2P connections; need to investigate split tunneling or relay options |

## Features

| # | Title | Where |
|---|-------|-------|
| 102 | iOS parent-only version | Feasible as parent-only device; enforcement can't port (no Accessibility/DeviceAdmin APIs). P2P pairing, policy sync, and UI all work. Child device stays Android. Only limitation: no background connectivity on iOS, parent must open app to sync. |
| 103 | Adapt PearCal release script to PearGuard | Port the PearCal build/release script for PearGuard releases |
