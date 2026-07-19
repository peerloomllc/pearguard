import React from 'react';
import { useTheme } from '../theme.js';
import Avatar from './Avatar.jsx';
import Icon from '../icons.js';
import Badge from './primitives/Badge.jsx';

// Shared by the lock icon and the alert badges stacked beneath it, so the two
// can't drift apart and start overlapping again.
const LOCK_ICON_SIZE = 20;

function formatSeconds(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${seconds}s`;
}

export default function ChildCard({ child, onPress, onLockToggle, onGrant, tourId }) {
  const { colors, typography, spacing, radius, shadow } = useTheme();
  const {
    displayName, isOnline, currentApp, currentAppIcon, todayScreenTimeSeconds,
    bypassAlerts, pendingApprovals, pendingTimeRequests, locked, screenTime,
  } = child;

  // Only meaningful once a cap is set; limitSeconds is 0 otherwise (#179).
  const hasBudget = screenTime && screenTime.limitSeconds > 0;
  const timeLeft = hasBudget ? screenTime.remainingSeconds : null;

  const hasAlerts = bypassAlerts > 0 || pendingApprovals > 0 || pendingTimeRequests > 0;
  const isPaused = child.pauseUntil && Date.now() < child.pauseUntil;

  let statusText = 'All good';
  let statusColor = colors.success;
  if (pendingApprovals > 0) {
    statusText = `${pendingApprovals} pending approval${pendingApprovals > 1 ? 's' : ''}`;
    statusColor = colors.secondary;
  } else if (bypassAlerts > 0) {
    statusText = `${bypassAlerts} bypass alert${bypassAlerts > 1 ? 's' : ''}`;
    statusColor = colors.error;
  } else if (isPaused) {
    // Free-time / holiday pause — surface it so a parent sees enforcement is off.
    statusText = 'Free time (protection paused)';
    statusColor = colors.secondary;
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
      data-tour-id={tourId}
    >
      <div style={{
        position: 'absolute', top: `${spacing.sm}px`, right: `${spacing.sm}px`,
        display: 'flex', alignItems: 'center', gap: `${spacing.sm}px`,
      }}>
        {onGrant && (
          <div
            role="button"
            aria-label={`Grant bonus time to ${displayName}`}
            onClick={(e) => { e.stopPropagation(); onGrant(); }}
          >
            <Icon name="Clock" size={LOCK_ICON_SIZE} color={colors.text.muted} />
          </div>
        )}
        <div
          aria-label={locked ? `Unlock ${displayName}` : `Lock ${displayName}`}
          onClick={(e) => { e.stopPropagation(); onLockToggle(); }}
        >
          <Icon
            name={locked ? 'LockSimple' : 'LockSimpleOpen'}
            size={LOCK_ICON_SIZE}
            color={locked ? colors.error : colors.text.muted}
          />
        </div>
      </div>

      {/* Alert badges used to sit at the end of the name row, which put them in the
          same band as the absolutely-positioned lock icon above — the padlock
          overlapped them. Stack them directly BELOW the lock instead, sharing its
          right edge so the two read as one column. */}
      {hasAlerts && (
        <div style={{
          position: 'absolute',
          top: `${spacing.sm + LOCK_ICON_SIZE + spacing.xs}px`,
          right: `${spacing.sm}px`,
          display: 'flex',
          gap: `${spacing.xs}px`,
        }}>
          {bypassAlerts > 0 && <Badge color={colors.error}>{bypassAlerts}</Badge>}
          {pendingApprovals > 0 && <Badge color={colors.secondary}>{pendingApprovals}</Badge>}
          {pendingTimeRequests > 0 && <Badge color={colors.primary}>{pendingTimeRequests}</Badge>}
        </div>
      )}

      {/* paddingRight reserves the top-right icon column (grant clock + lock) so a
          long child name can't slide underneath it now that the badges no longer
          hold that space open. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: `${spacing.md}px`,
        marginBottom: `${spacing.sm}px`,
        paddingRight: `${2 * LOCK_ICON_SIZE + spacing.sm * 2}px`,
      }}>
        <Avatar avatar={child.avatarThumb} name={displayName} size={32} />
        <span style={{
          width: '10px', height: '10px', borderRadius: '50%',
          backgroundColor: isOnline ? colors.success : colors.text.muted,
          flexShrink: 0,
        }} />
        <span style={{
          ...typography.subheading, color: colors.text.primary, fontWeight: '600', flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {displayName}
        </span>
      </div>
      <div style={{
        ...typography.caption, color: statusColor, marginBottom: `${spacing.xs}px`,
        // The badges now live in this band, right-aligned; keep the status text clear.
        paddingRight: hasAlerts ? `${spacing.xl * 2}px` : 0,
      }}>
        {statusText}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', ...typography.caption, color: colors.text.secondary }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: `${spacing.xs}px` }}>
          {currentAppIcon && <img src={`data:image/png;base64,${currentAppIcon}`} style={{ width: '16px', height: '16px', borderRadius: '3px' }} />}
          {currentApp || 'No active app'}
        </span>
        <span>{formatSeconds(todayScreenTimeSeconds || 0)} today</span>
      </div>
      {hasBudget && (
        <div style={{
          display: 'flex', justifyContent: 'space-between', marginTop: `${spacing.xs}px`,
          ...typography.caption,
          color: timeLeft === 0 ? colors.error : colors.text.secondary,
        }}>
          <span>Screen time left</span>
          <span style={{ fontWeight: '600', color: timeLeft === 0 ? colors.error : colors.primary }}>
            {timeLeft === 0 ? 'None left' : formatSeconds(timeLeft)}
            {screenTime.bonusSeconds > 0 ? ` (+${formatSeconds(screenTime.bonusSeconds)} granted)` : ''}
          </span>
        </div>
      )}
    </button>
  );
}
