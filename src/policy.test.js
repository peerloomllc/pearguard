'use strict'

const assert = require('assert')
const {
  isAppBlocked,
  isPaused,
  isScheduleActive,
  hasExceededLimit,
  hasExceededScreenTimeLimit,
  isScreenTimeExempt,
  effectiveScreenTimeLimitSeconds,
  bonusSecondsForToday,
  localDateKey,
  nextScheduleWindow,
  isSmsCallException,
} = require('./policy')

function makeDate(dayOfWeek, hour, minute) {
  const base = new Date('2024-01-07T00:00:00')
  base.setDate(base.getDate() + dayOfWeek)
  base.setHours(hour, minute, 0, 0)
  return base
}

// isScheduleActive — same-day range
{
  const schedule = { days: [1, 2, 3, 4, 5], start: '08:00', end: '15:00' }
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 8, 0)), true, 'same-day: at start')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 14, 59)), true, 'same-day: before end')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 15, 0)), false, 'same-day: at end is excluded')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 7, 59)), false, 'same-day: before start')
  assert.strictEqual(isScheduleActive(schedule, makeDate(0, 10, 0)), false, 'same-day: wrong day')
  assert.strictEqual(isScheduleActive(schedule, makeDate(6, 10, 0)), false, 'same-day: Saturday excluded')
}

// isScheduleActive — midnight-spanning range (21:00–07:00)
{
  const schedule = { days: [0, 1, 2, 3, 4, 5, 6], start: '21:00', end: '07:00' }
  assert.strictEqual(isScheduleActive(schedule, makeDate(0, 21, 0)), true, 'midnight-span: at start Sunday')
  assert.strictEqual(isScheduleActive(schedule, makeDate(0, 23, 59)), true, 'midnight-span: late night Sunday')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 0, 0)), true, 'midnight-span: midnight into Monday')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 6, 59)), true, 'midnight-span: early morning Monday')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 7, 0)), false, 'midnight-span: at end is excluded')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 12, 0)), false, 'midnight-span: midday not blocked')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 20, 59)), false, 'midnight-span: just before start')
}

// isScheduleActive — midnight-spanning, only some days
{
  const schedule = { days: [0], start: '22:00', end: '06:00' }
  assert.strictEqual(isScheduleActive(schedule, makeDate(0, 22, 0)), true, 'partial-span: Sunday night')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 5, 59)), true, 'partial-span: Monday early morning')
  assert.strictEqual(isScheduleActive(schedule, makeDate(1, 22, 0)), false, 'partial-span: Monday night not blocked')
  assert.strictEqual(isScheduleActive(schedule, makeDate(2, 5, 0)), false, 'partial-span: Tuesday morning not blocked')
}

// isScheduleActive — null/missing fields
{
  assert.strictEqual(isScheduleActive(null, makeDate(1, 10, 0)), false, 'null schedule')
  assert.strictEqual(isScheduleActive({}, makeDate(1, 10, 0)), false, 'empty schedule object')
  assert.strictEqual(
    isScheduleActive({ days: [1], start: '08:00' }, makeDate(1, 10, 0)),
    false,
    'missing end field'
  )
}

// hasExceededLimit
{
  const policy = {
    apps: {
      'com.example.tiktok': { status: 'blocked', dailyLimitSeconds: 3600 },
      'com.example.youtube': { status: 'allowed', dailyLimitSeconds: 1800 },
      'com.example.nolimit': { status: 'allowed' },
    },
  }
  assert.strictEqual(
    hasExceededLimit('com.example.youtube', policy, { 'com.example.youtube': { dailySeconds: 1800 } }),
    true,
    'exactly at limit is exceeded'
  )
  assert.strictEqual(
    hasExceededLimit('com.example.youtube', policy, { 'com.example.youtube': { dailySeconds: 1799 } }),
    false,
    'one second under limit'
  )
  assert.strictEqual(
    hasExceededLimit('com.example.tiktok', policy, { 'com.example.tiktok': { dailySeconds: 7200 } }),
    true,
    'over limit'
  )
  assert.strictEqual(
    hasExceededLimit('com.example.youtube', policy, {}),
    false,
    'no usage data for app'
  )
  assert.strictEqual(
    hasExceededLimit('com.example.nolimit', policy, { 'com.example.nolimit': { dailySeconds: 99999 } }),
    false,
    'no limit set on app'
  )
  assert.strictEqual(
    hasExceededLimit('com.example.unknown', policy, { 'com.example.unknown': { dailySeconds: 9999 } }),
    false,
    'app not in policy'
  )
  assert.strictEqual(hasExceededLimit('com.example.tiktok', null, {}), false, 'null policy')
}

