// tests/pairing.test.js
const { encodeInvite, decodeInvite, buildInviteLink, parseInviteLink } = require('../src/invite')
const { signMessage, verifyMessage } = require('../src/message')
const { generateKeypair } = require('../src/identity')

describe('pairing', () => {
  // db.createReadStream is used by invite:generate to sweep stale topics; return
  // an empty async iterable so no entries are found.
  function emptyReadStream () {
    return (async function* () {})()
  }

  test('invite:generate dispatch creates a valid invite link', async () => {
    const { createDispatch } = require('../src/bare-dispatch')

    const kp = generateKeypair()

    const ctx = {
      db: {
        put: jest.fn().mockResolvedValue(undefined),
        get: jest.fn().mockResolvedValue(null),
        del: jest.fn().mockResolvedValue(undefined),
        createReadStream: jest.fn(() => emptyReadStream()),
      },
      identity:  kp,
      peers:     new Map(),
      send:      jest.fn(),
      joinTopic: jest.fn().mockResolvedValue(undefined),
      sendToPeer: jest.fn(),
    }

    const dispatch = createDispatch(ctx)
    const result = await dispatch('invite:generate', [])

    expect(typeof result.inviteLink).toBe('string')
    expect(result.inviteLink.startsWith('pear://pearguard/join?t=')).toBe(true)

    const parsed = parseInviteLink(result.inviteLink)
    expect(parsed.ok).toBe(true)
    expect(parsed.parentPublicKey).toBe(Buffer.from(kp.publicKey).toString('hex'))
    expect(typeof parsed.swarmTopic).toBe('string')
    expect(parsed.swarmTopic.length).toBe(64)

    expect(ctx.joinTopic).toHaveBeenCalledWith(parsed.swarmTopic)
  })

  test('acceptInvite dispatch decodes invite and calls joinTopic', async () => {
    const { createDispatch } = require('../src/bare-dispatch')
    const parentKp = generateKeypair()
    const topic = Buffer.alloc(32, 0xcd).toString('hex')
    const inviteLink = buildInviteLink({
      parentPublicKey: Buffer.from(parentKp.publicKey).toString('hex'),
      swarmTopic: topic,
    })

    const childKp = generateKeypair()
    const ctx = {
      db:        { put: jest.fn(), get: jest.fn().mockResolvedValue(null) },
      identity:  childKp,
      peers:     new Map(),
      send:      jest.fn(),
      joinTopic: jest.fn().mockResolvedValue(undefined),
      sendToPeer: jest.fn(),
    }

    const dispatch = createDispatch(ctx)
    const result = await dispatch('acceptInvite', [inviteLink])

    expect(result.ok).toBe(true)
    expect(ctx.joinTopic).toHaveBeenCalledWith(topic)
    // Parent pubkey should be stored under the per-parent pendingParent key
    const parentPubHex = Buffer.from(parentKp.publicKey).toString('hex')
    expect(ctx.db.put).toHaveBeenCalledWith(
      'pendingParent:' + parentPubHex,
      expect.objectContaining({ publicKey: parentPubHex })
    )
  })

  test('hello message round-trip: sign + verify', () => {
    const kp = generateKeypair()
    const hello = signMessage({
      type: 'hello',
      payload: {
        publicKey:   Buffer.from(kp.publicKey).toString('hex'),
        displayName: 'Test Device',
      },
    }, kp)

    expect(verifyMessage(hello, hello.from)).toBe(true)
    expect(hello.type).toBe('hello')
    expect(hello.payload.displayName).toBe('Test Device')
  })
})
