/**
 * OpenCode v2 plugin: transparent Headroom context compression.
 *
 * Hooks `session.hook("context", ...)` — the provider-agnostic message list
 * OpenCode assembles immediately before dispatching to the model, *before*
 * any provider-specific lowering (Anthropic Messages, OpenAI Chat, Bedrock
 * Converse, ...) or request signing happens. Only `tool` role messages are
 * sent to Headroom's stateless `POST /v1/compress` for compression; user and
 * assistant text are never touched, and PROTECTED_TOOLS (see bridge.js) are
 * never candidates regardless of size. Because this runs above the wire
 * protocol, it works identically for every provider OpenCode supports —
 * including AWS Bedrock, whose native Converse API and SigV4-signed
 * requests made an earlier `http.request`-based approach unworkable (see
 * MEMORY.md).
 *
 * The guard/replay logic in guard.js follows `noheadroom`
 * (source_app/noheadroom): a cross-turn cache avoids recompressing the same
 * tool result on every step of a multi-step turn (OpenCode doesn't persist
 * `context` mutations into history, so the uncompressed original reappears
 * on the next call), and fingerprint guards throttle/skip redundant proxy
 * calls when the eligible content hasn't changed.
 *
 * Prerequisite: `headroom proxy` must already be running and reachable.
 * This plugin never starts, stops, or otherwise manages that process.
 *
 * @see https://docs.headroomlabs.ai/docs/proxy#post-v1compress
 * @see https://opencode.ai/v2/docs/build/plugins
 */
import { Plugin } from "@opencode/plugin"
import { applyCompressionResult, buildCompressionPayload, estimateContextTokens, fingerprintMessages } from "./bridge.js"
import { HeadroomClient } from "./client.js"
import { isRemoteBlocked, resolveConfig } from "./config.js"
import {
  allCandidateContentSeen,
  createSessionGuardState,
  generateCandidateFingerprint,
  ignoreSeenCandidateContent,
  recordCachedCandidates,
  recordSeenCandidateContent,
  replayCachedCandidates,
  shouldThrottle,
} from "./guard.js"

// Bounds memory if a server process outlives many short-lived sessions; the least recently
// used session is evicted first, well before this is ever reached in normal interactive use.
const MAX_TRACKED_SESSIONS = 200

export default Plugin.define({
  id: "headroom-context-compression",
  async setup(ctx) {
    const config = resolveConfig(ctx.options, process.env)
    const client = new HeadroomClient({ baseUrl: config.baseUrl, timeoutMs: config.timeoutMs })
    const sessionStates = new Map()
    let proxyWarningShown = false

    if (config.enabled && isRemoteBlocked(config)) {
      console.warn(
        `[headroom] Compression disabled: ${config.baseUrl} is not local and "allowRemote" is not set. ` +
          "Tool results would be sent to that proxy in full before compression. Set options.allowRemote to true only for a trusted proxy.",
      )
    }

    await ctx.session.hook("context", async (event) => {
      if (!config.enabled || isRemoteBlocked(config)) return
      if (config.excludeProviders.includes(event.model.providerID)) return
      if (estimateContextTokens(event.messages) < config.minContextTokens) return

      const state = sessionStateFor(sessionStates, event.sessionID)
      const payload = buildCompressionPayload(event.messages, config.minMessageChars, {
        renameToolCalls: config.renameToolCalls,
      })
      const replayed = replayCachedCandidates(state, event.messages, payload)
      const bypass = () => replaceMessages(event, replayed)

      if (payload.candidateCount === 0) return bypass()

      const now = Date.now()
      if (shouldThrottle(state, now)) return bypass()

      const inputFingerprint = fingerprintMessages(event.messages)
      // Our own compressed output looping back as next-turn input: nothing new to do, and no replay needed.
      if (state.lastOutputFingerprint === inputFingerprint) return
      if (state.lastInputFingerprint === inputFingerprint) return bypass()

      const candidateFingerprint = generateCandidateFingerprint(payload)
      if (state.lastGuardSkipCandidateFingerprint === candidateFingerprint) return bypass()
      if (allCandidateContentSeen(state, payload)) return bypass()
      ignoreSeenCandidateContent(state, payload)

      state.lastCompressionTime = now
      let result
      try {
        result = await client.compress(payload.messages, event.model.id)
      } catch (error) {
        if (!proxyWarningShown) {
          proxyWarningShown = true
          console.warn(
            `[headroom] compression skipped, proxy unavailable at ${config.baseUrl} (further failures are silent until it recovers): ` +
              (error instanceof Error ? error.message : String(error)),
          )
        }
        return bypass()
      }
      proxyWarningShown = false
      if (!result.tokensSaved || result.tokensSaved <= 0) {
        state.lastInputFingerprint = inputFingerprint
        state.lastGuardSkipCandidateFingerprint = candidateFingerprint
        return bypass()
      }

      // Apply on top of the replayed messages, not the originals: candidates excluded from this
      // round by ignoreSeenCandidateContent are the ones already compressed (and cached) earlier,
      // and must stay compressed. noheadroom stitches the same replayed values back in.
      const applied = applyCompressionResult(replayed ?? event.messages, payload.mappings, result.messages)
      if (!applied.ok) {
        state.lastInputFingerprint = inputFingerprint
        state.lastOutputFingerprint = null
        state.lastGuardSkipCandidateFingerprint = candidateFingerprint
        console.warn(`[headroom] compression not applied: ${applied.reason}`)
        return bypass()
      }

      state.lastInputFingerprint = inputFingerprint
      state.lastGuardSkipCandidateFingerprint = null
      recordSeenCandidateContent(state, payload, applied.messages)
      recordCachedCandidates(state, payload, applied.messages)
      state.lastOutputFingerprint = fingerprintMessages(applied.messages)
      replaceMessages(event, applied.messages)
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "headroom_retrieve",
        description:
          "Retrieve the full original content that Headroom compressed. Use the exact hash from a compression " +
          "marker (e.g. `Retrieve more: hash=...`) in a tool result.",
        input: {
          type: "object",
          properties: { hash: { type: "string", description: "The compression marker hash (12-24 hex characters)." } },
          required: ["hash"],
          additionalProperties: false,
        },
        execute: async ({ hash }, toolContext) => {
          const normalized = String(hash ?? "").trim().toLowerCase()
          if (!/^[a-f0-9]{12,24}$/.test(normalized)) {
            return { content: JSON.stringify({ error: "Invalid hash format. Expected 12-24 hex characters." }) }
          }
          const result = await client.retrieve(normalized, toolContext?.signal)
          return { content: result.ok ? result.content : JSON.stringify({ error: result.error, hash: normalized }) }
        },
      })
    })
  },
})

function sessionStateFor(sessionStates, sessionID) {
  const existing = sessionStates.get(sessionID)
  if (existing) {
    // Re-insert to mark as most recently used, so eviction below drops idle sessions first.
    sessionStates.delete(sessionID)
    sessionStates.set(sessionID, existing)
    return existing
  }

  if (sessionStates.size >= MAX_TRACKED_SESSIONS) {
    sessionStates.delete(sessionStates.keys().next().value)
  }
  const state = createSessionGuardState()
  sessionStates.set(sessionID, state)
  return state
}

function replaceMessages(event, messages) {
  if (!messages) return
  messages.forEach((message, index) => {
    event.messages[index] = message
  })
}
