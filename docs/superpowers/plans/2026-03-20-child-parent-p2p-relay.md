# Child→Parent P2P Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire up the child→parent P2P messaging pipeline so apps, time requests, usage reports, and heartbeats all reach the parent device; and add the missing parent-side bare dispatch handlers so the parent UI can read and update child policies.

**Architecture:** Four layers of change: (1) a new native `getInstalledPackages` method for the initial app sync; (2) `sendToParent` calls in existing bare-dispatch handlers that currently only emit locally; (3) new parent-side P2P message handlers in `handlePeerMessage`; (4) new parent-side bare-dispatch methods (`policy:get`, `app:decide`, `policy:update`) wired up by the AppsTab UI.  On child connect, the parent also pushes its stored policy down to the child so enforcement stays current.

**Tech Stack:** Android `PackageManager.getInstalledPackages()`, existing Hyperswarm/Hyperbee stack, `sendToPeer`/`sendToParent` already present in `src/bare.js`, Jest + RTL for unit tests.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `android/app/src/main/java/com/pearguard/UsageStatsModule.java` | Modify | Add `getInstalledPackages` `@ReactMethod` |
| `src/bare.js` | Modify | (a) Emit `apps:syncRequested` in `handleHello` (child side); (b) push stored policy to child in `handleHello` (parent side); (c) add `app:installed`, `time:request`, `usage:report`, `heartbeat` cases to `handlePeerMessage` |
| `src/bare-dispatch.js` | Modify | (a) Add `sendToParent` calls in `app:installed`, `time:request`, `usage:flush`, `heartbeat:send`; (b) add `policy:get`, `app:decide`, `policy:update` dispatch cases; (c) export `handleIncomingAppInstalled`, `handleIncomingTimeRequest` |
| `app/index.tsx` | Modify | Handle `apps:syncRequested` event: call `getInstalledPackages`, send each app as `app:installed` to worklet |
| `tests/bare-dispatch.test.js` | Modify | Add tests for new dispatch cases and new exported handlers; update `app:installed` test for `appName` field |

No new files needed.

---

## Task 1: Add `getInstalledPackages` to UsageStatsModule.java

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/UsageStatsModule.java`

No unit tests for native Java — verified by device in Task 6.

- [ ] **Step 1: Add the method**

In `UsageStatsModule.java`, add this method after `getDailyUsageAll` (around line 128):

```java
/**
 * Returns all user-installed (non-system) apps as an array of
 * { packageName: string, appName: string }.
 * Used by the bare worklet to sync the child's installed app list to the parent on pairing.
 */
@ReactMethod
public void getInstalledPackages(Promise promise) {
    PackageManager pm = reactContext.getPackageManager();
    List<ApplicationInfo> apps = pm.getInstalledApplications(PackageManager.GET_META_DATA);

    WritableArray result = Arguments.createArray();
    for (ApplicationInfo info : apps) {
        // Skip system apps — only user-installed
        if ((info.flags & ApplicationInfo.FLAG_SYSTEM) != 0) continue;
        // Skip PearGuard itself
        if (info.packageName.equals(reactContext.getPackageName())) continue;

        WritableMap item = Arguments.createMap();
        item.putString("packageName", info.packageName);
        item.putString("appName", pm.getApplicationLabel(info).toString());
        result.pushMap(item);
    }
    promise.resolve(result);
}
```

The required import `android.content.pm.ApplicationInfo` is already present (used in `getDailyUsageAll`). `List` is already imported too.

- [ ] **Step 2: Verify the file compiles**

```bash
cd /home/tim/peerloomllc/pearguard/android && ./gradlew compileDebugJavaWithJavac 2>&1 | tail -10
```

Expected: no errors (warnings are OK).

- [ ] **Step 3: Commit**

```bash
cd /home/tim/peerloomllc/pearguard
git add android/app/src/main/java/com/pearguard/UsageStatsModule.java
npx jest --no-coverage 2>&1 | tail -5
git commit -m "feat: add getInstalledPackages to UsageStatsModule"
```

Expected jest output: same pre-existing 5 suites failing, 0 new failures.

---

## Task 2: Wire initial app sync on pairing

**Files:**
- Modify: `src/bare.js` (emit `apps:syncRequested` in `handleHello`)
- Modify: `app/index.tsx` (handle event, call native, send apps to worklet)

No unit tests — these are IPC integration paths. Verified by device in Task 6.

- [ ] **Step 1: Emit `apps:syncRequested` in `handleHello` (child side)**

In `src/bare.js`, inside `handleHello`, find the child-side block (around line 341):

```js
  // If we're the child, check if this is our pending parent
  if (mode === 'child') {
    const pendingParent = await db.get('pendingParent').catch(() => null)
    if (pendingParent && pendingParent.value.publicKey === peerIdentityKeyHex) {
      await db.del('pendingParent').catch(() => {})
    }

    // Mark parent as connected and flush any queued messages
    peerConnected = true
    parentPeer = peers.get(remoteKeyHex)
    await flushPendingMessages(conn)
  }
