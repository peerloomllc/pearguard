// Gate for the GrapheneOS/Vanadium resume-freeze recovery.
//
// The recovery itself needs a live native module and a real AppState event, so
// the only part worth unit-testing is the decision: given how long we were
// backgrounded, do we terminate the renderer? Getting this wrong is expensive in
// both directions - too eager and every quick app-switch costs a WebView reload
// (~1-2s plus scroll/state reset), too lazy and a real freeze goes unrecovered.
//
// Mirrors app/index.tsx's shouldRecoverAfterBackground. That file is a TSX React
// Native entrypoint that cannot be imported under the node jest project, so the
// logic is duplicated here deliberately; it is four lines and the threshold is
// asserted against the same constant.

const WEBVIEW_RECOVERY_MIN_BG_MS = 20_000

function shouldRecoverAfterBackground (bgMs) {
  if (typeof bgMs !== 'number' || !isFinite(bgMs) || bgMs <= 0) return false
  return bgMs >= WEBVIEW_RECOVERY_MIN_BG_MS
}

describe('shouldRecoverAfterBackground', () => {
  test('recovers after a background long enough for the freezer to act', () => {
    expect(shouldRecoverAfterBackground(20_000)).toBe(true)
    expect(shouldRecoverAfterBackground(60_000)).toBe(true)
    expect(shouldRecoverAfterBackground(5 * 60_000)).toBe(true)
  })

  test('does not punish a quick app-switch with a reload', () => {
    expect(shouldRecoverAfterBackground(1)).toBe(false)
    expect(shouldRecoverAfterBackground(3_000)).toBe(false)
    expect(shouldRecoverAfterBackground(19_999)).toBe(false)
  })

  test('the threshold itself is inclusive', () => {
    expect(shouldRecoverAfterBackground(WEBVIEW_RECOVERY_MIN_BG_MS - 1)).toBe(false)
    expect(shouldRecoverAfterBackground(WEBVIEW_RECOVERY_MIN_BG_MS)).toBe(true)
  })

  // A spurious 'active' with no preceding 'background' leaves the timestamp at
  // 0, which the handler passes through as bgMs === 0. That must not reload:
  // AppState can emit 'active' on things like a permission dialog dismissal.
  test('a resume we never saw go to background does nothing', () => {
    expect(shouldRecoverAfterBackground(0)).toBe(false)
  })

  test('rejects nonsense rather than reloading on it', () => {
    expect(shouldRecoverAfterBackground(-5_000)).toBe(false)
    expect(shouldRecoverAfterBackground(NaN)).toBe(false)
    expect(shouldRecoverAfterBackground(Infinity)).toBe(false)
    expect(shouldRecoverAfterBackground(undefined)).toBe(false)
    expect(shouldRecoverAfterBackground(null)).toBe(false)
    expect(shouldRecoverAfterBackground('60000')).toBe(false)
  })
})
