const { describeBypassReason, isTamperReason } = require('../src/bypass-reasons')

describe('describeBypassReason', () => {
  test('real tampering names what the child actually did', () => {
    const a = describeBypassReason('accessibility_disabled', 'Ben')
    expect(a.body).toMatch(/Accessibility Service/)
    expect(a.tamper).toBe(true)

    expect(describeBypassReason('force_stopped', 'Ben').body).toMatch(/force-stopped/)
    expect(describeBypassReason('clock_changed', 'Ben').title).toMatch(/clock/i)
    expect(describeBypassReason('timezone_changed', 'Ben').title).toMatch(/time zone/i)
  })

  // The point of the whole module: an unsupported compositor is OUR limitation.
  // Telling a parent their kid "turned off" protection would be a false accusation
  // and could get the child punished for something they did not do.
  test('an unsupported Wayland compositor does NOT accuse the child', () => {
    const r = describeBypassReason('linux:unsupported-compositor', 'Ben')
    expect(r.tamper).toBe(false)
    expect(r.body).not.toMatch(/turned off|disabled|removed|stopped/i)
    expect(r.body).toMatch(/not something Ben did/i)
    // ...but it must still be unambiguous that protection is NOT running.
    expect(r.body).toMatch(/inactive/i)
  })

  test('extension-not-loaded reads as an action to take, not an accusation', () => {
    const r = describeBypassReason('linux:extension-not-loaded', 'Ben')
    expect(r.tamper).toBe(false)
    expect(r.body).toMatch(/log out/i)
    expect(r.body).not.toMatch(/turned off/i)
  })

  // The ONE Linux extension case we can actually attribute: the switch was
  // affirmatively turned off (Enabled: No).
  test('but turning the extension OFF is real tampering', () => {
    const r = describeBypassReason('linux:extension-disabled', 'Ben')
    expect(r.tamper).toBe(true)
    expect(r.body).toMatch(/turned off/i)
  })

  // These are the false accusations that shipped: the watchdog reported every
  // non-ACTIVE extension state as "extension-disabled", so a Shell that simply
  // hadn't loaded the extension (Enabled: Yes, State: INACTIVE) told the parent
  // their child had disabled protection. The child had done nothing.
  test('extension failures the child did not cause never blame the child', () => {
    for (const reason of [
      'linux:extension-not-loaded',
      'linux:extension-out-of-date',
      'linux:extension-error',
      'linux:extension-missing',
    ]) {
      const r = describeBypassReason(reason, 'Ben')
      expect(r.tamper).toBe(false)
      expect(r.body).not.toMatch(/Ben turned off|Ben disabled|Ben removed/i)
      // ...but the parent must still be told blocking is off.
      expect(r.title + ' ' + r.body).toMatch(/off|inactive|not running/i)
    }
  })

  // Enabled-in-settings but OS-killed process: protection is off, but the child
  // did not turn it off (that would be accessibility_disabled / force_stopped),
  // so it must not accuse and must still say blocking is inactive.
  test('accessibility-not-connected reports the gap without blaming the child', () => {
    const r = describeBypassReason('accessibility_not_connected', 'Ben')
    expect(r.tamper).toBe(false)
    expect(r.body).not.toMatch(/Ben turned off|Ben disabled|Ben removed|Ben force-stopped/i)
    expect(r.body).toMatch(/not something Ben did/i)
    expect(r.title + ' ' + r.body).toMatch(/paused|inactive|not running/i)
    expect(isTamperReason('accessibility_not_connected')).toBe(false)
  })

  test('never says "Accessibility Service" for a desktop reason', () => {
    for (const reason of ['force_stopped', 'linux:unsupported-compositor', 'linux:extension-not-loaded']) {
      expect(describeBypassReason(reason, 'Ben').body).not.toMatch(/Accessibility Service/)
    }
  })

  test('unknown/legacy reason states the truth without inventing a cause', () => {
    const r = describeBypassReason('something_new', 'Ben')
    expect(r.body).toMatch(/not running/i)
    expect(r.body).not.toMatch(/Accessibility Service/)
  })

  test('falls back to a generic name when the child has none', () => {
    expect(describeBypassReason('force_stopped', '').body).toMatch(/Your child/)
    expect(describeBypassReason('force_stopped', undefined).title).toMatch(/Your child/)
  })

  test('isTamperReason separates capability failures from tampering', () => {
    expect(isTamperReason('accessibility_disabled')).toBe(true)
    expect(isTamperReason('linux:unsupported-compositor')).toBe(false)
    expect(isTamperReason('linux:extension-not-loaded')).toBe(false)
  })
})
