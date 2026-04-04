import { useTheme } from '../theme.js';
import Icon from '../icons.js';

export default function TabBar({ tabs, activeTab, onTabChange }) {
  const { colors, typography, spacing } = useTheme();

  return (
    <div
      style={{
        display: 'flex',
        borderTop: `1px solid ${colors.border}`,
        backgroundColor: colors.surface.card,
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      }}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeTab;
        return (
          <button
            key={tab.key}
            onClick={() => {
              window.callBare('haptic:tap');
              onTabChange(tab.key);
            }}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: `${spacing.xs}px`,
              padding: `${spacing.sm}px 0`,
              border: 'none',
              background: 'none',
              cursor: 'pointer',
            }}
          >
            <Icon
              name={tab.icon}
              size={22}
              color={active ? colors.primary : colors.text.muted}
              weight={active ? 'fill' : 'regular'}
            />
            <span style={{
              ...typography.micro,
              color: active ? colors.primary : colors.text.muted,
            }}>
              {tab.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
