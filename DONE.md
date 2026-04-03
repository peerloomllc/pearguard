# PearGuard — Completed Items

Completed items with implementation notes. Open items are in `TODO.md`.

---

## Added 2026-04-03

### [x] Warn at 10/5/1 min before schedule or time-limit (#44) — 2026-04-03
Added warning notifications on the child device at 10, 5, and 1 minute before a schedule block starts or a daily time limit is reached. New `pearguard_upcoming_warning` notification channel (IMPORTANCE_HIGH) with heads-up display. Logic runs in EnforcementService's 5-second polling loop with in-memory dedup that resets daily.

---

## Added 2026-04-02

### [x] Remove Child Home status card (#89) — 2026-04-02
Removed the "All Good" / "Bedtime mode" / "Enforcement offline" status card from ChildHome. It always showed "All Good" on initial load regardless of actual state. Summary stats and active overrides remain.

### [x] Haptic feedback (#17) — 2026-04-02
Replaced WebView navigator.vibrate() with native Android Vibrator via UsageStatsModule.hapticTap(), routed through RN IPC. Adapts to hardware: amplitude-capable devices (Pixel) get 20ms at low amplitude; basic ERM motors (TCL) get 50ms at full amplitude. Added haptics to all button taps across parent and child UIs.

### [x] App categories with Approve All / Deny All (#16) — 2026-04-02
Native AppCategoryHelper detects category via ApplicationInfo.category + package-name heuristics. AppsTab supports By Category / By Status view toggle with batch Approve/Deny All per category. Child notifications only fire for pending requests, not proactive decisions.

### [x] Avatar customization (#3) — 2026-04-02
Presets and camera/gallery support in Profile.jsx and app/setup.tsx; base64 in Hyperbee profile, thumbnail in hello message.

### [x] Remove Children tab on Parent device (#86) — 2026-04-02
Removed redundant Children tab; moved "+ Add Child" button into Dashboard header. Deleted ChildrenList.jsx. Parent now has 3 tabs: Dashboard, Settings, Profile.

### [x] Remove package names from Requests detail (#80) — 2026-04-02
Removed monospace package name line from `RequestsTab.jsx`; app display name still shown as primary label.

### [x] Apps list collapsed by default (#81) — 2026-04-02
Changed `AppsTab.jsx` initial collapsed state to `true` for all three groups.

### [x] Usage list excludes PearGuard (#82) — 2026-04-02
Added `reactContext.getPackageName()` filter in `UsageStatsModule.java` `getDailyUsageAll`.

### [x] Child Home tab with status, counts, and overrides (#53) — 2026-04-02
Replaced placeholder with enforcement status card (good/bedtime/offline), summary row (blocked/pending/request counts), and active overrides section with countdown timers. New `child:homeData` bare method aggregates all data in one call. Auto-refreshes on events and every 30s.

### [x] Track and display active overrides in UI (#61) — 2026-04-02
New `overrides:list` bare method scans Hyperbee for non-expired `override:*` entries. PIN overrides now stored in Hyperbee via `pin:used` handler (previously only logged to pinLog). PIN usage relayed to parent as `pin:override` P2P message — creates alert ("PIN Override" label) and native notification. Parent Requests tab shows active overrides (both time grants and PIN overrides) with countdown. Active overrides on child shown only on Home tab.

### [x] Clarify schedule rule UI text (#50) — 2026-04-02
Schedule tab now explains rules are blackout windows with "Blocked from" / "Blocked until" labels. Added explainer text and updated empty state.

### [x] Grant specific apps permission to bypass schedule rules (#49) — 2026-04-02
Each schedule rule supports an `exemptApps` checkbox list in ScheduleTab.jsx. `AppBlockerModule.java` `getScheduleBlockReason()` checks per-rule `exemptApps` array — exempt apps skip that rule's blackout but remain subject to daily limits and policy status. Backward compatible with existing rules.

