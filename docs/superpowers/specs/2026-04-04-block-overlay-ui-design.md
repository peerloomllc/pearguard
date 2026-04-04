# Block Overlay UI Redesign

Theme the native Android overlays (block screen, PIN entry, duration picker) to match PearGuard's WebView UI system.

## Current State

All three overlays are programmatically built in `AppBlockerModule.java` using `WindowManager.addView()`. They use hardcoded colors (dark grays, raw blue/red) with default Android button styles, no icons, and system fonts. They look disconnected from the themed WebView UI.

## Design Direction

**Grouped list-style** - actions presented in a single rounded card with dividers (similar to iOS grouped settings). Icon in a tinted circle at top. Nunito font throughout. Phosphor icons on action rows.

## Font & Icon Assets

Bundle into Android assets:
- **Nunito** TTF (Regular 400, SemiBold 600) - loaded via `Typeface.createFromAsset()`
- **Phosphor icons** rendered as Android `Path`/`Canvas` drawings using the same SVG path data already in `src/ui/icons.js` - no PNG assets needed, just a helper class that draws paths onto a `Canvas`

## Color Palette

Matches the dark theme from `src/ui/theme.js`:

| Token | Hex | Usage |
|-------|-----|-------|
| surface.base | `#0D0D0D` | Overlay background (full screen, alpha 240) |
| surface.card | `#1A1A1A` | Grouped card background |
| surface.elevated | `#252525` | PIN keypad buttons |
| text.primary | `#F0F0F0` | Titles, button labels, PIN digits |
| text.secondary | `#A0A0A0` | Subtitles, secondary icons |
| text.muted | `#666666` | Chevrons, empty PIN dots border |
| border | `#333333` | Card border, cancel button border |
| divider | `#2A2A2A` | Row dividers inside grouped cards |
| primary | `#4CAF50` | Primary action text, filled PIN dots, icon circle tint |
| error | `#EF5350` | Shield icon, incorrect PIN flash |

## Overlay 1: Block Screen

Full-screen overlay shown when a blocked/pending/schedule/daily_limit app is foregrounded.

**Layout (top to bottom, vertically centered):**
1. **Icon circle** - 72dp, `primary` at 15% opacity background, 36dp Phosphor Shield icon in `error` color
2. **Title** - 22sp, weight 300, `text.primary`. Dynamic per block category:
   - `pending`: "{appName} needs approval"
   - `daily_limit`: "{appName}: daily limit reached"
   - `schedule`: "{appName}: scheduled block"
   - default: "{appName} is blocked"
3. **Subtitle** - 14sp, weight 400, `text.secondary`. Block reason text.
4. **Action card** - `surface.card` background, 16dp radius, 1px `border`, 4dp padding. Contains action rows separated by 1px `divider`:
   - **Request Approval** (or "Resend Approval Request") - icon: Shield, color: `primary`
   - **Request More Time** (or "Resend Time Request") - icon: Clock, color: `text.primary`
   - **Enter PIN** - icon: LockSimple, color: `text.primary`
   - Rows shown/hidden based on block category (same logic as current)
5. Gap: 8dp between icon and title, 8dp between title and subtitle, 40dp between subtitle and card.

## Overlay 2: PIN Entry

Replaces the block overlay when child taps "Enter PIN".

**Layout (vertically centered):**
1. **Icon circle** - 64dp, `primary` at 15% opacity, 32dp LockSimple icon in `primary`
2. **Title** - 18sp, weight 300, `text.primary`. "Enter parent PIN" (or "Incorrect PIN" in `error` on wrong entry)
3. **PIN dots** - 4 circles, 14dp each, 16dp gap. Filled = `primary`, empty = 2dp `border` stroke with transparent fill. On incorrect: all flash `error` for 1.5s then reset.
4. **Number pad card** - `surface.card`, 16dp radius, 1px `border`, 12dp padding. 4x3 grid:
   - Digit keys (0-9): `surface.elevated` background, 12dp radius, 52dp height, 22sp text, weight 400, `text.primary`
   - Backspace: transparent background, Phosphor Backspace icon 24dp in `text.secondary`
   - Empty cell (bottom-right): transparent, no content
   - Gap: 8dp between keys
5. **Cancel button** - ghost style: transparent background, 1px `border`, 12dp radius, 14sp weight 600, `text.secondary`. 20dp margin above.
6. Auto-submit on 4th digit (same behavior as current).

## Overlay 3: Duration Picker

Shown after "Request More Time" tap or after successful PIN entry.

**Layout (vertically centered):**
1. **Icon circle** - 64dp, `primary` at 15% opacity, 32dp Clock icon in `primary`
2. **Title** - 18sp, weight 300, `text.primary`. "How much extra time?" (time request) or "How long?" (post-PIN)
3. **Duration card** - `surface.card`, 16dp radius, 1px `border`, 4dp padding. Duration rows separated by 1px `divider`:
   - Each row: 16sp weight 500, `text.primary` label on left, 16dp CaretRight chevron in `text.muted` on right
   - Options from policy `timeRequestMinutes` array (defaults: 15, 30, 60, 120)
   - Format: "15 minutes", "30 minutes", "1 hour", "2 hours"
4. **Cancel button** - same ghost style as PIN overlay. Shown for time request picker, hidden for post-PIN picker (must pick a duration).

## Haptics

Unchanged from current implementation:
- Keypad tap: `{0, 30}` ms
- Button press: `{0, 60}` ms
- Error (wrong PIN): `{0, 80, 60, 80}` ms
- Success (correct PIN): `{0, 150}` ms

## Implementation Scope

All changes in a single file: `AppBlockerModule.java`.

1. Add Nunito TTF files to `android/app/src/main/assets/fonts/`
2. Create a small `PhosphorIcon` helper class (or static methods in AppBlockerModule) that draws SVG paths onto a `Bitmap` using `android.graphics.Path` + `Canvas`
3. Refactor `showOverlay()` to use new themed layout
4. Refactor `onEnterPin()` to use new themed PIN pad
5. Refactor `showExtraTimePicker()` and `showDurationPicker()` to use new themed picker
6. Extract shared styling constants (colors, dimensions, typefaces) to static fields

## Out of Scope

- Light theme support for overlays (overlays always use dark theme - they're enforcement UI)
- Animation/transitions between overlay states
- Landscape orientation handling (overlays are portrait-only enforcement screens)