// hasExceededScreenTimeLimit
{
  const policy = { dailyScreenTimeLimitSeconds: 3600 }
  assert.strictEqual(
    hasExceededScreenTimeLimit(policy, {
      'com.a': { dailySeconds: 2000 },
      'com.b': { dailySeconds: 1600 },
    }),
    true,
    'sum across apps at limit is exceeded'
  )
  assert.strictEqual(
    hasExceededScreenTimeLimit(policy, {
      'com.a': { dailySeconds: 2000 },
      'com.b': { dailySeconds: 1599 },
    }),
    false,
    'sum one second under limit'
  )
  assert.strictEqual(
    hasExceededScreenTimeLimit(policy, { 'com.a': { dailySeconds: 3600 } }),
    true,
    'single app exactly at limit'
  )
  assert.strictEqual(
    hasExceededScreenTimeLimit({ dailyScreenTimeLimitSeconds: 0 }, { 'com.a': { dailySeconds: 9999 } }),
    false,
    'zero limit means disabled'
  )
  assert.strictEqual(
    hasExceededScreenTimeLimit({}, { 'com.a': { dailySeconds: 9999 } }),
    false,
    'no limit field means disabled'
  )
  assert.strictEqual(
    hasExceededScreenTimeLimit(policy, {}),
    false,
    'no usage data'
  )
  assert.strictEqual(
    hasExceededScreenTimeLimit(policy, null),
    false,
    'null usage stats'
  )
  assert.strictEqual(
    hasExceededScreenTimeLimit(null, { 'com.a': { dailySeconds: 9999 } }),
    false,
    'null policy'
  )
}

// screenTimeExemptApps (#178)
{
  const policy = {
    dailyScreenTimeLimitSeconds: 3600,
    screenTimeExemptApps: ['org.thoughtcrime.securesms'],
  }

  assert.strictEqual(isScreenTimeExempt('org.thoughtcrime.securesms', policy), true, 'listed app is exempt')
  assert.strictEqual(isScreenTimeExempt('com.a', policy), false, 'unlisted app is not exempt')
  assert.strictEqual(isScreenTimeExempt('com.a', {}), false, 'no exempt list')
  assert.strictEqual(isScreenTimeExempt('com.a', null), false, 'null policy')

  // Exempt usage must not spend the shared budget.
  assert.strictEqual(
    hasExceededScreenTimeLimit(policy, {
      'com.a': { dailySeconds: 100 },
      'org.thoughtcrime.securesms': { dailySeconds: 5000 },
    }),
    false,
    'exempt app usage is excluded from the total'
  )
  assert.strictEqual(
    hasExceededScreenTimeLimit(policy, {
      'com.a': { dailySeconds: 3600 },
      'org.thoughtcrime.securesms': { dailySeconds: 5000 },
    }),
    true,
    'non-exempt usage alone still trips the limit'
  )

  // Once the budget is spent, exempt apps stay usable and others block.
  const spent = {
    'com.a': { dailySeconds: 3600 },
    'org.thoughtcrime.securesms': { dailySeconds: 5000 },
  }
  const now = makeDate(1, 12, 0)
  assert.strictEqual(
    isAppBlocked('org.thoughtcrime.securesms', policy, spent, now),
    false,
    'exempt app allowed after the cap is reached'
  )
  assert.strictEqual(
    isAppBlocked('com.a', policy, spent, now),
    true,
    'non-exempt app blocked after the cap is reached'
  )

  // Exemption from the total does not exempt from the app's own daily limit.
  const withOwnLimit = {
    ...policy,
    apps: { 'org.thoughtcrime.securesms': { dailyLimitSeconds: 1800 } },
  }
  assert.strictEqual(
    isAppBlocked('org.thoughtcrime.securesms', withOwnLimit, {
      'org.thoughtcrime.securesms': { dailySeconds: 1800 },
    }, now),
    true,
    'exempt app still blocked by its own per-app limit'
  )
  assert.strictEqual(
    isAppBlocked('org.thoughtcrime.securesms', withOwnLimit, {
      'org.thoughtcrime.securesms': { dailySeconds: 1799 },
    }, now),
    false,
    'exempt app under its own per-app limit is allowed'
  )
}

