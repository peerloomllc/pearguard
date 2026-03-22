import React, { useState } from 'react';
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
  const active = TABS.find((t) => t.key === activeTab);
  const ActiveComponent = active.Component;

  return (
    <div style={styles.container}>
      <div style={styles.topBar}>
        <button style={styles.backBtn} onClick={onBack} aria-label="Back to Dashboard">
          ← Back
        </button>
        <span style={styles.childName}>{child.displayName}</span>
      </div>

      <div style={styles.tabBar}>
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
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
        <ActiveComponent childPublicKey={child.publicKey} />
      </div>
    </div>
  );
}

const styles = {
  container: { display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: 'sans-serif' },
  topBar: {
    display: 'flex', alignItems: 'center', gap: '12px',
    padding: '12px 16px', borderBottom: '1px solid #ddd', backgroundColor: '#fff',
  },
  backBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: '16px', color: '#1a73e8', padding: '4px 8px',
  },
  childName: { fontSize: '17px', fontWeight: '700' },
  tabBar: {
    display: 'flex', overflowX: 'auto', borderBottom: '1px solid #ddd', backgroundColor: '#fff',
  },
  tabBtn: {
    flex: '0 0 auto', padding: '10px 14px',
    border: 'none', background: 'none', cursor: 'pointer',
    fontSize: '13px', fontWeight: '500', whiteSpace: 'nowrap',
  },
  tabActive: { color: '#1a73e8', borderBottom: '2px solid #1a73e8' },
  tabInactive: { color: '#666' },
  content: { flex: 1, overflowY: 'auto' },
};
