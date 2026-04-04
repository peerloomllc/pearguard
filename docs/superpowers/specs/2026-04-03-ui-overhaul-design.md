# PearGuard UI Overhaul Design

**Date:** 2026-04-03
**TODO:** #87 - UI overhaul session

## Overview

Full visual redesign of PearGuard across all screens. Introduces a centralized design system (theme, component primitives, Phosphor icons, bundled font), dark mode as default with light mode support, a pear-themed color palette, consolidated navigation, and a new quick-lock feature. Every component migrates from hardcoded inline styles to theme tokens.

## Design System Foundation

### Theme File (`src/ui/theme.js`)

Single source of truth for all visual tokens. Exports dark and light palettes, with a `useTheme()` hook providing the current palette. Theme preference stored in Hyperbee alongside mode. Default: dark.

### Color Palette (Pear-Themed)

| Token | Dark Mode | Light Mode | Usage |
|-------|-----------|------------|-------|
| `primary` | #4CAF50 | Same | Buttons, active states, accents |
| `primaryLight` | #81C784 | Same | Hover states, tinted backgrounds |
| `secondary` | #FFB74D | Same | Badges, warnings, highlights |
| `error` | #EF5350 | Same | Blocked, denied, alerts |
| `success` | #66BB6A | Same | Approved, connected |
| `surface.base` | #0D0D0D | #FAFAF8 | Page background |
| `surface.card` | #1A1A1A | #FFFFFF | Card background |
| `surface.elevated` | #252525 | #F0F0EC | Elevated elements, borders |
| `surface.input` | #333333 | #E8E8E4 | Input backgrounds |
| `text.primary` | #F0F0F0 | #1A1A1A | Primary text |
| `text.secondary` | #A0A0A0 | #555555 | Secondary text |
| `text.muted` | #666666 | #999999 | Hints, captions |

### Typography

Bundled font: **Nunito Light (300) + Regular (400)** - open source (OFL), friendly rounded character that fits the pear/family theme. Loaded via `@font-face` in the WebView HTML template with woff2 files bundled in assets.

Fallback stack: `'Nunito', 'Quicksand', system-ui, sans-serif`

| Token | Size | Weight |
|-------|------|--------|
| `display` | 24px | 300 |
| `heading` | 20px | 300 |
| `subheading` | 16px | 400 |
| `body` | 14px | 400 |
| `caption` | 12px | 400 |
| `micro` | 11px | 500 |

### Spacing Scale

| Token | Value |
|-------|-------|
| `xs` | 4px |
| `sm` | 8px |
| `md` | 12px |
| `base` | 16px |
| `lg` | 20px |
| `xl` | 24px |
| `xxl` | 32px |
| `xxxl` | 48px |

### Border Radius

| Token | Value |
|-------|-------|
| `sm` | 4px |
| `md` | 8px |
| `lg` | 12px |
| `xl` | 16px |
| `full` | 9999px |

### Shadows

- Dark mode: subtle dark shadows with slight primary green tint
- Light mode: traditional drop shadows (0 1px 3px rgba(0,0,0,0.1))

## Component Primitives

Reusable building blocks in `src/ui/components/`. All pull from theme tokens.

### Button

Three variants:
- `primary` - Pear green background, white text
- `secondary` - Transparent with green border
- `danger` - Red background for destructive actions

All support optional leading Phosphor icon, consistent padding (`spacing.md` horizontal, `spacing.sm` vertical), `borderRadius.md`.

### Card

- Background: `surface.card`, 1px border `surface.elevated`, `borderRadius.lg`
- Subtle shadow, `spacing.md` padding
- Optional header slot with title + action

### Badge

- Color-coded (green/red/amber/blue) with theme-aware backgrounds
- Pill shape (`borderRadius.full`), `micro` text, `spacing.xs` padding

### Input

- Background: `surface.input`, 1px border, `borderRadius.md`
- Focus state: green border glow
- Label above with `caption` typography

### TabBar

- Background: `surface.card` with top border
- Phosphor icons: regular weight inactive, fill weight active
- Active: primary green icon + label; Inactive: muted text

### FAB (Floating Action Button)

- Circular, pear green, positioned bottom-right above tab bar
- Phosphor `Plus` icon (or context-specific), white
- Subtle shadow/glow

### Modal/Overlay

- Semi-transparent backdrop
- Card-styled content container, `borderRadius.xl`
- Consistent header/body/footer layout

### Toggle

- Green when on, muted surface when off
- Smooth transition

## Phosphor Icons

Inline SVG module (`src/ui/icons.js`) exporting an `Icon` component that takes name, size, and color. Only the icons we use are included (~30-40 total). Zero external dependency.