// general-time bonus (#179)
{
  const today = new Date(2026, 6, 9, 12, 0, 0)
  const todayKey = localDateKey(today)
  const policy = { dailyScreenTimeLimitSeconds: 3600 }

  assert.strictEqual(todayKey, '2026-07-09', 'local date key format')

  // bonusSecondsForToday
  assert.strictEqual(bonusSecondsForToday({ date: todayKey, seconds: 600 }, today), 600, 'todays bonus counts')
  assert.strictEqual(bonusSecondsForToday({ date: '2026-07-08', seconds: 600 }, today), 0, 'yesterdays bonus ignored')
  assert.strictEqual(bonusSecondsForToday({ date: '2026-07-10', seconds: 600 }, today), 0, 'future-dated bonus ignored (clock rollback)')
  assert.strictEqual(bonusSecondsForToday(null, today), 0, 'no bonus')
  assert.strictEqual(bonusSecondsForToday({ date: todayKey, seconds: 0 }, today), 0, 'zero bonus')
  assert.strictEqual(bonusSecondsForToday({ date: todayKey, seconds: -60 }, today), 0, 'negative bonus ignored')

  // effectiveScreenTimeLimitSeconds
  assert.strictEqual(effectiveScreenTimeLimitSeconds(policy, { date: todayKey, seconds: 600 }, today), 4200, 'bonus raises the cap')
  assert.strictEqual(effectiveScreenTimeLimitSeconds(policy, null, today), 3600, 'no bonus leaves cap alone')
  assert.strictEqual(effectiveScreenTimeLimitSeconds({}, { date: todayKey, seconds: 600 }, today), 0, 'no cap configured stays uncapped')

  // A spent budget reopens once the bonus lands, and closes again when spent.
  const spent = { 'com.a': { dailySeconds: 3600 } }
  assert.strictEqual(hasExceededScreenTimeLimit(policy, spent, null, today), true, 'cap reached without bonus')
  assert.strictEqual(hasExceededScreenTimeLimit(policy, spent, { date: todayKey, seconds: 600 }, today), false, 'bonus reopens the budget')
  assert.strictEqual(
    hasExceededScreenTimeLimit(policy, { 'com.a': { dailySeconds: 4200 } }, { date: todayKey, seconds: 600 }, today),
    true,
    'bonus spent too'
  )
  assert.strictEqual(hasExceededScreenTimeLimit(policy, spent, { date: '2026-07-08', seconds: 600 }, today), true, 'stale bonus does not reopen')

  // A grant tops up the budget without overriding anything else.
  assert.strictEqual(isAppBlocked('com.a', policy, spent, today, { date: todayKey, seconds: 600 }), false, 'granted time unblocks a normal app')

  const strict = {
    ...policy,
    apps: { 'com.a': { status: 'blocked' }, 'com.b': { dailyLimitSeconds: 60 } },
    schedules: [{ days: [today.getDay()], start: '00:00', end: '23:59' }],
  }
  const bonus = { date: todayKey, seconds: 600 }
  assert.strictEqual(isAppBlocked('com.a', strict, spent, today, bonus), true, 'grant does not unblock a blocked app')
  assert.strictEqual(
    isAppBlocked('com.b', strict, { 'com.b': { dailySeconds: 60 } }, today, bonus),
    true,
    'grant does not beat a per-app limit or an active schedule'
  )
}

