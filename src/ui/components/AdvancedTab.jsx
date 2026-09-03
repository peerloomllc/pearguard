import React, { useState, useEffect } from 'react';
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

  // Rule sets kept from children that were unpaired. A child rotates its
  // identity when it is unpaired, so it comes back as a new device and its old
  // rules cannot be matched to it automatically: the parent picks.
  const [archives, setArchives] = useState([]);
  const [restoring, setRestoring] = useState(null);
  const [restoreNote, setRestoreNote] = useState(null);

  useEffect(() => {
    window.callBare('rules:archives')
      .then((r) => setArchives((r && r.archives) || []))
      .catch(() => {});
  }, [child.publicKey]);

  async function restoreArchive(a) {
    setRestoring(a.key);
    setRestoreNote(null);
    try {
      const res = await window.callBare('rules:restoreArchive', { archiveKey: a.key, targetChildPubKey: child.publicKey });
      setRestoreNote(res && res.ok
        ? `Restored ${a.displayName}'s rules to the ${res.appCount} app${res.appCount === 1 ? '' : 's'} on this device.`
        : 'Those rules are no longer available.');
    } catch {
      setRestoreNote('Could not restore those rules.');
    } finally {
      setRestoring(null);
    }
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

      {archives.length > 0 && (
        <Section title="Restore Kept Rules" colors={colors} spacing={spacing} typography={typography} radius={radius}>
          <p style={{ ...typography.body, color: colors.text.muted, margin: 0, marginBottom: `${spacing.md}px`, textAlign: 'center' }}>
            Rules kept from a device you unpaired. Applying a set only affects apps installed on {child.displayName}'s device.
          </p>
          {archives.map((a) => (
            <div key={a.key} style={{
              display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`,
              padding: `${spacing.sm}px 0`, borderTop: `1px solid ${colors.divider}`,
            }}>
              <div style={{ flex: 1 }}>
                <div style={{ ...typography.body, color: colors.text.primary }}>{a.displayName}</div>
                <div style={{ ...typography.caption, color: colors.text.muted }}>
                  {a.appCount} app{a.appCount === 1 ? '' : 's'}
                  {a.scheduleCount > 0 ? `, ${a.scheduleCount} schedule${a.scheduleCount === 1 ? '' : 's'}` : ''}
                  {a.hasScreenTimeLimit ? ', screen time limit' : ''}
                  {a.archivedAt ? ` \u00b7 unpaired ${new Date(a.archivedAt).toLocaleDateString()}` : ''}
                </div>
              </div>
              <Button
                variant="secondary"
                disabled={restoring === a.key}
                onClick={() => { window.callBare('haptic:tap'); restoreArchive(a); }}
              >
                {restoring === a.key ? 'Restoring...' : 'Restore'}
              </Button>
            </div>
          ))}
          {restoreNote && (
            <p role="status" style={{ ...typography.caption, color: colors.text.secondary, marginBottom: 0, textAlign: 'center' }}>
              {restoreNote}
            </p>
          )}
        </Section>
      )}

      <Section title="Danger Zone" colors={colors} spacing={spacing} typography={typography} radius={radius}>
        <p style={{ ...typography.body, color: colors.text.muted, margin: 0, marginBottom: `${spacing.md}px`, textAlign: 'center' }}>
          Removing {child.displayName} unpairs this device. You'll need to re-pair to monitor it again.
          Their rules are kept, so you can put them back if you do.
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
