# Multi-Parent Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow multiple parent devices to pair with a single child, with both parents seeing all data and either able to set policy (last-write-wins).

**Architecture:** Replace the child's single `peerConnected`/`parentPeer` state with a `parentPeers` Map. `sendToParent()` becomes `sendToAllParents()` which iterates all connected parents. Add a co-parent invite flow where Parent A relays Parent B's connection info to the child. The parent side needs minimal changes.

**Tech Stack:** Hyperswarm, Hyperbee, sodium-native (existing stack)

---

### Task 1: Replace child single-parent state with multi-parent Map

**Files:**
- Modify: `src/bare.js:36-38` (state declarations)
- Modify: `src/bare.js:128-132` (dispatch context)
- Modify: `src/bare.js:286-304` (connection error/close handlers)
- Modify: `src/bare.js:740-777` (handleHello child branch)

- [ ] **Step 1: Replace state variables**

In `src/bare.js`, replace lines 36-38:

```js
// Parent connection state (child mode only)
let peerConnected = false
let parentPeer = null  // the connected parent peer entry from `peers` map
```

with:

```js
// Parent connections (child mode only) — Map<identityKeyHex, { conn, remoteKeyHex, displayName, topicHex }>
const parentPeers = new Map()
```

- [ ] **Step 2: Update dispatch context**

In `src/bare.js`, replace the `resetParentConnection` in the `createDispatch` call (line 132):

```js
    resetParentConnection: () => { peerConnected = false; parentPeer = null } })
```

with:

```js
    resetParentConnection: (identityKey) => {
      if (identityKey) parentPeers.delete(identityKey)
      else parentPeers.clear()
    } })
```

- [ ] **Step 3: Update connection error handler**

In `src/bare.js`, replace the error handler body (lines 288-293):

```js
    if (mode === 'child' && parentPeer && parentPeer.remoteKeyHex === remoteKeyHex) {
      peerConnected = false
      parentPeer = null
    }
```

with:

```js
    if (mode === 'child') {
      for (const [ik, pp] of parentPeers) {
        if (pp.remoteKeyHex === remoteKeyHex) { parentPeers.delete(ik); break }
      }
    }
```

- [ ] **Step 4: Update connection close handler**

In `src/bare.js`, replace the close handler parent-state block (lines 297-301):

```js
    // Reset parent connection state if this was the parent peer
    if (mode === 'child' && parentPeer && parentPeer.remoteKeyHex === remoteKeyHex) {
      peerConnected = false
      parentPeer = null
    }
```

with:

```js
    // Remove from parentPeers if this was a parent connection
    if (mode === 'child') {
      for (const [ik, pp] of parentPeers) {
        if (pp.remoteKeyHex === remoteKeyHex) { parentPeers.delete(ik); break }
      }
    }
```

- [ ] **Step 5: Update handleHello child branch**

In `src/bare.js`, replace the child branch in handleHello (lines 747-749):

```js
    // Mark parent as connected and flush any queued messages
    peerConnected = true
    parentPeer = peers.get(remoteKeyHex)
```

with:

```js
    // Track this parent connection
    const peerEntry = peers.get(remoteKeyHex)
    parentPeers.set(peerIdentityKeyHex, {
      conn: peerEntry.conn,
      remoteKeyHex,
      displayName: displayName ?? 'Parent',
      topicHex: peerEntry.topicHex,
    })
```

- [ ] **Step 6: Commit**

```bash
git add src/bare.js
git commit -m "refactor: replace single parentPeer with parentPeers Map (#108)"
```

---

### Task 2: Replace sendToParent with sendToAllParents

**Files:**
- Modify: `src/bare.js:547-569` (sendToParent function)
- Modify: `src/bare.js:571-583` (flushPendingMessages)
- Modify: `src/bare.js:128-129` (dispatch context sendToParent reference)

- [ ] **Step 1: Rewrite sendToParent as sendToAllParents**

In `src/bare.js`, replace the entire `sendToParent` function (lines 547-569):

