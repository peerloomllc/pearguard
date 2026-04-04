import { useTheme } from '../theme.js';
import Icon from '../icons.js';

export default function FAB({ icon = 'Plus', onPress, style }) {
  const { colors, spacing } = useTheme();

  return (
    <button
      onClick={() => {
        window.callBare('haptic:tap');
        onPress();
      }}
      style={{
        position: 'fixed',
        bottom: `${56 + spacing.base}px`,
        right: `${spacing.base}px`,
        width: '56px',
        height: '56px',
        borderRadius: '50%',
        border: 'none',
        backgroundColor: colors.primary,
        boxShadow: '0 4px 12px rgba(76,175,80,0.4)',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 50,
        ...style,
      }}
    >
      <Icon name={icon} size={24} color="#FFFFFF" />
    </button>
  );
}
