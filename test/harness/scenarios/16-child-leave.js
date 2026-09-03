// A child device can free itself when the parent is gone for good, but only with
// a parent's PIN and only after a countdown the parent is told about and can
// cancel. See proposals/2026-09-03-child-initiated-leave.md.
module.exports = {
  name: 'child-leave',
  async run (lib, log) {
    const { spawnInstance, call, waitEvent, init, teardown } = lib
    const parent = spawnInstance('parent')
    const child = spawnInstance('child')
    try {
      const [, c] = await Promise.all([init(parent, true), init(child, true)])
      const childPub = c.data.publicKey
      await call(parent, 'setMode', ['parent'])
      await call(child, 'setMode', ['child'])
      await call(parent, 'identity:setName', { name: 'Daddy' })
      await call(child, 'identity:setName', { name: 'Sam' })
      const invite = await call(parent, 'invite:generate')
      const paired = Promise.all([
        waitEvent(parent, (m) => m.event === 'peer:paired', 90000),
        waitEvent(child, (m) => m.event === 'peer:paired', 90000),
      ])
      await call(child, 'acceptInvite', [invite.inviteLink])
      await paired
      // A PIN has to exist before any of this means anything.
      await call(parent, 'pin:set', { pin: '4321' })
      await new Promise((r) => setTimeout(r, 3000))

      // A wrong PIN gets nowhere.
      const refused = await call(child, 'leave:request', { pin: '0000' })
      log('wrong PIN:', JSON.stringify(refused))
      if (refused.ok !== false) throw new Error('a wrong PIN scheduled a leave')
      if ((await call(child, 'leave:status')).scheduled) throw new Error('a wrong PIN left something scheduled')

      // The right one schedules it, and the parent hears about it.
      const scheduledOnParent = waitEvent(parent, (m) => m.event === 'child:leaveScheduled', 20000)
      const req = await call(child, 'leave:request', { pin: '4321' })
      if (!req.ok) throw new Error('the correct PIN was refused: ' + JSON.stringify(req))
      const ev = await scheduledOnParent
      log('parent was told, effective', new Date(ev.data.effectiveAt).toISOString().slice(11, 19), 'for', ev.data.childDisplayName)
      if (ev.data.effectiveAt !== req.effectiveAt) throw new Error('the parent was told a different time')

      // Nothing happens yet: the child is still paired and still enforced.
      const status = await call(child, 'leave:status')
      log('child countdown:', Math.round(status.msRemaining / 3600000) + 'h left, needs', Math.round(status.observedRequiredMs / 60000) + 'min of real running')
      if (status.msRemaining < 23 * 3600000) throw new Error('the countdown is too short')
      const home = await call(child, 'child:homeData')
      if (!home.hasPolicy) throw new Error('the child stopped being supervised immediately')

      // The parent sees it on the child card and calls it off.
      const listed = (await call(parent, 'children:list')).find((x) => x.publicKey === childPub) || {}
      if (!(listed.leaveEffectiveAt > Date.now())) throw new Error('the child card does not show the pending leave')
      const cancelledOnChild = waitEvent(child, (m) => m.event === 'leave:cancelled', 20000)
      await call(parent, 'child:cancelLeave', { childPublicKey: childPub })
      const cancelEv = await cancelledOnChild
      log('parent cancelled it; the child was told by', cancelEv.data.by)
      if (cancelEv.data.by !== 'parent') throw new Error('the cancel did not come from the parent')
      if ((await call(child, 'leave:status')).scheduled) throw new Error('the child still has a leave scheduled')
      const after = (await call(parent, 'children:list')).find((x) => x.publicKey === childPub) || {}
      if (after.leaveEffectiveAt) throw new Error('the parent still shows a pending leave')

      // And the child can cancel its own, with the PIN.
      await call(child, 'leave:request', { pin: '4321' })
      const wrongCancel = await call(child, 'leave:cancel', { pin: '1111' })
      if (wrongCancel.ok !== false) throw new Error('a wrong PIN cancelled the leave')
      if (!(await call(child, 'leave:status')).scheduled) throw new Error('a wrong cancel PIN cleared it anyway')
      const ownCancel = await call(child, 'leave:cancel', { pin: '4321' })
      if (!ownCancel.ok) throw new Error('the child could not cancel with the right PIN')
      log('child cancelled its own with the PIN')

      // Last, because it deliberately locks the screen: guessing costs the same
      // ladder the block screen uses. Five free tries, then a wait that neither
      // the correct PIN nor further guesses can shorten.
      let locked = null
      for (let i = 0; i < 6; i++) locked = await call(child, 'leave:request', { pin: '0000' })
      log('after six wrong tries:', JSON.stringify(locked))
      if (!(locked.lockedForMs > 0)) throw new Error('six wrong PINs did not lock the leave screen')
      const rightWhileLocked = await call(child, 'leave:request', { pin: '4321' })
      if (rightWhileLocked.ok !== false || rightWhileLocked.reason !== 'locked') {
        throw new Error('the correct PIN was accepted while locked out: ' + JSON.stringify(rightWhileLocked))
      }
      if ((await call(child, 'leave:status')).scheduled) throw new Error('a locked-out guess still scheduled a leave')
      const stillLocked = await call(child, 'leave:status')
      log('the correct PIN is refused while locked;', Math.round(stillLocked.lockedForMs / 1000) + 's left to wait')
      if (!(stillLocked.lockedForMs > 0)) throw new Error('leave:status does not report the wait')
    } finally {
      teardown([parent, child])
    }
  },
}
