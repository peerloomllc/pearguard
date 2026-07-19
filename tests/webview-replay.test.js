const { ReplayBuffer, DEFAULT_CAP } = require('../src/webview-replay')

describe('ReplayBuffer', () => {
  test('assigns monotonically increasing seq starting at 1', () => {
    const b = new ReplayBuffer()
    expect(b.record('a', {}).seq).toBe(1)
    expect(b.record('b', {}).seq).toBe(2)
    expect(b.record('c', {}).seq).toBe(3)
    expect(b.lastSeq).toBe(3)
  })

  test('record returns the tagged record with event and data', () => {
    const b = new ReplayBuffer()
    const rec = b.record('peer:paired', { publicKey: 'abc' })
    expect(rec).toEqual({ seq: 1, event: 'peer:paired', data: { publicKey: 'abc' } })
  })

  test('replay() returns all buffered events oldest-first', () => {
    const b = new ReplayBuffer()
    b.record('a', 1)
    b.record('b', 2)
    b.record('c', 3)
    expect(b.replay().map((e) => e.event)).toEqual(['a', 'b', 'c'])
  })

  test('replay() returns a copy, not the internal array', () => {
    const b = new ReplayBuffer()
    b.record('a', 1)
    const snap = b.replay()
    snap.push({ seq: 999, event: 'x', data: null })
    expect(b.size).toBe(1)
  })

  test('is bounded to cap, evicting oldest events', () => {
    const b = new ReplayBuffer(3)
    b.record('a', 1)
    b.record('b', 2)
    b.record('c', 3)
    b.record('d', 4) // evicts 'a'
    expect(b.size).toBe(3)
    expect(b.replay().map((e) => e.event)).toEqual(['b', 'c', 'd'])
    // seq keeps counting past evictions — it is not reset by trimming.
    expect(b.lastSeq).toBe(4)
    expect(b.replay().map((e) => e.seq)).toEqual([2, 3, 4])
  })

  test('replay(afterSeq) returns only events newer than afterSeq', () => {
    const b = new ReplayBuffer()
    b.record('a', 1) // seq 1
    b.record('b', 2) // seq 2
    b.record('c', 3) // seq 3
    expect(b.replay(1).map((e) => e.event)).toEqual(['b', 'c'])
    expect(b.replay(3)).toEqual([])
  })

  test('replay(0) and replay() are equivalent (fresh page catches everything)', () => {
    const b = new ReplayBuffer()
    b.record('a', 1)
    b.record('b', 2)
    expect(b.replay(0)).toEqual(b.replay())
  })

  test('a reloaded context (lastSeen resets to 0) replays the full retained window', () => {
    // Simulate: many events fire, then the WebView reloads. The RN-side buffer
    // survives the reload (module-level), the WebView-side lastSeenSeq resets to 0.
    const b = new ReplayBuffer(3)
    for (let i = 0; i < 10; i++) b.record('evt' + i, i)
    // Fresh page has applied nothing → gets every event still retained.
    const replayed = b.replay(0)
    expect(replayed.map((e) => e.event)).toEqual(['evt7', 'evt8', 'evt9'])
  })

  test('WebView-side seq dedup: applying replay then live events never double-fires', () => {
    // Model the WebView __pearEvent guard: apply only seq > lastSeen.
    const b = new ReplayBuffer()
    b.record('a', 1)
    b.record('b', 2)
    let lastSeen = 0
    const applied = []
    const apply = ({ seq, event }) => {
      if (seq <= lastSeen) return
      lastSeen = seq
      applied.push(event)
    }
    // onLoad replay of the retained window
    b.replay(0).forEach(apply)
    // a stray duplicate injection of an already-applied event is ignored
    apply({ seq: 1, event: 'a' })
    // subsequent live events advance normally
    apply(b.record('c', 3))
    expect(applied).toEqual(['a', 'b', 'c'])
  })

  test('invalid cap falls back to DEFAULT_CAP', () => {
    expect(new ReplayBuffer(0)._cap).toBe(DEFAULT_CAP)
    expect(new ReplayBuffer(-5)._cap).toBe(DEFAULT_CAP)
    expect(new ReplayBuffer(NaN)._cap).toBe(DEFAULT_CAP)
    expect(new ReplayBuffer(undefined)._cap).toBe(DEFAULT_CAP)
    expect(new ReplayBuffer(10)._cap).toBe(10)
  })
})
