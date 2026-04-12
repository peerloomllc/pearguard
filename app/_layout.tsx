// app/_layout.tsx
import { useEffect } from 'react'
import { Stack } from 'expo-router'
import * as SplashScreen from 'expo-splash-screen'
import {
  useFonts,
  Nunito_300Light,
  Nunito_400Regular,
  Nunito_600SemiBold,
  Nunito_700Bold,
} from '@expo-google-fonts/nunito'

SplashScreen.preventAutoHideAsync().catch(() => {})

export default function RootLayout () {
  const [loaded] = useFonts({
    Nunito_300Light,
    Nunito_400Regular,
    Nunito_600SemiBold,
    Nunito_700Bold,
  })

  useEffect(() => {
    if (loaded) SplashScreen.hideAsync().catch(() => {})
  }, [loaded])

  if (!loaded) return null

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="setup" />
      <Stack.Screen name="join" />
      <Stack.Screen name="child-setup" options={{ headerShown: false, gestureEnabled: false }} />
    </Stack>
  )
}
