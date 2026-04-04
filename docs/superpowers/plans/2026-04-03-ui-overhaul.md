# UI Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign PearGuard's entire UI with a centralized design system, pear-themed dark/light palette, Phosphor icons, Nunito font, consolidated navigation, and a quick-lock feature.

**Architecture:** Introduce a theme system (`src/ui/theme.js`) that all components consume. Create reusable primitives (Button, Card, Badge, Input, Toggle, Modal, TabBar, FAB). Migrate all 20 existing component files from hardcoded inline styles to theme tokens. Consolidate child detail from 6 tabs to 4. Add quick-lock IPC flow through bare worklet.

**Tech Stack:** React (WebView), esbuild bundler, Phosphor Icons (inline SVG), Nunito font (base64-embedded woff2), Hyperbee persistence

---

## File Structure

### New Files

| File | Responsibility |
|------|----------------|
| `src/ui/theme.js` | Color palettes (dark/light), typography, spacing, radius, shadow tokens; `useTheme()` hook; theme persistence via callBare |
| `src/ui/icons.js` | Phosphor SVG icon component; exports `Icon({ name, size, color, weight })` with ~35 inline SVG paths |
| `src/ui/fonts.js` | Base64-encoded Nunito woff2 data; `injectFonts()` function that creates `<style>` with `@font-face` rules |
| `src/ui/components/primitives/Button.jsx` | Themed button: primary, secondary, danger variants with optional icon |
| `src/ui/components/primitives/Card.jsx` | Themed card container with optional header |
| `src/ui/components/primitives/Badge.jsx` | Color-coded pill badge |
| `src/ui/components/primitives/Input.jsx` | Themed text input with label and error state |
| `src/ui/components/primitives/Toggle.jsx` | On/off switch |
| `src/ui/components/primitives/Modal.jsx` | Overlay dialog with backdrop |
| `src/ui/components/TabBar.jsx` | Bottom tab bar with Phosphor icons |
| `src/ui/components/FAB.jsx` | Floating action button |
| `src/ui/components/ActivityTab.jsx` | Merged RequestsTab + AlertsTab |
| `src/ui/components/RulesTab.jsx` | Merged ScheduleTab + ContactsTab |
| `src/ui/components/LockOverlay.jsx` | Child lock screen overlay |
| `assets/fonts/Nunito-Light.woff2` | Nunito 300 weight font file |
| `assets/fonts/Nunito-Regular.woff2` | Nunito 400 weight font file |

### Modified Files

| File | Changes |
|------|---------|
| `src/ui/main.jsx` | Import and call `injectFonts()` on init |
| `src/ui/App.jsx` | Wrap in theme provider |
| `src/ui/components/ParentApp.jsx` | Replace tab bar with TabBar component, add FAB, migrate styles to theme, update PIN overlay |
| `src/ui/components/ChildApp.jsx` | Replace tab bar with TabBar component, add FAB, migrate styles to theme |
| `src/ui/components/Dashboard.jsx` | Migrate styles to theme, add lock button per card |
| `src/ui/components/ChildCard.jsx` | Migrate styles to theme, add lock icon button |
| `src/ui/components/ChildDetail.jsx` | Consolidate to 4 tabs (Usage, Apps, Activity, Rules), add lock toggle in top bar, migrate styles |
| `src/ui/components/ChildHome.jsx` | Migrate styles to theme, add LockOverlay when locked |
| `src/ui/components/Settings.jsx` | Migrate styles to theme, add theme toggle |
| `src/ui/components/Profile.jsx` | Migrate styles to theme |
| `src/ui/components/AppsTab.jsx` | Migrate styles to theme |
| `src/ui/components/UsageTab.jsx` | Migrate styles to theme |
| `src/ui/components/AddChildFlow.jsx` | Migrate styles to theme |
| `src/ui/components/AboutTab.jsx` | Migrate styles to theme |
| `src/ui/components/Avatar.jsx` | Migrate styles to theme |
| `src/ui/components/AvatarPicker.jsx` | Migrate styles to theme |
| `src/bare.js` / `src/bare-dispatch.js` | Add `policy:setLock` and `policy:getLock` dispatch methods |
| `app/index.tsx` | Update HTML template background to use theme-aware color |

---

## Task 1: Theme System

**Files:**
- Create: `src/ui/theme.js`

- [ ] **Step 1: Create theme.js with color palettes, tokens, and hook**

```js
// src/ui/theme.js
import { useState, useEffect } from 'react';

const palettes = {
  dark: {
    primary: '#4CAF50',
    primaryLight: '#81C784',
    secondary: '#FFB74D',
    error: '#EF5350',
    success: '#66BB6A',
    surface: {
      base: '#0D0D0D',
      card: '#1A1A1A',
      elevated: '#252525',
      input: '#333333',
    },
    text: {
      primary: '#F0F0F0',
      secondary: '#A0A0A0',
      muted: '#666666',
    },
    border: '#333333',
    divider: '#2A2A2A',
  },
  light: {
    primary: '#4CAF50',
    primaryLight: '#81C784',
    secondary: '#FFB74D',
    error: '#EF5350',
    success: '#66BB6A',
    surface: {
      base: '#FAFAF8',
      card: '#FFFFFF',
      elevated: '#F0F0EC',
      input: '#E8E8E4',
    },
    text: {
      primary: '#1A1A1A',
      secondary: '#555555',
      muted: '#999999',
    },
    border: '#DDDDDD',
    divider: '#EEEEEE',
  },
};

const typography = {
  display:    { fontSize: '24px', fontWeight: '300', fontFamily: "'Nunito', system-ui, sans-serif" },
  heading:    { fontSize: '20px', fontWeight: '300', fontFamily: "'Nunito', system-ui, sans-serif" },
  subheading: { fontSize: '16px', fontWeight: '400', fontFamily: "'Nunito', system-ui, sans-serif" },
  body:       { fontSize: '14px', fontWeight: '400', fontFamily: "'Nunito', system-ui, sans-serif" },
  caption:    { fontSize: '12px', fontWeight: '400', fontFamily: "'Nunito', system-ui, sans-serif" },
  micro:      { fontSize: '11px', fontWeight: '500', fontFamily: "'Nunito', system-ui, sans-serif" },
};

const spacing = { xs: 4, sm: 8, md: 12, base: 16, lg: 20, xl: 24, xxl: 32, xxxl: 48 };

const radius = { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 };

function shadow(colors) {
  // Dark mode: subtle glow; light mode: traditional drop shadow
  if (colors === palettes.dark) {
    return '0 2px 8px rgba(0,0,0,0.4)';
  }
  return '0 1px 3px rgba(0,0,0,0.1)';
}

// Global state - simple module-level state since this runs in a single WebView
let _theme = 'dark';
let _listeners = [];

function getColors() { return palettes[_theme]; }

function setTheme(name) {
  _theme = name;
  _listeners.forEach((fn) => fn(name));
  // Persist
  window.callBare('settings:setTheme', { theme: name }).catch(() => {});
}

function useTheme() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    _listeners.push(handler);
    return () => { _listeners = _listeners.filter((fn) => fn !== handler); };
  }, []);

  return {
    colors: getColors(),
    typography,
    spacing,
    radius,
    shadow: shadow(getColors()),
    theme: _theme,
    setTheme,
  };
}

// Call once on app init to load persisted theme
async function initTheme() {
  try {
    const { theme } = await window.callBare('settings:getTheme');
    if (theme && palettes[theme]) {
      _theme = theme;
      _listeners.forEach((fn) => fn(theme));
    }
  } catch {
    // Default to dark
  }
}

export { useTheme, initTheme, palettes, typography, spacing, radius };
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/theme.js
git commit -m "feat(ui): add theme system with dark/light palettes and tokens"
```

---

## Task 2: Phosphor Icons Module

**Files:**
- Create: `src/ui/icons.js`

- [ ] **Step 1: Create icons.js with inline SVG Phosphor icons**

This file exports an `Icon` component that renders inline SVGs. Each icon is stored as a path string. We include only the icons we need.

