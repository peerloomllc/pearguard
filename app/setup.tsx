// app/setup.tsx
//
// First-launch mode selection screen.
// Shown only when no mode is stored in Hyperbee (new device / fresh install).
// User taps "I'm a Parent" or "I'm a Child".
// Parent path: calls setMode then shows PIN setup step before navigating to /.
// Child path: calls setMode then navigates directly to /child-setup.

import { useState, useRef } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator, ScrollView, KeyboardAvoidingView, Platform, InputAccessoryView, Keyboard } from 'react-native'
import { useRouter } from 'expo-router'
import NativeIcon from './NativeIcon'
import { colors, spacing, radius, typography, fontFamily } from '../src/rn-theme'

let _callBare: ((method: string, args: any) => Promise<any>) | null = null

export function setBareCaller (fn: (method: string, args: any) => Promise<any>) {
  _callBare = fn
}

export function getBareCaller() { return _callBare }

export default function SetupScreen () {
  const [step, setStep]               = useState<'mode' | 'name' | 'pin'>('mode')
  const [selectedMode, setSelectedMode] = useState<'parent' | 'child' | null>(null)
  const [loading, setLoading]         = useState(false)
  const [error, setError]             = useState<string | null>(null)
  const [name, setName]               = useState('')
  const [pin, setPin]                 = useState('')
  const [confirmPin, setConfirmPin]   = useState('')
  const confirmPinRef                 = useRef<TextInput>(null)
  const router = useRouter()
  const pinAccessoryID = 'pinAccessoryDone'

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

  async function handleSetPin () {
    if (!_callBare) return
    if (pin.length !== 4) { setError('PIN must be exactly 4 digits.'); return }
    if (!/^\d+$/.test(pin)) { setError('PIN must contain only digits.'); return }
    if (pin !== confirmPin) { setError('PINs do not match.'); setConfirmPin(''); return }
    setError(null)
    setLoading(true)
    try {
      await _callBare('pin:set', { pin })
      router.replace('/')
    } catch (e: any) {
      setError(e.message || 'Failed to set PIN. Please try again.')
      setLoading(false)
    }
  }

  if (step === 'name') {
    return (
      <View style={styles.container}>
        <View style={[styles.iconCircle, styles.iconCircleGreen]}>
          <NativeIcon name="User" size={32} color={colors.primaryLight} />
        </View>
        <Text style={styles.title}>What's your name?</Text>
        <Text style={styles.subtitle}>
          This name is shown to the other device when you pair.
        </Text>

        {error && <Text style={styles.error}>{error}</Text>}

        {loading ? (
          <ActivityIndicator color={colors.primary} size="large" />
        ) : (
          <View style={styles.form}>
            <Text style={styles.label}>Your name</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={(v) => { setName(v); setError(null) }}
              placeholder="Your name"
              placeholderTextColor={colors.text.muted}
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

  if (step === 'pin') {
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.surface.base }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.container, { justifyContent: 'flex-start', paddingTop: 60 }]} keyboardShouldPersistTaps="handled">
          <View style={[styles.iconCircle, styles.iconCircleGreen]}>
            <NativeIcon name="LockSimple" size={32} color={colors.primaryLight} />
          </View>
          <Text style={styles.title}>Set Override PIN</Text>
          <Text style={styles.subtitle}>
            Children enter this PIN on the block screen to request temporary access.
            You can change it later in Settings.
          </Text>

          {error && <Text style={styles.error}>{error}</Text>}

          {loading ? (
            <ActivityIndicator color={colors.primary} size="large" />
          ) : (
            <View style={styles.form}>
              <Text style={styles.label}>PIN (4+ digits)</Text>
              <TextInput
                style={styles.input}
                value={pin}
                onChangeText={(v) => {
                  setPin(v);
                  setError(null);
                  if (v.length === 4) confirmPinRef.current?.focus();
                }}
                placeholder="e.g. 1234"
                placeholderTextColor={colors.text.muted}
                keyboardType="numeric"
                secureTextEntry
                maxLength={4}
                inputAccessoryViewID={Platform.OS === 'ios' ? pinAccessoryID : undefined}
              />
              <Text style={styles.label}>Confirm PIN</Text>
              <TextInput
                ref={confirmPinRef}
                style={styles.input}
                value={confirmPin}
                onChangeText={(v) => { setConfirmPin(v); setError(null) }}
                placeholder="Repeat PIN"
                placeholderTextColor={colors.text.muted}
                keyboardType="numeric"
                secureTextEntry
                maxLength={4}
                inputAccessoryViewID={Platform.OS === 'ios' ? pinAccessoryID : undefined}
              />
              <TouchableOpacity style={styles.btnSave} onPress={handleSetPin}>
                <Text style={styles.btnSaveText}>Save PIN</Text>
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
        {Platform.OS === 'ios' && (
          <InputAccessoryView nativeID={pinAccessoryID}>
            <View style={styles.accessoryBar}>
              <TouchableOpacity onPress={() => Keyboard.dismiss()} style={styles.accessoryBtn}>
                <Text style={styles.accessoryBtnText}>Done</Text>
              </TouchableOpacity>
            </View>
          </InputAccessoryView>
        )}
      </KeyboardAvoidingView>
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to PearGuard</Text>
      <Text style={styles.subtitle}>How will you use this device?</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {loading ? (
        <ActivityIndicator color={colors.primary} size="large" />
      ) : (
        <View style={styles.buttons}>
          <TouchableOpacity style={[styles.btn, styles.btnParent]} onPress={() => selectMode('parent')}>
            <NativeIcon name="Shield" size={36} color={colors.primary} />
            <Text style={styles.btnTitle}>I'm a Parent</Text>
            <Text style={styles.btnSub}>Monitor and manage your child's device</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.btn, styles.btnChild]} onPress={() => selectMode('child')}>
            <NativeIcon name="User" size={36} color={colors.accent} />
            <Text style={styles.btnTitle}>I'm a Child</Text>
            <Text style={styles.btnSub}>This device will be monitored by a parent</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: colors.surface.base, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  title:       { color: colors.text.primary, fontSize: 26, fontFamily: fontFamily.light, marginBottom: spacing.sm, textAlign: 'center' },
  subtitle:    { color: colors.text.secondary, fontSize: typography.subheading.fontSize, fontFamily: fontFamily.regular, marginBottom: spacing.xxxl - 8, textAlign: 'center' },
  error:       { color: colors.error, fontSize: typography.body.fontSize, fontFamily: fontFamily.regular, marginBottom: spacing.base, textAlign: 'center' },
  buttons:     { width: '100%', gap: spacing.base },
  btn:         { borderRadius: radius.xl, padding: spacing.xl, alignItems: 'center', gap: spacing.md - 2 },
  iconCircle:  { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: spacing.base },
  iconCircleGreen: { backgroundColor: colors.surface.tintedGreen, borderWidth: 2, borderColor: colors.primary },
  btnParent:   { backgroundColor: colors.surface.tintedGreen, borderWidth: 1, borderColor: colors.primary },
  btnChild:    { backgroundColor: colors.surface.tintedBlue, borderWidth: 1, borderColor: colors.accent },
  btnTitle:    { color: colors.text.primary, fontSize: 18, fontFamily: fontFamily.semibold },
  btnSub:      { color: colors.text.muted, fontSize: 13, fontFamily: fontFamily.regular, textAlign: 'center' },
  form:        { width: '100%', gap: spacing.md },
  label:       { color: colors.text.secondary, fontSize: typography.body.fontSize, fontFamily: fontFamily.regular, marginBottom: 2 },
  input:       { backgroundColor: colors.surface.input, color: colors.text.primary, borderRadius: radius.md, padding: 14, fontSize: typography.subheading.fontSize, fontFamily: fontFamily.regular, borderWidth: 1, borderColor: colors.border, width: '100%' },
  btnSave:     { backgroundColor: colors.primary, borderRadius: radius.lg, padding: spacing.base, alignItems: 'center', marginTop: spacing.sm },
  btnSaveText: { color: colors.primaryOn, fontSize: 17, fontFamily: fontFamily.bold },
  accessoryBar: { backgroundColor: colors.surface.card, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: spacing.base, paddingVertical: spacing.sm },
  accessoryBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.xs },
  accessoryBtnText: { color: colors.primary, fontSize: 16, fontFamily: fontFamily.semibold },
})
