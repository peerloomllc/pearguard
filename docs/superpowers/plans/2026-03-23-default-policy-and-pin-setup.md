# Default Policy + Required PIN Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix initial app pairing so all apps are `allowed` by default (TODO #30), and require parents to set an override PIN before reaching the dashboard (TODO #31).

**Architecture:** Three changes — (1) one-line status fix + policy push refactor in `bare-dispatch.js`, (2) a new `pin:isSet` dispatch method, (3) a PIN step added to the native `setup.tsx` first-launch screen, and (4) a PIN gate added to `ParentApp.jsx` for existing parents. No new files needed.

**Tech Stack:** Jest (bare-dispatch unit tests), React Testing Library / jsdom (WebView UI tests), React Native (setup.tsx — no test harness exists for RN components in this project)

---

## File Map

| File | Change |
|------|--------|
| `src/bare-dispatch.js` | Change first-sync default from `'pending'` to `'allowed'`; move `sendToPeer` outside `!isFirstSync` guard; add `pin:isSet` case |
| `tests/bare-dispatch.test.js` | Update first-sync test assertions; add `pin:isSet` describe block |
| `src/ui/components/ParentApp.jsx` | Add `pinCheckState` + PIN setup overlay on mount |
| `src/ui/components/__tests__/ParentApp.test.jsx` | Update `beforeEach` mock + add PIN gate tests |
| `app/setup.tsx` | Add `step` state + PIN entry view; update `_callBare` / `setBareCaller` types |

---

## Task 1: handleIncomingAppsSync — allowed default + unconditional policy push

**Files:**
- Modify: `src/bare-dispatch.js:822-861`
- Modify: `tests/bare-dispatch.test.js` (handleIncomingAppsSync describe block)

- [ ] **Step 1: Update the first-sync test to assert the new behavior**

In `tests/bare-dispatch.test.js`, find the test `'first sync: saves policy but suppresses app:installed events and alert entries'` and add:
- A `mockSendToPeer` argument
- Assertion that `mockSendToPeer` was called with the correct noise key and a `policy:update` message
- Assertion that the saved app has `status: 'allowed'`

Replace the test:

```js
test('first sync: apps get status allowed, policy:update sent to child, events suppressed', async () => {
  const mockDb = makeMockDb({ 'peers:childpk1': { noiseKey: 'noise-abc' } }) // no prior policy
  const mockSend = jest.fn()
  const mockSendToPeer = jest.fn()

  await handleIncomingAppsSync(
    { apps: [{ packageName: 'com.example.app', appName: 'Example' }] },
    'childpk1', mockDb, mockSend, mockSendToPeer
  )

  // Policy written with status 'allowed' (not 'pending')
  expect(mockDb.put).toHaveBeenCalledWith('policy:childpk1', expect.objectContaining({
    apps: expect.objectContaining({
      'com.example.app': expect.objectContaining({ status: 'allowed' }),
    }),
  }))

  // Policy pushed to child on first sync
  expect(mockSendToPeer).toHaveBeenCalledWith('noise-abc', expect.objectContaining({ type: 'policy:update' }))

  // Alert entries suppressed
  const alertPuts = mockDb.put.mock.calls.filter(([k]) => k.startsWith('alert:'))
  expect(alertPuts).toHaveLength(0)

  // app:installed events suppressed
  const appInstalledEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')
  expect(appInstalledEvents).toHaveLength(0)

  // apps:synced still fires
  const syncedEvents = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'apps:synced')
  expect(syncedEvents).toHaveLength(1)
})
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /home/tim/peerloomllc/pearguard
npx jest tests/bare-dispatch.test.js --testNamePattern="first sync" -t "first sync"
```

Expected: FAIL — `status: 'pending'` instead of `'allowed'`, and `mockSendToPeer` not called.

- [ ] **Step 3: Implement the changes in bare-dispatch.js**

In `handleIncomingAppsSync`, make two changes:

**Change 1** — line 824, inside the `for` loop: change the hardcoded `'pending'` to a conditional:

```js
// Before:
policy.apps[packageName] = { status: 'pending', appName: appName || packageName, addedAt: batchAddedAt }

// After:
policy.apps[packageName] = { status: isFirstSync ? 'allowed' : 'pending', appName: appName || packageName, addedAt: batchAddedAt }
```

**Change 2** — inside `if (newCount > 0)`, move the `sendToPeer` block from inside `if (!isFirstSync)` to before it. The result should look like:

