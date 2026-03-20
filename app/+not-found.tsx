// app/+not-found.tsx
//
// Catches any unmatched routes. Shows "Connecting…" and redirects home.
// The module-level Linking listener in index.tsx handles the actual invite URL.

import { useEffect } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'

export default function NotFound () {
  const router = useRouter()

  useEffect(() => {
    setTimeout(() => router.replace('/'), 1500)
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
