import assert from "node:assert/strict"
import { test } from "node:test"
import { buildCompressionPayload } from "../src/bridge.js"
import {
  allCandidateContentSeen,
  createSessionGuardState,
  generateCandidateFingerprint,
  ignoreSeenCandidateContent,
  recordCachedCandidates,
  recordSeenCandidateContent,
  replayCachedCandidates,
  shouldThrottle,
} from "../src/guard.js"

function toolMessage(id, name, text) {
  return { role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value: text } }] }
}

function compressAll(payload, replacementText) {
  return payload.messages.map((message) => (message.role === "tool" ? { ...message, content: replacementText } : message))
}

test("shouldThrottle blocks a second attempt within the throttle window", () => {
  const state = createSessionGuardState()
  state.lastCompressionTime = 1000
  assert.equal(shouldThrottle(state, 1500), true)
  assert.equal(shouldThrottle(state, 4001), false)
})

test("replayCachedCandidates returns undefined when nothing has been cached yet", () => {
  const state = createSessionGuardState()
  const messages = [toolMessage("call_1", "grep", "x".repeat(3000))]
  const payload = buildCompressionPayload(messages, 2000)
  assert.equal(replayCachedCandidates(state, messages, payload), undefined)
})

test("recordCachedCandidates + replayCachedCandidates reapply a validated compression without the proxy", () => {
  const state = createSessionGuardState()
  const originalText = "x".repeat(3000)
  const messages = [toolMessage("call_1", "grep", originalText)]
  const payload = buildCompressionPayload(messages, 2000)

  // Simulate a first, successful proxy round trip.
  const compressed = compressAll(payload, "compressed once")
  const appliedMessages = [{ ...messages[0], content: [{ ...messages[0].content[0], result: { type: "text", value: "compressed once" } }] }]
  recordCachedCandidates(state, payload, appliedMessages)

  // A later turn resends the same uncompressed original (OpenCode doesn't persist context mutations).
  const laterMessages = [toolMessage("call_1", "grep", originalText)]
  const laterPayload = buildCompressionPayload(laterMessages, 2000)
  const replayed = replayCachedCandidates(state, laterMessages, laterPayload)

  assert.ok(replayed)
  assert.equal(replayed[0].content[0].result.value, "compressed once")
  void compressed
})

test("replayCachedCandidates does not replay when the tool call id changed", () => {
  const state = createSessionGuardState()
  const originalText = "x".repeat(3000)
  const messages = [toolMessage("call_1", "grep", originalText)]
  const payload = buildCompressionPayload(messages, 2000)
  const appliedMessages = [{ ...messages[0], content: [{ ...messages[0].content[0], result: { type: "text", value: "compressed" } }] }]
  recordCachedCandidates(state, payload, appliedMessages)

  const differentCall = [toolMessage("call_2", "grep", originalText)]
  const differentPayload = buildCompressionPayload(differentCall, 2000)
  assert.equal(replayCachedCandidates(state, differentCall, differentPayload), undefined)
})

test("seen-candidate guard: allCandidateContentSeen becomes true once every candidate has been recorded", () => {
  const state = createSessionGuardState()
  const messages = [toolMessage("call_1", "grep", "x".repeat(3000))]
  const payload = buildCompressionPayload(messages, 2000)
  assert.equal(allCandidateContentSeen(state, payload), false)

  recordSeenCandidateContent(state, payload, messages)
  assert.equal(allCandidateContentSeen(state, payload), true)
})

test("ignoreSeenCandidateContent excludes only already-seen candidates from a mixed batch", () => {
  const state = createSessionGuardState()
  const seenMessages = [toolMessage("call_1", "grep", "x".repeat(3000))]
  const seenPayload = buildCompressionPayload(seenMessages, 2000)
  recordSeenCandidateContent(state, seenPayload, seenMessages)

  const mixedMessages = [toolMessage("call_1", "grep", "x".repeat(3000)), toolMessage("call_2", "grep", "y".repeat(3000))]
  const mixedPayload = buildCompressionPayload(mixedMessages, 2000)
  ignoreSeenCandidateContent(state, mixedPayload)

  assert.equal(mixedPayload.mappings[0].applyTo, false)
  assert.equal(mixedPayload.mappings[1].applyTo, true)
})

test("generateCandidateFingerprint is stable for identical candidates and changes when they differ", () => {
  const messagesA = [toolMessage("call_1", "grep", "x".repeat(3000))]
  const messagesB = [toolMessage("call_1", "grep", "y".repeat(3000))]
  const fingerprintA = generateCandidateFingerprint(buildCompressionPayload(messagesA, 2000))
  const fingerprintA2 = generateCandidateFingerprint(buildCompressionPayload(messagesA, 2000))
  const fingerprintB = generateCandidateFingerprint(buildCompressionPayload(messagesB, 2000))
  assert.equal(fingerprintA, fingerprintA2)
  assert.notEqual(fingerprintA, fingerprintB)
})
