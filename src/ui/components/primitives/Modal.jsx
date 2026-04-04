import { useTheme } from '../../theme.js';

export default function Modal({ visible, onClose, title, children, footer }) {
  const { colors, typography, spacing, radius } = useTheme();

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.6)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: `${spacing.xl}px`,
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          backgroundColor: colors.surface.card,
          borderRadius: `${radius.xl}px`,
          padding: `${spacing.xl}px`,
          maxWidth: '360px',
          width: '100%',
          border: `1px solid ${colors.border}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && (
          <div style={{ ...typography.heading, color: colors.text.primary, marginBottom: `${spacing.base}px` }}>
            {title}
          </div>
        )}
        <div style={{ color: colors.text.secondary, ...typography.body }}>
          {children}
        </div>
        {footer && (
          <div style={{ display: 'flex', gap: `${spacing.sm}px`, marginTop: `${spacing.base}px`, justifyContent: 'flex-end' }}>
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
