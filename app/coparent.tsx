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
