# Design: Force Profile Name at Setup (TODO #1)

**Date:** 2026-03-23
**Status:** Approved

---

## Problem

All new users default to `'PearGuard Device'` as their display name because nothing forces them to set one. This name appears in `hello` messages, so the other device shows "PearGuard Device" in its peer list instead of a real name.

## Decision

Add a mandatory name entry step to `app/setup.tsx` after mode selection, before any further navigation. The step is the same for both roles — parent and child — just with different next destinations.

## Flow

```
Parent: mode → name → pin → navigate to /
Child:  mode → name → navigate to /child-setup
```

## Changes

### `app/setup.tsx`

- Expand `step` state type from `'mode' | 'pin'` to `'mode' | 'name' | 'pin'`.
- Add `selectedMode` state (`'parent' | 'child' | null`) to remember the chosen role while the name step is shown.
- **`selectMode`**: instead of transitioning to `'pin'` (parent) or navigating (child), set `selectedMode` and transition to `'name'`.
- **`handleSetName`**: new async handler.
  - Validation: trim the value; if empty, show "Name is required."; if longer than 30 characters, show "Name must be 30 characters or fewer."
  - On valid input: call `_callBare('identity:setName', { name })`.
  - On success: if `selectedMode === 'parent'` → `setStep('pin')`; if `selectedMode === 'child'` → `router.replace('/child-setup')`.
  - On `identity:setName` failure: show error message, stay on name step.
- **Name step UI**: single `TextInput` (default keyboard), "Your name" placeholder, max length 30, "Continue" button. Same dark styling as the PIN step (`styles.container`, `styles.title`, `styles.form`, `styles.input`, `styles.btnSave`).
- No skip option — name is required.

### `bare.js` / `bare-dispatch.js`

No changes. `identity:setName` already exists. `hello` messages already read `profile.displayName` with `'PearGuard Device'` as fallback — that fallback remains but is unreachable for users who complete setup.

## Validation Rules

| Rule | Error message |
|------|---------------|
| Empty after trim | "Name is required." |
| Longer than 30 chars | "Name must be 30 characters or fewer." |

## Testing

- **Empty name**: shows "Name is required.", does not call `identity:setName`.
- **Name > 30 chars**: shows "Name must be 30 characters or fewer.", does not call `identity:setName`.
- **Valid name (parent)**: calls `identity:setName`, transitions to pin step.
- **Valid name (child)**: calls `identity:setName`, navigates to `/child-setup`.
- **`identity:setName` failure**: shows error, stays on name step.
