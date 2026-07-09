import React, { useState } from 'react';
import { useTheme } from '../theme.js';
import Button from './primitives/Button.jsx';
import BottomSheet from './primitives/BottomSheet.jsx';
import Collapsible from './primitives/Collapsible.jsx';
import Icon from '../icons.js';

const LIGHTNING_ADDRESS = 'peerloomllc@strike.me';
const STRIKE_TIP_URL = 'https://strike.me/peerloomllc/';
// Strike deposit address: custodial and derived from Strike's xpub, so reuse is fine.
// Empty string hides the on-chain row.
const BTC_ONCHAIN_ADDRESS = 'bc1q0kksenz3j4u9ppe6f4krclvzwxk7sjy00cc9cf';
// Shared height so every option box (buttons, copy fields, wallet rows) lines up.
const DONATE_OPTION_MIN_H = 56;
const MONO_FAMILY = "'SF Mono', 'Roboto Mono', Menlo, Consolas, monospace";

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

function CopyField({ value, hint }) {
  const { colors, typography, spacing, radius } = useTheme();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      const r = await window.callBare('clipboard:copy', { text: value });
      if (r?.ok !== false) {
        window.callBare('haptic:tap');
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }
    } catch {}
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: `${spacing.sm}px`,
          background: colors.surface.elevated,
          border: `1px solid ${colors.border}`,
          borderRadius: `${radius.md}px`,
          padding: `${spacing.sm + 2}px ${spacing.md}px`,
          minHeight: `${DONATE_OPTION_MIN_H}px`,
          boxSizing: 'border-box',
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: MONO_FAMILY,
            fontSize: '13px',
            color: colors.text.primary,
          }}
        >
          {value}
        </span>
        <button
          onClick={copy}
          style={{
            flexShrink: 0,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontFamily: typography.body.fontFamily,
            fontSize: '13px',
            fontWeight: '400',
            color: copied ? colors.success : colors.primary,
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          {copied ? <><Icon name="CheckCircle" size={14} weight="fill" color={colors.success} /> Copied</> : 'Copy'}
        </button>
      </div>
      {hint && (
        <p style={{ ...typography.caption, color: colors.text.muted, margin: `${spacing.xs}px 0 0`, lineHeight: '1.5', textAlign: 'center' }}>
          {hint}
        </p>
      )}
    </div>
  );
}

function shareApp() {
  window.callBare('haptic:tap');
  window.callBare('share:text', {
    text: 'Check out PearGuard - a private, peer-to-peer parental control app with no servers or accounts.\n\nhttps://peerloomllc.com/pearguard/',
  });
}

