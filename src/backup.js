// src/backup.js
//
// Pure logic for building and verifying signed export payloads.
// Two payload kinds:
//   - "device-backup" — full parent state for migrating to new hardware.
//   - "child-rules"   — single child's policy for cloning/sharing.
//
// Runs inside the Bare worklet. Takes raw data in / returns strings out;
// Hyperbee reads/writes happen in the caller.

const { sign, verify } = require('./identity')

const BACKUP_VERSION = 1
const KIND_BACKUP = 'device-backup'
const KIND_RULES = 'child-rules'

// Fields inside a policy that are device-specific and should NOT be overwritten
// when importing rules from another child.
const POLICY_DEVICE_FIELDS = ['pinHash', 'pinPlain', 'locked', 'lockMessage']

// Deterministic JSON serialization — keys sorted at every depth so that the
// bytes being signed are reproducible across export and verify.
function stableStringify (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

function hexToBuf (hex) { return Buffer.from(hex, 'hex') }
function bufToHex (buf) { return Buffer.from(buf).toString('hex') }

function signPayload (payload, identity) {
  const canonical = stableStringify(payload)
  const sig = sign(Buffer.from(canonical), hexToBuf(identity.secretKey))
  return JSON.stringify({
    payload,
    signature: bufToHex(sig),
    signerPublicKey: identity.publicKey
  })
}

/**
 * Build a signed device-backup JSON string.
 * @param {object} snapshot
 * @param {object} snapshot.identity       — { publicKey: hex, secretKey: hex }
 * @param {object|null} snapshot.profile
 * @param {object|null} snapshot.parentSettings
 * @param {Array<object>} snapshot.peers   — array of peer record values
 * @param {object} snapshot.policies       — { [childPubKeyHex]: policyObject }
 */
function buildBackup (snapshot) {
  const { identity, profile, parentSettings, peers, policies } = snapshot
  const sanitizedPolicies = {}
  for (const [childKey, policy] of Object.entries(policies || {})) {
    sanitizedPolicies[childKey] = stripPinPlain(policy)
  }
  const payload = {
    version: BACKUP_VERSION,
    kind: KIND_BACKUP,
    exportedAt: Date.now(),
    identity,
    profile: profile || null,
    parentSettings: parentSettings || null,
    peers: peers || [],
    policies: sanitizedPolicies
  }
  return signPayload(payload, identity)
}

/**
 * Build a signed child-rules JSON string.
 * @param {object} policy       — the policy:{childPubKey} value
 * @param {string} childPubKey  — hex
 * @param {object} identity     — { publicKey: hex, secretKey: hex }
 */
function buildRulesExport (policy, childPubKey, identity) {
  const stripped = stripDeviceFields(policy)
  delete stripped.childPublicKey
  const payload = {
    version: BACKUP_VERSION,
    kind: KIND_RULES,
    exportedAt: Date.now(),
    sourceChildPubKey: childPubKey,
    policy: stripped
  }
  return signPayload(payload, identity)
}

/**
 * Parse and verify a signed export. Throws on malformed input, bad signature,
 * or version/kind mismatch.
 * @param {string} jsonString
 * @param {string} [expectedKind] — optional gate
 * @returns {{ payload: object, signerPublicKey: string }}
 */
function parseAndVerify (jsonString, expectedKind) {
  let envelope
  try { envelope = JSON.parse(jsonString) } catch { throw new Error('backup: invalid JSON') }
  const { payload, signature, signerPublicKey } = envelope || {}
  if (!payload || !signature || !signerPublicKey) throw new Error('backup: missing envelope fields')
  if (payload.version !== BACKUP_VERSION) throw new Error('backup: unsupported version ' + payload.version)
  if (expectedKind && payload.kind !== expectedKind) {
    throw new Error('backup: expected ' + expectedKind + ' got ' + payload.kind)
  }
  const canonical = stableStringify(payload)
  const ok = verify(Buffer.from(canonical), hexToBuf(signature), hexToBuf(signerPublicKey))
  if (!ok) throw new Error('backup: signature verification failed')
  // For device-backup, the signer must be the embedded identity.
  if (payload.kind === KIND_BACKUP && payload.identity?.publicKey !== signerPublicKey) {
    throw new Error('backup: identity/signer mismatch')
  }
  return { payload, signerPublicKey }
}

/**
 * Compare two policies and describe what would change if `incoming` replaced
 * the apps+schedules of `current`. Used for import preview.
 */
function diffPolicies (current, incoming, installedSet) {
  const curApps = (current && current.apps) || {}
  const newApps = (incoming && incoming.apps) || {}
  const considered = (pkg) => !installedSet || installedSet.has(pkg)
  const appsAdded = []
  const appsRemoved = []
  const appsChanged = []
  const appsSkipped = []
  for (const pkg of Object.keys(newApps)) {
    if (!considered(pkg)) { appsSkipped.push(pkg); continue }
    if (!curApps[pkg]) appsAdded.push(pkg)
    else if (curApps[pkg].status !== newApps[pkg].status) appsChanged.push(pkg)
  }
  // When filtering by installed apps on the target, we never remove existing
  // target apps — apps not present in the source are simply left alone.
  if (!installedSet) {
    for (const pkg of Object.keys(curApps)) {
      if (!newApps[pkg]) appsRemoved.push(pkg)
    }
  }
  const curSchedules = (current && current.schedules) || []
  const newSchedules = (incoming && incoming.schedules) || []
  const schedulesChanged = stableStringify(curSchedules) !== stableStringify(newSchedules)
  return { appsAdded, appsRemoved, appsChanged, appsSkipped, schedulesChanged }
}

/**
 * Produce the policy to write back for a target child after importing rules
 * from another child. Replaces apps + schedules; preserves pinHash, locked,
 * lockMessage, childPublicKey.
 */
function mergeRulesIntoPolicy (targetPolicy, importedPolicy, targetChildPubKey, installedSet) {
  const base = targetPolicy || {}
  const targetApps = base.apps || {}
  const sourceApps = importedPolicy.apps || {}
  let mergedApps
  if (installedSet) {
    // Intersect mode: only apply source rules for apps installed on the target.
    // Apps installed on target that aren't in the source keep their existing
    // settings. Apps in the source not installed on target are dropped.
    mergedApps = { ...targetApps }
    for (const [pkg, app] of Object.entries(sourceApps)) {
      if (installedSet.has(pkg)) mergedApps[pkg] = { ...app, packageName: pkg }
    }
  } else {
    mergedApps = sourceApps
  }
  // Strip exemptApps in incoming schedules down to apps that survive the merge,
  // so the Exempt list on the target never references uninstalled packages.
  const allowed = new Set(Object.keys(mergedApps))
  const schedules = (importedPolicy.schedules || []).map(s => ({
    ...s,
    exemptApps: Array.isArray(s.exemptApps) ? s.exemptApps.filter(p => allowed.has(p)) : []
  }))
  return {
    ...base,
    childPublicKey: targetChildPubKey,
    apps: mergedApps,
    schedules,
    version: (base.version || 0) + 1
  }
}

function stripDeviceFields (policy) {
  const out = { ...(policy || {}) }
  for (const f of POLICY_DEVICE_FIELDS) delete out[f]
  return out
}

function stripPinPlain (policy) {
  if (!policy) return policy
  const out = { ...policy }
  delete out.pinPlain
  return out
}

module.exports = {
  BACKUP_VERSION,
  KIND_BACKUP,
  KIND_RULES,
  buildBackup,
  buildRulesExport,
  parseAndVerify,
  diffPolicies,
  mergeRulesIntoPolicy,
  stableStringify
}