```js
/**
 * Send a message to the connected parent.
 * - If connected: send immediately. No queuing — avoids duplicate delivery when the
 *   connection is active (queue would be flushed again on next handleHello).
 * - If not connected or send fails: queue in Hyperbee for reconnect delivery.
 * Child mode only.
 * @param {{ type: string, payload: object }} message
 */
async function sendToParent (message) {
  if (peerConnected && parentPeer && parentPeer.conn) {
    try {
      const signed = signMessage(message, identity)
      parentPeer.conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
      return  // Sent immediately; queuing would cause a duplicate on next reconnect
    } catch (e) {
      // Write failed — connection was dead; fall through to queue
      peerConnected = false
      parentPeer = null
    }
  }
  // Not connected (or send failed): queue for delivery on next handleHello
  await queueMessage(message, db)
}
```

with:

```js
/**
 * Send a message to all connected parents.
 * - If any parent is connected: send immediately to each.
 * - If no parents connected (or all sends fail): queue for reconnect delivery.
 * Child mode only.
 * @param {{ type: string, payload: object }} message
 */
async function sendToAllParents (message) {
  if (parentPeers.size === 0) {
    await queueMessage(message, db)
    return
  }
  const signed = signMessage(message, identity)
  const payload = Buffer.from(JSON.stringify(signed) + '\n')
  let sentToAny = false
  for (const [ik, pp] of parentPeers) {
    try {
      pp.conn.write(payload)
      sentToAny = true
    } catch (e) {
      parentPeers.delete(ik)
    }
  }
  if (!sentToAny) {
    await queueMessage(message, db)
  }
}
```

- [ ] **Step 2: Update flushPendingMessages to write to all parents**

In `src/bare.js`, replace the `flushPendingMessages` function (lines 571-583):

```js
/**
 * Flush all queued messages to the parent connection and clear the queue.
 * @param {object} conn — the parent peer's connection stream
 */
async function flushPendingMessages (conn) {
  const count = await flushMessageQueue(db, (message) => {
    const signed = signMessage(message, identity)
    conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
  })
  if (count > 0) {
    console.log('[bare] flushed', count, 'queued messages to parent')
  }
}
```

with:

```js
/**
 * Flush all queued messages to a specific parent connection and clear the queue.
 * Called on each parent reconnect. The queue is shared across all parents, so
 * flushing to the first parent that reconnects delivers everything.
 * @param {object} conn — the parent peer's connection stream
 */
async function flushPendingMessages (conn) {
  const count = await flushMessageQueue(db, (message) => {
    const signed = signMessage(message, identity)
    conn.write(Buffer.from(JSON.stringify(signed) + '\n'))
  })
  if (count > 0) {
    console.log('[bare] flushed', count, 'queued messages to parent')
  }
}
```

Note: The function body stays the same - it still flushes to a single `conn`. The queue is cleared after flush, so the first reconnecting parent gets the backlog. This is acceptable because both parents will eventually get live messages from `sendToAllParents`.

- [ ] **Step 3: Update dispatch context reference**

In `src/bare.js`, change `sendToParent` to `sendToAllParents` in the `createDispatch` call (line 129):

```js
    joinTopic, sendToPeer, sendToParent, sodium,
```

becomes:

```js
    joinTopic, sendToPeer, sendToAllParents, sodium,
```

- [ ] **Step 4: Update bare-dispatch.js references**

In `src/bare-dispatch.js`, rename all `ctx.sendToParent` references to `ctx.sendToAllParents`. There are 8 occurrences (lines 445, 448, 634, 635, 665, 666, 704, 705, 737, 738, 765, 766, 781, 782, 859, 860). Use find-and-replace:

Replace `ctx.sendToParent` with `ctx.sendToAllParents` (all occurrences).

- [ ] **Step 5: Update the dispatch context property name in createDispatch**

In `src/bare-dispatch.js`, in the `createDispatch` function signature/destructuring, rename `sendToParent` to `sendToAllParents`.

Find the line where `ctx` is built (near the top of `createDispatch`) and rename the property.

- [ ] **Step 6: Commit**

```bash
git add src/bare.js src/bare-dispatch.js
git commit -m "refactor: sendToParent -> sendToAllParents for multi-parent broadcast (#108)"
```

