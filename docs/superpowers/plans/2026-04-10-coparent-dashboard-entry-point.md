# Co-Parent Dashboard Entry Point Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Parent B a way to accept co-parent invites from the Dashboard via QR scan or paste, and fix deep link handling so co-parent invite URLs work on both iOS and Android.

**Architecture:** New `JoinCoparentCard` component rendered inline on Dashboard (same toggle pattern as `InviteCard`). Deep link fixes in `app.json` (Android intent filter) and `app/coparent.tsx` (URL decoding).

**Tech Stack:** React (WebView UI), Expo Router, React Native

---

### Task 1: Create JoinCoparentCard component

**Files:**
- Create: `src/ui/components/JoinCoparentCard.jsx`

- [ ] **Step 1: Create `JoinCoparentCard.jsx`**

This component handles the Parent B side of co-parent pairing. It provides scan and paste options, manages connection state, and shows success/error feedback. Follows the same card pattern as `CoparentInviteCard.jsx` and the pairing state machine from `Profile.jsx`.

```jsx
import React, { useState } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';

export default function JoinCoparentCard({ onConnected, onDismiss }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [state, setState] = useState('idle'); // 'idle' | 'connecting' | 'success' | 'error'
  const [error, setError] = useState(null);
  const [linkInput, setLinkInput] = useState('');

  async function handleScan() {
    setState('idle');
    setError(null);
    try {
      const url = await window.callBare('qr:scan');
      setState('connecting');
      await window.callBare('coparent:acceptInvite', [url]);
      setState('success');
      setTimeout(() => onConnected(), 1500);
    } catch (e) {
      if (e.message === 'cancelled') {
        setState('idle');
      } else {
        setState('error');
        setError(e.message);
      }
    }
  }

  async function handlePaste() {
    const url = linkInput.trim();
    if (!url.startsWith('pear://pearguard/coparent?t=')) {
      setState('error');
      setError('Not a valid co-parent invite link');
      return;
    }
    setState('connecting');
    setError(null);
    try {
      await window.callBare('coparent:acceptInvite', [url]);
      setState('success');
      setTimeout(() => onConnected(), 1500);
    } catch (e) {
      setState('error');
      setError(e.message);
    }
  }

  const cardStyle = {
    backgroundColor: colors.surface.card,
    border: `1px solid ${colors.border}`,
    borderRadius: `${radius.lg}px`,
    padding: `${spacing.base}px`,
    marginBottom: `${spacing.md}px`,
  };

  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: `${spacing.sm}px` }}>
        <h3 style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', margin: 0 }}>
          Join as Co-Parent
        </h3>
        <button
          onClick={onDismiss}
          style={{
            background: 'none', border: 'none', cursor: 'pointer', padding: `${spacing.xs}px`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          aria-label="Dismiss"
        >
          <Icon name="X" size={20} color={colors.text.muted} />
        </button>
      </div>

      <p style={{ ...typography.caption, color: colors.text.secondary, margin: 0, marginBottom: `${spacing.base}px` }}>
        If another parent already set up your child's device, ask them to share a co-parent invite. This lets you both manage the same child with shared policies.
      </p>

      {state === 'idle' && (
        <>
          <div style={{ display: 'flex', gap: `${spacing.sm}px`, marginBottom: `${spacing.md}px` }}>
            <Button variant="primary" icon="QrCode" onClick={() => { window.callBare('haptic:tap'); handleScan(); }} style={{ flex: 1 }}>
              Scan QR Code
            </Button>
          </div>

          <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
            <input
              type="text"
              value={linkInput}
              onChange={(e) => setLinkInput(e.target.value)}
              placeholder="Paste invite link"
              style={{
                flex: 1, padding: `${spacing.sm}px ${spacing.md}px`,
                backgroundColor: colors.surface.elevated, color: colors.text.primary,
                border: `1px solid ${colors.border}`, borderRadius: `${radius.md}px`,
                ...typography.body, outline: 'none',
              }}
            />
            <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); handlePaste(); }} disabled={!linkInput.trim()}>
              Join
            </Button>
          </div>
        </>
      )}

      {state === 'connecting' && (
        <p style={{ ...typography.caption, color: colors.text.muted, fontStyle: 'italic', margin: 0, textAlign: 'center' }}>
          Connecting to co-parent...
        </p>
      )}

      {state === 'success' && (
        <p style={{ ...typography.caption, color: colors.success, margin: 0, textAlign: 'center' }}>
          Connected! Loading child...
        </p>
      )}

      {state === 'error' && (
        <div>
          <p style={{ ...typography.caption, color: colors.error, margin: 0, marginBottom: `${spacing.sm}px` }}>{error}</p>
          <Button variant="secondary" onClick={() => { setState('idle'); setError(null); }}>
            Try Again
          </Button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/JoinCoparentCard.jsx
git commit -m "feat(#127): add JoinCoparentCard component for co-parent scan/paste"
```

