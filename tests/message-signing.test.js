// tests/message-signing.test.js
const { generateKeypair, sign, verify } = require('../src/identity')
const { signMessage, verifyMessage } = require('../src/message')

describe('message signing', () => {
  let kp

  beforeAll(() => {
    kp = generateKeypair()
  })

  test('signMessage returns an object with sig field', () => {
    const msg = signMessage({ type: 'heartbeat', payload: { online: true } }, kp)
    expect(typeof msg.sig).toBe('string')
    expect(msg.sig.length).toBe(128)  // 64 bytes as hex
    expect(typeof msg.from).toBe('string')
    expect(msg.from.length).toBe(64)  // 32 bytes as hex
    expect(typeof msg.ts).toBe('number')
  })

  test('verifyMessage returns true for valid message', () => {
    const msg = signMessage({ type: 'heartbeat', payload: { online: true } }, kp)
    const pubKeyHex = msg.from
    expect(verifyMessage(msg, pubKeyHex)).toBe(true)
  })

  test('verifyMessage returns false for tampered payload', () => {
    const msg = signMessage({ type: 'heartbeat', payload: { online: true } }, kp)
    msg.payload.online = false  // tamper
    expect(verifyMessage(msg, msg.from)).toBe(false)
  })

  test('verifyMessage returns false for wrong public key', () => {
    const kp2 = generateKeypair()
    const msg = signMessage({ type: 'heartbeat', payload: {} }, kp)
    const wrongPubKey = Buffer.from(kp2.publicKey).toString('hex')
    expect(verifyMessage(msg, wrongPubKey)).toBe(false)
  })

  test('verifyMessage returns false for missing sig', () => {
    const msg = signMessage({ type: 'heartbeat', payload: {} }, kp)
    delete msg.sig
    expect(verifyMessage(msg, msg.from)).toBe(false)
  })
})
