# In-App QR Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app QR code scanner to the child's Profile page so pairing works without relying on Android deep links.

**Architecture:** A new `qr:scan` IPC method is handled directly in the RN shell (`app/index.tsx`) — identical to how `share:text` works. It opens a full-screen `Modal` with `expo-camera`'s `CameraView`. When a QR code is scanned, the IPC promise resolves with the URL string; the WebView's `Profile.jsx` then calls `acceptInvite` directly.

**Tech Stack:** expo-camera (SDK 54 compatible, `~17.0.x`), React Native Modal, expo-camera `CameraView` + `useCameraPermissions`, React Testing Library (existing).

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Add `expo-camera` dependency |
| `app/index.tsx` | Modify | Add `showScanner` state, `scanResolve`/`scanReject` refs, `qr:scan` IPC branch, `ScannerModal` component |
| `src/ui/components/Profile.jsx` | Modify | Add "Parents" section (child mode only) with pair button and `pairState` machine |
| `src/ui/components/__tests__/Profile.test.jsx` | Create | Unit tests for the new Parents section |

No changes to `src/bare.js`, `src/bare-dispatch.js`, `src/invite.js`, or `app/join.tsx`.

---

## Task 1: Install expo-camera

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the package**

```bash
cd /home/tim/peerloomllc/pearguard
npx expo install expo-camera
```

Expected: `package.json` gains `"expo-camera": "~17.0.x"` (exact patch may vary). No errors.

- [ ] **Step 2: Verify the install**

```bash
node -e "console.log(require('./node_modules/expo-camera/package.json').version)"
```

Expected: prints a version like `17.0.x`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add expo-camera for in-app QR scanning"
```

---

## Task 2: Add `qr:scan` IPC handler and scanner modal to `app/index.tsx`

**Files:**
- Modify: `app/index.tsx`

No unit tests are possible for a native camera modal. Manual verification is in Task 4.

- [ ] **Step 1: Add imports**

Replace the existing React Native import line in `app/index.tsx`:

```tsx
// old:
import { View, StyleSheet, Platform, DeviceEventEmitter, NativeModules, StatusBar, Share } from 'react-native'

// new:
import { View, StyleSheet, Platform, DeviceEventEmitter, NativeModules, StatusBar, Share, Modal, Text, TouchableOpacity } from 'react-native'
```

Add a new import below the existing imports block:

```tsx
import { CameraView, useCameraPermissions } from 'expo-camera'
```

- [ ] **Step 2: Add ScannerModal component**

Add this component above the `Root` function in `app/index.tsx`:

```tsx
// ── Scanner modal ──────────────────────────────────────────────────────────────

