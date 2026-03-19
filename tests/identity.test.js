// tests/identity.test.js
const { generateKeypair, sign, verify } = require('../src/identity')

describe('identity', () => {
  test('generateKeypair returns publicKey and secretKey buffers', () => {
    const kp = generateKeypair()
    expect(Buffer.isBuffer(kp.publicKey)).toBe(true)
    expect(Buffer.isBuffer(kp.secretKey)).toBe(true)
    expect(kp.publicKey.length).toBe(32)
    expect(kp.secretKey.length).toBe(64)
  })

  test('sign returns a 64-byte signature buffer', () => {
    const kp = generateKeypair()
    const msg = Buffer.from('hello world')
    const sig = sign(msg, kp.secretKey)
    expect(Buffer.isBuffer(sig)).toBe(true)
    expect(sig.length).toBe(64)
  })

  test('verify returns true for valid signature', () => {
    const kp = generateKeypair()
    const msg = Buffer.from('hello pearguard')
    const sig = sign(msg, kp.secretKey)
    expect(verify(msg, sig, kp.publicKey)).toBe(true)
  })

  test('verify returns false for tampered message', () => {
    const kp = generateKeypair()
    const msg = Buffer.from('original message')
    const sig = sign(msg, kp.secretKey)
    const tampered = Buffer.from('tampered message')
    expect(verify(tampered, sig, kp.publicKey)).toBe(false)
  })

  test('verify returns false for wrong public key', () => {
    const kp1 = generateKeypair()
    const kp2 = generateKeypair()
    const msg = Buffer.from('test')
    const sig = sign(msg, kp1.secretKey)
    expect(verify(msg, sig, kp2.publicKey)).toBe(false)
  })

  test('two calls to generateKeypair return different keys', () => {
    const kp1 = generateKeypair()
    const kp2 = generateKeypair()
    expect(kp1.publicKey.equals(kp2.publicKey)).toBe(false)
  })
})
