// app/child-setup.tsx
//
// Mandatory wizard shown to child device users on first launch
// and whenever Accessibility Service or Usage Stats permission is missing.
// Step 1: Enable Accessibility Service
// Step 2: Grant Usage Access
// Step 3: Pair with parent (skipped if already paired)
// No back button (gestureEnabled: false in _layout.tsx).

import { useState, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Linking, NativeModules, ActivityIndicator, Modal } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { getBareCaller } from './setup'
import NativeIcon from './NativeIcon'

type Permissions = { accessibility: boolean; usageStats: boolean }

function IconAccessibility() {
  return (
    <View style={styles.iconCircle}>
      <NativeIcon name="GearSix" size={32} color="#81C784" />
    </View>
  )
}
function IconUsage() {
  return (
    <View style={styles.iconCircle}>
      <NativeIcon name="ChartBar" size={32} color="#81C784" />
    </View>
  )
}
function IconPair() {
  return (
    <View style={[styles.iconCircle, styles.iconCirclePair]}>
      <NativeIcon name="QrCode" size={32} color="#7B9FEB" />
    </View>
  )
}

const PERMISSION_STEPS = {
  1: {
    Icon: IconAccessibility,
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
    Icon: IconUsage,
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

// ── QR scanner modal ─────────────────────────────────────────────────────────

function ScannerModal({
  visible,
  onScanned,
  onCancel,
}: {
  visible: boolean
  onScanned: (url: string) => void
  onCancel: () => void
}) {
  const [permission, requestPermission] = useCameraPermissions()
  const scanned = useRef(false)

  useEffect(() => {
    if (!visible) { scanned.current = false; return }
    if (!permission?.granted) {
      requestPermission().catch(() => {})
    }
  }, [visible, permission, requestPermission])

  function handleBarcode(result: any) {
    if (scanned.current) return
    scanned.current = true
    onScanned(result.data)
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      {permission?.granted ? (
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          onBarcodeScanned={handleBarcode}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        >
          <View style={scannerStyles.overlay}>
            <TouchableOpacity style={scannerStyles.cancelBtn} onPress={onCancel}>
              <Text style={scannerStyles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </CameraView>
      ) : (
        <View style={scannerStyles.waiting}>
          <ActivityIndicator color="#7B9FEB" size="large" />
          <Text style={{ color: '#fff', marginTop: 16 }}>Requesting camera permission…</Text>
        </View>
      )}
    </Modal>
  )
}

const scannerStyles = StyleSheet.create({
  overlay:    { flex: 1, justifyContent: 'flex-end', padding: 32 },
  cancelBtn:  { backgroundColor: 'rgba(0,0,0,0.65)', padding: 16, borderRadius: 8, alignItems: 'center' },
  cancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  waiting:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0D0D0D' },
})

// ── Main screen ───────────────────────────────────────────────────────────────

export default function ChildSetupScreen() {
  const router = useRouter()
  const { step: stepParam, source } = useLocalSearchParams<{ step?: string; source?: string }>()
  const [step, setStep] = useState<1 | 2 | 3>(stepParam === '2' ? 2 : 1)
  const [totalSteps, setTotalSteps] = useState<2 | 3>(2)
  const [polling, setPolling] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [pairState, setPairState] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [pairError, setPairError] = useState<string | null>(null)
  const isBypassRecovery = source === 'bypass_recovery'

  // Regression guard: whenever step reaches 2, verify step 1 is still satisfied.
  useEffect(() => {
    if (step !== 2) return
    NativeModules.UsageStatsModule?.checkChildPermissions?.()
      .then((p: Permissions) => { if (!p.accessibility) { setPolling(false); setStep(1) } })
      .catch(() => {})
  }, [step])

  // Polling loop: check permissions every 1.5 s and auto-advance.
  useEffect(() => {
    if (step === 3) return  // step 3 is driven by QR scan, not polling
    const timerId = setInterval(async () => {
      try {
        const p: Permissions = await NativeModules.UsageStatsModule?.checkChildPermissions?.()
        if (!p) return
        if (step === 1 && p.accessibility) {
          setPolling(false)
          setStep(2)
        } else if (step === 2 && p.usageStats) {
          clearInterval(timerId)
          await advanceFromStep2()
        }
      } catch (e) {
        console.warn('[child-setup] checkChildPermissions error:', e)
      }
    }, 1500)
    return () => clearInterval(timerId)
  }, [step, router])

  async function advanceFromStep2() {
    const callBare = getBareCaller()
    if (!callBare) {
      // Worklet not ready yet — go straight to main screen
      router.replace('/')
      return
    }
    try {
      const result = await callBare('peers:hasParent', {})
      if (result?.hasPeers) {
        router.replace('/')
      } else {
        setTotalSteps(3)
        setStep(3)
      }
    } catch (_e) {
      // If check fails, go to main screen rather than blocking the user
      router.replace('/')
    }
  }

  async function handleScanned(url: string) {
    setShowScanner(false)
    if (!url.startsWith('pear://pearguard/join')) {
      setPairError('That QR code is not a valid PearGuard invite. Ask your parent to share their invite again.')
      return
    }
    setPairError(null)
    setPairState('connecting')
    const callBare = getBareCaller()
    if (!callBare) {
      setPairState('error')
      setPairError('App not ready. Please wait a moment and try again.')
      return
    }
    try {
      await callBare('acceptInvite', [url])
    } catch (e: any) {
      setPairState('error')
      setPairError(e.message || 'Failed to process invite. Please try again.')
      return
    }
    // Poll peers:hasParent until the P2P handshake completes
    const pollId = setInterval(async () => {
      try {
        const r = await callBare('peers:hasParent', {})
        if (r?.hasPeers) {
          clearInterval(pollId)
          router.replace('/')
        }
      } catch (_e) {}
    }, 1500)
  }

  function openSettings() {
    if (step === 3) return
    setPolling(true)
    Linking.sendIntent(PERMISSION_STEPS[step as 1 | 2].settingsAction).catch(() => {
      console.warn('[child-setup] sendIntent failed for:', PERMISSION_STEPS[step as 1 | 2].settingsAction)
    })
  }

  // ── Step 3: Pair with parent ─────────────────────────────────────────────

  if (step === 3) {
    return (
      <View style={styles.container}>
        <Text style={styles.stepLabel}>Step 3 of 3</Text>

        <IconPair />

        <Text style={styles.title}>Pair with your parent</Text>
        <Text style={styles.description}>
          Ask your parent to open PearGuard, go to their Profile tab, and tap "Share Invite". Then scan their QR code below.
        </Text>

        {pairError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>{pairError}</Text>
          </View>
        )}

        {pairState === 'connecting' ? (
          <View style={styles.connectingBox}>
            <ActivityIndicator size="large" color="#7B9FEB" />
            <Text style={styles.connectingText}>Connecting to parent…</Text>
            <Text style={styles.connectingSubText}>This may take up to 30 seconds.</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={styles.buttonPair}
            onPress={() => { setPairError(null); setShowScanner(true) }}
            activeOpacity={0.8}
          >
            <Text style={styles.buttonPairText}>Scan Parent's QR Code →</Text>
          </TouchableOpacity>
        )}

        <ScannerModal
          visible={showScanner}
          onScanned={handleScanned}
          onCancel={() => setShowScanner(false)}
        />
      </View>
    )
  }

  // ── Steps 1 & 2: Permissions ─────────────────────────────────────────────

  const config = PERMISSION_STEPS[step as 1 | 2]

  return (
    <View style={styles.container}>
      <Text style={styles.stepLabel}>Step {step} of {totalSteps}</Text>

      {isBypassRecovery && step === 1 && (
        <View style={styles.notifyBanner}>
          <Text style={styles.notifyText}>Your parent has been notified of this change.</Text>
        </View>
      )}

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
  container:        { flex: 1, backgroundColor: '#0D0D0D', alignItems: 'center', justifyContent: 'center', padding: 32 },
  stepLabel:        { color: '#707070', fontSize: 13, marginBottom: 24, textTransform: 'uppercase', letterSpacing: 1 },
  iconCircle:       { width: 72, height: 72, borderRadius: 36, backgroundColor: '#1A2E1A', borderWidth: 2, borderColor: '#4CAF50', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  iconCirclePair:   { backgroundColor: '#1a1a2e', borderColor: '#7B9FEB' },
  title:            { color: '#EAEAEA', fontSize: 20, fontWeight: '300', textAlign: 'center', marginBottom: 12 },
  description:      { color: '#B0B0B0', fontSize: 14, textAlign: 'center', lineHeight: 22, marginBottom: 24 },
  instructions:     { backgroundColor: '#1A1A1A', borderWidth: 1, borderColor: '#333333', borderRadius: 12, padding: 16, width: '100%', marginBottom: 32 },
  instructionsLabel:{ color: '#707070', fontSize: 11, letterSpacing: 0.5, marginBottom: 10 },
  instructionLine:  { color: '#B0B0B0', fontSize: 14, lineHeight: 26 },
  button:           { backgroundColor: '#1A2E1A', borderWidth: 1, borderColor: '#4CAF50', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, width: '100%', alignItems: 'center', marginBottom: 16 },
  buttonText:       { color: '#4CAF50', fontSize: 15, fontWeight: '600' },
  buttonPair:       { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#7B9FEB', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, width: '100%', alignItems: 'center', marginBottom: 16 },
  buttonPairText:   { color: '#7B9FEB', fontSize: 15, fontWeight: '600' },
  waitingRow:       { flexDirection: 'row', alignItems: 'center', gap: 8 },
  waitingText:      { color: '#707070', fontSize: 13 },
  connectingBox:    { alignItems: 'center', gap: 12, marginBottom: 16 },
  connectingText:   { color: '#7B9FEB', fontSize: 15, fontWeight: '600' },
  connectingSubText:{ color: '#707070', fontSize: 13 },
  notifyBanner:     { backgroundColor: '#2e1a1a', borderWidth: 1, borderColor: '#EF5350', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, marginBottom: 20, width: '100%' },
  notifyText:       { color: '#EF5350', fontSize: 13, textAlign: 'center' },
  errorBanner:      { backgroundColor: '#2e1a1a', borderWidth: 1, borderColor: '#EF5350', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 14, marginBottom: 20, width: '100%' },
  errorText:        { color: '#EF5350', fontSize: 13, textAlign: 'center' },
})