export default function AboutTab() {
  const { colors, typography, spacing, radius } = useTheme();
  const [walletModal, setWalletModal] = useState(false);
  const [lnDetected, setLnDetected] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [valueOpen, setValueOpen] = useState(false);
  const [bitcoinOpen, setBitcoinOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);

  // Always open the sheet: it is a chooser, never an auto-fire into the wallet.
  async function handleDonateBTC() {
    window.callBare('haptic:tap');
    let can = false;
    try {
      can = !!(await window.callBare('canOpenURL', { url: 'lightning:test' }));
    } catch {}
    setLnDetected(can);
    setWalletModal(true);
  }

  const fullWidth = { width: '100%' };
  const flexOne = { flex: 1 };
  const optionBox = { width: '100%', minHeight: `${DONATE_OPTION_MIN_H}px`, boxSizing: 'border-box' };
  const walletRow = { ...optionBox, textAlign: 'left' };
  const secLabel = {
    ...typography.caption,
    color: colors.text.secondary,
    fontWeight: '400',
    margin: `${spacing.lg}px 0 ${spacing.sm}px`,
    textAlign: 'center',
  };
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
        <Button variant="accent" onClick={() => openURL('https://pears.com/')} style={fullWidth}>
          Learn about P2P <Icon name="ArrowSquareOut" size={14} color="#000000" />
        </Button>
      </Collapsible>

      <Collapsible title="Tutorial" icon="BookOpen" open={tutorialOpen} onToggle={() => setTutorialOpen(v => !v)} maxHeight="200px" {...collapsibleProps}>
        <p style={bodyStyle}>
          Replay the in-app walkthrough that introduces the Dashboard, Apps, Rules, and Activity tabs.
        </p>
        <Button variant="accent" onClick={() => { window.callBare('haptic:tap'); window.__pearReplayTour?.(); }} style={fullWidth}>
          <Icon name="BookOpen" size={16} color="#000000" /> Replay Tutorial
        </Button>
      </Collapsible>

      <Collapsible title="Support development" icon="Lightning" open={valueOpen} onToggle={() => setValueOpen(v => !v)} maxHeight="200px" {...collapsibleProps}>
        <p style={bodyStyle}>
          PearGuard is free and open source. If you receive value from it, please
          consider returning value.
        </p>
        <div style={{ display: 'flex', gap: `${spacing.sm}px` }}>
          <Button variant="accent" onClick={handleDonateBTC} style={flexOne}>
            <Icon name="Lightning" size={14} color="#000000" /> BTC <Icon name="Lightning" size={14} color="#000000" />
          </Button>
          <Button variant="accent" onClick={() => openURL('https://buymeacoffee.com/peerloomllc')} style={flexOne}>
            <Icon name="CurrencyDollar" size={14} color="#000000" /> USD <Icon name="CurrencyDollar" size={14} color="#000000" />
          </Button>
        </div>
      </Collapsible>

      <Collapsible title="Learn about Bitcoin" icon="BookOpen" open={bitcoinOpen} onToggle={() => setBitcoinOpen(v => !v)} maxHeight="220px" {...collapsibleProps}>
        <p style={bodyStyle}>
          New to Bitcoin? The Satoshi Nakamoto Institute has a free, concise crash
          course explaining how Bitcoin works and why it matters.
        </p>
        <Button variant="accent" onClick={() => openURL('https://nakamotoinstitute.org/crash-course/')} style={fullWidth}>
          <Icon name="BookOpen" size={16} color="#000000" /> Bitcoin Crash Course <Icon name="ArrowSquareOut" size={14} color="#000000" />
        </Button>
      </Collapsible>

      <Collapsible title="Share the app" icon="ShareNetwork" open={shareOpen} onToggle={() => setShareOpen(v => !v)} maxHeight="200px" {...collapsibleProps}>
        <p style={bodyStyle}>
          Know someone who could use private, serverless parental controls? Share
          PearGuard with them.
        </p>
        <Button variant="accent" onClick={shareApp} style={fullWidth}>
          <Icon name="ShareNetwork" size={16} color="#000000" /> Share PearGuard
        </Button>
      </Collapsible>

      <Collapsible title="Contact" icon="EnvelopeSimple" open={contactOpen} onToggle={() => setContactOpen(v => !v)} maxHeight="120px" {...collapsibleProps}>
        <div style={{ display: 'flex', gap: `${spacing.sm}px`, justifyContent: 'center' }}>
          <Button
            variant="accent"
            onClick={() => openURL('mailto:peerloomllc@proton.me?subject=%5BPearGuard%5D%20Feedback')}
          >
            <Icon name="EnvelopeSimple" size={14} color="#000000" /> Send Email <Icon name="ArrowSquareOut" size={13} color="#000000" />
          </Button>
          <Button
            variant="accent"
            onClick={() => openURL('https://github.com/peerloomllc/pearguard/issues')}
          >
            <Icon name="Bug" size={14} color="#000000" /> Report Issue <Icon name="ArrowSquareOut" size={13} color="#000000" />
          </Button>
        </div>
      </Collapsible>

      <div style={{ textAlign: 'center', fontSize: '11px', color: colors.text.muted, paddingTop: `${spacing.md}px`, paddingBottom: `${spacing.sm}px` }}>v{window.__pearVersion || ''}</div>

      {walletModal && (
        <BottomSheet
          onClose={() => setWalletModal(false)}
          title={<><Icon name="Lightning" size={18} color={colors.primary} /> Bitcoin Lightning <Icon name="Lightning" size={18} color={colors.primary} /></>}
          footer={(close) => (
            <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); close(); }} style={fullWidth}>Close</Button>
          )}
        >
          {(close) => (
            <>
              <p style={{ lineHeight: '1.7', textAlign: 'center', marginTop: 0, marginBottom: `${spacing.base}px` }}>
                Support PearGuard with Bitcoin over Lightning (fast and low-fee)
                {BTC_ONCHAIN_ADDRESS ? ' or on-chain' : ''}.
              </p>

              {lnDetected && (
                <>
                  <Button variant="accent" onClick={() => { openURL('lightning:' + LIGHTNING_ADDRESS); close(); }} style={optionBox}>
                    <Icon name="Lightning" size={16} color="#000000" /> Open in your Lightning wallet <Icon name="Lightning" size={16} color="#000000" />
                  </Button>
                  <p style={{ lineHeight: '1.7', textAlign: 'center', margin: `${spacing.base}px 0 0` }}>or use another method:</p>
                </>
              )}

              <p style={{ ...secLabel, marginTop: `${lnDetected ? spacing.base : spacing.md}px` }}>Lightning address</p>
              <CopyField value={LIGHTNING_ADDRESS} hint="Paste into any Lightning, ecash or web wallet." />

              <div style={{ marginTop: `${spacing.base}px` }}>
                <Button variant="accent" onClick={() => { openURL(STRIKE_TIP_URL); close(); }} style={optionBox}>
                  <Icon name="Lightning" size={16} color="#000000" /> Show a QR / pay in a browser <Icon name="Lightning" size={16} color="#000000" />
                </Button>
                <p style={{ ...typography.caption, color: colors.text.muted, margin: `${spacing.xs}px 0 0`, textAlign: 'center', lineHeight: '1.5' }}>
                  Scan from another device or on desktop.
                </p>
              </div>

              {BTC_ONCHAIN_ADDRESS && (
                <>
                  <p style={secLabel}>On-chain Bitcoin</p>
                  <CopyField value={BTC_ONCHAIN_ADDRESS} hint="On-chain BTC. Higher fees, so Lightning is cheaper for small tips." />
                </>
              )}

              {!lnDetected && (
                <>
                  <p style={{ lineHeight: '1.7', textAlign: 'center', margin: `${spacing.lg}px 0 ${spacing.sm}px` }}>
                    Don't have a Lightning wallet?
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.sm}px` }}>
                    {WALLETS.map((w) => (
                      <Button key={w.name} variant="secondary" onClick={() => openURL(w.url)} style={walletRow}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: '600' }}>{w.name}</div>
                          <div style={{ fontSize: '12px', color: colors.text.muted }}>{w.desc}</div>
                        </div>
                        <Icon name="ArrowSquareOut" size={14} color={colors.text.muted} />
                      </Button>
                    ))}
                  </div>
                  <p style={{ lineHeight: '1.7', textAlign: 'center', marginTop: `${spacing.base}px`, marginBottom: 0 }}>
                    After installing, return here and tap BTC again.
                  </p>
                </>
              )}
            </>
          )}
        </BottomSheet>
      )}
    </div>
  );
}
