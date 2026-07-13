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
])

function isTamperReason(reason) {
  return !NON_TAMPER_REASONS.has(String(reason || ''))
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

    default:
      // Includes the GNOME extension-watchdog reasons ('linux:extension-*'),
      // which DO mean the child disabled or deleted the blocking extension.
      if (r.startsWith('linux:extension')) {
        return {
          title: who + "'s parental controls disabled",
          body: who + " disabled PearGuard's app-blocking extension.",
          tamper: true,
        }
      }
      // Unknown/legacy reason: say the true, minimal thing rather than guessing
      // at a cause and risking a false accusation.
      return {
        title: 'Protection disabled',
        body: 'App blocking is not running on ' + who + "'s device.",
        tamper: true,
      }
  }
}

module.exports = { describeBypassReason, isTamperReason, NON_TAMPER_REASONS }