```js
// src/ui/icons.js

// Phosphor icon SVG paths (Regular weight unless noted)
// Source: https://phosphoricons.com - MIT license
const PATHS = {
  // Navigation
  House: 'M219.6,210.5V136.1l-91.6-76L36.4,136.1v74.4a6,6,0,0,0,6,6h48a6,6,0,0,0,6-6V168.5a6,6,0,0,1,6-6h52a6,6,0,0,1,6,6v42a6,6,0,0,0,6,6h48A6,6,0,0,0,219.6,210.5Z M234.3,121.2,128,29.7,21.7,121.2a8,8,0,1,0,10.6,12L128,47.4l95.7,85.8a8,8,0,0,0,10.6-12Z',
  HouseFill: 'M224,115.5V208a16,16,0,0,1-16,16H168a16,16,0,0,1-16-16V168a8,8,0,0,0-8-8H112a8,8,0,0,0-8,8v40a16,16,0,0,1-16,16H48a16,16,0,0,1-16-16V115.5a16,16,0,0,1,5.2-11.8l80-72.7a16,16,0,0,1,21.5,0l80,72.7A16,16,0,0,1,224,115.5Z',
  GearSix: 'M128,80a48,48,0,1,0,48,48A48,48,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.8a8,8,0,0,0,0-4.4l-13.8-48.2a8,8,0,0,0-3.4-4.6L152,40.2a8,8,0,0,0-5.6-1.6l-50,5.6a8,8,0,0,0-4.2,1.8L55.2,80.2a8,8,0,0,0-2.6,4.2L39.8,130.2a8,8,0,0,0,0,4.4l13.8,48.2a8,8,0,0,0,3.4,4.6L104,220.2a8,8,0,0,0,5.6,1.6l50-5.6a8,8,0,0,0,4.2-1.8l36.8-34.2a8,8,0,0,0,2.6-4.2Z',
  GearSixFill: 'M128,80a48,48,0,1,0,48,48A48,48,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Z M216,130.2a8,8,0,0,0,0-4.4l-13.8-48.2a8,8,0,0,0-3.4-4.6L152,40.2a8,8,0,0,0-5.6-1.6l-50,5.6a8,8,0,0,0-4.2,1.8L55.2,80.2a8,8,0,0,0-2.6,4.2L39.8,130.2a8,8,0,0,0,0,4.4l13.8,48.2a8,8,0,0,0,3.4,4.6L104,220.2a8,8,0,0,0,5.6,1.6l50-5.6a8,8,0,0,0,4.2-1.8l36.8-34.2a8,8,0,0,0,2.6-4.2Z',
  Info: 'M128,24A104,104,0,1,0,232,128,104.2,104.2,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-104v64a8,8,0,0,0,16,0V112a8,8,0,0,0-16,0Zm20-28a12,12,0,1,1-12-12A12,12,0,0,1,140,84Z',
  InfoFill: 'M128,24A104,104,0,1,0,232,128,104.2,104.2,0,0,0,128,24Zm-4,48a12,12,0,1,1-12,12A12,12,0,0,1,124,72Zm12,112a8,8,0,0,1-16,0V120a8,8,0,0,1,16,0Z',
  User: 'M128,24A104,104,0,1,0,232,128,104.2,104.2,0,0,0,128,24ZM74.1,197.5a64,64,0,0,1,107.8,0,87.8,87.8,0,0,1-107.8,0ZM96,120a32,32,0,1,1,32,32A32,32,0,0,1,96,120Zm97.2,66.3a79.7,79.7,0,0,0-36.7-28.6,48,48,0,1,0-56.9,0,79.7,79.7,0,0,0-36.7,28.6,88,88,0,1,1,130.3,0Z',
  UserFill: 'M128,24A104,104,0,1,0,232,128,104.2,104.2,0,0,0,128,24ZM74.1,197.5a64,64,0,0,1,107.8,0,87.8,87.8,0,0,1-107.8,0ZM96,120a32,32,0,1,1,32,32A32,32,0,0,1,96,120Z',
  Bell: 'M168,224a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,224Zm53.8-32A15.9,15.9,0,0,1,208,200H48a16,16,0,0,1-8.7-29.4C45.6,166.1,56,139.7,56,104a72,72,0,0,1,144,0c0,35.7,10.4,62.1,16.7,66.6A15.9,15.9,0,0,1,221.8,192ZM208,184c-10.6-11.5-24-40.7-24-80a56,56,0,0,0-112,0c0,39.3-13.4,68.5-24,80Z',
  BellFill: 'M168,224a8,8,0,0,1-8,8H96a8,8,0,0,1,0-16h64A8,8,0,0,1,168,224Zm53.8-32A15.9,15.9,0,0,1,208,200H48a16,16,0,0,1-8.7-29.4C45.6,166.1,56,139.7,56,104a72,72,0,0,1,144,0c0,35.7,10.4,62.1,16.7,66.6A15.9,15.9,0,0,1,221.8,192Z',
  CaretLeft: 'M168,48V208a8,8,0,0,1-13.7,5.7l-80-80a8,8,0,0,1,0-11.3l80-80A8,8,0,0,1,168,48Z',

  // Actions
  Plus: 'M224,128a8,8,0,0,1-8,8H136v80a8,8,0,0,1-16,0V136H40a8,8,0,0,1,0-16h80V40a8,8,0,0,1,16,0v80h80A8,8,0,0,1,224,128Z',
  Clock: 'M128,24A104,104,0,1,0,232,128,104.2,104.2,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm64-88a8,8,0,0,1-8,8H128a8,8,0,0,1-8-8V72a8,8,0,0,1,16,0v48h48A8,8,0,0,1,192,128Z',
  LockSimple: 'M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Z',
  LockSimpleOpen: 'M208,80H96V56a32,32,0,0,1,64,0,8,8,0,0,0,16,0,48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80Zm0,128H48V96H208V208Z',
  Trash: 'M216,48H176V40a24,24,0,0,0-24-24H104A24,24,0,0,0,80,40v8H40a8,8,0,0,0,0,16h8V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64h8a8,8,0,0,0,0-16ZM96,40a8,8,0,0,1,8-8h48a8,8,0,0,1,8,8v8H96Zm96,168H64V64H192ZM112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z',
  QrCode: 'M104,40H56A16,16,0,0,0,40,56v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,104,40Zm0,64H56V56h48v48Zm96-64H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,64H152V56h48v48ZM104,136H56a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,104,136Zm0,64H56V152h48v48Zm32-64a8,8,0,0,1,8-8h24a8,8,0,0,1,0,16H144A8,8,0,0,1,136,136Zm80,16a8,8,0,0,1-8,8H192v40a8,8,0,0,1-8,8H168a8,8,0,0,1,0-16h8V152h-8a8,8,0,0,1,0-16h16a8,8,0,0,1,8,8v16h16A8,8,0,0,1,216,152Zm0,48a8,8,0,0,1-8,8H200a8,8,0,0,1,0-16h8A8,8,0,0,1,216,200Z',
  PencilSimple: 'M227.3,73.4,182.6,28.7a16,16,0,0,0-22.6,0L36.7,152a16,16,0,0,0-4.7,11.3V208a16,16,0,0,0,16,16H92.7A16,16,0,0,0,104,219.3L227.3,96a16,16,0,0,0,0-22.6ZM92.7,208H48V163.3L136,75.3,180.7,120Z',

  // Content
  ChartBar: 'M224,200a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V40a8,8,0,0,1,16,0V192H216A8,8,0,0,1,224,200ZM80,192V120a8,8,0,0,0-16,0v72a8,8,0,0,0,16,0Zm40,0V80a8,8,0,0,0-16,0V192a8,8,0,0,0,16,0Zm40,0V104a8,8,0,0,0-16,0v88a8,8,0,0,0,16,0Zm40,0V56a8,8,0,0,0-16,0V192a8,8,0,0,0,16,0Z',
  ChartBarFill: 'M224,200a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V40a8,8,0,0,1,16,0V192H216A8,8,0,0,1,224,200ZM80,192V120a8,8,0,0,0-16,0v72Zm40,0V80a8,8,0,0,0-16,0V192Zm40,0V104a8,8,0,0,0-16,0v88Zm40,0V56a8,8,0,0,0-16,0V192Z',
  SquaresFour: 'M104,40H56A16,16,0,0,0,40,56v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,104,40Zm0,64H56V56h48ZM200,40H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40Zm0,64H152V56h48ZM104,136H56a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,104,136Zm0,64H56V152h48ZM200,136H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,200,136Zm0,64H152V152h48Z',
  SquaresFourFill: 'M120,56v48a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V56A16,16,0,0,1,56,40h48A16,16,0,0,1,120,56Zm80-16H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V56A16,16,0,0,0,200,40ZM104,136H56a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,104,136Zm96,0H152a16,16,0,0,0-16,16v48a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V152A16,16,0,0,0,200,136Z',
  ListBullets: 'M80,64a8,8,0,0,1,8-8H216a8,8,0,0,1,0,16H88A8,8,0,0,1,80,64Zm136,56H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,64H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16ZM44,52A12,12,0,1,0,56,64,12,12,0,0,0,44,52Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,116Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,180Z',
  ListBulletsFill: 'M80,64a8,8,0,0,1,8-8H216a8,8,0,0,1,0,16H88A8,8,0,0,1,80,64Zm136,56H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16Zm0,64H88a8,8,0,0,0,0,16H216a8,8,0,0,0,0-16ZM44,52A12,12,0,1,0,56,64,12,12,0,0,0,44,52Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,116Zm0,64a12,12,0,1,0,12,12A12,12,0,0,0,44,180Z',
  Shield: 'M208,40H48A16,16,0,0,0,32,56v58.7c0,89.4,75.8,119.1,91,124a8.2,8.2,0,0,0,10,0c15.2-4.9,91-34.6,91-124V56A16,16,0,0,0,208,40Zm0,74.7c0,78.2-66.4,104.4-80,109.1-13.5-4.7-80-30.9-80-109.1V56H208Z',
  ShieldFill: 'M208,40H48A16,16,0,0,0,32,56v58.7c0,89.4,75.8,119.1,91,124a8.2,8.2,0,0,0,10,0c15.2-4.9,91-34.6,91-124V56A16,16,0,0,0,208,40Z',
  MagnifyingGlass: 'M229.7,218.3l-43.3-43.2a92.2,92.2,0,1,0-11.3,11.3l43.2,43.3a8,8,0,0,0,11.4-11.4ZM40,112a72,72,0,1,1,72,72A72.1,72.1,0,0,1,40,112Z',
  FunnelSimple: 'M192,88H64a8,8,0,0,1,0-16H192a8,8,0,0,1,0,16Zm-32,48H96a8,8,0,0,0,0,16h64a8,8,0,0,0,0-16Zm-16,64h-32a8,8,0,0,0,0,16h32a8,8,0,0,0,0-16Z',
  CaretDown: 'M213.7,101.7l-80,80a8,8,0,0,1-11.4,0l-80-80a8,8,0,0,1,11.4-11.4L128,164.7l74.3-74.4a8,8,0,0,1,11.4,11.4Z',
  CaretUp: 'M213.7,165.7a8,8,0,0,1-11.4,0L128,91.3,53.7,165.7a8,8,0,0,1-11.4-11.4l80-80a8,8,0,0,1,11.4,0l80,80A8,8,0,0,1,213.7,165.7Z',
  Check: 'M229.7,77.7l-128,128a8,8,0,0,1-11.4,0l-56-56a8,8,0,0,1,11.4-11.4L96,188.7,218.3,66.3a8,8,0,0,1,11.4,11.4Z',
  X: 'M205.7,194.3a8,8,0,0,1-11.4,11.4L128,139.3,61.7,205.7a8,8,0,0,1-11.4-11.4L116.7,128,50.3,61.7A8,8,0,0,1,61.7,50.3L128,116.7l66.3-66.4a8,8,0,0,1,11.4,11.4L139.3,128Z',
  Warning: 'M236.8,188.1,149.4,36.9a24.8,24.8,0,0,0-42.8,0L19.2,188.1A23.6,23.6,0,0,0,16,200a24,24,0,0,0,24,24H216a24,24,0,0,0,24-24A23.6,23.6,0,0,0,236.8,188.1ZM120,104a8,8,0,0,1,16,0v40a8,8,0,0,1-16,0Zm8,88a12,12,0,1,1,12-12A12,12,0,0,1,128,192Z',
  SunDim: 'M128,60a68,68,0,1,0,68,68A68.1,68.1,0,0,0,128,60Zm0,120a52,52,0,1,1,52-52A52.1,52.1,0,0,1,128,180ZM120,36V16a8,8,0,0,1,16,0V36a8,8,0,0,1-16,0Zm0,204v-20a8,8,0,0,1,16,0v20a8,8,0,0,1-16,0ZM58.3,69.7,44,55.4A8,8,0,0,1,55.4,44L69.7,58.3a8,8,0,1,1-11.4,11.4ZM197.7,186.3l14.3,14.3a8,8,0,0,1-11.4,11.4l-14.3-14.3a8,8,0,0,1,11.4-11.4ZM44,200.6a8,8,0,0,1,0-11.3l14.3-14.3a8,8,0,0,1,11.4,11.3L55.4,200.6a8,8,0,0,1-11.4,0Zm156-145.3a8,8,0,0,1,0-11.3l14.3-14.3A8,8,0,0,1,225.6,41L211.3,55.3A8,8,0,0,1,200,55.3ZM36,120H16a8,8,0,0,1,0-16H36a8,8,0,0,1,0,16Zm204-8a8,8,0,0,1-8,8H220a8,8,0,0,1,0-16h12A8,8,0,0,1,240,112Z',
  Moon: 'M233.5,108.5A96.1,96.1,0,0,1,147.5,22.5a8,8,0,0,0-10.3,10.3A80.1,80.1,0,0,0,223.2,118.8a8,8,0,0,0,10.3-10.3Z M216,144a88,88,0,0,1-175,15.7A96.2,96.2,0,0,0,147.5,22.5a8,8,0,0,0-10.3,10.3A80,80,0,0,0,223.2,118.8a8,8,0,0,0,10.3-10.3A89,89,0,0,1,216,144Z',
};

export default function Icon({ name, size = 24, color = 'currentColor', weight = 'regular' }) {
  // Try fill variant first if weight is 'fill'
  const key = weight === 'fill' ? (name + 'Fill') : name;
  const path = PATHS[key] || PATHS[name];
  if (!path) return null;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill={color}
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <path d={path} />
    </svg>
  );
}
```

