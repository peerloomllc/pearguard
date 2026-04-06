# Multi-Parent Pairing Design Spec

**Date:** 2026-04-06
**Issue:** #108
**Approach:** Multi-connection child (Approach A)

## Overview

Allow multiple parent devices to pair with a single child device. Target use case: two-parent household where both parents manage the same child from independent devices.

## Requirements

- Either parent can set policy (last-write-wins)
- Both parents see all dashboard data (usage reports, alerts, time requests)
- Either parent can respond to time requests (first response wins)
- Two pairing methods: child scans a second invite, or parent-to-parent invite

## 1. Child-Side Connection Model

**Current:** Single `peerConnected` boolean + `parentPeer` reference.

**New:** A `parentPeers` Map keyed by identity public key. Each entry holds `{ conn, remoteKeyHex, displayName, topicHex }`.

- `sendToParent()` becomes `sendToAllParents()` - iterates the map and writes to every connected parent. Failed writes remove that entry.
- `acceptInvite` no longer deletes existing swarm topics - it joins the new topic alongside existing ones. The child ends up on N swarm topics, one per parent.
- The `peers:` Hyperbee entries already support multiple parents since they're keyed by public key.

## 2. Pairing Flows

### Flow 1: Child Scans a Second Invite (existing flow, relaxed)

Today `acceptInvite` wipes old topics. The change: skip that cleanup, just join the new topic alongside existing ones. The hello handshake works as-is - each parent gets its own `peers:{publicKey}` entry on the child.

### Flow 2: Parent-to-Parent Invite

New dispatch methods for co-parent pairing without touching the child device again.

Message flow:
1. Parent A calls `coparent:generateInvite` - returns a link containing `{ swarmTopic, childPublicKey, parentPublicKey }`
2. Parent B scans the link, calls `coparent:acceptInvite` - joins the swarm topic, connects to Parent A via Hyperswarm
3. Parent A and Parent B exchange a new `coparent:hello` P2P message type (distinct from the child hello) to authenticate each other. Parent A verifies Parent B is a legitimate parent (not a child device).
4. Parent A generates a new swarm topic for the Parent B <-> Child connection, then sends a `coparent:relay` P2P message to the connected child containing `{ newSwarmTopic, parentBPublicKey }`
5. Child joins the new swarm topic. Parent B also joins it (communicated back via Parent A).
6. Child and Parent B complete the normal hello handshake on the new topic.

## 3. Policy and Data Broadcasting

**Policy (parent -> child):** No change to the message format. Either parent sends `policy:update`, child stores it under `policy` (singular key, last-write-wins). Child enforces whatever it received most recently.

**Reports/alerts/requests (child -> parents):** `sendToAllParents()` iterates `parentPeers` and writes to each connected parent. Message types unchanged: `heartbeat`, `usage:report`, `app:installed`, `app:uninstalled`, `apps:sync`, `time:request`, `bypass:alert`, `pin:override`. Each parent receives an independent copy.

**Request responses (parent -> child):** Either parent can respond to a `time:request`. The child processes whichever response arrives first. If both parents respond, the second is a no-op (request already resolved). No conflict resolution needed.

**Reconnect backfill:** Each parent stores its own decisions and pushes them independently on child reconnect. No changes needed.

## 4. Parent-Side Changes

Minimal. Parents don't need to know about each other at the data layer. Each parent independently:
- Pairs with the child (gets its own `peers:{childPubKey}` entry)
- Sends/receives policy and reports
- Responds to requests

New parent-side code is only for the co-parent invite flow (Flow 2):
- `coparent:generateInvite` - creates a new swarm topic, builds a link with the child's public key
- `coparent:acceptInvite` - parses the link, joins the topic, handshakes with Parent A, then gets relayed to the child
- Handling the `coparent:hello` message from Parent B (relay the child's new topic)

**Dashboard:** No changes needed. Each parent has its own local Hyperbee with usage reports, alerts, and request records populated from the child's messages.

**Caveat:** Parents won't see each other's policy changes. If Parent A sets a bedtime and Parent B changes it, Parent A's dashboard still shows the old value until the child sends back a status update reflecting the new policy. Acceptable for last-write-wins in a shared household.

## 5. Unpair and Cleanup

**Parent unpairs child:** Works as today. `child:unpair` sends the `unpair` message, writes `blocked:{childPubKey}`, deletes records. The other parent is unaffected.

**Child gets unpaired by one parent:** The child removes only that parent's `peers:` entry and leaves that parent's swarm topic. Other parent connections stay intact. Today's `unpair` handler destroys the entire swarm and rotates the identity keypair - that changes to:
- Delete `peers:{unparingParentPubKey}`
- Leave that parent's swarm topic
- Keep identity intact (other parent still knows this keypair)

**Child gets unpaired by all parents:** When the last parent unpairs, the child returns to the fresh/setup state. Identity rotation happens here (no remaining parents know the old key).

**Co-parent awareness of unpair:** If Parent A unpairs the child, Parent B has no way to know (they're independent). Acceptable for the household use case - no automated cross-parent notification needed.
