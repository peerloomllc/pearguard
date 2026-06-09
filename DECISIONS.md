# DECISIONS

Per-app decision log for PearGuard. Append-only, newest on top. See `/home/tim/peerloomllc/CONSTITUTION.md` §4 for the entry format.

## 2026-06-08 - block overlay fully suppressed while screen off or locked
Tier: T1
Context: a schedule block (e.g. Bedtime) firing while the screen was off left the fullscreen accessibility overlay stuck over the lock screen; the child could not enter their device PIN, request more time or reach the restart option, and a PearGuard PIN override was accepted but the overlay re-appeared. Root cause: the only gate was KeyguardManager.isKeyguardLocked(), which reads false on non-secure locks and during the delay before the keyguard engages after sleep, and nothing re-checked it on screen-off.
Choice: gate overlay display on screen-interactive AND keyguard AND an awaiting-unlock flag; register a runtime BroadcastReceiver that tears the overlay down on ACTION_SCREEN_OFF and resumes only after USER_PRESENT (or SCREEN_ON on non-secure devices).
Alternatives: keyguard-only check with a shorter poll interval (still leaks on non-secure/delayed locks); key the PIN override to the schedule rule instead of the package (does not fix the lock-screen lockout).
Consequences: enforcement is intentionally inactive while the screen is off or the lock screen is up; apps cannot be launched from those states anyway, so no bypass. Android-local only, no Hyperbee/IPC/wire change.

<!-- No decisions recorded yet. First entry goes above this comment. -->