### [x] Some notifications show package name instead of app name (#71) — 2026-04-02
Root cause: child-side `app:uninstalled` handler in `bare-dispatch.js` deleted the app from the policy cache before grabbing its `appName`, so the P2P payload and local event only contained `packageName`. Fix: grab `appName` from policy before deleting, include it in both the local event emission and the P2P payload. Parent-side handler now prefers the child-sent label over its own cache.

---

## Added 2026-04-01

### [x] Notification tap doesn't navigate to child's tab (#69, #77) — 2026-04-01
Root cause: Deep link `pear://pearguard/alerts?...` triggered Expo Router, which navigated to `+not-found.tsx` (showing "Connecting..." for 1.5s), unmounting the WebView and losing navigation state. Fix: MainActivity now intercepts notification deep links in `onNewIntent` (warm start) and `onCreate` (cold start), stores the URL in SharedPreferences, and strips it from the intent so Expo Router never sees it. index.tsx reads the pending navigation via `consumePendingNavigation()` on AppState 'active' and during startup. Also lifted `navigate:child:alerts` listener to ParentApp (always mounted) so it works from any tab, and made ChildDetail respond to `initialTab` prop changes. Fixed false "enforcement may be off" notifications caused by clock skew — `updateChildHeartbeat` now uses parent's `Date.now()` instead of child's timestamp.


### [x] Force-stopped parent doesn't receive child notifications (#76) — 2026-04-01
Root cause: `sendToParentOrQueue` on the child wrote to the TCP socket just as the parent process was dying. The write appeared to succeed (OS buffered it), so the message was not queued in `pendingMessages`. When the parent restarted and reconnected, the child's queue flush sent nothing, and the parent's Hyperbee had no record to backfill.

Fix (soft): on child reconnect (`handleHello`, mode=child), after flushing `pendingMessages`, scan `req:*` in the child's own Hyperbee for entries still `status: 'pending'` within the last 24 h and re-send each as a signed `time:request` P2P message. The parent's `handleIncomingTimeRequest` deduplicates via `request:requestId` — re-delivering a request the parent already has is a no-op. Added `notified` flag to parent-side request entries and a `request:markNotified` dispatch so requests that already had their notification shown are not re-fired on subsequent reconnects. FCM-based real-time push added as future enhancement #78.

---

## Added 2026-03-31 (unpair/re-pair session)

### [x] Duplicate children on Dashboard after remove + re-pair — 2026-03-31
`invite:generate` was clearing all `blocked:` entries before sweeping stale topics. A lingering Hyperswarm connection from the removed child could reconnect in that window, pass `handleHello` (no longer blocked), and resurrect its `peers:` entry alongside the new child's. Fix: removed the block-clearing from `invite:generate` entirely. The child always gets a new keypair when processing `unpair` (see below), so `blocked:old_PK` never matches them again and accumulates harmlessly.

### [x] Re-pairing after remove requires clearing child app data — 2026-03-31
`unpair` wiped the child's DB but left the old keypair alive in the module-level `identity` variable. The child's next connection (after scanning a new invite) sent hello with the blocked PK — the parent rejected it, sent another unpair, and the child looped back to setup. Fix: `unpair` now calls `generateKeypair()` and mutates the identity object's `.publicKey`/`.secretKey` in place (not reassignment), so re-pairing succeeds in one scan.

### [x] Child profile name doesn't sync to parent after re-pairing — 2026-03-31
`identity:setName` broadcast used `ctx.identity.publicKey` for the hello payload, but `ctx.identity` is a reference captured at `createDispatch` time. After `unpair` reassigned the module-level `identity` variable, `ctx.identity` still pointed to the old object — so the broadcast declared the old (blocked) public key but signed with the new keypair, failing signature verification on the parent. Fixed by mutating the identity object in place (same fix as re-pairing above), keeping `ctx.identity` in sync automatically.

### [x] "Loading..." / "Checking..." flash on cold-start notification tap — 2026-03-31
Removed the text content from App.jsx's `mode === undefined` loading state and ParentApp's `pinCheckState === 'loading'` state. Both now return `null`, so the dark RN shell background is visible until the app is ready rather than briefly flashing loading text.

---

## Added 2026-03-31 (this session)