---

### Task 3: Update handleHello reconnect to flush per-parent

**Files:**
- Modify: `src/bare.js:750-777` (handleHello child reconnect section)

- [ ] **Step 1: Update pending request re-send to use the specific parent conn**

In `src/bare.js`, the handleHello child branch currently does (line 750):

```js
    await flushPendingMessages(conn)
```

This stays the same - `conn` is the specific parent's connection that just completed hello. The queue flush delivers to this parent. No change needed.

- [ ] **Step 2: Update the pending time request re-send**

The pending request re-send loop (lines 758-777) currently writes directly to `conn`. This is correct - we're re-sending to the specific parent that just reconnected. No change needed.

- [ ] **Step 3: Verify no references to old `peerConnected`/`parentPeer` remain**

Run:

```bash
grep -n 'peerConnected\|parentPeer[^s]' src/bare.js
```

Expected: no matches. If any remain, update them.

- [ ] **Step 4: Commit (if any changes were made)**

```bash
git add src/bare.js
git commit -m "fix: clean up any remaining single-parent references (#108)"
```

---

### Task 4: Update acceptInvite to preserve existing topics

**Files:**
- Modify: `src/bare-dispatch.js:249-279` (acceptInvite case)

- [ ] **Step 1: Remove the old-topic cleanup from acceptInvite**

In `src/bare-dispatch.js`, replace the `acceptInvite` case (lines 249-279):

```js
      case 'acceptInvite': {
        // args[0]: full pearguard://join/... URL
        const { parseInviteLink } = require('./invite')
        const parsed = parseInviteLink(args[0])
        if (!parsed.ok) throw new Error('invalid invite: ' + parsed.error)

        const { parentPublicKey, swarmTopic } = parsed

        // Store the parent's public key as a "pending" entry — will be confirmed on hello
        await ctx.db.put('pendingParent', { publicKey: parentPublicKey, ts: Date.now() })

        // Leave and delete all existing topics before joining the new one.
        // A child should only be connected to one parent at a time. Any old topics
        // (from a previous pairing that wasn't fully cleaned up) would let the child
        // stay joined to a stale topic, which can cause ghost connections on the parent.
        const oldTopics = []
        for await (const { key, value } of ctx.db.createReadStream({ gt: 'topics:', lt: 'topics:~' })) {
          if (value.topicHex !== swarmTopic) oldTopics.push({ key, topicHex: value.topicHex })
        }
        for (const { key, topicHex } of oldTopics) {
          await ctx.db.del(key).catch(() => {})
          if (ctx.swarm) {
            try { ctx.swarm.leave(ctx.b4a.from(topicHex, 'hex')) } catch (_e) {}
          }
        }

        // Join the swarm topic (child connects to parent)
        await ctx.joinTopic(swarmTopic)

        return { ok: true, swarmTopic, parentPublicKey }
      }
```

with:

```js
      case 'acceptInvite': {
        // args[0]: full pearguard://join/... URL
        const { parseInviteLink } = require('./invite')
        const parsed = parseInviteLink(args[0])
        if (!parsed.ok) throw new Error('invalid invite: ' + parsed.error)

        const { parentPublicKey, swarmTopic } = parsed

        // Store the parent's public key as a "pending" entry — will be confirmed on hello
        await ctx.db.put('pendingParent:' + parentPublicKey, { publicKey: parentPublicKey, ts: Date.now() })

        // Join the swarm topic alongside any existing parent topics (multi-parent support).
        // Old single-parent behavior deleted all existing topics here — now we keep them.
        await ctx.joinTopic(swarmTopic)

        return { ok: true, swarmTopic, parentPublicKey }
      }
```

- [ ] **Step 2: Update pendingParent check in handleHello**

In `src/bare.js` handleHello child branch, the pendingParent lookup (lines 742-744) currently checks a single `pendingParent` key. Update to check `pendingParent:{publicKey}`:

```js
    const pendingParent = await db.get('pendingParent').catch(() => null)
    if (pendingParent && pendingParent.value.publicKey === peerIdentityKeyHex) {
      await db.del('pendingParent').catch(() => {})
    }
```

