// src/bare-dispatch.js
//
// Pure method dispatch table for the Bare worklet.
// Separated from IPC wiring so it can be unit tested in Node/jest.
// src/bare.js imports this and wires it to BareKit.IPC.

/**
 * Create a dispatch function bound to the given context (db, swarm, etc.)
 * @param {object} ctx — { db, identity, swarm, peers }
 * @returns {(method: string, args: any[]) => Promise<any>}
 */
function createDispatch (ctx) {
  return async function dispatch (method, args) {
    switch (method) {
      case 'ping':
        return 'pong'

      case 'setMode': {
        const newMode = args[0]
        if (newMode !== 'parent' && newMode !== 'child') {
          throw new Error('invalid mode: must be "parent" or "child"')
        }
        await ctx.db.put('mode', newMode)
        ctx.mode = newMode
        return newMode
      }

      case 'getMode': {
        const stored = await ctx.db.get('mode')
        return stored ? stored.value : null
      }

      default:
        throw new Error('unknown method: ' + method)
    }
  }
}

module.exports = { createDispatch }