### [x] 75. App slow to start (20+ seconds) after remove/unpair cycles — 2026-03-31
`init()` in `bare.js` now cross-references `topics:*` entries against `peers:*` records at startup. Any topic not referenced by a live peer's `swarmTopic` is deleted from Hyperbee and skipped — no DHT join, no ~5s wait per orphaned topic. Pruning only runs when at least one paired peer exists, so a device mid-invite is unaffected. Startup now takes ~5-6s (one join per active peer).

### [x] 60. Parent PIN not carried over to child after Remove + re-pair — 2026-03-31
`handleIncomingAppsSync` and `handleIncomingAppInstalled` in `bare-dispatch.js` inject `pinHash` from the parent's local `'policy'` Hyperbee key into the policy pushed to the child, so the override PIN survives remove + re-pair cycles.

### [x] 73. Profile name change does not propagate to paired devices — 2026-03-31
`identity:setName` in `bare-dispatch.js` now broadcasts a signed `hello` to all currently connected peers after saving. `handleHello` on the receiving side updates the `peers:*` Hyperbee record and emits `child:reconnected`, refreshing the UI without a reconnect.

### [x] 74. Duplicate child entry after profile name change + parent force-stop/restart — 2026-03-31
`handleHello` in `bare.js` now scans the in-memory `peers` map for any existing entry with the same identity key under a different noise key, evicts it, and destroys the stale connection before associating the new one.

### [x] 15. Apps list: categories, collapsible sections, search — 2026-03-31
`AppsTab.jsx` rewritten to group apps into three collapsible sections (Pending Approval, Allowed, Blocked) each with a colored badge showing the count. Added a search bar that filters by app name or package name with a live match count. Empty sections hide automatically. Sort (A–Z / Date) applies within each section. `AppRow` behavior unchanged.

---

## Added 2026-03-31 (PR #21)

### [x] 65. Ghost child device reappears after Remove + force-stop/reinstall — 2026-03-31
`bare.js` `handleHello` detects stale `blocked:` peers and re-unpairs them before processing the hello, preventing ghost child entries from reappearing after a remove + reinstall cycle.

---

## Added 2026-03-31

### [x] 66. Time limit not enforced while app is already open — 2026-03-31
`EnforcementService` 5s polling loop now calls `AppBlockerModule.checkAndShowOverlayIfNeeded()`. `AppBlockerModule` tracks `lastForegroundPackage` (updated in `onAccessibilityEvent` for any non-system-overlay package or home launcher). `getDailyUsageSeconds` rewritten to use raw `queryEvents` instead of `queryAndAggregateUsageStats` — the aggregate API excludes the current live session, causing the limit to appear un-hit while the app was still open.

### [x] 67. Parent device receives "Your parent allowed more time" notification — 2026-03-31
`index.tsx`: added `&& _mode === 'child'` guard on the `request:updated` → `showDecisionNotification` block. The parent's `time:grant` handler emits `request:updated` locally, and without the guard the parent called `showDecisionNotification` on itself.

### [x] 68. Double notifications on child for approved time requests — 2026-03-31
`AppsTab.jsx`: `handleApprove`/`handleDeny` now call a new `onDecide` callback (local state update only) instead of `onUpdate` (which also fired `policy:update`). Sending both `app:decision` P2P (from `app:decide`) and `policy:update` P2P (from the redundant `policy:update` call) caused two separate `request:updated` events on the child → two notifications. Also fixed `handleTimeExtend` in `bare-dispatch.js` to include `appName`/`packageName` in the `request:updated` payload so the notification shows the real app name.

### [x] 70. Approving an app request does not immediately update Apps list UI — 2026-03-31
`bare-dispatch.js` `app:decide`: emits `apps:synced` after updating the policy. `AppsTab` already subscribes to this event and calls `loadPolicy()`.

