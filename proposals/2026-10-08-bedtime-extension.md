# Bedtime extension request

**Goal** - When a bedtime schedule blocks the phone, the child can ask for more time for the whole device, and an approval lifts the bedtime block for every app until the time runs out.

**Tier** - T2. It adds a field to the `time:request` and `time:extend` P2P payloads and to stored request and override records.

## Today

A schedule block on one app offers "Request More Time". The child picks a duration and the parent's approval creates an override for that one app only. That override also skips the app's limits and blocked status, because the override check runs before every other rule (`AppBlockerModule.java` step 1, `block-evaluator.js` ~148). At bedtime the child has to ask once per app.

## Scope

Decided 2026-10-08 (Tim):

- **The extension lifts schedule rules only.** Daily limits, category limits, the screen-time cap, blocked and pending apps and per-app time windows still apply.
- **The child picks the duration with the existing extra-time picker** (`getTimeRequestOptions()` on Android, `[15,30,60,120]` or `timeRequestMinutes` on desktop).

Changes:

1. **Child request.** When the block comes from a schedule rule ("Blocked during ..."), but not from a per-app window, the picker sends `requestType: 'extra_time'` plus `scope: 'device'`. The new field is carried by:
   - Android: `TimeRequestQueueHelper` and the queue drain in `app/index.tsx`
   - Desktop: the evaluator marks schedule-rule blocks so the overlay can tell them from app windows
   - Bare: the `time:request` dispatch, the stored `req:` record, the P2P payload and the reconnect re-send in `bare.js`
2. **Parent.** `handleIncomingTimeRequest` and `alerts:list` keep `scope`. `PendingRequestCard` titles it "Bedtime extension" and says it covers all apps. `time:grant` reads `scope` from the stored request and puts it on the `override:` record, the `time:extend` payload and the `replayActiveGrants` re-send.
3. **Child grant.** `handleTimeExtend` passes `scope` through `native:grantOverride`.
   - Android: a `scope: 'device'` grant goes to a new `UsageStatsModule.grantScheduleOverride(expiresAt)`, which stores `pearguard_schedule_override_until`. `getBlockReason` skips `getScheduleBlockReason` while it is in the future. The key does not use the `pearguard_override_` prefix, so the clear-all at `UsageStatsModule.java` ~1292 needs a matching line.
   - Desktop: the overrides store keeps one device-wide expiry next to the per-app map, and `evaluate()` skips the schedule-rule check while it holds.
4. **Midnight.** The grant is an absolute `expiresAt` like any `time:extend`, so a 23:45 grant of 30 minutes runs to 00:15. It does not use the per-day rule that `screenTimeBonus` follows.

Unchanged: the `general_time` flow, per-app extra time for limits, PIN overrides and quick-lock.

## Compat

`scope` is optional and every hop ignores fields it does not know, so each mixed pair falls back to today's per-app behavior:

- **New child, old parent:** the parent sees an ordinary extra-time request for the app that hit bedtime. Approving it grants that one app, as today.
- **Old child, new parent:** an old child never sends `scope`, so nothing changes.
- **New parent, old child** receiving a replayed device grant: it applies a per-app override for `packageName`, as today.
- **Co-parents on different versions:** an old co-parent sees a normal extra-time request, and its approval grants that one app.

No migration. Old records without `scope` read as per-app.

## Verify

- Jest:
  - `scope` survives `time:request` to the stored request, the P2P payload, the parent's record, `alerts:list`, `time:grant`, `time:extend`, `replayActiveGrants` and `handleTimeExtend`
  - A missing `scope` behaves exactly as today
- `npm run verify`.
- `npm run test:harness` scenario: child requests with `scope: 'device'`, parent grants, child gets `native:grantOverride` with `scope: 'device'`. Also run with the child offline at approval, so the grant is delivered by replay.
- TCL as child:
  - A bedtime rule blocks two apps. One request is approved. Both open.
  - An app over its daily limit stays blocked during the extension.
  - The block comes back when the extension expires.
  - A per-app window block still offers per-app time only.
- Desktop child on the Debian VM: the same checks.

## Rollback

Revert the PR. A stored `scope` field is ignored by the old code, and the leftover `pearguard_schedule_override_until` pref is unread. Any device grant still pending replay arrives as a per-app grant.

## Open questions

None. Scope and duration were decided above.