// nextScheduleWindow — child's "bedtime at ..." hint
{
  // 2026-07-09 is a Thursday (day 4).
  const thursdayNoon = new Date(2026, 6, 9, 12, 0, 0)
  const everyDay = [0, 1, 2, 3, 4, 5, 6]

  assert.strictEqual(nextScheduleWindow(null, thursdayNoon), null, 'no schedules')
  assert.strictEqual(nextScheduleWindow([], thursdayNoon), null, 'empty schedules')

  // Upcoming tonight.
  const bedtime = [{ label: 'Bedtime', days: everyDay, start: '21:00', end: '07:00' }]
  const next = nextScheduleWindow(bedtime, thursdayNoon)
  assert.strictEqual(next.active, false, 'not active at noon')
  assert.strictEqual(next.label, 'Bedtime')
  assert.strictEqual(next.at.getDate(), 9, 'starts tonight')
  assert.strictEqual(next.at.getHours(), 21, 'starts at 21:00')

  // Inside an overnight window, before midnight: ends tomorrow morning.
  const thursday22 = new Date(2026, 6, 9, 22, 0, 0)
  const active = nextScheduleWindow(bedtime, thursday22)
  assert.strictEqual(active.active, true, 'active at 22:00')
  assert.strictEqual(active.at.getDate(), 10, 'ends the next morning')
  assert.strictEqual(active.at.getHours(), 7, 'ends at 07:00')

  // Inside an overnight window, after midnight: ends this morning.
  const friday3am = new Date(2026, 6, 10, 3, 0, 0)
  const stillActive = nextScheduleWindow(bedtime, friday3am)
  assert.strictEqual(stillActive.active, true, 'active at 03:00')
  assert.strictEqual(stillActive.at.getDate(), 10, 'ends same morning')
  assert.strictEqual(stillActive.at.getHours(), 7, 'ends at 07:00')

  // Day-restricted schedule skips to the next matching weekday.
  const weekend = [{ label: 'Weekend lock', days: [6], start: '10:00', end: '11:00' }]
  const nextWeekend = nextScheduleWindow(weekend, thursdayNoon)
  assert.strictEqual(nextWeekend.at.getDay(), 6, 'lands on Saturday')
  assert.strictEqual(nextWeekend.at.getDate(), 11, 'this coming Saturday')

  // Soonest of several wins.
  const many = [
    { label: 'Late', days: everyDay, start: '23:00', end: '23:30' },
    { label: 'Early', days: everyDay, start: '13:00', end: '13:30' },
  ]
  assert.strictEqual(nextScheduleWindow(many, thursdayNoon).label, 'Early', 'soonest start wins')
}

// isSmsCallException
{
  const policy = {
    allowedContacts: [
      { name: 'Mom', phone: '+15551234567' },
      { name: 'Dad', phone: '+15559876543' },
    ],
  }
  assert.strictEqual(
    isSmsCallException('com.android.dialer', '+15551234567', policy),
    true,
    'known dialer + matching contact'
  )
  assert.strictEqual(
    isSmsCallException('com.google.android.apps.messaging', '+15559876543', policy),
    true,
    'known messaging + matching contact'
  )
  assert.strictEqual(
    isSmsCallException('com.samsung.android.dialer', '+15551234567', policy),
    true,
    'package contains dialer substring'
  )
  assert.strictEqual(
    isSmsCallException('com.carrier.sms', '+15551234567', policy),
    true,
    'package contains sms substring'
  )
  assert.strictEqual(
    isSmsCallException('com.example.tiktok', '+15551234567', policy),
    false,
    'non-phone app gets no exception'
  )
  assert.strictEqual(
    isSmsCallException('com.android.dialer', '+15550000000', policy),
    false,
    'contact not in allowed list'
  )
  assert.strictEqual(
    isSmsCallException('com.android.dialer', '+15551234567', {}),
    false,
    'empty allowedContacts'
  )
  assert.strictEqual(
    isSmsCallException('com.android.dialer', '+15551234567', null),
    false,
    'null policy'
  )
  assert.strictEqual(
    isSmsCallException('com.android.dialer', null, policy),
    false,
    'null contactPhone'
  )
}

