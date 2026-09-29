/**
 * Per-session guard state: cross-turn replay cache and loop-prevention
 * fingerprints. Ported from `noheadroom` (source_app/noheadroom,
 * extensions/headroom.ts), which solves the same problem for Pi: OpenCode,
 * like Pi, does not persist a `context` hook's mutations back into session
 * history, so every subsequent request resends the same large tool result
 * uncompressed. Without this module the plugin would re-call Headroom's
 * `/v1/compress` for identical content on every turn of a multi-step tool
 * loop.
 *
 * Kept free of `@opencode/plugin` for unit testing. Unlike noheadroom (one
 * process per Pi session), an OpenCode plugin instance can see multiple
 * concurrent sessions, so `index.js` keys one state object per `sessionID`
 * via `createSessionGuardState()` — this module has no concept of sessions
 * itself.
 */

import { applyCompressionResult, stableHash } from "./bridge.js"

// Bounded FIFO, not config: a safety valve, not a tunable. 512 hashes is far
// beyond a realistic reread-loop case while keeping memory bounded for long
// sessions. Mirrors noheadroom's MAX_SEEN_CANDIDATE_CONTENT_FINGERPRINTS.
const MAX_TRACKED_FINGERPRINTS = 512
// Kills rapid repeated compression attempts (e.g. several hook invocations
// for the same turn) without needing to reason about their exact cause.
const THROTTLE_MS = 3000

export function createSessionGuardState() {
  return {
    lastCompressionTime: 0,
    lastInputFingerprint: null,
    lastOutputFingerprint: null,
    lastGuardSkipCandidateFingerprint: null,
    seenCandidateContentFingerprints: new Set(),
    seenCandidateContentOrder: [],
    compressedCandidates: new Map(),
  }
}

export function shouldThrottle(state, now) {
  return now - state.lastCompressionTime < THROTTLE_MS
}

/** Identifies a specific tool-result occurrence, independent of its position in the message list. */
function candidateKey(mapping) {
  return stableHash(JSON.stringify([mapping.toolCallId ?? null, mapping.toolName ?? null, stableHash(mapping.originalText)]))
}

/**
 * Reapplies previously-validated compressed text for candidates whose exact
 * (tool call id, tool name, original text) was compressed before in this
 * session — without calling Headroom again.
 *
 * @returns {Array|undefined} the replayed messages, or `undefined` if nothing in the cache applies.
 */
export function replayCachedCandidates(state, messages, payload) {
  if (state.compressedCandidates.size === 0) return undefined

  const mappings = payload.mappings.map((mapping) => ({
    ...mapping,
    applyTo: mapping.applyTo && state.compressedCandidates.has(candidateKey(mapping)),
  }))
  const compressed = mappings.map((mapping) =>
    mapping.applyTo ? { ...mapping.converted, content: state.compressedCandidates.get(candidateKey(mapping)) } : mapping.converted,
  )

  const applied = applyCompressionResult(messages, mappings, compressed)
  return applied.ok ? applied.messages : undefined
}

/** Records validated compressions from a successful proxy round trip so later turns can replay them. */
export function recordCachedCandidates(state, payload, appliedMessages) {
  for (const mapping of payload.mappings) {
    if (!mapping.applyTo) continue
    const part = appliedMessages[mapping.messageIndex]?.content?.[mapping.partIndex]
    if (!part || part.type !== "tool-result" || part.result?.type !== "text") continue
    const text = part.result.value
    if (text === mapping.originalText) continue

    state.compressedCandidates.set(candidateKey(mapping), text)
    if (state.compressedCandidates.size > MAX_TRACKED_FINGERPRINTS) {
      state.compressedCandidates.delete(state.compressedCandidates.keys().next().value)
    }
  }
}

/** True once every current candidate's original text has already been seen (and rejected or replayed) before. */
export function allCandidateContentSeen(state, payload) {
  const seen = state.seenCandidateContentFingerprints
  const hashes = payload.mappings.filter((mapping) => mapping.applyTo).map((mapping) => stableHash(mapping.originalText))
  return hashes.length > 0 && hashes.every((hash) => seen.has(hash))
}

/** Mutates `payload.mappings` in place, excluding already-seen candidates from this round's proxy request. */
export function ignoreSeenCandidateContent(state, payload) {
  const seen = state.seenCandidateContentFingerprints
  for (const mapping of payload.mappings) {
    if (mapping.applyTo && seen.has(stableHash(mapping.originalText))) mapping.applyTo = false
  }
}

export function recordSeenCandidateContent(state, payload, appliedMessages) {
  for (const mapping of payload.mappings) {
    if (!mapping.applyTo) continue
    addSeenHash(state, stableHash(mapping.originalText))
    const part = appliedMessages[mapping.messageIndex]?.content?.[mapping.partIndex]
    if (part?.type === "tool-result" && part.result?.type === "text") addSeenHash(state, stableHash(part.result.value))
  }
}

function addSeenHash(state, hash) {
  if (state.seenCandidateContentFingerprints.has(hash)) return
  state.seenCandidateContentFingerprints.add(hash)
  state.seenCandidateContentOrder.push(hash)
  while (state.seenCandidateContentOrder.length > MAX_TRACKED_FINGERPRINTS) {
    const oldest = state.seenCandidateContentOrder.shift()
    state.seenCandidateContentFingerprints.delete(oldest)
  }
}

/** Fingerprints only the candidates eligible this round, so unrelated conversation growth doesn't defeat the guard below. */
export function generateCandidateFingerprint(payload) {
  const units = payload.mappings
    .filter((mapping) => mapping.applyTo)
    .map((mapping) => ({
      messageIndex: mapping.messageIndex,
      partIndex: mapping.partIndex,
      toolCallId: mapping.toolCallId ?? null,
      toolName: mapping.toolName ?? null,
      textLength: mapping.originalText.length,
      textHash: stableHash(mapping.originalText),
    }))
  return stableHash(JSON.stringify(units))
}