```

Add one line after `flushPendingMessages(conn)`, so it becomes:

```js
  if (mode === 'child') {
    const pendingParent = await db.get('pendingParent').catch(() => null)
    if (pendingParent && pendingParent.value.publicKey === peerIdentityKeyHex) {
      await db.del('pendingParent').catch(() => {})
    }

    peerConnected = true
    parentPeer = peers.get(remoteKeyHex)
    await flushPendingMessages(conn)
    // Ask RN shell to scan installed apps and relay each as app:installed
    send({ type: 'event', event: 'apps:syncRequested', data: {} })
  }
```

- [ ] **Step 2: Handle `apps:syncRequested` in `app/index.tsx`**

In `app/index.tsx`, inside the `_worklet.IPC.on('data', ...)` handler, inside the `if (msg.type === 'event')` branch (around line 280), add a handler for `apps:syncRequested` alongside the existing forwarded events.

Currently the event branch looks like:
```tsx
if (msg.type === 'event') {
  // Forward Bare events to WebView
  webViewRef.current?.injectJavaScript(
    'window.__pearEvent(' + JSON.stringify(msg.event) + ',' + JSON.stringify(msg.data) + ');true;'
  )
  ;(_eventHandlers.get(msg.event) ?? []).forEach(fn => fn(msg.data))
}
```

Replace it with:
```tsx
if (msg.type === 'event') {
  // Handle apps:syncRequested locally — do NOT forward to WebView
  if (msg.event === 'apps:syncRequested') {
    NativeModules.UsageStatsModule?.getInstalledPackages?.()
      .then((apps: { packageName: string; appName: string }[]) => {
        for (const app of apps) {
          sendToWorklet({ method: 'app:installed', args: { packageName: app.packageName, appName: app.appName } })
        }
      })
      .catch((e: any) => console.warn('[RN] getInstalledPackages failed:', e))
    return
  }
  // Forward all other Bare events to WebView
  webViewRef.current?.injectJavaScript(
    'window.__pearEvent(' + JSON.stringify(msg.event) + ',' + JSON.stringify(msg.data) + ');true;'
  )
  ;(_eventHandlers.get(msg.event) ?? []).forEach(fn => fn(msg.data))
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd /home/tim/peerloomllc/pearguard && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 4: Run tests and commit**

```bash
npx jest --no-coverage 2>&1 | tail -5
git add src/bare.js app/index.tsx
git commit -m "feat: emit apps:syncRequested on child pairing and relay installed apps to worklet"
```

Expected: no new test failures.

---

## Task 3: Parent-side bare dispatch — `policy:get`, `app:decide`, `policy:update`

**Files:**
- Modify: `src/bare-dispatch.js`
- Modify: `tests/bare-dispatch.test.js`

These are the handlers the parent's `AppsTab.jsx` calls via `window.callBare(...)`.

- [ ] **Step 1: Write failing tests**

In `tests/bare-dispatch.test.js`, add a new describe block at the end (before the closing `})`):

```js
// ── Parent-side policy dispatch ─────────────────────────────────────────────

describe('policy:get', () => {
  function makeMockDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
    }
  }

  test('returns policy for known child', async () => {
    const policy = { apps: { 'com.example.app': { status: 'allowed' } }, childPublicKey: 'abc', version: 1 }
    const mockDb = makeMockDb({ 'policy:abc': policy })
    const dispatch = createDispatch({ db: mockDb })

    const result = await dispatch('policy:get', { childPublicKey: 'abc' })
    expect(result).toEqual(policy)
  })

  test('returns { apps: {} } for unknown child', async () => {
    const mockDb = makeMockDb({})
    const dispatch = createDispatch({ db: mockDb })

    const result = await dispatch('policy:get', { childPublicKey: 'unknown' })
    expect(result).toEqual({ apps: {} })
  })

  test('throws when childPublicKey is missing', async () => {
    const dispatch = createDispatch({ db: makeMockDb() })
    await expect(dispatch('policy:get', {})).rejects.toThrow()
  })
})

describe('app:decide', () => {
  function makeMockDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      _stored: stored,
    }
  }

  test('approve: updates app status to allowed, stores policy:{childPublicKey}, calls sendToPeer', async () => {
    const existing = { apps: { 'com.example.app': { status: 'pending' } }, childPublicKey: 'child1', version: 1 }
    const mockDb = makeMockDb({ 'policy:child1': existing })
    const mockSendToPeer = jest.fn()
    const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

    const result = await dispatch('app:decide', { childPublicKey: 'child1', packageName: 'com.example.app', decision: 'approve' })

    expect(result).toMatchObject({ ok: true, decision: 'allowed' })

    const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
    expect(policyPuts).toHaveLength(1)
    const [, saved] = policyPuts[0]
    expect(saved.apps['com.example.app'].status).toBe('allowed')
    expect(saved.version).toBe(2)

    expect(mockSendToPeer).toHaveBeenCalledWith('child1', expect.objectContaining({
      type: 'app:decision',
      payload: expect.objectContaining({ packageName: 'com.example.app', decision: 'allowed' }),
    }))
  })

  test('deny: updates app status to blocked', async () => {
    const existing = { apps: { 'com.example.app': { status: 'pending' } }, childPublicKey: 'child1', version: 1 }
    const mockDb = makeMockDb({ 'policy:child1': existing })
    const mockSendToPeer = jest.fn()
    const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

    const result = await dispatch('app:decide', { childPublicKey: 'child1', packageName: 'com.example.app', decision: 'deny' })

    expect(result).toMatchObject({ ok: true, decision: 'blocked' })
    const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
    const [, saved] = policyPuts[0]
    expect(saved.apps['com.example.app'].status).toBe('blocked')
  })

  test('child offline (sendToPeer throws): still stores policy, returns ok:true', async () => {
    const existing = { apps: {}, childPublicKey: 'child1', version: 0 }
    const mockDb = makeMockDb({ 'policy:child1': existing })
    const mockSendToPeer = jest.fn().mockImplementation(() => { throw new Error('peer not connected') })
    const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

    const result = await dispatch('app:decide', { childPublicKey: 'child1', packageName: 'com.example.app', decision: 'approve' })

    expect(result).toMatchObject({ ok: true })
    const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
    expect(policyPuts).toHaveLength(1)
  })

  test('no existing policy: creates new one with apps object', async () => {
    const mockDb = makeMockDb({})
    const mockSendToPeer = jest.fn()
    const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

    const result = await dispatch('app:decide', { childPublicKey: 'child1', packageName: 'com.example.app', decision: 'approve' })

    expect(result).toMatchObject({ ok: true })
    const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
    expect(policyPuts).toHaveLength(1)
    const [, saved] = policyPuts[0]
    expect(saved.apps['com.example.app'].status).toBe('allowed')
  })
})

describe('policy:update (parent-initiated)', () => {
  function makeMockDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
    }
  }

  test('stores policy:{childPublicKey}, increments version, calls sendToPeer with policy:update', async () => {
    const policy = { apps: { 'com.example.app': { status: 'allowed' } }, childPublicKey: 'child1', version: 2 }
    const mockDb = makeMockDb({})
    const mockSendToPeer = jest.fn()
    const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

    const result = await dispatch('policy:update', { childPublicKey: 'child1', policy })

    expect(result).toEqual({ ok: true })

    const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
    expect(policyPuts).toHaveLength(1)
    const [, saved] = policyPuts[0]
    expect(saved.version).toBe(3)
    expect(saved.childPublicKey).toBe('child1')

    expect(mockSendToPeer).toHaveBeenCalledWith('child1', expect.objectContaining({
      type: 'policy:update',
      payload: expect.objectContaining({ version: 3, childPublicKey: 'child1' }),
    }))
  })

  test('child offline (sendToPeer throws): still stores policy, returns ok:true', async () => {
    const policy = { apps: {}, childPublicKey: 'child1', version: 1 }
    const mockDb = makeMockDb({})
    const mockSendToPeer = jest.fn().mockImplementation(() => { throw new Error('peer not connected') })
    const dispatch = createDispatch({ db: mockDb, sendToPeer: mockSendToPeer })

    const result = await dispatch('policy:update', { childPublicKey: 'child1', policy })

    expect(result).toEqual({ ok: true })
    const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:child1')
    expect(policyPuts).toHaveLength(1)
  })

  test('throws when args are invalid', async () => {
    const dispatch = createDispatch({ db: makeMockDb() })
    await expect(dispatch('policy:update', { childPublicKey: 'child1' })).rejects.toThrow()
    await expect(dispatch('policy:update', { policy: {} })).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/tim/peerloomllc/pearguard && npx jest tests/bare-dispatch.test.js --no-coverage 2>&1 | tail -10
```

Expected: the 3 new describe blocks all FAIL with "unknown method".

- [ ] **Step 3: Implement the three dispatch cases**

In `src/bare-dispatch.js`, add three new cases inside `createDispatch` just before the `default:` case:

```js
      case 'policy:get': {
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('invalid policy:get args')
        const raw = await ctx.db.get('policy:' + childPublicKey)
        return raw ? raw.value : { apps: {} }
      }

      case 'app:decide': {
        const { childPublicKey, packageName, decision } = args
        if (!childPublicKey || !packageName || !['approve', 'deny'].includes(decision)) {
          throw new Error('invalid app:decide args')
        }
        const raw = await ctx.db.get('policy:' + childPublicKey)
        const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
        if (!policy.apps) policy.apps = {}
        const d = decision === 'approve' ? 'allowed' : 'blocked'
        policy.apps[packageName] = { ...(policy.apps[packageName] || {}), status: d }
        policy.version = (policy.version || 0) + 1
        await ctx.db.put('policy:' + childPublicKey, policy)
        try {
          ctx.sendToPeer(childPublicKey, { type: 'app:decision', payload: { packageName, decision: d } })
        } catch (_e) {
          // child offline — policy stored; will be sent on next reconnect
        }
        return { ok: true, decision: d }
      }

      case 'policy:update': {
        const { childPublicKey, policy } = args
        if (!childPublicKey || !policy || typeof policy !== 'object') {
          throw new Error('invalid policy:update args')
        }
        const newPolicy = { ...policy, childPublicKey, version: (policy.version || 0) + 1 }
        await ctx.db.put('policy:' + childPublicKey, newPolicy)
        try {
          ctx.sendToPeer(childPublicKey, { type: 'policy:update', payload: newPolicy })
        } catch (_e) {
          // child offline — policy stored; will be sent on reconnect
        }
        return { ok: true }
      }
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
npx jest tests/bare-dispatch.test.js --no-coverage 2>&1 | tail -10
```

Expected: all new tests pass.

- [ ] **Step 5: Run full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -5
```

Expected: same pre-existing 5 failing suites, 0 new failures.

- [ ] **Step 6: Commit**

```bash
git add src/bare-dispatch.js tests/bare-dispatch.test.js
git commit -m "feat: add policy:get, app:decide, policy:update (parent) to bare dispatch"
```

---

## Task 4: Child→Parent P2P relay — `sendToParent` calls and parent-side handlers

**Files:**
- Modify: `src/bare-dispatch.js` (sendToParent calls + new exported handlers)
- Modify: `src/bare.js` (handlePeerMessage cases)
- Modify: `tests/bare-dispatch.test.js`

**Context for implementer:** `sendToParent` is already in the dispatch context (passed in from `bare.js`). It sends a signed message to the connected parent peer, or queues it in Hyperbee if parent is offline. The call signature is `await ctx.sendToParent({ type: string, payload: object })`. Guard all calls with `if (ctx.sendToParent)` so existing tests (which don't provide `sendToParent`) don't break.

The new exported functions `handleIncomingAppInstalled` and `handleIncomingTimeRequest` run on the **parent device** when it receives those P2P messages. They follow the same pattern as the existing `handleAppDecision`, `handlePolicyUpdate`, `handleTimeExtend` exported functions.

- [ ] **Step 1: Write failing tests**

In `tests/bare-dispatch.test.js`, add to the existing `app:installed` describe block a new test (after the existing two tests):

```js
  test('new package: calls ctx.sendToParent with app:installed payload when sendToParent is provided', async () => {
    const mockDb = makeMockDb({})
    const mockSend = jest.fn()
    const mockSendToParent = jest.fn().mockResolvedValue(undefined)
    const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
    const dispatch = createDispatch(ctx)

    await dispatch('app:installed', { packageName: 'com.example.newapp', appName: 'New App' })

    expect(mockSendToParent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'app:installed',
      payload: expect.objectContaining({ packageName: 'com.example.newapp', appName: 'New App' }),
    }))
  })

  test('already-known package: does NOT call sendToParent', async () => {
    const existingPolicy = { apps: { 'com.example.known': { status: 'allowed' } } }
    const mockDb = makeMockDb({ policy: existingPolicy })
    const mockSend = jest.fn()
    const mockSendToParent = jest.fn()
    const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
    const dispatch = createDispatch(ctx)

    await dispatch('app:installed', { packageName: 'com.example.known' })

    expect(mockSendToParent).not.toHaveBeenCalled()
  })
