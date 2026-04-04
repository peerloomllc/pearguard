import { useTheme } from '../../theme.js';
import Icon from '../../icons.js';

export default function Button({ children, variant = 'primary', icon, disabled, style, ...props }) {
  const { colors, typography, spacing, radius } = useTheme();

  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: `${spacing.sm}px`,
    padding: `${spacing.sm}px ${spacing.md}px`,
    border: 'none',
    borderRadius: `${radius.md}px`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    ...typography.body,
    fontWeight: '600',
    transition: 'opacity 0.15s',
    opacity: disabled ? 0.5 : 1,
  };

  const variants = {
    primary: { backgroundColor: colors.primary, color: '#FFFFFF' },
    secondary: { backgroundColor: 'transparent', border: `1px solid ${colors.primary}`, color: colors.primary },
    danger: { backgroundColor: colors.error, color: '#FFFFFF' },
  };

  return (
    <button style={{ ...base, ...variants[variant], ...style }} disabled={disabled} {...props}>
      {icon && <Icon name={icon} size={16} color={variant === 'secondary' ? colors.primary : '#FFFFFF'} />}
      {children}
    </button>
  );
}
