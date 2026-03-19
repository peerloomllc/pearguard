// Tests for the callBare IPC helper — loaded after jest.setup.js mocks postMessage

describe('callBare IPC helper', () => {
  beforeEach(() => {
    // Re-import a fresh copy of the module side-effects by resetting modules
    jest.resetModules();
    window.ReactNativeWebView = { postMessage: jest.fn() };
    // Re-run main.jsx side-effects (globals) by requiring it directly
    require('../main.jsx');
  });

  test('callBare sends a JSON message with id, method, args', () => {
    window.callBare('identity:getMode', {});
    expect(window.ReactNativeWebView.postMessage).toHaveBeenCalledTimes(1);
    const msg = JSON.parse(window.ReactNativeWebView.postMessage.mock.calls[0][0]);
    expect(msg).toMatchObject({ method: 'identity:getMode', args: {} });
    expect(typeof msg.id).toBe('number');
  });

  test('callBare resolves when __pearResponse is called with matching id', async () => {
    const promise = window.callBare('identity:getMode', {});
    const msg = JSON.parse(window.ReactNativeWebView.postMessage.mock.calls[0][0]);
    window.__pearResponse(msg.id, { mode: 'parent' });
    await expect(promise).resolves.toEqual({ mode: 'parent' });
  });

  test('callBare rejects when __pearResponse is called with an error', async () => {
    const promise = window.callBare('identity:getMode', {});
    const msg = JSON.parse(window.ReactNativeWebView.postMessage.mock.calls[0][0]);
    window.__pearResponse(msg.id, null, 'not initialized');
    await expect(promise).rejects.toThrow('not initialized');
  });

  test('onBareEvent delivers events to registered handlers', () => {
    const handler = jest.fn();
    window.onBareEvent('child:connected', handler);
    window.__pearEvent('child:connected', { publicKey: 'abc' });
    expect(handler).toHaveBeenCalledWith({ publicKey: 'abc' });
  });

  test('onBareEvent unsubscribe removes handler', () => {
    const handler = jest.fn();
    const unsub = window.onBareEvent('child:connected', handler);
    unsub();
    window.__pearEvent('child:connected', { publicKey: 'abc' });
    expect(handler).not.toHaveBeenCalled();
  });

  test('unknown __pearResponse id is silently ignored', () => {
    expect(() => window.__pearResponse(9999, { mode: 'parent' })).not.toThrow();
  });
});
