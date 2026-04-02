import React, { useState, useEffect, useCallback } from 'react';
import Avatar from './Avatar.jsx';
import UsageTab from './UsageTab.jsx';
import AppsTab from './AppsTab.jsx';
import ScheduleTab from './ScheduleTab.jsx';
import ContactsTab from './ContactsTab.jsx';
import AlertsTab from './AlertsTab.jsx';
import RequestsTab from './RequestsTab.jsx';

const TABS = [
  { key: 'usage', label: 'Usage', Component: UsageTab },
  { key: 'apps', label: 'Apps', Component: AppsTab },
  { key: 'requests', label: 'Requests', Component: RequestsTab },
  { key: 'schedule', label: 'Schedule', Component: ScheduleTab },
  { key: 'contacts', label: 'Contacts', Component: ContactsTab },
  { key: 'alerts', label: 'Activity', Component: AlertsTab },
];

export default function ChildDetail({ child, onBack, initialTab }) {
  const [activeTab, setActiveTab] = useState(initialTab || 'usage');
  const [confirming, setConfirming] = useState(false);

  // Respond to initialTab prop changes (e.g. notification tap while already viewing a child)
  useEffect(() => {
    if (initialTab && initialTab !== activeTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);
  const active = TABS.find((t) => t.key === activeTab);
  const ActiveComponent = active.Component;

  const handleRemove = useCallback(() => {
    window.callBare('child:unpair', { childPublicKey: child.publicKey })
      .catch((e) => console.warn('[ChildDetail] child:unpair failed:', e))
      .finally(() => onBack());
  }, [child.publicKey, onBack]);

  return (
    <div style={styles.container}>
      <div style={styles.topBar}>
        <button style={styles.backBtn} onClick={onBack} aria-label="Back to Dashboard">
          ← Back
        </button>
        <Avatar avatar={child.avatarThumb} name={child.displayName} size={28} />
        <span style={styles.childName}>{child.displayName}</span>
        {!confirming ? (
          <button style={styles.removeBtn} onClick={() => setConfirming(true)}>Remove</button>
        ) : (
          <span style={styles.confirmRow}>
            <span style={styles.confirmText}>Remove {child.displayName}?</span>
            <button style={styles.confirmYes} onClick={handleRemove}>Yes, remove</button>
            <button style={styles.confirmNo} onClick={() => setConfirming(false)}>Cancel</button>
          </span>
        )}
      </div>

      <div style={styles.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => { navigator.vibrate(30); setActiveTab(tab.key); }}
            style={{
              ...styles.tabBtn,
              ...(activeTab === tab.key ? styles.tabActive : styles.tabInactive),
            }}
            aria-selected={activeTab === tab.key}
            role="tab"
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div style={styles.content}>
        {TABS.map((tab) => (
          <div key={tab.key} style={{ display: activeTab === tab.key ? 'block' : 'none' }}>
            <tab.Component childPublicKey={child.publicKey} />
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' },
  topBar: {
    display: 'flex', alignItems: 'center', gap: '12px',
    padding: '12px 16px', borderBottom: '1px solid #ddd', backgroundColor: '#fff',
    flexWrap: 'wrap',
  },
  backBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: '16px', color: '#1a73e8', padding: '4px 8px',
  },
  childName: { fontSize: '17px', fontWeight: '700', flex: 1 },
  removeBtn: {
    background: 'none', border: '1px solid #ea4335', borderRadius: '6px',
    color: '#ea4335', cursor: 'pointer', fontSize: '13px', padding: '4px 10px',
  },
  confirmRow: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
  confirmText: { fontSize: '13px', color: '#333' },
  confirmYes: {
    background: '#ea4335', border: 'none', borderRadius: '6px',
    color: '#fff', cursor: 'pointer', fontSize: '13px', padding: '4px 10px',
  },
  confirmNo: {
    background: 'none', border: '1px solid #aaa', borderRadius: '6px',
    color: '#555', cursor: 'pointer', fontSize: '13px', padding: '4px 10px',
  },
  tabBar: {
    display: 'flex', overflowX: 'auto', borderBottom: '1px solid #ddd', backgroundColor: '#fff',
  },
  tabBtn: {
    flex: '0 0 auto', padding: '10px 14px',
    border: 'none', background: 'none', cursor: 'pointer',
    fontSize: '13px', fontWeight: '500', whiteSpace: 'nowrap',
  },
  tabActive: { color: '#1a73e8', borderBottom: '2px solid #1a73e8' },
  tabInactive: { color: '#666', borderBottom: '2px solid transparent' },
  content: { flex: 1, overflowY: 'auto' },
};
