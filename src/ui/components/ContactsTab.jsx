import React, { useState, useEffect, useCallback } from 'react';

export default function ContactsTab({ childPublicKey }) {
  const [policy, setPolicy] = useState(null);
  const [loading, setLoading] = useState(true);
  const [picking, setPicking] = useState(false);

  const loadPolicy = useCallback(() => {
    window.callBare('policy:get', { childPublicKey })
      .then((p) => { setPolicy(p); setLoading(false); })
      .catch(() => setLoading(false));
  }, [childPublicKey]);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  function saveContacts(contacts) {
    const updated = { ...policy, allowedContacts: contacts };
    setPolicy(updated);
    window.callBare('policy:update', { childPublicKey, policy: updated });
  }

  function handleRemove(index) {
    const contacts = policy.allowedContacts.filter((_, i) => i !== index);
    saveContacts(contacts);
  }

  async function handleAddContact() {
    setPicking(true);
    try {
      const contact = await window.callBare('contacts:pick');
      if (contact && contact.phone) {
        const contacts = [...(policy.allowedContacts || []), contact];
        saveContacts(contacts);
      }
    } catch (e) {
      // User cancelled picker or permission denied — silently ignore
    } finally {
      setPicking(false);
    }
  }

  if (loading) return <div style={styles.msg}>Loading contacts...</div>;

  const contacts = (policy && policy.allowedContacts) || [];

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h3 style={styles.heading}>Allowed Contacts</h3>
        <button
          style={styles.addBtn}
          onClick={handleAddContact}
          disabled={picking}
          aria-label="Add contact"
        >
          {picking ? 'Picking...' : '+ Add Contact'}
        </button>
      </div>
      <p style={styles.hint}>
        These contacts can call and message the child even when the phone app is blocked.
      </p>
      {contacts.length === 0 && <p style={styles.empty}>No contacts added yet.</p>}
      {contacts.map((contact, i) => (
        <div key={i} style={styles.contactRow}>
          <div style={styles.contactInfo}>
            <span style={styles.contactName}>{contact.name}</span>
            <span style={styles.contactPhone}>{contact.phone}</span>
          </div>
          <button
            style={styles.removeBtn}
            onClick={() => handleRemove(i)}
            aria-label={`Remove ${contact.name}`}
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

const styles = {
  container: { padding: '16px' },
  msg: { padding: '16px', color: '#666', fontSize: '14px' },
  header: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' },
  heading: { fontSize: '16px', fontWeight: '700', margin: 0 },
  addBtn: {
    padding: '8px 14px', border: 'none', borderRadius: '6px',
    backgroundColor: '#1a73e8', color: '#fff', cursor: 'pointer', fontSize: '13px',
  },
  hint: { fontSize: '12px', color: '#888', marginBottom: '16px' },
  empty: { color: '#888', fontSize: '14px' },
  contactRow: {
    display: 'flex', alignItems: 'center', gap: '8px',
    padding: '10px 0', borderBottom: '1px solid #eee',
  },
  contactInfo: { flex: 1, display: 'flex', flexDirection: 'column' },
  contactName: { fontSize: '14px', fontWeight: '500' },
  contactPhone: { fontSize: '12px', color: '#666' },
  removeBtn: {
    padding: '5px 12px', border: '1px solid #ea4335', borderRadius: '6px',
    color: '#ea4335', background: '#fff', cursor: 'pointer', fontSize: '12px',
  },
};
