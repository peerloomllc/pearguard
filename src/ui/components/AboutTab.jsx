import React, { useState } from 'react';
import { useTheme } from '../theme.js';
import Button from './primitives/Button.jsx';
import Modal from './primitives/Modal.jsx';
import Collapsible from './primitives/Collapsible.jsx';
import Icon from '../icons.js';

const LIGHTNING_ADDRESS = 'peerloomllc@strike.me';

const WALLETS = [
  { name: 'Strike', url: 'https://strike.me', desc: 'Simple Lightning payments' },
  { name: 'Cash App', url: 'https://cash.app', desc: 'Send Bitcoin via Lightning' },
  { name: 'Wallet of Satoshi', url: 'https://walletofsatoshi.com', desc: 'Beginner-friendly Lightning wallet' },
  { name: 'Phoenix', url: 'https://phoenix.acinq.co', desc: 'Self-custodial Lightning wallet' },
];

function openURL(url) {
  window.callBare('haptic:tap');
  window.callBare('openURL', { url });
}

function shareApp() {
  window.callBare('haptic:tap');
  window.callBare('share:text', {
    text: 'Check out PearGuard - a private, peer-to-peer parental control app with no servers or accounts.\n\nhttps://peerloomllc.com/pearguard/',
  });
}

export default function AboutTab() {
  const { colors, spacing, radius } = useTheme();
  const [walletModal, setWalletModal] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [valueOpen, setValueOpen] = useState(false);
  const [bitcoinOpen, setBitcoinOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  // App Store guideline 3.1.1 forbids non-IAP digital purchases, including donations.
  const isIOS = window.__pearPlatform === 'ios';

  async function handleDonateBTC() {
    window.callBare('haptic:tap');
    try {
      const can = await window.callBare('canOpenURL', { url: 'lightning:test' });
      if (can) {
        window.callBare('openURL', { url: 'lightning:' + LIGHTNING_ADDRESS });
      } else {
        setWalletModal(true);
      }
    } catch {
      setWalletModal(true);
    }
  }

  const fullWidth = { width: '100%' };
  const flexOne = { flex: 1 };
  const bodyStyle = { fontSize: '13px', color: colors.text.muted, lineHeight: '1.6', marginBottom: `${spacing.md}px`, marginTop: 0 };
  const collapsibleProps = { colors, spacing, radius };

  return (
    <div style={{ padding: `${spacing.base}px`, overflowY: 'auto', flex: 1 }}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: `${spacing.xs}px`, marginBottom: `${spacing.lg}px` }}>
        <div style={{ fontSize: '20px', fontWeight: '600', color: colors.text.primary }}>PearGuard</div>
        <div style={{ fontSize: '12px', color: colors.text.muted }}>Private. Peer-to-Peer. No Servers.</div>
      </div>

      <Collapsible title="How it works" icon="Info" open={howOpen} onToggle={() => setHowOpen(v => !v)} maxHeight="240px" {...collapsibleProps}>
        <p style={bodyStyle}>
          PearGuard connects parent and child devices directly using peer-to-peer
          technology. Your data never touches a server - policies, usage reports, and
          requests stay between your devices. No accounts. No subscriptions. No data
          collection.
        </p>
        <Button variant="secondary" onClick={() => openURL('https://pears.com/')} style={fullWidth}>
          Learn about P2P <Icon name="ArrowSquareOut" size={14} color={colors.primary} />
        </Button>
      </Collapsible>

      <Collapsible title="Tutorial" icon="BookOpen" open={tutorialOpen} onToggle={() => setTutorialOpen(v => !v)} maxHeight="200px" {...collapsibleProps}>
        <p style={bodyStyle}>
          Replay the in-app walkthrough that introduces the Dashboard, Apps, Rules, and Activity tabs.
        </p>
        <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); window.__pearReplayTour?.(); }} style={fullWidth}>
          <Icon name="BookOpen" size={16} color={colors.primary} /> Replay Tutorial
        </Button>
      </Collapsible>

      {!isIOS && (
        <Collapsible title="Value for value" icon="Lightning" open={valueOpen} onToggle={() => setValueOpen(v => !v)} maxHeight="200px" {...collapsibleProps}>
          <p style={bodyStyle}>
            PearGuard is free and open source. If you receive value from it, please
            consider returning value.
          </p>
          <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
            <Button variant="secondary" onClick={handleDonateBTC} style={flexOne}>
              <Icon name="Lightning" size={14} color={colors.primary} /> BTC <Icon name="Lightning" size={14} color={colors.primary} />
            </Button>
            <Button variant="secondary" onClick={() => openURL('https://buymeacoffee.com/peerloomllc')} style={flexOne}>
              <Icon name="CurrencyDollar" size={14} color={colors.primary} /> USD <Icon name="CurrencyDollar" size={14} color={colors.primary} />
            </Button>
          </div>
        </Collapsible>
      )}

      <Collapsible title="Learn about Bitcoin" icon="BookOpen" open={bitcoinOpen} onToggle={() => setBitcoinOpen(v => !v)} maxHeight="220px" {...collapsibleProps}>
        <p style={bodyStyle}>
          New to Bitcoin? The Satoshi Nakamoto Institute has a free, concise crash
          course explaining how Bitcoin works and why it matters.
        </p>
        <Button variant="secondary" onClick={() => openURL('https://nakamotoinstitute.org/crash-course/')} style={fullWidth}>
          <Icon name="BookOpen" size={16} color={colors.primary} /> Bitcoin Crash Course <Icon name="ArrowSquareOut" size={14} color={colors.primary} />
        </Button>
      </Collapsible>

      <Collapsible title="Share the app" icon="ShareNetwork" open={shareOpen} onToggle={() => setShareOpen(v => !v)} maxHeight="200px" {...collapsibleProps}>
        <p style={bodyStyle}>
          Know someone who could use private, serverless parental controls? Share
          PearGuard with them.
        </p>
        <Button variant="secondary" onClick={shareApp} style={fullWidth}>
          <Icon name="ShareNetwork" size={16} color={colors.primary} /> Share PearGuard
        </Button>
      </Collapsible>

      <Collapsible title="Contact" icon="EnvelopeSimple" open={contactOpen} onToggle={() => setContactOpen(v => !v)} maxHeight="120px" {...collapsibleProps}>
        <div style={{ display: 'flex', gap: `${spacing.sm}px`, justifyContent: 'center' }}>
          <Button
            variant="secondary"
            onClick={() => openURL('mailto:peerloomllc@proton.me?subject=%5BPearGuard%5D%20Feedback')}
          >
            <Icon name="EnvelopeSimple" size={14} color={colors.primary} /> Send Email <Icon name="ArrowSquareOut" size={13} color={colors.primary} />
          </Button>
          <Button
            variant="secondary"
            onClick={() => openURL('https://github.com/peerloomllc/pearguard/issues')}
          >
            <Icon name="Bug" size={14} color={colors.primary} /> Report Issue <Icon name="ArrowSquareOut" size={13} color={colors.primary} />
          </Button>
        </div>
      </Collapsible>

      <div style={{ textAlign: 'center', fontSize: '11px', color: colors.text.muted, paddingTop: `${spacing.md}px`, paddingBottom: `${spacing.sm}px` }}>v0.1.0</div>

      <Modal
        visible={walletModal}
        onClose={() => setWalletModal(false)}
        title={<><Icon name="Lightning" size={18} color={colors.primary} /> Bitcoin Lightning <Icon name="Lightning" size={18} color={colors.primary} /></>}
        footer={<Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); setWalletModal(false); }} style={fullWidth}>Close</Button>}
      >
        <p style={{ lineHeight: '1.6', marginTop: 0, marginBottom: `${spacing.base}px` }}>
          No Lightning wallet was detected on your device. Bitcoin Lightning is a fast, low-fee
          payment network built on top of Bitcoin. To send a tip, install one of these wallets:
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
          {WALLETS.map((w) => (
            <Button key={w.name} variant="secondary" onClick={() => openURL(w.url)} style={{ width: '100%', textAlign: 'left' }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: '600' }}>{w.name}</div>
                <div style={{ fontSize: '12px', color: colors.text.muted }}>{w.desc}</div>
              </div>
              <Icon name="ArrowSquareOut" size={14} color={colors.text.muted} />
            </Button>
          ))}
        </div>
        <p style={{ fontSize: '12px', color: colors.text.muted, textAlign: 'center', marginTop: `${spacing.base}px`, marginBottom: 0 }}>
          After installing, return here and tap Donate again.
        </p>
      </Modal>
    </div>
  );
}
