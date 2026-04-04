import { useTheme } from '../../theme.js';

export default function Input({ label, error, style, inputStyle, ...props }) {
  const { colors, typography, spacing, radius } = useTheme();

  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: `${spacing.xs}px`, ...style }}>
      {label && <span style={{ ...typography.caption, color: colors.text.secondary }}>{label}</span>}
      <input
        style={{
          padding: `${spacing.sm + 2}px`,
          backgroundColor: colors.surface.input,
          border: `1px solid ${error ? colors.error : colors.border}`,
          borderRadius: `${radius.md}px`,
          color: colors.text.primary,
          outline: 'none',
          ...typography.body,
          ...inputStyle,
        }}
        {...props}
      />
      {error && <span style={{ ...typography.caption, color: colors.error }}>{error}</span>}
    </label>
  );
}
