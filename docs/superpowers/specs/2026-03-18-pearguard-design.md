# PearGuard — Design Specification

**Date:** 2026-03-18
**Project:** PearGuard (working directory: `~/peerloomllc/test`, to be renamed `pearguard-native`)
**Author:** PeerloomLLC

---

## Overview

PearGuard is a privacy-focused, peer-to-peer parental control app for Android. It allows a parent device to monitor app usage, approve/deny app installs, set time limits and schedules, and enforce rules on one or more child devices. All communication between devices is strictly peer-to-peer using the Pear/Hypercore stack with holepunching — no servers, no accounts, no data collection.

The app ships as a single APK with two modes: **Parent** and **Child**, selected on first launch.

---

## Target Platform & Distribution

- **Platform:** Android only (v1)
- **Distribution:** Google Play Store
- **Enforcement model:** Accessibility Service overlay (Option B) + Device Admin registration (prevents uninstall)
- **Age targets:** Younger children and teenagers

---

## Runtime Architecture

PearGuard uses the same three-layer architecture as PearCal, with an additional native enforcement layer:

```
┌─────────────────────────────────────────┐
│  React Native (Expo) Shell              │  app/index.tsx
│  - Loads bundles, owns native bridges   │
│  - Routes IPC between all layers        │
├─────────────────────────────────────────┤
│  WebView (React UI)                     │  src/ui/
│  - Parent mode: dashboard, policy mgmt  │
│  - Child mode: status screen, requests  │
│  - Communicates via postMessage         │
├─────────────────────────────────────────┤
│  Bare Worklet (P2P Backend)             │  src/bare.js
│  - Keypair identity, signing/verify     │
│  - Hyperswarm peer discovery            │
│  - Signed message send/receive          │
│  - Local Hyperbee persistence           │
├─────────────────────────────────────────┤
│  Native Foreground Service (Android)    │  Java/Kotlin
│  - Accessibility Service (app blocking) │
│  - UsageStatsManager (monitoring)       │
│  - DeviceAdminReceiver (anti-uninstall) │
│  - PackageManager (install detection)   │
└─────────────────────────────────────────┘
```

**IPC message flow** (same pattern as PearCal):
- WebView → RN: `window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args }))`
- RN → Bare: `_worklet.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))`
- Bare → RN: `BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))`
- RN → WebView: `webViewRef.current.injectJavaScript('window.__pearResponse(...); true;')`
- RN → WebView (events): `webViewRef.current.injectJavaScript('window.__pearEvent("name", data); true;')`

---

## Identity, Pairing & P2P Messaging

### Identity

Each device generates a keypair on first launch using `sodium-native`. The public key is the device's permanent identity. No accounts or email addresses are required.

### Device Modes

On first launch, the user selects **Parent** or **Child** mode. This is stored in the local Hyperbee and determines which UI and enforcement behaviors are active. A device can only be in one mode.

### Pairing

1. Parent generates a pairing invite (QR code or shareable link)
2. The invite encodes: `{ parentPublicKey, swarmTopic }`
3. Child scans the QR / opens the link, stores the parent's public key, connects via Hyperswarm on the shared topic
4. On first connection, child sends its public key and display name; parent stores the child identity
5. Multiple children can be paired to one parent (one swarm topic per parent-child pair)

Invite links use the same deep link mechanism as PearCal (`pearguard://` scheme, intercepted via Android intent filter).

### P2P Layer

- One Hyperswarm topic per parent-child pair, derived from a shared secret exchanged during pairing
- All messages are signed JSON — sender signs with their private key, receiver verifies against the stored public key
- Unknown or unverifiable messages are silently dropped
- Both devices persist the latest state to local Hyperbee; child enforces last-received policy when offline

### Message Types

| Direction | Type | Payload |
|-----------|------|---------|
| Parent → Child | `policy:update` | Full policy snapshot (rules, limits, schedules, blocked apps, allowed contacts, PIN hash) |
| Parent → Child | `app:decision` | Approve or deny a pending install request |
| Parent → Child | `time:extend` | Grant extra time for an app or globally |
| Child → Parent | `usage:report` | Periodic app usage stats and PIN override log |
| Child → Parent | `app:installed` | New app detected, awaiting approval |
| Child → Parent | `time:request` | Child requesting more time |
| Child → Parent | `alert:bypass` | Accessibility Service disabled, Safe Mode detected, etc. |
| Child → Parent | `heartbeat` | Online status and enforcement state |

