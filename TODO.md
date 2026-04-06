# PearGuard TODO

Open items only. Completed items are in `DONE.md`.

## Bugs

| # | Title | Where |
|---|-------|-------|
| 85 | Contacts overrides not working | Can't add contacts on Parent device; untested on Child device |
| 93 | Time request sometimes dismisses overlay and unblocks app | Child submits time request but overlay disappears and app becomes usable before parent responds |
| 98 | Investigate Tailscale VPN compatibility | Tailscale breaks Hyperswarm P2P connections; need to investigate split tunneling or relay options |
| 99 | Usage Reports show previous day's data on new day | UTC date keys cause sessions flushed in evening local time to appear under next day; also "12a"/"11p" chart labels cut off |

## Features

| # | Title | Where |
|---|-------|-------|
| 101 | Rethink Add Child (+) button invite flow | FAB in bottom right doesn't generate invite until navigating back to Dashboard; needs redesign |
