// Decides whether PearGuard can actually enforce on this Linux session — and,
// if it can't, says so out loud instead of pretending.
//
// Why this exists: on Wayland, xprop/active-win is blind to Wayland-native
// windows, so foreground detection depends entirely on our GNOME Shell
// extension. On a non-GNOME Wayland compositor (KDE, sway, Hyprland...) there is
// no way to install it, so the foreground monitor sees nothing and enforcement
// silently does nothing at all. The child's machine looked protected, the parent
// dashboard looked healthy, and no app was ever blocked. Worse, the old code told
// the CHILD to "log out and log back in" — advice that can never help on KDE.
//
// X11 sessions are fine: active-win/xprop works there, extension or not.
//
// CAREFUL — the lock screen: GNOME disables extensions on the lock screen, so the
// extension's D-Bus name disappears while the session is locked (this is
// deliberate and load-bearing; see foreground-wayland.js). A naive "is D-Bus
// answering?" health check would therefore scream "enforcement is broken!" every
// time the kid locks their screen. So capability is decided from *configuration*
// (is this Wayland? is GNOME present? is the extension enabled?) — signals that
// survive a lock — and the D-Bus probe is only ever used to distinguish
// "installed but Shell hasn't loaded it yet" from "live", never as the sole
// evidence of failure.

const REASON_UNSUPPORTED = 'linux:unsupported-compositor'
const REASON_NOT_LOADED = 'linux:extension-not-loaded'

/**
 * Pure decision function — all environment probing is done by the caller and
 * passed in, so this is trivially unit-testable.
 *
 * @param {object}  env
 * @param {boolean} env.isLinux
 * @param {boolean} env.isWayland        Wayland session? (X11 needs no extension)
 * @param {boolean} env.hasGnome         is this a GNOME Shell session at all?
 * @param {boolean} env.extensionEnabled is our extension in the enabled list?
 * @param {boolean|null} env.dbusLive    extension answering on D-Bus? null = unknown/not probed
 * @param {boolean} env.sessionLocked    if locked, dbusLive is meaningless (see above)
 *
 * @returns {{ ok: boolean, reason: string|null, childMessage: {title,body}|null }}
 */
function assessLinuxEnforcement({
  isLinux = true,
  isWayland = false,
  hasGnome = false,
  extensionEnabled = false,
  dbusLive = null,
  sessionLocked = false,
} = {}) {
  // Non-Linux, or X11: active-win handles it. Nothing to check.
  if (!isLinux || !isWayland) return { ok: true, reason: null, childMessage: null }

  // Wayland without GNOME: we have no foreground adapter at all, and no path to
  // one. This is a hard capability failure and no amount of logging out fixes it.
  if (!hasGnome) {
    return {
      ok: false,
      reason: REASON_UNSUPPORTED,
      childMessage: {
        title: "PearGuard can't block apps on this desktop",
        body: 'This Linux desktop\'s window system is not supported, so app blocking is inactive. '
          + 'Your parent has been notified.',
      },
    }
  }

  // GNOME Wayland, but our extension isn't even enabled: the Shell will never
  // expose the focused window to us.
  if (!extensionEnabled) {
    return {
      ok: false,
      reason: REASON_NOT_LOADED,
      childMessage: {
        title: 'PearGuard needs you to log out',
        body: 'Log out and log back in to finish enabling app blocking. It is inactive until then.',
      },
    }
  }

  // Extension is enabled. Only now does the D-Bus probe mean anything — and only
  // when the session is UNLOCKED, because a locked GNOME session unloads
  // extensions and would otherwise look identical to a broken one.
  if (!sessionLocked && dbusLive === false) {
    return {
      ok: false,
      reason: REASON_NOT_LOADED,
      childMessage: {
        title: 'PearGuard needs you to log out',
        body: 'Log out and log back in to finish enabling app blocking. It is inactive until then.',
      },
    }
  }

  return { ok: true, reason: null, childMessage: null }
}

module.exports = { assessLinuxEnforcement, REASON_UNSUPPORTED, REASON_NOT_LOADED }
