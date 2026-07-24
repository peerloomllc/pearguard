// tests/relay.test.js
//
// The blind-relay policy (src/relay.js). This is the whole decision surface of the
// relay feature: everything else is Hyperswarm and hyperdht doing what they already
// do. The two properties worth pinning are (1) direct-first, so we never relay a peer
// we could have punched, and (2) the opt-out wins over everything, so a user who said
// no never touches PeerLoom infrastructure.

const { RELAY_PUBLIC_KEY, RELAY_PUBLIC_KEY_Z, RELAY_PREF_KEY, relayEnabledFromPref, relayThroughFor } = require('../src/relay')

const KEY = RELAY_PUBLIC_KEY

describe('relay key constant', () => {
  test('the baked z-base32 key decodes to a 32-byte public key', () => {
    expect(typeof RELAY_PUBLIC_KEY_Z).toBe('string')
    expect(RELAY_PUBLIC_KEY).not.toBeNull()
    expect(RELAY_PUBLIC_KEY.length).toBe(32)
  })

  test('the key matches the deployed PeerLoom relay', () => {
    // Hard-coded on purpose: this is the one value that must agree across the whole
    // suite, so a well-meaning edit should fail a test rather than silently point
    // PearGuard at a relay that does not exist.
    expect(RELAY_PUBLIC_KEY_Z).toBe('qshao3eawtzecrt5p7buswr4meyyhw6q6b51qtxazd8wwfdp8uqy')
  })

  test('the pref key is stable', () => {
    // The UI writes this string literally via pref:set; a rename here without a
    // matching UI change would silently strand every existing opt-out.
    expect(RELAY_PREF_KEY).toBe('relay:enabled')
  })
})

describe('relayEnabledFromPref', () => {
  test('defaults to on when the pref was never written', () => {
    expect(relayEnabledFromPref(undefined)).toBe(true)
    expect(relayEnabledFromPref(null)).toBe(true)
  })

  test('only an explicit false turns it off', () => {
    expect(relayEnabledFromPref(false)).toBe(false)
    expect(relayEnabledFromPref(true)).toBe(true)
  })
})

describe('relayThroughFor - direct-first', () => {
  test('a normal first attempt is direct: no relay key offered', () => {
    expect(relayThroughFor({ force: false, randomized: false, useRelay: true, relayKey: KEY })).toBeNull()
  })

  test('escalates to the relay once the direct punch has failed for this peer', () => {
    expect(relayThroughFor({ force: true, randomized: false, useRelay: true, relayKey: KEY })).toBe(KEY)
  })

  test('relays from the first attempt when this NAT can never punch', () => {
    expect(relayThroughFor({ force: false, randomized: true, useRelay: true, relayKey: KEY })).toBe(KEY)
  })
})

describe('relayThroughFor - the opt-out wins', () => {
  test('opted out: never relays, even after the punch failed', () => {
    expect(relayThroughFor({ force: true, randomized: false, useRelay: false, relayKey: KEY })).toBeNull()
  })

  test('opted out: never relays, even on an unpunchable NAT', () => {
    expect(relayThroughFor({ force: true, randomized: true, useRelay: false, relayKey: KEY })).toBeNull()
  })

  test('no relay configured: a pure no-op regardless of NAT or failure', () => {
    expect(relayThroughFor({ force: true, randomized: true, useRelay: true, relayKey: null })).toBeNull()
  })
})