---

### Task 2: Add "Join as Co-Parent" button to Dashboard

**Files:**
- Modify: `src/ui/components/Dashboard.jsx`

- [ ] **Step 1: Add import and state**

At top of `Dashboard.jsx`, add the import after the `InviteCard` import (line 8):

```jsx
import JoinCoparentCard from './JoinCoparentCard.jsx';
```

Add state inside the `Dashboard` component, after the `inviteActive` state (line 16):

```jsx
const [joinCoparentActive, setJoinCoparentActive] = useState(false);
```

- [ ] **Step 2: Add the button next to "Add Child"**

Replace the existing "Add Child" button block (lines 160-172) with a version that includes both buttons:

```jsx
{!inviteActive && !joinCoparentActive && !loading && children.length > 0 && (
  <div style={{ display: 'flex', gap: `${spacing.sm}px`, alignItems: 'center' }}>
    <button
      onClick={() => { window.callBare('haptic:tap'); setJoinCoparentActive(true); }}
      style={{
        background: 'none', border: `1px solid ${colors.primary}`, cursor: 'pointer',
        ...typography.caption, color: colors.primary, fontWeight: '600',
        display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`,
        padding: `${spacing.xs}px ${spacing.sm}px`, borderRadius: `${radius.md}px`,
      }}
    >
      <Icon name="UserPlus" size={14} color={colors.primary} />
      Join as Co-Parent
    </button>
    <button
      onClick={() => { window.callBare('haptic:tap'); setInviteActive(true); }}
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        ...typography.body, color: colors.primary, fontWeight: '600',
        display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`,
      }}
    >
      <Icon name="Plus" size={16} color={colors.primary} />
      Add Child
    </button>
  </div>
)}
```

- [ ] **Step 3: Render JoinCoparentCard below InviteCard**

After the `InviteCard` block (after line 197), add:

```jsx
{joinCoparentActive && (
  <JoinCoparentCard
    onConnected={() => { setJoinCoparentActive(false); loadChildren(); }}
    onDismiss={() => setJoinCoparentActive(false)}
  />
)}
```

- [ ] **Step 4: Dismiss join card on child:connected event**

In the `child:connected` event handler (line 92), also dismiss the join card:

```jsx
window.onBareEvent('child:connected', () => { loadChildren(); setInviteActive(false); setJoinCoparentActive(false); }),
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/Dashboard.jsx
git commit -m "feat(#127): add Join as Co-Parent button to Dashboard"
```

---

### Task 3: Add Android intent filter for /coparent deep links

**Files:**
- Modify: `app.json`

- [ ] **Step 1: Add coparent intent filter**

In `app.json`, add a second entry to the `intentFilters` array (after the existing `/join` filter, line 43):

```json
{
  "action": "VIEW",
  "autoVerify": false,
  "data": [
    {
      "scheme": "pear",
      "host": "pearguard",
      "pathPrefix": "/coparent"
    }
  ],
  "category": [
    "BROWSABLE",
    "DEFAULT"
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add app.json
git commit -m "fix(#127): add /coparent intent filter for Android deep links"
```

---

### Task 4: Fix iOS co-parent deep link INVALID_INVITE error

**Files:**
- Modify: `app/coparent.tsx`

