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

- Add `expo-camera` to the project
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
2. RN sets a `scanResolve` ref and renders a full-screen `Modal`
3. Modal contains `expo-camera` `CameraView` with `useCameraPermissions`
   - If permission denied: reject with `'Camera permission denied'`
   - On barcode detected: close modal, resolve with `{ url: scannedString }`
   - Cancel button: close modal, reject with `'cancelled'`
4. IPC response flows back to WebView as normal

**State held in the Root component:**
```
scanResolve: ((result: any) => void) | null
showScanner: boolean
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
  1. result = await callBare('qr:scan')        // camera opens natively
  2. setState('connecting')
  3. await callBare('acceptInvite', [result.url])
  4. setState('success')
  catch 'cancelled' → setState('idle')
  catch other error → setState('error', message)
```

---

## Files Changed

| File | Change |
|---|---|
| `package.json` | Add `expo-camera` |
| `app/index.tsx` | Add `showScanner` state, `scanResolve` ref, `qr:scan` IPC handler, `Modal` + `CameraView` JSX |
| `src/ui/components/Profile.jsx` | Add "Parents" section (child mode only) with pair button and states |

No changes to `src/bare.js`, `src/bare-dispatch.js`, or `src/invite.js`.

---

## Permissions

`CAMERA` permission is requested at scan time via `expo-camera`'s `useCameraPermissions` hook.
No changes to `AndroidManifest.xml` needed — `expo-camera` auto-patches it via Expo config plugins.

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
1. Child device: Profile → "Pair to Parent" → camera opens
2. Scan parent's QR code in AddChildFlow
3. Child shows "Connecting…" then "Paired!"
4. Parent's AddChildFlow shows the child in the children list
5. Cancel mid-scan → returns to idle
6. Deny camera permission → clear error message shown
