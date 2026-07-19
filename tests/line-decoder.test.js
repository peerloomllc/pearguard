const b4a = require('b4a')
const { createLineDecoder } = require('../src/line-decoder')

describe('createLineDecoder', () => {
  test('yields complete lines from a single chunk', () => {
    const d = createLineDecoder()
    expect(d(b4a.from('a\nb\nc\n', 'utf8'))).toEqual(['a', 'b', 'c'])
  })

  test('holds a partial line until its newline arrives', () => {
    const d = createLineDecoder()
    expect(d(b4a.from('hel', 'utf8'))).toEqual([])
    expect(d(b4a.from('lo\nwor', 'utf8'))).toEqual(['hello'])
    expect(d(b4a.from('ld\n', 'utf8'))).toEqual(['world'])
  })

  // The bug: a multi-byte UTF-8 char (é = 0xC3 0xA9) split across two chunks.
  // Per-chunk toString() produced two replacement chars; the decoder must recover é.
  test('recovers a multi-byte UTF-8 char split across chunks', () => {
    const d = createLineDecoder()
    const full = b4a.from('café\n', 'utf8') // é = 0xC3 0xA9
    const nl = b4a.indexOf(full, 0x0a)
    // Split the buffer mid-é (one byte before the newline's char): café -> caf + [0xC3] | [0xA9]\n
    const cut = nl - 1 // between the two bytes of é
    expect(d(full.subarray(0, cut))).toEqual([])
    const out = d(full.subarray(cut))
    expect(out).toEqual(['café'])
  })

  test('does not mangle unicode when a line boundary splits a chunk mid-character', () => {
    const d = createLineDecoder()
    const payload = JSON.stringify({ displayName: 'Renée 🚀', lockMessage: 'до свидания' })
    const bytes = b4a.from(payload + '\n', 'utf8')
    // Feed it one byte at a time — the worst case for chunk-boundary corruption.
    let out = []
    for (let i = 0; i < bytes.byteLength; i++) out = out.concat(d(bytes.subarray(i, i + 1)))
    expect(out).toHaveLength(1)
    expect(JSON.parse(out[0])).toEqual({ displayName: 'Renée 🚀', lockMessage: 'до свидания' })
  })

  test('handles multiple lines and a trailing partial in one chunk', () => {
    const d = createLineDecoder()
    expect(d(b4a.from('one\ntwo\nthr', 'utf8'))).toEqual(['one', 'two'])
    expect(d(b4a.from('ee\n', 'utf8'))).toEqual(['three'])
  })

  test('accepts string chunks too (defensive)', () => {
    const d = createLineDecoder()
    expect(d('x\ny\n')).toEqual(['x', 'y'])
  })

  test('emits empty strings for blank lines (caller filters them)', () => {
    const d = createLineDecoder()
    expect(d(b4a.from('\n\na\n', 'utf8'))).toEqual(['', '', 'a'])
  })
})
