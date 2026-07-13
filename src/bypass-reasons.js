// Turns a bypass/enforcement-offline `reason` into the text the PARENT sees.
//
// Every reason used to render the same Android-specific sentence ("<child> turned
// off the PearGuard Accessibility Service"), no matter what actually happened or
// which platform the child was on. That's wrong in two directions:
//
//   - It's factually incorrect for a desktop child (there is no Accessibility
//     Service on Windows or Linux).
//   - Worse, it ACCUSES. Some reasons are not the child's doing at all — an
//     unsupported Wayland compositor means PearGuard simply cannot enforce on
//     that machine. Telling a parent their kid "turned off" protection when the
//     app never worked there invites a punishment for something the child didn't
//     do. Reasons that are the app's limitation must read as the app's problem.
//
// The parent still needs to know enforcement is off in every case — that's the
// whole point of the alert — but the wording has to match the cause.

// Reasons that mean "PearGuard cannot enforce here", NOT "the child defeated it".
// Kept exported so the UI can style/prioritise them differently from real tampering.
const NON_TAMPER_REASONS = new Set([
  'linux:unsupported-compositor',
  'linux:extension-not-loaded',
  'linux:extension-out-of-date',
  'linux:extension-error',
  'linux:extension-missing',
])

// Delegate to describeBypassReason so there is exactly ONE definition of what
// counts as tampering. Deriving it from the Set instead would silently disagree
// with the wording for any reason not listed there (e.g. an unknown one, which
// the switch deliberately treats as "not the child's fault").
function isTamperReason(reason) {
  return describeBypassReason(reason, 'x').tamper
}

/**
 * @param {string} reason  as sent by the child (bypass:detected)
 * @param {string} childName  display name, already defaulted by the caller
 * @returns {{ title: string, body: string, tamper: boolean }}
 */
function describeBypassReason(reason, childName) {
  const who = childName || 'Your child'
  const r = String(reason || '')

  switch (r) {
    // --- The child actively defeated enforcement -----------------------------
    case 'accessibility_disabled':
      return {
        title: who + "'s parental controls disabled",
        body: who + ' turned off the PearGuard Accessibility Service.',
        tamper: true,
      }
    case 'device_admin_disabled':
      return {
        title: who + "'s parental controls disabled",
        body: who + " removed PearGuard's device administrator.",
        tamper: true,
      }
    case 'force_stopped':
      return {
        title: 'PearGuard was stopped on ' + who + "'s device",
        body: who + ' force-stopped PearGuard. App blocking is not running.',
        tamper: true,
      }
    case 'clock_changed':
      return {
        title: 'Device clock changed',
        body: who + ' changed the device clock, which can defeat daily limits and schedules.',
        tamper: true,
      }
    case 'timezone_changed':
      return {
        title: 'Device time zone changed',
        body: who + ' changed the device time zone, which can defeat daily limits and schedules.',
        tamper: true,
      }

    // --- PearGuard can't enforce here. NOT the child's fault. -----------------
    case 'linux:unsupported-compositor':
      return {
        title: "App blocking isn't working on " + who + "'s PC",
        body: "PearGuard can't monitor apps on this Linux desktop — its window system isn't supported. "
          + 'Blocking is inactive until this is resolved. This is a PearGuard limitation, not something '
          + who + ' did.',
        tamper: false,
      }
    case 'linux:extension-not-loaded':
      return {
        title: 'Action needed on ' + who + "'s PC",
        body: who + ' needs to log out and back in to finish enabling app blocking. '
          + 'Blocking is inactive until then.',
        tamper: false,
      }
    case 'linux:extension-out-of-date':
      return {
        title: "App blocking is off on " + who + "'s PC",
        body: "PearGuard's app-blocking extension isn't compatible with the version of GNOME on this PC, "
          + 'so blocking is inactive. A PearGuard update is needed — ' + who + ' did not do this.',
        tamper: false,
      }
    case 'linux:extension-error':
      return {
        title: "App blocking is off on " + who + "'s PC",
        body: "PearGuard's app-blocking extension crashed, so blocking is inactive. "
          + 'Restarting the PC usually fixes it. This is a PearGuard fault, not something ' + who + ' did.',
        tamper: false,
      }
    case 'linux:extension-missing':
      // Could be a destructive child OR a failed install — we genuinely cannot
      // tell from here, so state the fact and assign no blame.
      return {
        title: "App blocking is off on " + who + "'s PC",
        body: "PearGuard's app-blocking extension is missing, so blocking is inactive. "
          + 'PearGuard will try to reinstall it.',
        tamper: false,
      }

    // The one Linux extension case we CAN attribute: the switch was turned off.
    case 'linux:extension-disabled':
      return {
        title: who + "'s parental controls disabled",
        body: who + " turned off PearGuard's app-blocking extension.",
        tamper: true,
      }

    default:
      // Unknown/legacy reason: state the true, minimal thing. Do NOT guess at a
      // cause — inventing "your child disabled protection" for a reason we don't
      // recognise is exactly the false accusation this module exists to prevent.
      return {
        title: 'App blocking is off',
        body: 'App blocking is not running on ' + who + "'s device.",
        tamper: false,
      }
  }
}

module.exports = { describeBypassReason, isTamperReason, NON_TAMPER_REASONS }