```

Also update the existing `app:installed` test "new package: sets status to pending..." — the check `toEqual({ status: 'pending' })` needs to change to `toMatchObject({ status: 'pending' })` since we're also storing `appName`:

```js
  // Change this line in the existing test:
  expect(savedPolicy.apps['com.example.newapp']).toEqual({ status: 'pending' })
  // To:
  expect(savedPolicy.apps['com.example.newapp']).toMatchObject({ status: 'pending' })
```

Add these tests for `time:request`, `usage:flush`, `heartbeat:send` (inside each existing describe block, as new tests):

```js
  // Inside describe('time:request', ...):
  test('calls ctx.sendToParent with time:request payload when sendToParent is provided', async () => {
    const mockDb = makeMockDb()
    const mockSend = jest.fn()
    const mockSendToParent = jest.fn().mockResolvedValue(undefined)
    const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
    const dispatch = createDispatch(ctx)

    await dispatch('time:request', { packageName: 'com.example.tiktok' })

    expect(mockSendToParent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'time:request',
      payload: expect.objectContaining({ packageName: 'com.example.tiktok' }),
    }))
  })

  // Inside describe('usage:flush', ...):
  test('calls ctx.sendToParent with usage:report payload when sendToParent is provided', async () => {
    const identity = { publicKey: 'abc123def456', secretKey: 'secret' }
    const stored = { pinLog: [], identity }
    const mockDb = makeMockDb(stored)
    const mockSend = jest.fn()
    const mockSendToParent = jest.fn().mockResolvedValue(undefined)
    const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
    const dispatch = createDispatch(ctx)

    await dispatch('usage:flush', [])

    expect(mockSendToParent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'usage:report',
      payload: expect.objectContaining({ type: 'usage:report' }),
    }))
  })

  // Inside describe('heartbeat:send', ...):
  test('calls ctx.sendToParent with heartbeat payload when sendToParent is provided', async () => {
    const identity = { publicKey: 'abc123', secretKey: 'secret' }
    const mockDb = makeMockDb({ identity })
    const mockSend = jest.fn()
    const mockSendToParent = jest.fn().mockResolvedValue(undefined)
    const ctx = { db: mockDb, send: mockSend, sendToParent: mockSendToParent }
    const dispatch = createDispatch(ctx)

    await dispatch('heartbeat:send', {})

    expect(mockSendToParent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'heartbeat',
      payload: expect.objectContaining({ isOnline: true }),
    }))
  })
