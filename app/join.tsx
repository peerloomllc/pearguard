// app/join.tsx
//
// Expo Router screen for pearguard://join/<encoded> deep links.
// Android intent filter routes pearguard://join/... to this screen.
// This screen decodes the invite and sends it to the Bare worklet via IPC.
// After forwarding, it navigates back to the main screen.

import { useEffect } from 'react'
import { View, Text, StyleSheet, DeviceEventEmitter } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'

export default function JoinRoute () {
  const localParams = useLocalSearchParams<{ encoded?: string }>()
  const router = useRouter()

  useEffect(() => {
    // The full URL is available via Expo Linking — reconstruct it from the path segment
    // Expo Router passes path segments as params; the invite is the first segment after /join/
    // We get the raw path from localParams and reconstruct the pearguard:// URL.
    //
    // Android intent filter is configured for scheme=pearguard host=join.
    // When the user opens pearguard://join/ENCODED, Expo Router navigates to /join
    // with the remainder available via the route params.
    //
    // We emit a 'pearguardLink' event that app/index.tsx listens for.

    let inviteUrl: string | null = null

    // Get all params except internal expo-router ones
    const entries = Object.entries(localParams)
      .filter(([k]) => !k.startsWith('__'))
      .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
      .join('&')

    if (entries) {
      inviteUrl = `pearguard://join?${entries}`
    } else {
      // Fallback: check if the full path was captured
      const path = (localParams as any)['...encoded']
      if (path) inviteUrl = `pearguard://join/${path}`
    }

    if (inviteUrl) {
      console.log('[join] emitting pearguardLink:', inviteUrl)
      // Small delay to ensure the main screen's worklet is ready
      setTimeout(() => {
        DeviceEventEmitter.emit('pearguardLink', inviteUrl)
      }, 1500)
    }

    // Navigate back to main after forwarding
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