The issue: when iOS opens a `pear://pearguard/coparent?t=<base64url>` link, Expo Router parses the URL and extracts the `t` query parameter via `useLocalSearchParams`. iOS may percent-encode special characters in the URL before passing it to the app. The base64url payload contains `-` and `_` characters which should survive, but the `coparent.tsx` route reconstructs the URL and emits it.

The real problem is that `useLocalSearchParams` may return `undefined` for the `t` param if Expo Router doesn't match the route correctly for the `pear://` custom scheme on iOS. The route file is `app/coparent.tsx` which maps to the path `/coparent`, but the incoming URL is `pear://pearguard/coparent?t=...` where `pearguard` is the host.

- [ ] **Step 1: Fix coparent.tsx to handle URL robustly**

Replace the entire `app/coparent.tsx` with a version that also reads the raw URL via Expo's Linking API as a fallback, and decodes the `t` param:

```tsx
// app/coparent.tsx
//
// Expo Router screen for pear://pearguard/coparent?t=<encoded> deep links.
// Same pattern as join.tsx but for co-parent invites.

import { useEffect } from 'react'
import { View, Text, StyleSheet, DeviceEventEmitter, Linking } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'

export default function CoparentRoute () {
  const params = useLocalSearchParams<{ t?: string }>()
  const router = useRouter()

  useEffect(() => {
    let inviteUrl: string | null = null

    // Primary: use search param from Expo Router
    if (params.t) {
      const decoded = decodeURIComponent(params.t)
      inviteUrl = `pear://pearguard/coparent?t=${decoded}`
    }

    if (inviteUrl) {
      console.log('[coparent] forwarding invite:', inviteUrl)
      setTimeout(() => {
        DeviceEventEmitter.emit('pearguardLink', inviteUrl)
      }, 1500)
    } else {
      // Fallback: read the raw URL from Linking API
      Linking.getInitialURL().then((rawUrl) => {
        if (rawUrl && rawUrl.includes('/coparent')) {
          console.log('[coparent] forwarding raw URL:', rawUrl)
          DeviceEventEmitter.emit('pearguardLink', rawUrl)
        } else {
          console.warn('[coparent] no invite param found in URL')
        }
      })
    }

    setTimeout(() => router.replace('/'), 2000)
  }, [])

  return (
    <View style={styles.container}>
      <Text style={styles.text}>Connecting to co-parent...</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  text:      { color: '#6FCF97', fontSize: 18 },
})
```

- [ ] **Step 2: Apply the same decodeURIComponent fix to join.tsx for consistency**

In `app/join.tsx`, update the URL reconstruction to decode the param:

```tsx
if (t) {
  const decoded = decodeURIComponent(t)
  const inviteUrl = `pear://pearguard/join?t=${decoded}`
```

- [ ] **Step 3: Commit**

```bash
git add app/coparent.tsx app/join.tsx
git commit -m "fix(#127): decode URL params in deep link routes for iOS compatibility"
```

---

### Task 5: Build, install, and test

**Files:** None (build and deploy)

- [ ] **Step 1: Build UI**

```bash
npm run build:ui
```

- [ ] **Step 2: Build Android APK and install on parent device**

```bash
cd android && ./gradlew assembleDebug && cd ..
adb install -r /home/tim/peerloomllc/pearguard/android/app/build/outputs/apk/debug/app-debug.apk
```

- [ ] **Step 3: Build and install iOS (for deep link testing)**

```bash
npm run build:bare:ios
npm run build:bare:ios-sim
npm run build:ui
```

Then sync + build on Mac Mini per CLAUDE.md iOS build instructions.

- [ ] **Step 4: On-device verification checklist**

Verify on parent device:
1. Dashboard shows "Join as Co-Parent" button next to "Add Child"
2. Tapping it shows the JoinCoparentCard with info text, scan button, and paste input
3. Dismissing the card works (X button)
4. Scan QR code flow works (scan Parent A's co-parent QR -> connects)
5. Paste link flow works (paste a co-parent link -> connects)
6. Invalid link shows error with retry option
7. Deep link from another app/browser opens PearGuard and triggers co-parent accept

- [ ] **Step 5: Commit any fixes from testing**
