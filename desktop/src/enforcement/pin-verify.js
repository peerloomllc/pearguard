// PIN verification mirrors Android's AppBlockerModule.checkPinAgainstPolicy:
// hash the entered PIN with BLAKE2b (sodium-native crypto_generichash), then
// match against every value in policy.pinHashes (per-parent map, primary
// schema), with a fallback to the legacy policy.pinHash field.
//
// Bare's pin:verify used to check only the legacy field, which handlePolicyUpdate
// strips from the child's policy, so it denied every PIN and this had to exist.
// It checks pinHashes too now, but verification still belongs here: the overlay
// needs an answer without a round trip through the worklet, and the lockout
// ladder and audit routing around it live on this side.

function hashPin(sodium, pin) {
  const buf = Buffer.alloc(sodium.crypto_generichash_BYTES)
  sodium.crypto_generichash(buf, Buffer.from(pin))
  return buf.toString('hex')
}

// Returns one of:
//   { ok: true }
//   { ok: false, reason: 'no-pin' | 'wrong-pin' | 'no-policy' }
function verifyPin({ sodium, policy, pin }) {
  if (!policy) return { ok: false, reason: 'no-policy' }
  const pinHashes = policy.pinHashes || {}
  const legacy = policy.pinHash || null
  const hashCount = Object.keys(pinHashes).length
  if (hashCount === 0 && !legacy) return { ok: false, reason: 'no-pin' }

  const entered = hashPin(sodium, String(pin))

  for (const stored of Object.values(pinHashes)) {
    if (stored === entered) return { ok: true }
  }
  if (legacy && legacy === entered) return { ok: true }

  return { ok: false, reason: 'wrong-pin' }
}

module.exports = { verifyPin, hashPin }
