# In-App QR Pairing — Design Spec
_Date: 2026-03-20_

## Problem

The deep-link pairing flow (`pear://pearguard/join?t=…` → `join.tsx`) is unreliable:
timing races between the Bare worklet initialising and the invite URL arriving cause
`acceptInvite` to be silently dropped. Replacing it with an in-app camera scanner
removes the deep-link path entirely and calls `acceptInvite` directly once the worklet
is guaranteed ready.

---

## Scope

- Add `expo-camera` to the project (`npx expo install expo-camera`)
- Add a `qr:scan` IPC handler in the RN shell (`app/index.tsx`)
- Add a "Parents" section with a "Pair to Parent" button to `Profile.jsx` (child mode only)
- Leave `join.tsx` and the deep-link flow intact (harmless fallback)

Out of scope: persistent paired-parent list, parent confirmation UI, removing the old
deep-link flow.

---

## Architecture

### New IPC method: `qr:scan`

Handled directly in `app/index.tsx`, alongside the existing `share:text` handler.
Not forwarded to Bare.

**Flow:**
1. WebView calls `window.callBare('qr:scan')`
2. RN sets `scanResolve` and `scanReject` refs and sets `showScanner: true`
3. A full-screen `Modal` renders with `expo-camera`'s `CameraView` and `useCameraPermissions`:
   - If permission denied: call `scanReject('Camera permission denied')`, close modal
   - On barcode detected via `onBarcodeScanned={(e) => …}`: use `e.data` as the URL string,
     close modal, call `scanResolve(url)` — resolves with the URL string directly
   - Set `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}` to restrict to QR codes only
   - Cancel button: call `scanReject('cancelled')`, close modal
4. IPC response flows back to WebView via the normal `__pearResponse` path

**State held in the Root component:**
```
showScanner: boolean
scanResolve: ((url: string) => void) | null
scanReject:  ((reason: string) => void) | null
```

### Profile page — child mode additions

New "Parents" section rendered below the name field when `mode === 'child'`.

**UI states:**
| State | Display |
|---|---|
| `idle` | "Pair to Parent" button |
| `connecting` | Spinner + "Connecting to parent…" |
| `success` | "Paired! Waiting for parent to confirm…" |
| `error` | Error message + "Try Again" button |

**Logic:**
```
handlePair():
  1. url = await callBare('qr:scan')       // resolves with URL string
  2. setState('connecting')
  3. await callBare('acceptInvite', [url]) // args[0] = url, consistent with bare-dispatch
  4. setState('success')
  catch 'cancelled' → setState('idle')  // silent, no error shown
  catch other error → setState('error', error.message)
```

Note: `callBare('acceptInvite', [url])` passes an array as `args`. This is consistent with
how `bare-dispatch.js` accesses `args[0]` for `acceptInvite`. The `window.callBare`
implementation in `main.jsx` passes args as-is when truthy, so arrays serialize correctly.

---

## Files Changed

| File | Change |
|---|---|
| `package.json` | Add `expo-camera` (via `npx expo install expo-camera`) |
| `app/index.tsx` | Add `showScanner` state, `scanResolve`/`scanReject` refs, `qr:scan` IPC handler, `Modal` + `CameraView` JSX |
| `src/ui/components/Profile.jsx` | Add "Parents" section (child mode only) with pair button and states |

No changes to `src/bare.js`, `src/bare-dispatch.js`, `src/invite.js`, or `app/join.tsx`.

---

## Permissions

`CAMERA` permission is requested at scan time via `expo-camera`'s `useCameraPermissions` hook.
No changes to `AndroidManifest.xml` needed — `expo-camera` uses a config plugin that patches
the manifest automatically during the Gradle build.

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| Camera permission denied | Profile shows "Camera permission denied. Please enable in Settings." |
| User cancels scan | Profile returns to idle silently |
| Invalid QR (not a pearguard invite) | `acceptInvite` rejects → Profile shows error message |
| Worklet not ready | Impossible — `callBare` is only available after `dbReady = true` |

---

## Testing

Unit tests are not applicable for the camera modal (native hardware).

Manual test plan:
1. Child device: Profile tab → "Pair to Parent" → camera opens
2. Scan parent's QR code shown in AddChildFlow
3. Child shows "Connecting to parent…" then "Paired! Waiting for parent to confirm…"
4. Parent's AddChildFlow shows the child appearing in the children list
5. Cancel mid-scan → returns to idle with no error shown
6. Deny camera permission → "Camera permission denied. Please enable in Settings." shown
7. Scan a non-PearGuard QR code → error message shown, "Try Again" button appears
