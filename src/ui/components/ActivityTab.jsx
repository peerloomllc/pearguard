import React, { useState, useEffect } from 'react';
import { useTheme } from '../theme.js';
import Icon from '../icons.js';
import Card from './primitives/Card.jsx';
import Button from './primitives/Button.jsx';
import Badge from './primitives/Badge.jsx';

const TYPE_META = {
  bypass:          { label: 'Bypass Attempt',  icon: 'Warning' },
  // Enforcement is off, but the child did not do it (an extension that failed to
  // load, an unsupported compositor). Same urgency, no accusation - badging these
  // as a "Bypass Attempt" in red told parents their kid defeated protection when
  // PearGuard had simply failed. See src/bypass-reasons.js.
  enforcement_off: { label: 'Protection Off',   icon: 'Warning' },
  pin_use:         { label: 'PIN Used',         icon: 'LockSimpleOpen' },
  time_request:    { label: 'Time Request',     icon: 'Clock' },
  app_installed:   { label: 'App Installed',    icon: 'Plus' },
  app_uninstalled: { label: 'App Uninstalled',  icon: 'Trash' },
  pin_override:    { label: 'PIN Override',     icon: 'LockSimpleOpen' },
  pin_failure:     { label: 'PIN Guessing',     icon: 'Warning' },
};

