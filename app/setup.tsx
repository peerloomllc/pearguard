// app/setup.tsx
//
// First-launch mode selection screen.
// Shown only when no mode is stored in Hyperbee (new device / fresh install).
// User taps "I'm a Parent" or "I'm a Child".
// Selection is stored via IPC call to bare.js, then navigates to main screen.

import { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { useRouter } from 'expo-router'

let _callBare: ((method: string, args: any[]) => Promise<any>) | null = null

/**
 * Called by app/index.tsx to inject the IPC caller into this screen.
 */
export function setBareCaller (fn: (method: string, args: any[]) => Promise<any>) {
  _callBare = fn
}

export default function SetupScreen () {
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)
  const router = useRouter()

  async function selectMode (mode: 'parent' | 'child') {
    if (!_callBare) { setError('App not ready — please wait'); return }
    setLoading(true)
    try {
      await _callBare('setMode', [mode])
      router.replace(mode === 'child' ? '/child-setup' : '/')
    } catch (e: any) {
      setError(e.message)
      setLoading(false)
    }
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
  container:  { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center', padding: 32 },
  title:      { color: '#fff', fontSize: 26, fontWeight: '700', marginBottom: 8, textAlign: 'center' },
  subtitle:   { color: '#aaa', fontSize: 16, marginBottom: 40, textAlign: 'center' },
  error:      { color: '#EB5757', fontSize: 14, marginBottom: 16 },
  buttons:    { width: '100%', gap: 16 },
  btn:        { borderRadius: 16, padding: 24, alignItems: 'center', gap: 6 },
  btnParent:  { backgroundColor: '#1a2e1a', borderWidth: 1, borderColor: '#6FCF97' },
  btnChild:   { backgroundColor: '#1a1a2e', borderWidth: 1, borderColor: '#7B9FEB' },
  btnIcon:    { fontSize: 32 },
  btnTitle:   { color: '#fff', fontSize: 18, fontWeight: '600' },
  btnSub:     { color: '#888', fontSize: 13, textAlign: 'center' },
})
