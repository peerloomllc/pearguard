// src/relay.js
//
// The PeerLoom blind relay - client-side constant + policy.
//
// Reference: ../peartune/proposals/2026-07-23-blind-relay.md (the relay node was
// built, deployed and hardware-verified there; this is PearGuard adopting the same
// already-live node). One relay backs the whole suite - a blind byte-forwarder
// cares nothing about which app's bytes it carries.
//
// WHY PEARGUARD NEEDS IT: parent and child are routinely on *different* networks,
// and very often both are mobile. Two CGNAT'd phones is the hardest hole-punch case
// there is, and a user on a genuinely symmetric NAT punches at ~0% - the swarm never
// lands, so alerts never arrive and a policy change never reaches the child. Retries
// do not rescue 0%. A relay does.
//
// WHAT THE RELAY SEES: ciphertext only. The parent<->child stream stays Noise-
// encrypted end to end; the relay matches two half-connections by token and forwards
// bytes. It does learn metadata - which two keys are talking, and how much. That is
// the standard relay disclosure and it should be stated plainly rather than dressed
// up as zero-knowledge.

const z32 = require('z32')

// The deployed PeerLoom relay's public key (2026-07-23). Its private seed lives only
// on the relay box + Tim's password manager. Null here would make every function
// below a no-op, which is the intended "no relay configured" degradation.
const RELAY_PUBLIC_KEY_Z = 'qshao3eawtzecrt5p7buswr4meyyhw6q6b51qtxazd8wwfdp8uqy'

const RELAY_PUBLIC_KEY = RELAY_PUBLIC_KEY_Z ? z32.decode(RELAY_PUBLIC_KEY_Z) : null

// Local per-device pref (stored under `pref:` + this, via the pref:set/pref:get
// dispatch pair). Absent means "on" - see relayEnabledFromPref.
const RELAY_PREF_KEY = 'relay:enabled'

/**
 * Read the stored pref value into a boolean, defaulting to ON.
 *
 * Default-on is deliberate: a parental-control app whose whole value proposition is
 * that the parent can see and change things is worse than useless when the two
 * devices cannot reach each other. Opting out is a real choice we honour, but it is
 * a choice, not the default.
 */
function relayEnabledFromPref (value) {
  return value !== false
}

/**
 * The direct-first relay policy - the function Hyperswarm calls per outbound connect.
 * Hyperswarm accepts `relayThrough` as either a key or a `(force, swarm) => key|null`
 * function; we pass a function so the toggle and the key are read LIVE on every dial,
 * and a toggle change applies without tearing down the swarm.
 *
 * Returns the relay key to route through, or null for a direct-only attempt.
 *
 *   force      - Hyperswarm sets peerInfo.forceRelaying = true after a connect error
 *                whose code is HOLEPUNCH_ABORTED / HOLEPUNCH_DOUBLE_RANDOMIZED_NATS /
 *                REMOTE_NOT_HOLEPUNCHABLE (hyperswarm/index.js shouldForceRelaying).
 *                This is what makes us direct-FIRST: null on the normal attempt, the
 *                key only after the direct punch has actually failed for this peer.
 *   randomized - this device's own NAT is double-randomized, i.e. a direct punch can
 *                never work. Relay from the first attempt. Matches Hyperswarm's own
 *                default gate (`force || swarm.dht.randomized`).
 *   useRelay   - the privacy toggle (parent Settings -> Connection, default on).
 *   relayKey   - the baked relay key, or null when no relay is configured.
 *
 * Order matters: the toggle and the is-a-relay-even-configured check gate first, so a
 * user who opted out never relays regardless of what their NAT is doing.
 *
 * SCOPE OF THE TOGGLE - worth being precise about, because the obvious reading is
 * wrong: this governs whether THIS device escalates its OWN outbound dials. It does
 * not stop a peer from relaying *to* us. hyperdht's server relays whenever the remote
 * asked (`if (relayThrough || remotePayload.relayThrough)`, lib/server.js:397), and
 * that is correct - refusing would strand the peer who actually needs the relay.
 */
function relayThroughFor ({ force, randomized, useRelay, relayKey }) {
  if (!useRelay || !relayKey) return null
  return (force || randomized) ? relayKey : null
}

module.exports = { RELAY_PUBLIC_KEY, RELAY_PUBLIC_KEY_Z, RELAY_PREF_KEY, relayEnabledFromPref, relayThroughFor }
