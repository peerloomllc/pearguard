# Usage Reports Design Spec (#95)

Screen Time-style usage reports with session-level data, interactive charts, and drill-down views.

## Decisions

- **Data granularity**: Session-level (individual app open/close events)
- **Retention**: 30 days, daily cleanup of older records
- **Session detection**: Native side (Java, UsageStatsManager)
- **Views**: Daily Summary, Weekly Trends, Per-App Drill-Down, Category Breakdown
- **Navigation**: Drill-down from existing Usage tab via "See Details" button
- **Charts**: Custom SVG (no charting library)
- **Day selector**: Left/right arrows
- **Weekly trends**: Toggleable between 7-day and 30-day
- **Animations**: Subtle CSS transitions throughout - bars animate in, charts draw progressively, day transitions fade/slide
- **Data flow**: Raw sessions over P2P (Approach 1) - child sends full sessions, parent aggregates on the fly

## Data Model

### Native Session Building

New method in `UsageStatsModule.java`:

`getSessionsSinceLastFlush()` queries `UsageStatsManager.queryEvents()` from last flush timestamp, pairs `MOVE_TO_FOREGROUND` / `MOVE_TO_BACKGROUND` events into session objects:

```json
{
  "packageName": "com.tiktok.lite",
  "displayName": "TikTok",
  "startedAt": 1775440000000,
  "endedAt": 1775441980000,
  "durationSeconds": 1980
}
```

Open sessions (no BACKGROUND event yet) get `endedAt: null` and `durationSeconds` computed from current time.

Last flush timestamp stored in SharedPreferences (`pearguard_last_session_flush`). If missing (first run or data cleared), defaults to start of today.

### Flush Payload Enhancement

The existing `usage:flush` payload adds a `sessions` array alongside existing `apps` and `weekly` fields. Existing fields remain for backward compatibility with the current Usage tab.

### Hyperbee Storage (Parent)

Sessions stored at: `sessions:{childPublicKey}:{YYYY-MM-DD}:{timestamp}`

Each key holds one flush's batch of sessions. Querying a day = range scan on `sessions:{childKey}:{date}:`, flatten, deduplicate by `packageName + startedAt`.

### 30-Day Cleanup

On `init` and once per day: scan for `sessions:*` and `usageReport:*` keys older than 30 days, delete them.

## IPC & P2P Protocol

### Modified usage:flush Flow

1. `EnforcementService` triggers flush every 60s (unchanged)
2. `app/index.tsx` calls `UsageStatsModule.getSessionsSinceLastFlush()`
3. Flush payload adds `sessions: [...]` to existing fields
4. Bare worklet receives via `usage:flush`, stores sessions locally, sends `usage:report` to parent over P2P with sessions included

### New bare-dispatch Methods

- `usage:getSessions({childPublicKey, date})` - All sessions for a child on a given date
- `usage:getDailySummaries({childPublicKey, days})` - Aggregated daily totals for the last N days (computed from stored sessions)
- `usage:getCategorySummary({childPublicKey, date})` - Usage grouped by category (uses category from policy app entries)

No new P2P message types - piggybacks on existing `usage:report`.

## UI Architecture

### Enhanced UsageTab.jsx

- Animated usage bars: CSS `width` transition with ease-out, staggered delays per bar
- "See Details" button at the bottom navigating to full reports view

### New UsageReports.jsx Component

Renders inside ChildDetail as a nested screen (replaces subtab view when active, back arrow to return). Horizontal pill selector for four sub-views:

#### 1. Daily Summary

- Hourly bar chart (custom SVG, 24 bars)
- Total screen time
- Top 5 apps list
- Left/right arrows to navigate days
- Subtle fade/slide animation between days

#### 2. Weekly Trends

- Vertical bar chart showing daily totals
- Toggle chip: "7 days" / "30 days"
- Average line across bars
- Comparison to previous period (percentage up/down)
- Bars animate up on load and period toggle

#### 3. Per-App Drill-Down

- Sorted list of apps by usage
- Tap app to expand inline:
  - Daily usage sparkline (last 7 or 30 days)
  - Session list for selected day
  - Stats: longest session, average session, total sessions
- App icons from policy data

#### 4. Category Breakdown

- Custom SVG donut chart with animated stroke-dashoffset segment reveal
- Legend below: category names, times, percentages
- Tap category to show ranked apps within it
- Categories from existing AppCategoryHelper (Games, Social, Video & Music, etc.)

### Animation Approach

All animations via CSS transitions/keyframes, no JS animation libraries:

- **Usage bars**: `width` transition with ease-out, staggered `transition-delay` per bar
- **Day transitions**: opacity + translateX fade/slide
- **Donut chart**: `stroke-dashoffset` animation for progressive segment drawing
- **Bar charts**: `height` transition with ease-out from 0
- **General**: Subtle, not flashy - elements appear smoothly rather than popping in

## Aggregation Logic

All aggregation in WebView JS at render time. No pre-computed aggregates stored.

### Daily Summary

- Fetch sessions via `usage:getSessions`
- Group by hour (from `startedAt`): sum `durationSeconds` per hour
- Sum all for total screen time
- Group by `packageName`, sort descending for top 5
- Count distinct sessions for pickups

### Weekly/Monthly Trends

- `usage:getDailySummaries({days: 7 or 30})` scans sessions across date keys, returns per-day totals
- Average from totals
- Previous period comparison: fetch prior 7/30 days, compare averages

### Category Breakdown

- Fetch sessions for selected date
- Map `packageName` to category via policy app entries
- Sum duration per category for donut
- Keep per-app breakdown within each category

### Per-App Drill-Down

- Filter current date's sessions by `packageName`
- Sparkline: `usage:getDailySummaries` filtered to that app

### Caching

WebView holds fetched data in React state. Navigating between sub-views doesn't re-fetch. Switching dates or toggling 7/30 days triggers a new fetch.