### [x] 72. Overlay re-appears over Home screen after dismissing blocked app — 2026-03-31
Two fixes: (1) `lastForegroundPackage` is now updated when the home launcher comes to foreground (previously skipped because launcher is a system app with no launch intent on some devices), clearing the polling loop's target. (2) `enforcementSuppressedUntil` timestamp set for 2 minutes when child taps "Request More Time", preventing the polling loop from overwriting the duration picker dialog with a fresh overlay.

---

## UI / UX

### [x] 1. Force profile name creation at setup — 2026-03-24
Before completing first-launch setup (parent or child mode), require the user to enter a display name. The name is used in `hello` messages so the other device shows the real name instead of "PearGuard Device".
- **Where**: `app/setup.tsx` — add a name input step before or during mode selection; `identity:setName` bare method

### [x] 2. Share profile names between devices (Children tab) — 2026-03-24
Children tab shows child's real name from `hello`. Parent's name shown on child's Profile screen also uses `hello` reply. Both now include profile name.

### [x] 4. Parent UI: show pairing confirmation + refresh Children list — 2026-03-22
`child:connected` event triggers a success banner in `ChildrenList.jsx`.

### [x] 5. Child UI: show pairing confirmation + refresh Profile — 2026-03-22
`peer:paired` event triggers refresh of parents list; `pairState === 'success'` banner shown.

### [x] 8. Display app icons in Apps list — 2026-03-31
Child sends base64 icon in `app:installed` payload; `AppRow` in `AppsTab.jsx` renders it.

### [x] 10. "Child Requests" management page on parent — 2026-03-22
Requests tab added to `ChildDetail.jsx`. Reads `request:{requestId}` Hyperbee keys; Approve/Deny buttons per request.

### [x] 13. PIN override: prompt for duration — 2026-03-24
After correct PIN, child sees a "How long?" picker (15/30/60/120 min) before override is granted.

### [x] 20. Failsafe: unpair / deactivate all restrictions at once — 2026-03-31
Parent "Remove" button sends `child:unpair` P2P and clears all local records. Child wipes state and returns to setup. Offline child receives `unpair` on next reconnect via `handleHello` blocked-peer check.

### [x] 21. Clear old / stale Requests — 2026-03-22
Auto-expire and "Clear all resolved requests" button in `ChildRequests.jsx`. `requests:clear` bare method.

### [x] 27. Alphabetize Apps list; add sort option — 2026-03-24
`AppsTab.jsx` sorts by `appName` (fallback `packageName`); toggle between alpha and discovery-date order.

### [x] 31. Parent setup: require override PIN before first use — 2026-03-23
Gate 1 (`app/setup.tsx`): PIN setup step before navigating to dashboard. Gate 2 (`ParentApp.jsx`): `pin:isSet` check on mount. All PIN inputs restricted to 4 digits with auto-focus.

### [x] 43. UX: Schedule rule form should show validation error when Label is empty — 2026-03-24
`ScheduleTab.jsx` shows inline "Label is required" error.

### [x] 45. Parent: ability to edit existing schedule rules — 2026-03-24
Each rule row has Edit button. Loads rule into form; "Save Changes" replaces in place; Cancel restores Add Rule form.

### [x] 54. Force pairing to parent as part of child onboarding — 2026-03-25
`app/child-setup.tsx` step 3 requires scanning parent QR invite if no parent is paired. Skipped if already paired.

### [x] 62. "Send Request" overlay should prompt for a requested duration — 2026-03-31
`AppBlockerModule.java` `onSendRequest` shows duration picker; `requestedSeconds` included in `onTimeRequest` payload and `time:request` P2P. Parent Requests tab displays requested duration; approval uses it as default.

---

## Bugs Fixed

### [x] 18. Swipe-up gesture causes overlay to briefly flash — 2026-03-24
Added debounce and ignore list for known system gesture/nav packages in `AppBlockerModule.java`.

### [x] 19. Overlay: auto-dismiss when conditions are no longer met — 2026-03-23
`native:setPolicy` calls `dismissOverlayForPackage` for every `status: 'allowed'` app. `native:grantOverride` also calls it directly.

### [x] 22. Requests showing Pending even after approval — 2026-03-23
`handlePolicyUpdate` now scans `req:*` entries and updates any pending ones where the app is now `allowed`/`blocked`, emitting `request:updated`.

