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

  test('but disabling the extension IS tampering', () => {
    const r = describeBypassReason('linux:extension-disabled', 'Ben')
    expect(r.tamper).toBe(true)
    expect(r.body).toMatch(/disabled/i)
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