```

Add tests for the two new exported handler functions at the end of `tests/bare-dispatch.test.js`. First update the top-level require:

```js
// Change:
const { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue } = require('../src/bare-dispatch')
// To:
const { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingTimeRequest, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue } = require('../src/bare-dispatch')
```

Then add these describe blocks:

```js
describe('handleIncomingAppInstalled', () => {
  function makeMockDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
      _stored: stored,
    }
  }

  test('new app: creates policy:{childPK} entry with status pending, emits app:installed event', async () => {
    const mockDb = makeMockDb({})
    const mockSend = jest.fn()

    await handleIncomingAppInstalled(
      { packageName: 'com.example.app', appName: 'Example App', detectedAt: 1000 },
      'childpk1',
      mockDb,
      mockSend
    )

    const policyPuts = mockDb.put.mock.calls.filter(([k]) => k === 'policy:childpk1')
    expect(policyPuts).toHaveLength(1)
    const [, saved] = policyPuts[0]
    expect(saved.apps['com.example.app']).toMatchObject({ status: 'pending' })

    const events = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'app:installed')
    expect(events).toHaveLength(1)
    expect(events[0][0].data).toMatchObject({ packageName: 'com.example.app', childPublicKey: 'childpk1' })
  })

  test('already-known app: no db write, no event', async () => {
    const existing = { apps: { 'com.example.app': { status: 'allowed' } }, childPublicKey: 'childpk1', version: 1 }
    const mockDb = makeMockDb({ 'policy:childpk1': existing })
    const mockSend = jest.fn()

    await handleIncomingAppInstalled(
      { packageName: 'com.example.app', appName: 'Example App', detectedAt: 1000 },
      'childpk1',
      mockDb,
      mockSend
    )

    expect(mockDb.put).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  test('missing packageName: returns without error, no writes', async () => {
    const mockDb = makeMockDb({})
    const mockSend = jest.fn()

    await handleIncomingAppInstalled({}, 'childpk1', mockDb, mockSend)

    expect(mockDb.put).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })
})

