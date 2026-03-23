# PearGuard TODO

## UI / UX

### [ ] 1. Force profile name creation at setup
Before completing first-launch setup (parent or child mode), require the user to enter a display name. The name is used in `hello` messages so the other device shows the real name instead of "PearGuard Device".

- **Where**: `app/setup.tsx` — add a name input step before or during mode selection
- **Bare method**: `identity:setName`

### [ ] 2. Share profile names between devices (Children tab)
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

### [ ] 18. Bug: Swipe-up gesture causes overlay to briefly flash
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

### [ ] 24. Bug: Profile name changes don't sync to paired devices
After initial pairing, if the child or parent changes their display name in Profile, the other device still shows the old name.

- **Root cause**: `hello` messages (which carry `displayName`) are only sent at connection time. A name change after pairing never triggers a new `hello`.
- **Fix**: When `identity:setName` is called, also broadcast a `profile:update` P2P message to all connected peers with the new name. Peers update their `peers:{publicKey}` Hyperbee entry on receipt.

### [x] 25. New app install: notify parent and auto-block until approved — 2026-03-23
`handleIncomingAppInstalled` and `handleIncomingAppsSync` (incremental syncs only) now receive `sendToPeer` and push a `policy:update` back to the child after storing the new app as `pending`. The child's `handlePolicyUpdate` stores the policy and calls `native:setPolicy`, so the overlay fires immediately when the child tries to open the new app. First-sync apps remain suppressed (no notifications, no auto-block flood at initial pairing).

## Added 2026-03-21

### [x] 26. Remove uninstalled apps from parent's Apps list — 2026-03-23
Already fully implemented: `PackageMonitorModule` fires `onAppUninstalled` event → `index.tsx` forwards to worklet → `bare-dispatch.js` `app:uninstalled` removes from child policy and calls `sendToParent` with `app:uninstalled` P2P → parent's `handleIncomingAppUninstalled` deletes from `policy:{childPublicKey}.apps` and emits `app:uninstalled` event. `index.tsx` shows `showAppUninstalledNotification` on parent.

### [ ] 27. Alphabetize Apps list; add sort option
The Apps tab has no defined order, making it hard to find apps on a real device with many entries.

- **Default**: Sort alphabetically by `appName` (falling back to `packageName`)
- **Sort option**: Toggle between alphabetical and install/discovery date (order apps were added to policy)
- **Where**: `src/ui/components/AppsTab.jsx` — sort `Object.entries(policy.apps)` before rendering; add a sort control in the header

## Added 2026-03-22

### [ ] 31. Parent setup: require override PIN before first use
Before the parent device becomes operational, force the parent to set an override PIN. Without a PIN, the child can never request access to a blocked app, making enforcement useless.

- **Where**: `app/setup.tsx` — add a PIN-entry step after mode selection; do not proceed until a valid PIN is saved via `pin:set`
- **Related**: TODO #1 (force profile name at setup) — these could be combined into a single setup wizard step

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

### [ ] 30. Design decision: default policy for apps discovered at initial pairing
When a child pairs for the first time, all installed apps arrive via `apps:sync`. Currently they all default to `status: 'pending'`. Consider whether the right default is:

- **Approve all** (allow everything until parent actively blocks) — less friction, easier onboarding
- **Deny all** (block everything until parent reviews) — more secure, but child can't use their device until parent approves
- **Keep pending** (current) — overlay fires for every app the child tries to open until parent decides; worst UX
- **Where**: `handleIncomingAppsSync` and `handleIncomingAppInstalled` default status; may also want a prompt in the parent UI at first-pairing time

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

### [x] 40. Tapping "app installed" notification on parent should deep-link to Apps tab — 2026-03-23
Currently the notification routes to the Activity tab. The more actionable destination is the Apps tab for the relevant child, where the parent can immediately approve or deny the new app.

- **Where**: `android/.../UsageStatsModule.java` `showAppInstalledNotification` — build a `pear://pearguard/alerts?childPublicKey=X&tab=apps` PendingIntent (mirrors the existing alerts deep link pattern)
- `app/index.tsx` and `src/ui/components/ChildDetail.jsx` already support the `tab` param, so no UI changes needed