becomes:

```js
    const pendingParent = await db.get('pendingParent:' + peerIdentityKeyHex).catch(() => null)
    if (pendingParent) {
      await db.del('pendingParent:' + peerIdentityKeyHex).catch(() => {})
    }
```

- [ ] **Step 3: Commit**

```bash
git add src/bare-dispatch.js src/bare.js
git commit -m "feat: allow child to accept multiple parent invites (#108)"
```

---

### Task 5: Update child unpair to handle single-parent removal

**Files:**
- Modify: `src/bare.js:484-526` (unpair case in handlePeerMessage)

- [ ] **Step 1: Replace the full-wipe unpair with selective removal**

In `src/bare.js`, replace the `case 'unpair'` block (lines 484-526):

```js
    case 'unpair': {
      // Parent has removed this child — wipe all local state and return to setup.
      // Collect keys first, then delete: avoids Hyperbee deadlock from writing
      // inside a createReadStream iteration.
      const allKeys = []
      for await (const { key } of db.createReadStream()) {
        allKeys.push(key)
      }
      for (const key of allKeys) await db.del(key).catch(() => {})

      // Rotate to a fresh identity keypair immediately in memory and DB.
      // The old keypair may be listed as blocked on the parent (blocked:{oldPK}).
      // If we keep the old keypair in memory, the next connection attempt after
      // scanning a new invite will send hello with the old blocked PK — the parent
      // rejects it, sends unpair again, and the child is stuck in a reset loop.
      // A fresh keypair is not blocked, so re-pairing succeeds in one scan.
      //
      // IMPORTANT: mutate the existing identity object in place rather than
      // reassigning the variable. The dispatch context (createDispatch) holds a
      // reference to the same object via ctx.identity. Reassigning would leave
      // ctx.identity pointing to the old keypair, so identity:setName would
      // broadcast hello with the stale public key — causing signature mismatches
      // on the parent and silently dropping the name update.
      const newKeypair = generateKeypair()
      identity.publicKey = newKeypair.publicKey
      identity.secretKey = newKeypair.secretKey
      await db.put('identity', {
        publicKey:  b4a.toString(identity.publicKey, 'hex'),
        secretKey:  b4a.toString(identity.secretKey, 'hex'),
      })

      // Destroy the in-memory Hyperswarm so it stops auto-reconnecting on old topics.
      // joinTopic() recreates the swarm lazily when the child scans a new invite.
      if (swarm) {
        try { await swarm.destroy() } catch (_e) {}
        swarm = null
      }
      peerConnected = false
      parentPeer = null

      send({ type: 'event', event: 'child:reset', data: {} })
      break
    }
```

with:

```js
    case 'unpair': {
      // A parent has removed this child.
      // Find which parent sent this unpair by looking up the identity key for this noise key.
      const senderPeer = peers.get(remoteKeyHex)
      const senderIdentityKey = senderPeer?.identityKey

      // Remove this parent's peer record and topic
      if (senderIdentityKey) {
        const peerRecord = await db.get('peers:' + senderIdentityKey).catch(() => null)
        const parentTopic = peerRecord?.value?.swarmTopic
        await db.del('peers:' + senderIdentityKey).catch(() => {})
        await db.del('pendingParent:' + senderIdentityKey).catch(() => {})
        parentPeers.delete(senderIdentityKey)

        // Leave this parent's swarm topic if no other parent uses it
        if (parentTopic) {
          let topicStillUsed = false
          for await (const { value } of db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
            if (value && value.swarmTopic === parentTopic) { topicStillUsed = true; break }
          }
          if (!topicStillUsed) {
            await db.del('topics:' + parentTopic).catch(() => {})
            if (swarm) {
              try { swarm.leave(b4a.from(parentTopic, 'hex')) } catch (_e) {}
            }
          }
        }
      }

      // Close the connection from this parent
      try { conn.destroy() } catch (_e) {}
      peers.delete(remoteKeyHex)

      // Check if any parents remain
      const remainingParents = []
      for await (const { value } of db.createReadStream({ gt: 'peers:', lt: 'peers:~' })) {
        if (value) remainingParents.push(value)
      }

      if (remainingParents.length === 0) {
        // Last parent removed - full reset (original behavior)
        const allKeys = []
        for await (const { key } of db.createReadStream()) {
          allKeys.push(key)
        }
        for (const key of allKeys) await db.del(key).catch(() => {})

        // Rotate identity keypair (see original comments for rationale)
        const newKeypair = generateKeypair()
        identity.publicKey = newKeypair.publicKey
        identity.secretKey = newKeypair.secretKey
        await db.put('identity', {
          publicKey:  b4a.toString(identity.publicKey, 'hex'),
          secretKey:  b4a.toString(identity.secretKey, 'hex'),
        })

        // Destroy swarm - no parents to reconnect to
        if (swarm) {
          try { await swarm.destroy() } catch (_e) {}
          swarm = null
        }
        parentPeers.clear()

        send({ type: 'event', event: 'child:reset', data: {} })
      } else {
        // Still have other parent(s) - just notify UI about the removed parent
        send({ type: 'event', event: 'parent:removed', data: { parentKey: senderIdentityKey } })
      }
      break
    }
```

