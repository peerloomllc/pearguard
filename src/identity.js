// src/identity.js
//
// Keypair identity helpers using sodium-native.
// This module runs inside the Bare worklet (src/bare.js).
// Do NOT import this from app/ (React Native shell) directly.

const sodium = require('sodium-native')

/**
 * Generate a new Ed25519 keypair.
 * @returns {{ publicKey: Buffer, secretKey: Buffer }}
 */
function generateKeypair () {
  const publicKey = Buffer.allocUnsafe(sodium.crypto_sign_PUBLICKEYBYTES)  // 32 bytes
  const secretKey = Buffer.allocUnsafe(sodium.crypto_sign_SECRETKEYBYTES)  // 64 bytes
  sodium.crypto_sign_keypair(publicKey, secretKey)
  return { publicKey, secretKey }
}

/**
 * Sign a message with an Ed25519 secret key.
 * @param {Buffer} msg
 * @param {Buffer} secretKey — 64-byte Ed25519 secret key
 * @returns {Buffer} 64-byte signature
 */
function sign (msg, secretKey) {
  const sig = Buffer.allocUnsafe(sodium.crypto_sign_BYTES)  // 64 bytes
  sodium.crypto_sign_detached(sig, msg, secretKey)
  return sig
}

/**
 * Verify an Ed25519 signature.
 * @param {Buffer} msg
 * @param {Buffer} sig — 64-byte signature
 * @param {Buffer} publicKey — 32-byte Ed25519 public key
 * @returns {boolean}
 */
function verify (msg, sig, publicKey) {
  try {
    return sodium.crypto_sign_verify_detached(sig, msg, publicKey)
  } catch {
    return false
  }
}

module.exports = { generateKeypair, sign, verify }
