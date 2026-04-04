import React from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';

export default function LockOverlay({ parentName }) {
  const { colors, typography, spacing } = useTheme();

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: colors.surface.base,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      zIndex: 200,
    }}>
      <Icon name="LockSimple" size={64} color={colors.error} />
      <h2 style={{ ...typography.heading, color: colors.text.primary, marginTop: `${spacing.xl}px` }}>
        Device locked{parentName ? ` by ${parentName}` : ''}
      </h2>
      <p style={{ ...typography.body, color: colors.text.secondary, marginTop: `${spacing.sm}px` }}>
        Contact your parent to unlock
      </p>
    </div>
  );
}