- [ ] **Step 2: Commit**

```bash
git add src/bare.js
git commit -m "feat: selective parent removal on unpair, full reset only when last parent leaves (#108)"
```

---

### Task 6: Add co-parent invite generation (parent side)

**Files:**
- Modify: `src/bare-dispatch.js` (add `coparent:generateInvite` case)
- Modify: `src/invite.js` (add co-parent link builder/parser)

- [ ] **Step 1: Add co-parent invite link helpers to invite.js**

In `src/invite.js`, before the `module.exports` line (line 111), add:

```js
/**
 * Build a co-parent invite link. Contains the parent's public key, a new swarm
 * topic for parent-to-parent communication, and the child's public key so
 * Parent B knows which child to pair with.
 * Format: pear://pearguard/coparent?t=<base64url-payload>
 * @param {{ parentPublicKey: string, swarmTopic: string, childPublicKey: string }} payload
 * @returns {string}
 */
function buildCoparentLink (payload) {
  const json = JSON.stringify({
    p: payload.parentPublicKey ?? '',
    t: payload.swarmTopic ?? '',
    c: payload.childPublicKey ?? '',
  })
  return 'pear://pearguard/coparent?t=' + toBase64url(json)
}

/**
 * Parse a co-parent invite link.
 * @param {string} url
 * @returns {{ ok: boolean, parentPublicKey?: string, swarmTopic?: string, childPublicKey?: string, error?: string }}
 */
function parseCoparentLink (url) {
  if (typeof url !== 'string') return { ok: false, error: 'not a string' }
  const prefix = 'pear://pearguard/coparent?t='
  if (!url.startsWith(prefix)) return { ok: false, error: 'not a coparent link' }
  const encoded = url.slice(prefix.length)
  let raw
  try { raw = fromBase64url(encoded) } catch { return { ok: false, error: 'base64url decode failed' } }
  let payload
  try { payload = JSON.parse(raw) } catch { return { ok: false, error: 'JSON parse failed' } }
  const parentPublicKey = payload.p
  const swarmTopic = payload.t
  const childPublicKey = payload.c
  if (!parentPublicKey || !HEX_64.test(parentPublicKey)) return { ok: false, error: 'invalid parentPublicKey' }
  if (!swarmTopic || !HEX_64.test(swarmTopic)) return { ok: false, error: 'invalid swarmTopic' }
  if (!childPublicKey || !HEX_64.test(childPublicKey)) return { ok: false, error: 'invalid childPublicKey' }
  return { ok: true, parentPublicKey, swarmTopic, childPublicKey }
}
```

Update the module.exports:

```js
module.exports = { encodeInvite, decodeInvite, buildInviteLink, parseInviteLink, buildCoparentLink, parseCoparentLink }
```

- [ ] **Step 2: Add `coparent:generateInvite` dispatch case**

In `src/bare-dispatch.js`, add a new case after the `invite:generate` case (after line 247):

