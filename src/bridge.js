/**
 * Pure message-compression logic: converts OpenCode's provider-agnostic
 * `Message`/`ToolResultPart` shape (from `@opencode/ai`, seen in
 * `session.hook("context", ...)`) into the plain "OpenAI-shape" messages
 * Headroom's `POST /v1/compress` expects, and applies the compressed result
 * back — touching only `tool` role messages.
 *
 * Ported from `@casualjim/pi-headroom` (pi-mimir) and, for the guard rules
 * below, from its sibling fork `@raquezha/noheadroom` (both derive from
 * `@ryan_nookpi/pi-extension-headroom`, MIT) — adapted to OpenCode's message
 * model. Kept free of `@opencode/plugin` so it can be unit tested without a
 * running OpenCode server.
 */

import { createHash } from "node:crypto"

/** Only these roles ever get sent to Headroom; `system` never leaves this plugin. */
const CONVERTIBLE_ROLES = new Set(["user", "assistant", "tool"])

// File reads and structural edits (edit/patch) supply exact anchors for later
// exact-match edits; compressing their output risks corrupting those anchors,
// and `skill` output is directive text meant to be followed verbatim. Ported
// from noheadroom's `PROTECTED_TOOLS`, renamed to OpenCode's built-in tool
// names. These never become compression candidates, regardless of size —
// unlike `renameToolCalls` below, which only concerns tools we DO allow to
// compress but still want to shield from Headroom's own default exclusions.
const PROTECTED_TOOLS = new Set(["read", "write", "edit", "patch", "skill", "headroom_retrieve"])

/**
 * @param {Array} messages - `event.messages` from the `context` hook.
 * @param {number} minMessageChars - skip tool results shorter than this.
 * @param {{ renameToolCalls?: boolean }} [options]
 */
export function buildCompressionPayload(messages, minMessageChars, options = {}) {
  const renameToolCalls = options.renameToolCalls !== false
  const mappings = []

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex++) {
    const message = messages[messageIndex]
    if (!CONVERTIBLE_ROLES.has(message.role)) continue

    if (message.role === "tool") {
      const parts = Array.isArray(message.content) ? message.content : []
      for (let partIndex = 0; partIndex < parts.length; partIndex++) {
        const part = parts[partIndex]
        if (!part || part.type !== "tool-result") continue
        const text = extractToolResultText(part)
        // `null` means the result carries non-text content (files/images) or
        // an error — never compressed, never even sent to Headroom.
        if (text === null) continue
        mappings.push({
          messageIndex,
          partIndex,
          toolCallId: part.id,
          toolName: part.name,
          applyTo: !PROTECTED_TOOLS.has(part.name) && text.length >= minMessageChars,
          originalText: text,
          converted: { role: "tool", content: text, tool_call_id: part.id },
        })
      }
      continue
    }

    const converted = message.role === "user" ? convertUser(message) : convertAssistant(message, renameToolCalls)
    if (!converted) continue
    mappings.push({
      messageIndex,
      partIndex: -1,
      toolCallId: undefined,
      toolName: undefined,
      applyTo: false,
      originalText: extractText(converted),
      converted,
    })
  }

  return {
    messages: mappings.map((mapping) => mapping.converted),
    mappings,
    candidateCount: mappings.filter((mapping) => mapping.applyTo).length,
  }
}

/**
 * Applies Headroom's compressed messages back onto the original OpenCode
 * messages, touching only entries marked `applyTo`. Anything Headroom
 * changed outside those entries (it may rewrite context for its own
 * cross-message analysis) is ignored — the original message is kept as is.
 */
export function applyCompressionResult(messages, mappings, compressedMessages) {
  if (!Array.isArray(compressedMessages) || compressedMessages.length !== mappings.length) {
    return { ok: false, reason: "message-count-changed" }
  }

  const next = messages.slice()
  let appliedMessages = 0
  let tokensBefore = 0
  let tokensAfter = 0

  for (let index = 0; index < mappings.length; index++) {
    const mapping = mappings[index]
    if (!mapping.applyTo) continue

    const compressed = compressedMessages[index]
    if (!compressed || compressed.role !== "tool") return { ok: false, reason: "role-changed" }
    if (compressed.tool_call_id !== mapping.converted.tool_call_id) return { ok: false, reason: "tool-call-id-changed" }

    const rawText = typeof compressed.content === "string" ? compressed.content : mapping.originalText
    if (rawText === mapping.originalText) continue

    const nextText = naturalizeHeadroomMarkers(rawText)
    // Reject the whole batch on an empty result: it is never a legitimate
    // compression outcome and likely signals a malformed proxy response.
    if (!nextText.trim()) return { ok: false, reason: "empty-compressed-content" }
    // A single candidate that didn't actually shrink is skipped on its own —
    // it does not invalidate the other candidates in this batch.
    if (estimateTokens(nextText) >= estimateTokens(mapping.originalText)) continue

    const original = next[mapping.messageIndex]
    const originalPart = Array.isArray(original.content) ? original.content[mapping.partIndex] : undefined
    if (!originalPart || originalPart.type !== "tool-result") return { ok: false, reason: "target-unreplaceable" }

    const nextContent = original.content.slice()
    nextContent[mapping.partIndex] = { ...originalPart, result: { type: "text", value: nextText } }
    next[mapping.messageIndex] = { ...original, content: nextContent }

    tokensBefore += estimateTokens(mapping.originalText)
    tokensAfter += estimateTokens(nextText)
    appliedMessages++
  }

  if (appliedMessages === 0) return { ok: false, reason: "no-applicable-message-changed" }
  const tokensSaved = Math.max(0, tokensBefore - tokensAfter)
  if (tokensSaved === 0) return { ok: false, reason: "no-estimated-token-savings" }

  return {
    ok: true,
    messages: next,
    appliedMessages,
    appliedTokensBefore: tokensBefore,
    appliedTokensAfter: tokensAfter,
    appliedTokensSaved: tokensSaved,
    appliedCompressionRatio: tokensAfter / tokensBefore,
  }
}