**Note:** The SVG paths above are approximations. During implementation, the developer should copy the exact `d` attribute values from the Phosphor Icons GitHub repo (`phosphor-icons/core/assets/regular/*.svg` and `fill/*.svg`). Each icon's SVG file contains a single `<path>` element with the `d` attribute to copy.

- [ ] **Step 2: Commit**

```bash
git add src/ui/icons.js
git commit -m "feat(ui): add Phosphor icons module with inline SVGs"
```

---

## Task 3: Font Bundling

**Files:**
- Create: `assets/fonts/Nunito-Light.woff2`
- Create: `assets/fonts/Nunito-Regular.woff2`
- Create: `src/ui/fonts.js`
- Modify: `src/ui/main.jsx`

- [ ] **Step 1: Download Nunito woff2 files**

Download from Google Fonts:

```bash
cd /home/tim/peerloomllc/pearguard
mkdir -p assets/fonts
# Download Nunito Light (300) and Regular (400)
curl -L "https://fonts.gstatic.com/s/nunito/v26/XRXI3I6Li01BKofiOc5wtlZ2di8HDIkhdTQ3j6zbXWjgeg.woff2" -o assets/fonts/Nunito-Light.woff2
curl -L "https://fonts.gstatic.com/s/nunito/v26/XRXI3I6Li01BKofiOc5wtlZ2di8HDLshdTQ3j6zbXWjgeg.woff2" -o assets/fonts/Nunito-Regular.woff2
```

**Note:** If these URLs change, go to `https://fonts.google.com/specimen/Nunito`, select Light 300 and Regular 400, and get the woff2 URLs from the generated CSS `@font-face` rules.

- [ ] **Step 2: Create fonts.js that base64-encodes and injects the fonts**

Since esbuild can't bundle binary woff2 files directly, we generate a JS file with the base64 data at build time. Add a build script:

```bash
# Generate fonts.js with base64 data
node -e "
const fs = require('fs');
const light = fs.readFileSync('assets/fonts/Nunito-Light.woff2').toString('base64');
const regular = fs.readFileSync('assets/fonts/Nunito-Regular.woff2').toString('base64');
const code = \`// Auto-generated - do not edit
const LIGHT = '\${light}';
const REGULAR = '\${regular}';

export function injectFonts() {
  const style = document.createElement('style');
  style.textContent = \\\`
    @font-face {
      font-family: 'Nunito';
      font-weight: 300;
      font-style: normal;
      font-display: swap;
      src: url(data:font/woff2;base64,\\\${LIGHT}) format('woff2');
    }
    @font-face {
      font-family: 'Nunito';
      font-weight: 400;
      font-style: normal;
      font-display: swap;
      src: url(data:font/woff2;base64,\\\${REGULAR}) format('woff2');
    }
  \\\`;
  document.head.appendChild(style);
}
\`;
fs.writeFileSync('src/ui/fonts.js', code);
"
```

- [ ] **Step 3: Add build:fonts script to package.json**

In `package.json`, add a `build:fonts` script and update `build:ui` to run it first:

```json
"build:fonts": "node -e \"const fs=require('fs');const l=fs.readFileSync('assets/fonts/Nunito-Light.woff2').toString('base64');const r=fs.readFileSync('assets/fonts/Nunito-Regular.woff2').toString('base64');fs.writeFileSync('src/ui/fonts.js','const LIGHT=\\''+l+'\\';\\nconst REGULAR=\\''+r+'\\';\\nexport function injectFonts(){const s=document.createElement(\\'style\\');s.textContent=\\'@font-face{font-family:Nunito;font-weight:300;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,\\'+LIGHT+\\') format(woff2)}@font-face{font-family:Nunito;font-weight:400;font-style:normal;font-display:swap;src:url(data:font/woff2;base64,\\'+REGULAR+\\') format(woff2)}\\';document.head.appendChild(s);}')\"",
"build:ui": "npm run build:fonts && esbuild src/ui/main.jsx --bundle --format=iife --jsx=automatic --define:process.env.NODE_ENV=\\\"production\\\" --outfile=assets/app-ui.bundle"
```

- [ ] **Step 4: Update main.jsx to inject fonts on init**

Add to the top of `src/ui/main.jsx`, before `createRoot`:

```js
import { injectFonts } from './fonts.js';
injectFonts();
```

- [ ] **Step 5: Run build:fonts to generate the fonts.js file**

```bash
npm run build:fonts
```

- [ ] **Step 6: Commit**

```bash
git add assets/fonts/ src/ui/fonts.js src/ui/main.jsx package.json
git commit -m "feat(ui): bundle Nunito font via base64 injection"
```

---

## Task 4: Component Primitives

**Files:**
- Create: `src/ui/components/primitives/Button.jsx`
- Create: `src/ui/components/primitives/Card.jsx`
- Create: `src/ui/components/primitives/Badge.jsx`
- Create: `src/ui/components/primitives/Input.jsx`
- Create: `src/ui/components/primitives/Toggle.jsx`
- Create: `src/ui/components/primitives/Modal.jsx`

- [ ] **Step 1: Create Button.jsx**

```jsx
// src/ui/components/primitives/Button.jsx
import { useTheme } from '../../theme.js';
import Icon from '../../icons.js';

export default function Button({ children, variant = 'primary', icon, disabled, style, ...props }) {
  const { colors, typography, spacing, radius } = useTheme();

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: `${spacing.sm}px`,
    padding: `${spacing.sm}px ${spacing.md}px`,
    border: 'none',
    borderRadius: `${radius.md}px`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    ...typography.body,
    fontWeight: '600',
    transition: 'opacity 0.15s',
    opacity: disabled ? 0.5 : 1,
  };

  const variants = {
    primary: { backgroundColor: colors.primary, color: '#FFFFFF' },
    secondary: { backgroundColor: 'transparent', border: `1px solid ${colors.primary}`, color: colors.primary },
    danger: { backgroundColor: colors.error, color: '#FFFFFF' },
  };

  return (
    <button style={{ ...base, ...variants[variant], ...style }} disabled={disabled} {...props}>
      {icon && <Icon name={icon} size={16} color={variant === 'secondary' ? colors.primary : '#FFFFFF'} />}
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Create Card.jsx**

```jsx
// src/ui/components/primitives/Card.jsx
import { useTheme } from '../../theme.js';