```js
      case 'coparent:generateInvite': {
        // args.childPublicKey: which child the co-parent will pair with
        const { childPublicKey } = args
        if (!childPublicKey) throw new Error('coparent:generateInvite requires childPublicKey')

        // Verify this child is actually paired with us
        const childRecord = await ctx.db.get('peers:' + childPublicKey).catch(() => null)
        if (!childRecord) throw new Error('child not paired: ' + childPublicKey.slice(0, 12))

        // Generate a random swarm topic for the parent-to-parent handshake
        const topicBuf = Buffer.allocUnsafe(32)
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
          crypto.getRandomValues(topicBuf)
        } else {
          require('sodium-native').randombytes_buf(topicBuf)
        }
        const topicHex = topicBuf.toString('hex')
        const parentPublicKey = Buffer.from(ctx.identity.publicKey).toString('hex')

        // Join the topic so we can handshake with Parent B
        await ctx.joinTopic(topicHex)

        // Build the co-parent invite link
        const { buildCoparentLink } = require('./invite')
        const inviteLink = buildCoparentLink({ parentPublicKey, swarmTopic: topicHex, childPublicKey })

        return { inviteLink, qrData: inviteLink, swarmTopic: topicHex, childPublicKey }
      }
```

- [ ] **Step 3: Commit**

```bash
git add src/invite.js src/bare-dispatch.js
git commit -m "feat: add co-parent invite generation (#108)"
```

---

### Task 7: Add co-parent accept and relay flow

**Files:**
- Modify: `src/bare-dispatch.js` (add `coparent:acceptInvite` case)
- Modify: `src/bare.js` (handle `coparent:hello` and `coparent:relay` message types)

- [ ] **Step 1: Add `coparent:acceptInvite` dispatch case**

In `src/bare-dispatch.js`, add after the `coparent:generateInvite` case:

```js
      case 'coparent:acceptInvite': {
        // args[0]: full pear://pearguard/coparent?t=... URL
        const { parseCoparentLink } = require('./invite')
        const parsed = parseCoparentLink(args[0])
        if (!parsed.ok) throw new Error('invalid coparent invite: ' + parsed.error)

        const { parentPublicKey: parentAKey, swarmTopic, childPublicKey } = parsed

        // Store Parent A's key so we can recognize the coparent:hello response
        await ctx.db.put('pendingCoparent', {
          parentAKey,
          childPublicKey,
          swarmTopic,
          ts: Date.now(),
        })

        // Join the parent-to-parent topic
        await ctx.joinTopic(swarmTopic)

        return { ok: true, swarmTopic, parentAKey, childPublicKey }
      }
```

- [ ] **Step 2: Handle `coparent:hello` in handlePeerMessage**

In `src/bare.js`, inside `handlePeerMessage` (after the `case 'unpair':` block, before `default:`), add a new case for `coparent:hello`:

```js
    case 'coparent:hello': {
      // A co-parent (Parent B) has connected on our parent-to-parent topic.
      // We are Parent A. Generate a new swarm topic for Parent B <-> Child,
      // then relay it to the child via our existing connection.
      const parentBIdentityKey = msg.payload?.publicKey
      if (!parentBIdentityKey) break
      const childPublicKey = msg.payload?.childPublicKey
      if (!childPublicKey) break

      // Generate a new topic for Parent B <-> Child
      const topicBuf = Buffer.allocUnsafe(32)
      sodium.randombytes_buf(topicBuf)
      const newTopicHex = b4a.toString(topicBuf, 'hex')

      // Tell the child to join this new topic for Parent B
      // Find the child's noise key from peers map
      let childNoiseKey = null
      for (const [noiseKey, p] of peers) {
        if (p.identityKey === childPublicKey) { childNoiseKey = noiseKey; break }
      }
      if (childNoiseKey) {
        sendToPeer(childNoiseKey, {
          type: 'coparent:relay',
          payload: { swarmTopic: newTopicHex, parentPublicKey: parentBIdentityKey },
        })
      }

      // Tell Parent B which topic to join for the child connection
      sendToPeer(remoteKeyHex, {
        type: 'coparent:childTopic',
        payload: { swarmTopic: newTopicHex, childPublicKey },
      })

      console.log('[bare] relayed co-parent topic to child and parent B:', newTopicHex.slice(0, 12))
      break
    }
```

