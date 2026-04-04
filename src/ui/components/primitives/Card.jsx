import { useTheme } from '../../theme.js';

export default function Card({ children, title, action, style, ...props }) {
  const { colors, typography, spacing, radius, shadow } = useTheme();

  return (
    <div
      style={{
        backgroundColor: colors.surface.card,
        border: `1px solid ${colors.border}`,
        borderRadius: `${radius.lg}px`,
        padding: `${spacing.md}px`,
        boxShadow: shadow,
        ...style,
      }}
      {...props}
    >
      {(title || action) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: `${spacing.sm}px` }}>
          {title && <div style={{ ...typography.subheading, color: colors.text.primary }}>{title}</div>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