export default function Card({ children, title, action, style, ...props }) {
  const { colors, typography, spacing, radius, shadow } = useTheme();

  return (
    <div
      style={{
        backgroundColor: colors.surface.card,
        border: `1px solid ${colors.border}`,
        borderRadius: `${radius.lg}px`,
        padding: `${spacing.md}px`,
        boxShadow: shadow,
        ...style,
      }}
      {...props}
    >
      {(title || action) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: `${spacing.sm}px` }}>
          {title && <div style={{ ...typography.subheading, color: colors.text.primary }}>{title}</div>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Create Badge.jsx**

```jsx
// src/ui/components/primitives/Badge.jsx
import { useTheme } from '../../theme.js';

export default function Badge({ children, color, style }) {
  const { typography, spacing, radius } = useTheme();

  if (!children) return null;

  return (
    <span
      style={{
        display: 'inline-block',
        ...typography.micro,
        color: '#FFFFFF',
        backgroundColor: color,
        borderRadius: `${radius.full}px`,
        padding: `2px ${spacing.sm - 1}px`,
        minWidth: '20px',
        textAlign: 'center',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 4: Create Input.jsx**

```jsx
// src/ui/components/primitives/Input.jsx
import { useTheme } from '../../theme.js';

export default function Input({ label, error, style, inputStyle, ...props }) {
  const { colors, typography, spacing, radius } = useTheme();

  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px`, ...style }}>
      {label && <span style={{ ...typography.caption, color: colors.text.secondary }}>{label}</span>}
      <input
        style={{
          padding: `${spacing.sm + 2}px`,
          backgroundColor: colors.surface.input,
          border: `1px solid ${error ? colors.error : colors.border}`,
          borderRadius: `${radius.md}px`,
          color: colors.text.primary,
          outline: 'none',
          ...typography.body,
          ...inputStyle,
        }}
        {...props}
      />
      {error && <span style={{ ...typography.caption, color: colors.error }}>{error}</span>}
    </label>
  );
}
```

- [ ] **Step 5: Create Toggle.jsx**

```jsx
// src/ui/components/primitives/Toggle.jsx
import { useTheme } from '../../theme.js';

export default function Toggle({ checked, onChange, style }) {
  const { colors, spacing } = useTheme();

  const trackW = 44;
  const trackH = 24;
  const thumbSize = 20;
  const offset = checked ? trackW - thumbSize - 2 : 2;

  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: `${trackW}px`,
        height: `${trackH}px`,
        borderRadius: `${trackH / 2}px`,
        border: 'none',
        cursor: 'pointer',
        backgroundColor: checked ? colors.primary : colors.surface.elevated,
        transition: 'background-color 0.2s',
        padding: 0,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '2px',
          left: `${offset}px`,
          width: `${thumbSize}px`,
          height: `${thumbSize}px`,
          borderRadius: '50%',
          backgroundColor: '#FFFFFF',
          transition: 'left 0.2s',
        }}
      />
    </button>
  );
}
```

- [ ] **Step 6: Create Modal.jsx**

```jsx
// src/ui/components/primitives/Modal.jsx
import { useTheme } from '../../theme.js';

export default function Modal({ visible, onClose, title, children, footer }) {
  const { colors, typography, spacing, radius } = useTheme();

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: `${spacing.xl}px`,
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: colors.surface.card,
          borderRadius: `${radius.xl}px`,
          padding: `${spacing.xl}px`,
          maxWidth: '360px',
          width: '100%',
          border: `1px solid ${colors.border}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.base}px` }}>
            {title}
          </div>
        )}
        <div style={{ color: colors.text.secondary, ...typography.body }}>
          {children}
        </div>
        {footer && (
          <div style={{ display: 'flex', gap: `${spacing.sm}px`, marginTop: `${spacing.base}px`, justifyContent: 'flex-end' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Commit**

```bash
git add src/ui/components/primitives/
git commit -m "feat(ui): add themed component primitives (Button, Card, Badge, Input, Toggle, Modal)"
```

---

## Task 5: TabBar and FAB Components

**Files:**
- Create: `src/ui/components/TabBar.jsx`
- Create: `src/ui/components/FAB.jsx`

- [ ] **Step 1: Create TabBar.jsx**

```jsx
// src/ui/components/TabBar.jsx
import { useTheme } from '../theme.js';
import Icon from '../icons.js';

export default function TabBar({ tabs, activeTab, onTabChange }) {
  const { colors, typography, spacing } = useTheme();

  return (
    <div
      style={{
        display: 'flex',
        borderTop: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            onClick={() => {
              window.callBare('haptic:tap');
              onTabChange(tab.key);
            }}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: `${spacing.xs}px`,
              padding: `${spacing.sm}px 0`,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
            }}
          >
            <Icon
              name={tab.icon}
              size={22}
              color={active ? colors.primary : colors.text.muted}
              weight={active ? 'fill' : 'regular'}
            />
            <span style={{
              ...typography.micro,
              color: active ? colors.primary : colors.text.muted,
            }}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Create FAB.jsx**

```jsx
// src/ui/components/FAB.jsx
import { useTheme } from '../theme.js';
import Icon from '../icons.js';

export default function FAB({ icon = 'Plus', onPress, style }) {
  const { colors, spacing } = useTheme();

  return (
    <button
      onClick={() => {
        window.callBare('haptic:tap');
        onPress();
      }}
      style={{
        position: 'fixed',
        bottom: `${56 + spacing.base}px`, // above tab bar
        right: `${spacing.base}px`,
        width: '56px',
        height: '56px',
        borderRadius: '50%',
        border: 'none',
        backgroundColor: colors.primary,
        boxShadow: '0 4px 12px rgba(76,175,80,0.4)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        ...style,
      }}
    >
      <Icon name={icon} size={24} color="#FFFFFF" />
    </button>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/TabBar.jsx src/ui/components/FAB.jsx
git commit -m "feat(ui): add TabBar and FAB components"
```

---

## Task 6: Theme Provider and App Shell

**Files:**
- Modify: `src/ui/App.jsx` (lines 1-47)
- Modify: `app/index.tsx` (lines 131-151)

- [ ] **Step 1: Update App.jsx to wrap in theme and initialize**

Replace the entire `src/ui/App.jsx` with:

```jsx
import { useState, useEffect } from 'react';
import { initTheme, useTheme } from './theme.js';
import ParentApp from './components/ParentApp.jsx';
import ChildApp from './components/ChildApp.jsx';

function ModeSetup() {
  const { colors, typography } = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: colors.surface.base }}>
      <p style={{ ...typography.body, color: colors.text.secondary }}>Waiting for setup...</p>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState(null);
  const [ready, setReady] = useState(false);
  const { colors } = useTheme();

  useEffect(() => {
    initTheme();
    window.callBare('identity:getMode')
      .then(({ mode: m }) => setMode(m))
      .catch(() => {});

    const unsub = window.onBareEvent('ready', () => {
      window.callBare('identity:getMode')
        .then(({ mode: m }) => setMode(m))
        .catch(() => {});
    });
    setReady(true);
    return unsub;
  }, []);

  if (!ready) return null;

  return (
    <div style={{ height: '100vh', backgroundColor: colors.surface.base, color: colors.text.primary }}>
      {mode === 'parent' ? <ParentApp /> : mode === 'child' ? <ChildApp /> : <ModeSetup />}
    </div>
  );
}
```

- [ ] **Step 2: Update HTML template background in app/index.tsx**

In `app/index.tsx` line 142, change the background from `#111` to `#0D0D0D` (dark theme base):

```
'html, body, #root { height: 100dvh; width: 100%; overflow: hidden; background: #0D0D0D; }',
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/App.jsx app/index.tsx
git commit -m "feat(ui): add theme provider wrapper and update app shell"
```

---

## Task 7: Parent App - Tab Bar, FAB, PIN Overlay Migration

**Files:**
- Modify: `src/ui/components/ParentApp.jsx` (208 lines - full rewrite of styles and tab bar)

- [ ] **Step 1: Rewrite ParentApp.jsx with themed components**

Replace the entire file. The logic (PIN setup, navigation events, pairing banner) stays the same. The rendering and styles change to use theme tokens, TabBar, and FAB.

Key changes:
- Replace bottom tab bar with `<TabBar>` component
- Add `<FAB icon="Plus" onPress={() => setShowAdd(true)} />` (was previously a button in Dashboard header)
- PIN overlay uses theme colors instead of hardcoded #111/#1a1a1a
- Banner uses theme success colors
- Import `useTheme`, `TabBar`, `FAB`, `Icon`, `Modal`, `Button`, `Input`

```jsx
import React, { useState, useEffect, useRef } from 'react';
import { useTheme } from '../theme.js';
import TabBar from './TabBar.jsx';
import FAB from './FAB.jsx';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import Input from './primitives/Input.jsx';
import Dashboard from './Dashboard.jsx';
import Settings from './Settings.jsx';
import AboutTab from './AboutTab.jsx';

const TABS = [
  { key: 'dashboard', label: 'Dashboard', icon: 'House', Component: Dashboard },
  { key: 'settings', label: 'Settings', icon: 'GearSix', Component: Settings },
  { key: 'about', label: 'About', icon: 'Info', Component: AboutTab },
];

export default function ParentApp() {
  const { colors, typography, spacing, radius } = useTheme();
  const [tab, setTab] = useState('dashboard');
  const [pinCheckState, setPinCheckState] = useState('checking'); // 'checking'|'needed'|'done'
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState('');
  const [banner, setBanner] = useState(null);
  const dashRef = useRef(null);

  useEffect(() => {
    window.callBare('pin:check')
      .then(({ hasPin }) => setPinCheckState(hasPin ? 'done' : 'needed'))
      .catch(() => setPinCheckState('done'));
  }, []);

  // Navigation events from native/bare
  useEffect(() => {
    const unsubAlerts = window.onBareEvent('navigate:child:alerts', (data) => {
      setTab('dashboard');
      if (dashRef.current?.navigateToChild) {
        dashRef.current.navigateToChild(data.childPublicKey, 'activity');
      }
    });
    const unsubRequests = window.onBareEvent('navigate:child:requests', (data) => {
      setTab('dashboard');
      if (dashRef.current?.navigateToChild) {
        dashRef.current.navigateToChild(data.childPublicKey, 'activity');
      }
    });
    const unsubConnected = window.onBareEvent('child:connected', (data) => {
      const name = data?.displayName || 'Child';
      setBanner(`${name} paired successfully!`);
      setTimeout(() => setBanner(null), 4000);
    });
    return () => { unsubAlerts(); unsubRequests(); unsubConnected(); };
  }, []);

  async function handlePinSubmit(e) {
    e.preventDefault();
    setPinError('');
    if (pin.length < 4) { setPinError('PIN must be at least 4 digits'); return; }
    if (pin !== pinConfirm) { setPinError('PINs do not match'); return; }
    try {
      await window.callBare('pin:set', { pin });
      setPinCheckState('done');
    } catch {
      setPinError('Failed to set PIN');
    }
  }

  if (pinCheckState === 'checking') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: colors.surface.base }}>
        <p style={{ ...typography.body, color: colors.text.secondary }}>Loading...</p>
      </div>
    );
  }

  if (pinCheckState === 'needed') {
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: colors.surface.base,
        padding: `${spacing.xl}px`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          backgroundColor: colors.surface.card,
          borderRadius: `${radius.xl}px`,
          padding: `${spacing.xxl}px`,
          maxWidth: '360px', width: '100%',
          border: `1px solid ${colors.border}`,
        }}>
          <h2 style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.sm}px` }}>
            Set Override PIN
          </h2>
          <p style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.base}px` }}>
            This PIN lets your child temporarily unblock an app. Choose something they won't guess.
          </p>
          <form onSubmit={handlePinSubmit} style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.base}px` }}>
            <Input
              label="PIN"
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="Enter PIN"
              error={pinError && pin.length > 0 ? pinError : undefined}
            />
            <Input
              label="Confirm PIN"
              type="password"
              inputMode="numeric"
              value={pinConfirm}
              onChange={(e) => setPinConfirm(e.target.value)}
              placeholder="Re-enter PIN"
            />
            {pinError && <p style={{ ...typography.caption, color: colors.error, margin: 0 }}>{pinError}</p>}
            <Button variant="primary" type="submit" style={{ width: '100%', padding: `${spacing.md}px` }}>
              Set PIN
            </Button>
          </form>
        </div>
      </div>
    );
  }

  const ActiveTab = TABS.find((t) => t.key === tab)?.Component || Dashboard;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      backgroundColor: colors.surface.base, ...typography.body,
    }}>
      {banner && (
        <div style={{
          backgroundColor: `${colors.success}22`,
          color: colors.success,
          border: `1px solid ${colors.success}44`,
          padding: `${spacing.md}px ${spacing.base}px`,
          textAlign: 'center',
          ...typography.body,
          fontWeight: '500',
        }}>
          {banner}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <ActiveTab ref={tab === 'dashboard' ? dashRef : undefined} />
      </div>
      {tab === 'dashboard' && (
        <FAB icon="Plus" onPress={() => {
          if (dashRef.current?.showAddChild) dashRef.current.showAddChild();
        }} />
      )}
      <TabBar tabs={TABS} activeTab={tab} onTabChange={setTab} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/ParentApp.jsx
git commit -m "feat(ui): migrate ParentApp to themed TabBar, FAB, and primitives"
```

---

## Task 8: Child App - Tab Bar, FAB Migration

**Files:**
- Modify: `src/ui/components/ChildApp.jsx` (58 lines - full rewrite)

- [ ] **Step 1: Rewrite ChildApp.jsx with themed components**

```jsx
import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import TabBar from './TabBar.jsx';
import FAB from './FAB.jsx';
import ChildHome from './ChildHome.jsx';
import ChildRequests from './ChildRequests.jsx';
import Profile from './Profile.jsx';

const TABS = [
  { key: 'home', label: 'Home', icon: 'House', Component: ChildHome },
  { key: 'requests', label: 'Requests', icon: 'Bell', Component: ChildRequests },
  { key: 'profile', label: 'Profile', icon: 'User', Component: () => <Profile mode="child" /> },
];

export default function ChildApp() {
  const { colors, typography } = useTheme();
  const [tab, setTab] = useState('home');

  useEffect(() => {
    const unsub = window.onBareEvent('navigate:child:requests', () => setTab('requests'));
    return unsub;
  }, []);

  const ActiveTab = TABS.find((t) => t.key === tab)?.Component || ChildHome;

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100vh',
      backgroundColor: colors.surface.base, ...typography.body,
    }}>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <ActiveTab />
      </div>
      {tab === 'home' && (
        <FAB icon="Clock" onPress={() => setTab('requests')} />
      )}
      <TabBar tabs={TABS} activeTab={tab} onTabChange={setTab} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/ChildApp.jsx
git commit -m "feat(ui): migrate ChildApp to themed TabBar and FAB"
```

---

## Task 9: Dashboard and ChildCard Migration

**Files:**
- Modify: `src/ui/components/Dashboard.jsx` (180 lines)
- Modify: `src/ui/components/ChildCard.jsx` (111 lines)

- [ ] **Step 1: Rewrite ChildCard.jsx with theme and lock button**

```jsx
import React from 'react';
import { useTheme } from '../theme.js';
import Avatar from './Avatar.jsx';
import Icon from '../icons.js';
import Badge from './primitives/Badge.jsx';

function formatSeconds(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function ChildCard({ child, onPress, onLockToggle }) {
  const { colors, typography, spacing, radius, shadow } = useTheme();
  const {
    displayName, isOnline, currentApp, todayScreenTimeSeconds,
    bypassAlerts, pendingApprovals, pendingTimeRequests, locked,
  } = child;

  const hasAlerts = bypassAlerts > 0 || pendingApprovals > 0 || pendingTimeRequests > 0;

  // Build status line
  let statusText = 'All good';
  let statusColor = colors.success;
  if (pendingApprovals > 0) {
    statusText = `${pendingApprovals} pending approval${pendingApprovals > 1 ? 's' : ''}`;
    statusColor = colors.secondary;
  } else if (bypassAlerts > 0) {
    statusText = `${bypassAlerts} bypass alert${bypassAlerts > 1 ? 's' : ''}`;
    statusColor = colors.error;
  }

  return (
    <button
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        backgroundColor: colors.surface.card,
        border: `1px solid ${colors.border}`,
        borderRadius: `${radius.lg}px`,
        padding: `${spacing.base}px`,
        marginBottom: `${spacing.md}px`,
        cursor: 'pointer',
        boxShadow: shadow,
        position: 'relative',
      }}
      onClick={onPress}
      aria-label={`Open ${displayName}`}
    >
      {/* Lock toggle */}
      <div
        style={{ position: 'absolute', top: `${spacing.sm}px`, right: `${spacing.sm}px` }}
        onClick={(e) => { e.stopPropagation(); onLockToggle(); }}
      >
        <Icon
          name={locked ? 'LockSimple' : 'LockSimpleOpen'}
          size={20}
          color={locked ? colors.error : colors.text.muted}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', marginBottom: `${spacing.sm}px` }}>
        <Avatar avatar={child.avatarThumb} name={displayName} size={32} />
        <span style={{
          width: '10px', height: '10px', borderRadius: '50%',
          backgroundColor: isOnline ? colors.success : colors.text.muted,
          marginRight: `${spacing.sm}px`, flexShrink: 0,
        }} />
        <span style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', flex: 1 }}>
          {displayName}
        </span>
        {hasAlerts && (
          <div style={{ display: 'flex', gap: `${spacing.xs}px` }}>
            {bypassAlerts > 0 && <Badge color={colors.error}>{bypassAlerts}</Badge>}
            {pendingApprovals > 0 && <Badge color={colors.secondary}>{pendingApprovals}</Badge>}
            {pendingTimeRequests > 0 && <Badge color={colors.primary}>{pendingTimeRequests}</Badge>}
          </div>
        )}
      </div>
      <div style={{ ...typography.caption, color: statusColor, marginBottom: `${spacing.xs}px` }}>
        {statusText}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', ...typography.caption, color: colors.text.secondary }}>
        <span>{currentApp || 'No active app'}</span>
        <span>{formatSeconds(todayScreenTimeSeconds || 0)} today</span>
      </div>
    </button>
  );
}
```

- [ ] **Step 2: Update Dashboard.jsx to pass lock toggle and use theme**

The Dashboard needs these changes:
- Import `useTheme` and use theme tokens for all styles
- Replace the "Add Child" button in the header (now handled by FAB in ParentApp)
- Pass `onLockToggle` to each ChildCard
- Add `showAddChild` method exposed via `forwardRef` for the FAB
- Add lock confirmation modal
- Empty state with icon

```jsx
import React, { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';
import ChildCard from './ChildCard.jsx';
import ChildDetail from './ChildDetail.jsx';
import AddChildFlow from './AddChildFlow.jsx';

export default forwardRef(function Dashboard(props, ref) {
  const { colors, typography, spacing } = useTheme();
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedChild, setSelectedChild] = useState(null);
  const [selectedTab, setSelectedTab] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [lockTarget, setLockTarget] = useState(null); // child to lock/unlock

  function loadChildren() {
    window.callBare('children:list')
      .then((list) => {
        setChildren((list || []).map((c) => ({
          ...c,
          bypassAlerts: c.bypassAlerts || 0,
          pendingApprovals: c.pendingApprovals || 0,
          pendingTimeRequests: c.pendingTimeRequests || 0,
          todayScreenTimeSeconds: c.todayScreenTimeSeconds || 0,
          currentApp: c.currentApp || null,
          locked: c.locked || false,
        })));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => { loadChildren(); }, []);

  useEffect(() => {
    const unsubs = [
      window.onBareEvent('child:usageReport', (data) => {
        setChildren((prev) => prev.map((c) =>
          c.publicKey === data.childPublicKey
            ? { ...c, todayScreenTimeSeconds: data.todayScreenTimeSeconds, currentApp: data.currentApp }
            : c
        ));
      }),
      window.onBareEvent('child:timeRequest', (data) => {
        setChildren((prev) => prev.map((c) =>
          c.publicKey === data.childPublicKey ? { ...c, pendingTimeRequests: c.pendingTimeRequests + 1 } : c
        ));
      }),
      window.onBareEvent('alert:bypass', (data) => {
        setChildren((prev) => prev.map((c) =>
          c.publicKey === data.childPublicKey ? { ...c, bypassAlerts: c.bypassAlerts + 1 } : c
        ));
      }),
      window.onBareEvent('child:connected', () => { loadChildren(); setShowAdd(false); }),
      window.onBareEvent('child:unpaired', (data) => {
        setChildren((prev) => prev.filter((c) => c.publicKey !== data.childPublicKey));
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const navigateToChild = useCallback((publicKey, tab) => {
    const child = children.find((c) => c.publicKey === publicKey);
    if (child) {
      setSelectedChild(child);
      if (tab) setSelectedTab(tab);
    }
  }, [children]);

  useImperativeHandle(ref, () => ({
    navigateToChild,
    showAddChild: () => setShowAdd(true),
  }));

  async function handleLockToggle(child) {
    if (child.locked) {
      // Unlock immediately (no confirmation)
      await window.callBare('policy:setLock', { childPublicKey: child.publicKey, locked: false });
      setChildren((prev) => prev.map((c) => c.publicKey === child.publicKey ? { ...c, locked: false } : c));
    } else {
      setLockTarget(child);
    }
  }

  async function confirmLock() {
    if (!lockTarget) return;
    await window.callBare('policy:setLock', { childPublicKey: lockTarget.publicKey, locked: true });
    setChildren((prev) => prev.map((c) => c.publicKey === lockTarget.publicKey ? { ...c, locked: true } : c));
    setLockTarget(null);
  }

  if (selectedChild) {
    return (
      <ChildDetail
        child={selectedChild}
        initialTab={selectedTab}
        onBack={() => { setSelectedChild(null); setSelectedTab(null); loadChildren(); }}
      />
    );
  }

  if (showAdd) {
    return <AddChildFlow onConnected={() => { setShowAdd(false); loadChildren(); }} onCancel={() => setShowAdd(false)} />;
  }

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <h2 style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.base}px` }}>
        Dashboard
      </h2>

      {loading && <p style={{ ...typography.body, color: colors.text.secondary }}>Loading...</p>}

      {!loading && children.length === 0 && (
        <div style={{ textAlign: 'center', padding: `${spacing.xxxl}px ${spacing.base}px` }}>
          <Icon name="User" size={48} color={colors.text.muted} />
          <p style={{ ...typography.body, color: colors.text.secondary, marginTop: `${spacing.md}px` }}>
            No children added yet
          </p>
          <p style={{ ...typography.caption, color: colors.text.muted }}>
            Tap the + button to add your first child
          </p>
        </div>
      )}

      {children.map((child) => (
        <ChildCard
          key={child.publicKey}
          child={child}
          onPress={() => navigateToChild(child.publicKey)}
          onLockToggle={() => handleLockToggle(child)}
        />
      ))}

      <Modal
        visible={!!lockTarget}
        onClose={() => setLockTarget(null)}
        title={`Lock ${lockTarget?.displayName}'s device?`}
        footer={<>
          <Button variant="secondary" onClick={() => setLockTarget(null)}>Cancel</Button>
          <Button variant="primary" icon="LockSimple" onClick={confirmLock}>Lock</Button>
        </>}
      >
        All apps will be blocked until you unlock.
      </Modal>
    </div>
  );
});
```

- [ ] **Step 3: Commit**

```bash
git add src/ui/components/Dashboard.jsx src/ui/components/ChildCard.jsx
git commit -m "feat(ui): migrate Dashboard and ChildCard to theme with lock toggle"
```

---

## Task 10: Child Detail - Consolidated Tabs and Lock Toggle

**Files:**
- Modify: `src/ui/components/ChildDetail.jsx` (122 lines - full rewrite)

- [ ] **Step 1: Rewrite ChildDetail.jsx with 4 consolidated tabs and lock toggle**

```jsx
import React, { useState } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import Modal from './primitives/Modal.jsx';
import Avatar from './Avatar.jsx';
import UsageTab from './UsageTab.jsx';
import AppsTab from './AppsTab.jsx';
import ActivityTab from './ActivityTab.jsx';
import RulesTab from './RulesTab.jsx';

const TABS = [
  { key: 'usage', label: 'Usage', icon: 'ChartBar' },
  { key: 'apps', label: 'Apps', icon: 'SquaresFour' },
  { key: 'activity', label: 'Activity', icon: 'ListBullets' },
  { key: 'rules', label: 'Rules', icon: 'Shield' },
];

const TAB_COMPONENTS = { usage: UsageTab, apps: AppsTab, activity: ActivityTab, rules: RulesTab };

export default function ChildDetail({ child, initialTab, onBack }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [tab, setTab] = useState(initialTab || 'usage');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [locked, setLocked] = useState(child.locked || false);

  async function handleRemove() {
    await window.callBare('child:unpair', { childPublicKey: child.publicKey });
    onBack();
  }

  async function handleLockToggle() {
    const newLocked = !locked;
    await window.callBare('policy:setLock', { childPublicKey: child.publicKey, locked: newLocked });
    setLocked(newLocked);
  }

  const ActiveComponent = TAB_COMPONENTS[tab] || UsageTab;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', backgroundColor: colors.surface.base }}>
      {/* Top bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: `${spacing.md}px`,
        padding: `${spacing.md}px ${spacing.base}px`,
        borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
      }}>
        <button onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}>
          <Icon name="CaretLeft" size={20} color={colors.primary} />
        </button>
        <Avatar avatar={child.avatarThumb} name={child.displayName} size={32} />
        <span style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', flex: 1 }}>
          {child.displayName}
        </span>
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%',
          backgroundColor: child.isOnline ? colors.success : colors.text.muted,
        }} />

        {/* Lock toggle */}
        <button
          onClick={handleLockToggle}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}
          aria-label={locked ? 'Unlock device' : 'Lock device'}
        >
          <Icon name={locked ? 'LockSimple' : 'LockSimpleOpen'} size={20} color={locked ? colors.error : colors.text.muted} />
        </button>

        {/* Remove */}
        {!confirmRemove ? (
          <button
            onClick={() => setConfirmRemove(true)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px` }}
            aria-label="Remove child"
          >
            <Icon name="Trash" size={18} color={colors.text.muted} />
          </button>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
            <span style={{ ...typography.caption, color: colors.text.secondary }}>Remove?</span>
            <Button variant="danger" onClick={handleRemove} style={{ padding: `${spacing.xs}px ${spacing.sm}px` }}>Yes</Button>
            <Button variant="secondary" onClick={() => setConfirmRemove(false)} style={{ padding: `${spacing.xs}px ${spacing.sm}px` }}>No</Button>
          </div>
        )}
      </div>

      {/* Sub-tabs */}
      <div style={{
        display: 'flex', overflowX: 'auto',
        borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
      }}>
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <button
              key={t.key}
              onClick={() => { window.callBare('haptic:tap'); setTab(t.key); }}
              style={{
                flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`,
                padding: `${spacing.sm + 2}px ${spacing.md + 2}px`,
                border: 'none', background: 'none', cursor: 'pointer',
                borderBottom: `2px solid ${active ? colors.primary : 'transparent'}`,
                ...typography.caption,
                color: active ? colors.primary : colors.text.muted,
                fontWeight: active ? '600' : '400',
                whiteSpace: 'nowrap',
              }}
            >
              <Icon name={t.icon} size={16} color={active ? colors.primary : colors.text.muted} weight={active ? 'fill' : 'regular'} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <ActiveComponent childPublicKey={child.publicKey} />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/ChildDetail.jsx
git commit -m "feat(ui): consolidate ChildDetail to 4 tabs with lock toggle"
```

---

## Task 11: ActivityTab (Merge RequestsTab + AlertsTab)

**Files:**
- Create: `src/ui/components/ActivityTab.jsx`

- [ ] **Step 1: Create ActivityTab.jsx merging requests and alerts**

This component shows pending requests at the top (actionable cards) and historical activity events below.

```jsx
import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Card from './primitives/Card.jsx';
import Button from './primitives/Button.jsx';
import Badge from './primitives/Badge.jsx';

const TYPE_META = {
  bypass:          { label: 'Bypass Attempt',  icon: 'Warning' },
  pin_use:         { label: 'PIN Used',         icon: 'LockSimpleOpen' },
  time_request:    { label: 'Time Request',     icon: 'Clock' },
  app_installed:   { label: 'App Installed',    icon: 'Plus' },
  app_uninstalled: { label: 'App Uninstalled',  icon: 'Trash' },
  pin_override:    { label: 'PIN Override',     icon: 'LockSimpleOpen' },
};

function formatTime(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function formatSeconds(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function typeColor(type, colors) {
  if (type === 'bypass' || type === 'app_uninstalled') return colors.error;
  if (type === 'time_request' || type === 'pin_use' || type === 'pin_override') return colors.secondary;
  if (type === 'app_installed') return colors.success;
  return colors.text.muted;
}

function RequestCard({ req, childPublicKey, onResolved, colors, typography, spacing, radius }) {
  const [acting, setActing] = useState(false);
  const isExtraTime = req.requestType === 'extra_time';

  async function handleApprove() {
    setActing(true);
    try {
      if (isExtraTime) {
        await window.callBare('time:grant', {
          childPublicKey, requestId: req.id, packageName: req.packageName,
          extraSeconds: req.extraSeconds || 1800,
        });
      } else {
        await window.callBare('app:decide', { childPublicKey, packageName: req.packageName, decision: 'approve' });
      }
      onResolved();
    } catch (e) { console.error('approve failed:', e); }
    finally { setActing(false); }
  }

  async function handleDeny() {
    setActing(true);
    try {
      if (isExtraTime) {
        await window.callBare('time:deny', {
          childPublicKey, requestId: req.id, packageName: req.packageName,
          appName: req.appDisplayName || req.packageName,
        });
      } else {
        await window.callBare('app:decide', { childPublicKey, packageName: req.packageName, decision: 'deny' });
      }
      onResolved();
    } catch (e) { console.error('deny failed:', e); }
    finally { setActing(false); }
  }

  function approveLabel() {
    if (!isExtraTime) return 'Approve';
    if (!req.extraSeconds) return 'Grant Time';
    const mins = req.extraSeconds / 60;
    return mins >= 60 ? `Grant ${mins / 60}h` : `Grant ${mins}m`;
  }

  return (
    <Card style={{ marginBottom: `${spacing.sm}px` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ ...typography.body, color: colors.text.primary, fontWeight: '600' }}>
            {req.appDisplayName || req.packageName}
          </div>
          <Badge color={colors.secondary} style={{ marginTop: `${spacing.xs}px` }}>
            {isExtraTime ? 'Extra time' : 'App approval'}
          </Badge>
          <div style={{ ...typography.micro, color: colors.text.muted, marginTop: `${spacing.xs}px` }}>
            {formatTime(req.timestamp)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
          <Button variant="primary" onClick={handleApprove} disabled={acting}>{approveLabel()}</Button>
          <Button variant="danger" onClick={handleDeny} disabled={acting}>Deny</Button>
        </div>
      </div>
    </Card>
  );
}

function AlertRow({ alert, colors, typography, spacing }) {
  const meta = TYPE_META[alert.type] || { label: alert.type, icon: 'Info' };
  const color = typeColor(alert.type, colors);

  return (
    <div style={{
      display: 'flex', gap: `${spacing.sm}px`, alignItems: 'flex-start',
      padding: `${spacing.md}px 0`, borderBottom: `1px solid ${colors.divider}`,
    }}>
      <Icon name={meta.icon} size={18} color={color} />
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
          <Badge color={color}>{meta.label}</Badge>
        </div>
        <div style={{ ...typography.body, color: colors.text.primary, marginTop: `${spacing.xs}px` }}>
          {alert.appDisplayName || alert.packageName || 'Unknown app'}
          {alert.type === 'time_request' && alert.requestedSeconds
            ? ` - requesting ${formatSeconds(alert.requestedSeconds)}` : ''}
        </div>
        <div style={{ ...typography.micro, color: colors.text.muted, marginTop: `${spacing.xs}px` }}>
          {formatTime(alert.timestamp)}
        </div>
      </div>
      {alert.resolved && (
        <span style={{ ...typography.caption, color: colors.text.muted, fontStyle: 'italic' }}>
          {alert.status === 'approved' ? 'Approved' : alert.status === 'denied' ? 'Denied' : 'Resolved'}
        </span>
      )}
    </div>
  );
}

export default function ActivityTab({ childPublicKey }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  function reload() {
    window.callBare('alerts:list', { childPublicKey })
      .then((list) => { setItems(list || []); setLoading(false); })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    const unsubs = [
      window.onBareEvent('alert:bypass', reload),
      window.onBareEvent('time:request:received', reload),
      window.onBareEvent('app:installed', reload),
      window.onBareEvent('app:uninstalled', reload),
      window.onBareEvent('request:updated', reload),
    ];
    return () => unsubs.forEach((u) => u());
  }, [childPublicKey]);

  if (loading) return <div style={{ padding: `${spacing.base}px`, ...typography.body, color: colors.text.secondary }}>Loading activity...</div>;

  // Split into pending requests and historical events
  const pendingRequests = items.filter((a) => a.type === 'time_request' && !a.resolved);
  const history = items.filter((a) => a.type !== 'time_request' || a.resolved);

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      {pendingRequests.length > 0 && (
        <>
          <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', marginBottom: `${spacing.sm}px` }}>
            Pending Requests
          </h3>
          {pendingRequests.map((req) => (
            <RequestCard
              key={req.id} req={req} childPublicKey={childPublicKey}
              onResolved={reload} colors={colors} typography={typography}
              spacing={spacing} radius={radius}
            />
          ))}
        </>
      )}

      <h3 style={{
        ...typography.subheading, color: colors.text.primary, fontWeight: '600',
        marginTop: pendingRequests.length > 0 ? `${spacing.lg}px` : 0,
        marginBottom: `${spacing.sm}px`,
      }}>
        Activity Log
      </h3>
      {history.length === 0 && <p style={{ ...typography.body, color: colors.text.muted }}>No activity yet.</p>}
      {history.map((alert) => (
        <AlertRow key={alert.id} alert={alert} colors={colors} typography={typography} spacing={spacing} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/ActivityTab.jsx
git commit -m "feat(ui): create ActivityTab merging RequestsTab and AlertsTab"
```

---

## Task 12: RulesTab (Merge ScheduleTab + ContactsTab)

**Files:**
- Create: `src/ui/components/RulesTab.jsx`

- [ ] **Step 1: Create RulesTab.jsx combining schedule and contacts**

This component has two sections: "Schedule Rules" (blackout windows) and "Allowed Contacts" (whitelist). Uses accordion-style sections.

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Card from './primitives/Card.jsx';
import Button from './primitives/Button.jsx';
import Input from './primitives/Input.jsx';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const BLANK_RULE = { label: '', days: [], start: '21:00', end: '07:00', exemptApps: [] };

export default function RulesTab({ childPublicKey }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [newRule, setNewRule] = useState(BLANK_RULE);
  const [editingIndex, setEditingIndex] = useState(null);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [picking, setPicking] = useState(false);
  const [section, setSection] = useState('schedule'); // 'schedule' | 'contacts'

  const loadPolicy = useCallback(() => {
    window.callBare('policy:get', { childPublicKey })
      .then((p) => { setPolicy(p); setLoading(false); })
      .catch(() => setLoading(false));
  }, [childPublicKey]);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  // App names map
  const appNames = {};
  const appList = [];
  if (policy?.apps) {
    for (const [pkg, data] of Object.entries(policy.apps)) {
      appNames[pkg] = data.appName || pkg;
      appList.push({ packageName: pkg, appName: data.appName || pkg });
    }
    appList.sort((a, b) => a.appName.localeCompare(b.appName));
  }

  function saveSchedules(schedules) {
    const updated = { ...policy, schedules };
    setPolicy(updated);
    window.callBare('policy:update', { childPublicKey, policy: updated });
  }

  function saveContacts(contacts) {
    const updated = { ...policy, allowedContacts: contacts };
    setPolicy(updated);
    window.callBare('policy:update', { childPublicKey, policy: updated });
  }

  function handleDeleteRule(index) { saveSchedules(policy.schedules.filter((_, i) => i !== index)); }

  function handleEditRule(index) {
    setEditingIndex(index);
    setNewRule({ ...policy.schedules[index], exemptApps: policy.schedules[index].exemptApps || [] });
    setSubmitAttempted(false);
  }

  function handleCancelEdit() { setEditingIndex(null); setNewRule(BLANK_RULE); setSubmitAttempted(false); }

  function handleSaveRule() {
    setSubmitAttempted(true);
    if (!newRule.label.trim() || newRule.days.length === 0) return;
    let schedules;
    if (editingIndex !== null) {
      schedules = policy.schedules.map((r, i) => i === editingIndex ? newRule : r);
    } else {
      schedules = [...(policy.schedules || []), newRule];
    }
    saveSchedules(schedules);
    setNewRule(BLANK_RULE);
    setEditingIndex(null);
    setSubmitAttempted(false);
  }

  function toggleDay(dayIndex) {
    const days = newRule.days.includes(dayIndex)
      ? newRule.days.filter((d) => d !== dayIndex)
      : [...newRule.days, dayIndex].sort((a, b) => a - b);
    setNewRule({ ...newRule, days });
  }

  function toggleExemptApp(packageName) {
    const exempt = newRule.exemptApps || [];
    const updated = exempt.includes(packageName) ? exempt.filter((p) => p !== packageName) : [...exempt, packageName];
    setNewRule({ ...newRule, exemptApps: updated });
  }

  async function handleAddContact() {
    setPicking(true);
    try {
      const contact = await window.callBare('contacts:pick');
      if (contact?.phone) saveContacts([...(policy.allowedContacts || []), contact]);
    } catch { /* cancelled */ }
    finally { setPicking(false); }
  }

  function handleRemoveContact(index) {
    saveContacts(policy.allowedContacts.filter((_, i) => i !== index));
  }

  if (loading) return <div style={{ padding: `${spacing.base}px`, ...typography.body, color: colors.text.secondary }}>Loading rules...</div>;

  const schedules = policy?.schedules || [];
  const contacts = policy?.allowedContacts || [];

  const sectionBtn = (key, label, icon) => (
    <button
      onClick={() => setSection(key)}
      style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: `${spacing.xs}px`, padding: `${spacing.sm + 2}px`,
        border: 'none', background: 'none', cursor: 'pointer',
        borderBottom: `2px solid ${section === key ? colors.primary : 'transparent'}`,
        ...typography.caption, color: section === key ? colors.primary : colors.text.muted,
        fontWeight: section === key ? '600' : '400',
      }}
    >
      <Icon name={icon} size={16} color={section === key ? colors.primary : colors.text.muted} />
      {label}
    </button>
  );

  return (
    <div>
      {/* Section toggle */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.surface.card }}>
        {sectionBtn('schedule', 'Schedule', 'Clock')}
        {sectionBtn('contacts', 'Contacts', 'User')}
      </div>

      <div style={{ padding: `${spacing.base}px` }}>
        {section === 'schedule' && (
          <>
            <p style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.base}px`, lineHeight: '1.4' }}>
              Schedule rules define <strong>blackout windows</strong> - times when apps are blocked.
            </p>

            {schedules.length === 0 && <p style={{ ...typography.body, color: colors.text.muted }}>No blackout rules yet.</p>}
            {schedules.map((rule, i) => {
              const activeDays = DAY_LABELS.filter((_, d) => rule.days.includes(d)).join(', ');
              const exemptCount = (rule.exemptApps || []).length;
              const exemptLabel = exemptCount > 0
                ? (rule.exemptApps || []).map(pkg => appNames[pkg] || pkg).join(', ')
                : null;
              return (
                <Card key={i} style={{ marginBottom: `${spacing.sm}px` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ ...typography.body, color: colors.text.primary, fontWeight: '600' }}>{rule.label || '(no label)'}</div>
                      <div style={{ ...typography.caption, color: colors.text.secondary }}>{activeDays || 'No days'} - {rule.start}-{rule.end}</div>
                      {exemptLabel && <div style={{ ...typography.micro, color: colors.primary, marginTop: `${spacing.xs}px` }}>Exempt: {exemptLabel}</div>}
                    </div>
                    <Button variant="secondary" onClick={() => handleEditRule(i)} style={{ padding: `${spacing.xs}px ${spacing.sm}px` }}>Edit</Button>
                    <Button variant="danger" onClick={() => handleDeleteRule(i)} style={{ padding: `${spacing.xs}px ${spacing.sm}px` }}>Delete</Button>
                  </div>
                </Card>
              );
            })}

            <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', marginTop: `${spacing.lg}px`, marginBottom: `${spacing.sm}px` }}>
              {editingIndex !== null ? 'Edit Rule' : 'Add Rule'}
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.md}px` }}>
              <Input
                label="Label"
                value={newRule.label}
                onChange={(e) => setNewRule({ ...newRule, label: e.target.value })}
                placeholder="e.g. Bedtime"
                error={submitAttempted && !newRule.label.trim() ? 'Label is required' : undefined}
              />
              <div>
                <div style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.xs}px` }}>Days</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: `${spacing.sm}px` }}>
                  {DAY_LABELS.map((day, i) => (
                    <button
                      key={i}
                      onClick={() => toggleDay(i)}
                      style={{
                        padding: `${spacing.xs}px ${spacing.sm}px`,
                        borderRadius: `${radius.full}px`,
                        border: `1px solid ${newRule.days.includes(i) ? colors.primary : colors.border}`,
                        backgroundColor: newRule.days.includes(i) ? colors.primary : 'transparent',
                        color: newRule.days.includes(i) ? '#FFFFFF' : colors.text.secondary,
                        ...typography.caption, cursor: 'pointer',
                      }}
                    >
                      {day}
                    </button>
                  ))}
                </div>
                {submitAttempted && newRule.days.length === 0 && (
                  <span style={{ ...typography.caption, color: colors.error, marginTop: `${spacing.xs}px` }}>Select at least one day</span>
                )}
              </div>
              <div style={{ display: 'flex', gap: `${spacing.base}px` }}>
                <Input label="Blocked from" type="time" value={newRule.start} onChange={(e) => setNewRule({ ...newRule, start: e.target.value })} />
                <Input label="Blocked until" type="time" value={newRule.end} onChange={(e) => setNewRule({ ...newRule, end: e.target.value })} />
              </div>
              {appList.length > 0 && (
                <div>
                  <div style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.xs}px` }}>Exempt apps</div>
                  <p style={{ ...typography.micro, color: colors.text.muted, marginBottom: `${spacing.sm}px` }}>These apps will not be blocked during this window.</p>
                  <div style={{
                    display: 'flex', flexDirection: 'column', gap: `${spacing.xs + 2}px`,
                    maxHeight: '160px', overflowY: 'auto',
                    border: `1px solid ${colors.border}`, borderRadius: `${radius.md}px`, padding: `${spacing.sm}px`,
                  }}>
                    {appList.map(({ packageName, appName }) => (
                      <label key={packageName} style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`, ...typography.caption, color: colors.text.primary, cursor: 'pointer' }}>
                        <input type="checkbox" checked={(newRule.exemptApps || []).includes(packageName)} onChange={() => toggleExemptApp(packageName)} />
                        {appName}
                      </label>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
                <Button variant="primary" onClick={handleSaveRule}>{editingIndex !== null ? 'Save Changes' : 'Add Rule'}</Button>
                {editingIndex !== null && <Button variant="secondary" onClick={handleCancelEdit}>Cancel</Button>}
              </div>
            </div>
          </>
        )}

        {section === 'contacts' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: `${spacing.sm}px` }}>
              <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0 }}>Allowed Contacts</h3>
              <Button variant="primary" icon="Plus" onClick={handleAddContact} disabled={picking}>
                {picking ? 'Picking...' : 'Add Contact'}
              </Button>
            </div>
            <p style={{ ...typography.caption, color: colors.text.secondary, marginBottom: `${spacing.base}px` }}>
              These contacts can call and message the child even when the phone app is blocked.
            </p>
            {contacts.length === 0 && <p style={{ ...typography.body, color: colors.text.muted }}>No contacts added yet.</p>}
            {contacts.map((contact, i) => (
              <Card key={i} style={{ marginBottom: `${spacing.sm}px` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ ...typography.body, color: colors.text.primary, fontWeight: '500' }}>{contact.name}</div>
                    <div style={{ ...typography.caption, color: colors.text.secondary }}>{contact.phone}</div>
                  </div>
                  <Button variant="danger" onClick={() => handleRemoveContact(i)} style={{ padding: `${spacing.xs}px ${spacing.sm}px` }}>
                    Remove
                  </Button>
                </div>
              </Card>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/RulesTab.jsx
git commit -m "feat(ui): create RulesTab merging ScheduleTab and ContactsTab"
```

---

## Task 13: Remaining Screen Migrations (ChildHome, Settings, Profile, UsageTab, AppsTab, AddChildFlow, AboutTab, Avatar, AvatarPicker)

**Files:**
- Modify: `src/ui/components/ChildHome.jsx`
- Modify: `src/ui/components/Settings.jsx`
- Modify: `src/ui/components/Profile.jsx`
- Modify: `src/ui/components/UsageTab.jsx`
- Modify: `src/ui/components/AppsTab.jsx`
- Modify: `src/ui/components/AddChildFlow.jsx`
- Modify: `src/ui/components/AboutTab.jsx`
- Modify: `src/ui/components/Avatar.jsx`
- Modify: `src/ui/components/AvatarPicker.jsx`
- Create: `src/ui/components/LockOverlay.jsx`

Each file follows the same migration pattern:
1. Import `useTheme` from `../theme.js` (or `../../theme.js` for primitives)
2. Call `const { colors, typography, spacing, radius } = useTheme();` inside the component
3. Replace hardcoded style values with theme tokens
4. Replace Unicode symbols with Phosphor `<Icon>` components where applicable
5. Use primitive components (Button, Card, Input, Badge, Toggle) where they fit

- [ ] **Step 1: Create LockOverlay.jsx**

```jsx
// src/ui/components/LockOverlay.jsx
import React from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';

export default function LockOverlay({ parentName }) {
  const { colors, typography, spacing } = useTheme();

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: colors.surface.base,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      zIndex: 200,
    }}>
      <Icon name="LockSimple" size={64} color={colors.error} />
      <h2 style={{ ...typography.heading, color: colors.text.primary, marginTop: `${spacing.xl}px` }}>
        Device locked{parentName ? ` by ${parentName}` : ''}
      </h2>
      <p style={{ ...typography.body, color: colors.text.secondary, marginTop: `${spacing.sm}px` }}>
        Contact your parent to unlock
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Update ChildHome.jsx with theme and lock overlay**

Rewrite `src/ui/components/ChildHome.jsx`. The component logic (loadHomeData, event listeners, refresh interval) stays identical. Changes: theme tokens for all styles, Card primitives for stat boxes and overrides, LockOverlay when `homeData.locked` is true, greeting with display typography.

```jsx
import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../theme.js';
import Card from './primitives/Card.jsx';
import LockOverlay from './LockOverlay.jsx';

function timeRemaining(expiresAt) {
  const diff = Math.max(0, expiresAt - Date.now());
  const mins = Math.ceil(diff / 60000);
  if (mins >= 60) return Math.floor(mins / 60) + 'h ' + (mins % 60) + 'm';
  return mins + 'm';
}

export default function ChildHome() {
  const { colors, typography, spacing } = useTheme();
  const [homeData, setHomeData] = useState(null);

  const loadHomeData = useCallback(() => {
    window.callBare('child:homeData').then(setHomeData).catch(() => {});
  }, []);

  useEffect(() => {
    let isMounted = true;
    loadHomeData();
    function onPearEvent(event) {
      if (!isMounted) return;
      const { name } = event.detail;
      if (name === 'policy:updated' || name === 'override:granted' || name === 'request:updated' || name === 'request:submitted') {
        loadHomeData();
      }
    }
    window.addEventListener('__pearEvent', onPearEvent);
    const timer = setInterval(loadHomeData, 30000);
    return () => { isMounted = false; window.removeEventListener('__pearEvent', onPearEvent); clearInterval(timer); };
  }, [loadHomeData]);

  if (!homeData) return <div style={{ padding: spacing.xl, ...typography.body, color: colors.text.secondary }}>Loading...</div>;

  if (homeData.locked) {
    return <LockOverlay parentName={homeData.parentName} />;
  }

  const statColor = (type) => {
    if (type === 'blocked') return colors.error;
    if (type === 'pending') return colors.secondary;
    return colors.primary;
  };

  return (
    <div style={{ padding: spacing.xl }}>
      <h2 style={{ ...typography.display, color: colors.text.primary, marginBottom: `${spacing.lg}px` }}>
        Hi, {homeData.childName || 'there'}
      </h2>

      <div style={{ display: 'flex', gap: spacing.md }}>
        {[
          { label: 'Blocked', count: homeData.blockedCount, type: 'blocked' },
          { label: 'Awaiting approval', count: homeData.pendingCount, type: 'pending' },
          { label: 'Pending requests', count: homeData.pendingRequests, type: 'requests' },
        ].map((stat) => (
          <Card key={stat.label} style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ fontSize: '22px', fontWeight: '700', color: statColor(stat.type) }}>{stat.count}</div>
            <div style={{ ...typography.micro, color: colors.text.muted, marginTop: spacing.xs }}>{stat.label}</div>
          </Card>
        ))}
      </div>

      {homeData.activeOverrides.length > 0 && (
        <div style={{ marginTop: spacing.xl }}>
          <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', marginBottom: `${spacing.sm}px` }}>
            Active overrides
          </h3>
          {homeData.activeOverrides.map((o, i) => (
            <Card key={i} style={{ marginBottom: spacing.sm, border: `1px solid ${colors.primary}44` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ ...typography.body, color: colors.text.primary, fontWeight: '600' }}>{o.appName}</div>
                  <div style={{ ...typography.caption, color: colors.text.secondary, marginTop: spacing.xs }}>
                    {o.source === 'parent-approved' ? 'Granted by parent' : 'PIN override'}
                  </div>
                </div>
                <div style={{ ...typography.body, color: colors.primary, fontWeight: '600' }}>
                  {timeRemaining(o.expiresAt)} left
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Update Settings.jsx with theme and toggle**

Migrate all styles to theme tokens. Replace the chip selectors with themed chip buttons. Add a theme toggle (dark/light) using the Toggle primitive. Replace hardcoded colors. Keep all existing logic.

Key style replacements throughout the file:
- `backgroundColor: '#fff'` -> `backgroundColor: colors.surface.card`
- `color: '#444'` / `'#555'` / `'#333'` -> `color: colors.text.primary` or `colors.text.secondary`
- `color: '#888'` -> `color: colors.text.muted`
- `backgroundColor: '#1a73e8'` -> `backgroundColor: colors.primary`
- `color: '#ea4335'` -> `color: colors.error`
- `color: '#34a853'` -> `color: colors.success`
- `border: '1px solid #ccc'` -> `border: \`1px solid ${colors.border}\``
- `fontFamily: 'sans-serif'` -> remove (inherited from theme typography)

Add at the top of Settings component, after the existing state hooks:
```jsx
const { colors, typography, spacing, radius, theme: currentTheme, setTheme } = useTheme();
```

Add a Theme section before the Save button:
```jsx
<div style={{ marginBottom: `${spacing.xxl}px` }}>
  <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', marginBottom: `${spacing.sm}px` }}>Theme</h3>
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
      <Icon name={currentTheme === 'dark' ? 'Moon' : 'SunDim'} size={20} color={colors.text.primary} />
      <span style={{ ...typography.body, color: colors.text.primary }}>{currentTheme === 'dark' ? 'Dark mode' : 'Light mode'}</span>
    </div>
    <Toggle checked={currentTheme === 'dark'} onChange={(checked) => setTheme(checked ? 'dark' : 'light')} />
  </div>
</div>
```

- [ ] **Step 4: Update Profile.jsx with theme**

Migrate all styles. Replace `&#9998;` edit icon with `<Icon name="PencilSimple" size={13} color="#FFFFFF" />`. Replace all hardcoded colors with theme tokens. Use Button and Input primitives where they replace existing inputs/buttons.

- [ ] **Step 5: Update UsageTab.jsx with theme**

Migrate bar colors: `#1a73e8` -> `colors.primary`, `#ea4335` -> `colors.error`, `#34a853` -> `colors.success`. Track backgrounds: `#eee` -> `colors.surface.elevated`. Text colors from theme.

- [ ] **Step 6: Update AppsTab.jsx with theme**

This is the largest file (575 lines). Migration pattern is the same: import `useTheme`, replace all hardcoded colors/spacing with theme tokens. Replace text symbols (>, <, checkmark) with Phosphor icons where used as UI elements. Keep all existing logic unchanged.

- [ ] **Step 7: Update AddChildFlow.jsx with theme**

Migrate styles. QR code canvas wrapper gets themed background. Buttons use Button primitive.

- [ ] **Step 8: Update AboutTab.jsx with theme**

Migrate card backgrounds, text colors, button styles. Replace `&#8599;` with appropriate treatment (keep as text, it's a standard arrow character).

- [ ] **Step 9: Update Avatar.jsx and AvatarPicker.jsx with theme**

Migrate colors. AvatarPicker overlay uses theme surface colors instead of hardcoded.

- [ ] **Step 10: Commit**

```bash
git add src/ui/components/LockOverlay.jsx src/ui/components/ChildHome.jsx src/ui/components/Settings.jsx src/ui/components/Profile.jsx src/ui/components/UsageTab.jsx src/ui/components/AppsTab.jsx src/ui/components/AddChildFlow.jsx src/ui/components/AboutTab.jsx src/ui/components/Avatar.jsx src/ui/components/AvatarPicker.jsx
git commit -m "feat(ui): migrate all remaining screens to theme system"
```

---

## Task 14: Quick-Lock Backend

**Files:**
- Modify: `src/bare-dispatch.js` (add policy:setLock and policy:getLock cases)

- [ ] **Step 1: Add policy:setLock dispatch method**

In `src/bare-dispatch.js`, add a new case in the dispatch switch. Find the section with other `policy:` methods and add:

```js
case 'policy:setLock': {
  const { childPublicKey, locked } = args;
  const policyKey = 'policy:' + childPublicKey;
  let policy = await db.get(policyKey);
  policy = policy ? JSON.parse(policy.value.toString()) : {};
  policy.locked = !!locked;
  await db.put(policyKey, JSON.stringify(policy));
  // Send to child if connected
  const peer = connectedPeers.get(childPublicKey);
  if (peer) {
    peer.write(Buffer.from(JSON.stringify({ type: 'policy:update', payload: policy }) + '\n'));
  }
  return {};
}
```

- [ ] **Step 2: Add settings:setTheme and settings:getTheme dispatch methods**

```js
case 'settings:setTheme': {
  const { theme } = args;
  await db.put('settings:theme', theme);
  return {};
}
case 'settings:getTheme': {
  const entry = await db.get('settings:theme');
  return { theme: entry ? entry.value.toString() : 'dark' };
}
```

- [ ] **Step 3: Update child:homeData to include lock state and child name**

In the `child:homeData` case, add `locked` and `childName` to the returned object:

```js
// After existing code that builds the homeData response:
const policy = /* existing policy fetch */;
homeData.locked = !!policy.locked;
// Get child's own display name
const identity = await db.get('identity:name');
homeData.childName = identity ? identity.value.toString() : '';
// Get parent name for lock overlay
if (policy.locked) {
  // parentName comes from the paired parent's stored data
  const peers = /* existing peers list */;
  homeData.parentName = peers.length > 0 ? peers[0].displayName : '';
}
```

- [ ] **Step 4: Commit**

```bash
git add src/bare-dispatch.js
git commit -m "feat: add policy:setLock and theme persistence to bare dispatch"
```

---

## Task 15: Clean Up Old Files and Update Tests

**Files:**
- Delete: `src/ui/components/RequestsTab.jsx` (merged into ActivityTab)
- Delete: `src/ui/components/ScheduleTab.jsx` (merged into RulesTab)
- Delete: `src/ui/components/ContactsTab.jsx` (merged into RulesTab)
- Delete: `src/ui/components/AlertsTab.jsx` (merged into ActivityTab)
- Update: all test files to account for theme and new component structure

- [ ] **Step 1: Delete merged files**

```bash
git rm src/ui/components/RequestsTab.jsx src/ui/components/ScheduleTab.jsx src/ui/components/ContactsTab.jsx src/ui/components/AlertsTab.jsx
```

- [ ] **Step 2: Update test files**

All test files that render components need to mock the theme. Add to `jest.setup.js`:

```js
// Mock callBare for theme init
window.callBare = jest.fn().mockResolvedValue({});
```

Each test file that imports a component using `useTheme` needs the theme module available. Since the tests use jsdom and the components import from `../theme.js`, the theme module's module-level state will work as-is (defaults to dark theme).

Update test files for:
- `ChildDetail.test.jsx` - update TABS expectation from 6 to 4 (usage, apps, activity, rules)
- `ParentApp.test.jsx` - update to expect TabBar component instead of inline tab buttons
- `ChildApp.test.jsx` - update to expect TabBar component
- `Dashboard.test.jsx` - add lock toggle expectations
- `ChildHome.test.jsx` - add lock overlay test case
- Delete: `src/ui/components/__tests__/AlertsTab.test.jsx`
- Delete: `src/ui/components/__tests__/ContactsTab.test.jsx`
- Delete: `src/ui/components/__tests__/ScheduleTab.test.jsx`

```bash
git rm src/ui/components/__tests__/AlertsTab.test.jsx src/ui/components/__tests__/ContactsTab.test.jsx src/ui/components/__tests__/ScheduleTab.test.jsx
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: remove merged tab files and update tests for UI overhaul"
```

---

## Task 16: Build, Install, and Verify

- [ ] **Step 1: Run build:bare (since bare-dispatch.js changed)**

```bash
cd /home/tim/peerloomllc/pearguard
npm run build:bare
```

- [ ] **Step 2: Run build:ui**

```bash
npm run build:ui
```

- [ ] **Step 3: Build Android APK**

```bash
cd android && ./gradlew assembleDebug && cd ..
```

- [ ] **Step 4: Install on both test devices**

```bash
adb -s <parent-serial> install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s <child-serial> install -r android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 5: On-device verification checklist**

Verify on parent device:
- Dark theme loads by default
- Bottom tab bar shows Phosphor icons (House, GearSix, Info)
- FAB (green +) appears on Dashboard tab
- Child cards show lock icon
- Tapping lock icon shows confirmation modal
- Child detail has 4 tabs (Usage, Apps, Activity, Rules)
- Settings has theme toggle (dark/light)
- PIN overlay uses themed colors

Verify on child device:
- Dark theme loads by default
- Bottom tab bar shows Phosphor icons (House, Bell, User)
- FAB (clock) appears on Home tab
- Greeting shows "Hi, [name]"
- Stat cards use theme colors
- When parent locks device, lock overlay appears

Verify quick-lock:
- Parent taps lock on child card, confirms
- Child sees lock overlay
- Parent taps unlock
- Child lock overlay disappears
