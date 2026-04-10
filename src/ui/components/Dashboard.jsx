import React, { useState, useEffect, useCallback, forwardRef, useImperativeHandle, useRef } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Modal from './primitives/Modal.jsx';
import Button from './primitives/Button.jsx';
import ChildCard from './ChildCard.jsx';
import ChildDetail from './ChildDetail.jsx';
import InviteCard from './InviteCard.jsx';
import JoinCoparentCard from './JoinCoparentCard.jsx';

export default forwardRef(function Dashboard(_props, ref) {
  const { colors, typography, spacing, radius } = useTheme();
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedChild, setSelectedChild] = useState(null);
  const [selectedTab, setSelectedTab] = useState(null);
  const [inviteActive, setInviteActive] = useState(false);
  const [joinCoparentActive, setJoinCoparentActive] = useState(false);
  const [lockTarget, setLockTarget] = useState(null);
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
      window.onBareEvent('child:connected', () => { loadChildren(); setInviteActive(false); setJoinCoparentActive(false); }),
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: `${spacing.base}px` }}>
        <h2 style={{ ...typography.heading, color: colors.text.primary, margin: 0 }}>
          Dashboard
        </h2>
        {!inviteActive && !joinCoparentActive && !loading && children.length > 0 && (
          <div style={{ display: 'flex', gap: `${spacing.sm}px`, alignItems: 'center' }}>
            <button
              onClick={() => { window.callBare('haptic:tap'); setJoinCoparentActive(true); }}
              style={{
                background: 'none', border: `1px solid ${colors.primary}`, cursor: 'pointer',
                ...typography.caption, color: colors.primary, fontWeight: '600',
                display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`,
                padding: `${spacing.xs}px ${spacing.sm}px`, borderRadius: `${radius.md}px`,
              }}
            >
              <Icon name="UserPlus" size={14} color={colors.primary} />
              Join as Co-Parent
            </button>
            <button
              onClick={() => { window.callBare('haptic:tap'); setInviteActive(true); }}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                ...typography.body, color: colors.primary, fontWeight: '600',
                display: 'flex', alignItems: 'center', gap: `${spacing.xs}px`,
              }}
            >
              <Icon name="Plus" size={16} color={colors.primary} />
              Add Child
            </button>
          </div>
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
          <Button variant="primary" icon="Plus" onClick={() => setInviteActive(true)}>
            Add Your First Child
          </Button>
        </div>
      )}

      {inviteActive && (
        <InviteCard
          onConnected={() => { setInviteActive(false); loadChildren(); }}
          onDismiss={() => setInviteActive(false)}
        />
      )}

      {joinCoparentActive && (
        <JoinCoparentCard
          onConnected={() => { setJoinCoparentActive(false); loadChildren(); }}
          onDismiss={() => setJoinCoparentActive(false)}
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
