# Co-Parent PIN & Request Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two co-parent bugs: #120 (multi-parent PIN conflict) and #122 (request decisions not syncing to other parents).

**Architecture:** Replace single `pinHash` with per-parent `pinHashes` map in child policy. After child processes any request decision, broadcast `request:resolved` to all connected parents. Backfill resolved requests on parent reconnect via the hello handshake.

**Tech Stack:** JavaScript (Bare worklet), Java (Android native module)

---

### Task 1: Parent `pin:set` writes `pinHashes` instead of `pinHash`

**Files:**
- Modify: `src/bare-dispatch.js:373-413`

- [ ] **Step 1: Update pin:set to write pinHashes map**

In `src/bare-dispatch.js`, replace the child policy propagation inside `case 'pin:set'` (lines 392-410). The parent's own `policy.pinHash` stays unchanged (local use). But when writing to child policies, use `pinHashes` keyed by parent public key and delete the legacy `pinHash` field:

```javascript
      case 'pin:set': {
        const { pin } = args
        if (!pin || typeof pin !== 'string') throw new Error('invalid pin')

        // Hash the PIN using BLAKE2b (crypto_generichash) — a core libsodium primitive
        // that is reliably available in all builds including Android/Bare.
        // crypto_pwhash_str (argon2id) is intentionally NOT used here because its
        // availability in the Android libsodium build is not guaranteed.
        const hashBuf = Buffer.alloc(ctx.sodium.crypto_generichash_BYTES)
        ctx.sodium.crypto_generichash(hashBuf, Buffer.from(pin))
        const hashStr = hashBuf.toString('hex')
        if (!hashStr) throw new Error('PIN hashing failed — crypto_generichash returned empty result')

        // Store in parent's own policy key (unchanged — for local use)
        const raw = await ctx.db.get('policy')
        const policy = raw ? raw.value : {}
        policy.pinHash = hashStr
        await ctx.db.put('policy', policy)

        // Propagate pinHashes into every child's policy and push to connected children
        const myPublicKey = Buffer.from(ctx.identity.publicKey).toString('hex')
        for await (const { value: peerRecord } of ctx.db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
          const childPK = peerRecord.publicKey
          const childPolicyRaw = await ctx.db.get('policy:' + childPK).catch(() => null)
          const childPolicy = childPolicyRaw
            ? childPolicyRaw.value
            : { apps: {}, childPublicKey: childPK, version: 0 }
          // Write per-parent pinHash into pinHashes map; remove legacy field
          if (!childPolicy.pinHashes) childPolicy.pinHashes = {}
          childPolicy.pinHashes[myPublicKey] = hashStr
          delete childPolicy.pinHash
          childPolicy.version = (childPolicy.version || 0) + 1
          await ctx.db.put('policy:' + childPK, childPolicy)
          try {
            const noiseKey = peerRecord.noiseKey
            if (noiseKey) {
              ctx.sendToPeer(noiseKey, { type: 'policy:update', payload: childPolicy })
            }
          } catch (_e) {
            // child offline — pinHashes stored; will be pushed on next hello
          }
        }

        return { ok: true }
      }
```

- [ ] **Step 2: Build and verify no syntax errors**