// isAppBlocked — composite tests
{
  const policy = {
    apps: {
      'com.example.tiktok': { status: 'blocked', dailyLimitSeconds: 3600 },
      'com.example.youtube': { status: 'allowed', dailyLimitSeconds: 1800 },
      'com.example.pending': { status: 'pending' },
    },
    schedules: [
      { label: 'Bedtime', days: [0, 1, 2, 3, 4, 5, 6], start: '21:00', end: '07:00' },
    ],
    allowedContacts: [],
  }

  const daytime = makeDate(1, 14, 0)
  const bedtime = makeDate(1, 22, 0)

  assert.strictEqual(isAppBlocked('com.example.tiktok', policy, {}, daytime), true, 'blocked app')
  assert.strictEqual(isAppBlocked('com.example.pending', policy, {}, daytime), true, 'pending app blocked')
  assert.strictEqual(isAppBlocked('com.example.youtube', policy, {}, daytime), false, 'allowed app, daytime, no usage')
  assert.strictEqual(
    isAppBlocked('com.example.youtube', policy, { 'com.example.youtube': { dailySeconds: 1799 } }, daytime),
    false,
    'allowed app under limit'
  )
  assert.strictEqual(
    isAppBlocked('com.example.youtube', policy, { 'com.example.youtube': { dailySeconds: 1800 } }, daytime),
    true,
    'allowed app at daily limit'
  )
  assert.strictEqual(isAppBlocked('com.example.youtube', policy, {}, bedtime), true, 'allowed app during schedule block')
  assert.strictEqual(isAppBlocked('com.example.unknown', policy, {}, daytime), false, 'unknown app not in policy')
  assert.strictEqual(isAppBlocked('com.example.tiktok', null, {}, daytime), false, 'null policy never blocks')
  assert.strictEqual(isAppBlocked('com.example.tiktok', {}, {}, daytime), false, 'empty policy never blocks')
}

// isAppBlocked — cumulative screen-time cap
{
  const policy = {
    apps: { 'com.example.youtube': { status: 'allowed' } },
    dailyScreenTimeLimitSeconds: 3600,
  }
  const daytime = makeDate(1, 14, 0)

  assert.strictEqual(
    isAppBlocked('com.example.youtube', policy, { 'com.example.youtube': { dailySeconds: 1800 } }, daytime),
    false,
    'screen-time cap: under total, allowed'
  )
  assert.strictEqual(
    isAppBlocked('com.example.youtube', policy, {
      'com.example.youtube': { dailySeconds: 1800 },
      'com.example.other': { dailySeconds: 1800 },
    }, daytime),
    true,
    'screen-time cap: total at limit blocks the app'
  )
  assert.strictEqual(
    isAppBlocked('com.example.unmapped', policy, {
      'com.example.youtube': { dailySeconds: 3600 },
    }, daytime),
    true,
    'screen-time cap: blocks even apps not listed in policy'
  )
}

// isPaused + isAppBlocked — free-time / holiday pause
{
  const now = 1_000_000
  assert.strictEqual(isPaused(null, now), false, 'null policy is not paused')
  assert.strictEqual(isPaused({}, now), false, 'no pauseUntil is not paused')
  assert.strictEqual(isPaused({ pauseUntil: now + 1000 }, now), true, 'future pauseUntil is paused')
  assert.strictEqual(isPaused({ pauseUntil: now - 1000 }, now), false, 'past pauseUntil is not paused')
  assert.strictEqual(isPaused({ pauseUntil: now }, now), false, 'pauseUntil == now has expired')

  // While paused, EVERYTHING is allowed — even an explicitly blocked/pending app
  // and a bedtime schedule.
  const policy = {
    apps: {
      'com.example.tiktok': { status: 'blocked' },
      'com.example.pending': { status: 'pending' },
      'com.example.youtube': { status: 'allowed', dailyLimitSeconds: 1 },
    },
    schedules: [{ label: 'Bedtime', days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '23:59' }],
    dailyScreenTimeLimitSeconds: 1,
    pauseUntil: now + 60_000,
  }
  assert.strictEqual(isAppBlocked('com.example.tiktok', policy, {}, now), false, 'pause unblocks a blocked app')
  assert.strictEqual(isAppBlocked('com.example.pending', policy, {}, now), false, 'pause unblocks a pending app')
  assert.strictEqual(
    isAppBlocked('com.example.youtube', policy, { 'com.example.youtube': { dailySeconds: 9999 } }, now),
    false,
    'pause overrides a schedule / screen-time / daily limit'
  )

  // Once the pause expires, enforcement resumes.
  const expired = { ...policy, pauseUntil: now - 1 }
  assert.strictEqual(isAppBlocked('com.example.tiktok', expired, {}, now), true, 'expired pause re-blocks')
}

console.log('All policy.js tests passed.')
