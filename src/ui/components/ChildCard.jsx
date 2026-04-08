import React from 'react';
import { useTheme } from '../theme.js';
import Avatar from './Avatar.jsx';
import Icon from '../icons.js';
import Badge from './primitives/Badge.jsx';

function formatSeconds(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export default function ChildCard({ child, onPress, onLockToggle }) {
  const { colors, typography, spacing, radius, shadow } = useTheme();
  const {
    displayName, isOnline, currentApp, currentAppIcon, todayScreenTimeSeconds,
    bypassAlerts, pendingApprovals, pendingTimeRequests, locked,
  } = child;

  const hasAlerts = bypassAlerts > 0 || pendingApprovals > 0 || pendingTimeRequests > 0;

  let statusText = 'All good';
  let statusColor = colors.success;
  if (pendingApprovals > 0) {
    statusText = `${pendingApprovals} pending approval${pendingApprovals > 1 ? 's' : ''}`;
    statusColor = colors.secondary;
  } else if (bypassAlerts > 0) {
    statusText = `${bypassAlerts} bypass alert${bypassAlerts > 1 ? 's' : ''}`;
    statusColor = colors.error;
  }

  return (
    <button
      style={{
        display: 'block', width: '100%', textAlign: 'left',
        backgroundColor: colors.surface.card,
        border: `1px solid ${colors.border}`,
        borderRadius: `${radius.lg}px`,
        padding: `${spacing.base}px`,
        marginBottom: `${spacing.md}px`,
        cursor: 'pointer',
        boxShadow: shadow,
        position: 'relative',
      }}
      onClick={onPress}
      aria-label={`Open ${displayName}`}
    >
      <div
        style={{ position: 'absolute', top: `${spacing.sm}px`, right: `${spacing.sm}px` }}
        onClick={(e) => { e.stopPropagation(); onLockToggle(); }}
      >
        <Icon
          name={locked ? 'LockSimple' : 'LockSimpleOpen'}
          size={20}
          color={locked ? colors.error : colors.text.muted}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', marginBottom: `${spacing.sm}px` }}>
        <Avatar avatar={child.avatarThumb} name={displayName} size={32} />
        <span style={{
          width: '10px', height: '10px', borderRadius: '50%',
          backgroundColor: isOnline ? colors.success : colors.text.muted,
          marginRight: `${spacing.sm}px`, flexShrink: 0,
        }} />
        <span style={{ ...typography.subheading, color: colors.text.primary, fontWeight: '600', flex: 1 }}>
          {displayName}
        </span>
        {hasAlerts && (
          <div style={{ display: 'flex', gap: `${spacing.xs}px` }}>
            {bypassAlerts > 0 && <Badge color={colors.error}>{bypassAlerts}</Badge>}
            {pendingApprovals > 0 && <Badge color={colors.secondary}>{pendingApprovals}</Badge>}
            {pendingTimeRequests > 0 && <Badge color={colors.primary}>{pendingTimeRequests}</Badge>}
          </div>
        )}
      </div>
      <div style={{ ...typography.caption, color: statusColor, marginBottom: `${spacing.xs}px` }}>
        {statusText}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', ...typography.caption, color: colors.text.secondary }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: `${spacing.xs}px` }}>
          {currentAppIcon && <img src={`data:image/png;base64,${currentAppIcon}`} style={{ width: '16px', height: '16px', borderRadius: '3px' }} />}
          {currentApp || 'No active app'}
        </span>
        <span>{formatSeconds(todayScreenTimeSeconds || 0)} today</span>
      </div>
    </button>
  );
}
