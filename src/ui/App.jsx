import { useState, useEffect } from 'react';
import { initTheme, useTheme } from './theme.js';
import ParentApp from './components/ParentApp.jsx';
import ChildApp from './components/ChildApp.jsx';

function ModeSetup() {
  const { colors, typography } = useTheme();
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', backgroundColor: colors.surface.base }}>
      <p style={{ ...typography.body, color: colors.text.secondary }}>Waiting for setup...</p>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState(null);
  const [ready, setReady] = useState(false);
  const { colors } = useTheme();

  useEffect(() => {
    initTheme();
    window.callBare('identity:getMode')
      .then(({ mode: m }) => setMode(m))
      .catch(() => {});

    const unsub = window.onBareEvent('ready', () => {
      window.callBare('identity:getMode')
        .then(({ mode: m }) => setMode(m))
        .catch(() => {});
    });
    setReady(true);
    return unsub;
  }, []);

  if (!ready) return null;

  return (
    <div style={{ height: '100vh', backgroundColor: colors.surface.base, color: colors.text.primary }}>
      {mode === 'parent' ? <ParentApp /> : mode === 'child' ? <ChildApp /> : <ModeSetup />}
    </div>
  );
}
