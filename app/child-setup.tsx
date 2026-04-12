// app/child-setup.tsx
//
// Mandatory wizard shown to child device users on first launch
// and whenever Accessibility Service or Usage Stats permission is missing.
// Step 1: Enable Accessibility Service
// Step 2: Grant Usage Access
// Step 3: Pair with parent (skipped if already paired)
// No back button (gestureEnabled: false in _layout.tsx).

import { useState, useEffect, useRef } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Linking, NativeModules, ActivityIndicator, Modal, TextInput } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { getBareCaller } from './setup'
import NativeIcon from './NativeIcon'
import { colors, spacing, radius, typography, fontFamily } from '../src/rn-theme'

type Permissions = { accessibility: boolean; usageStats: boolean }

function IconAccessibility() {
  return (
    <View style={styles.iconCircle}>
      <NativeIcon name="GearSix" size={32} color={colors.primaryLight} />
    </View>
  )
}
function IconUsage() {
  return (
    <View style={styles.iconCircle}>
      <NativeIcon name="ChartBar" size={32} color={colors.primaryLight} />
    </View>
  )
}
function IconPair() {
  return (
    <View style={[styles.iconCircle, styles.iconCirclePair]}>
      <NativeIcon name="QrCode" size={32} color={colors.accent} />
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
          <ActivityIndicator color={colors.accent} size="large" />
          <Text style={scannerStyles.waitingText}>Requesting camera permission…</Text>
        </View>
      )}
    </Modal>
  )
}

const scannerStyles = StyleSheet.create({
  overlay:    { flex: 1, justifyContent: 'flex-end', padding: spacing.xxl },
  cancelBtn:  { backgroundColor: 'rgba(0,0,0,0.65)', padding: spacing.base, borderRadius: radius.md, alignItems: 'center' },
  cancelText: { color: '#fff', fontSize: typography.subheading.fontSize, fontFamily: fontFamily.semibold },
  waiting:    { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface.base },
  waitingText:{ color: '#fff', marginTop: spacing.base, fontFamily: fontFamily.regular },
})