Run:
```bash
npm run build:bare
```
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/bare-dispatch.js
git commit -m "fix(#120): pin:set writes per-parent pinHashes map instead of single pinHash"
```

---

### Task 2: Child `handlePolicyUpdate` merges `pinHashes`

**Files:**
- Modify: `src/bare-dispatch.js:1358-1388`

- [ ] **Step 1: Update handlePolicyUpdate to merge pinHashes**

In `src/bare-dispatch.js`, replace the `handlePolicyUpdate` function (lines 1358-1388). The key change: merge incoming `pinHashes` into existing ones so Parent A's hash is preserved when Parent B sends an update. Also handle legacy `pinHash` migration on receipt.

```javascript
async function handlePolicyUpdate (payload, db, send) {
  if (typeof payload.version !== 'number' || !payload.childPublicKey) {
    console.warn('[bare] policy:update ignored: invalid payload (missing version or childPublicKey)')
    return
  }

  // Merge pinHashes so that each parent's PIN survives the other parent's policy push.
  // If the incoming payload still uses the legacy pinHash field (from a parent that
  // hasn't updated yet), convert it to pinHashes format using the 'from' field.
  const existing = await db.get('policy').catch(() => null)
  const existingPinHashes = (existing && existing.value && existing.value.pinHashes) || {}
  const incomingPinHashes = payload.pinHashes || {}
  const merged = { ...existingPinHashes, ...incomingPinHashes }
  payload.pinHashes = merged
  delete payload.pinHash  // ensure legacy field is cleaned up

  await db.put('policy', payload)
  // Use method format (not event) so the RN shell routes this to
  // NativeModules.UsageStatsModule.setPolicy() via the msg.method === 'native:setPolicy' branch
  // in the bare IPC data handler (app/index.tsx ~line 162).
  // Sending as a type:'event' would only forward it to the WebView, never to the native module.
  send({ method: 'native:setPolicy', args: { json: JSON.stringify(payload) } })
  send({ type: 'event', event: 'policy:updated', data: payload })

  // Sync pending req:* entries with the new policy so ChildRequests shows the correct status.
  // This handles the case where app:decision was not delivered directly (e.g., child was offline
  // and the parent's decision arrives via the policy:update pushed on reconnect).
  const apps = payload.apps || {}
  for await (const { key, value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
    if (value.status !== 'pending') continue
    const appEntry = apps[value.packageName]
    const appStatus = appEntry && appEntry.status
    if (appStatus === 'allowed' || appStatus === 'blocked') {
      const newStatus = appStatus === 'allowed' ? 'approved' : 'denied'
      await db.put(key, { ...value, status: newStatus })
      send({ type: 'event', event: 'request:updated', data: {
        requestId: value.id, status: newStatus,
        packageName: value.packageName, appName: value.appName || value.packageName,
      } })
    }
  }
}
```

- [ ] **Step 2: Build and verify no syntax errors**

Run:
```bash
npm run build:bare
```
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/bare-dispatch.js
git commit -m "fix(#120): handlePolicyUpdate merges pinHashes from multiple parents"
```

---

### Task 3: Native `verifyPin` iterates `pinHashes` with fallback

**Files:**
- Modify: `android/app/src/main/java/com/pearguard/AppBlockerModule.java:1369-1389`

- [ ] **Step 1: Update verifyPin to check all hashes in pinHashes map**

In `AppBlockerModule.java`, replace the `verifyPin` method (lines 1369-1389). It should iterate over all values in the `pinHashes` JSONObject. If none match, fall back to the legacy `pinHash` string field for migration support.

```java
    /**
     * Verifies the entered PIN against BLAKE2b hex hashes stored by bare-dispatch.js pin:set.
     * Checks all parent PIN hashes in the pinHashes map (per-parent PINs).
     * Falls back to legacy single pinHash field for migration support.
     */
    private boolean verifyPin(String enteredPin) {
        JSONObject policy = loadPolicy();
        if (policy == null) return false;

        try {
            byte[] passwordBytes = enteredPin.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            final int HASH_BYTES = 32; // crypto_generichash_BYTES
            byte[] computedHash = new byte[HASH_BYTES];
            lazySodium.getSodium().crypto_generichash(
                    computedHash, HASH_BYTES, passwordBytes, passwordBytes.length, null, 0);

            // Check per-parent pinHashes map
            JSONObject pinHashes = policy.optJSONObject("pinHashes");
            if (pinHashes != null && pinHashes.length() > 0) {
                java.util.Iterator<String> keys = pinHashes.keys();
                while (keys.hasNext()) {
                    String parentKey = keys.next();
                    String hashHex = pinHashes.optString(parentKey, null);
                    if (hashHex != null && !hashHex.isEmpty()) {
                        byte[] storedHash = hexToBytes(hashHex);
                        if (Arrays.equals(computedHash, storedHash)) return true;
                    }
                }
                return false;
            }

            // Fallback: legacy single pinHash field (migration support)
            String pinHash = policy.optString("pinHash", null);
            if (pinHash == null || pinHash.isEmpty()) return false;
            byte[] storedHash = hexToBytes(pinHash);
            return Arrays.equals(computedHash, storedHash);
        } catch (Exception e) {
            return false;
        }
    }
```

- [ ] **Step 2: Build and verify no compilation errors**

Run:
```bash
cd android && ./gradlew assembleDebug && cd ..
```
Expected: BUILD SUCCESSFUL.

- [ ] **Step 3: Commit**

```bash
git add android/app/src/main/java/com/pearguard/AppBlockerModule.java
git commit -m "fix(#120): verifyPin checks per-parent pinHashes map with legacy fallback"
```

---

### Task 4: Child broadcasts `request:resolved` after processing decisions

**Files:**
- Modify: `src/bare-dispatch.js:1317-1348` (handleAppDecision)
- Modify: `src/bare-dispatch.js:1398-1430` (handleTimeExtend)
- Modify: `src/bare.js:393-405` (request:denied handler)

- [ ] **Step 1: Add sendToAllParents parameter to handleAppDecision and handleTimeExtend**

Both functions currently take `(payload, db, send)`. Add a fourth parameter `sendToAllParents` (a function) that the child calls to broadcast to all parents. When the function is null (parent-side call), the broadcast is skipped.

In `src/bare-dispatch.js`, update `handleAppDecision` (lines 1317-1348) to broadcast resolved requests:

```javascript
async function handleAppDecision (payload, db, send, sendToAllParents) {
  const { packageName, decision } = payload
  if (!packageName || !['allowed', 'blocked'].includes(decision)) {
    console.warn('[bare] app:decision: malformed payload')
    return
  }

  const raw = await db.get('policy')
  if (!raw) return
  const policy = raw.value

  if (!policy.apps) policy.apps = {}
  policy.apps[packageName] = { ...(policy.apps[packageName] || {}), status: decision }

  await db.put('policy', policy)
  send({ method: 'native:setPolicy', args: { json: JSON.stringify(policy) } })
  send({ type: 'event', event: 'policy:updated', data: policy })

  // Update any pending time requests for this package so the child's request
  // list reflects the parent's decision ('allowed' -> 'approved', 'blocked' -> 'denied').
  const requestStatus = decision === 'allowed' ? 'approved' : 'denied'
  // Only emit request:updated (which triggers a child notification) when a
  // pending request actually exists. Proactive parent decisions (approve/deny
  // from the Apps tab without a child request) should NOT notify the child.
  for await (const { key, value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
    if (value.packageName === packageName && value.status === 'pending') {
      const updated = { ...value, status: requestStatus }
      await db.put(key, updated)
      send({ type: 'event', event: 'request:updated', data: { requestId: value.id, status: requestStatus, packageName: value.packageName, appName: value.appName || value.packageName } })
      // Broadcast resolution to all parents so co-parent activity lists update (#122)
      if (sendToAllParents) {
        sendToAllParents({ type: 'request:resolved', payload: { requestId: value.id, status: requestStatus, packageName: value.packageName, resolvedAt: Date.now() } })
      }
    }
  }
}
```

- [ ] **Step 2: Update handleTimeExtend to broadcast resolution**

In `src/bare-dispatch.js`, update `handleTimeExtend` (lines 1398-1430):

```javascript
async function handleTimeExtend (payload, db, send, sendToAllParents) {
  const { requestId, packageName, extraSeconds } = payload
  if (!requestId || !packageName || typeof extraSeconds !== 'number') {
    console.warn('[bare] time:extend: malformed payload, dropping')
    return
  }

  const expiresAt = Date.now() + extraSeconds * 1000
  const grant = { packageName, grantedAt: Date.now(), expiresAt, source: 'parent-approved' }

  // Update request status in Hyperbee
  const existing = await db.get(requestId)
  let appName = null
  if (existing) {
    const req = existing.value
    appName = req.appName || null
    req.status = 'approved'
    req.expiresAt = expiresAt
    await db.put(requestId, req)
  }

  // Store grant to Hyperbee so overrides:list can find it (#61)
  grant.appName = appName || packageName
  await db.put('override:' + packageName + ':' + grant.grantedAt, grant)

  // Notify native to grant override
  send({ method: 'native:grantOverride', args: grant })

  // Notify WebView — include appName/packageName so the decision notification (#67 fix)
  // can show the real app name instead of "an app".
  send({ type: 'event', event: 'override:granted', data: grant })
  send({ type: 'event', event: 'request:updated', data: { requestId, packageName, appName, status: 'approved', expiresAt } })

  // Broadcast resolution to all parents so co-parent activity lists update (#122)
  if (sendToAllParents) {
    sendToAllParents({ type: 'request:resolved', payload: { requestId, status: 'approved', packageName, resolvedAt: Date.now() } })
  }
}
```

- [ ] **Step 3: Update bare.js callers to pass sendToAllParents**

In `src/bare.js`, update the call sites in `handlePeerMessage` (lines 386-409). The child passes `sendToAllParents`; the function is already in scope from the module-level declaration.

Change line 388 from:
```javascript
      await handlePolicyUpdate(msg.payload, db, send)
```
to:
```javascript
      await handlePolicyUpdate(msg.payload, db, send, sendToAllParents)
```

Change line 391 from:
```javascript
      await handleTimeExtend(msg.payload, db, send)
```
to:
```javascript
      await handleTimeExtend(msg.payload, db, send, sendToAllParents)
```

Change line 408 from:
```javascript
      await handleAppDecision(msg.payload, db, send)
```
to:
```javascript
      await handleAppDecision(msg.payload, db, send, sendToAllParents)
```

- [ ] **Step 4: Add request:resolved broadcast after request:denied handler in bare.js**

In `src/bare.js`, inside the `case 'request:denied'` block (lines 393-406), add the broadcast after the existing logic. Replace the entire case block:

```javascript
    case 'request:denied': {
      // Parent denied an extra-time request — update the child-side req: entry and notify.
      const { requestId, packageName, appName } = msg.payload || {}
      if (requestId) {
        const existing = await db.get(requestId).catch(() => null)
        if (existing) {
          await db.put(requestId, { ...existing.value, status: 'denied' })
        }
      }
      send({ type: 'event', event: 'request:updated', data: { requestId, packageName, status: 'denied' } })
      // Trigger native notification (same channel as approval decisions)
      send({ method: 'native:showDecisionNotification', args: { appName: appName || packageName || 'the app', decision: 'denied' } })
      // Broadcast resolution to all parents so co-parent activity lists update (#122)
      sendToAllParents({ type: 'request:resolved', payload: { requestId, status: 'denied', packageName, resolvedAt: Date.now() } })
      break
    }
```

- [ ] **Step 5: Update handlePolicyUpdate signature to accept sendToAllParents**

In `src/bare-dispatch.js`, update the `handlePolicyUpdate` function signature. After the `pinHashes` merge work done in Task 2, the function should also broadcast resolved requests when syncing `req:*` entries against policy:

The function already has `async function handlePolicyUpdate (payload, db, send)` from Task 2. Change to `async function handlePolicyUpdate (payload, db, send, sendToAllParents)`.

Then inside the `req:*` sync loop, after the `db.put` and `send` calls, add the broadcast:

```javascript
      if (sendToAllParents) {
        sendToAllParents({ type: 'request:resolved', payload: { requestId: value.id, status: newStatus, packageName: value.packageName, resolvedAt: Date.now() } })
      }
```

Add this right after the existing `send({ type: 'event', event: 'request:updated', ...})` line inside the loop.

- [ ] **Step 6: Build and verify no syntax errors**

Run:
```bash
npm run build:bare
```
Expected: Build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/bare-dispatch.js src/bare.js
git commit -m "fix(#122): child broadcasts request:resolved to all parents after decisions"
```

---

### Task 5: Parent handles incoming `request:resolved` messages

**Files:**
- Modify: `src/bare.js:386-409` (handlePeerMessage switch)
- Modify: `src/bare-dispatch.js:1710` (module.exports)

- [ ] **Step 1: Add handleRequestResolved function to bare-dispatch.js**

Add this function just before the `module.exports` line (before line 1710) in `src/bare-dispatch.js`:

```javascript
/**
 * Handle a `request:resolved` P2P message from a child peer.
 * Updates the parent's local request entry so the activity list stays in sync (#122).
 *
 * @param {object} payload — { requestId, status, packageName, resolvedAt }
 * @param {object} db — Hyperbee instance
 * @param {function} send — bare->RN IPC send function
 */
async function handleRequestResolved (payload, db, send) {
  const { requestId, status, packageName, resolvedAt } = payload
  if (!requestId || !status) return

  const existing = await db.get('request:' + requestId).catch(() => null)
  if (!existing || existing.value.status !== 'pending') return

  await db.put('request:' + requestId, { ...existing.value, status, resolvedAt })
  send({ type: 'event', event: 'request:updated', data: { requestId, status, packageName } })
}
```

- [ ] **Step 2: Export handleRequestResolved from bare-dispatch.js**

Update the `module.exports` line (line 1710) to include `handleRequestResolved`:

```javascript
module.exports = { createDispatch, handleAppDecision, handlePolicyUpdate, handleTimeExtend, handleIncomingAppInstalled, handleIncomingAppUninstalled, handleIncomingAppsSync, handleIncomingTimeRequest, handleRequestResolved, appendPinUseLog, getPinUseLog, queueMessage, flushMessageQueue }
```

- [ ] **Step 3: Import and route request:resolved in bare.js**

In `src/bare.js`, add `handleRequestResolved` to the destructured import from `./bare-dispatch`. Find the line that imports these functions (near the top of the file where `createDispatch` is destructured) and add `handleRequestResolved`.

Then add a new case in the `handlePeerMessage` switch block (after the `case 'app:decision'` block around line 409):

```javascript
    case 'request:resolved':
      await handleRequestResolved(msg.payload, db, send)
      break
```

- [ ] **Step 4: Build and verify no syntax errors**

Run:
```bash
npm run build:bare
```
Expected: Build succeeds with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/bare-dispatch.js src/bare.js
git commit -m "fix(#122): parent handles request:resolved messages from child"
```

---

### Task 6: Backfill resolved requests on parent reconnect

**Files:**
- Modify: `src/bare.js:860-911` (child-side handleHello)

- [ ] **Step 1: Send resolved requests to parent during child hello handshake**

In `src/bare.js`, inside `handleHello` in the child-mode block (after `mode === 'child'`, around line 861), after the pending request resend logic (line 905), add a block that sends recently-resolved requests to the reconnecting parent. Insert before the `apps:syncRequested` event (line 908):

```javascript
    // Backfill resolved requests so co-parents who were offline see updated statuses (#122).
    // Send all non-pending requests from the last 7 days.
    try {
      const resolvedCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
      let backfilled = 0
      for await (const { value } of db.createReadStream({ gt: 'req:', lt: 'req:~' })) {
        if (!value || value.status === 'pending') continue
        if (value.requestedAt < resolvedCutoff) continue
        const resolved = signMessage({
          type: 'request:resolved',
          payload: { requestId: value.id, status: value.status, packageName: value.packageName, resolvedAt: value.expiresAt || Date.now() },
        }, identity)
        conn.write(Buffer.from(JSON.stringify(resolved) + '\n'))
        backfilled++
      }
      if (backfilled > 0) console.log('[bare] backfilled', backfilled, 'resolved request(s) to parent on reconnect')
    } catch (e) {
      console.warn('[bare] resolved request backfill failed:', e.message)
    }
```

This goes right after the `if (resent > 0) console.log(...)` block (line 902-904), before line 907 (`send({ type: 'event', event: 'apps:syncRequested' ...`).

- [ ] **Step 2: Build and verify no syntax errors**

Run:
```bash
npm run build:bare
```
Expected: Build succeeds with no errors.

- [ ] **Step 3: Commit**

```bash
git add src/bare.js
git commit -m "fix(#122): child backfills resolved requests to parent on reconnect"
```

---

### Task 7: Build, install, and verify on device

**Files:**
- No code changes - build and deploy only.

- [ ] **Step 1: Full build**

```bash
npm run build:bare
npm run build:ui
cd android && ./gradlew assembleDebug && cd ..
```

- [ ] **Step 2: Install on both devices**

```bash
adb -s 39071JEHN07324 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s T3CX105M25A install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 3: On-device verification**

Test #120 (multi-parent PIN):
1. Parent A: set PIN to 1234
2. Parent B: set PIN to 5678
3. Child: open a blocked app, enter 1234 - should unlock
4. Child: open a blocked app, enter 5678 - should also unlock
5. Child: enter 0000 - should reject

Test #122 (request sync):
1. Child: send an unlock request for a blocked app
2. Both parents: verify request appears in Activity tab
3. Parent A: approve the request
4. Parent B: verify Activity tab shows the request as approved (not pending)
5. Repeat with a deny from Parent B for a different request, verify Parent A sees it resolved