function typeColor(type, colors) {
  // Amber, not red: the parent must still act, but nobody is being accused.
  if (type === 'enforcement_off') return colors.secondary;
  if (type === 'bypass' || type === 'app_uninstalled' || type === 'pin_failure') return colors.error;
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

  // General time tops up the whole daily budget; extra time overrides one app.
  const isGeneralTime = req.requestType === 'general_time';
  const isExtraTime = req.requestType === 'extra_time' || isGeneralTime;

  async function handleApprove() {
    setActing(true);
    try {
      if (isGeneralTime) {
        await window.callBare('time:grantGeneral', {
          childPublicKey,
          requestId: req.id,
          extraSeconds: req.extraSeconds || 1800,
        });
      } else if (isExtraTime) {
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

  // A general-time request is about the whole day's budget, so lead with that
  // and demote the app that happened to trigger it to context.
  const appLabel = req.appDisplayName || req.packageName || 'Unknown app';
  const title = isGeneralTime ? 'More screen time' : appLabel;
  // Requests raised from the child's home screen carry no real app, just the
  // 'general' sentinel — there is no "blocked while opening X" to show.
  const triggeredBy = isGeneralTime && req.packageName !== 'general' ? appLabel : null;

  const badgeColor = typeColor(req.type, colors);
  const meta = TYPE_META[req.type] || { label: req.type, icon: 'Clock' };

  return (
    <Card style={{ marginBottom: `${spacing.sm}px` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: `${spacing.sm}px` }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...typography.body, color: colors.text.primary, fontWeight: '600', marginBottom: '4px' }}>
            {title}
          </div>
          {triggeredBy && (
            <div style={{ ...typography.caption, color: colors.text.secondary, marginBottom: '4px' }}>
              blocked while opening {triggeredBy}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
            <Badge color={badgeColor}>{meta.label}</Badge>
            {isExtraTime && (req.requestedSeconds || req.extraSeconds)
              ? <span style={{ ...typography.caption, color: colors.text.secondary }}>
                  requesting {formatSeconds(req.requestedSeconds || req.extraSeconds)}
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

// A time_request row is a record of a request the child made, and the parent's
// answer to it lives on the child. Dismissing history is fine; making a request
// disappear from the parent's side is not, so only alert rows get an X.
function isDismissible(item) {
  return item.type !== 'time_request';
}

function ActivityRow({ item, onDismiss }) {
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
          {item.type === 'pin_failure' && item.failCount
            ? <span style={{ ...typography.caption, color: colors.text.secondary }}>
                {item.failCount} wrong attempts
                {item.lockoutMs ? ', locked ' + Math.max(1, Math.round(item.lockoutMs / 60000)) + ' min' : ''}
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
      {isDismissible(item) && (
        <button
          onClick={() => onDismiss(item)}
          aria-label={`Dismiss ${meta.label}`}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: `0 ${spacing.xs}px`, flexShrink: 0, lineHeight: 1,
          }}
        >
          <Icon name="X" size={14} color={colors.text.muted} />
        </button>
      )}
    </div>
  );
}

export default function ActivityTab({ childPublicKey }) {
  const { colors, typography, spacing } = useTheme();
  const [allAlerts, setAllAlerts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [clearing, setClearing] = useState(false);

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
    const unsubOverride    = window.onBareEvent('alert:pin_override',    reload);
    const unsubFailure     = window.onBareEvent('alert:pin_failure',     reload);
    return () => { unsubBypass(); unsubRequest(); unsubInstalled(); unsubUninstalled(); unsubUpdated(); unsubOverride(); unsubFailure(); };
  }, [childPublicKey]);

  function handleDismiss(item) {
    window.callBare('haptic:tap');
    // Drop it from the list immediately; a failed delete just reappears on the
    // next reload rather than leaving the row in a wedged half-dismissed state.
    setAllAlerts((prev) => prev.filter((a) => a !== item));
    window.callBare('alerts:dismiss', { childPublicKey, timestamp: item.timestamp })
      .catch((e) => { console.error('[ActivityTab] dismiss failed:', e); reload(); });
  }

  function handleClearAll() {
    window.callBare('haptic:tap');
    setClearing(false);
    window.callBare('alerts:clear', { childPublicKey })
      .then(reload)
      .catch((e) => { console.error('[ActivityTab] clear failed:', e); reload(); });
  }

  const pendingRequests = allAlerts.filter(
    (a) => a.type === 'time_request' && !a.resolved,
  );
  const history = allAlerts.filter(
    (a) => !(a.type === 'time_request' && !a.resolved),
  );
  // Clearing only removes alert rows, so only offer it when there are some.
  const clearableCount = history.filter(isDismissible).length;

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
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: `${spacing.sm}px`, marginBottom: `${spacing.sm}px`,
        }}>
          {/* Spacer keeps the title optically centred against the button. */}
          <div style={{ width: '60px', flexShrink: 0 }} />
          <div style={{ ...typography.subheading, color: colors.text.primary, textAlign: 'center' }}>
            Activity Log
          </div>
          <div style={{ width: '60px', flexShrink: 0, textAlign: 'right' }}>
            {clearableCount > 0 && !clearing && (
              <button
                onClick={() => { window.callBare('haptic:tap'); setClearing(true); }}
                aria-label="Clear activity log"
                style={{
                  background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                  ...typography.caption, color: colors.text.secondary,
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>

        {/* Clearing is irreversible, so confirm — but inline, not behind a modal
            the parent has to dismiss. Pending requests are never cleared. */}
        {clearing && (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: `${spacing.sm}px`, marginBottom: `${spacing.sm}px`,
            padding: `${spacing.sm}px`,
            backgroundColor: colors.surface.elevated,
            borderRadius: `${spacing.xs}px`,
          }}>
            <span style={{ ...typography.caption, color: colors.text.secondary }}>
              Clear {clearableCount} activity {clearableCount === 1 ? 'entry' : 'entries'}?
              Pending requests are kept.
            </span>
            <div style={{ display: 'flex', gap: `${spacing.xs}px`, flexShrink: 0 }}>
              <Button variant="secondary" onClick={() => setClearing(false)} style={{ fontSize: '12px', padding: '4px 10px' }}>
                Cancel
              </Button>
              <Button variant="danger" onClick={handleClearAll} style={{ fontSize: '12px', padding: '4px 10px' }}>
                Clear
              </Button>
            </div>
          </div>
        )}
        {history.length === 0 ? (
          <div style={{ ...typography.body, color: colors.text.muted, textAlign: 'center' }}>No activity yet.</div>
        ) : (
          history.map((item) => (
            <ActivityRow key={item.id} item={item} onDismiss={handleDismiss} />
          ))
        )}
      </div>
    </div>
  );
}