export default function ChildSetupScreen() {
  const router = useRouter()
  const { step: stepParam, source } = useLocalSearchParams<{ step?: string; source?: string }>()
  const [step, setStep] = useState<1 | 2 | 3>(stepParam === '2' ? 2 : 1)
  const [totalSteps, setTotalSteps] = useState<2 | 3>(2)
  const [polling, setPolling] = useState(false)
  const [showScanner, setShowScanner] = useState(false)
  const [pairState, setPairState] = useState<'idle' | 'connecting' | 'error'>('idle')
  const [pairError, setPairError] = useState<string | null>(null)
  const [showPaste, setShowPaste] = useState(false)
  const [pasteLink, setPasteLink] = useState('')
  const isBypassRecovery = source === 'bypass_recovery'

  useEffect(() => {
    if (step !== 2) return
    NativeModules.UsageStatsModule?.checkChildPermissions?.()
      .then((p: Permissions) => { if (!p.accessibility) { setPolling(false); setStep(1) } })
      .catch(() => {})
  }, [step])

  useEffect(() => {
    if (step === 3) return
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

  function handlePasteSubmit() {
    const trimmed = pasteLink.trim()
    if (!trimmed) return
    handleScanned(trimmed)
    setPasteLink('')
    setShowPaste(false)
  }

  function openSettings() {
    if (step === 3) return
    setPolling(true)
    Linking.sendIntent(PERMISSION_STEPS[step as 1 | 2].settingsAction).catch(() => {
      console.warn('[child-setup] sendIntent failed for:', PERMISSION_STEPS[step as 1 | 2].settingsAction)
    })
  }

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
            <ActivityIndicator size="large" color={colors.accent} />
            <Text style={styles.connectingText}>Connecting to parent...</Text>
            <Text style={styles.connectingSubText}>This may take up to 30 seconds.</Text>
          </View>
        ) : (
          <>
            <TouchableOpacity
              style={styles.buttonPair}
              onPress={() => { setPairError(null); setShowScanner(true) }}
              activeOpacity={0.8}
            >
              <Text style={styles.buttonPairText}>Scan Parent's QR Code</Text>
            </TouchableOpacity>

            {showPaste ? (
              <View style={styles.pasteBox}>
                <TextInput
                  style={styles.pasteInput}
                  value={pasteLink}
                  onChangeText={setPasteLink}
                  placeholder="Paste invite link here"
                  placeholderTextColor={colors.text.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <View style={styles.pasteButtons}>
                  <TouchableOpacity
                    style={[styles.pasteBtn, styles.pasteBtnConnect, !pasteLink.trim() && styles.pasteBtnDisabled]}
                    onPress={handlePasteSubmit}
                    disabled={!pasteLink.trim()}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.pasteBtnConnectText}>Connect</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.pasteBtn, styles.pasteBtnCancel]}
                    onPress={() => { setShowPaste(false); setPasteLink(''); }}
                    activeOpacity={0.8}
                  >
                    <Text style={styles.pasteBtnCancelText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              </View>
            ) : (
              <TouchableOpacity
                style={styles.pasteToggle}
                onPress={() => setShowPaste(true)}
                activeOpacity={0.8}
              >
                <Text style={styles.pasteToggleText}>Or paste an invite link</Text>
              </TouchableOpacity>
            )}
          </>
        )}

        <ScannerModal
          visible={showScanner}
          onScanned={handleScanned}
          onCancel={() => setShowScanner(false)}
        />
      </View>
    )
  }

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
          <ActivityIndicator size="small" color={colors.text.muted} />
          <Text style={styles.waitingText}>Waiting for permission…</Text>
        </View>
      ) : (
        <Text style={styles.waitingText}>Tap the button above to open Settings</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container:        { flex: 1, backgroundColor: colors.surface.base, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  stepLabel:        { color: colors.text.muted, fontSize: 13, fontFamily: fontFamily.semibold, marginBottom: spacing.xl, textTransform: 'uppercase', letterSpacing: 1 },
  iconCircle:       { width: 72, height: 72, borderRadius: 36, backgroundColor: colors.surface.tintedGreen, borderWidth: 2, borderColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.lg },
  iconCirclePair:   { backgroundColor: colors.surface.tintedBlue, borderColor: colors.accent },
  title:            { color: colors.text.primary, fontSize: typography.heading.fontSize, fontFamily: fontFamily.light, textAlign: 'center', marginBottom: spacing.md },
  description:      { color: colors.text.secondary, fontSize: typography.body.fontSize, fontFamily: fontFamily.regular, textAlign: 'center', lineHeight: 22, marginBottom: spacing.xl },
  instructions:     { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.base, width: '100%', marginBottom: spacing.xxl },
  instructionsLabel:{ color: colors.text.muted, fontSize: 11, fontFamily: fontFamily.semibold, letterSpacing: 0.5, marginBottom: spacing.md - 2 },
  instructionLine:  { color: colors.text.secondary, fontSize: typography.body.fontSize, fontFamily: fontFamily.regular, lineHeight: 26 },
  button:           { backgroundColor: colors.surface.tintedGreen, borderWidth: 1, borderColor: colors.primary, borderRadius: radius.lg, paddingVertical: 14, paddingHorizontal: spacing.lg, width: '100%', alignItems: 'center', marginBottom: spacing.base },
  buttonText:       { color: colors.primary, fontSize: 15, fontFamily: fontFamily.semibold },
  buttonPair:       { backgroundColor: colors.surface.tintedBlue, borderWidth: 1, borderColor: colors.accent, borderRadius: radius.lg, paddingVertical: 14, paddingHorizontal: spacing.lg, width: '100%', alignItems: 'center', marginBottom: spacing.base },
  buttonPairText:   { color: colors.accent, fontSize: 15, fontFamily: fontFamily.semibold },
  waitingRow:       { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  waitingText:      { color: colors.text.muted, fontSize: 13, fontFamily: fontFamily.regular },
  connectingBox:    { alignItems: 'center', gap: spacing.md, marginBottom: spacing.base },
  connectingText:   { color: colors.accent, fontSize: 15, fontFamily: fontFamily.semibold },
  connectingSubText:{ color: colors.text.muted, fontSize: 13, fontFamily: fontFamily.regular },
  notifyBanner:     { backgroundColor: colors.surface.tintedRed, borderWidth: 1, borderColor: colors.error, borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: 14, marginBottom: spacing.lg, width: '100%' },
  notifyText:       { color: colors.error, fontSize: 13, fontFamily: fontFamily.regular, textAlign: 'center' },
  errorBanner:      { backgroundColor: colors.surface.tintedRed, borderWidth: 1, borderColor: colors.error, borderRadius: radius.md, paddingVertical: spacing.sm, paddingHorizontal: 14, marginBottom: spacing.lg, width: '100%' },
  errorText:        { color: colors.error, fontSize: 13, fontFamily: fontFamily.regular, textAlign: 'center' },
  pasteToggle:      { marginTop: spacing.xs, padding: spacing.sm },
  pasteToggleText:  { color: colors.text.muted, fontSize: 13, fontFamily: fontFamily.regular, textAlign: 'center', textDecorationLine: 'underline' },
  pasteBox:         { backgroundColor: colors.surface.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: spacing.base, width: '100%', marginTop: spacing.xs },
  pasteInput:       { backgroundColor: colors.surface.base, borderWidth: 1, borderColor: '#444444', borderRadius: radius.md, padding: spacing.md, color: colors.text.primary, fontSize: typography.body.fontSize, fontFamily: fontFamily.regular, marginBottom: spacing.md },
  pasteButtons:     { flexDirection: 'row', gap: spacing.sm },
  pasteBtn:         { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  pasteBtnConnect:  { backgroundColor: colors.surface.tintedBlue, borderWidth: 1, borderColor: colors.accent },
  pasteBtnConnectText: { color: colors.accent, fontSize: 14, fontFamily: fontFamily.semibold },
  pasteBtnDisabled: { opacity: 0.4 },
  pasteBtnCancel:   { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  pasteBtnCancelText: { color: colors.text.muted, fontSize: 14, fontFamily: fontFamily.regular },
})
