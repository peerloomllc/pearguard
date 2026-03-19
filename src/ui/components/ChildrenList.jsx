import React, { useState, useEffect } from 'react';
import AddChildFlow from './AddChildFlow.jsx';

export default function ChildrenList() {
  const [children, setChildren] = useState([]);
  const [showAdd, setShowAdd] = useState(false);

  useEffect(() => {
    window.callBare('children:list').then(setChildren).catch(() => {});
  }, []);

  function handleChildConnected(data) {
    setShowAdd(false);
    // Refresh list
    window.callBare('children:list').then(setChildren).catch(() => {});
  }

  if (showAdd) {
    return (
      <AddChildFlow
        onConnected={handleChildConnected}
        onCancel={() => setShowAdd(false)}
      />
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h2 style={styles.heading}>Children</h2>
        <button style={styles.addBtn} onClick={() => setShowAdd(true)}>
          + Add Child
        </button>
      </div>
      {children.length === 0 && (
        <p style={styles.empty}>No children paired yet.</p>
      )}
      {children.map((child) => (
        <div key={child.publicKey} style={styles.row}>
          <span style={{
            ...styles.dot,
            backgroundColor: child.isOnline ? '#34a853' : '#bbb',
          }} />
          <span style={styles.name}>{child.displayName}</span>
          <span style={styles.lastSeen}>
            {child.isOnline ? 'Online' : child.lastSeen ? `Last seen: ${new Date(child.lastSeen).toLocaleString()}` : 'Never connected'}
          </span>
        </div>
      ))}
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' },
  heading: { fontSize: '20px', fontWeight: '700', margin: 0 },
  addBtn: {
    padding: '8px 16px',
    backgroundColor: '#1a73e8',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  empty: { color: '#888', fontSize: '14px' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '12px 0',
    borderBottom: '1px solid #eee',
  },
  dot: { width: '10px', height: '10px', borderRadius: '50%', flexShrink: 0 },
  name: { fontSize: '15px', fontWeight: '500', flex: 1 },
  lastSeen: { fontSize: '12px', color: '#888' },
};