**Offline behavior:** Child enforces last-received policy. Parent dashboard shows last-known data with a "last synced" timestamp. On reconnect, child flushes queued reports and parent sends any pending policy updates.

---

## Native Enforcement Layer (Child Device Only)

Runs as an Android foreground service in Java/Kotlin. Starts on boot. Active only on child-mode devices.

### Native Modules

| Module | Purpose |
|--------|---------|
| `EnforcementService` | Main foreground service; orchestrates all enforcement, polls policy every few seconds |
| `AppBlockerModule` | Accessibility Service — detects foreground app, shows block overlay |
| `UsageStatsModule` | Queries `UsageStatsManager` for per-app daily/weekly usage |
| `DeviceAdminModule` | `DeviceAdminReceiver` — prevents uninstall without parent PIN |
| `PackageMonitorModule` | `BroadcastReceiver` for `ACTION_PACKAGE_ADDED` — detects new installs |
| `ContactsModule` | Reads contacts for SMS/call exception list |
| `BootReceiverModule` | `BroadcastReceiver` for `BOOT_COMPLETED` — restarts enforcement after reboot |

### Enforcement Logic

On each Accessibility foreground app event:
1. Is this app permanently blocked? → Show block overlay
2. Is this a scheduled blackout period? → Show block overlay
3. Has this app exceeded its daily limit? → Show block overlay
4. Is this app pending approval (not yet approved after install)? → Show block overlay
5. Otherwise → allow, increment usage counter

SMS/call exceptions: allowed contacts bypass block rules for the phone and messaging apps. The following package names are treated as phone/messaging apps subject to contact-based exceptions: `com.android.dialer`, `com.google.android.dialer`, `com.android.mms`, `com.google.android.apps.messaging`, and any app whose package name contains `dialer`, `sms`, or `messaging`. Additional packages can be added to the policy in a future version.

Every 5 minutes: flush usage stats to Hyperbee, send `usage:report` to parent if connected.

### Bypass Detection

If the Accessibility Service is disabled or the app is force-stopped:
- On next app launch, a persistent notification warns the child
- On next Hyperswarm connection, an `alert:bypass` message is sent to the parent
- Parent dashboard shows a red "enforcement offline" badge for that child

### Required Permissions

| Permission | Method |
|-----------|--------|
| `PACKAGE_USAGE_STATS` | User enables manually in Settings |
| `BIND_ACCESSIBILITY_SERVICE` | User enables manually in Settings |
| `BIND_DEVICE_ADMIN` | User grants during Device Admin enrollment |
| `RECEIVE_BOOT_COMPLETED` | Normal manifest permission |
| `READ_CONTACTS` | Normal runtime permission |
| `FOREGROUND_SERVICE` | Normal manifest permission |

---

## PIN Override System

- Parent sets a numeric PIN in the parent UI
- The PIN is hashed using `sodium-native`'s `crypto_pwhash` before transmission — raw PIN never leaves the parent device
- Hashing parameters are fixed constants shared across all code paths: `opslimit = crypto_pwhash_OPSLIMIT_INTERACTIVE`, `memlimit = crypto_pwhash_MEMLIMIT_INTERACTIVE`, `alg = crypto_pwhash_ALG_DEFAULT`
- The PIN hash is included in `policy:update` messages and stored in the child's Hyperbee
- Parent also sets an override duration (e.g. 15 min, 1 hr, until bedtime)

**On the block overlay, the child has two options:**
1. **"Send Request"** — fires a `time:request` to the parent device; parent approves or denies remotely
2. **"Enter PIN"** — enter PIN locally; hash is compared against stored hash; if correct, grants a timed override

Every PIN use is logged and included in the next `usage:report` (app name, timestamp, duration).

Parent can rotate the PIN at any time; the new hash propagates via the next `policy:update`.

If the child device is offline, Send Request is unavailable but PIN entry still works — intentional, as the parent sharing the PIN is a deliberate trust gesture.

---

## Parent Dashboard UI

**Navigation:**
```
Bottom tabs: Dashboard | Children | Settings
```

**Dashboard:** Card per child showing name, online status, current active app, today's screen time, and alert badges (bypass attempts, pending approvals, pending time requests).

**Child Detail (tabs):**
- **Usage** — per-app usage bars (today / this week), last synced timestamp
- **Apps** — installed app list with Allow/Block toggle, daily time limit per app, pending approval badges
- **Schedule** — time range rules (e.g. "No apps 9pm–7am", "School hours Mon–Fri 8am–3pm")
- **Contacts** — SMS/call exception list (selected from device contacts)
- **Alerts** — log of bypass attempts, PIN uses, time requests

