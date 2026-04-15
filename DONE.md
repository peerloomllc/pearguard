# PearGuard — Completed Items

Completed items with implementation notes. Open items are in `TODO.md`.

---

## Added 2026-04-14

### [x] Look up ASC_APP_ID (#106) - closed 2026-04-14
- Registered `com.pearguard` App ID in Apple Developer portal and created PearGuard listing in App Store Connect.
- `asc apps list` returned numeric ID `6762235405`.
- Set `ASC_APP_ID=6762235405` in `~/peerloomllc/pearguard/scripts/.env` on Mac Mini (gitignored).

### [x] Create metadata/ios/ directory (#111) - closed 2026-04-14
- Scaffolded to match PearCal layout: `app-info/en-US.json`, `en-US/release_notes.txt`, `version/default/en-US.json`.
- PearGuard-specific copy: subtitle "P2P parental controls. No cloud.", privacy URL `peerloomllc.com/pearguard/privacy`, support URL `github.com/peerloomllc/pearguard/issues`.
- Release notes placeholder ("Initial release."); update before first submission.

### [x] Port screenshot automation from PearCal (#112) - closed 2026-04-14
- Copied scripts (`android-screenshots.sh`, `ios-screenshots.sh`, `screenshots.sh`, `add-ios-sources.rb`, `frame-android-screenshots.sh`) and `scripts/assets/pixel5-frame.png`.
- Added `ScreenshotModule.kt` + `ScreenshotPackage.kt` under `com.pearguard`, registered in `MainApplication.kt`; iOS `ScreenshotModule.swift` + `.m` registered via `add-ios-sources.rb`.
- `src/ui/screenshot-fixtures.js` with 10 scenes: parent dashboard, child detail Rules/Apps/Usage/Activity, Usage Reports (daily + categories), empty dashboard with Invite card, child Home, child Profile with paired parents.
- `app/index.tsx`: screenshot-mode bypasses dbReady gate and `/setup` redirect; injects `__PEARGUARD_SCREENSHOT_*` before WebView content load.
- Dashboard, ChildApp, ChildDetail, UsageReports, ChildHome read screenshot-mode hooks from `window`.
- Light-only (no dark loop). `scripts/app.conf` has iOS simulator UDID (shared with PearCal), `com.pearguard.debug` app id, `Pixel_9_Pro` AVD.
- `zapstore.yaml` `images:` and README "Screenshots" section point at `metadata/android/screenshots/Pixel_9_Pro_Framed/light/scene-{1..10}.png`.
- Small real-app fix: `ChildHome` root now adds `env(safe-area-inset-top)` padding so the locked banner clears the status bar on iOS.