### [x] 23. PearGuard force-close stops enforcement — 2026-03-24
Child: `EnforcementService` writes heartbeat to SharedPreferences every 5s; on next launch `bypass:detected` queued to parent. Parent: `ParentConnectionService` checks heartbeat staleness every 60s; fires "enforcement may be off" notification after 3 min.

### [x] 24. Profile name changes don't sync to paired devices — 2026-03-24
`identity:setName` now broadcasts `profile:update` P2P to all connected peers; peers update `peers:{publicKey}` Hyperbee entry.

### [x] 28. Prevent child from clearing app storage — 2026-03-24
Not possible (requires Device Owner). Existing heartbeat staleness detection covers it; notification text updated to include "or app data cleared".

### [x] 29. Initial pairing should not send "app installed" notifications to parent — 2026-03-22
`handleIncomingAppsSync` suppresses alerts and `app:installed` events when `raw` is null (first sync).

### [x] 33. Selected tab highlight remains after navigating away from ChildDetail — 2026-03-22
`tabInactive` style now has `borderBottom: '2px solid transparent'` so React explicitly clears highlight on tab switch.

### [x] 34. Tapping a time-request notification on parent routes to Activity tab instead of Requests tab — 2026-03-22
`showTimeRequestNotification` uses `buildRequestsPendingIntent` which appends `&tab=requests`.

### [x] 35. Child: tapping "Request Approved" notification should navigate to Requests tab — 2026-03-22
`showDecisionNotification` builds `pear://pearguard/child-requests` deep link; `index.tsx` sets `_pendingChildRequestsNav`; `ChildApp.jsx` fires `setActiveTab('requests')`.

### [x] 36. "Successfully paired" banner fires on every reconnect — 2026-03-22
`handleHello` emits `child:connected` (first pair) vs `child:reconnected` (reconnect). Banner only on `child:connected`.

### [x] 38. Usage tab not populating any data — 2026-03-24
`usage:flush` now maps native array into `report.apps`. `usage:getLatest` handler added (reads last `usageReport:*` entry via `createReadStream`).

### [x] 39. Schedules and time limits not working together properly — 2026-03-25
`getBlockReason` in `AppBlockerModule` rewritten with explicit precedence: system exemptions → active override → scheduled blackout → policy status → daily limit.

### [x] 40. Tapping "app installed" notification should deep-link to Apps tab — 2026-03-23
`showAppInstalledNotification` builds `pear://pearguard/alerts?childPublicKey=X&tab=apps` PendingIntent.

### [x] 41. System apps must be exempt from policies and filtered from Usage report — 2026-03-23
`AppBlockerModule` exempts packages with no launcher icon. `UsageStatsModule` filters to launcher-package set.

### [x] 42. Usage tab data disappears after leaving and returning to the app — 2026-03-24
Fixed `usageReport:*` key persistence in Hyperbee; corrected `usage:getLatest` query range.

### [x] 46. "Requesting app access" notification shows package name instead of app name — 2026-03-24
Child includes `appName` in `time:request` P2P payload; parent uses it directly.

### [x] 51. Correct PIN not working on child device — 2026-03-24
`verifyPin()` switched from argon2id to BLAKE2b (`crypto_generichash`) to match `bare-dispatch.js` `pin:set`.

### [x] 55. After unpairing child device, can't pair back to same parent — 2026-03-25
`blocked:{childPublicKey}` entry is cleared when a new invite is generated or child completes invite acceptance.

### [x] 56. Unpair from parent doesn't clear active restrictions on child — 2026-03-25
`child:reset` in `index.tsx` calls `setPolicy('')` + `dismissAllOverlays()` before navigating to `/setup`.

### [x] 57. Overlay persists over Home screen after dismissing blocked app — 2026-03-25
`isCurrentHomeLauncher()` added; `onAccessibilityEvent` always dismisses overlay when home launcher comes to foreground. `DISMISS_COOLDOWN_MS` reduced to 800ms.

