import { useState, useEffect } from 'react';

const palettes = {
  dark: {
    primary: '#4CAF50',
    primaryLight: '#81C784',
    secondary: '#FFB74D',
    error: '#EF5350',
    success: '#66BB6A',
    surface: {
      base: '#0D0D0D',
      card: '#1A1A1A',
      elevated: '#252525',
      input: '#333333',
    },
    text: {
      primary: '#F0F0F0',
      secondary: '#A0A0A0',
      muted: '#666666',
    },
    border: '#333333',
    divider: '#2A2A2A',
  },
  light: {
    primary: '#4CAF50',
    primaryLight: '#81C784',
    secondary: '#FFB74D',
    error: '#EF5350',
    success: '#66BB6A',
    surface: {
      base: '#FAFAF8',
      card: '#FFFFFF',
      elevated: '#F0F0EC',
      input: '#E8E8E4',
    },
    text: {
      primary: '#1A1A1A',
      secondary: '#555555',
      muted: '#999999',
    },
    border: '#DDDDDD',
    divider: '#EEEEEE',
  },
};

const typography = {
  display:    { fontSize: '24px', fontWeight: '300', fontFamily: "'Nunito', system-ui, sans-serif" },
  heading:    { fontSize: '20px', fontWeight: '300', fontFamily: "'Nunito', system-ui, sans-serif" },
  subheading: { fontSize: '16px', fontWeight: '400', fontFamily: "'Nunito', system-ui, sans-serif" },
  body:       { fontSize: '14px', fontWeight: '400', fontFamily: "'Nunito', system-ui, sans-serif" },
  caption:    { fontSize: '12px', fontWeight: '400', fontFamily: "'Nunito', system-ui, sans-serif" },
  micro:      { fontSize: '11px', fontWeight: '500', fontFamily: "'Nunito', system-ui, sans-serif" },
};

const spacing = { xs: 4, sm: 8, md: 12, base: 16, lg: 20, xl: 24, xxl: 32, xxxl: 48 };

const radius = { sm: 4, md: 8, lg: 12, xl: 16, full: 9999 };

function shadow(colors) {
  if (colors === palettes.dark) {
    return '0 2px 8px rgba(0,0,0,0.4)';
  }
  return '0 1px 3px rgba(0,0,0,0.1)';
}

let _theme = 'dark';
let _listeners = [];

function getColors() { return palettes[_theme]; }

function setTheme(name) {
  _theme = name;
  _listeners.forEach((fn) => fn(name));
  window.callBare('settings:setTheme', { theme: name }).catch(() => {});
}

function useTheme() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const handler = () => forceUpdate((n) => n + 1);
    _listeners.push(handler);
    return () => { _listeners = _listeners.filter((fn) => fn !== handler); };
  }, []);

  return {
    colors: getColors(),
    typography,
    spacing,
    radius,
    shadow: shadow(getColors()),
    theme: _theme,
    setTheme,
  };
}

async function initTheme() {
  try {
    const { theme } = await window.callBare('settings:getTheme');
    if (theme && palettes[theme]) {
      _theme = theme;
      _listeners.forEach((fn) => fn(theme));
    }
  } catch {
    // Default to dark
  }
}

export { useTheme, initTheme, palettes, typography, spacing, radius };
