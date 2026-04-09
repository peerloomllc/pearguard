# Co-Parent PIN Support & Request Decision Sync

**Date:** 2026-04-09
**Bugs:** #120, #122

## Problem

### #120 - Multi-Parent PIN Conflict
Two parents with different PINs overwrite each other. The child stores a single `pinHash` string in its policy object. Whichever parent last called `pin:set` wins - the other parent's PIN stops working on the child's block overlay.

### #122 - Request Decisions Not Syncing to Co-Parents
When Parent A approves or denies a child's request (app unlock or extra time), Parent B's activity list still shows it as pending. Each parent stores requests independently in their own Hyperbee (`request:{id}`). There is no mechanism to notify other parents when a decision is made.

## Solution

### #120 - Per-Parent PIN Hashes

Replace the single `pinHash: string` field with `pinHashes: { [parentPublicKey]: string }` in child policy objects.

#### Parent `pin:set` (bare-dispatch.js)

When a parent sets a PIN:
- Hash the PIN with BLAKE2b (unchanged)
- Store in parent's own `policy.pinHash` (unchanged, for local use)
- When propagating to child policies (`policy:{childPublicKey}`), set `policy.pinHashes[myPublicKey] = hashStr` instead of `policy.pinHash = hashStr`
- Delete the legacy `pinHash` field from child policy objects

#### Child policy merge (bare-dispatch.js, `handlePolicyUpdate`)

Currently the child replaces its entire policy object with the incoming payload. This must change to a merge for `pinHashes`:

- When receiving `policy:update`, merge incoming `pinHashes` into existing `pinHashes` (so Parent A's hash is preserved when Parent B sends an update)
- All other policy fields (apps, version, etc.) continue to use the incoming values as-is
- Accept the update only if `payload.version >= existing.version` (existing behavior)

#### Native PIN verification (AppBlockerModule.java)

`verifyPin()` changes:
- Read `pinHashes` JSONObject from policy
- Iterate over all values (hex hash strings)
- If the entered PIN's BLAKE2b hash matches any value, return true
- Fallback: if `pinHashes` is missing/empty, check legacy `pinHash` field (migration support)

#### Migration

No explicit migration step needed. The first `pin:set` call after this change writes `pinHashes` and removes `pinHash`. The native verifier checks both fields, so old policies still work until the next PIN set. The child-side merge logic also handles the case where an incoming policy still has `pinHash` (from a parent that hasn't updated yet) by converting it to `pinHashes` format on receipt.

### #122 - Child Relays Decisions to All Parents

After the child processes a decision, it broadcasts the resolution to all connected parents.

#### Child broadcasts `request:resolved` (bare-dispatch.js)

Add a broadcast after each decision handler:

- `handleAppDecision` - after updating local request status
- `handleTimeExtend` - after updating local request status
- `request:denied` handler - after updating local request status

Broadcast message:
```json
{
  "type": "request:resolved",
  "payload": {
    "requestId": "req:1712345678:com.example.app",
    "status": "approved" | "denied",
    "packageName": "com.example.app",
    "resolvedAt": 1712345999
  }
}
```

Uses `sendToAllParents()` to reach all connected parents.

#### Parent receives `request:resolved` (bare.js + bare-dispatch.js)

New P2P message handler:
- Look up `request:{requestId}` in parent's Hyperbee
- If found and status is `pending`, update to the resolved status
- Emit `request:updated` event so ActivityTab refreshes in real-time

If the request entry doesn't exist (parent wasn't connected when request came in), ignore the message - the parent will get the resolved status if/when the child re-sends.

#### Backfill on reconnect (bare.js, hello handshake)

When a parent reconnects to a child:
- Child sends all recently-resolved requests (last 7 days) as part of the hello response
- Uses a new `resolved:requests` field in the hello payload
- Parent processes each one the same as a `request:resolved` message

This handles the case where Parent B was offline when Parent A made a decision.

## Files to Change

| File | Changes |
|------|---------|
| `src/bare-dispatch.js` | `pin:set` writes `pinHashes`; `handlePolicyUpdate` merges `pinHashes`; decision handlers broadcast `request:resolved`; new `handleRequestResolved` function; hello handshake includes resolved requests |
| `src/bare.js` | New `request:resolved` case in `handlePeerMessage`; hello handshake sends resolved requests |
| `android/.../AppBlockerModule.java` | `verifyPin()` iterates `pinHashes` with `pinHash` fallback |

## Data Shape Changes

### Policy object (child side)

Before:
```json
{
  "pinHash": "abc123...",
  "apps": { ... },
  "version": 5,
  "childPublicKey": "def456..."
}
```

After:
```json
{
  "pinHashes": {
    "parentA_publicKey_hex": "abc123...",
    "parentB_publicKey_hex": "xyz789..."
  },
  "apps": { ... },
  "version": 6,
  "childPublicKey": "def456..."
}
```

### Hello payload addition

```json
{
  "resolvedRequests": [
    { "requestId": "req:...", "status": "approved", "packageName": "...", "resolvedAt": 1712345999 },
    ...
  ]
}
```

## Edge Cases

- **Parent removed:** If a parent is unpaired, their pinHash entry persists in `pinHashes` until the remaining parent sets a new PIN (which triggers a fresh policy push). This is acceptable - an orphaned hash doesn't create a security issue since the removed parent's PIN was known to the family.
- **All parents offline during decision:** The child stores the resolved status locally. On reconnect, the hello backfill delivers it.
- **Race condition - two parents decide simultaneously:** Both decisions reach the child. The child processes them sequentially (single-threaded JS). The second decision is a no-op if the request is already resolved. Both parents get the `request:resolved` broadcast.
