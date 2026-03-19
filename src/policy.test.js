'use strict'

const assert = require('assert')
const {
  isAppBlocked,
  isScheduleActive,
  hasExceededLimit,
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

console.log('All policy.js tests passed.')
