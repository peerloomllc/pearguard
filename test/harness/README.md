# Headless bare P2P harness

Drives two (or more) real `src/bare.js` instances headlessly under Node so
parent↔child interactions can be tested autonomously — no Android emulator, no
iOS simulator, no device. Instances discover and pair over the **live Hyperswarm
DHT**, exactly as two devices would, so this exercises the true P2P path (invite,
pairing, policy, time-grants, co-parent handling), not a mock.

It does **not** cover the native Android enforcement layer (accessibility service,
app blocking) or any WebView UI — those still need a real device.

## Run

```bash
npm run test:harness            # run every scenario
npm run test:harness pair       # run scenarios whose name matches "pair"
```

Needs outbound network for the DHT. Each scenario takes a few seconds (pairing is
typically 2-4s). This is intentionally **not** part of `npm test` / CI — it does
real networking and would be slow and flaky there.

## How it works

- `bare-runner.js` — boots ONE `bare.js` in a forked process with a shim for the
  `BareKit.IPC` global the RN/Electron shell normally provides. It bridges bare's
  JSON-over-newline IPC to the orchestrator over `child_process` IPC.
- `harness-lib.js` — spawns/kills/respawns instances (each with its own temp data
  dir, so each keeps an independent Hyperbee identity), and provides `call`
  (dispatch a method, await its response) and `waitEvent` (await an emitted event).
  `kill` + `respawn` reuse the same data dir to simulate a device going offline and
  coming back with the same identity.
- `scenarios/*.js` — one file per scenario, each exporting `{ name, run(lib, log) }`.
  A scenario throws to fail, returns to pass, and tears down its own instances.
- `run.js` — runs the scenarios and prints a pass/fail summary (non-zero exit on
  any failure).

## Scenarios

| File | Covers |
|------|--------|
| `01-pair.js` | Two instances pair over Hyperswarm; both sides see each other in `children:list`. |
| `02-coparent-dedup.js` | PR #211 — two different parents sharing a display name both survive on the child (the old dedup deleted one). |
| `03-offline-time-grant.js` | PR #210 — a grant approved while the child is offline is re-sent and applied when the child reconnects. |
| `04-policy-propagation.js` | Parent `policy:update` reaches the child; `policy:getCurrent` reflects it. |
| `05-unpair-repair.js` | Parent `child:unpair` resets the child (identity rotates); the two then re-pair cleanly. |
| `06-new-app-approval.js` | Child `app:installed` surfaces in the parent inbox; `app:decide` propagates the decision back. |
| `07-offline-message-queue.js` | A child message sent while the parent is offline is queued and delivered on reconnect. |

Total run ~90s (the offline scenarios each wait ~15-20s for the peer to notice a
hard disconnect). Run individually while iterating: `npm run test:harness <name>`
(substring match — note `pair` also matches `unpair-repair`).

## Adding a scenario

Drop a `scenarios/NN-name.js` exporting `{ name, run }`. Inside `run`, use
`spawnInstance` / `init` / `call` / `waitEvent` / `teardown` from the lib. Prefer a
numeric prefix to keep ordering stable. Useful method + event names live in
`src/bare-dispatch.js` (dispatch `case` labels) and `src/bare.js` (`event:` strings).
