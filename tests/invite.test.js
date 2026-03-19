// tests/invite.test.js
const { encodeInvite, decodeInvite, buildInviteLink, parseInviteLink } = require('../src/invite')

describe('invite', () => {
  const validInvite = {
    parentPublicKey: 'a'.repeat(64),  // 32-byte key as 64 hex chars
    swarmTopic:      'b'.repeat(64),
  }

  test('encodeInvite returns a non-empty string', () => {
    const encoded = encodeInvite(validInvite)
    expect(typeof encoded).toBe('string')
    expect(encoded.length).toBeGreaterThan(0)
  })

  test('encoded string contains no URL-unsafe characters', () => {
    const encoded = encodeInvite(validInvite)
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  test('decodeInvite round-trips encodeInvite', () => {
    const encoded = encodeInvite(validInvite)
    const decoded = decodeInvite(encoded)
    expect(decoded.ok).toBe(true)
    expect(decoded.parentPublicKey).toBe(validInvite.parentPublicKey)
    expect(decoded.swarmTopic).toBe(validInvite.swarmTopic)
  })

  test('decodeInvite returns error for empty string', () => {
    const result = decodeInvite('')
    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
  })

  test('decodeInvite returns error for garbage input', () => {
    const result = decodeInvite('not-valid-base64!!!')
    expect(result.ok).toBe(false)
  })

  test('decodeInvite returns error if parentPublicKey is missing', () => {
    const broken = encodeInvite({ swarmTopic: 'b'.repeat(64) })
    const result = decodeInvite(broken)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/parentPublicKey/)
  })

  test('decodeInvite returns error if parentPublicKey is wrong length', () => {
    const broken = encodeInvite({ parentPublicKey: 'abc', swarmTopic: 'b'.repeat(64) })
    const result = decodeInvite(broken)
    expect(result.ok).toBe(false)
  })

  test('buildInviteLink produces a pearguard:// URL', () => {
    const link = buildInviteLink(validInvite)
    expect(link.startsWith('pearguard://join/')).toBe(true)
  })

  test('parseInviteLink round-trips buildInviteLink', () => {
    const link = buildInviteLink(validInvite)
    const result = parseInviteLink(link)
    expect(result.ok).toBe(true)
    expect(result.parentPublicKey).toBe(validInvite.parentPublicKey)
    expect(result.swarmTopic).toBe(validInvite.swarmTopic)
  })
})