/**
 * Headroom's bracket markers carry the CCR hash. Keep the hash and name the
 * tool that redeems it, so the model doesn't need an MCP server to resolve
 * "Retrieve more: hash=...]" — our own `headroom_retrieve` tool does it.
 * Idempotent: running it on already-naturalized text is a no-op (the
 * rewritten phrasing no longer matches the source markers), which matters
 * because replayed/cached text has already passed through this once.
 */
export function naturalizeHeadroomMarkers(text) {
  return text
    .replace(
      /\[(.*?(?:compressed|omitted).*?)\.?\s*Retrieve (?:more|original): hash=([a-f0-9]{12,24})\]/gi,
      "[$1. Retrieve the full original with the `headroom_retrieve` tool using hash=$2.]",
    )
    .replace(
      /Retrieve original: hash=([a-f0-9]{12,24})/gi,
      "Retrieve the full original with the `headroom_retrieve` tool using hash=$1",
    )
}

/**
 * Deterministic per-message fingerprint of the whole `event.messages` array,
 * used by `guard.js` to detect an unchanged or already-compressed context
 * without re-running the (more expensive) compression payload build.
 */
export function fingerprintMessages(messages) {
  return messages.map((message) => `${message.role}:${stableHash(fingerprintText(message)).slice(0, 16)}`).join(",")
}

/** Rough total context size, used to gate compression on small sessions where it isn't worth a proxy round trip. */
export function estimateContextTokens(messages) {
  return messages.reduce((total, message) => total + estimateTokens(fingerprintText(message)), 0)
}

export function stableHash(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function estimateTokens(text) {
  // Cheap local estimate; an exact tokenizer would add a heavy dependency for a footer number.
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4))
}

function fingerprintText(message) {
  if (message.role === "tool") {
    const parts = Array.isArray(message.content) ? message.content : []
    return parts
      .map((part) => (part?.type === "tool-result" ? `${part.id}:${extractToolResultText(part) ?? ""}` : ""))
      .join("|")
  }
  if (message.role === "user") return joinTextParts(message.content)
  if (message.role === "assistant") {
    const parts = Array.isArray(message.content) ? message.content : []
    const toolCallIds = parts
      .filter((part) => part?.type === "tool-call")
      .map((part) => part.id)
      .join(",")
    return `${joinTextParts(parts)}#${toolCallIds}`
  }
  return ""
}

function extractToolResultText(part) {
  const result = part.result
  if (!result) return null
  if (result.type === "text") return typeof result.value === "string" ? result.value : safeStringify(result.value)
  if (result.type === "json") return safeStringify(result.value)
  if (result.type === "content") {
    const items = Array.isArray(result.value) ? result.value : []
    // A file/image tool result loses meaning as text; leave it untouched
    // rather than risk destroying an attachment.
    if (items.some((item) => item?.type !== "text")) return null
    return items.map((item) => item.text).join("\n")
  }
  return null // "error" results are left untouched
}

function convertUser(message) {
  const text = joinTextParts(message.content)
  if (text) return { role: "user", content: text }
  const hasMedia = Array.isArray(message.content) && message.content.some((part) => part?.type === "media")
  return hasMedia ? { role: "user", content: "[media omitted from Headroom compression payload]" } : null
}

function convertAssistant(message, renameToolCalls) {
  const parts = Array.isArray(message.content) ? message.content : []
  const text = joinTextParts(parts)
  const toolCalls = parts.filter((part) => part?.type === "tool-call")
  if (!text && toolCalls.length === 0) return null

  const converted = { role: "assistant", content: text || null }
  if (toolCalls.length > 0) {
    converted.tool_calls = toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        // Headroom protects exact tool names (read, grep, ...) from compression
        // via its DEFAULT_EXCLUDE_TOOLS; a neutral name keeps large results compressible
        // for tools we allow to compress (PROTECTED_TOOLS above blocks the rest regardless).
        name: renameToolCalls ? "opencode_tool_result" : call.name,
        arguments: renameToolCalls ? JSON.stringify({ originalToolName: call.name }) : JSON.stringify(call.input ?? {}),
      },
    }))
  }
  return converted
}

function joinTextParts(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n")
}

function extractText(converted) {
  if (typeof converted.content === "string") return converted.content
  return ""
}

function safeStringify(value) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