```js
if (newCount > 0) {
  policy.version = (policy.version || 0) + 1
  await db.put('policy:' + childPublicKey, policy)

  // Push policy to child on every sync (first AND incremental) so the child
  // immediately receives the allowed/pending status for new apps.
  if (sendToPeer) {
    try {
      const peerRec = await db.get('peers:' + childPublicKey).catch(() => null)
      const noiseKey = peerRec && peerRec.value && peerRec.value.noiseKey
      if (noiseKey) sendToPeer(noiseKey, { type: 'policy:update', payload: policy })
    } catch (_e) {}
  }

  // On first sync only suppress per-app alert entries and app:installed events.
  if (!isFirstSync) {
    for (const { packageName, appName } of newApps) {
      const now = Date.now()
      const alertEntry = {
        id: 'app_installed:' + now + ':' + packageName,
        type: 'app_installed',
        timestamp: now,
        packageName,
        appDisplayName: appName,
        childPublicKey,
        childDisplayName,
      }
      await db.put('alert:' + childPublicKey + ':' + now + ':' + packageName, alertEntry)
      send({ type: 'event', event: 'app:installed', data: { packageName, appName, childPublicKey, childDisplayName } })
    }
  }

  send({ type: 'event', event: 'apps:synced', data: { childPublicKey, totalApps: Object.keys(policy.apps).length } })
}
```

- [ ] **Step 4: Run the handleIncomingAppsSync tests to confirm they pass**

```bash
npx jest tests/bare-dispatch.test.js --testPathPattern="bare-dispatch" -t "handleIncomingAppsSync"
```

Expected: all 3 tests PASS.

- [ ] **Step 5: Run the full test suite to confirm nothing is broken**

```bash
npx jest tests/bare-dispatch.test.js src/ui/components/__tests__/
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/bare-dispatch.js tests/bare-dispatch.test.js
git commit -m "fix: TODO #30 — first-sync apps default to allowed; policy pushed to child unconditionally"
```

---

## Task 2: pin:isSet dispatch method

**Files:**
- Modify: `src/bare-dispatch.js` (add case after `pin:verify`)
- Modify: `tests/bare-dispatch.test.js` (add `pin:isSet` describe block)

- [ ] **Step 1: Write the failing tests**

Find the `describe('bare dispatch', ...)` block in `tests/bare-dispatch.test.js`. Add a new `describe('pin:isSet', ...)` block. A good place is after the existing `pin:set` / `pin:verify` tests. Use the same `createDispatch` pattern used throughout the file.

```js
describe('pin:isSet', () => {
  function makeMockDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      createReadStream: jest.fn(async function * () {}),
    }
  }

  test('returns { isSet: true } when pinHash is stored in policy', async () => {
    const mockDb = makeMockDb({ policy: { pinHash: '$argon2id$...' } })
    const ctx = { db: mockDb, send: jest.fn() }
    const dispatch = createDispatch(ctx)

    const result = await dispatch('pin:isSet', {})
    expect(result).toEqual({ isSet: true })
  })

  test('returns { isSet: false } when policy exists but has no pinHash', async () => {
    const mockDb = makeMockDb({ policy: { apps: {} } })
    const ctx = { db: mockDb, send: jest.fn() }
    const dispatch = createDispatch(ctx)

    const result = await dispatch('pin:isSet', {})
    expect(result).toEqual({ isSet: false })
  })

  test('returns { isSet: false } when no policy key exists at all', async () => {
    const mockDb = makeMockDb({}) // empty DB
    const ctx = { db: mockDb, send: jest.fn() }
    const dispatch = createDispatch(ctx)

    const result = await dispatch('pin:isSet', {})
    expect(result).toEqual({ isSet: false })
  })
})
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
npx jest tests/bare-dispatch.test.js -t "pin:isSet"
```

Expected: FAIL with `unknown method: pin:isSet`.

- [ ] **Step 3: Add the pin:isSet case to bare-dispatch.js**

Find the `pin:verify` case and add the new case directly after it:

```js
case 'pin:isSet': {
  // Reads the parent's own 'policy' key — NOT a per-child 'policy:{childPK}' key.
  // pin:set stores pinHash here (ctx.db.put('policy', policy)).
  // valueEncoding: 'json' means raw.value is already a parsed JS object.
  const raw = await ctx.db.get('policy')
  return { isSet: !!(raw && raw.value && raw.value.pinHash) }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest tests/bare-dispatch.test.js -t "pin:isSet"
```

