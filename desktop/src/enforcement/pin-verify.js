// PIN verification mirrors Android's AppBlockerModule.checkPinAgainstPolicy:
// hash the entered PIN with BLAKE2b (sodium-native crypto_generichash), then
// match against every value in policy.pinHashes (per-parent map, primary
// schema), with a fallback to the legacy policy.pinHash field.
//
// Bare's pin:verify only checks the legacy field, which is stripped from the
// child's policy by handlePolicyUpdate (line 1621 in bare-dispatch.js). So we
// can't go through bare for verification — we have to do it here.

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
