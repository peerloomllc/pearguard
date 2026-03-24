# PearGuard TODO

## UI / UX

### [x] 1. Force profile name creation at setup — 2026-03-24
Before completing first-launch setup (parent or child mode), require the user to enter a display name. The name is used in `hello` messages so the other device shows the real name instead of "PearGuard Device".

- **Where**: `app/setup.tsx` — add a name input step before or during mode selection
- **Bare method**: `identity:setName`

### [x] 2. Share profile names between devices (Children tab) — 2026-03-24
The Children tab currently shows the name the child declared in its `hello` message. Since we now include the real profile name in `hello`, this will update on reconnect. But the parent's own name shown on the child's Profile screen also uses `hello` reply, which now includes profile name too.

- Verify Children tab shows child's real name after reconnect (should work with the `hello` fix)
- On child Profile screen, show parent's real name in the Parents list

### [ ] 3. Avatar customization
Add avatar/photo support on the Profile page and during forced profile setup.

- **Options**: in-app camera (via `expo-camera`) and photo/gallery picker (via `expo-image-picker`)
- **Where**: `src/ui/components/Profile.jsx` — replace the initials circle with photo when set
- **Storage**: encode avatar as base64 in Hyperbee `profile` record; include thumbnail in `hello` payload

### [x] 4. Parent UI: show pairing confirmation + refresh Children list — 2026-03-22
When a child device pairs with the parent, the parent's Children tab should immediately refresh its list and display a "Successfully paired" confirmation message.

- **Where**: `src/ui/components/ChildrenList.jsx` — already listens for `child:connected`; needs a success banner rendered briefly after the event fires
- **Bare event**: `child:connected`

### [x] 5. Child UI: show pairing confirmation + refresh Profile — 2026-03-22
After the child completes pairing (`acceptInvite` resolves), the Profile screen should immediately reflect the new parent connection (refresh the parents list) and display a "Successfully paired" confirmation.

- **Where**: `src/ui/components/Profile.jsx` — `pairState === 'success'` already shows a message; ensure the parents list also reloads at that point
- **Bare event**: `peer:paired` already triggers a refresh — verify it fires reliably after `acceptInvite` completes

### [ ] 8. Display app icons in Apps list
Show the app's launcher icon next to its name in the parent's Apps tab.

- **Where**: `src/ui/components/AppsTab.jsx` — when child sends `app:installed`, include a base64 icon in the payload; display in `AppRow`
- **How**: `getInstalledPackages` in Java can fetch `pm.getApplicationIcon(ai)` and encode as base64

### [x] 10. "Child Requests" management page on parent — 2026-03-22
When a child sends a time request, the parent currently has no dedicated UI to view and approve/deny pending requests. Add a requests tab or section to the parent's ChildDetail screen.

- **Where**: `src/ui/components/ChildDetail.jsx` — add a "Requests" tab alongside Apps/Schedule/Usage
- **Data**: read from `request:{requestId}` keys in Hyperbee; listen for `time:request:received` event to refresh
- **Actions**: Approve (grant timed override) / Deny buttons per request

### [ ] 12. Persistent parent identity key (invite URL never changes)

The parent's invite URL is derived from the Hyperswarm keypair stored in the Hypercore data directory. Since the Hypercore data directory is in `documentDirectory` (not `cacheDirectory`), it survives app data clears if the OS only clears cache. This means the same invite URL is reused across setups. Decision needed:

- **Keep as-is**: Simpler for reconnecting existing children — same key means no re-pairing.
- **Force fresh keypair**: On first-launch setup, always generate a new keypair and clear old peer records.

### [ ] 13. PIN override: prompt for duration

When a PIN override is granted, the duration is fixed at `policy.overrideDurationSeconds` (default 3600s = 1 hour). The child (and parent) should be able to choose a duration at the moment of granting.

- **Where** (child overlay): After 4-digit PIN is verified, show a duration picker (e.g., "15 min / 30 min / 1 hour / Custom") before dismissing
- **Where** (parent side): Parent approving a time request should similarly choose duration
- **Edge case**: If parent updates policy while an override is active, the override should be respected until it expires

---

## Added 2026-03-20

### [ ] 14. What happens when child turns off Accessibility Service?
When the child disables the PearGuard Accessibility Service, enforcement silently stops. The bypass detection path (`onBypassDetected`) should already fire, but the UX around it needs verification and hardening.