describe('handleIncomingTimeRequest', () => {
  function makeMockDb (stored = {}) {
    return {
      put: jest.fn(async (k, v) => { stored[k] = v }),
      get: jest.fn(async (k) => stored[k] !== undefined ? { value: stored[k] } : null),
    }
  }

  test('stores request with request:{requestId} key, emits time:request:received event', async () => {
    const mockDb = makeMockDb({})
    const mockSend = jest.fn()

    await handleIncomingTimeRequest(
      { requestId: 'req:1234:com.example.tiktok', packageName: 'com.example.tiktok', requestedAt: 1234 },
      'childpk1',
      mockDb,
      mockSend
    )

    const reqPuts = mockDb.put.mock.calls.filter(([k]) => k === 'request:req:1234:com.example.tiktok')
    expect(reqPuts).toHaveLength(1)
    const [, saved] = reqPuts[0]
    expect(saved).toMatchObject({ status: 'pending', packageName: 'com.example.tiktok', childPublicKey: 'childpk1' })

    const events = mockSend.mock.calls.filter(([m]) => m.type === 'event' && m.event === 'time:request:received')
    expect(events).toHaveLength(1)
    expect(events[0][0].data).toMatchObject({ packageName: 'com.example.tiktok', childPublicKey: 'childpk1' })
  })

  test('missing requestId: returns without error, no writes', async () => {
    const mockDb = makeMockDb({})
    const mockSend = jest.fn()

    await handleIncomingTimeRequest({ packageName: 'com.example.tiktok' }, 'childpk1', mockDb, mockSend)

    expect(mockDb.put).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/tim/peerloomllc/pearguard && npx jest tests/bare-dispatch.test.js --no-coverage 2>&1 | tail -10
```

Expected: new tests FAIL (sendToParent not called, handlers not exported).

- [ ] **Step 3: Add sendToParent calls in bare-dispatch.js**

In `src/bare-dispatch.js`:

**(a) `app:installed` case** — add `appName` to destructuring and add `sendToParent` call + store `appName` in policy:

```js
      case 'app:installed': {
        const { packageName, appName } = args   // add appName

        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : { apps: {} }
        if (!policy.apps) policy.apps = {}

        if (!policy.apps[packageName]) {
          policy.apps[packageName] = { status: 'pending', appName: appName || packageName }
          await ctx.db.put('policy', policy)

          ctx.send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })
          ctx.send({ type: 'event', event: 'app:installed', data: { packageName, detectedAt: Date.now() } })
          ctx.send({ type: 'event', event: 'policy:updated', data: policy })

          if (ctx.sendToParent) {
            await ctx.sendToParent({ type: 'app:installed', payload: { packageName, appName: appName || packageName, detectedAt: Date.now() } })
          }
        }

        return { status: policy.apps[packageName].status }
      }
```

**(b) `time:request` case** — add `sendToParent` call after the existing `ctx.send` calls:

```js
      case 'time:request': {
        const { packageName } = args
        const requestId = 'req:' + Date.now() + ':' + packageName
        const request = {
          id: requestId,
          packageName,
          requestedAt: Date.now(),
          status: 'pending',
        }

        await ctx.db.put(requestId, request)

        ctx.send({ type: 'event', event: 'time:request:sent', data: { packageName, requestId, requestedAt: request.requestedAt } })
        ctx.send({ type: 'event', event: 'request:submitted', data: request })

        if (ctx.sendToParent) {
          await ctx.sendToParent({ type: 'time:request', payload: { requestId, packageName, requestedAt: request.requestedAt } })
        }

        return { requestId, status: 'pending' }
      }
```

**(c) `usage:flush` case** — add `sendToParent` call after `ctx.send`:

```js
        // Emit event to RN which can relay to parent
        ctx.send({ type: 'event', event: 'usage:report', data: report })

        if (ctx.sendToParent) {
          await ctx.sendToParent({ type: 'usage:report', payload: report })
        }

        // Clear PIN log for next reporting period
        await ctx.db.put('pinLog', [])
```

**(d) `heartbeat:send` case** — add `sendToParent` call after `ctx.send`:

```js
        ctx.send({ type: 'event', event: 'heartbeat:send', data: heartbeat })

        if (ctx.sendToParent) {
          await ctx.sendToParent({ type: 'heartbeat', payload: heartbeat.payload })
        }

        return heartbeat.payload
```

- [ ] **Step 4: Add the two new exported handler functions**

In `src/bare-dispatch.js`, add these two functions before the `module.exports` line:

```js
/**
 * Handle an incoming `app:installed` P2P message from a child peer.
 * Runs on the PARENT device. Extracted for testability.
 *
 * @param {object} payload — { packageName, appName, detectedAt }
 * @param {string} childPublicKey — the child's identity key (msg.from)
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare→RN IPC send function
 */
async function handleIncomingAppInstalled (payload, childPublicKey, db, send) {
  const { packageName, appName } = payload
  if (!packageName) {
    console.warn('[bare] app:installed from child: missing packageName')
    return
  }

  const raw = await db.get('policy:' + childPublicKey)
  const policy = raw ? raw.value : { apps: {}, childPublicKey, version: 0 }
  if (!policy.apps) policy.apps = {}

  if (!policy.apps[packageName]) {
    policy.apps[packageName] = { status: 'pending', appName: appName || packageName }
    await db.put('policy:' + childPublicKey, policy)
    send({ type: 'event', event: 'app:installed', data: { packageName, appName: appName || packageName, childPublicKey, detectedAt: Date.now() } })
  }
}

/**
 * Handle an incoming `time:request` P2P message from a child peer.
 * Runs on the PARENT device. Extracted for testability.
 *
 * @param {object} payload — { requestId, packageName, requestedAt }
 * @param {string} childPublicKey — the child's identity key (msg.from)
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare→RN IPC send function
 */
async function handleIncomingTimeRequest (payload, childPublicKey, db, send) {
  const { requestId, packageName, requestedAt } = payload
  if (!requestId || !packageName) {
    console.warn('[bare] time:request from child: missing fields')
    return
  }

  const request = { id: requestId, packageName, requestedAt, status: 'pending', childPublicKey }
  await db.put('request:' + requestId, request)
  send({ type: 'event', event: 'time:request:received', data: request })
}
```

Update `module.exports` to include the new exports:

```js
module.exports = { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingTimeRequest, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue }
```

- [ ] **Step 5: Add parent-side cases to `handlePeerMessage` in `src/bare.js`**

Update the import at the top of `bare.js`:

```js
// Change:
const { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, queueMessage, flushMessageQueue } = require('./bare-dispatch')
// To:
const { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingTimeRequest, queueMessage, flushMessageQueue } = require('./bare-dispatch')
```

In `handlePeerMessage`, inside the `switch (msg.type)` block, add these cases before `default:`:

```js
    case 'app:installed':
      await handleIncomingAppInstalled(msg.payload, msg.from, db, send)
      break
    case 'time:request':
      await handleIncomingTimeRequest(msg.payload, msg.from, db, send)
      break
    case 'usage:report': {
      const childPublicKey = msg.from
      await db.put('usageReport:' + childPublicKey + ':' + (msg.payload.timestamp || Date.now()), msg.payload)
      send({ type: 'event', event: 'usage:report', data: { ...msg.payload, childPublicKey } })
      break
    }
    case 'heartbeat': {
      const childPublicKey = msg.from
      send({ type: 'event', event: 'heartbeat:received', data: { ...msg.payload, childPublicKey } })
      break
    }
```

- [ ] **Step 6: Run tests to confirm they pass**

```bash
cd /home/tim/peerloomllc/pearguard && npx jest tests/bare-dispatch.test.js --no-coverage 2>&1 | tail -10
```

Expected: all new and updated tests pass.

- [ ] **Step 7: Run full test suite**

```bash
npx jest --no-coverage 2>&1 | tail -5
```

Expected: same pre-existing 5 failing suites, 0 new failures.

- [ ] **Step 8: Commit**

```bash
git add src/bare-dispatch.js src/bare.js tests/bare-dispatch.test.js
git commit -m "feat: relay app:installed, time:request, usage:flush, heartbeat from child to parent via P2P"
```

---

## Task 5: Push stored policy to child on connect/reconnect

**Files:**
- Modify: `src/bare.js`

No unit tests — this is a bare.js integration path only. Verified by device in Task 6.

- [ ] **Step 1: Add policy push in `handleHello` (parent side)**

In `src/bare.js` inside `handleHello`, find the parent-side block:

```js
  // Notify the parent UI that a child has connected
  if (mode === 'parent') {
    send({ type: 'event', event: 'child:connected', data: peerRecord })
  }
```

Replace with:

```js
  // Notify the parent UI that a child has connected
  if (mode === 'parent') {
    send({ type: 'event', event: 'child:connected', data: peerRecord })

    // Push the latest stored policy to the child so enforcement stays current
    const storedPolicy = await db.get('policy:' + peerIdentityKeyHex).catch(() => null)
    if (storedPolicy && storedPolicy.value) {
      try {
        sendToPeer(remoteKeyHex, { type: 'policy:update', payload: storedPolicy.value })
        console.log('[bare] sent stored policy to child:', peerIdentityKeyHex.slice(0, 12))
      } catch (e) {
        console.warn('[bare] could not send stored policy:', e.message)
      }
    }
  }
```

- [ ] **Step 2: Run tests and commit**

```bash
cd /home/tim/peerloomllc/pearguard && npx jest --no-coverage 2>&1 | tail -5
git add src/bare.js
git commit -m "feat: push stored policy to child when parent receives hello on connect/reconnect"
```

Expected: no new test failures.

---

## Task 6: Build and install on both devices

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

On **child device**:
1. Open PearGuard (should still be paired from previous session)
2. If Hyperswarm reconnects automatically, the parent should receive the child's installed apps within a few seconds
3. On child Profile → Pair to Parent (if pairing expired) — re-pair as needed

On **parent device**, go to Children tab → tap the child → Apps tab:
4. Verify apps list is populated (e.g. "com.android.chrome", other installed apps)
5. Approve one app, deny another — verify no crash
6. After approve/deny, go to child device — open a "denied" app — should be blocked by accessibility service
7. On child ChildRequests tab — after being blocked, verify the time request button becomes enabled
8. Tap time request — parent should receive `time:request:received` event (verify in AlertsTab or console)
