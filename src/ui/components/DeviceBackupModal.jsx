import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import Button from './primitives/Button.jsx';
import Modal from './primitives/Modal.jsx';

// mode: 'export' | 'import'
export default function DeviceBackupModal({ visible, mode, onClose }) {
  const { colors, spacing, typography } = useTheme();
  const [stage, setStage] = useState('idle'); // idle | working | done | error
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) { setStage('idle'); setSummary(null); setError(''); }
  }, [visible]);

  const isExport = mode === 'export';
  const title = isExport ? 'Export Device Backup' : 'Import Device Backup';

  async function handleExport() {
    window.callBare('haptic:tap');
    setStage('working'); setError('');
    try {
      const res = await window.callBare('backup:export');
      const filename = `pearguard-backup-${Date.now()}.json`;
      await window.callBare('file:save', { filename, content: res.json });
      setSummary({ peerCount: res.peerCount, policyCount: res.policyCount, bytes: res.json.length });
      setStage('done');
    } catch (e) {
      setError(String(e?.message || e));
      setStage('error');
    }
  }

  async function handleImport() {
    window.callBare('haptic:tap');
    setStage('working'); setError('');
    try {
      const picked = await window.callBare('file:pick');
      if (!picked || picked.canceled) { setStage('idle'); return; }
      const text = picked.content || '';
      if (!text.trim()) throw new Error('Selected file is empty.');
      const res = await window.callBare('backup:import', { jsonString: text });
      setSummary({ paired: res.paired || [] });
      setStage('done');
    } catch (e) {
      setError(String(e?.message || e));
      setStage('error');
    }
  }

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      title={title}
      footer={renderFooter()}
    >
      {renderBody()}
    </Modal>
  );

  function renderBody() {
    if (stage === 'working') return <div style={{ textAlign: 'center', color: colors.text.muted }}>Working...</div>;
    if (stage === 'error') return <div style={{ color: colors.error, ...typography.body }}>{error}</div>;
    if (isExport) {
      if (stage === 'done' && summary) {
        return (
          <div style={{ ...typography.body, color: colors.text.primary }}>
            Backup file saved ({summary.bytes.toLocaleString()} bytes).
            Includes {summary.peerCount} paired {summary.peerCount === 1 ? 'child' : 'children'} and {summary.policyCount} {summary.policyCount === 1 ? 'policy' : 'policies'}.
            <div style={{ marginTop: `${spacing.md}px`, color: colors.warning || colors.error }}>
              ⚠️ This backup contains your parent identity secret key. Treat it like a password - anyone with this file can impersonate you to your children. Store it in a password manager or encrypted location, not email or chat.
            </div>
          </div>
        );
      }
      return (
        <div style={{ ...typography.body, color: colors.text.primary }}>
          Exports your full parent state: identity, profile, settings, paired children, and all policies.
          <div style={{ marginTop: `${spacing.md}px`, color: colors.warning || colors.error }}>
            ⚠️ Contains your identity secret key. Store securely.
          </div>
        </div>
      );
    }
    // Import
    if (stage === 'done' && summary) {
      return (
        <div style={{ ...typography.body, color: colors.text.primary }}>
          Backup imported. Restored {summary.paired.length} paired {summary.paired.length === 1 ? 'child' : 'children'}.
          <div style={{ marginTop: `${spacing.md}px`, color: colors.text.muted }}>
            Close and reopen the app to reconnect peers. Children will come online as they join the network.
          </div>
        </div>
      );
    }
    return (
      <div style={{ ...typography.body, color: colors.text.primary }}>
        Pick a backup JSON file. This replaces this device's identity, children list, and policies.
        <div style={{ marginTop: `${spacing.md}px`, color: colors.warning || colors.error }}>
          Only works on a fresh install with no existing identity. If you've already set up this device, clear app data first.
        </div>
      </div>
    );
  }

  function renderFooter() {
    if (stage === 'working') return null;
    if (stage === 'done') return <Button onClick={onClose} style={{ flex: 1 }}>Done</Button>;
    if (isExport) {
      return (
        <>
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); onClose(); }} style={{ flex: 1 }}>Cancel</Button>
          <Button icon="Export" onClick={handleExport} style={{ flex: 1 }}>Save backup</Button>
        </>
      );
    }
    return (
      <>
        <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); onClose(); }} style={{ flex: 1 }}>Cancel</Button>
        <Button icon="DownloadSimple" onClick={handleImport} style={{ flex: 1 }}>Import backup</Button>
      </>
    );
  }
}