Expected: 3 tests PASS.

- [ ] **Step 5: Run full suite**

```bash
npx jest tests/bare-dispatch.test.js src/ui/components/__tests__/
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/bare-dispatch.js tests/bare-dispatch.test.js
git commit -m "feat: add pin:isSet bare dispatch method"
```

---

## Task 3: ParentApp.jsx — PIN gate for existing parents

**Files:**
- Modify: `src/ui/components/ParentApp.jsx`
- Modify: `src/ui/components/__tests__/ParentApp.test.jsx`

- [ ] **Step 1: Update beforeEach in ParentApp.test.jsx to handle pin:isSet**

The existing `beforeEach` mocks all `callBare` calls to resolve `{}`. After adding the PIN gate, `ParentApp` will call `pin:isSet` on mount and receive `{}` → `isSet: undefined` → shows PIN overlay instead of dashboard. This breaks all existing tests.

Update `beforeEach`:

```js
beforeEach(() => {
  window.callBare = jest.fn().mockImplementation((method) => {
    if (method === 'pin:isSet') return Promise.resolve({ isSet: true });
    return Promise.resolve({});
  });
  window.onBareEvent = jest.fn().mockReturnValue(() => {});
});
```

- [ ] **Step 2: Add new PIN gate tests**

Add these tests to `ParentApp.test.jsx`:

```js
test('shows loading state while pin:isSet is pending', () => {
  let resolvePinCheck;
  window.callBare = jest.fn().mockImplementation((method) => {
    if (method === 'pin:isSet') return new Promise((resolve) => { resolvePinCheck = resolve; });
    return Promise.resolve({});
  });
  render(<ParentApp />);
  expect(screen.getByText(/checking/i)).toBeInTheDocument();
  expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
});

test('shows PIN setup overlay when pin:isSet returns false', async () => {
  window.callBare = jest.fn().mockImplementation((method) => {
    if (method === 'pin:isSet') return Promise.resolve({ isSet: false });
    return Promise.resolve({});
  });
  render(<ParentApp />);
  await waitFor(() => {
    expect(screen.getByLabelText('Set PIN')).toBeInTheDocument();
    expect(screen.getByLabelText('Confirm PIN')).toBeInTheDocument();
  });
  expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
});

test('dismisses PIN overlay and shows dashboard after pin:set succeeds', async () => {
  window.callBare = jest.fn().mockImplementation((method) => {
    if (method === 'pin:isSet') return Promise.resolve({ isSet: false });
    return Promise.resolve({});
  });
  render(<ParentApp />);
  await waitFor(() => screen.getByLabelText('Set PIN'));

  fireEvent.change(screen.getByLabelText('Set PIN'), { target: { value: '1234' } });
  fireEvent.change(screen.getByLabelText('Confirm PIN'), { target: { value: '1234' } });
  fireEvent.click(screen.getByRole('button', { name: /save pin/i }));

  await waitFor(() => {
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });
});
```

Add `waitFor` to the import at the top of the test file.

- [ ] **Step 3: Run the new tests to confirm they fail**

```bash
npx jest src/ui/components/__tests__/ParentApp.test.jsx
```

