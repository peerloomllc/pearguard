// app/_layout.tsx
import { Stack } from 'expo-router'

export default function RootLayout () {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="setup" />
      <Stack.Screen name="join" />
    </Stack>
  )
}
