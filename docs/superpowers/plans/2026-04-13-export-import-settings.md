# Export / Import Settings (TODO #137)

Two features sharing infrastructure, different purposes.

## 1. Device Backup (global)

**Purpose:** Move a parent device to new hardware, or disaster recovery. Restores full paired state.

**Location:** Settings tab → new "Device Backup" section.

**Export payload (signed JSON):**
```
{
  version: 1,
  kind: "device-backup",
  exportedAt: <ms>,
  identity:       <from identity key>,
  profile:        <from profile key>,
  parentSettings: <from parentSettings key>,
  peers:          [ <all peers:* values> ],
  policies:       { <childPubKey>: <policy:{childPubKey}> for every paired child }
}
```
Signed with identity.secretKey (self-signed; signature verifies payload integrity, not authenticity against a third party).

**Excluded:** `override:*`, `alert:*`, `usageReport:*`, `sessions:*`, `request:*`, `topics:*`, `blocked:*`, `pendingInviteTopic:*`, `pendingParent:*`. These are ephemeral or reconstructable. `pinPlain` must be stripped; `pinHash` kept.

**Import precondition:** Fresh install only — refuse import if `identity` already exists in Hyperbee. User must uninstall/clear data first. Prevents stale-state corruption on a live device.

**Import action:** Write identity, profile, parentSettings, every peers:* and policy:* key. On next swarm init, normal self-heal (bare.js:149) rejoins every peer.swarmTopic. Children reconnect automatically when online.

**Security note:** Backup file contains identity.secretKey. Treat as equivalent to the device itself. UI warns user; suggest storing in password manager or encrypted cloud. v1 ships unencrypted; passphrase encryption is a v2 follow-up.

## 2. Copy Rules (per-child)

**Purpose:** Clone policy from one child to another. Share known-good config with co-parent.

**Location:** ChildDetail header → "Export Rules" / "Import Rules" buttons.

**Export payload (signed JSON):**
```
{
  version: 1,
  kind: "child-rules",
  exportedAt: <ms>,
  sourceChildPubKey: <hex>,
  policy: <policy:{childPubKey}, with childPublicKey field stripped>
}
```

**Import action:** Pick a target child from the paired list. Show a diff preview (apps changed, schedules changed). On confirm: merge into target's `policy:{targetChildPubKey}` — replace `apps` and `schedules`; preserve `pinHash`, `locked`, `lockMessage` (those are target-device specific). Broadcast `policy:update` to the target child (existing dispatch in bare-dispatch.js:1197).

**No signature verification beyond self-sign** — user is trusting the file they picked.

## Implementation

### Bare layer (`src/bare-dispatch.js`)

New dispatch methods:
- `backup:export` → returns signed JSON string.
- `backup:import` → takes JSON string, verifies signature against embedded identity.publicKey, checks precondition, writes keys, returns `{ok, paired: [childPubKey,...]}`. Caller (RN) restarts swarm after.
- `rules:export` → `{childPubKey}` → returns signed JSON string.
- `rules:import:preview` → `{jsonString, targetChildPubKey}` → returns `{sourceChildPubKey, appsAdded, appsRemoved, appsChanged, schedulesChanged}`.
- `rules:import:apply` → `{jsonString, targetChildPubKey}` → writes merged policy, broadcasts to child.

Helpers in new `src/backup.js`: `buildBackup(bee, identity)`, `buildRulesExport(bee, childPubKey, identity)`, `verifyAndParse(jsonString)`.

### RN shell (`app/index.tsx`)

Add bridges for file share + picker:
- `expo-sharing` for export (write JSON to cache dir, share sheet).
- `expo-document-picker` for import (returns file URI, RN reads, forwards to bare).

New IPC passthrough methods (thin): `backup:saveToFile`, `backup:loadFromFile`, same for rules.

After `backup:import` succeeds, RN tears down swarm and re-initializes from the freshly-written identity.

### UI (`src/ui/`)

- `components/Settings.jsx`: new "Device Backup" card with Export + Import buttons and security warning.
- `components/ChildDetail.jsx`: header actions menu → Export Rules, Import Rules.
- `components/ImportRulesDiff.jsx` (new): shows diff preview, Apply/Cancel.
- First-run gate: if `backup:import` attempted on a non-fresh install, surface error with instructions to clear app data.

### Tests (`npx jest` — logic only)

- `backup.test.js`: round-trip export/import of a synthetic bee snapshot; signature tampering rejected; version mismatch rejected.
- `rules-diff.test.js`: diff computation across policy variants.

### Out of scope for v1
- Passphrase encryption of backup file.
- Selective per-child restore from a full backup.
- Contacts (#85 is not yet a stored namespace).
- Cross-platform backup compat testing (Android ↔ iOS) — worth a manual pass but not gated.

## Ordering

1. `src/backup.js` + jest tests (pure logic, no device needed).
2. Bare dispatch methods + build:bare + build:ui + install; test Copy Rules first (safer, per-child).
3. Device Backup export + import flow; test on Android parent device with fresh install.
4. iOS parity pass.

## Risk log

- **Backup file leaks identity.secretKey.** v1 mitigates with UI warning only. v2: passphrase-encrypt.
- **Stale backup restored over live install.** Mitigated by fresh-install precondition.
- **Swarm restart after import** needs clean teardown — verify no leaked listeners/topics from pre-restore state. Easiest: full RN reload after import, not just swarm.destroy().
- **Child offline at restore time.** Expected; reconnects when online. Document in UI ("children will reconnect when they come online").