**Settings:** Override PIN management, parent display name, app preferences.

---

## Child UI

Minimal — not a control center.

**Navigation:**
```
Bottom tabs: Home | Requests
```

- **Home** — current enforcement status ("All good", "Bedtime mode", "Enforcement offline" warning)
- **Requests** — send time requests, view pending approvals
- **Block Overlay** — full-screen overlay shown by Accessibility Service when an app is blocked; displays app name, reason, and two action buttons: "Send Request" and "Enter PIN"

---

## Policy Data Model

Stored in parent Hyperbee; transmitted as signed JSON in `policy:update`:

```js
{
  version: 1,                          // incremented on every change
  childPublicKey: '...',
  pinHash: '...',                      // sodium crypto_pwhash hash
  overrideDurationSeconds: 3600,
  apps: {
    'com.example.tiktok': {
      status: 'blocked',               // 'allowed' | 'blocked' | 'pending'
      dailyLimitSeconds: 3600,
    }
  },
  schedules: [
    {
      label: 'Bedtime',
      days: [0,1,2,3,4,5,6],          // 0 = Sunday
      start: '21:00',
      end: '07:00'                     // if end < start, the range spans midnight (e.g. 21:00–07:00 = overnight block)
    }
  ],
  allowedContacts: [
    { name: 'Mom', phone: '+15551234567' }
  ]
}
```

---

## First Launch & Setup Flow

```
Launch
├── Mode Selection: "I'm a Parent" / "I'm a Child"
│
├── Parent Path:
│   ├── Generate keypair
│   ├── Set display name
│   ├── Set override PIN
│   └── Home → Add Child (generates QR / invite link)
│
└── Child Path:
    ├── Generate keypair
    ├── Set display name
    ├── Scan parent QR / open invite link
    ├── Permission Wizard (one screen per permission, plain-language explanations):
    │   ├── Usage Access (PACKAGE_USAGE_STATS)
    │   ├── Accessibility Service (BIND_ACCESSIBILITY_SERVICE)
    │   └── Device Admin (BIND_DEVICE_ADMIN)
    └── Enforcement starts, initial policy:update received from parent
```

---

## Project Structure

```
pearguard-native/
├── app/                    # RN shell (TypeScript)
│   ├── index.tsx           # Main shell, IPC routing, worklet lifecycle
│   ├── setup.tsx           # Mode selection + permission wizard
│   └── join.tsx            # Deep link / invite handling
├── src/
│   ├── bare.js             # Bare worklet: Hyperswarm, signing, Hyperbee
│   ├── invite.js           # Invite link builder/parser
│   └── ui/
│       ├── main.jsx        # WebView bootstrap
│       ├── App.jsx         # Full React UI (parent + child modes)
│       └── components/     # Shared UI components
├── android/
│   └── app/src/main/java/com/pearguard/
│       ├── EnforcementService.java
│       ├── AppBlockerModule.java
│       ├── UsageStatsModule.java
│       ├── DeviceAdminModule.java
│       ├── PackageMonitorModule.java
│       ├── ContactsModule.java
│       └── BootReceiverModule.java
├── assets/
│   ├── bare-universal.bundle
│   └── app-ui.bundle
├── docs/
├── CLAUDE.md
├── package.json
└── TODO.md
```

---

## Key Lessons Applied from PearCal

- All cross-layer IPC is JSON-over-newline dispatched by `method` name
- UI-only changes rebuild only `app-ui.bundle`; `bare.js` changes rebuild both bundles
- Native module changes require full `./gradlew assembleDebug` rebuild
- Always use `adb install -r` — never uninstall (preserves Hyperbee data)
- Feature branch strategy: `feature/description`, merge via GitHub PR
- New Java files must be registered in `build.gradle` / Android manifest before building
- Boot receiver must be declared in `AndroidManifest.xml` to survive device restarts

---

## Google Play Considerations

- Accessibility Service usage requires a Declaration Form submission justifying the parental control use case
- App description must clearly state it is a parental control application
- Device Admin usage must be declared and justified
- `PACKAGE_USAGE_STATS` is a special permission; the setup wizard must guide the user to enable it manually in Android Settings
- Expect extended review times on first submission

---

## Out of Scope (v1)

- iOS support
- Content filtering / web filtering
- Location tracking
- Remote device lock / wipe
- Multiple parent devices per child
- Cloud backup / seed word recovery
