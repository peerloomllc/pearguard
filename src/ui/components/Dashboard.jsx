import React, { useState, useEffect, useCallback } from 'react';
import ChildCard from './ChildCard.jsx';
import ChildDetail from './ChildDetail.jsx';

export default function Dashboard({ navTrigger, onNavConsumed }) {
  const [children, setChildren] = useState([]);
  const [loading, setLoading] = useState(true);
  const [initialTab, setInitialTab] = useState(null);
  const [selectedChild, setSelectedChild] = useState(null);

  const loadChildren = useCallback(() => {
    window.callBare('children:list')
      .then((list) => {
        setChildren(
          list.map((c) => ({
            ...c,
            bypassAlerts: c.bypassAlerts || 0,
            pendingApprovals: c.pendingApprovals || 0,
            pendingTimeRequests: c.pendingTimeRequests || 0,
            todayScreenTimeSeconds: c.todayScreenTimeSeconds || 0,
            currentApp: c.currentApp || null,
          }))
        );
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  // Navigate to a specific child's tab. Retries up to 2× at 500 ms intervals
  // in case children:list races with worklet initialization on cold/warm start.
  const navigateToChild = useCallback((childPublicKey, tab, attempt) => {
    if (attempt === undefined) attempt = 0;
    window.callBare('children:list').then((list) => {
      const child = list.find((c) => c.publicKey === childPublicKey);
      if (child) {
        setInitialTab(tab || 'alerts');
        setSelectedChild(child);
      } else if (attempt < 2) {
        setTimeout(() => navigateToChild(childPublicKey, tab, attempt + 1), 500);
      }
    }).catch(() => {
      if (attempt < 2) setTimeout(() => navigateToChild(childPublicKey, tab, attempt + 1), 500);
    });
  }, []);

  // Consume navTrigger from ParentApp (notification tap navigation)
  useEffect(() => {
    if (navTrigger && navTrigger.childPublicKey) {
      navigateToChild(navTrigger.childPublicKey, navTrigger.tab);
      onNavConsumed?.();
    }
  }, [navTrigger, navigateToChild, onNavConsumed]);

  useEffect(() => {
    loadChildren();

    // Update screen time + currentApp when a usage report arrives
    const unsubUsage = window.onBareEvent('child:usageReport', ({ childPublicKey, todayScreenTimeSeconds, currentApp }) => {
      setChildren((prev) =>
        prev.map((c) =>
          c.publicKey === childPublicKey
            ? { ...c, todayScreenTimeSeconds, currentApp }
            : c
        )
      );
    });

    // Increment pending time request badge
    const unsubTime = window.onBareEvent('child:timeRequest', ({ childPublicKey }) => {
      setChildren((prev) =>
        prev.map((c) =>
          c.publicKey === childPublicKey
            ? { ...c, pendingTimeRequests: (c.pendingTimeRequests || 0) + 1 }
            : c
        )
      );
    });

    // Increment bypass alert badge
    const unsubBypass = window.onBareEvent('alert:bypass', ({ childPublicKey }) => {
      setChildren((prev) =>
        prev.map((c) =>
          c.publicKey === childPublicKey
            ? { ...c, bypassAlerts: (c.bypassAlerts || 0) + 1 }
            : c
        )
      );
    });

    // Notification tap: navigate directly to a child's tab (tab defaults to 'alerts').
    // Also clears the persistent __pendingAlertsNav marker set by index.tsx.
    const unsubNav = window.onBareEvent('navigate:child:alerts', ({ childPublicKey, tab }) => {
      window.__pendingAlertsNav = null;
      navigateToChild(childPublicKey, tab);
    });

    const unsubUnpaired = window.onBareEvent('child:unpaired', ({ childPublicKey }) => {
      setChildren((prev) => prev.filter((c) => c.publicKey !== childPublicKey));
      setSelectedChild((prev) => (prev?.publicKey === childPublicKey ? null : prev));
      setInitialTab(null);
    });

    return () => {
      unsubUsage();
      unsubTime();
      unsubBypass();
      unsubNav();
      unsubUnpaired();
    };
  }, [loadChildren]);

  if (selectedChild) {
    return (
      <ChildDetail
        child={selectedChild}
        initialTab={initialTab}
        onBack={() => {
          setSelectedChild(null);
          setInitialTab(null);
          loadChildren(); // refresh badges on return
        }}
      />
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.heading}>Dashboard</h2>
      {loading && <p style={styles.msg}>Loading...</p>}
      {!loading && children.length === 0 && (
        <p style={styles.msg}>No children paired yet. Go to the Children tab to add one.</p>
      )}
      {children.map((child) => (
        <ChildCard
          key={child.publicKey}
          child={child}
          onPress={() => setSelectedChild(child)}
        />
      ))}
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  heading: { fontSize: '20px', fontWeight: '700', marginBottom: '16px' },
  msg: { color: '#666', fontSize: '14px' },
};
