import React, { useState, useEffect, useCallback, forwardRef, useImperativeHandle, useRef } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';
import Input from './primitives/Input.jsx';
import ChildCard from './ChildCard.jsx';
import ChildDetail from './ChildDetail.jsx';
import InviteCard from './InviteCard.jsx';

export default forwardRef(function Dashboard(_props, ref) {
  const { colors, typography, spacing, radius } = useTheme();
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedChild, setSelectedChild] = useState(null);
  const [selectedTab, setSelectedTab] = useState(null);
  const [inviteActive, setInviteActive] = useState(false);
  const [lockTarget, setLockTarget] = useState(null);
  const [lockMessage, setLockMessage] = useState('');
  const childrenRef = useRef(children);
  childrenRef.current = children;

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

  // Handle notification deep link navigation from window global (set by RN shell)
  useEffect(() => {
    if (children.length === 0) return;
    const nav = window.__pendingAlertsNav;
    if (nav?.childPublicKey) {
      window.__pendingAlertsNav = null;
      const child = children.find((c) => c.publicKey === nav.childPublicKey);
      if (child) {
        setSelectedChild(child);
        setSelectedTab(nav.tab || 'activity');
      }
    }
  }, [children]);

  useEffect(() => {
    if (children.length === 0) return;
    const ss = window.__pearScreenshotOpenChild;
    if (ss?.publicKey) {
      const child = children.find((c) => c.publicKey === ss.publicKey);
      if (child) {
        setSelectedChild(child);
        setSelectedTab(ss.tab || 'activity');
      }
    }
  }, [children]);

  // Handle notification deep link navigation from live events
  useEffect(() => {
    function handleNav(data) {
      const key = data?.childPublicKey;
      if (!key) return;
      const child = childrenRef.current.find((c) => c.publicKey === key);
      if (child) {
        setSelectedChild(child);
        setSelectedTab(data.tab || 'activity');
      } else {
        // Children not loaded yet (cold start) - store for retry in [children] effect
        window.__pendingAlertsNav = { childPublicKey: key, tab: data.tab || 'activity' };
      }
    }
    const unsub1 = window.onBareEvent('navigate:child:alerts', handleNav);
    const unsub2 = window.onBareEvent('navigate:child:requests', handleNav);
    return () => { unsub1(); unsub2(); };
  }, []);

  useEffect(() => {
    const unsubs = [
      window.onBareEvent('usage:report', (data) => {
        setChildren((prev) => prev.map((c) =>
          c.publicKey === data.childPublicKey
            ? { ...c, todayScreenTimeSeconds: data.todayScreenTimeSeconds, currentApp: data.currentApp, currentAppPackage: data.currentAppPackage, currentAppIcon: data.currentAppIcon }
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
      window.onBareEvent('child:connected', (data) => {
        // Add child directly from event data so the card appears immediately.
        // children:list (createReadStream) may not find the record immediately after
        // a brokered co-parent pairing, so we inject from event data and skip loadChildren.
        if (data && data.publicKey) {
          setChildren((prev) => {
            const exists = prev.some((c) => c.publicKey === data.publicKey);
            if (exists) return prev;
            return [...prev, {
              ...data,
              bypassAlerts: 0, pendingApprovals: 0, pendingTimeRequests: 0,
              todayScreenTimeSeconds: 0, currentApp: null, locked: false, isOnline: false,
            }];
          });
        } else {
          loadChildren();
        }
        setInviteActive(false);
              }),
      window.onBareEvent('child:unpaired', (data) => {
        setChildren((prev) => prev.filter((c) => c.publicKey !== data.childPublicKey));
      }),
      window.onBareEvent('peer:connected', (data) => {
        if (!data?.remoteKey) return;
        setChildren((prev) => prev.map((c) =>
          c.noiseKey === data.remoteKey ? { ...c, isOnline: true } : c
        ));
        loadChildren();
      }),
      window.onBareEvent('peer:disconnected', (data) => {
        if (!data?.remoteKey) return;
        setChildren((prev) => prev.map((c) =>
          c.noiseKey === data.remoteKey ? { ...c, isOnline: false } : c
        ));
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
    await window.callBare('policy:setLock', { childPublicKey: lockTarget.publicKey, locked: true, lockMessage });
    setChildren((prev) => prev.map((c) => c.publicKey === lockTarget.publicKey ? { ...c, locked: true } : c));
    setLockTarget(null);
    setLockMessage('');
  }

  // Android back gesture: close child detail view
  const backHandler = useCallback(() => {
    if (selectedChild) {
      setSelectedChild(null);
      setSelectedTab(null);
      loadChildren();
      return true;
    }
    return false;
  }, [selectedChild]);

  useEffect(() => {
    window.__registerBackHandler?.(backHandler);
    return () => window.__unregisterBackHandler?.(backHandler);
  }, [backHandler]);

  if (selectedChild) {
    return (
      <ChildDetail
        child={selectedChild}
        initialTab={selectedTab}
        onBack={() => { setSelectedChild(null); setSelectedTab(null); loadChildren(); }}
      />
    );
  }

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: `${spacing.base}px` }}>
        <h2 style={{ ...typography.heading, color: colors.text.primary, margin: 0, textAlign: 'center' }}>
          Dashboard
        </h2>
        {!inviteActive && !loading && children.length > 0 && (
          <button
            onClick={() => { window.callBare('haptic:tap'); setInviteActive(true); }}
            style={{
              position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', cursor: 'pointer',
              ...typography.body, color: colors.primary, fontWeight: '600',
              display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`,
            }}
          >
            <Icon name="Plus" size={16} color={colors.primary} />
            Add Child
          </button>
        )}
      </div>

      {loading && <p style={{ ...typography.body, color: colors.text.secondary }}>Loading...</p>}

      {!loading && children.length === 0 && !inviteActive && (
        <div style={{ textAlign: 'center', padding: `${spacing.xxxl}px ${spacing.base}px` }}>
          <Icon name="Users" size={48} color={colors.text.muted} />
          <p style={{ ...typography.body, color: colors.text.secondary, marginTop: `${spacing.md}px` }}>
            Welcome to PearGuard
          </p>
          <p style={{ ...typography.caption, color: colors.text.muted, marginBottom: `${spacing.xl}px` }}>
            Add your first child to get started
          </p>
          <Button variant="primary" icon="Plus" onClick={() => setInviteActive(true)} style={{ width: '220px' }}>
            Add Child
          </Button>
        </div>
      )}

      {inviteActive && (
        <InviteCard
          onConnected={() => { setInviteActive(false); loadChildren(); }}
          onDismiss={() => setInviteActive(false)}
        />
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
        onClose={() => { setLockTarget(null); setLockMessage(''); }}
        title={`Lock ${lockTarget?.displayName}'s device?`}
        footer={<>
          <Button variant="secondary" onClick={() => { window.callBare('haptic:tap'); setLockTarget(null); setLockMessage(''); }} style={{ flex: 1 }}>Cancel</Button>
          <Button variant="danger" icon="LockSimple" onClick={() => { window.callBare('haptic:tap'); confirmLock(); }} style={{ flex: 1 }}>Lock</Button>
        </>}
      >
        <div style={{ textAlign: 'center', marginBottom: `${spacing.md}px` }}>
          This will immediately block all apps on {lockTarget?.displayName}'s device until you unlock it.
        </div>
        <Input
          label="Message (optional)"
          placeholder="Shown to your child on the block screen"
          value={lockMessage}
          onChange={(e) => setLockMessage(e.target.value.slice(0, 280))}
          maxLength={280}
        />
      </Modal>
    </div>
  );
});
