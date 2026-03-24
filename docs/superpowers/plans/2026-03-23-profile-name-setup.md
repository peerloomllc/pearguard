# Profile Name at Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Force every new user to enter a display name during first-launch setup, so paired devices see a real name instead of "PearGuard Device".

**Architecture:** Add a `'name'` step to the existing `step` state machine in `app/setup.tsx`. After the user selects their role (parent/child) and `setMode` succeeds, the screen transitions to a name entry form. On save, `identity:setName` is called; then parents proceed to the existing PIN step, children navigate to `/child-setup`. No changes to `bare.js`, `bare-dispatch.js`, or any other file — `identity:setName` already exists and `hello` messages already carry `profile.displayName`.

**Tech Stack:** React Native (Expo), TypeScript, `_callBare` IPC injected via `setBareCaller`.

---

## Files

| File | Change |
|------|--------|
| `app/setup.tsx` | Modify — add `'name'` step, `selectedMode` state, `name` state, `handleSetName` handler, name step render branch |

No other files change.

---

### Task 1: Add state variables and expand step type

**Files:**
- Modify: `app/setup.tsx`

**Context:** The current state declarations are at the top of `SetupScreen`. `step` is typed `'mode' | 'pin'`. We need to add `'name'` to the union and add two new state variables: `selectedMode` (remembers which role was chosen while the name step is shown) and `name` (the text field value).

- [ ] **Step 1: Read the current state block**

Open `app/setup.tsx` and find this block (currently lines 23–29):

```typescript
const [step, setStep]           = useState<'mode' | 'pin'>('mode')
const [loading, setLoading]     = useState(false)
const [error, setError]         = useState<string | null>(null)
const [pin, setPin]             = useState('')
const [confirmPin, setConfirmPin] = useState('')
const confirmPinRef             = useRef<TextInput>(null)
const router = useRouter()
```

- [ ] **Step 2: Replace the state block**

Replace the block above with:

```typescript
const [step, setStep]             = useState<'mode' | 'name' | 'pin'>('mode')
const [selectedMode, setSelectedMode] = useState<'parent' | 'child' | null>(null)
const [loading, setLoading]       = useState(false)
const [error, setError]           = useState<string | null>(null)
const [name, setName]             = useState('')
const [pin, setPin]               = useState('')
const [confirmPin, setConfirmPin] = useState('')
const confirmPinRef               = useRef<TextInput>(null)
const router = useRouter()
```

- [ ] **Step 3: Verify the file saves cleanly (no TypeScript errors visible)**

TypeScript errors will be caught at build time, not in the editor for this project. Just confirm the file is saved.

---

### Task 2: Update `selectMode` to transition to the name step

**Files:**
- Modify: `app/setup.tsx`

**Context:** Currently `selectMode` navigates immediately after `setMode` succeeds. We want it to stay on-screen and show the name step instead. The `loading` state is set to `true` before the bare call and must be reset to `false` before transitioning (matching the existing pattern for the parent branch).

- [ ] **Step 1: Find the current `selectMode` function**

It currently looks like this:

```typescript
async function selectMode (mode: 'parent' | 'child') {
  if (!_callBare) { setError('App not ready — please wait'); return }
  setLoading(true)
  try {
    await _callBare('setMode', [mode])
    if (mode === 'child') {
      router.replace('/child-setup')
    } else {
      setLoading(false)
      setStep('pin')
    }
  } catch (e: any) {
    setError(e.message)
    setLoading(false)
  }
}
```

- [ ] **Step 2: Replace `selectMode` with the updated version**

```typescript
async function selectMode (mode: 'parent' | 'child') {
  if (!_callBare) { setError('App not ready — please wait'); return }
  setLoading(true)
  try {
    await _callBare('setMode', [mode])
    setSelectedMode(mode)
    setLoading(false)
    setStep('name')
  } catch (e: any) {
    setError(e.message)
    setLoading(false)
  }
}
```

Note: The `catch` block is unchanged — on `setMode` failure the user stays on the mode step with the error shown.

---

### Task 3: Add `handleSetName` handler

**Files:**
- Modify: `app/setup.tsx`

**Context:** Add the async handler that validates the name, calls `identity:setName`, and transitions to the next step. Place it immediately after `selectMode` and before `handleSetPin`.

- [ ] **Step 1: Add `handleSetName` after `selectMode`**

