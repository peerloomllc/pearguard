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

### [x] 54. Force pairing to parent as part of child onboarding — 2026-03-25
Currently, the child setup wizard only covers Accessibility Service and Usage Stats permissions. A child device is usable as "standalone" without being paired to a parent.

- After permissions are granted, require the child to scan the parent's QR invite before proceeding to the main screen
- If child is already paired (has at least one parent in `peers:`), skip this step
- **Where**: `app/child-setup.tsx` — add a step 3 for pairing if no parent is paired yet

### [ ] 53. Child "Home" tab is a placeholder
The Home tab on the child device currently just shows "All good" with no real content.

- **Consider**: Show current enforcement status (which apps are blocked right now), today's screen time summary, active schedule restrictions, and any pending requests
- **Where**: `src/ui/components/ChildHome.jsx` (or equivalent)

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

### [x] 13. PIN override: prompt for duration — 2026-03-24
After correct PIN, child now sees a "How long?" picker (15 min / 30 min / 1 hour / 2 hours) before the override is granted.

---

## Added 2026-03-20

### [x] 14. What happens when child turns off Accessibility Service? — 2026-03-24
Detection and UX hardened. `EnforcementService` detects the accessibility→disabled transition and now also persists `bypass_detected_reason`/`bypass_detected_at` to SharedPreferences so the event survives a suspended RN JS thread. On next launch, `index.tsx` reads these and relays `bypass:detected` to the worklet (which queues `bypass:alert` to the parent), then clears them. The `child-setup` screen shows a "Your parent has been notified" red banner when navigated to via `source=bypass_recovery`. Re-enabling does not require a PIN (would block enforcement recovery).

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

### [x] 23. Bug: PearGuard force-close stops enforcement — 2026-03-24
Prevention is not possible with Device Admin alone (requires Device Owner). Two detection layers added:

**Child-side (restart detection)**: `EnforcementService` writes `enforcement_heartbeat_ms` to SharedPreferences every 5 s. On next app launch, `index.tsx` reads this via `checkChildPermissions()`. If accessibility is off and the heartbeat is <5 min old, a `bypass:detected` with reason `force_stopped` is sent to the parent — queued and delivered on reconnect.

**Parent-side (staleness detection)**: `heartbeat:received` events now include `childDisplayName` (looked up from Hyperbee). `index.tsx` calls `updateChildHeartbeat` to save the timestamp per child in SharedPreferences. `ParentConnectionService` checks every 60 s for any child whose last heartbeat is >3 min old and fires an "enforcement may be off" notification.

Also added `force_stopped` and `device_admin_disabled` to the `reasonLabels` map in `bare.js`.

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

## Added 2026-03-25

### [x] 60. Bug: Parent PIN not carried over to child after Remove + re-pair — 2026-03-25
Root cause: `unpair` deletes `policy:{childPublicKey}`, so `handleIncomingAppsSync` recreates it from scratch as `{ apps: {}, childPublicKey, version: 0 }` — no `pinHash`. Fixed in both `handleIncomingAppsSync` and `handleIncomingAppInstalled`: if `policy.pinHash` is missing, fetch it from the parent's own `'policy'` key and inject it before storing/pushing the policy.

### [ ] 58. Block overlay should show reason for block
The overlay currently shows a generic title. Show a specific reason so the child understands why they're blocked.

- **Cases**: "Not approved by parent", "Daily time limit reached", "Scheduled blackout (rule label)"
- **Where**: `AppBlockerModule.java` `showOverlay()` — the `reason` string is already passed in; verify the `reasonView` TextView is surfacing it clearly, or improve the message strings in `getBlockReason()`

### [ ] 59. New app install: auto-generate a request + notification opens Requests list
When a child installs a new app it goes to `pending` status. Currently the parent gets an "app installed" notification that opens the Apps tab. The parent should be able to action it from the Requests list instead.