- [ ] **Step 3: Handle `coparent:relay` on the child side**

In `src/bare.js`, inside `handlePeerMessage`, add before the `default:` case:

```js
    case 'coparent:relay': {
      // Parent A is telling us to join a new topic for Parent B.
      // Only process if we're a child.
      if (mode !== 'child') break
      const { swarmTopic: newTopic, parentPublicKey: parentBKey } = msg.payload ?? {}
      if (!newTopic || !parentBKey) break

      // Store Parent B as pending and join the new topic
      await db.put('pendingParent:' + parentBKey, { publicKey: parentBKey, ts: Date.now() })
      await joinTopic(newTopic)
      console.log('[bare] joining co-parent topic for parent B:', parentBKey.slice(0, 12))
      break
    }
```

- [ ] **Step 4: Handle `coparent:childTopic` on Parent B's side**

In `src/bare.js`, inside `handlePeerMessage`, add before the `default:` case:

```js
    case 'coparent:childTopic': {
      // Parent A is telling us (Parent B) which topic to join for the child.
      if (mode !== 'parent') break
      const { swarmTopic: childTopic, childPublicKey } = msg.payload ?? {}
      if (!childTopic || !childPublicKey) break

      // Join the child's topic - normal hello handshake will follow
      await joinTopic(childTopic)

      // Clean up the pending coparent state
      await db.del('pendingCoparent').catch(() => {})

      console.log('[bare] joining child topic as co-parent:', childTopic.slice(0, 12))
      send({ type: 'event', event: 'coparent:joined', data: { childPublicKey, swarmTopic: childTopic } })
      break
    }
```

- [ ] **Step 5: Send `coparent:hello` when Parent B connects to Parent A**

In `src/bare.js`, in `onPeerConnection` (after the child hello block, around line 326), add a parent co-parent hello:

```js
  // Parent B sends coparent:hello if we have a pending coparent handshake
  if (mode === 'parent') {
    const pendingCp = await db.get('pendingCoparent').catch(() => null)
    if (pendingCp && pendingCp.value) {
      const myIdentityHex = b4a.toString(identity.publicKey, 'hex')
      const coparentHello = signMessage({
        type: 'coparent:hello',
        payload: {
          publicKey: myIdentityHex,
          childPublicKey: pendingCp.value.childPublicKey,
        },
      }, identity)
      peers.get(remoteKeyHex).sentHello = true
      conn.write(Buffer.from(JSON.stringify(coparentHello) + '\n'))
    }
  }
```

- [ ] **Step 6: Commit**

```bash
git add src/bare.js src/bare-dispatch.js
git commit -m "feat: add co-parent invite accept and relay flow (#108)"
```

---

### Task 8: Build and test on device

**Files:** None (build/deploy only)

- [ ] **Step 1: Build bare and UI**

```bash
npm run build:bare
npm run build:ui
```

- [ ] **Step 2: Build APK**

```bash
cd android && ./gradlew assembleDebug && cd ..
```

- [ ] **Step 3: Install on both devices**

```bash
adb -s <parent1-serial> install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s <parent2-serial> install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s <child-serial> install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 4: Test Flow 1 - child scans second invite**

1. Parent A generates invite, child scans - verify pairing works (existing flow)
2. Parent B generates invite, child scans - verify child connects to both parents
3. Verify both parents receive heartbeats and usage reports
4. Parent A sets policy - verify child enforces it
5. Parent B changes policy - verify child enforces the new policy (last-write-wins)

- [ ] **Step 5: Test Flow 2 - parent-to-parent invite**

1. Parent A is already paired with child
2. Parent A generates co-parent invite from child detail screen
3. Parent B scans the co-parent QR
4. Verify Parent B auto-pairs with child without touching the child device
5. Verify both parents see child status

- [ ] **Step 6: Test unpair scenarios**

1. Parent A unpairs child - verify Parent B connection stays active
2. Parent B unpairs child - verify child resets to setup (last parent removed)