### [x] 38. Bug: Usage tab not populating any data — 2026-03-23
Two bugs: (1) `usage:flush` in `bare-dispatch.js` ignored `args.usage` (native data passed from `index.tsx` → `getDailyUsageAll()`) and always sent `usageStats: {}`; fixed to map native array into `report.apps`. (2) `usage:getLatest` didn't exist; added handler that reads latest `usageReport:{childPublicKey}:*` entry from Hyperbee via `createReadStream({ reverse: true, limit: 1 })`.
- **Where**: `android/.../UsageStatsModule.java`, `src/bare.js` (usage reporting timer), `src/ui/components/UsageTab.jsx`

### [ ] 39. Schedules and Time Limits need to work together properly
Time-limit enforcement and scheduled block windows should interoperate correctly — e.g. a scheduled block should override an active time-limit grant, and an approved time extension should not bypass a scheduled block window.

- **Investigate**: How `EnforcementService` and `AppBlockerModule` currently prioritize policy fields (`schedule`, `dailyLimitSeconds`, active overrides)
- **Design**: Define clear precedence rules: scheduled block > daily limit exhausted > active override > policy status
- **Where**: `android/.../AppBlockerModule.java`, `android/.../EnforcementService.java`, `src/bare-dispatch.js` policy shape

### [x] 42. Bug: Usage tab data disappears after leaving and returning to the app — 2026-03-23
Usage stats were visible, but after backgrounding the app and returning the Usage tab showed empty again. The `usageReport:{childPublicKey}:{timestamp}` entries may be getting lost across app restarts, or `usage:getLatest` is not finding them on re-mount.

- **Investigate**: Confirm `usageReport:*` keys are persisted in Hyperbee across app restarts (not just in-memory); check if the bare worklet re-initializes and clears state on foreground
- **Also check**: `UsageTab` calls `usage:getLatest` on mount — verify the query range `gt/lt` matches the actual stored keys

### [ ] 41. System apps must be exempt from policies and filtered from Usage report
System apps (Launcher, Google Play Services, Settings, Phone, SMS, etc.) should never be blocked by the overlay and should not appear in the Usage tab on the parent's dashboard.

- **Policy exemption**: In `AppBlockerModule.java` `getBlockReason`, skip enforcement for known system packages (those with `FLAG_SYSTEM` + `FLAG_UPDATED_SYSTEM_APP`, or a curated allowlist of critical services like `com.android.launcher`, `com.google.android.gms`)
- **Usage filter**: In `UsageStatsModule.java` `getDailyUsageAll`, exclude system apps before returning the list — same FLAG_SYSTEM check or launcher-intent filter (only include apps that appear in the launcher)
- **Apps list**: `handleIncomingAppsSync` in `bare-dispatch.js` already uses a launcher-intent filter for the initial sync; verify system apps are excluded there too

## Known Limitations

### Overlay not triggered for already-open apps
The Accessibility Service overlay fires on `TYPE_WINDOW_STATE_CHANGED`. If an app is already in the foreground when its policy changes to blocked, no event fires until the user navigates away and back. Possible mitigation: add a background polling loop in the service that periodically checks if the foreground app is now blocked.

---

## Completed

### [x] 6. Guided Accessibility Service setup on Child device — 2026-03-21
Mandatory two-step wizard (`app/child-setup.tsx`) guides child device users through enabling Accessibility Service and Usage Stats permission on first launch and whenever either is missing. Auto-advances via 1.5s polling. Re-triggers on app foreground if permissions are revoked.

### [x] 11. Time limits not honored — ensure Usage Stats permission is granted on child — 2026-03-21
Resolved as part of TODO #6. Step 2 of the child setup wizard guides the user through granting Usage Access permission before reaching the main screen.

### [x] 7. Remove "Pending Approval" badge from Apps list — 2026-03-21
The yellow "Pending Approval" badge on each row was redundant — the Approve/Deny buttons immediately below it already convey pending state.

### [x] 9. Use app display name instead of package name — 2026-03-21
Both the parent's Apps tab and child's My Requests list were showing raw package names (e.g. `com.android.chrome`). Now shows the human-readable app name as the primary label with the package name in smaller text below. `appName` is also stored in `req:*` records so My Requests shows it correctly for overlay-originated requests.