### [x] 58. Block overlay should show reason for block — 2026-03-26
Overlay title is now category-specific; reason strings are concise and human-readable.

### [x] 60. Parent PIN not carried over to child after Remove + re-pair — 2026-03-25
`handleIncomingAppsSync` and `handleIncomingAppInstalled` inject `pinHash` from parent `'policy'` key if missing from child policy.

### [x] 64. Inconsistent policy enforcement after multiple Remove/Re-pair cycles — 2026-03-25
(1) In-memory `overrides` + `pendingRequestPackages` cleared on re-pair via `clearAllOverrides()`. (2) `pearguard_override_*` SharedPreferences keys cleared by `clearChildState()`. (3) Stale `request:` Hyperbee entries deleted in `child:unpair`.

### [x] 65 (was open) — see current open #65 for ghost child bug.

---

## Reliability / Backend

### [x] 25. New app install: notify parent and auto-block until approved — 2026-03-23
`handleIncomingAppInstalled` and incremental `handleIncomingAppsSync` push `policy:update` to child immediately, setting new apps to `pending` so overlay fires on first open.

### [x] 26. Remove uninstalled apps from parent's Apps list — 2026-03-23
Full pipeline: `PackageMonitorModule` → `index.tsx` → `app:uninstalled` → `sendToParent` `app:uninstalled` P2P → parent deletes from `policy:{childPublicKey}.apps` and shows notification.

### [x] 29. Default policy for apps discovered at initial pairing — 2026-03-23
`handleIncomingAppsSync`: first-sync apps default to `status: 'allowed'`; `sendToPeer` moved outside `!isFirstSync` guard so child receives policy immediately.

### [x] 30. Default policy for apps at initial pairing — 2026-03-23
(See #29 above — combined fix.)

### [x] 32. Parent-initiated unpair / remote deactivation of child — 2026-03-25
Parent writes `blocked:{childPublicKey}`, deletes all records, sends signed `unpair` P2P. Child deletes all DB keys, emits `child:reset`. Offline child gets `unpair` on next `handleHello`.

### [x] 37. P2P messages not delivered to parent while app is backgrounded — 2026-03-24
`ParentConnectionService` foreground service keeps RN + Bare worklet alive; emits `onParentReconnectNeeded` every 30s → `swarm:reconnect`.

### [x] 47. Sync reliability: Hypercore lock retry + swarm.flush on disconnect — 2026-03-24
`init()` retries up to 20× on Hypercore lock error. `conn.on('close')` calls `swarm.flush()` for fast reconnect.

### [x] 48. Slow app startup (30–60 seconds) — 2026-03-25
`Promise.all` parallelizes topic rejoins (was sequential, ~5-6s/topic). `swarmTopic` persisted in peer record. Stale topics cleaned up on `child:unpair`.

### [x] 52. Maximize background delivery reliability — 2026-03-24
All child→parent messages queued in Hyperbee first; `flushPendingMessages` drains on reconnect. `ParentConnectionService` keeps Hyperswarm alive.

### [x] 59. New app install: auto-generate request + notification opens Requests list — 2026-03-31
`handleIncomingAppInstalled` creates `req:*` Hyperbee entry so new apps appear in Requests tab. `showAppInstalledNotification` links to `tab=requests`.

### [x] 63. Send Request: approval request vs. extra time request — 2026-03-25
`getBlockCategory()` derives `pending`/`blocked`/`schedule`/`daily_limit`. Approval type fires `onTimeRequest` with `requestType: "approval"`; schedule/limit type shows duration picker then `requestType: "extra_time"`. `time:grant` and `time:deny` bare dispatch handlers added.

---

## Known Limitations (not bugs, won't fix for now)

### Overlay not triggered for already-open apps
`TYPE_WINDOW_STATE_CHANGED` only fires on app transitions. If an app is already in the foreground when policy changes to blocked, no event fires. Tracked as open bug #66 (polling loop mitigation).

### Prevent child from clearing app storage
Not possible without Device Owner (enterprise MDM) privileges. Covered by heartbeat staleness detection (#23).
