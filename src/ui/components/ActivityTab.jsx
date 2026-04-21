import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Card from './primitives/Card.jsx';
import Button from './primitives/Button.jsx';
import Badge from './primitives/Badge.jsx';

const TYPE_META = {
  bypass:          { label: 'Bypass Attempt',  icon: 'Warning' },
  pin_use:         { label: 'PIN Used',         icon: 'LockSimpleOpen' },
  time_request:    { label: 'Time Request',     icon: 'Clock' },
  app_installed:   { label: 'App Installed',    icon: 'Plus' },
  app_uninstalled: { label: 'App Uninstalled',  icon: 'Trash' },
  pin_override:    { label: 'PIN Override',     icon: 'LockSimpleOpen' },
};

function typeColor(type, colors) {
  if (type === 'bypass' || type === 'app_uninstalled') return colors.error;
  if (type === 'time_request' || type === 'pin_use' || type === 'pin_override') return colors.secondary;
  if (type === 'app_installed') return colors.success;
  return colors.text.muted;
}

function formatTime(ts) {
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

function formatSeconds(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function PendingRequestCard({ req, childPublicKey, onResolved }) {
  const { colors, typography, spacing } = useTheme();
  const [acting, setActing] = useState(false);

  const isExtraTime = req.requestType === 'extra_time';

  async function handleApprove() {
    setActing(true);
    try {
      if (isExtraTime) {
        await window.callBare('time:grant', {
          childPublicKey,
          requestId: req.id,
          packageName: req.packageName,
          extraSeconds: req.extraSeconds || 1800,
        });
      } else {
        await window.callBare('app:decide', { childPublicKey, packageName: req.packageName, decision: 'approve' });
      }
      onResolved();
    } catch (e) {
      console.error('approve failed:', e);
    } finally {
      setActing(false);
    }
  }

  async function handleDeny() {
    setActing(true);
    try {
      if (isExtraTime) {
        await window.callBare('time:deny', {
          childPublicKey,
          requestId: req.id,
          packageName: req.packageName,
          appName: req.appDisplayName || req.packageName,
        });
      } else {
        await window.callBare('app:decide', { childPublicKey, packageName: req.packageName, decision: 'deny' });
      }
      onResolved();
    } catch (e) {
      console.error('deny failed:', e);
    } finally {
      setActing(false);
    }
  }

  function approveLabel() {
    if (!isExtraTime) return 'Approve';
    if (!req.extraSeconds) return 'Grant Time';
    const mins = req.extraSeconds / 60;
    return mins >= 60 ? `Grant ${mins / 60}h` : `Grant ${mins}m`;
  }

  const badgeColor = typeColor(req.type, colors);
  const meta = TYPE_META[req.type] || { label: req.type, icon: 'Clock' };

  return (
    <Card style={{ marginBottom: `${spacing.sm}px` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: `${spacing.sm}px` }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...typography.body, color: colors.text.primary, fontWeight: '600', marginBottom: '4px' }}>
            {req.appDisplayName || req.packageName || 'Unknown app'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <Badge color={badgeColor}>{meta.label}</Badge>
            {isExtraTime && req.requestedSeconds
              ? <span style={{ ...typography.caption, color: colors.text.secondary }}>
                  requesting {formatSeconds(req.requestedSeconds)}
                </span>
              : null}
          </div>
          <div style={{ ...typography.micro, color: colors.text.muted }}>{formatTime(req.timestamp)}</div>
        </div>
        <div style={{ display: 'flex', gap: `${spacing.sm}px`, flexShrink: 0, paddingTop: '2px' }}>
          <Button
            variant="primary"
            disabled={acting}
            onClick={handleApprove}
            aria-label={`Approve request for ${req.packageName}`}
          >
            {approveLabel()}
          </Button>
          <Button
            variant="danger"
            disabled={acting}
            onClick={handleDeny}
            aria-label={`Deny request for ${req.packageName}`}
          >
            Deny
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ActivityRow({ item }) {
  const { colors, typography, spacing } = useTheme();

  const meta = TYPE_META[item.type] || { label: item.type, icon: 'Bell' };
  const iconColor = typeColor(item.type, colors);

  return (
    <div style={{
      display: 'flex',
      alignItems: 'flex-start',
      gap: `${spacing.sm}px`,
      padding: `${spacing.sm}px 0`,
      borderBottom: `1px solid ${colors.divider}`,
    }}>
      <div style={{ paddingTop: '2px', flexShrink: 0 }}>
        <Icon name={meta.icon} size={18} color={iconColor} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', marginBottom: '2px' }}>
          <Badge color={iconColor}>{meta.label}</Badge>
          <span style={{ ...typography.body, color: colors.text.primary }}>
            {item.appDisplayName || item.packageName || 'Unknown app'}
          </span>
          {item.type === 'time_request' && item.requestedSeconds
            ? <span style={{ ...typography.caption, color: colors.text.secondary }}>
                requested {formatSeconds(item.requestedSeconds)}
              </span>
            : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: `${spacing.sm}px` }}>
          <span style={{ ...typography.micro, color: colors.text.muted }}>{formatTime(item.timestamp)}</span>
          {item.type === 'time_request' && item.resolved
            ? <span style={{ ...typography.micro, color: colors.text.muted, fontStyle: 'italic' }}>
                {item.status === 'approved' ? 'Approved' : item.status === 'denied' ? 'Denied' : 'Resolved'}
              </span>
            : null}
        </div>
      </div>
    </div>
  );
}

export default function ActivityTab({ childPublicKey }) {
  const { colors, typography, spacing } = useTheme();
  const [allAlerts, setAllAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  function reload() {
    window.callBare('alerts:list', { childPublicKey })
      .then((list) => { setAllAlerts(list || []); setLoading(false); })
      .catch(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    const unsubBypass      = window.onBareEvent('alert:bypass',          reload);
    const unsubRequest     = window.onBareEvent('time:request:received', reload);
    const unsubInstalled   = window.onBareEvent('app:installed',         reload);
    const unsubUninstalled = window.onBareEvent('app:uninstalled',       reload);
    const unsubUpdated     = window.onBareEvent('request:updated',       reload);
    return () => { unsubBypass(); unsubRequest(); unsubInstalled(); unsubUninstalled(); unsubUpdated(); };
  }, [childPublicKey]);

  const pendingRequests = allAlerts.filter(
    (a) => a.type === 'time_request' && !a.resolved,
  );
  const history = allAlerts.filter(
    (a) => !(a.type === 'time_request' && !a.resolved),
  );

  if (loading) {
    return (
      <div style={{ padding: `${spacing.base}px`, ...typography.body, color: colors.text.muted }}>
        Loading activity...
      </div>
    );
  }

  return (
    <div style={{ padding: `${spacing.base}px` }}>
      {pendingRequests.length > 0 && (
        <div style={{ marginBottom: `${spacing.lg}px` }}>
          <div style={{ ...typography.subheading, color: colors.text.primary, marginBottom: `${spacing.sm}px` }}>
            Pending Requests
          </div>
          {pendingRequests.map((req) => (
            <PendingRequestCard
              key={req.id}
              req={req}
              childPublicKey={childPublicKey}
              onResolved={reload}
            />
          ))}
        </div>
      )}

      <div>
        <div style={{ ...typography.subheading, color: colors.text.primary, marginBottom: `${spacing.sm}px`, textAlign: 'center' }}>
          Activity Log
        </div>
        {history.length === 0 ? (
          <div style={{ ...typography.body, color: colors.text.muted, textAlign: 'center' }}>No activity yet.</div>
        ) : (
          history.map((item) => (
            <ActivityRow key={item.id} item={item} />
          ))
        )}
      </div>
    </div>
  );
}
