# Co-Parent Invite UI (#110)

## Summary

Add UI for Parent A to generate a co-parent invite link for a specific child, and for Parent B to accept that link and join as a second parent. The backend (`coparent:generateInvite`, `coparent:acceptInvite`, and the full P2P handshake) already exists - this is purely a UI and deep link routing change.

## Scope

- Parent A: button + invite card in child detail view
- Parent B: deep link acceptance for `pear://pearguard/coparent?t=...` URLs
- Only handles the case where Parent B is already set up as a parent device

## Design

### 1. Trigger - "Invite Co-Parent" button in ChildDetail

A labeled button at the bottom of the `ChildDetail` view, below the tab content area. Uses the existing `Button` component with a `UserPlus` icon and "Invite Co-Parent" label. Toggles a boolean `coparentInviteActive` state.

**File:** `src/ui/components/ChildDetail.jsx`

### 2. CoparentInviteCard component

A new component following the same visual pattern as `InviteCard.jsx`:

- **Title:** "Invite Co-Parent"
- **Subtitle:** "Share this with another parent to co-manage [child name]'s device"
- **QR code** canvas rendered from the invite link
- **"Share Link"** and **"Copy Link"** buttons (same as InviteCard)
- **Status text:** "Waiting for co-parent to connect..."
- **Dismiss (X)** button in the corner

**On mount:** Calls `coparent:generateInvite` with `{ childPublicKey }`.

**On success:** Listens for `coparent:joined` event. When received, calls `onConnected` callback to dismiss the card.

**Props:** `{ childPublicKey, childDisplayName, onConnected, onDismiss }`

**File:** `src/ui/components/CoparentInviteCard.jsx`

### 3. Deep link routing for Parent B

Currently, `app/index.tsx` line 66 sends all `pearguardLink` events to `acceptInvite`. This needs to detect coparent links and route them to `coparent:acceptInvite` instead.

**Detection:** Check if the URL contains `/coparent?` - if so, call `coparent:acceptInvite`; otherwise call `acceptInvite` as before.

**File:** `app/index.tsx` (module-level `pearguardLink` listener)

### 4. Android intent filter

Add a new intent filter for the `/coparent` path so Android routes `pear://pearguard/coparent?t=...` URLs to the app.

**File:** `android/app/src/main/AndroidManifest.xml`

### 5. Expo Router screen

Add `app/coparent.tsx` (or reuse `app/join.tsx` with path detection) to handle the `/coparent` deep link route. It reconstructs the URL and emits `pearguardLink`, same pattern as `join.tsx`.

**File:** `app/coparent.tsx` (new) or `app/join.tsx` (modified)

## Files Changed

| File | Change |
|------|--------|
| `src/ui/components/CoparentInviteCard.jsx` | New - invite card component |
| `src/ui/components/ChildDetail.jsx` | Add invite button + card rendering |
| `app/index.tsx` | Route coparent links to `coparent:acceptInvite` |
| `app/coparent.tsx` | New - Expo Router screen for `/coparent` deep links |
| `android/app/src/main/AndroidManifest.xml` | Add `/coparent` intent filter |

## Out of Scope

- Fresh install flow for Parent B (setup + accept in one flow)
- Co-parent management UI (viewing/removing co-parents)
- Notifications when a co-parent joins
