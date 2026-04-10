# Co-Parent Dashboard Entry Point (#127)

## Problem

There is no way to initiate or accept a co-parent pairing from the Dashboard or onboarding flow. The only entry point is buried inside ChildDetail (Parent A's side). Parent B has no UI to accept a co-parent invite - they must rely on deep links, which are broken on iOS (INVALID_INVITE error).

## Scope

1. Dashboard "Join as Co-Parent" button and inline card (Parent B's entry point)
2. Fix iOS and Android deep link handling for co-parent invites
3. Info text explaining co-parent vs regular pairing

Out of scope: onboarding changes, co-parent management/removal UI.

## Design

### 1. Dashboard UI

A "Join as Co-Parent" button appears alongside the existing "Add Child" button in the Dashboard header. Tapping it toggles a `JoinCoparentCard` component below the header.

**JoinCoparentCard contents:**
- Info text: "If another parent already set up your child's device, ask them to share a co-parent invite. This lets you both manage the same child with shared policies."
- "Scan QR Code" button - calls `qr:scan`, then `coparent:acceptInvite` with the scanned URL
- "Paste Invite Link" text input with a submit button - validates the URL starts with `pear://pearguard/coparent?t=`, then calls `coparent:acceptInvite`
- State flow: idle -> scanning/pasting -> connecting -> success/error
- On success: dismiss the card, refresh the children list (new child appears)
- On error: show error message with retry option

**New file:** `src/ui/components/JoinCoparentCard.jsx`

**Modified file:** `src/ui/components/Dashboard.jsx` - add button and conditionally render JoinCoparentCard

### 2. Deep Link Fixes

**Android (`app.json`):** Add a second intent filter entry with `pathPrefix: "/coparent"` so tapping a `pear://pearguard/coparent?t=...` link opens the app.

**iOS (`app/coparent.tsx`):** Debug and fix the INVALID_INVITE error. Likely cause: the `t` search param arrives percent-encoded from iOS URL handling, and the reconstructed URL `pear://pearguard/coparent?t=${t}` passes a double-encoded string to `parseCoparentLink`. Fix by decoding the param if needed.

**Cold start:** Verify the `_pendingInviteUrl` buffering in `app/index.tsx` works for co-parent links on cold start (the `url.includes('/coparent?')` check should handle this already).

### 3. Info Note

The explanatory text lives inside `JoinCoparentCard` only - no separate banner, no onboarding changes. The setup screen remains parent/child only.

## Files Changed

| File | Change |
|------|--------|
| `src/ui/components/JoinCoparentCard.jsx` | New - scan/paste UI for accepting co-parent invites |
| `src/ui/components/Dashboard.jsx` | Add "Join as Co-Parent" button, render JoinCoparentCard |
| `app.json` | Add `/coparent` intent filter for Android deep links |
| `app/coparent.tsx` | Fix URL encoding issue causing INVALID_INVITE on iOS |
