# Design: Default Policy (TODO #30) + Required PIN Setup (TODO #31)

**Date:** 2026-03-23
**Status:** Approved

---

## #30 — Default Policy for Apps at Initial Pairing

### Problem
When a child pairs for the first time, all installed apps arrive via `apps:sync`. Currently every app defaults to `status: 'pending'`, causing the block overlay to fire every time the child opens any app. This makes the device unusable until the parent individually approves every app.

### Decision
Default status for apps at **initial pairing** is `allowed`. The parent blocks selectively.

### Change
- **`handleIncomingAppsSync`** (`src/bare-dispatch.js`): When `isFirstSync` is `true`, set `status: 'allowed'` instead of `'pending'`.
- **`handleIncomingAppInstalled`** and subsequent incremental `handleIncomingAppsSync` calls: keep `status: 'pending'` — new installs after pairing still require parent review.
- **Policy push on first sync**: The `sendToPeer` call **must fire unconditionally** when `newCount > 0` — move it before (outside of) the existing `if (!isFirstSync)` guard. The child needs the `allowed` policy delivered immediately so no overlay fires when they open their apps. Only the per-app alert entries and `app:installed` events remain suppressed inside the `!isFirstSync` block.

### Data flow
No policy shape changes. The `status` field already supports `'allowed'`.

---

## #31 — Require Override PIN Before First Use

### Problem
Without a PIN, a child can never request access to a blocked app, making the blocking system useless. Currently nothing prevents a parent from using the app without ever setting a PIN.

### Decision
- PIN is mandatory for parents — they cannot reach the dashboard without one.
- Applies to both new setups and existing installs with no PIN stored.
- PIN is entered twice to confirm (entry + confirm fields).
- PIN format: at least 4 digits, digits only — consistent with `Settings.jsx` which validates both `newPin.length < 4` and `!/^\d+$/.test(newPin)`. Both new PIN forms must apply the same two validations.
- Settings.jsx remains the way to change an existing PIN. Gate 2 only fires when no PIN is stored at all.

### Gate 1 — New parents (`app/setup.tsx`)

Add a `step` state (`'mode' | 'pin'`). Flow:

1. Parent taps "I'm a Parent"
2. `setMode('parent')` is called (same as now)
3. `step` transitions to `'pin'` — PIN setup view renders inline
4. Parent enters PIN (≥4 digits, digits only), then enters it again in a confirm field
5. Validation: digits-only + min-length on the entry field; "PINs do not match." on mismatch (canonical string matching Settings.jsx) — clear the confirm field only
6. On success: call `_callBare('pin:set', { pin })`, then `router.replace('/')`

**`_callBare` type update**: Update both `_callBare` (module-level variable) and `setBareCaller` (exported setter) from `(method: string, args: any[]) => Promise<any>` to `(method: string, args: any) => Promise<any>`. The existing `setMode` call `_callBare('setMode', [mode])` continues to work — passing an array is valid under `any`.

### Gate 2 — Existing parents with no PIN (`src/ui/components/ParentApp.jsx`)

On mount, `ParentApp` calls `window.callBare('pin:isSet', {})` (using the global injected by the IPC bridge, matching the pattern used in `Settings.jsx`).

- **While the call is in-flight**: render a blank/loading overlay — the dashboard is not accessible until the check resolves.
- **If `isSet` is `false`**: render a full-screen PIN setup overlay (same two-input form as Gate 1 with same validations). Once `pin:set` succeeds, dismiss the overlay and render the dashboard.
- **If `isSet` is `true`**: render the dashboard normally.
- **If the call rejects** (DB error, worklet not yet ready): treat as not set — show the PIN gate. **Known tradeoff**: a transient IPC failure will force the parent to re-set their PIN even if one was already stored. This is accepted — the PIN form is fast to complete and the failure case is rare. It is preferable to accidentally locking a parent out of a dashboard with no PIN gate than to showing an unsecured dashboard due to a failed check.

Gate 2 does not reappear once a PIN is stored. The parent changes their PIN via Settings.jsx.

### New bare dispatch method: `pin:isSet`

```js
case 'pin:isSet': {
  // Reads the parent's own 'policy' key — NOT a per-child 'policy:{childPK}' key.
  // pin:set stores pinHash here (ctx.db.put('policy', policy)).
  // valueEncoding: 'json' means raw.value is already a parsed JS object.
  const raw = await ctx.db.get('policy')
  return { isSet: !!(raw && raw.value && raw.value.pinHash) }
}
```

Simple read — no args required.

### Error handling
- PIN fails digits-only or min-length: show inline validation error, do not proceed.
- Mismatch between entry and confirm fields: show "PINs do not match." inline, clear the confirm field only.
- `pin:set` failure: show error message, stay on PIN screen.
- `pin:isSet` failure or rejection: treat as not set — show PIN gate.

### Testing
- Unit test `pin:isSet`: returns `{ isSet: true }` when `pinHash` present, `{ isSet: false }` when absent or DB empty.
- UI test for `setup.tsx` PIN step: non-digit or short PIN shows validation error; mismatched PINs show "PINs do not match." and clear confirm; matching valid PINs call `pin:set` and navigate.
- UI test for `ParentApp` gate: renders loading state while `pin:isSet` is pending; renders PIN overlay when `{ isSet: false }`; dismisses after `pin:set` succeeds; renders dashboard when `{ isSet: true }`.
