// src/message.js
//
// Signed message helpers for PearGuard P2P protocol.
// Used by src/bare.js when sending/receiving messages over Hyperswarm.

const { sign, verify } = require('./identity')

/**
 * Sign a message with our keypair. Returns the full message object
 * (including `from`, `ts`, and `sig`) ready to send over the wire.
 *
 * @param {{ type: string, payload: object }} msg
 * @param {{ publicKey: Buffer, secretKey: Buffer }} keypair
 * @returns {{ from: string, type: string, payload: object, ts: number, sig: string }}
 */
function signMessage (msg, keypair) {
  const from = Buffer.from(keypair.publicKey).toString('hex')
  const ts   = Date.now()
  const body = JSON.stringify({ from, type: msg.type, payload: msg.payload, ts })
  const sig  = sign(Buffer.from(body), keypair.secretKey).toString('hex')
  return { from, type: msg.type, payload: msg.payload, ts, sig }
}

/**
 * Verify a received message against the sender's known public key.
 * Returns false if signature is missing, malformed, or invalid.
 *
 * @param {{ from: string, type: string, payload: object, ts: number, sig: string }} msg
 * @param {string} expectedPublicKeyHex — hex-encoded 32-byte Ed25519 public key
 * @returns {boolean}
 */
function verifyMessage (msg, expectedPublicKeyHex) {
  try {
    if (!msg.sig || !msg.from || !msg.ts) return false
    if (msg.from !== expectedPublicKeyHex) return false
    const body = JSON.stringify({ from: msg.from, type: msg.type, payload: msg.payload, ts: msg.ts })
    const sig  = Buffer.from(msg.sig, 'hex')
    const pk   = Buffer.from(expectedPublicKeyHex, 'hex')
    return verify(Buffer.from(body), sig, pk)
  } catch {
    return false
  }
}

module.exports = { signMessage, verifyMessage }
