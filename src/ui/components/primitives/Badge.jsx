import { useTheme } from '../../theme.js';

export default function Badge({ children, color, style }) {
  const { typography, spacing, radius } = useTheme();

  if (!children) return null;

  return (
    <span
      style={{
        display: 'inline-block',
        ...typography.micro,
        color: '#FFFFFF',
        backgroundColor: color,
        borderRadius: `${radius.full}px`,
        padding: `2px ${spacing.sm - 1}px`,
        minWidth: '20px',
        textAlign: 'center',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
