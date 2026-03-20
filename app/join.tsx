// app/join.tsx
//
// Expo Router screen for pearguard://join?t=<encoded> deep links.
// Android intent filter routes pearguard://join?... to this screen.
// This screen reconstructs the invite URL and forwards it to the Bare worklet.

import { useEffect } from 'react'
import { View, Text, StyleSheet, DeviceEventEmitter } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'

export default function JoinRoute () {
  const params = useLocalSearchParams<{ t?: string }>()
  const router = useRouter()

  useEffect(() => {
    const t = params.t
    if (t) {
      const inviteUrl = `pear://pearguard/join?t=${t}`
      console.log('[join] forwarding invite:', inviteUrl)
      // Delay slightly to ensure the main screen worklet is ready
      setTimeout(() => {
        DeviceEventEmitter.emit('pearguardLink', inviteUrl)
      }, 1500)
    } else {
      console.warn('[join] no invite param found in URL')
    }

    setTimeout(() => router.replace('/'), 2000)
  }, [])

  return (
    <View style={styles.container}>
      <Text style={styles.text}>Connecting…</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#111', alignItems: 'center', justifyContent: 'center' },
  text:      { color: '#6FCF97', fontSize: 18 },
})
