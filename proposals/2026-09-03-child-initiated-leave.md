# Child-initiated leave (PIN-gated)

**Goal** - Give a child device a way to unpair itself when the only parent's phone is gone for good, without weakening enforcement for a child whose parent is simply not looking.

**Tier** - T3. It touches unpair semantics and adds an authenticated action on the child, both named explicitly in the constitution's T3 list.

## The problem

A child device only resets when a parent sends `unpair` (`bare.js`, the `unpair` peer-message case). There is no child-side leave anywhere in `ChildApp.jsx`, `ChildHome.jsx` or `Profile.jsx`; `child:reset` exists only as a shell-side event handler. So if the single parent's phone is lost, stolen or wiped with no backup, the child device stays enforced forever and the only exit is uninstalling PearGuard, which on Android also means fighting the accessibility service and device admin the app installed. A family that loses a phone should not have to factory-reset a child's tablet.

## Scope

What changes:

- **New dispatch methods on the child**: `leave:request` (takes a PIN, verifies it against `policy.pinHashes` with the same BLAKE2b comparison `pin:verify` uses, and on success records `leaveScheduled` = `{ at, effectiveAt }`), `leave:cancel` (clears it; reachable from the child's own screen with the PIN, and from the parent) and `leave:status` (for the UI countdown). A `leave:commit` step runs the reset once `effectiveAt` passes: wipe every Hyperbee key, rotate the identity keypair, destroy the swarm, emit `child:reset`.
- **The countdown is checked, not timed.** The child evaluates `leaveScheduled` on its existing heartbeat tick and whenever the child screen loads, the same pattern the request expiry uses (#248), so it survives a force-stop or reboot rather than depending on a live timer.
- **A moved clock cannot shorten it.** `effectiveAt` is stored as wall-clock, and the commit additionally requires that the device's monotonic uptime accumulated since the request is at least the remaining wall time, falling back to wall-clock only across a genuine reboot. Winding the clock forward a day is the obvious attack and must not work.
- **Throttled like the block screen.** Wrong attempts cost the same ladder as the overlay keypad: 5 free, then 30 s / 2 min / 10 min / 1 h, persisted so it survives a force-stop or reboot, and a clock wound back to before the lock serves the full remaining wait rather than reading as expired.

  **Correction, 2026-09-03:** as first shipped this was not true. The overlay's ladder lives in `AppBlockerModule` and is driven by native code, so a WebView screen cannot feed it; the leave screen went out with no throttle at all, on Android and desktop alike, while this line and the code comment both claimed otherwise. It was found by auditing desktop/mobile consistency and fixed by keeping the counter and the ladder in the worklet (`leaveLockoutForFailCount`, `leaveLockRemainingMs`, persisted as `leaveAttempts`), which also makes the two platforms behave identically rather than leaving desktop with nothing. While locked, even the correct PIN is refused and further guesses neither count nor extend the wait.
- **The parent is told, loudly and repeatedly.** On the request, and on every reconnect during the countdown, the child relays a `leave:scheduled` alert carrying `effectiveAt`. The parent's dashboard shows the child as scheduled to leave with the time, and the parent can cancel it. On commit, a best-effort `unpair` goes to every connected parent so a reachable parent sees the child leave rather than a device that silently goes quiet. If nobody is connected, the leave proceeds anyway; that is the whole point.
- **Child UI**: an entry in the child's Profile screen, deliberately not on the home screen. Wording states plainly that it needs the parent's PIN, that the parent will be told, and that it takes a day. While a leave is pending the child's home screen shows the countdown and a cancel button.

What does not change:

- **One new wire message**, `leave:scheduled` (child to parent, carrying `effectiveAt`), plus new *usage* of the existing `unpair` type in the child-to-parent direction, which the parent's existing handler already understands. Cancel from the parent reuses the existing parent-to-child path.
- No change to `pin:verify`, to override grants, or to how PINs are set or stored.
- No change to the parent-initiated unpair path.
- Desktop child gets the same dispatch method; its UI can follow separately.

## The security question, stated plainly

This hands a child an escape hatch that did not exist. It is only as strong as the PIN, and the PIN already unlocks any blocked app on that device, so a child who knows it can already defeat enforcement app by app. The new capability is that they can defeat it permanently in one action rather than repeatedly.

**Decided 2026-09-03 (Tim):** a correct PIN starts a **24-hour countdown**, not an immediate wipe, and the secret is the **existing override PIN**.

- A waiting period is what makes this safe to ship. An impulsive child gets a day in which their parent is told, repeatedly, that the device is scheduled to leave, and can cancel it from their phone. The lost-phone case is unaffected: nobody is there to cancel, so the day passes and the device frees itself.
- A separate leave PIN was rejected: it is one more secret for a parent to lose, and this feature exists precisely for a parent who has lost something. The override PIN already unblocks any single app on that device, so it is not a new secret and not a new level of trust.
- Rejected: refusing to leave until a parent has been out of contact for 7 days. It targets the failure more tightly, but a parent on a long holiday would trip it, and the countdown already gives a present parent the chance to say no.

## Compat

Old parents are unaffected: they receive a plain `unpair`, which their existing handler already understands. An old child simply has no leave screen. No Hyperbee key changes shape; the leave reuses the wipe that already exists. Nothing to migrate.

## Verify

- Jest: PIN accepted and rejected, wrong-mode call refused, the countdown does not commit early, a moved clock does not shorten it, cancel clears it, and the commit wipes every key and rotates the identity.
- Harness: pair, child requests a leave with the correct PIN while the parent is connected, parent sees it scheduled and cancels it; then request again with the parent offline, let the countdown pass, and confirm the child frees itself and can re-pair with a new identity.
- Hardware: TCL schedules a leave, the Pixel shows it, and a shortened-window build proves the commit and the re-pair.

## Rollback

Revert the commit. The stored data model is unchanged, so a device that already left stays left, and one that has not is untouched.

## Open questions

None blocking. Settled above on 2026-09-03: 24-hour countdown, existing override PIN, no contact-based gate.
