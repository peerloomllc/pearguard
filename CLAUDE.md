# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Project Overview

PearGuard is a privacy-focused, peer-to-peer parental control app for Android.
It uses the same three-layer architecture as PearCal:
- React Native (Expo) shell: `app/index.tsx`
- WebView React UI: `src/ui/`
- Bare worklet (P2P backend): `src/bare.js`

A fourth layer — native Android enforcement (Accessibility Service, DeviceAdmin) — is
added in Plan 2.

## Build & Deploy

Two test devices connected via ADB:
- Device 1: (parent device — update this with your ADB serial)
- Device 2: (child device — update this with your ADB serial)

Always use `adb install -r` — **never uninstall** (preserves Hyperbee data).

**UI-only changes** (`src/ui/`):
```bash
npm run build:ui
cd android && ./gradlew assembleDebug && cd ..
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**bare.js changes** (also rebuild UI after):
```bash
npm run build:bare
npm run build:ui
cd android && ./gradlew assembleDebug && cd ..
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

**Native changes** (Java/Kotlin):
```bash
cd android && ./gradlew assembleDebug && cd ..
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

## Architecture

### Three-Layer Runtime

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
└─────────────────────────────────────────┘
```

### IPC Message Flow

All cross-layer calls are JSON-over-newline, dispatched by `method` name:

- **WebView → RN**: `window.ReactNativeWebView.postMessage(JSON.stringify({ id, method, args }))`
- **RN → Bare worklet**: `_worklet.IPC.write(b4a.from(JSON.stringify(msg) + '\n'))`
- **Bare → RN**: `BareKit.IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))`
- **RN → WebView**: `webViewRef.current.injectJavaScript('window.__pearResponse(...); true;')`
- **RN → WebView (events)**: `webViewRef.current.injectJavaScript('window.__pearEvent("name", data); true;')`

### Key Source Files

| File | Role |
|------|------|
| `app/index.tsx` | RN shell: loads bundles, starts worklet, owns all IPC routing |
| `app/join.tsx` | Handles `pearguard://join/...` deep link invite URLs |
| `app/setup.tsx` | First-launch mode selection screen |
| `src/bare.js` | Bare worklet: Hyperswarm, signing, Hyperbee, all data logic |
| `src/identity.js` | Keypair generation and sign/verify helpers (sodium-native) |
| `src/invite.js` | Invite link builder/parser |
| `src/ui/main.jsx` | WebView bootstrap: sets up IPC bridge globals, renders `<App>` |
| `src/ui/App.jsx` | Full React UI (runs inside the WebView) |

### Hyperbee Keys

| Key | Value |
|-----|-------|
| `identity` | `{ publicKey: hex, secretKey: hex }` |
| `mode` | `'parent'` or `'child'` |
| `peers:{publicKey}` | `{ publicKey: hex, displayName: string, pairedAt: number }` |
| `policy` | Latest received policy snapshot (child only) |

## Branch Strategy

Always create a branch before starting work — never commit directly to master.
- Feature branches: `feature/description`
- Bug fix branches: `bugfix/description`
- Merge via GitHub PR: `gh pr merge N --merge`
- After merge: `git checkout master && git pull origin master`

## Testing

Pure logic (identity, invite encode/decode, message signing) uses jest:
```bash
npx jest
```

IPC round-trips and Hyperswarm connections require a physical Android device.