function ScannerModal ({
  visible,
  onScanned,
  onCancel,
  onPermissionDenied,
}: {
  visible: boolean
  onScanned: (url: string) => void
  onCancel: () => void
  onPermissionDenied: () => void
}) {
  const [permission, requestPermission] = useCameraPermissions()
  const scanned = useRef(false)

  useEffect(() => {
    if (!visible) { scanned.current = false; return }
    if (!permission?.granted) {
      requestPermission().then(result => {
        if (!result.granted) onPermissionDenied()
      })
    }
  }, [visible])

  function handleBarcode (result: any) {
    if (scanned.current) return
    scanned.current = true
    onScanned(result.data)
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      {permission?.granted ? (
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          onBarcodeScanned={handleBarcode}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        >
          <View style={scannerStyles.overlay}>
            <TouchableOpacity style={scannerStyles.cancelBtn} onPress={onCancel}>
              <Text style={scannerStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </CameraView>
      ) : (
        <View style={scannerStyles.waiting}>
          <Text style={{ color: '#fff' }}>Requesting camera permission…</Text>
        </View>
      )}
    </Modal>
  )
}

const scannerStyles = StyleSheet.create({
  overlay:    { flex: 1, justifyContent: 'flex-end', padding: 32 },
  cancelBtn:  { backgroundColor: 'rgba(0,0,0,0.65)', padding: 16, borderRadius: 8, alignItems: 'center' },
  cancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  waiting:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
})
```

- [ ] **Step 3: Add state and refs to the Root component**

Inside the `Root` function, after the existing `const webViewRef = useRef...` line, add:

```tsx
const [showScanner, setShowScanner] = useState(false)
const scanResolve = useRef<((url: string) => void) | null>(null)
const scanReject  = useRef<((reason: string) => void) | null>(null)
```

- [ ] **Step 4: Add `qr:scan` IPC handler**

Inside `onWebViewMessage`, add a new branch **before** the `// Forward everything else to Bare` comment (alongside the existing `share:text` and `navigateTo` branches):

```tsx
if (msg.method === 'qr:scan') {
  const msgId = msg.id
  scanResolve.current = (url: string) => {
    setShowScanner(false)
    webViewRef.current?.injectJavaScript(
      'window.__pearResponse(' + msgId + ', ' + JSON.stringify(url) + ', null);true;'
    )
  }
  scanReject.current = (reason: string) => {
    setShowScanner(false)
    webViewRef.current?.injectJavaScript(
      'window.__pearResponse(' + msgId + ', null, ' + JSON.stringify(reason) + ');true;'
    )
  }
  setShowScanner(true)
  return
}
```

- [ ] **Step 5: Render the ScannerModal**

In the Root component's return JSX, add `ScannerModal` just before the closing `</View>`:

```tsx
<ScannerModal
  visible={showScanner}
  onScanned={(url) => scanResolve.current?.(url)}
  onCancel={() => scanReject.current?.('cancelled')}
  onPermissionDenied={() => scanReject.current?.('Camera permission denied. Please enable in Settings.')}
/>
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd /home/tim/peerloomllc/pearguard
npx tsc --noEmit
```

Expected: no errors. Fix any type errors before continuing.

- [ ] **Step 7: Commit**

```bash
git add app/index.tsx
git commit -m "feat: add qr:scan IPC handler and ScannerModal to RN shell"
```

---

## Task 3: Add Parents section to Profile.jsx (child mode)

**Files:**
- Modify: `src/ui/components/Profile.jsx`
- Create: `src/ui/components/__tests__/Profile.test.jsx`

- [ ] **Step 1: Write the failing tests**

Create `src/ui/components/__tests__/Profile.test.jsx`:

```jsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Profile from '../Profile.jsx';

beforeEach(() => {
  window.callBare = jest.fn().mockResolvedValue({});
});

// ── Parent mode ───────────────────────────────────────────────────────────────

test('parent mode: does not show Pair to Parent button', () => {
  render(<Profile mode="parent" />);
  expect(screen.queryByText(/pair to parent/i)).not.toBeInTheDocument();
});

// ── Child mode — idle state ───────────────────────────────────────────────────

test('child mode: shows Pair to Parent button', () => {
  render(<Profile mode="child" />);
  expect(screen.getByText(/pair to parent/i)).toBeInTheDocument();
});

// ── Child mode — happy path ───────────────────────────────────────────────────

test('child mode: calls qr:scan then acceptInvite on button press', async () => {
  window.callBare = jest.fn()
    .mockResolvedValueOnce('pear://pearguard/join?t=abc123') // qr:scan
    .mockResolvedValueOnce({});                              // acceptInvite

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  await waitFor(() => {
    expect(window.callBare).toHaveBeenCalledWith('qr:scan');
    expect(window.callBare).toHaveBeenCalledWith('acceptInvite', ['pear://pearguard/join?t=abc123']);
  });
  expect(await screen.findByText(/paired!/i)).toBeInTheDocument();
});

test('child mode: shows connecting state after scan, while acceptInvite is pending', async () => {
  let resolveAccept;
  window.callBare = jest.fn()
    .mockResolvedValueOnce('pear://pearguard/join?t=abc123') // qr:scan resolves immediately
    .mockImplementationOnce(() => new Promise(res => { resolveAccept = res; })); // acceptInvite hangs

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  // connecting appears only after qr:scan resolves and acceptInvite is pending
  expect(await screen.findByText(/connecting to parent/i)).toBeInTheDocument();
  resolveAccept({});
  expect(await screen.findByText(/paired!/i)).toBeInTheDocument();
});

// ── Child mode — cancel ───────────────────────────────────────────────────────

test('child mode: cancel returns to idle silently', async () => {
  window.callBare = jest.fn().mockRejectedValueOnce(new Error('cancelled'));

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  expect(await screen.findByText(/pair to parent/i)).toBeInTheDocument();
  expect(screen.queryByText(/cancelled/i)).not.toBeInTheDocument();
});

// ── Child mode — error ────────────────────────────────────────────────────────

test('child mode: non-cancel error shows message and retry button', async () => {
  window.callBare = jest.fn().mockRejectedValueOnce(new Error('invalid invite'));

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  expect(await screen.findByText(/invalid invite/i)).toBeInTheDocument();
  expect(screen.getByText(/try again/i)).toBeInTheDocument();
});

test('child mode: Try Again resets to idle', async () => {
  window.callBare = jest.fn().mockRejectedValueOnce(new Error('invalid invite'));

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));
  await screen.findByText(/try again/i);

  fireEvent.click(screen.getByText(/try again/i));
  expect(screen.getByText(/pair to parent/i)).toBeInTheDocument();
});

test('child mode: permission denied shows error message', async () => {
  window.callBare = jest.fn().mockRejectedValueOnce(
    new Error('Camera permission denied. Please enable in Settings.')
  );

  render(<Profile mode="child" />);
  fireEvent.click(screen.getByText(/pair to parent/i));

  expect(await screen.findByText(/camera permission denied/i)).toBeInTheDocument();
  expect(screen.getByText(/try again/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/tim/peerloomllc/pearguard
npx jest src/ui/components/__tests__/Profile.test.jsx --no-coverage
```

Expected: all tests FAIL (Profile has no Parents section yet).

- [ ] **Step 3: Implement the Parents section in Profile.jsx**

Add the following state and handler inside the `Profile` component function, after the existing state declarations:

```jsx
const [pairState, setPairState] = useState('idle') // 'idle' | 'connecting' | 'success' | 'error'
const [pairError, setPairError] = useState(null)

async function handlePair() {
  setPairError(null)
  try {
    const url = await window.callBare('qr:scan')  // camera opens natively; wait for scan
    setPairState('connecting')                      // show connecting only after scan
    await window.callBare('acceptInvite', [url])
    setPairState('success')
  } catch (e) {
    if (e.message === 'cancelled') {
      setPairState('idle')
    } else {
      setPairState('error')
      setPairError(e.message)
    }
  }
}
```

Add this section to the JSX, after the closing `</div>` of the name `field` div, still inside the outer container — but only when `mode === 'child'`:

```jsx
{mode === 'child' && (
  <div style={styles.section}>
    <h3 style={styles.sectionHeading}>Parents</h3>

    {pairState === 'idle' && (
      <button style={styles.btn} onClick={handlePair}>
        Pair to Parent
      </button>
    )}

    {pairState === 'connecting' && (
      <p style={styles.hint}>Connecting to parent…</p>
    )}

    {pairState === 'success' && (
      <p style={styles.success}>Paired! Waiting for parent to confirm…</p>
    )}

    {pairState === 'error' && (
      <>
        <p style={styles.error}>{pairError}</p>
        <button style={styles.btn} onClick={() => setPairState('idle')}>
          Try Again
        </button>
      </>
    )}
  </div>
)}
```

Add these style entries to the `styles` object (`section`, `sectionHeading`, and `hint` — `success` and `error` already exist):

```jsx
section:        { marginTop: '32px' },
sectionHeading: { fontSize: '16px', fontWeight: '600', marginBottom: '12px', color: '#333' },
hint:           { color: '#888', fontSize: '14px' },
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest src/ui/components/__tests__/Profile.test.jsx --no-coverage
```

Expected: all 8 tests PASS.

- [ ] **Step 5: Run the full test suite to check for regressions**

```bash
npx jest --no-coverage
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/Profile.jsx src/ui/components/__tests__/Profile.test.jsx
git commit -m "feat: add Parents section with Pair to Parent button to child Profile"
```

---

## Task 4: Build and install on both devices

**Files:** none (build only)

- [ ] **Step 1: Build all bundles and APK**

```bash
cd /home/tim/peerloomllc/pearguard
npm run build:bare && npm run build:ui
cd android && ./gradlew assembleDebug 2>&1 | tail -5
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 2: Install on both devices**

```bash
adb -s 53071FDAP00038 install -r /home/tim/peerloomllc/pearguard/android/app/build/outputs/apk/debug/app-debug.apk &
adb -s 4H65K7MFZXSCSWPR install -r /home/tim/peerloomllc/pearguard/android/app/build/outputs/apk/debug/app-debug.apk
```

Expected: `Success` for both.

- [ ] **Step 3: Manual smoke test**

Follow the manual test plan from the spec:
1. Child device: Profile tab → "Pair to Parent" → camera opens
2. Scan parent's QR code shown in AddChildFlow → child shows "Connecting to parent…" → "Paired!"
3. Parent's AddChildFlow shows the child in the children list
4. Re-test cancel: scan screen opens → tap Cancel → returns to idle, no error shown
5. Re-test permission deny: revoke camera permission in Android Settings → tap "Pair to Parent" → shows "Camera permission denied. Please enable in Settings." error with Try Again button
6. Scan a non-PearGuard QR → error message + "Try Again" button shown
