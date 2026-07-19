const { pendingUninstalls } = require('../src/package-reconcile')

describe('pendingUninstalls', () => {
  test('returns policy packages that are no longer installed', () => {
    const policy = ['com.a', 'com.b', 'com.c']
    const installed = ['com.b'] // only b is still installed
    expect(pendingUninstalls(policy, installed)).toEqual(['com.a', 'com.c'])
  })

  test('accepts installed set as objects with packageName (getInstalledPackages shape)', () => {
    const policy = ['com.a', 'com.b']
    const installed = [{ packageName: 'com.b', appName: 'B' }]
    expect(pendingUninstalls(policy, installed)).toEqual(['com.a'])
  })

  test('de-duplicates the policy list', () => {
    expect(pendingUninstalls(['com.a', 'com.a', 'com.b'], [])).toEqual(['com.a', 'com.b'])
  })

  test('keeps a package that is still installed (never prunes a live app)', () => {
    expect(pendingUninstalls(['com.game'], ['com.game'])).toEqual([])
  })

  test('empty policy → empty', () => {
    expect(pendingUninstalls([], ['com.a'])).toEqual([])
  })

  test('everything pruned when nothing is installed', () => {
    expect(pendingUninstalls(['com.a', 'com.b'], [])).toEqual(['com.a', 'com.b'])
  })

  test('ignores non-string / empty entries in the policy list', () => {
    expect(pendingUninstalls(['com.a', '', null, undefined, 42, 'com.b'], [])).toEqual(['com.a', 'com.b'])
  })

  test('tolerates non-array inputs', () => {
    expect(pendingUninstalls(null, null)).toEqual([])
    expect(pendingUninstalls(undefined, undefined)).toEqual([])
    expect(pendingUninstalls('nope', ['com.a'])).toEqual([])
  })

  test('handles malformed installed entries without throwing', () => {
    expect(pendingUninstalls(['com.a'], [null, {}, { packageName: '' }, 'com.a'])).toEqual([])
  })
})
