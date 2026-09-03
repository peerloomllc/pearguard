# DECISIONS

Per-app decision log for PearGuard. Append-only, newest on top. See `/home/tim/peerloomllc/CONSTITUTION.md` §4 for the entry format.

## 2026-09-03 - a day of usage belongs to the child's calendar

Tier: T2
Context: `dailyTotals` rows were keyed by the CHILD's calendar (the Android
aggregate builds its date from a `Calendar` in the child's zone) but read by the
PARENT's (`usage:getDailySummaries` and `usage:getCategorySummary` built their
windows from the parent's `localDateStr()`), while sessions from the same report
were re-keyed into parent-local dates by `groupSessionsByLocalDate`. One store,
two calendars, read with a third assumption. Proved with the harness running the
child in Pacific/Kiritimati against a parent on this machine: on main the parent
asked for 2026-09-03/02/01, never asked for the child's own day 2026-09-04, and
filed the child's 1800 s onto 09-03.
Choice: the child's calendar owns the day. It is their screen time and their
midnight that resets the daily budget, so `usage:report` now carries `localDate`
and `tzOffsetMinutes`; the parent stores the offset as `childZone:{child}` and
uses `dateStrInZone` for session keys, for both summary windows, and for the
"is this the current day" test that decides whether to prefer sessions over the
native daily bucket.
Rejected: the parent's calendar. It makes the parent's dates always match their
own phone, but a child's evening would land on the parent's next day and it
disagrees with the budget reset the child actually lives through.
Compat and migration: an older child sends neither field, `childZoneOffset`
returns null, and `dateStrInZone` with no offset is exactly `localDateStr`, so
that pairing behaves as it always did. No migration is run over existing rows:
sessions already written under parent-local dates stay where they are, which for
a same-zone family (every pairing today) is the same string anyway. A family
already split across zones will see its old rows settle onto the child's
calendar as new reports arrive.
Tim approved building this without a separate proposal on 2026-09-03, having
seen the evidence that the originally reported bug (a distant parent seeing
today's usage zeroed by `dateGateReport`) does not exist.

## 2026-09-03 - child-initiated leave: PIN plus a 24 hour countdown, no block on commit

Tier: T3
Context: a child device only resets when a parent sends `unpair`. If the only
parent's phone is lost, stolen or wiped with no backup, the device stays
enforced forever and the sole exit is uninstalling, which on Android also means
fighting the accessibility service the app installed. A family that loses a
phone should not have to factory-reset a child's tablet.
Choice: `leave:request` takes any parent's PIN (`policy.pinHashes`, plus the
pre-#122 `pinHash`) and schedules the leave 24 hours out rather than acting on
it. The parent is told immediately and on every reconnect, sees it on the child
card and in Activity, and can cancel from the child's screen. The child can
cancel too, with the PIN. On commit the child tells its parents (`leave:committed`),
wipes every key, rotates its identity and destroys the swarm.
Rejected: an immediate leave (a child who learns the PIN frees the device on the
spot, with no chance for the parent to object); a separate leave PIN (one more
secret for a parent to lose, and this exists for a parent who has already lost
something); gating on 7 days of no parent contact (tighter, but a parent on a
long holiday would trip it).
Correction (same day): the entry below claimed wrong PINs at the leave screen
feed the overlay's brute-force ladder. They did not: that ladder is native, in
AppBlockerModule, and a WebView screen cannot reach it, so the leave screen
shipped with no throttle on either platform. Found while auditing whether the
desktop client had kept up with the day's child-side changes. Fixed by keeping
the counter and the same ladder in the worklet (5 free attempts, then 30 s /
2 min / 10 min / 1 h, persisted as `leaveAttempts`, a backward clock serving the
full remaining wait), which has the side benefit of behaving identically on
desktop, where there is no native lockout at all. A fresh lockout relays the
existing `pin:failure` alert to the parent, so guessing is visible.
Clock: the countdown is checked on the existing heartbeat tick, never timed, so
it survives force-stop and reboot. Winding the clock forward is the obvious
attack, so the commit also requires an hour of *observed* running, accumulated
in capped 5-minute credits per tick; a backward jump credits nothing and cannot
cancel the leave.
The parent does NOT write `blocked:` on `leave:committed`, unlike `child:unpair`.
This was not a removal and the family may well want to pair again; the child has
rotated its identity anyway, so it returns as a new peer. Proven by the harness
re-pairing immediately after a commit.
Proposal: proposals/2026-09-03-child-initiated-leave.md

## 2026-06-29 - cumulative daily screen-time cap (policy.dailyScreenTimeLimitSeconds)
Tier: T2 (proposal: proposals/2026-06-29-cumulative-screen-time-limit.md, issue #175)
Context: parents could blanket-block by schedule or cap per-app/per-category time, but had no way to cap total device use per day. Requested in #175.
Choice: new optional top-level policy field dailyScreenTimeLimitSeconds (seconds; absent or <=0 = off). Enforced device-wide once total foreground time for the day crosses the cap. Gate sits after the active-override check and before the schedule check in all three engines (AppBlockerModule.getBlockReason, desktop block-evaluator.evaluate, src/policy.js isAppBlocked reference). Block category "screen_time" reuses the daily_limit downstream path (Request More Time + per-package override bypass). Standard exemptions (PearGuard, phone/messaging, system shells) never count toward the total and stay reachable. Android sums all foreground sessions in a single event pass; desktop/reference sum reported per-app usage.
Alternatives: count phone/messaging toward the cap (rejected - matches device-lock exemptions); a separate Hyperbee key for the limit (rejected - rides inside the existing policy value, no new key, transparently forwarded by policy:update).
Consequences: additive and backward-compatible - old peers ignore the unknown field and do not enforce. A granted time request for the foreground app bypasses the cap for that app by design. Minor cross-platform total-counting difference noted in the proposal's open questions.

## 2026-06-08 - block overlay fully suppressed while screen off or locked
Tier: T1
Context: a schedule block (e.g. Bedtime) firing while the screen was off left the fullscreen accessibility overlay stuck over the lock screen; the child could not enter their device PIN, request more time or reach the restart option, and a PearGuard PIN override was accepted but the overlay re-appeared. Root cause: the only gate was KeyguardManager.isKeyguardLocked(), which reads false on non-secure locks and during the delay before the keyguard engages after sleep, and nothing re-checked it on screen-off.
Choice: gate overlay display on screen-interactive AND keyguard AND an awaiting-unlock flag; register a runtime BroadcastReceiver that tears the overlay down on ACTION_SCREEN_OFF and resumes only after USER_PRESENT (or SCREEN_ON on non-secure devices).
Alternatives: keyguard-only check with a shorter poll interval (still leaks on non-secure/delayed locks); key the PIN override to the schedule rule instead of the package (does not fix the lock-screen lockout).
Consequences: enforcement is intentionally inactive while the screen is off or the lock screen is up; apps cannot be launched from those states anyway, so no bypass. Android-local only, no Hyperbee/IPC/wire change.

<!-- No decisions recorded yet. First entry goes above this comment. -->
