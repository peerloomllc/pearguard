// app/child-setup.tsx
//
// Mandatory two-step wizard shown to child device users on first launch
// and whenever Accessibility Service or Usage Stats permission is missing.
// No back button (gestureEnabled: false in _layout.tsx).

import { useState, useEffect } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Linking, NativeModules, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'

type Permissions = { accessibility: boolean; usageStats: boolean }

// Styled placeholder icons — avoid emoji for cross-Android-version rendering consistency.
function IconA() {
  return (
    <View style={styles.iconCircle}>
      <Text style={styles.iconLetter}>A</Text>
    </View>
  )
}
function IconU() {
  return (
    <View style={styles.iconCircle}>
      <Text style={styles.iconLetter}>U</Text>
    </View>
  )
}

const STEPS = {
  1: {
    Icon: IconA,
    title: 'Enable Accessibility Service',
    description:
      'PearGuard needs the Accessibility Service to detect and block restricted apps on this device.',
    instructions: [
      'Tap the button below',
      'Find PearGuard in the list',
      'Toggle it ON',
      'Return to this app',
    ],
    buttonLabel: 'Open Accessibility Settings',
    settingsAction: 'android.settings.ACCESSIBILITY_SETTINGS',
  },
  2: {
    Icon: IconU,
    title: 'Grant Usage Access',
    description:
      'PearGuard needs Usage Access to track daily app time and enforce screen time limits set by your parent.',
    instructions: [
      'Tap the button below',
      'Find PearGuard in the list',
      'Toggle it ON',
      'Return to this app',
    ],
    buttonLabel: 'Open Usage Access Settings',
    settingsAction: 'android.settings.USAGE_ACCESS_SETTINGS',
  },
} as const

export default function ChildSetupScreen() {
  const router = useRouter()
  const { step: stepParam } = useLocalSearchParams<{ step?: string }>()
  const [step, setStep] = useState<1 | 2>(stepParam === '2' ? 2 : 1)
  const [polling, setPolling] = useState(false)

  // Regression guard: whenever step reaches 2 (first-launch advancement or re-appear jump),
  // verify step 1 is still satisfied before showing step 2.
  useEffect(() => {
    if (step !== 2) return
    NativeModules.UsageStatsModule?.checkChildPermissions?.()
      .then((p: Permissions) => { if (!p.accessibility) { setPolling(false); setStep(1) } })
      .catch(() => {})
  }, [step])

  // Polling loop: check current permission every 1.5 s and auto-advance.
  useEffect(() => {
    const timerId = setInterval(async () => {
      try {
        const p: Permissions = await NativeModules.UsageStatsModule?.checkChildPermissions?.()
        if (!p) return
        if (step === 1 && p.accessibility) {
          setPolling(false)
          setStep(2)
        } else if (step === 2 && p.usageStats) {
          clearInterval(timerId)
          router.replace('/')
        }
      } catch (e) {
        console.warn('[child-setup] checkChildPermissions error:', e)
      }
    }, 1500)
    return () => clearInterval(timerId)
  }, [step, router])

  function openSettings() {
    setPolling(true)
    Linking.sendIntent(STEPS[step].settingsAction).catch(() => {
      // sendIntent is Android-only; fallback for dev/test environments
      console.warn('[child-setup] sendIntent failed for:', STEPS[step].settingsAction)
    })
  }

  const config = STEPS[step]

  return (
    <View style={styles.container}>
      <Text style={styles.stepLabel}>Step {step} of 2</Text>

      <config.Icon />

      <Text style={styles.title}>{config.title}</Text>
      <Text style={styles.description}>{config.description}</Text>

      <View style={styles.instructions}>
        <Text style={styles.instructionsLabel}>HOW TO ENABLE</Text>
        {config.instructions.map((line, i) => (
          <Text key={i} style={styles.instructionLine}>
            {i + 1}. {line}
          </Text>
        ))}
      </View>

      <TouchableOpacity style={styles.button} onPress={openSettings} activeOpacity={0.8}>
        <Text style={styles.buttonText}>{config.buttonLabel} →</Text>
      </TouchableOpacity>

      {polling ? (
        <View style={styles.waitingRow}>
          <ActivityIndicator size="small" color="#555" />
          <Text style={styles.waitingText}>Waiting for permission…</Text>
        </View>
      ) : (
        <Text style={styles.waitingText}>Tap the button above to open Settings</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 32 },
  stepLabel:        { color: '#555', fontSize: 13, marginBottom: 24, textTransform: 'uppercase', letterSpacing: 1 },
  iconCircle:       { width: 72, height: 72, borderRadius: 36, backgroundColor: '#1a2e1a', borderWidth: 2, borderColor: '#6FCF97', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  iconLetter:       { color: '#6FCF97', fontSize: 28, fontWeight: '700' },
  title:            { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 12 },
  description:      { color: '#aaa', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  instructions:     { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#333', borderRadius: 12, padding: 16, width: '100%', marginBottom: 32 },
  instructionsLabel:{ color: '#555', fontSize: 11, letterSpacing: 0.5, marginBottom: 10 },
  instructionLine:  { color: '#ccc', fontSize: 14, lineHeight: 26 },
  button:           { backgroundColor: '#1a2e1a', borderWidth: 1, borderColor: '#6FCF97', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, width: '100%', alignItems: 'center', marginBottom: 16 },
  buttonText:       { color: '#6FCF97', fontSize: 15, fontWeight: '600' },
  waitingRow:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  waitingText:      { color: '#555', fontSize: 13 },
})
