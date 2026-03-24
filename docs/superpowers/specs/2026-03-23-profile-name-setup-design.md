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
- Add `name` state (`string`, default `''`) for the name input value.
- **`selectMode`**: calls `_callBare('setMode', [mode])` as before (with `loading` guard), then calls `setLoading(false)`, sets `selectedMode`, and transitions `step` to `'name'` (instead of navigating directly).
- **`handleSetName`**: new async handler.
  - Guard: `if (!_callBare) return`.
  - Validation: trim the value; if empty, show "Name is required." and return.
  - Set `loading(true)`, clear error.
  - Call `_callBare('identity:setName', { name: name.trim() })`.
  - On success: `setLoading(false)`; if `selectedMode === 'parent'` → `setStep('pin')`; if `selectedMode === 'child'` → `router.replace('/child-setup')`.
  - On failure: show error message, `setLoading(false)`, stay on name step.
- **Name step UI**:
  - Single `TextInput` (default keyboard), placeholder `"Your name"`, `maxLength={30}` (enforces character limit at the input level — no length check needed in the handler), `value={name}`, `onChangeText` sets name state and calls `setError(null)`.
  - "Continue" `TouchableOpacity` button calls `handleSetName`.
  - Reuses existing styles: `styles.container`, `styles.title`, `styles.subtitle`, `styles.form`, `styles.label`, `styles.input`, `styles.btnSave`, `styles.btnSaveText`, `styles.error`.
  - While `loading` is `true`, show `<ActivityIndicator>` instead of the form (same pattern as pin step).
- No skip option — name is required.

### `bare.js` / `bare-dispatch.js`

No changes. `identity:setName` already exists. `hello` messages already read `profile.displayName` with `'PearGuard Device'` as fallback — that fallback remains but is unreachable for users who complete setup.

## Validation Rules

| Rule | Where enforced | Error message |
|------|----------------|---------------|
| Empty after trim | `handleSetName` | "Name is required." |
| Longer than 30 chars | `TextInput maxLength={30}` | (input prevents entry — no handler check needed) |

## Testing

- **Empty name**: shows "Name is required.", does not call `identity:setName`.
- **Valid name (parent)**: calls `identity:setName` with trimmed value, transitions to pin step.
- **Valid name (child)**: calls `identity:setName` with trimmed value, navigates to `/child-setup`.
- **`identity:setName` failure**: shows error message, stays on name step.
