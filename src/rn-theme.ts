// Shared RN theme tokens mirroring src/ui/theme.js.
// Used by native onboarding screens so they stay visually consistent
// with the WebView UI. Keep in sync with src/ui/theme.js.

export const colors = {
  primary: '#4CAF50',
  primaryLight: '#81C784',
  primaryOn: '#FFFFFF',
  accent: '#7B9FEB',
  secondary: '#FFB74D',
  error: '#EF5350',
  success: '#66BB6A',
  surface: {
    base: '#0D0D0D',
    card: '#1A1A1A',
    elevated: '#252525',
    input: '#333333',
    tintedGreen: '#1A2E1A',
    tintedBlue: '#1a1a2e',
    tintedRed: '#2e1a1a',
  },
  text: {
    primary: '#F0F0F0',
    secondary: '#A0A0A0',
    muted: '#666666',
    onPrimary: '#FFFFFF',
  },
  border: '#333333',
  divider: '#2A2A2A',
}

export const spacing = { xs: 4, sm: 8, md: 12, base: 16, lg: 20, xl: 24, xxl: 32, xxxl: 48 }

export const radius = { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 }

export const fontFamily = {
  light: 'Nunito_300Light',
  regular: 'Nunito_400Regular',
  semibold: 'Nunito_600SemiBold',
  bold: 'Nunito_700Bold',
}

export const typography = {
  display:    { fontSize: 24, fontFamily: fontFamily.light },
  heading:    { fontSize: 20, fontFamily: fontFamily.light },
  subheading: { fontSize: 16, fontFamily: fontFamily.regular },
  body:       { fontSize: 14, fontFamily: fontFamily.regular },
  caption:    { fontSize: 12, fontFamily: fontFamily.regular },
  micro:      { fontSize: 11, fontFamily: fontFamily.semibold },
}
