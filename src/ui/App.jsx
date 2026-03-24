import React, { useState, useEffect } from 'react';
import ParentApp from './components/ParentApp.jsx';
import ChildApp from './components/ChildApp.jsx';

function ModeSetup() {
  return (
    <div style={styles.center}>
      <h2>Welcome to PearGuard</h2>
      <p>Please complete setup in the PearGuard app to choose your mode.</p>
    </div>
  );
}

export default function App() {
  const [mode, setMode] = useState(undefined); // undefined = loading, null = no mode

  useEffect(() => {
    function fetchMode() {
      window.callBare('identity:getMode')
        .then(({ mode }) => setMode(mode))
        .catch(() => setMode(null));
    }
    fetchMode();
    // Re-fetch when the worklet re-initializes (e.g. returning from setup screen)
    // so the UI transitions from ModeSetup → ParentApp/ChildApp without a full remount.
    return window.onBareEvent('ready', fetchMode);
  }, []);

  if (mode === undefined) {
    return <div style={styles.center}><p>Loading...</p></div>;
  }
  if (mode === 'parent') return <ParentApp />;
  if (mode === 'child') return <ChildApp />;
  return <ModeSetup />;
}

const styles = {
  center: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    fontFamily: 'sans-serif',
    color: '#fff',
  },
};
