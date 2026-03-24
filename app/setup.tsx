// app/setup.tsx
//
// First-launch mode selection screen.
// Shown only when no mode is stored in Hyperbee (new device / fresh install).
// User taps "I'm a Parent" or "I'm a Child".
// Parent path: calls setMode then shows PIN setup step before navigating to /.
// Child path: calls setMode then navigates directly to /child-setup.

import { useState, useRef } from 'react'
import { View, Text, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'

let _callBare: ((method: string, args: any) => Promise<any>) | null = null

/**
 * Called by app/index.tsx to inject the IPC caller into this screen.
 */
export function setBareCaller (fn: (method: string, args: any) => Promise<any>) {
  _callBare = fn
}

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

  if (step === 'pin') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Set Override PIN</Text>
        <Text style={styles.subtitle}>
          Children enter this PIN on the block screen to request temporary access.
          You can change it later in Settings.
        </Text>

        {error && <Text style={styles.error}>{error}</Text>}

        {loading ? (
          <ActivityIndicator color="#6FCF97" size="large" />
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
              keyboardType="numeric"
              secureTextEntry
              maxLength={4}
            />
            <Text style={styles.label}>Confirm PIN</Text>
            <TextInput
              ref={confirmPinRef}
              style={styles.input}
              value={confirmPin}
              onChangeText={(v) => { setConfirmPin(v); setError(null) }}
              placeholder="Repeat PIN"
              keyboardType="numeric"
              secureTextEntry
              maxLength={4}
            />
            <TouchableOpacity style={styles.btnSave} onPress={handleSetPin}>
              <Text style={styles.btnSaveText}>Save PIN</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to PearGuard</Text>
      <Text style={styles.subtitle}>How will you use this device?</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      {loading ? (
        <ActivityIndicator color="#6FCF97" size="large" />
      ) : (
        <View style={styles.buttons}>
          <TouchableOpacity style={[styles.btn, styles.btnParent]} onPress={() => selectMode('parent')}>
            <Text style={styles.btnIcon}>👤</Text>
            <Text style={styles.btnTitle}>I'm a Parent</Text>
            <Text style={styles.btnSub}>Monitor and manage your child's device</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.btn, styles.btnChild]} onPress={() => selectMode('child')}>
            <Text style={styles.btnIcon}>🧒</Text>
            <Text style={styles.btnTitle}>I'm a Child</Text>
            <Text style={styles.btnSub}>This device will be monitored by a parent</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container:   { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 32 },
  title:       { color: '#fff', fontSize: 26, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  subtitle:    { color: '#aaa', fontSize: 16, marginBottom: 40, textAlign: 'center' },
  error:       { color: '#EB5757', fontSize: 14, marginBottom: 16, textAlign: 'center' },
  buttons:     { width: '100%', gap: 16 },
  btn:         { borderRadius: 16, padding: 24, alignItems: 'center', gap: 6 },
  btnParent:   { backgroundColor: '#1a2e1a', borderWidth: 1, borderColor: '#6FCF97' },
  btnChild:    { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#7B9FEB' },
  btnIcon:     { fontSize: 32 },
  btnTitle:    { color: '#fff', fontSize: 18, fontWeight: '600' },
  btnSub:      { color: '#888', fontSize: 13, textAlign: 'center' },
  form:        { width: '100%', gap: 12 },
  label:       { color: '#aaa', fontSize: 14, marginBottom: 2 },
  input:       { backgroundColor: '#222', color: '#fff', borderRadius: 10, padding: 14, fontSize: 16, borderWidth: 1, borderColor: '#444', width: '100%' },
  btnSave:     { backgroundColor: '#6FCF97', borderRadius: 12, padding: 16, alignItems: 'center', marginTop: 8 },
  btnSaveText: { color: '#111', fontSize: 17, fontWeight: '700' },
})