### [x] Release pre-work: keystore, .env, release scripts, app.conf, zapstore.yaml (#104, #105, #107, #108, #110) - closed 2026-04-14
- #104 Created `pearguard` alias in existing `~/keystore.jks` (shared with PearCal).
- #105 `scripts/.env` created (gitignored) with shared NSEC, PeerLoom-CI ASC creds, `KEY_ALIAS=pearguard`, `PLAY_QUOTA_PROJECT=pearcal-release` (reusing existing GCP project).
- #107 `scripts/release.sh` and `scripts/ios-appstore.sh` copied from PearCal unchanged (parameterized via app.conf, added to .gitignore).
- #108 `zapstore.yaml` created with parental-control metadata.
- #110 `app.conf` reviewed: removed stale FIXMEs, uncommented iOS block, corrected tagline to "A peer-to-peer parental control app", updated Nostr hashtags.
- Bonus: `android/app/build.gradle` updated to read release signing from env vars with fallback to debug keystore; versionCode/versionName now derive from app.json (PR #85). First release AAB built and uploaded to Play Console internal testing track.
- Bonus: README and LICENSE added to repo (PR #83).

### [x] #109 Google Play app listing - closed 2026-04-14
App created in Play Console (`com.pearguard`, free), internal testing track set up, first AAB (v0.1.0) uploaded and released to internal testers. Privacy policy hosted separately by user.

### [x] Child Home phantom "awaiting approval" count (#136) - closed 2026-04-14
Stale pending-request count on Child Home with empty Requests tab — resolved.

### [x] Child device UI updates - closed 2026-04-14
Themed the child-facing screens to match parent styling and made the Home summary tiles interactive.
- `ChildRequests.jsx` rewritten to use `useTheme()` tokens (colors, typography, spacing, radius) — removed all hardcoded greys/hex.
- `ChildHome.jsx` Blocked / Awaiting approval / Pending requests tiles are now clickable buttons that open a themed Modal listing the relevant apps/requests. Tiles with count 0 are disabled. Greeting centered and falls back to time-based "Good morning/afternoon/evening" when the child hasn't set a name. "Active overrides" heading centered.
- `ChildApp.jsx` Requests tab removed from bottom nav; `navigate:child:requests` event now switches to Home so the requests modal can open.
- `bare-dispatch.js` `child:homeData` extended to return `blockedApps`, `pendingApps`, `pendingRequestsList` so the modals have data without extra round-trips.

## Added 2026-04-13

### [x] Miscellaneous UI cleanup - closed 2026-04-13
Merged via PR #79. Settings: centered title, mixed-case section headers with icons, auto-save name on blur, reorder (PIN → Appearance → Time Request → Warnings → Device Backup). Dashboard: centered title with absolute-positioned Add Child button. Usage: "See Reports" centered with "Last synced" below. Rules: removed tab strip, intro moved to info tooltip, Add Rule form hidden behind + button. ChildCard: unified avatar/dot/name spacing. Profile (child): centered title, auto-save on blur, Paired Parents wrapped in Collapsible, paired banner moved below section to avoid layout shift. New shared `Collapsible` primitive extracted.

### [x] Child app sometimes opens to black screen (#149) - closed 2026-04-13
Fixed per commit 5a2314f (merged via PR #78).

### [x] Clean up duplicate Parent entries on Child device (#151) - closed 2026-04-13
Auto-dedup in `children:list` dispatch (child mode only): groups `peers:*` records by normalized displayName; for groups >1, ranks by (isOnline desc, lastSeen desc, pairedAt desc) and deletes losers from Hyperbee plus `pendingParent:` and `knownPeerKeys`. Parent mode unaffected (two kids may share a name legitimately). Runs on every Profile tab load so duplicates don't resurface.

### [x] Approve All / Deny All for Pending Approval apps (#150) - closed 2026-04-13
Apps tab Status view "Pending Approval" section now shows both Approve All and Deny All buttons side-by-side, matching the Category view. Previously only Allowed ("Deny All") and Blocked ("Approve All") sections had batch actions.

### [x] Export/import child settings (#137) - closed 2026-04-13
Two signed JSON exports, both Ed25519-signed by the parent identity.
- **Device Backup** (Settings → Device Backup): full parent state — identity, profile, parentSettings, peers, all policies. Restoring on a fresh install lets a parent migrate to new hardware; Hyperswarm reconnects automatically because noiseKey derives from the restored identity. Pin plaintext stripped before export.
- **Copy Rules** (Child → Advanced tab → Rules Transfer): per-child policy clone (apps + schedules) for templating between children. Device-specific fields (pinHash, locked, lockMessage) never leave the source. Import is **intersect-only**: source rules are applied only for apps installed on the target child; target apps not in source keep their existing settings; schedule `exemptApps` are filtered to surviving packages. Preview surfaces "Skipped (not installed on target)" so parent sees what was dropped.
- File-based via expo-document-picker on iOS (share sheet) and a native `DownloadsModule` on Android (MediaStore.Downloads on Q+, no permission, toast confirmation).
- New `src/backup.js` with deterministic JSON serializer + 15 unit tests.
- Header cleanup: Export/Import/Unpair moved off ChildDetail header into a new "Advanced" tab; online dot moved between avatar and name.

### [x] Haptics on About page (#148) - closed 2026-04-13
Added `haptic:tap` to every interactive control on the About tab and wallet modal (URL buttons, Donate BTC, Share, Contact, wallet list, Close). Matches the tap-haptic pattern used elsewhere. PR #74.

### [x] Parent/child reconnection: swarmTopic persistence and self-heal (#147 follow-up) - closed 2026-04-13
Follow-up to PR #73. On-device logs showed peer records were being written without `swarmTopic` because Hyperswarm can deliver a connection with empty `info.topics[]` (dedup / reconnect paths), leaving `inMemoryPeer.topicHex` null in `handleHello`. After restart, the parent's init() rejoin loop only rejoined topics recorded in `peers:*`, so peers missing swarmTopic dropped off the announce set and the two sides ended up listening on different topics. `invite:generate` now persists `pendingInviteTopic:{hex}`; `invite:accept` stores `swarmTopic` on `pendingParent`; `handleHello` falls back to these when in-memory topic is null. `init()` self-heals legacy state: 1 missing + 1 orphan → bind them; multiple orphans → drop (re-pair required). Verified on device. PR #75.

### [x] Parent/child reconnection not recovering after long background (#147) - closed 2026-04-13
`swarm:reconnect` previously only called `swarm.flush()`, which does not re-announce on the DHT. After long background, network change, or Android doze the announce went stale and peers stopped discovering each other until re-pairing. Handler now mirrors the cold-start rejoin loop in `init()`: iterates `peers:*` for every `swarmTopic`, unions with persisted `topics:*`, and calls `joinTopic()` for each. Fix lives in shared bare-worklet code so Android and iOS both get it via their respective bundles. PR #73.

---

## Added 2026-04-12

### [x] iOS Camera/Gallery picker for avatars (#125) - closed 2026-04-12
Added iOS native camera picker with action sheet (Take Photo / Choose from Library / Cancel) and inline avatar buttons. PR #64.

### [x] Optional message for global lock (#139) - closed 2026-04-12
Both lock-confirmation modals (Dashboard and ChildDetail) now expose an optional message input (max 280 chars). `policy:setLock` accepts a `lockMessage` arg, stores it on the policy (cleared on unlock), and the existing `policy:update` push delivers it to the child. Android `AppBlockerModule.getBlockReason` uses the message as the block-overlay reason when present. Bundled fixes found while testing: (1) AppBlockerModule now exempts PearGuard's own package from block overlays so the child can still open the app while globally locked; (2) replaced the full-screen `LockOverlay` in `ChildHome` with a non-blocking red banner showing the parent name and optional lock message — the home UI stays accessible so the child can see pending requests, active overrides, and submit PIN/request flows while locked; (3) `children:list` now merges `locked` and `lockMessage` from each child's policy so the parent Dashboard padlock state persists across navigation instead of reverting to unlocked.

### [x] "Device has not checked in" notifications for unpaired child (#146) - closed 2026-04-12
Added `UsageStatsModule.clearChildHeartbeat(key)` that removes the four `heartbeat_*` SharedPreferences entries and cancels any posted offline notification; wired to the `child:unpaired` event in `app/index.tsx` so the parent stops tracking a child immediately on unpair. Also added `pruneStaleHeartbeats(pairedKeys)` that runs on `ready` to clean up legacy entries left behind by unpairs that predate this fix. `bare.js` now includes `pairedKeys` in the `ready` event so the native prune has the current paired set.

### [x] Parent/child not connected on app load (#144) - closed 2026-04-12
Dashboard and Profile now subscribe to `peer:connected` / `peer:disconnected` and flip `isOnline` on the matching child/parent by `noiseKey`, plus refresh `children:list` on connect so usage fields re-populate. Root cause: the connection dot is driven by `children:list` (computed from `ctx.peers.has(noiseKey)`), which was called once on mount before Hyperswarm DHT discovery completed; no UI listener updated the state when peers connected later. Also added a startup backfill in `bare.js`: any `swarmTopic` referenced by a peer record is now rejoined even if the `topics:*` entry was never persisted (older pairings predate topic persistence).

### [x] QR-only invite and single Photo picker on Android (#145, #136) - closed 2026-04-12
Removed copy/paste invite-link UI across child-setup and pairing flows; QR code is now the sole pairing method. On Android, consolidated the redundant Camera button into a single "Photo" picker (gallery already surfaces camera and files). PR #70.

### [x] Onboarding design to match rest of app (#134) - closed 2026-04-12
Added shared RN theme module (`src/rn-theme.ts`) mirroring the WebView tokens (colors, spacing, radius, typography) so native onboarding screens can't drift from the main UI. Registered Nunito (`@expo-google-fonts/nunito` + `expo-font` + `expo-splash-screen`) in `app/_layout.tsx`, holding the splash until the fonts load. Refactored `app/setup.tsx` and `app/child-setup.tsx` to consume shared tokens and Nunito weights (Light/Regular/SemiBold/Bold) instead of hardcoded hex and system fonts. PIN inputs on iOS now have an `InputAccessoryView` with a Done button so the numeric keyboard is dismissable on small screens (iPhone SE).

### [x] Center tabs on child detail (#138) - closed 2026-04-12
Sub-tab row on ChildDetail now centers via `justifyContent: 'center'`. Also added `overflowX: 'hidden'` to the tab content scroll container to prevent horizontal scroll/bounce on iOS in the Rules tab.

### [x] Global/category time limits (#130) and Clear/apply time limits per category (#142) - closed 2026-04-12
Added per-category daily time limits alongside the existing per-app limits. Policy now carries `categories[name] = { dailyLimitSeconds }`. Precedence: per-app limit wins; category limit applies only to apps in the category with no limit of their own. Enforcement (Android `AppBlockerModule.getCategoryLimitBlockReason`) sums foreground usage across every app sharing the category. Apps tab category view exposes a limit input with Save, Apply to All (copies the limit onto every app in the category), and Clear All (removes the category limit and per-app limits). Both destructive actions use the shared Modal/Button confirmation pattern. Bundled UX refinements: pending-only bulk approve/deny row (hides when no pending), inherited-limit display with Override/Revert affordances, simplified header (total count + amber pending badge), centered Sort/Filter pills with fixed widths, haptic feedback on all controls.

### [x] Show current PIN on Settings page (#141) - closed 2026-04-12
Added a "Current PIN: ••••" row at the top of Settings → Override PIN with an Eye/EyeSlash toggle that reveals the parent's PIN. PIN plaintext is now stored locally in the parent's `policy` Hyperbee record (new `pinPlain` field) alongside the existing `pinHash`; plaintext is never placed in per-child policies or sent over the wire. New `pin:get` dispatch returns the stored plaintext. Revealed PIN auto-hides when the Override PIN section collapses. Existing PINs set before this change will appear as "••••" until re-saved.

### [x] Global lock now requires confirmation (#140) - closed 2026-04-12
Tapping the padlock in ChildDetail top bar or a Dashboard child card now opens a confirmation modal before locking. Unlocking stays instant (single tap on the red padlock). Both modals share identical copy ("This will immediately block all apps on {name}'s device until you unlock it."), centered text, danger-variant Lock button, and flex-1 footer buttons.

### [x] Co-parent unpair leaves stale parent record on child (#132) - closed 2026-04-12
Obsolete. The co-parent concept/flow was removed in PR #127 (2026-04-11) in favor of direct pairing, where each parent pairs with the child independently via the standard "Add Child" flow and policies sync via child relay. There is no longer a "co-parent" relationship that can be unpaired, so the stale-record scenario no longer applies.

---

## Added 2026-04-11

### [x] Not consistently receiving usage stats from Child (#131) - closed 2026-04-11
Native usage queue in SharedPreferences collects stats when the RN bridge is dead (app dismissed). EnforcementService queues every 60s, WorkManager backs up every 15 min. Queue flushes over P2P on app reopen. WorkManager wakes the app via MainActivity only when data is >30 min stale, with no-animation and 10s auto-background to minimize child disruption. PR #63.

### [x] Apps tab should remember last active filter (#123) - closed 2026-04-11
Added generic `pref:set`/`pref:get` Hyperbee dispatch cases for UI preferences. Apps tab viewMode is persisted on toggle and restored on mount. localStorage doesn't work in inline-HTML WebViews, so Hyperbee is used instead.

### [x] Co-parent flow missing onboarding/dashboard entry point (#127) - closed 2026-04-11
Replaced broken brokered co-parent pairing (Hyperswarm dedup issues) with direct pairing: Parent B uses "Add Child" to generate a fresh topic, Child scans via "Pair Another Parent" on Profile page. Added policy sync via child relay so app decisions propagate between co-parents in real-time. Removed ~640 lines of dead brokered flow code and orphaned UI components.

### [x] Second parent using regular invite instead of Add Parent (#121) - closed 2026-04-11
No longer an issue. The brokered co-parent flow has been removed. All parents now pair directly with the child using the standard "Add Child" flow, and policies are synced between parents via child relay.

---

## Added 2026-04-10

### [x] Quickly foregrounding/backgrounding app can dismiss overlay (#126) - closed 2026-04-10
Not a bug. The 800ms cooldown after overlay dismissal is intentional (prevents overlay flashing on home screen during activity destruction). Rapid fg/bg cycling can delay overlay reappearance by up to 5 seconds, but the EnforcementService polling loop always catches it. Timing gap, not a bypass.

### [x] Frequent "Child device has not checked in" notifications (#112) - completed 2026-04-10
Resolved - no longer a priority issue.

### [x] Add Hyperswarm dedup resilience pattern to P2P wiki (#128) - completed 2026-04-10
Documented the conn identity check pattern for Hyperswarm dedup in the P2P wiki. Covers close/error handler guards, per-connection state tracking, and cross-project applicability.

### [x] Add piggyback sync pattern to P2P wiki (#129) - completed 2026-04-10
Documented three complementary sync patterns (piggyback push, pull-based on UI open, reconnect backfill) for reliable P2P state convergence. Includes design rules for idempotency, dedup via Hyperbee keys, and bounded sync windows.

### [x] Co-parent request approval/denial not syncing to other parent (#122) - completed 2026-04-10
Root cause: Hyperswarm dedup closing live connections (peers/parentPeers close handlers deleted entries without checking conn identity), plus stale iOS bare-ios-sim.bundle being loaded on physical device. Fixed: (1) conn identity checks in close/error handlers, (2) piggyback resolved requests onto usage:report for reliable co-parent sync, (3) always trigger pull-based syncResolved on Activity tab open, (4) pass childPublicKey through handleRequestResolved for proper alerts:list filtering, (5) setup.tsx PIN screen ScrollView for small iOS screens. Branch: `bugfix/coparent-pin-and-request-sync`, PR #60.

---

## Added 2026-04-09

### [x] Multi-parent PIN conflict - last sync wins (#120) - completed 2026-04-09
Replaced single `pinHash` with per-parent `pinHashes: { [parentPublicKey]: hash }` map in child policy. Parent `pin:set` writes to `pinHashes[myKey]`. Child `handlePolicyUpdate` merges incoming pinHashes with existing ones so each parent's PIN survives the other's policy push. Added legacy `pinHash` -> `pinHashes[senderKey]` conversion for parents running old code. Native `verifyPin` (AppBlockerModule.java) iterates all pinHashes values with legacy pinHash fallback. Branch: `bugfix/coparent-pin-and-request-sync`.

## Added 2026-04-08

### [x] iOS notification tap doesn't navigate to child's Activity tab (#124) - completed 2026-04-09
Made LinkModule an RCTEventEmitter so notification taps fire a JS event immediately (handles foreground, background, and cold start). Fixed tab='requests' in showNotification to tab='activity' to match Android behavior - ChildDetail has no 'requests' tab so it was falling back to UsageTab. Added event handler retry in Dashboard to buffer nav when children aren't loaded yet.

### [x] Donate BTC button not working on iOS without Lightning wallet (#119) - completed 2026-04-08
Added canOpenURL IPC handler in RN shell. AboutTab now checks if a Lightning wallet is installed before opening the lightning: URI. If none found, shows a modal with wallet suggestions (Strike, Cash App, Wallet of Satoshi, Phoenix). Added LSApplicationQueriesSchemes to iOS config for the lightning scheme.

### [x] iOS parent-only version (#102) - completed 2026-04-08
Added iOS support as parent-only device. Five Swift native modules (notifications, haptics, background sync, share, deep links) ported from PearCal. Platform.OS branching in index.tsx. Background fetch for P2P sync. Tested on iPhone SE - launch, setup, dashboard, invite links all working. PR #58.

### [x] Android back gestures (#113) - completed 2026-04-08
Implemented WebView navigation and tab-level back handling for Android gesture nav.

### [x] Adapt PearCal release script to PearGuard (#103) - completed 2026-04-08
Covered by release pre-work items #104-#111.

---

## Added 2026-04-07

### [x] Usage stats only updating sometimes (#114) - completed 2026-04-07
The usageFlushRequested handler (P2P reconnect path) was missing getLastForegroundPackage and getSessionsSinceLastFlush calls, producing incomplete usage reports on reconnect.

### [x] Change "This week" to "Last 7 days" (#115) - completed 2026-04-07
Updated label on usage bars from "This week" to "Last 7 days" to clarify rolling window.

### [x] Save name button too wide (#117) - completed 2026-04-07
Added alignSelf: 'center' to Save Name button on both Settings (parent) and Profile (child) screens.

### [x] Add Rule button centering (#118) - completed 2026-04-07
Added justifyContent: 'center' to the Add Rule button container on the Rules tab.

### [x] Show scale on usage bars with time limits (#120) - completed 2026-04-07
Usage bars now show "X of Y" (e.g. "45m 30s of 2h 0m") when a daily time limit is set.

### [x] Fix usage report accuracy (#111) - completed 2026-04-07
Fixed wrong ACTIVITY_RESUMED/PAUSED event type constants (were hardcoded as 7/8, actually 23/24). Added 3-second session merging to handle gesture navigation causing rapid activity cycling. Updated formatSeconds to show seconds for sub-minute usage.

### [x] Fix app list not syncing to second parent (#109) - completed 2026-04-07
Moved sendToAllParents call outside the newCount > 0 guard in apps:sync handler so the full app list is always relayed to all connected parents, even when no new apps were added on the child device.

### [x] Multi-parent pairing on-device validation (#108) - completed 2026-04-07
3-device testing passed: two parent devices (Pixel 9 Pro + Pixel 7) paired to one child (TCL). Usage stats sync, app list sync (after #109 fix), and co-parent invite flow all verified.

### [x] Co-parent invite UI (#110) - completed 2026-04-07
Added "Add Co-Parent" button in child detail top bar with CoparentInviteCard component (QR + share + copy). Added coparent.tsx Expo Router screen and AndroidManifest intent filter for pear://pearguard/coparent deep links. Fixed clipboard:copy to use RN built-in Clipboard.

---

## Added 2026-04-06

### [x] Add 2-week donation reminder (#104) - completed 2026-04-06
Added donation reminder modal matching PearCal's pattern. Shows after 2 weeks based on identity createdAt timestamp; dismissed permanently via donationReminderDismissed flag in Hyperbee. Existing installs without createdAt treated as eligible.

### [x] Remove FAB from Child Home tab (#107) - completed 2026-04-06
Removed the floating action button from ChildApp Home tab and deleted the unused FAB.jsx component.

### [x] Settings page UI tweaks (#106) - completed 2026-04-06
Refactored Settings into collapsible accordion sections (Override PIN, Time Request Options, Warning Notifications, Appearance) matching PearCal's pattern. Profile section remains static at top. Replaced custom button styles with shared Button component. Centered Save Settings button.

### [x] Tap highlight shape fix (#109) - completed 2026-04-06
Added global `-webkit-tap-highlight-color: transparent` and `button:active` opacity rule so tap highlights respect border-radius.

### [x] About page button colors (#105) - completed 2026-04-06
Replaced custom inline-styled buttons with shared Button component (secondary variant) and added Phosphor icons matching PearCal's About page.

### [x] Usage Reports date keys, session accuracy, and UI fixes (#99) - completed 2026-04-06
Fixed UTC date keys causing sessions to appear under wrong day. Fixed chart label cutoff for "12a"/"11p".

### [x] Time request overlay dismissal fix (#93) - completed 2026-04-06
Fixed overlay disappearing and app becoming usable before parent responds to time request.

### [x] Rethink Add Child invite flow (#101) - completed 2026-04-06
Replaced FAB + modal overlay with inline InviteCard on Dashboard. Empty state shows welcome message with "Add Your First Child" button; existing children get "+ Add Child" header button. Added paste invite link option on child setup step 3. Added native clipboard:copy IPC handler. Deleted AddChildFlow.jsx.

### [x] Move "See Reports" button to top of Usage tab (#100) - completed 2026-04-06
Moved button inline with "Last synced" header. Sorted apps list descending by today's usage. Renamed "See Details" to "See Reports".

## Added 2026-04-05

### [x] Interactable Screen Time-style usage reports (#95) - completed 2026-04-05
Session-level usage tracking with 30-day retention. Native Android session building from UsageStatsManager events. Four interactive views on parent device: Daily Summary (hourly SVG bar chart, day navigation), Weekly Trends (7/30-day toggle, average line, period comparison), Per-App Drill-Down (session list, sparkline, stats), Category Breakdown (animated SVG donut chart). Animated usage bars on Usage tab with "See Details" entry point. System/launcher app filtering.

### [x] Animation/feedback on approve/deny in Apps list (#83) - completed 2026-04-05
Slide/fade animations when apps move between Pending/Allowed/Blocked groups in By Status view. Batch fade for Approve All/Deny All. Also: sticky header row, auto-expand categories on search, batch buttons in status view sections, category header pills show allowed (green) and blocked (red) counts.

## Added 2026-04-04

### [x] Block overlay UI update (#97) - completed 2026-04-04
Themed all three native Android overlays (block screen, PIN entry, duration picker) to match the WebView dark UI. Grouped-card layout style with Phosphor icons in tinted circles, Nunito font (Regular + SemiBold TTFs bundled), dot indicators for PIN entry, rounded keypad keys, ghost cancel buttons, and full dark theme color palette. Added `OverlayTheme` constants and `PhosphorIcon` SVG path renderer using `androidx.core.graphics.PathParser`. Removed unused `Button` import.

### [x] Active app indicator on device card (#98) - completed 2026-04-04
Fixed Dashboard device card to show current foreground app on Child device. Root causes: wrong event name (`child:usageReport` vs `usage:report`), missing `currentApp`/`todayScreenTimeSeconds` fields in usage report, and `children:list` not merging latest usage data (causing reset on re-mount). Also added app icon (16px) next to app name on the card, reduced usage flush interval from 5min to 1min, and exposed `getLastForegroundPackage` as a React Native method.

### [x] UI overhaul session (#87) - completed 2026-04-04
Full visual redesign: dark/light theme system, Nunito font, Phosphor icons, component primitives (Button, Card, Badge, Input, Toggle, Modal), TabBar + FAB navigation, consolidated tabs (Activity = Alerts+Requests, Rules = Schedule+Contacts), quick-lock feature, and all screens migrated to themed styles. Follow-up fixes: lock enforcement end-to-end, onboarding Phosphor icons via react-native-svg, notification deep link navigation via onResume event.

## Added 2026-04-03

### [x] FCM push for force-stopped parent (#78) - closed 2026-04-03
Closed as won't fix. ParentConnectionService already runs as a foreground service to keep the parent alive. The only remaining gap is force-stop from Settings, which is an intentional user action. Adding FCM would compromise the P2P/privacy-first design for a narrow edge case.

### [x] Persistent parent identity key (#12) - closed 2026-04-03
Decision: won't fix. Identity lives in Hyperbee (documentDirectory), which is wiped by Android "Clear Data" as expected. Persisting outside Hyperbee adds complexity for a narrow edge case. Current behavior is correct - clearing data is effectively a factory reset.

### [x] Configurable time request options and warning thresholds (#96) — 2026-04-03
Added Settings UI chip selectors for time request duration options (child block overlay) and warning notification thresholds (minutes before block). Settings stored in Hyperbee, synced to child via policy. Native EnforcementService and AppBlockerModule read from policy settings instead of hardcoded values.

### [x] About page on Parent device (#79) — 2026-04-03
Added About tab with P2P explainer, Support Development (Donate BTC + Buy Me a Coffee), Learn About Bitcoin, Share the App, and Contact sections. Merged parent Profile into Settings (avatar + name on top, PIN below). Added openURL IPC handler.

### [x] More reliable/accurate usage metrics (#92) — 2026-04-03
Switched daily usage collection from aggregate stats to raw queryEvents() for real-time accuracy (includes current live session). Added batch weekly usage. Usage reports now include weekSeconds and dailyLimitSeconds. Bars scale against daily limit when set, 24h/168h otherwise.

### [x] Move overrides from Requests tab to Apps list (#84) — 2026-04-03
Active overrides now show as a blue time-remaining badge on individual app rows in AppsTab. Removed overrides section from RequestsTab. Override data refreshes every 30s and on request events.

### [x] Save button for app time limits (#91) — 2026-04-03
Time limit input no longer auto-saves on blur. A blue "Save" button appears when the input differs from the saved value. Enter key also saves. Clearing and saving removes the limit.

### [x] Fix notification deep link navigating to wrong tab (#94) — 2026-04-03
PendingIntents used `FLAG_IMMUTABLE | FLAG_UPDATE_CURRENT`, which on Android 12+ prevents updating cached intent data. After process restarts, the static `notificationId` counter resets, causing request code collisions with stale cached intents pointing to the wrong tab. Fixed by switching to `FLAG_CANCEL_CURRENT` in all three PendingIntent builders.

### [x] Fix overlay not dismissed when daily limit removed (#90) — 2026-04-03
Two fixes: (1) UI — clearing the time limit input now deletes `dailyLimitSeconds` from the policy instead of silently keeping the old value. (2) Enforcement — `checkAndShowOverlayIfNeeded()` now re-evaluates `getBlockReason()` every 5s while the overlay is showing, dismissing it if the block no longer applies.

### [x] Fix false "enforcement may be off" notifications after reinstalls (#88) — 2026-04-03
ParentConnectionService now has a 3-minute grace period after startup before checking stale heartbeats, and ignores heartbeat timestamps from before the current service session. Prevents false notifications when P2P connection hasn't re-established yet.

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