Insert this function between `selectMode` and `handleSetPin`:

```typescript
async function handleSetName () {
  if (!_callBare) return
  if (!name.trim()) { setError('Name is required.'); return }
  setError(null)
  setLoading(true)
  try {
    await _callBare('identity:setName', { name: name.trim() })
    setLoading(false)
    if (selectedMode === 'parent') {
      setStep('pin')
    } else {
      router.replace('/child-setup')
    }
  } catch (e: any) {
    setError(e.message || 'Failed to save name. Please try again.')
    setLoading(false)
  }
}
```

---

### Task 4: Add the name step render branch

**Files:**
- Modify: `app/setup.tsx`

**Context:** The render function currently has an `if (step === 'pin')` block before the final `return`. Add an `if (step === 'name')` block in the same pattern, placed between the top of the render and the `if (step === 'pin')` block.

- [ ] **Step 1: Find the render section**

Find this line near the top of the render:

```typescript
if (step === 'pin') {
```

- [ ] **Step 2: Insert the name step render block immediately before `if (step === 'pin')`**

```typescript
if (step === 'name') {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>What's your name?</Text>
      <Text style={styles.subtitle}>
        This name is shown to the other device when you pair.
      </Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {loading ? (
        <ActivityIndicator color="#6FCF97" size="large" />
      ) : (
        <View style={styles.form}>
          <Text style={styles.label}>Your name</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={(v) => { setName(v); setError(null) }}
            placeholder="Your name"
            maxLength={30}
            autoFocus
          />
          <TouchableOpacity style={styles.btnSave} onPress={handleSetName}>
            <Text style={styles.btnSaveText}>Continue</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
}
```

- [ ] **Step 3: Verify the file — check that `if (step === 'name')` appears before `if (step === 'pin')`**

The render order should be:
1. `if (step === 'name')` — new block
2. `if (step === 'pin')` — existing block
3. Final `return` for mode step — existing block

---

### Task 5: Build and verify on device

**Context:** There are no automated tests for React Native components in `app/` — the jest config only covers `tests/**/*.test.js` (node) and `src/ui/**/*.test.jsx` (jsdom). Verification is on-device.

- [ ] **Step 1: Run the existing test suite to confirm nothing regressed**

```bash
npx jest
```

Expected: all tests pass (same count as before this change).

- [ ] **Step 2: Build the UI bundle**

```bash
npm run build:ui
```

- [ ] **Step 3: Build and install the APK**

```bash
cd android && ./gradlew assembleDebug && cd ..
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Use `-s <serial>` if multiple devices are connected (see `reference_devices.md` in project memory for ADB serials).

- [ ] **Step 4: Verify parent flow on-device**

1. Clear app data on the parent device so setup runs again (Settings → Apps → PearGuard → Clear Storage)
2. Launch PearGuard
3. Tap "I'm a Parent" — should transition to the name step
4. Tap "Continue" without entering a name — should show "Name is required."
5. Enter a name and tap "Continue" — should transition to PIN setup
6. Complete PIN setup — should navigate to the dashboard
7. Verify: pair with the child device and confirm the child sees the parent's chosen name in its peer list

- [ ] **Step 5: Verify child flow on-device**

1. Clear app data on the child device
2. Launch PearGuard
3. Tap "I'm a Child" — should transition to the name step
4. Enter a name and tap "Continue" — should navigate to `/child-setup` (permissions wizard)
5. Complete permissions — should navigate to `/`
6. Verify: pair with the parent device and confirm the parent sees the child's chosen name in the Children tab

- [ ] **Step 6: Commit**

```bash
git add app/setup.tsx
git commit -m "feat: TODO #1 — require profile name at setup before navigating"
```

---

### Task 6: Mark TODO #1 complete in docs/TODO.md

**Files:**
- Modify: `docs/TODO.md`

- [ ] **Step 1: Mark #1 as complete**

Find:
```
### [ ] 1. Force profile name creation at setup
```

Replace with:
```
### [x] 1. Force profile name creation at setup — 2026-03-23
```

And replace the body description with a one-line summary of what was done:
```
`app/setup.tsx`: added `'name'` step between mode selection and PIN/child-setup; calls `identity:setName`; both parent and child paths require a non-empty name before proceeding.
```

- [ ] **Step 2: Commit**

```bash
git add docs/TODO.md
git commit -m "docs: mark TODO #1 complete"
```
