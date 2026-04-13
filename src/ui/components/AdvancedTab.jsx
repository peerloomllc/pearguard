import React, { useState } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Button from './primitives/Button.jsx';
import Modal from './primitives/Modal.jsx';
import RulesTransferModal from './RulesTransferModal.jsx';

export default function AdvancedTab({ child, onUnpair }) {
  const { colors, spacing, typography, radius } = useTheme();
  const [transferMode, setTransferMode] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  function openTransfer(mode) {
    window.callBare('haptic:tap');
    setTransferMode(mode);
  }

  async function handleRemove() {
    window.callBare('haptic:tap');
    setConfirmRemove(false);
    await window.callBare('child:unpair', { childPublicKey: child.publicKey });
    onUnpair?.();
  }

  return (
    <div style={{ padding: `${spacing.base}px`, display: 'flex', flexDirection: 'column', gap: `${spacing.lg}px` }}>
      <Section title="Rules Transfer" colors={colors} spacing={spacing} typography={typography} radius={radius}>
        <p style={{ ...typography.body, color: colors.text.muted, margin: 0, marginBottom: `${spacing.md}px`, textAlign: 'center' }}>
          Export {child.displayName}'s rules to a JSON file, or import rules from another child.
        </p>
        <div style={{ display: 'flex', gap: `${spacing.sm}px`, justifyContent: 'center' }}>
          <Button variant="secondary" icon="Export" onClick={() => openTransfer('export')} style={{ flex: 1 }}>Export</Button>
          <Button variant="secondary" icon="DownloadSimple" onClick={() => openTransfer('import')} style={{ flex: 1 }}>Import</Button>
        </div>
      </Section>

      <Section title="Danger Zone" colors={colors} spacing={spacing} typography={typography} radius={radius}>
        <p style={{ ...typography.body, color: colors.text.muted, margin: 0, marginBottom: `${spacing.md}px`, textAlign: 'center' }}>
          Removing {child.displayName} unpairs this device. You'll need to re-pair to monitor it again.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <Button variant="danger" icon="Trash" onClick={() => { window.callBare('haptic:tap'); setConfirmRemove(true); }}>
            Unpair {child.displayName}
          </Button>
        </div>
      </Section>

      <Modal
        visible={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Unpair from ${child.displayName}?`}
        footer={<>
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); setConfirmRemove(false); }} style={{ flex: 1 }}>Cancel</Button>
          <Button variant="danger" icon="Trash" onClick={handleRemove} style={{ flex: 1 }}>Unpair</Button>
        </>}
      >
        This will remove {child.displayName} from your dashboard. You'll need to re-pair to monitor this device again.
      </Modal>

      <RulesTransferModal
        visible={transferMode !== null}
        mode={transferMode || 'export'}
        child={child}
        onClose={() => setTransferMode(null)}
      />
    </div>
  );
}

function Section({ title, colors, spacing, typography, radius, children }) {
  return (
    <div style={{
      backgroundColor: colors.surface.elevated,
      borderRadius: `${radius.lg}px`,
      padding: `${spacing.base}px`,
    }}>
      <div style={{ ...typography.subheading, color: colors.text.primary, fontWeight: 600, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
        {title}
      </div>
      {children}
    </div>
  );
}