- Verify `EnforcementService` detects and emits `bypass:detected` when Accessibility is disabled
- Confirm parent receives the bypass alert via P2P relay
- Consider whether re-enabling should require a PIN or parent approval
- Related: TODO #6 (guided setup) — the same deep-link flow could be reused here to guide the child back to enabling it

### [ ] 15. Apps list: categories, expandable/collapsible sections, search
The Apps tab will grow large on a real device. Make it manageable.

- Group apps into categories (e.g. Social, Games, Productivity, System) — either from Play Store metadata or a curated map of known package prefixes
- Expandable/collapsible sections per category; collapsed by default for cleaner first view
- Search/filter bar at top to find an app by name
- **Where**: `src/ui/components/AppsTab.jsx`

### [ ] 16. Approve All / Deny All per category
Once categories exist (TODO #15), add Approve All / Deny All buttons per category header row so the parent can quickly manage a whole group at once.

- **Where**: category header in `AppsTab.jsx`
- **Bare method**: batch variant of `app:decide` — send one policy:update containing all the decisions at once

### [ ] 17. Haptic feedback
Add haptic feedback on key interactions: overlay button taps, PIN digit entry, PIN success/fail, request submitted.

- **Overlay (Java)**: `android.os.Vibrator` / `VibrationEffect` — short pulse on button press, error pattern on wrong PIN, success pattern on correct PIN
- **WebView UI (JS)**: `navigator.vibrate()` for request submission confirmation

### [x] 18. Bug: Swipe-up gesture causes overlay to briefly flash — 2026-03-24
When the child uses the swipe-up-from-bottom gesture (Android navigation), the overlay briefly flashes before disappearing. The gesture likely causes a transient window state change that re-triggers `showOverlay`, then the gesture completes and the overlay is dismissed.

- **Investigate**: What package name does the TYPE_WINDOW_STATE_CHANGED event carry during a swipe-up gesture? Likely the launcher/gesture nav overlay.
- **Fix candidate**: Ignore events from known system gesture/nav packages, or add a short debounce (e.g. 150ms) before showing the overlay so rapid show→dismiss sequences are coalesced.

### [x] 19. Overlay: auto-dismiss when conditions are no longer met — 2026-03-23
Already implemented: `app/index.tsx` `native:setPolicy` handler parses the policy JSON and calls `NativeModules.UsageStatsModule.dismissOverlayForPackage(pkg)` for every app with `status: 'allowed'`. `native:grantOverride` also calls `dismissOverlayForPackage` directly.

### [ ] 20. Failsafe: unpair / deactivate all restrictions at once
A safety valve for when the parent-child relationship needs to be reset or in an emergency.

- **Child device**: A hidden sequence (e.g., tap version number 7 times in Settings) or a timed button that calls `disableEnforcement` and optionally clears the paired parent record.
- **Parent device**: Option in ChildDetail to "Remove child" that sends an `unpair` P2P message before clearing local peer record.
- **Edge case**: Child with no internet / offline — the child-side failsafe must work without a P2P connection.

### [x] 21. Clear old / stale Requests — 2026-03-22
Requests accumulate in Hyperbee indefinitely. Add a way to archive or delete them.

- **Auto-expire**: Requests older than N days (e.g. 7) could be auto-deleted on startup or during `usage:flush`.
- **Manual clear**: "Clear all resolved requests" button in child's My Requests tab.
- **Where**: `src/ui/components/ChildRequests.jsx` + `bare-dispatch.js` `requests:list` / new `requests:clear` method

### [x] 22. Bug: Requests showing Pending even after approval — 2026-03-23
Root cause: `handlePolicyUpdate` (child side) updated the policy but did not sync pending `req:*` entries. When the parent was offline during child's approval or reconnect pushed a `policy:update`, pending requests stayed Pending. Fix: `handlePolicyUpdate` now scans `req:*` entries and updates any pending ones where the app is now `allowed`/`blocked`, emitting `request:updated` so `ChildRequests` refreshes.

### [ ] 23. Bug: PearGuard force-close stops enforcement
If the child force-closes PearGuard, the Accessibility Service (which is hosted in the same process) also stops. Enforcement silently ceases.

- **Investigate**: Can the Accessibility Service be declared in a separate process (`android:process`) so it survives PearGuard's main process being killed?
- **Detect**: `EnforcementService` should detect when PearGuard's main process is not running and alert the parent.
- **Mitigation**: Device admin (`DevicePolicyManager`) can prevent force-close of designated apps on some Android versions.

### [x] 24. Bug: Profile name changes don't sync to paired devices — 2026-03-24
After initial pairing, if the child or parent changes their display name in Profile, the other device still shows the old name.

- **Root cause**: `hello` messages (which carry `displayName`) are only sent at connection time. A name change after pairing never triggers a new `hello`.
- **Fix**: When `identity:setName` is called, also broadcast a `profile:update` P2P message to all connected peers with the new name. Peers update their `peers:{publicKey}` Hyperbee entry on receipt.

### [x] 25. New app install: notify parent and auto-block until approved — 2026-03-23
`handleIncomingAppInstalled` and `handleIncomingAppsSync` (incremental syncs only) now receive `sendToPeer` and push a `policy:update` back to the child after storing the new app as `pending`. The child's `handlePolicyUpdate` stores the policy and calls `native:setPolicy`, so the overlay fires immediately when the child tries to open the new app. First-sync apps remain suppressed (no notifications, no auto-block flood at initial pairing).

## Added 2026-03-21

### [x] 26. Remove uninstalled apps from parent's Apps list — 2026-03-23
Already fully implemented: `PackageMonitorModule` fires `onAppUninstalled` event → `index.tsx` forwards to worklet → `bare-dispatch.js` `app:uninstalled` removes from child policy and calls `sendToParent` with `app:uninstalled` P2P → parent's `handleIncomingAppUninstalled` deletes from `policy:{childPublicKey}.apps` and emits `app:uninstalled` event. `index.tsx` shows `showAppUninstalledNotification` on parent.

### [x] 27. Alphabetize Apps list; add sort option — 2026-03-24
The Apps tab has no defined order, making it hard to find apps on a real device with many entries.

- **Default**: Sort alphabetically by `appName` (falling back to `packageName`)
- **Sort option**: Toggle between alphabetical and install/discovery date (order apps were added to policy)
- **Where**: `src/ui/components/AppsTab.jsx` — sort `Object.entries(policy.apps)` before rendering; add a sort control in the header

## Added 2026-03-22

### [x] 31. Parent setup: require override PIN before first use — 2026-03-23
Two gates added. Gate 1 (`app/setup.tsx`): after tapping "I'm a Parent", a PIN setup step is shown inline before navigating to the dashboard. Gate 2 (`src/ui/components/ParentApp.jsx`): on mount, checks `pin:isSet`; if false, renders a full-screen PIN overlay until a valid PIN is saved. New `pin:isSet` bare dispatch method reads parent's own `'policy'` key. All PIN inputs restricted to exactly 4 digits with auto-focus from entry to confirm field on 4th digit. Same 4-digit restriction and auto-focus applied to `Settings.jsx`.

### [ ] 32. Parent-initiated unpair / remote deactivation of child
The parent should be able to sever the pairing from their side, which should remotely deactivate PearGuard enforcement on the child device.

- **Parent side**: "Remove child" option in ChildDetail → sends an `unpair` P2P message to the child, then deletes `peers:{childPublicKey}` and `policy:{childPublicKey}` locally
- **Child side**: On receiving `unpair`, delete `peers:*`, `policy`, and `mode` from Hyperbee; navigate to setup screen
- **Offline case**: If child is offline, queue the `unpair` message; deliver on next reconnect
- **Related**: TODO #20 (failsafe unpair from child side)

### [ ] 28. Prevent child from clearing app storage to deactivate PearGuard
Clearing PearGuard's storage via Android Settings (Apps → PearGuard → Clear Storage) wipes all Hyperbee data — keypair, pairing records, policy — effectively unpairing the device without parent knowledge.

- **Investigate**: Does `DevicePolicyManager` allow restricting "Clear Data" for a specific app when PearGuard is a Device Admin?
- **Detect**: On next launch after a wipe, the child setup wizard would re-run (no `mode` key in DB). This could be used as a signal to notify the parent if they're still reachable.
- **Related**: TODO #20 (failsafe unpair), TODO #23 (force-close stops enforcement)

### [x] 29. Bug: Initial pairing should not send "app installed" notifications to parent — 2026-03-22
`handleIncomingAppsSync` now checks `raw` (the existing policy record) before processing: if null it's the first sync, so alert entries and `app:installed` events are suppressed. `apps:synced` still fires so the Apps tab refreshes. Incremental syncs (reconnects after initial pairing) continue to notify for genuinely new installs.

### [x] 30. Default policy for apps discovered at initial pairing — 2026-03-23
`handleIncomingAppsSync`: when `isFirstSync` is true, apps now default to `status: 'allowed'` instead of `'pending'`. `sendToPeer` (policy push to child) moved outside the `!isFirstSync` guard so it fires unconditionally on every sync, ensuring the child receives the allowed policy immediately at first pairing. Post-pairing installs still default to `pending`.

### [x] 33. Bug: Selected tab highlight remains after navigating away from ChildDetail — 2026-03-22
Root cause: `tabInactive` style had no `borderBottom` key, so React never removed the active `borderBottom` when a tab switched from active to inactive within a render cycle. Fixed by adding `borderBottom: '2px solid transparent'` to `tabInactive` so React explicitly clears the highlight. `initialTab` reset in Dashboard `onBack` was already correct.

### [x] 34. Bug: Tapping a time-request notification on parent routes to Activity tab instead of Requests tab — 2026-03-22
`showTimeRequestNotification` now uses `buildRequestsPendingIntent` which appends `&tab=requests` to the deep link URL. `index.tsx` parses the `tab` param and passes it in the `navigate:child:alerts` event payload. `Dashboard.jsx` reads `tab` (defaulting to `'alerts'`) and sets `initialTab` accordingly.

### [x] 36. Bug: "Successfully paired" banner fires on every reconnect, not just first pairing — 2026-03-22
`bare.js` `handleHello` now checks `existingRecord`: if null → first-time pairing → emits `child:connected`; otherwise → reconnect → emits `child:reconnected`. `ParentApp.jsx` only listens for `child:connected`, so the banner only fires on first pairing. `ChildrenList.jsx` also subscribes to `child:reconnected` to refresh the list (lastSeen, displayName) on reconnect.

### [x] 35. Child: tapping "Request Approved" notification should open the approved app or navigate to Requests tab — 2026-03-22
`showDecisionNotification` now builds a `pear://pearguard/child-requests` deep link PendingIntent. `index.tsx` parses this URL and sets `_pendingChildRequestsNav = true`; the `dbReady` useEffect fires `navigate:child:requests` into the WebView. `ChildApp.jsx` listens for that event and calls `setActiveTab('requests')`.

### [ ] 37. Bug: P2P messages (app installs, time requests) not delivered to parent while app is backgrounded
When the child sends a message while the parent app is backgrounded, Android drops the Hyperswarm TCP connection. The message is queued on the child and delivered the next time the parent foregrounds (triggering `swarm:reconnect` → new connection → `handleHello` → `flushPendingMessages`). The parent receives no push notification until it opens the app.

- **Root cause**: Hyperswarm requires an active foreground TCP connection; there is no background push path
- **Option A**: Android foreground service on the parent — keeps Hyperswarm alive even when backgrounded, delivering messages in real time
- **Option B**: FCM push as a fallback wakeup — child sends an FCM ping to the parent when it has a queued message; parent wakes Hyperswarm to flush
- **Where**: `app/index.tsx`, new foreground service, or FCM integration

### [ ] 52. Maximize background delivery reliability for Requests and Alerts
Requests and alerts (time requests, app installs, bypass alerts) must reach the parent as consistently as possible even when the app is backgrounded. Related to #37 but broader in scope — covers both parent and child sides and all alert types.

- **Audit**: Confirm all alert types (time request, app install, bypass alert) are queued and flushed on reconnect
- **Parent-side**: Keep Hyperswarm alive in background via a foreground service (preferred) or FCM wakeup
- **Child-side**: Ensure queued messages are flushed immediately on reconnect, not just on `handleHello`
- **Goal**: Parent should receive an Android notification within seconds of a child event, even if the app was not open

### [x] 40. Tapping "app installed" notification on parent should deep-link to Apps tab — 2026-03-23
Currently the notification routes to the Activity tab. The more actionable destination is the Apps tab for the relevant child, where the parent can immediately approve or deny the new app.

- **Where**: `android/.../UsageStatsModule.java` `showAppInstalledNotification` — build a `pear://pearguard/alerts?childPublicKey=X&tab=apps` PendingIntent (mirrors the existing alerts deep link pattern)
- `app/index.tsx` and `src/ui/components/ChildDetail.jsx` already support the `tab` param, so no UI changes needed

### [x] 38. Bug: Usage tab not populating any data — 2026-03-24
Two bugs: (1) `usage:flush` in `bare-dispatch.js` ignored `args.usage` (native data passed from `index.tsx` → `getDailyUsageAll()`) and always sent `usageStats: {}`; fixed to map native array into `report.apps`. (2) `usage:getLatest` didn't exist; added handler that reads latest `usageReport:{childPublicKey}:*` entry from Hyperbee via `createReadStream({ reverse: true, limit: 1 })`.
- **Where**: `android/.../UsageStatsModule.java`, `src/bare.js` (usage reporting timer), `src/ui/components/UsageTab.jsx`

### [ ] 39. Schedules and Time Limits need to work together properly
Time-limit enforcement and scheduled block windows should interoperate correctly — e.g. a scheduled block should override an active time-limit grant, and an approved time extension should not bypass a scheduled block window.

- **Investigate**: How `EnforcementService` and `AppBlockerModule` currently prioritize policy fields (`schedule`, `dailyLimitSeconds`, active overrides)
- **Design**: Define clear precedence rules: scheduled block > daily limit exhausted > active override > policy status
- **Where**: `android/.../AppBlockerModule.java`, `android/.../EnforcementService.java`, `src/bare-dispatch.js` policy shape

### [x] 42. Bug: Usage tab data disappears after leaving and returning to the app — 2026-03-24
Usage stats were visible, but after backgrounding the app and returning the Usage tab showed empty again. The `usageReport:{childPublicKey}:{timestamp}` entries may be getting lost across app restarts, or `usage:getLatest` is not finding them on re-mount.

- **Investigate**: Confirm `usageReport:*` keys are persisted in Hyperbee across app restarts (not just in-memory); check if the bare worklet re-initializes and clears state on foreground
- **Also check**: `UsageTab` calls `usage:getLatest` on mount — verify the query range `gt/lt` matches the actual stored keys

### [x] 47. Sync reliability: Hypercore lock retry + swarm.flush on disconnect — 2026-03-24
Applied lessons from PearCal sync post-mortem. `init()` now retries up to 20× with 1s delay when Hypercore throws a lock error (Bare may restart before the previous instance releases the lock file). `conn.on('close')` now calls `swarm.flush()` so Hyperswarm expedites peer reconnection after a drop rather than waiting for its default retry schedule.

### [x] 41. System apps must be exempt from policies and filtered from Usage report — 2026-03-23
`AppBlockerModule.java` `getBlockReason` now calls `isSystemOverlayPackage` at the top to exempt system services with no launcher icon. `UsageStatsModule.java` `getDailyUsageAll` now builds a launcher-package set and skips any app not in it.

### [x] 43. UX: Schedule rule form should show validation error when Label is empty — 2026-03-24
Currently the form silently refuses to save without a label — there is no feedback to the user.

- **Where**: `src/ui/components/ScheduleTab.jsx` — show an inline error message (e.g. "Label is required") when the user tries to save without filling in the label field

### [ ] 44. Child: warn at 10 and 5 minutes before a schedule restriction starts
Give the child advance notice before a schedule block kicks in so they can save their work.

- **Where**: `android/.../EnforcementService.java` or `AppBlockerModule.java` — poll upcoming schedule windows; when 10 min or 5 min remain before a block starts, show a heads-up notification or non-blocking overlay on the child device

### [ ] 48. Investigate slow app startup (5+ seconds)
App takes over 5 seconds to load on device. Identify the bottleneck and reduce startup time.

### [ ] 49. Grant specific apps permission to bypass schedule rules
Some apps (e.g. phone, messaging) should be usable even during a schedule blackout window.

- **Where**: `src/ui/components/ScheduleTab.jsx` or per-rule form — add an "Exempt apps" picker per rule
- **Enforcement**: `EnforcementService` / `AppBlockerModule` should skip the schedule check for exempt packages

### [ ] 50. Clarify schedule rule UI text — rules are blackout windows, not permitted times
The current label/description language is ambiguous. Make it clear that a schedule rule defines when apps are **blocked** (a blackout/lockdown window), not when they are allowed.

- **Where**: `src/ui/components/ScheduleTab.jsx` — update section heading, form labels, and placeholder text

### [ ] 51. Bug: Correct PIN not working on child device
Child enters the correct PIN on the block overlay but it is not accepted.

- **Investigate**: Whether the child device is receiving the policy (including `pinHash`) from the parent via P2P sync; log `loadPolicy()` output in `verifyPin` to confirm `pinHash` is present
- **Related**: TODO #1 (PIN stored using BLAKE2b) — confirm the hash stored in policy matches what `verifyPin` expects

## Known Limitations

### Overlay not triggered for already-open apps
The Accessibility Service overlay fires on `TYPE_WINDOW_STATE_CHANGED`. If an app is already in the foreground when its policy changes to blocked, no event fires until the user navigates away and back. Possible mitigation: add a background polling loop in the service that periodically checks if the foreground app is now blocked.

---

## Completed

### [x] 46. Bug: "Requesting app access" notification shows package name instead of app name — 2026-03-24
Child now includes `appName` in the `time:request` P2P payload. Parent uses it directly, falling back to policy cache then `packageName`.

### [x] 45. Parent: ability to edit existing schedule rules — 2026-03-24
Each rule row now has an Edit button. Clicking it loads the rule into the form (heading changes to "Edit Rule", button changes to "Save Changes"). Saving replaces the rule in place. Cancel restores the Add Rule form.

### [x] 2. Share profile names between devices (Children tab) — 2026-03-24
Children tab shows child's real name via `hello` message on reconnect. Child's Profile screen shows parent's real name in the Parents list.

### [x] 18. Bug: Swipe-up gesture causes overlay to briefly flash — 2026-03-24

### [x] 24. Bug: Profile name changes don't sync to paired devices — 2026-03-24
`identity:setName` now broadcasts a `profile:update` P2P message to all connected peers; peers update their `peers:{publicKey}` Hyperbee entry on receipt.

### [x] 27. Alphabetize Apps list; add sort option — 2026-03-24
Apps tab now sorts alphabetically by `appName` by default with a toggle for install/discovery order.

### [x] 43. UX: Schedule rule form should show validation error when Label is empty — 2026-03-24
Inline "Label is required" error shown in `ScheduleTab.jsx` when user attempts to save without a label.

### [x] 1. Force profile name creation at setup — 2026-03-24
Added name-entry step to `app/setup.tsx` between mode selection and PIN setup. Also fixed `pin:set`/`pin:verify` to use BLAKE2b (`crypto_generichash`) instead of argon2id which silently failed in the Android Bare worklet, causing the PIN overlay to reappear on every launch.

### [x] 6. Guided Accessibility Service setup on Child device — 2026-03-21
Mandatory two-step wizard (`app/child-setup.tsx`) guides child device users through enabling Accessibility Service and Usage Stats permission on first launch and whenever either is missing. Auto-advances via 1.5s polling. Re-triggers on app foreground if permissions are revoked.

### [x] 11. Time limits not honored — ensure Usage Stats permission is granted on child — 2026-03-21
Resolved as part of TODO #6. Step 2 of the child setup wizard guides the user through granting Usage Access permission before reaching the main screen.

### [x] 7. Remove "Pending Approval" badge from Apps list — 2026-03-21
The yellow "Pending Approval" badge on each row was redundant — the Approve/Deny buttons immediately below it already convey pending state.

### [x] 38. Bug: Usage tab not reliably populating data — 2026-03-24
Four root causes fixed: (1) bare.js `setInterval` fired `usage:flush` with no native data every 5 minutes, sending empty `apps:[]` reports to the parent that overwrote valid data via `onBareEvent` — removed (EnforcementService owns this timer). (2) `EnforcementService` silently dropped the flush when the RN bridge was inactive (app backgrounded); now resets `lastUsageFlushTime = 0` to retry on next loop. (3) Added `usageFlushRequested` event on child reconnect so data arrives within seconds of pairing. (4) `usageReport:` keys were stored with `msg.from` (Hyperswarm noise key) but queried with `child.publicKey` (Ed25519 identity key) — now uses `msg.payload.childPublicKey` so both sides agree. Also added `lastSynced` to reports (fixing "Last synced: Never"), empty-report guard in `usage:flush`, and `ChildDetail` now keeps all tabs mounted (`display:none` when inactive) so UsageTab state survives tab navigation.

### [x] 42. Bug: Usage tab data disappears after navigating to another tab and back — 2026-03-24
`ChildDetail` rendered only the active tab component, so `UsageTab` unmounted on tab switch and remounted fresh. On remount, `usage:getLatest` returned null (key mismatch between stored noise key and queried identity key — see #38 fix). Fixed both the key consistency bug and the unmount issue: `ChildDetail` now renders all tab components simultaneously and uses `display:none` to hide inactive ones, preserving loaded state across tab navigation.

### [x] 9. Use app display name instead of package name — 2026-03-21
Both the parent's Apps tab and child's My Requests list were showing raw package names (e.g. `com.android.chrome`). Now shows the human-readable app name as the primary label with the package name in smaller text below. `appName` is also stored in `req:*` records so My Requests shows it correctly for overlay-originated requests.