Expected: the 3 new tests FAIL (component doesn't have the gate yet), existing tests may also fail if `pin:isSet` isn't handled yet.

- [ ] **Step 4: Implement the PIN gate in ParentApp.jsx**

Replace the entire `ParentApp.jsx` with:

```jsx
import React, { useState, useEffect } from 'react';
import Dashboard from './Dashboard.jsx';
import ChildrenList from './ChildrenList.jsx';
import Settings from './Settings.jsx';
import Profile from './Profile.jsx';

const ParentProfile = () => <Profile mode="parent" />;

const TABS = [
  { key: 'dashboard', label: 'Dashboard', Component: Dashboard },
  { key: 'children', label: 'Children', Component: ChildrenList },
  { key: 'settings', label: 'Settings', Component: Settings },
  { key: 'profile', label: 'Profile', Component: ParentProfile },
];

function PinSetupOverlay({ onDone }) {
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState(null);

  function handleSubmit(e) {
    e.preventDefault();
    if (pin.length < 4) { setError('PIN must be at least 4 digits.'); return; }
    if (!/^\d+$/.test(pin)) { setError('PIN must contain only digits.'); return; }
    if (pin !== confirmPin) { setError('PINs do not match.'); setConfirmPin(''); return; }
    setError(null);
    window.callBare('pin:set', { pin })
      .then(onDone)
      .catch((err) => setError(err.message || 'Failed to set PIN. Please try again.'));
  }

  return (
    <div style={styles.overlay}>
      <div style={styles.overlayCard}>
        <h2 style={styles.overlayTitle}>Set Override PIN</h2>
        <p style={styles.overlayHint}>
          Children enter this PIN on the block screen to request temporary access.
        </p>
        <form onSubmit={handleSubmit} style={styles.form}>
          <label style={styles.label}>
            Set PIN
            <input
              type="text"
              value={pin}
              onChange={(e) => { setPin(e.target.value); setError(null); }}
              placeholder="e.g. 1234"
              inputMode="numeric"
              style={styles.input}
              aria-label="Set PIN"
            />
          </label>
          <label style={styles.label}>
            Confirm PIN
            <input
              type="text"
              value={confirmPin}
              onChange={(e) => { setConfirmPin(e.target.value); setError(null); }}
              placeholder="Repeat PIN"
              inputMode="numeric"
              style={styles.input}
              aria-label="Confirm PIN"
            />
          </label>
          {error && <p style={styles.errorText} role="alert">{error}</p>}
          <button type="submit" style={styles.submitBtn} aria-label="Save PIN">
            Save PIN
          </button>
        </form>
      </div>
    </div>
  );
}

export default function ParentApp() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [pairedName, setPairedName] = useState(null);
  const [pinCheckState, setPinCheckState] = useState('loading'); // 'loading' | 'needed' | 'done'

  useEffect(() => {
    window.callBare('pin:isSet', {})
      .then(({ isSet }) => setPinCheckState(isSet ? 'done' : 'needed'))
      .catch(() => setPinCheckState('needed'));
  }, []);

  useEffect(() => {
    const unsub = window.onBareEvent('child:connected', (data) => {
      setPairedName(data?.displayName || 'Child');
      setTimeout(() => {
        setPairedName(null);
        setActiveTab('dashboard');
      }, 3000);
    });
    return unsub;
  }, []);

  if (pinCheckState === 'loading') {
    return <div style={styles.checking}>Checking...</div>;
  }

  if (pinCheckState === 'needed') {
    return <PinSetupOverlay onDone={() => setPinCheckState('done')} />;
  }

  const active = TABS.find((t) => t.key === activeTab);
  const ActiveComponent = active.Component;

  return (
    <div style={styles.container}>
      {pairedName && (
        <div style={styles.banner}>Successfully paired with {pairedName}!</div>
      )}
      <div style={styles.content}>
        <ActiveComponent />
      </div>
      <nav style={styles.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            style={{
              ...styles.tabButton,
              ...(activeTab === tab.key ? styles.tabActive : styles.tabInactive),
            }}
            aria-selected={activeTab === tab.key}
            role="tab"
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex', flexDirection: 'column', height: '100vh',
    fontFamily: 'sans-serif', backgroundColor: '#fff',
  },
  checking: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#888', fontSize: '14px' },
  overlay: {
    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: '#111', display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '24px',
  },
  overlayCard: {
    backgroundColor: '#1a1a1a', borderRadius: '16px', padding: '32px',
    width: '100%', maxWidth: '360px', border: '1px solid #333',
  },
  overlayTitle: { color: '#fff', fontSize: '22px', fontWeight: '700', marginBottom: '8px' },
  overlayHint: { color: '#888', fontSize: '13px', marginBottom: '24px' },
  form: { display: 'flex', flexDirection: 'column', gap: '16px' },
  label: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '14px', color: '#aaa' },
  input: {
    padding: '12px', border: '1px solid #444', borderRadius: '8px',
    fontSize: '16px', marginTop: '4px', backgroundColor: '#222', color: '#fff',
  },
  errorText: { color: '#ea4335', fontSize: '13px', margin: 0 },
  submitBtn: {
    padding: '14px', border: 'none', borderRadius: '8px',
    backgroundColor: '#6FCF97', color: '#111', cursor: 'pointer',
    fontSize: '16px', fontWeight: '700',
  },
  banner: {
    backgroundColor: '#e6f4ea', color: '#1e7e34', border: '1px solid #a8d5b5',
    padding: '12px 16px', fontSize: '14px', fontWeight: '500', textAlign: 'center',
    flexShrink: 0,
  },
  content: { flex: 1, overflowY: 'auto' },
  tabBar: { display: 'flex', borderTop: '1px solid #ddd', backgroundColor: '#fff' },
  tabButton: {
    flex: 1, padding: '12px 0', border: 'none', background: 'none',
    cursor: 'pointer', fontSize: '14px', fontWeight: '500',
  },
  tabActive: { color: '#1a73e8', borderTop: '2px solid #1a73e8' },
  tabInactive: { color: '#666' },
};
```

- [ ] **Step 5: Run the ParentApp tests**

```bash
npx jest src/ui/components/__tests__/ParentApp.test.jsx
```

Expected: all tests PASS including the 3 new ones.

- [ ] **Step 6: Run full suite**

```bash
npx jest tests/bare-dispatch.test.js src/ui/components/__tests__/
```

Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/ui/components/ParentApp.jsx src/ui/components/__tests__/ParentApp.test.jsx
git commit -m "feat: TODO #31 — Gate 2: PIN setup overlay for existing parents with no PIN stored"
```

---

## Task 4: setup.tsx — PIN step for new parents

**Files:**
- Modify: `app/setup.tsx`

> Note: No test harness exists for React Native components in this project (`app/*.tsx`). This task has no automated tests — verify manually on device.

- [ ] **Step 1: Update setup.tsx**

Replace the entire contents of `app/setup.tsx` with:

```tsx
// app/setup.tsx
//
// First-launch mode selection screen.
// Shown only when no mode is stored in Hyperbee (new device / fresh install).
// User taps "I'm a Parent" or "I'm a Child".
// Parent path: calls setMode then shows PIN setup step before navigating to /.
// Child path: calls setMode then navigates directly to /child-setup.

import { useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'

let _callBare: ((method: string, args: any) => Promise<any>) | null = null

/**
 * Called by app/index.tsx to inject the IPC caller into this screen.
 */
export function setBareCaller (fn: (method: string, args: any) => Promise<any>) {
  _callBare = fn
}

export default function SetupScreen () {
  const [step, setStep]           = useState<'mode' | 'pin'>('mode')
  const [loading, setLoading]     = useState(false)
  const [error, setError]         = useState<string | null>(null)
  const [pin, setPin]             = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const router = useRouter()

  async function selectMode (mode: 'parent' | 'child') {
    if (!_callBare) { setError('App not ready — please wait'); return }
    setLoading(true)
    try {
      await _callBare('setMode', [mode])
      if (mode === 'child') {
        router.replace('/child-setup')
      } else {
        setLoading(false)
        setStep('pin')
      }
    } catch (e: any) {
      setError(e.message)
      setLoading(false)
    }
  }

  async function handleSetPin () {
    if (!_callBare) return
    if (pin.length < 4) { setError('PIN must be at least 4 digits.'); return }
    if (!/^\d+$/.test(pin)) { setError('PIN must contain only digits.'); return }
    if (pin !== confirmPin) { setError('PINs do not match.'); setConfirmPin(''); return }
    setError(null)
    setLoading(true)
    try {
      await _callBare('pin:set', { pin })
      router.replace('/')
    } catch (e: any) {
      setError(e.message || 'Failed to set PIN. Please try again.')
      setLoading(false)
    }
  }

  if (step === 'pin') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Set Override PIN</Text>
        <Text style={styles.subtitle}>
          Children enter this PIN on the block screen to request temporary access.
          You can change it later in Settings.
        </Text>

        {error && <Text style={styles.error}>{error}</Text>}

        {loading ? (
          <ActivityIndicator color="#6FCF97" size="large" />
        ) : (
          <View style={styles.form}>
            <Text style={styles.label}>PIN (4+ digits)</Text>
            <TextInput
              style={styles.input}
              value={pin}
              onChangeText={(v) => { setPin(v); setError(null) }}
              placeholder="e.g. 1234"
              keyboardType="numeric"
              secureTextEntry
              maxLength={12}
            />
            <Text style={styles.label}>Confirm PIN</Text>
            <TextInput
              style={styles.input}
              value={confirmPin}
              onChangeText={(v) => { setConfirmPin(v); setError(null) }}
              placeholder="Repeat PIN"
              keyboardType="numeric"
              secureTextEntry
              maxLength={12}
            />
            <TouchableOpacity style={styles.btnSave} onPress={handleSetPin}>
              <Text style={styles.btnSaveText}>Save PIN</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to PearGuard</Text>
      <Text style={styles.subtitle}>How will you use this device?</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {loading ? (
        <ActivityIndicator color="#6FCF97" size="large" />
      ) : (
        <View style={styles.buttons}>
          <TouchableOpacity style={[styles.btn, styles.btnParent]} onPress={() => selectMode('parent')}>
            <Text style={styles.btnIcon}>👤</Text>
            <Text style={styles.btnTitle}>I'm a Parent</Text>
            <Text style={styles.btnSub}>Monitor and manage your child's device</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.btn, styles.btnChild]} onPress={() => selectMode('child')}>
            <Text style={styles.btnIcon}>🧒</Text>
            <Text style={styles.btnTitle}>I'm a Child</Text>
            <Text style={styles.btnSub}>This device will be monitored by a parent</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 32 },
  title:       { color: '#fff', fontSize: 26, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  subtitle:    { color: '#aaa', fontSize: 16, marginBottom: 40, textAlign: 'center' },
  error:       { color: '#EB5757', fontSize: 14, marginBottom: 16, textAlign: 'center' },
  buttons:     { width: '100%', gap: 16 },
  btn:         { borderRadius: 16, padding: 24, alignItems: 'center', gap: 6 },
  btnParent:   { backgroundColor: '#1a2e1a', borderWidth: 1, borderColor: '#6FCF97' },
  btnChild:    { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#7B9FEB' },
  btnIcon:     { fontSize: 32 },
  btnTitle:    { color: '#fff', fontSize: 18, fontWeight: '600' },
  btnSub:      { color: '#888', fontSize: 13, textAlign: 'center' },
  form:        { width: '100%', gap: 12 },
  label:       { color: '#aaa', fontSize: 14, marginBottom: 2 },
  input:       { backgroundColor: '#222', color: '#fff', borderRadius: 10, padding: 14, fontSize: 16, borderWidth: 1, borderColor: '#444', width: '100%' },
  btnSave:     { backgroundColor: '#6FCF97', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  btnSaveText: { color: '#111', fontSize: 17, fontWeight: '700' },
})
```

- [ ] **Step 2: Run the test suite to confirm nothing broke**

```bash
npx jest tests/bare-dispatch.test.js src/ui/components/__tests__/
```

Expected: all tests pass (no test covers `setup.tsx` — verify this step on device).

- [ ] **Step 3: Commit**

```bash
git add app/setup.tsx
git commit -m "feat: TODO #31 — Gate 1: PIN setup step in setup.tsx for new parents"
```

---

## Task 5: Build, install, and verify on device

- [ ] **Step 1: Build bundles and APK**

```bash
cd /home/tim/peerloomllc/pearguard
npm run build:bare && npm run build:ui
cd android && ./gradlew assembleDebug 2>&1 | tail -3
```

Expected: `BUILD SUCCESSFUL`

- [ ] **Step 2: Install on both devices**

```bash
adb -s 53071FDAP00038 install -r /home/tim/peerloomllc/pearguard/android/app/build/outputs/apk/debug/app-debug.apk
adb -s 4H65K7MFZXSCSWPR install -r /home/tim/peerloomllc/pearguard/android/app/build/outputs/apk/debug/app-debug.apk
```

Expected: `Success` on both.

- [ ] **Step 3: Verify on parent device (existing install — Gate 2)**

Open PearGuard on the parent device. Since no PIN is set yet:
- Should see "Checking..." briefly
- Then full-screen PIN setup overlay (dark background, "Set Override PIN" heading)
- Enter a mismatched PIN → should see "PINs do not match." with confirm field cleared
- Enter a short PIN → should see "PIN must be at least 4 digits."
- Enter matching valid PIN → should dismiss overlay and show the dashboard

- [ ] **Step 4: Verify on child device (fresh pairing — #30)**

Clear app data on child device (or use a fresh install). Pair with parent. After pairing, open apps on the child — they should open without the block overlay appearing (apps are `allowed` by default).

- [ ] **Step 5: Verify Gate 1 (new parent setup)**

Clear app data on parent device to trigger first-launch flow. Tap "I'm a Parent" — should transition to PIN step. Set a PIN — should navigate to the dashboard.
