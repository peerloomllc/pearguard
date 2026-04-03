import React from 'react';

function openURL(url) {
  window.callBare('openURL', { url });
}

function shareApp() {
  window.callBare('share:text', {
    text: 'Check out PearGuard - a private, peer-to-peer parental control app with no servers or accounts.\n\nhttps://peerloomllc.com/pearguard/',
  });
}

export default function AboutTab() {
  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.appName}>PearGuard</div>
        <div style={styles.tagline}>Private. Peer-to-Peer. No Servers.</div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>HOW IT WORKS</div>
        <p style={styles.cardText}>
          PearGuard connects parent and child devices directly using peer-to-peer
          technology. Your data never touches a server - policies, usage reports, and
          requests stay between your devices. No accounts. No subscriptions. No data
          collection.
        </p>
        <button onClick={() => openURL('https://pears.com/')} style={styles.btn}>
          Learn about P2P &#8599;
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>SUPPORT DEVELOPMENT</div>
        <p style={styles.cardText}>
          PearGuard is free and open source. If you find it valuable, please consider
          supporting its development.
        </p>
        <div style={styles.btnRow}>
          <button onClick={() => openURL('lightning:peerloomllc@strike.me')} style={{ ...styles.btn, flex: 1 }}>
            Donate BTC
          </button>
          <button onClick={() => openURL('https://buymeacoffee.com/peerloomllc')} style={{ ...styles.btn, flex: 1 }}>
            Buy Me a Coffee
          </button>
        </div>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>LEARN ABOUT BITCOIN</div>
        <p style={styles.cardText}>
          New to Bitcoin? The Satoshi Nakamoto Institute has a free, concise crash
          course explaining how Bitcoin works and why it matters.
        </p>
        <button onClick={() => openURL('https://nakamotoinstitute.org/crash-course/')} style={styles.btn}>
          Bitcoin Crash Course &#8599;
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>SHARE THE APP</div>
        <p style={styles.cardText}>
          Know someone who could use private, serverless parental controls? Share
          PearGuard with them.
        </p>
        <button onClick={shareApp} style={styles.btn}>
          Share PearGuard
        </button>
      </div>

      <div style={styles.card}>
        <div style={styles.cardTitle}>CONTACT</div>
        <div style={styles.btnRow}>
          <button
            onClick={() => openURL('mailto:peerloomllc@proton.me?subject=%5BPearGuard%5D%20Feedback')}
            style={styles.btn}
          >
            Send Email &#8599;
          </button>
          <button
            onClick={() => openURL('https://github.com/peerloomllc/pearguard/issues')}
            style={styles.btn}
          >
            Report Issue &#8599;
          </button>
        </div>
      </div>

      <div style={styles.version}>v0.1.0</div>
    </div>
  );
}

const styles = {
  container: {
    padding: '16px',
    fontFamily: 'sans-serif',
    overflowY: 'auto',
    flex: 1,
  },
  header: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '4px',
    marginBottom: '20px',
  },
  appName: { fontSize: '20px', fontWeight: '600' },
  tagline: { fontSize: '12px', color: '#888' },
  card: {
    backgroundColor: '#f8f8f8',
    borderRadius: '12px',
    padding: '14px 16px',
    marginBottom: '12px',
  },
  cardTitle: {
    fontSize: '11px',
    fontWeight: '600',
    color: '#555',
    letterSpacing: '0.04em',
    textAlign: 'center',
    marginBottom: '8px',
  },
  cardText: {
    fontSize: '13px',
    color: '#666',
    lineHeight: '1.6',
    marginBottom: '12px',
    marginTop: 0,
  },
  btn: {
    width: '100%',
    padding: '10px',
    border: '1px solid #ddd',
    borderRadius: '8px',
    backgroundColor: '#fff',
    color: '#333',
    fontSize: '14px',
    cursor: 'pointer',
    textAlign: 'center',
  },
  btnRow: {
    display: 'flex',
    gap: '8px',
  },
  version: {
    textAlign: 'center',
    fontSize: '11px',
    color: '#aaa',
    paddingTop: '12px',
    paddingBottom: '8px',
  },
};
