# Apps Tab Animation Design

## Overview

Add slide/fade animations to AppsTab when apps move between Pending, Allowed, and Blocked groups after approve/deny actions.

## Animation Behavior

### Individual Approve/Deny/Toggle

1. User taps Approve, Deny, or toggles the Allowed/Blocked checkbox
2. The row fades out + slides left over 300ms
3. After fade completes, state updates (row moves to new group)
4. The row fades in + slides from right in its new group over 300ms

### Batch Approve All / Deny All

1. User taps batch button
2. The entire expanded section content fades out over 250ms
3. State updates, section counts refresh
4. The destination section content fades in over 250ms

## Implementation

### Keyframe Animations

A `<style>` block in AppsTab defines four keyframes:

- `fadeSlideOut` - opacity 1 to 0, translateX(0) to translateX(-20px), 300ms
- `fadeSlideIn` - opacity 0 to 1, translateX(20px) to translateX(0), 300ms
- `fadeOut` - opacity 1 to 0, 250ms (batch section fade)
- `fadeIn` - opacity 0 to 1, 250ms (batch section fade)

### New State

- `animatingItems` - Map of packageName to `{ phase: 'exiting' | 'entering' }` for items mid-animation
- `animatingSection` - key of section currently fading for batch operations

### Flow (Individual)

1. `handleDecide` / `handleUpdate` (checkbox toggle): instead of immediately updating policy, set the item as "exiting" in `animatingItems`
2. After 300ms timeout, update policy state and set item as "entering"
3. After another 300ms, clear from `animatingItems`

### Flow (Batch)

1. `handleBatchDecide`: set `animatingSection` to the source section key with phase "exiting"
2. After 250ms, update policy state and set phase to "entering"
3. After another 250ms, clear `animatingSection`

### Component Changes

- `AppRow` receives an `animationStyle` prop - when set, applies the animation CSS
- `StatusSection` / `CategorySection` content wrapper gets opacity/animation style during batch operations

## Scope

- Only modifies `src/ui/components/AppsTab.jsx`
- No new dependencies
- No changes to IPC, bare.js, or other components