- **Auto-generate request**: When a new app arrives as `pending` on the parent, create a `req:*` Hyperbee entry so it appears in the Requests tab alongside time requests
- **Notification deep link**: Change `showAppInstalledNotification` to link to `pear://pearguard/alerts?childPublicKey=X&tab=requests` instead of `tab=apps`
- **Where**: `src/bare-dispatch.js` `handleIncomingAppInstalled`, `android/.../UsageStatsModule.java` `showAppInstalledNotification`

### [ ] 61. Track and display active overrides in UI
When a PIN or parent-approved override is active for an app, show it somewhere visible so the parent and child both know a time extension is in effect and when it expires.

- **Child side**: Show active overrides on the Home tab (once #53 is built) or in My Requests — e.g. "YouTube: override active, expires in 23 min"
- **Parent side**: Show in ChildDetail (Activity or Requests tab) — e.g. a badge or row showing the child has an active override for a specific app
- **Where**: Requires surfacing override expiry via a bare method (e.g. `overrides:list`) so the UI can read it

### [ ] 62. "Send Request" overlay should prompt for a requested duration
Currently "Send Request" sends a generic access request with no duration. The PIN override picker already shows 15 min / 30 min / 1 hr / 2 hr options — the request flow should too, so the parent knows exactly how long the child wants.

- **Child overlay** (`AppBlockerModule.java` `onSendRequest`): Show the same duration picker before sending the `onTimeRequest` event; include the selected `requestedSeconds` in the payload
- **Bare / P2P** (`src/bare-dispatch.js` `time:request`): Pass `requestedSeconds` through the P2P message
- **Parent Requests tab** (`src/ui/components/ChildDetail.jsx` Requests tab): Display the requested duration alongside the app name
- **Parent approval** (`bare-dispatch.js` `request:approve`): Use the child's requested duration as the default override duration (parent can still change it)

## Added 2026-03-22

### [x] 31. Parent setup: require override PIN before first use — 2026-03-23
Two gates added. Gate 1 (`app/setup.tsx`): after tapping "I'm a Parent", a PIN setup step is shown inline before navigating to the dashboard. Gate 2 (`src/ui/components/ParentApp.jsx`): on mount, checks `pin:isSet`; if false, renders a full-screen PIN overlay until a valid PIN is saved. New `pin:isSet` bare dispatch method reads parent's own `'policy'` key. All PIN inputs restricted to exactly 4 digits with auto-focus from entry to confirm field on 4th digit. Same 4-digit restriction and auto-focus applied to `Settings.jsx`.

### [x] 55. After unpairing child device, can't pair back to same parent — 2026-03-25
When a parent removes a child via the "Remove" button, the parent writes a `blocked:{childPublicKey}` entry to prevent reconnects. The child's state is wiped and it returns to setup. But if the user tries to re-pair the same child to the same parent, the `blocked:` entry causes the parent to reject the child's `hello` with an `unpair` message, making re-pairing impossible without clearing the parent's data.

- **Fix**: Clear the `blocked:{childPublicKey}` entry when a new invite is generated or when the child completes the invite acceptance flow
- **Alternative**: Add a UI option on the parent to "re-allow" a previously removed child

### [x] 28. Prevent child from clearing app storage to deactivate PearGuard — 2026-03-24
**Investigation result**: Preventing Clear Data is not possible as a Device Admin — it requires Device Owner (enterprise MDM) privileges, which are not available to consumer apps. This is an Android OS-level user right.

**Detection result**: No standard Android storage survives Clear Data for non-system apps (SharedPreferences, files, and even ciphertext encrypted with Keystore-backed keys are all in the app's data directory). There is no reliable way to detect the wipe from the child side before it happens or on first subsequent launch.

**Mitigation**: The existing parent heartbeat staleness detection (from #23/#37) already covers this — when the child clears data, heartbeats stop and `ParentConnectionService` fires the "enforcement may be off" notification after 3 min. Updated the notification text in both `ParentConnectionService` and `UsageStatsModule` to say "force-closed **or app data cleared**" so the parent has the correct context. Child must re-pair after a data clear.

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

### [x] 37. Bug: P2P messages (app installs, time requests) not delivered to parent while app is backgrounded — 2026-03-24
Added `ParentConnectionService` — a foreground service on the parent device that keeps the React Native (and Bare worklet) process alive while backgrounded. The service emits `onParentReconnectNeeded` every 30 s → `index.tsx` calls `swarm:reconnect` on the worklet → Hyperswarm re-establishes any dropped connections. Started automatically from `index.tsx` `ready` handler when `mode === 'parent'`.

### [x] 52. Maximize background delivery reliability for Requests and Alerts — 2026-03-24
All child→parent message types (time request, app install, app uninstall, apps sync, bypass alert, usage report, heartbeat) go through `sendToParent()` which always queues to Hyperbee first, then attempts immediate delivery. On reconnect, `handleHello` calls `flushPendingMessages` to drain the queue. Parent side now keeps Hyperswarm alive via `ParentConnectionService` (see #37).

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

### [x] 51. Bug: Correct PIN not working on child device — 2026-03-24
`verifyPin()` in `AppBlockerModule.java` was calling LazySodium's `cryptoPwHashStrVerify` (argon2id) while `bare-dispatch.js` `pin:set` had been switched to BLAKE2b hex in commit 129e929. Fixed by calling `crypto_generichash` via the native `SodiumAndroid` layer and comparing the resulting bytes directly.

### [ ] 56. Bug: Unpair from parent doesn't clear active restrictions on child
When the parent removes a child while enforcement is active (e.g. a blocked app's overlay is showing), the child's DB is wiped by `unpair` but the native enforcement layer (AppBlockerModule) still has the old policy cached in SharedPreferences. The overlay stays visible and cannot be dismissed — tapping anywhere only triggers "Send Request" or PIN entry.

- **Root cause**: `child:reset` navigates to `/setup` but never calls `native:setPolicy` with an empty/null policy to clear SharedPreferences
- **Fix**: In `index.tsx`, handle `child:reset` by calling `NativeModules.UsageStatsModule?.setPolicy('')` (or a clear-policy method) before navigating to `/setup`, so AppBlockerModule stops blocking
- **Also**: Call `dismissOverlayForPackage` for all packages, or add a `clearAllPolicies` native method

### [ ] 57. Bug: Overlay persists over Home screen after dismissing blocked app
After a blocked app's overlay is shown and the user navigates away (e.g. swipe to Home), the overlay sometimes stays visible over the Home screen. The only way to dismiss it is to tap "Send Request" or enter the PIN.

- **Investigate**: Whether the `TYPE_WINDOW_STATE_CHANGED` event for the Home screen launcher is being filtered out (system package exemption added in #41 may be too broad)
- **Also investigate**: Whether this is triggered by the same stale-policy condition as #56 (policy says app is blocked, overlay fires on any focus event even on Home)
- **Likely related to #56** when tested while unpairing, but may be reproducible independently

## Known Limitations

### Overlay not triggered for already-open apps
The Accessibility Service overlay fires on `TYPE_WINDOW_STATE_CHANGED`. If an app is already in the foreground when its policy changes to blocked, no event fires until the user navigates away and back. Possible mitigation: add a background polling loop in the service that periodically checks if the foreground app is now blocked.

---

## Completed

### [x] 32. Parent-initiated unpair / remote deactivation of child — 2026-03-25
Parent "Remove" button in ChildDetail sends `child:unpair` to the bare worklet. Parent side: writes `blocked:{childPublicKey}` first (prevents reconnect race), deletes peer/policy/alert/usageReport records, sends signed `unpair` P2P message, emits `child:unpaired` event to UI (removes child from list). Child side: on receiving `unpair`, collects all DB keys then deletes them all, emits `child:reset` → RN navigates to `/setup`. Offline case handled: if child was offline at unpair time, `handleHello` on parent now sends the signed `unpair` before returning when a blocked peer reconnects, so the child receives it on next connection.

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
