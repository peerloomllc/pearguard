// src/invite.js
//
// Invite link builder and parser for PearGuard.
//
// Invite payload: { p: hex(32 bytes pubkey), t: hex(32 bytes topic), r: 'p' | 'c' }
//   r = 'p' → invite is parent-hosted (p is parentPublicKey). Legacy default.
//   r = 'c' → invite is child-hosted  (p is childPublicKey).
// Encoded as base64url (URL-safe, no padding).
// Full link format: pear://pearguard/join?t=<base64url-payload>
//
// This module runs in both the Bare worklet (src/bare.js) and in the
// React Native shell (app/join.tsx). It uses only built-in JS APIs.

const SCHEME_QUERY = 'pear://pearguard/join?t='    // preferred: query param format
const SCHEME_PATH  = 'pear://pearguard/join/'      // legacy: path format (still parsed)
const HEX_64 = /^[0-9a-f]{64}$/i   // 32 bytes as hex

// ── Base64url helpers (no external deps) ──────────────────────────────────────

function toBase64url (str) {
  // btoa is available in both Node 16+ and Bare
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function fromBase64url (str) {
  // Restore standard base64
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/')
  // Pad to multiple of 4
  const padded = b64 + '==='.slice(0, (4 - b64.length % 4) % 4)
  return atob(padded)
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Encode an invite payload to a base64url string.
 * Accepts either parent-hosted or child-hosted payloads.
 * @param {{ parentPublicKey?: string, childPublicKey?: string, swarmTopic?: string, role?: 'p'|'c' }} payload
 * @returns {string}
 */
function encodeInvite (payload) {
  const role = payload.role === 'c' ? 'c' : 'p'
  const hostPublicKey = role === 'c'
    ? (payload.childPublicKey ?? payload.parentPublicKey ?? '')
    : (payload.parentPublicKey ?? payload.childPublicKey ?? '')
  const obj = {
    p: hostPublicKey,
    t: payload.swarmTopic ?? '',
  }
  // Only include role field for non-default (child-hosted) invites so legacy
  // parent-hosted invite payloads remain byte-identical to prior versions.
  if (role === 'c') obj.r = 'c'
  return toBase64url(JSON.stringify(obj))
}

/**
 * Decode a base64url invite string.
 * @param {string} encoded
 * @returns {{ ok: boolean, role?: 'p'|'c', hostPublicKey?: string, parentPublicKey?: string, childPublicKey?: string, swarmTopic?: string, error?: string }}
 */
function decodeInvite (encoded) {
  if (!encoded || typeof encoded !== 'string') {
    return { ok: false, error: 'empty input' }
  }
  let raw
  try {
    raw = fromBase64url(encoded)
  } catch {
    return { ok: false, error: 'base64url decode failed' }
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'JSON parse failed' }
  }
  const hostPublicKey = payload.p
  const swarmTopic    = payload.t
  const role = payload.r === 'c' ? 'c' : 'p'
  if (!hostPublicKey || typeof hostPublicKey !== 'string') {
    return { ok: false, error: 'missing parentPublicKey' }
  }
  if (!HEX_64.test(hostPublicKey)) {
    return { ok: false, error: 'invalid parentPublicKey length (expected 64 hex chars)' }
  }
  if (!swarmTopic || !HEX_64.test(swarmTopic)) {
    return { ok: false, error: 'invalid swarmTopic' }
  }
  const result = { ok: true, role, hostPublicKey, swarmTopic }
  if (role === 'c') {
    result.childPublicKey = hostPublicKey
  } else {
    result.parentPublicKey = hostPublicKey
  }
  return result
}

/**
 * Build a full pear://pearguard/join?t=<encoded> deep link.
 * @param {{ parentPublicKey?: string, childPublicKey?: string, swarmTopic: string, role?: 'p'|'c' }} payload
 * @returns {string}
 */
function buildInviteLink (payload) {
  return SCHEME_QUERY + encodeInvite(payload)
}

/**
 * Parse a pear://pearguard/join deep link — supports both query param (?t=) and legacy path formats.
 * @param {string} url
 * @returns {{ ok: boolean, role?: 'p'|'c', hostPublicKey?: string, parentPublicKey?: string, childPublicKey?: string, swarmTopic?: string, error?: string }}
 */
function parseInviteLink (url) {
  if (typeof url !== 'string') return { ok: false, error: 'not a string' }
  // Query param format: pear://pearguard/join?t=<encoded>
  if (url.startsWith(SCHEME_QUERY)) {
    return decodeInvite(url.slice(SCHEME_QUERY.length))
  }
  // Legacy path format: pear://pearguard/join/<encoded>
  if (url.startsWith(SCHEME_PATH)) {
    return decodeInvite(url.slice(SCHEME_PATH.length))
  }
  return { ok: false, error: 'not a pearguard://join link' }
}

module.exports = { encodeInvite, decodeInvite, buildInviteLink, parseInviteLink }
