import React, { useState, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';
import ChildCard from './ChildCard.jsx';
import ChildDetail from './ChildDetail.jsx';
import AddChildFlow from './AddChildFlow.jsx';

export default forwardRef(function Dashboard(props, ref) {
  const { colors, typography, spacing } = useTheme();
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedChild, setSelectedChild] = useState(null);
  const [selectedTab, setSelectedTab] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [lockTarget, setLockTarget] = useState(null);

  function loadChildren() {
    window.callBare('children:list')
      .then((list) => {
        setChildren((list || []).map((c) => ({
          ...c,
          bypassAlerts: c.bypassAlerts || 0,
          pendingApprovals: c.pendingApprovals || 0,
          pendingTimeRequests: c.pendingTimeRequests || 0,
          todayScreenTimeSeconds: c.todayScreenTimeSeconds || 0,
          currentApp: c.currentApp || null,
          locked: c.locked || false,
        })));
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }

  useEffect(() => { loadChildren(); }, []);

  useEffect(() => {
    const unsubs = [
      window.onBareEvent('child:usageReport', (data) => {
        setChildren((prev) => prev.map((c) =>
          c.publicKey === data.childPublicKey
            ? { ...c, todayScreenTimeSeconds: data.todayScreenTimeSeconds, currentApp: data.currentApp }
            : c
        ));
      }),
      window.onBareEvent('child:timeRequest', (data) => {
        setChildren((prev) => prev.map((c) =>
          c.publicKey === data.childPublicKey ? { ...c, pendingTimeRequests: c.pendingTimeRequests + 1 } : c
        ));
      }),
      window.onBareEvent('alert:bypass', (data) => {
        setChildren((prev) => prev.map((c) =>
          c.publicKey === data.childPublicKey ? { ...c, bypassAlerts: c.bypassAlerts + 1 } : c
        ));
      }),
      window.onBareEvent('child:connected', () => { loadChildren(); setShowAdd(false); }),
      window.onBareEvent('child:unpaired', (data) => {
        setChildren((prev) => prev.filter((c) => c.publicKey !== data.childPublicKey));
      }),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const navigateToChild = useCallback((publicKey, tab) => {
    const child = children.find((c) => c.publicKey === publicKey);
    if (child) {
      setSelectedChild(child);
      if (tab) setSelectedTab(tab);
    }
  }, [children]);

  useImperativeHandle(ref, () => ({
    navigateToChild,
    showAddChild: () => setShowAdd(true),
  }));

  async function handleLockToggle(child) {
    if (child.locked) {
      await window.callBare('policy:setLock', { childPublicKey: child.publicKey, locked: false });
      setChildren((prev) => prev.map((c) => c.publicKey === child.publicKey ? { ...c, locked: false } : c));
    } else {
      setLockTarget(child);
    }
  }

  async function confirmLock() {
    if (!lockTarget) return;
    await window.callBare('policy:setLock', { childPublicKey: lockTarget.publicKey, locked: true });
    setChildren((prev) => prev.map((c) => c.publicKey === lockTarget.publicKey ? { ...c, locked: true } : c));
    setLockTarget(null);
  }

  if (selectedChild) {
    return (
      <ChildDetail
        child={selectedChild}
        initialTab={selectedTab}
        onBack={() => { setSelectedChild(null); setSelectedTab(null); loadChildren(); }}
      />
    );
  }

  if (showAdd) {
    return <AddChildFlow onConnected={() => { setShowAdd(false); loadChildren(); }} onCancel={() => setShowAdd(false)} />;
  }

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <h2 style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.base}px` }}>
        Dashboard
      </h2>

      {loading && <p style={{ ...typography.body, color: colors.text.secondary }}>Loading...</p>}

      {!loading && children.length === 0 && (
        <div style={{ textAlign: 'center', padding: `${spacing.xxxl}px ${spacing.base}px` }}>
          <Icon name="User" size={48} color={colors.text.muted} />
          <p style={{ ...typography.body, color: colors.text.secondary, marginTop: `${spacing.md}px` }}>
            No children added yet
          </p>
          <p style={{ ...typography.caption, color: colors.text.muted }}>
            Tap the + button to add your first child
          </p>
        </div>
      )}

      {children.map((child) => (
        <ChildCard
          key={child.publicKey}
          child={child}
          onPress={() => navigateToChild(child.publicKey)}
          onLockToggle={() => handleLockToggle(child)}
        />
      ))}

      <Modal
        visible={!!lockTarget}
        onClose={() => setLockTarget(null)}
        title={`Lock ${lockTarget?.displayName}'s device?`}
        footer={<>
          <Button variant="secondary" onClick={() => setLockTarget(null)}>Cancel</Button>
          <Button variant="primary" icon="LockSimple" onClick={confirmLock}>Lock</Button>
        </>}
      >
        All apps will be blocked until you unlock.
      </Modal>
    </div>
  );
});