**Icon inventory:**

- **Navigation:** House, GearSix, Info, User, Bell, CaretLeft
- **Actions:** Plus, Clock, LockSimple, LockSimpleOpen, Trash, QrCode, PencilSimple
- **Content:** ChartBar, SquaresFour, ListBullets, Shield, MagnifyingGlass, FunnelSimple, CaretDown, CaretUp, Check, X, Warning

Weight convention: Regular for UI chrome, Bold for emphasis, Fill for active states.

## Navigation Structure

### Parent Mode - 3 Bottom Tabs + FAB

| Tab | Icon | Content |
|-----|------|---------|
| Dashboard | `House` | Child list and management |
| Settings | `GearSix` | Profile, PIN, preferences, theme toggle |
| About | `Info` | App info, sharing, contact |
| FAB | `Plus` | Triggers Add Child flow |

### Child Mode - 3 Bottom Tabs + FAB

| Tab | Icon | Content |
|-----|------|---------|
| Home | `House` | Status summary, active overrides |
| Requests | `Bell` | Pending approvals and time requests |
| Profile | `User` | Identity, pairing |
| FAB | `Clock` | Triggers new time request |

### Parent Child Detail - 4 Tabs (Consolidated from 6)

| Tab | Icon | Merges |
|-----|------|--------|
| Usage | `ChartBar` | Unchanged |
| Apps | `SquaresFour` | Unchanged |
| Activity | `ListBullets` | Old Requests + Activity; incoming requests as actionable cards at top, historical events below |
| Rules | `Shield` | Old Schedule + Contacts; schedule blackouts and contact whitelist grouped as device behavior rules |

Top bar: `CaretLeft` back, avatar, child name, online status dot, `LockSimple` toggle (right), `Trash` remove (far right, muted).

## Screen Designs

### Parent Dashboard

- Dark surface base, child cards in `surface.card`
- Each child card: Avatar (left), name + online status dot (center), today's screen time (right)
- Below name: compact status line, e.g. "2 pending approvals" in amber or "All good" in green
- Top-right corner of card: Lock toggle icon (`LockSimple`), turns red when locked
- Tapping card navigates to child detail
- Empty state: icon + "Add your first child" prompt pointing to FAB
- FAB bottom-right: green circle with `Plus`

### Parent Child Detail

- Top bar with back, avatar, name, online dot, lock toggle, remove
- 4 horizontal tabs below top bar, scrollable
- Content area fills remaining space

### Parent Settings

- Sections as Cards: Profile (display name, avatar picker), Security (PIN setup/change), Preferences (theme toggle dark/light, time request options, warning thresholds)
- Clean form layout with Input and Toggle primitives

### Child Home

- Greeting: "Hi, [name]" in display typography
- Three stat cards in a row: Blocked apps (red), Awaiting approval (amber), Pending requests (green)
- Active overrides section: countdown timers in cards showing remaining time per override
- If device locked by parent: full-screen overlay with `LockSimple` icon and "Device locked by [parent name]"

### Child Requests

- List of pending requests as cards
- Each card: app icon/name, request type badge, timestamp
- Swipe or tap actions depending on type

### Child Profile

- Avatar (large, centered), display name, edit button
- Pairing section: QR scanner button (`QrCode`), paired parent card with name + connection status
- Unpair option (danger button with confirmation)

### PIN Overlay

- Uses dark theme surface colors (consistent with dark mode, no separate dark style)
- Card centered vertically, pear green accent on input focus state and submit button

## Quick-Lock Feature

### Behavior

- Parent taps `LockSimple` icon on child card (dashboard) or child detail top bar
- Confirmation modal: "Lock [child name]'s device?" with Lock (primary) and Cancel (secondary) buttons
- No confirmation needed to unlock - single tap toggles back

### IPC Flow

1. Parent UI sends `policy:setLock` via `callBare()` with `{ childPublicKey, locked: true/false }`
2. Bare worklet stores lock state in the policy object, signs and sends to child over Hyperswarm
3. Child bare worklet receives updated policy, stores it, emits `policy:updated` event to RN shell
4. RN shell triggers the enforcement layer (Accessibility Service blocks all apps when locked)
5. Child UI receives event and shows/hides the full-screen lock overlay

### Child Lock Screen

- Full-screen dark overlay, centered content
- Large `LockSimple` icon (64px) in muted red
- "Device locked by [parent name]" in heading typography
- "Contact your parent to unlock" in secondary text
- No dismiss, no interaction - only cleared when parent unlocks

### Persistence

- Lock state stored in policy under `locked: true/false` key in Hyperbee
- Survives app restarts - child checks lock state on launch
- If child is offline when parent locks, lock applies on next sync
