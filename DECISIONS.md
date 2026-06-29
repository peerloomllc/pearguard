# DECISIONS

Per-app decision log for PearGuard. Append-only, newest on top. See `/home/tim/peerloomllc/CONSTITUTION.md` §4 for the entry format.

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
