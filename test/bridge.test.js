import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyCompressionResult,
  buildCompressionPayload,
  estimateContextTokens,
  fingerprintMessages,
  naturalizeHeadroomMarkers,
} from "../src/bridge.js"

/** Minimal OpenCode `Message` fixtures, matching @opencode/ai's shape closely enough for this logic. */
function userMessage(text) {
  return { role: "user", content: [{ type: "text", text }] }
}

function assistantMessage({ text, toolCall } = {}) {
  const content = []
  if (text) content.push({ type: "text", text })
  if (toolCall) content.push({ type: "tool-call", id: toolCall.id, name: toolCall.name, input: toolCall.input ?? {} })
  return { role: "assistant", content }
}

function toolMessage(id, name, text) {
  return { role: "tool", content: [{ type: "tool-result", id, name, result: { type: "text", value: text } }] }
}

test("buildCompressionPayload only marks large tool results as candidates", () => {
  const messages = [
    userMessage("please search this repo"),
    assistantMessage({ toolCall: { id: "call_1", name: "grep" } }),
    toolMessage("call_1", "grep", "short"),
    toolMessage("call_2", "grep", "x".repeat(3000)),
  ]

  const payload = buildCompressionPayload(messages, 2000)

  assert.equal(payload.candidateCount, 1)
  const candidate = payload.mappings.find((mapping) => mapping.applyTo)
  assert.equal(candidate.messageIndex, 3)
  assert.equal(candidate.originalText.length, 3000)
})

test("buildCompressionPayload renames tool calls by default to defeat Headroom's exclude list", () => {
  const messages = [assistantMessage({ toolCall: { id: "call_1", name: "grep" } })]
  const payload = buildCompressionPayload(messages, 2000)
  const [assistant] = payload.messages
  assert.equal(assistant.tool_calls[0].function.name, "opencode_tool_result")
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { originalToolName: "grep" })
})

test("buildCompressionPayload never sends non-text tool results (files/images)", () => {
  const messages = [
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          id: "call_1",
          name: "grep",
          result: { type: "content", value: [{ type: "file", uri: "file:///a.png", mime: "image/png" }] },
        },
      ],
    },
  ]
  const payload = buildCompressionPayload(messages, 1)
  assert.equal(payload.mappings.length, 0)
})

test("buildCompressionPayload skips system messages entirely", () => {
  const messages = [{ role: "system", content: [{ type: "text", text: "x".repeat(5000) }] }]
  const payload = buildCompressionPayload(messages, 1)
  assert.equal(payload.mappings.length, 0)
})

test("buildCompressionPayload never marks protected tools (read/write/edit/patch/skill) as candidates", () => {
  for (const name of ["read", "write", "edit", "patch", "skill", "headroom_retrieve"]) {
    const messages = [toolMessage("call_1", name, "x".repeat(5000))]
    const payload = buildCompressionPayload(messages, 2000)
    assert.equal(payload.candidateCount, 0, `expected ${name} to be protected from compression`)
    assert.equal(payload.mappings[0].applyTo, false)
  }
})

test("buildCompressionPayload still forwards protected tool results as context, just not as candidates", () => {
  const messages = [toolMessage("call_1", "read", "x".repeat(5000))]
  const payload = buildCompressionPayload(messages, 2000)
  assert.equal(payload.messages[0].content.length, 5000)
})

test("applyCompressionResult replaces only marked candidates and validates alignment", () => {
  const messages = [toolMessage("call_1", "grep", "x".repeat(3000))]
  const payload = buildCompressionPayload(messages, 2000)

  const compressed = payload.messages.map((message) => ({ ...message, content: "compressed text" }))
  const applied = applyCompressionResult(messages, payload.mappings, compressed)

  assert.equal(applied.ok, true)
  assert.equal(applied.messages[0].content[0].result.value, "compressed text")
  assert.equal(applied.appliedMessages, 1)
  assert.ok(applied.appliedTokensSaved > 0)
})

test("applyCompressionResult rejects a response that changes tool_call_id", () => {
  const messages = [toolMessage("call_1", "grep", "x".repeat(3000))]
  const payload = buildCompressionPayload(messages, 2000)
  const compressed = payload.messages.map((message) => ({ ...message, tool_call_id: "call_2" }))
  const applied = applyCompressionResult(messages, payload.mappings, compressed)
  assert.equal(applied.ok, false)
  assert.equal(applied.reason, "tool-call-id-changed")
})

test("applyCompressionResult is a no-op when nothing shrank", () => {
  const messages = [toolMessage("call_1", "grep", "x".repeat(3000))]
  const payload = buildCompressionPayload(messages, 2000)
  const applied = applyCompressionResult(messages, payload.mappings, payload.messages)
  assert.equal(applied.ok, false)
  assert.equal(applied.reason, "no-applicable-message-changed")
})

test("applyCompressionResult rejects the whole batch on an empty compressed result", () => {
  const messages = [toolMessage("call_1", "grep", "x".repeat(3000))]
  const payload = buildCompressionPayload(messages, 2000)
  const compressed = payload.messages.map((message) => ({ ...message, content: "   " }))
  const applied = applyCompressionResult(messages, payload.mappings, compressed)
  assert.equal(applied.ok, false)
  assert.equal(applied.reason, "empty-compressed-content")
})

test("applyCompressionResult skips a single candidate that didn't actually shrink, without rejecting the batch", () => {
  const messages = [
    toolMessage("call_1", "grep", "x".repeat(3000)),
    toolMessage("call_2", "grep", "y".repeat(3000)),
  ]
  const payload = buildCompressionPayload(messages, 2000)
  const compressed = [
    { ...payload.messages[0], content: "x".repeat(3000) }, // same length: no real savings
    { ...payload.messages[1], content: "compressed" },
  ]
  const applied = applyCompressionResult(messages, payload.mappings, compressed)
  assert.equal(applied.ok, true)
  assert.equal(applied.appliedMessages, 1)
  assert.equal(applied.messages[0].content[0].result.value, "x".repeat(3000))
  assert.equal(applied.messages[1].content[0].result.value, "compressed")
})

test("naturalizeHeadroomMarkers points the model at the headroom_retrieve tool", () => {
  const text = naturalizeHeadroomMarkers("[400 items compressed to 10. Retrieve more: hash=abc123def456]")
  assert.match(text, /headroom_retrieve/)
  assert.match(text, /hash=abc123def456/)
})

test("naturalizeHeadroomMarkers is idempotent (safe to run twice, as replay does)", () => {
  const once = naturalizeHeadroomMarkers("[400 items compressed to 10. Retrieve more: hash=abc123def456]")
  const twice = naturalizeHeadroomMarkers(once)
  assert.equal(once, twice)
})

test("fingerprintMessages is stable for identical content and changes when content changes", () => {
  const a = [toolMessage("call_1", "grep", "same text")]
  const b = [toolMessage("call_1", "grep", "same text")]
  const c = [toolMessage("call_1", "grep", "different text")]
  assert.equal(fingerprintMessages(a), fingerprintMessages(b))
  assert.notEqual(fingerprintMessages(a), fingerprintMessages(c))
})

test("estimateContextTokens grows with message content size", () => {
  const small = [toolMessage("call_1", "grep", "x".repeat(40))]
  const large = [toolMessage("call_1", "grep", "x".repeat(4000))]
  assert.ok(estimateContextTokens(large) > estimateContextTokens(small))
})
