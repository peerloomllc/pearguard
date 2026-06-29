# Cumulative daily screen-time limit

**Goal** - Add a device-wide cumulative daily screen-time cap that locks the child device once total usage crosses a parent-set threshold (issue #175).

**Tier** - T2. Adds a new optional persisted policy field (`dailyScreenTimeLimitSeconds`) that flows parent -> child over the existing `policy:update` path.

## Scope

What changes:

- **Policy schema**: new optional top-level field `policy.dailyScreenTimeLimitSeconds` (number, seconds; absent or `<= 0` = disabled).
- **Shared reference** (`src/policy.js`): new pure `hasExceededScreenTimeLimit(policy, usageStats)` plus a check in `isAppBlocked`. Tests in `src/policy.test.js`.
- **Android enforcement** (`AppBlockerModule.java`): a device-wide gate in `getBlockReason`, placed after the active-override check and before the schedule check, backed by a single-pass `getTotalDailyUsageSeconds()` that sums foreground time across all non-exempt packages. New block category `screen_time` (behaves like `daily_limit`: "Request More Time" path, per-package override bypass). Pre-limit warning in `EnforcementService.java` mirroring the existing per-app warning.
- **Desktop enforcement** (`desktop/src/enforcement/block-evaluator.js`): same device-wide gate, summing `getUsageSeconds` across `policy.apps`. Category `screen_time` flows through the existing "Request More Time" overlay path unchanged.
- **Parent UI** (`src/ui/components/RulesTab.jsx`): a "Daily Screen Time Limit" section to set/clear the cap.
- **Vendor sync**: `desktop/vendor/src/policy.js` kept identical to `src/policy.js`.

What does not change:

- No wire-protocol, pairing, invite, or key-management change.
- No new Hyperbee key (the field rides inside the existing `policy` value).
- iOS is parent-only; no child enforcement there.

## Compat

The field is optional and additive. Old child peers that have not upgraded simply ignore an unknown policy key and do not enforce the cap. Old parents never set it. All enforcement checks are gated on `typeof === 'number' && > 0`, so a policy without the field behaves exactly as today. No migration needed; no data rewrite.

Semantic note: the cap counts cumulative foreground time today. The override check runs first, so a parent-granted time extension for the foreground app bypasses the cap for that app (intended - lets the child request and receive more time). Standard exemptions (PearGuard itself, phone/messaging, system shells) never count toward the total and are never blocked, so the child can always reach the app to see the reason and request more time.

## Verify

- `node src/policy.test.js` green (new screen-time cases).
- On-device Android: set a low cap, accrue usage, confirm all non-exempt apps lock with the "Screen time limit reached" overlay, phone/PearGuard stay reachable, a granted time request reopens the foreground app, and the pre-limit warning fires.
- Desktop (Linux VM / Windows): same cap behavior via the headless/GUI path.

## Rollback

Revert the branch. Because the field is optional and ignored by old code, a parent who clears the cap (or a reverted build) returns to prior behavior with no residual state.

## Open questions

- Should phone/messaging time count toward the cap? Current choice: no (excluded, same as device-lock exemptions). Revisit if parents expect "total screen time including calls".
- Android sums all foreground sessions in a single pass; desktop sums reported per-app usage across `policy.apps`. Both approximate "device screen time today" but can differ slightly for apps the desktop tracker has not yet mapped.
