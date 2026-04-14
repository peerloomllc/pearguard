import React from 'react';
import Icon from '../../icons.js';

export default function Collapsible({ title, icon, open, onToggle, maxHeight, children, colors, spacing, radius }) {
  return (
    <div style={{
      backgroundColor: colors.surface.elevated,
      borderRadius: `${radius.lg}px`,
      marginBottom: `${spacing.md}px`,
      overflow: 'hidden',
    }}>
      <div
        onClick={() => { window.callBare('haptic:tap'); onToggle(); }}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 16px', cursor: 'pointer',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`, fontSize: '14px', fontWeight: '600', color: colors.text.primary }}>
          {icon && <Icon name={icon} size={18} color={colors.text.secondary} />}
          {title}
        </div>
        <span style={{
          fontSize: '16px', color: colors.text.muted, transition: 'transform 0.3s',
          transform: open ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block',
        }}>&rsaquo;</span>
      </div>
      <div style={{
        maxHeight: open ? maxHeight : '0px', overflow: 'hidden',
        transition: 'max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
      }}>
        <div style={{ padding: '0 16px 14px' }}>
          {children}
        </div>
      </div>
    </div>
  );
}
