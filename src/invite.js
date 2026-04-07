// src/invite.js
//
// Invite link builder and parser for PearGuard.
//
// Invite payload: { parentPublicKey: hex(32 bytes), swarmTopic: hex(32 bytes) }
// Encoded as base64url (URL-safe, no padding).
// Full link format: pearguard://join/<base64url-payload>
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
 * @param {{ parentPublicKey?: string, swarmTopic?: string }} payload
 * @returns {string}
 */
function encodeInvite (payload) {
  const json = JSON.stringify({
    p: payload.parentPublicKey ?? '',
    t: payload.swarmTopic ?? '',
  })
  return toBase64url(json)
}

/**
 * Decode a base64url invite string.
 * @param {string} encoded
 * @returns {{ ok: boolean, parentPublicKey?: string, swarmTopic?: string, error?: string }}
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
  const parentPublicKey = payload.p
  const swarmTopic      = payload.t
  if (!parentPublicKey || typeof parentPublicKey !== 'string') {
    return { ok: false, error: 'missing parentPublicKey' }
  }
  if (!HEX_64.test(parentPublicKey)) {
    return { ok: false, error: 'invalid parentPublicKey length (expected 64 hex chars)' }
  }
  if (!swarmTopic || !HEX_64.test(swarmTopic)) {
    return { ok: false, error: 'invalid swarmTopic' }
  }
  return { ok: true, parentPublicKey, swarmTopic }
}

/**
 * Build a full pearguard://join?t=<encoded> deep link.
 * @param {{ parentPublicKey: string, swarmTopic: string }} payload
 * @returns {string}
 */
function buildInviteLink (payload) {
  return SCHEME_QUERY + encodeInvite(payload)
}

/**
 * Parse a pearguard://join deep link — supports both query param (?t=) and legacy path formats.
 * @param {string} url
 * @returns {{ ok: boolean, parentPublicKey?: string, swarmTopic?: string, error?: string }}
 */
function parseInviteLink (url) {
  if (typeof url !== 'string') return { ok: false, error: 'not a string' }
  // Query param format: pearguard://join?t=<encoded>
  if (url.startsWith(SCHEME_QUERY)) {
    return decodeInvite(url.slice(SCHEME_QUERY.length))
  }
  // Legacy path format: pearguard://join/<encoded>
  if (url.startsWith(SCHEME_PATH)) {
    return decodeInvite(url.slice(SCHEME_PATH.length))
  }
  return { ok: false, error: 'not a pearguard://join link' }
}

// ── Co-parent invite helpers ─────────────────────────────────────────────────

const COPARENT_SCHEME = 'pear://pearguard/coparent?t='

/**
 * Build a co-parent invite link containing the inviting parent's key, a swarm
 * topic for the parent-to-parent handshake, and the child's public key.
 * @param {{ parentPublicKey: string, swarmTopic: string, childPublicKey: string }} payload
 * @returns {string}
 */
function buildCoparentLink (payload) {
  const json = JSON.stringify({
    p: payload.parentPublicKey ?? '',
    t: payload.swarmTopic ?? '',
    c: payload.childPublicKey ?? '',
  })
  return COPARENT_SCHEME + toBase64url(json)
}

/**
 * Parse a co-parent invite link.
 * @param {string} url
 * @returns {{ ok: boolean, parentPublicKey?: string, swarmTopic?: string, childPublicKey?: string, error?: string }}
 */
function parseCoparentLink (url) {
  if (typeof url !== 'string') return { ok: false, error: 'not a string' }
  if (!url.startsWith(COPARENT_SCHEME)) return { ok: false, error: 'not a coparent link' }
  const encoded = url.slice(COPARENT_SCHEME.length)
  let raw
  try { raw = fromBase64url(encoded) } catch { return { ok: false, error: 'base64url decode failed' } }
  let payload
  try { payload = JSON.parse(raw) } catch { return { ok: false, error: 'JSON parse failed' } }
  const parentPublicKey = payload.p
  const swarmTopic = payload.t
  const childPublicKey = payload.c
  if (!parentPublicKey || !HEX_64.test(parentPublicKey)) return { ok: false, error: 'invalid parentPublicKey' }
  if (!swarmTopic || !HEX_64.test(swarmTopic)) return { ok: false, error: 'invalid swarmTopic' }
  if (!childPublicKey || !HEX_64.test(childPublicKey)) return { ok: false, error: 'invalid childPublicKey' }
  return { ok: true, parentPublicKey, swarmTopic, childPublicKey }
}

module.exports = { encodeInvite, decodeInvite, buildInviteLink, parseInviteLink, buildCoparentLink, parseCoparentLink }
