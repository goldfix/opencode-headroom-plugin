import assert from "node:assert/strict"
import { test } from "node:test"
import plugin from "../src/index.js"

/**
 * Exercises the plugin against the real `@opencode/plugin` package, with a
 * minimal fake context and a stubbed `fetch` standing in for a running
 * `headroom proxy`.
 */

function withStubbedFetch(handler, run) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  return Promise.resolve(run()).finally(() => {
    globalThis.fetch = original
  })
}

// Tests below exercise candidate/guard/replay logic, not the total-context-size gate
// (`minContextTokens`, default 10,000) — fixtures build one small message on purpose,
// so it's disabled here and covered by its own dedicated test.
async function setupPlugin(options = { minContextTokens: 0 }) {
  const hooks = []
  const ctx = {
    options,
    session: { hook: async (name, callback) => (hooks.push({ name, callback }), { dispose: async () => {} }) },
    tool: { transform: async () => ({ dispose: async () => {} }) },
  }
  await plugin.setup(ctx)
  return hooks.find((hook) => hook.name === "context").callback
}

function toolResultEvent({ sessionID = "ses_1", providerID = "amazon-bedrock", modelID = "eu.anthropic.claude-sonnet-5", toolName = "grep", text }) {
  return {
    sessionID,
    model: { providerID, id: modelID },
    messages: [
      {
        role: "tool",
        content: [{ type: "tool-result", id: "call_1", name: toolName, result: { type: "text", value: text } }],
      },
    ],
  }
}

function stubCompress(handler) {
  return async (url, init) => {
    assert.match(String(url), /\/v1\/compress$/)
    return handler(JSON.parse(init.body))
  }
}

test("plugin.define exposes the expected id and setup signature", () => {
  assert.equal(plugin.id, "headroom-context-compression")
  assert.equal(typeof plugin.setup, "function")
})

test("setup registers a context hook and a headroom_retrieve tool", async () => {
  const hooks = []
  const tools = []
  const ctx = {
    options: {},
    session: {
      hook: async (name, callback) => {
        hooks.push({ name, callback })
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (callback) => {
        callback({ add: (definition) => tools.push(definition) })
        return { dispose: async () => {} }
      },
    },
  }

  await plugin.setup(ctx)

  assert.equal(hooks.length, 1)
  assert.equal(hooks[0].name, "context")
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, "headroom_retrieve")
})

test("context hook compresses a large tool result end to end (Bedrock scenario)", async () => {
  const contextHook = await setupPlugin()

  await withStubbedFetch(
    stubCompress((body) => {
      assert.equal(body.messages[0].role, "tool")
      return new Response(
        JSON.stringify({
          messages: [{ role: "tool", content: "compressed!", tool_call_id: "call_1" }],
          tokens_before: 1000,
          tokens_after: 5,
          tokens_saved: 995,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }),
    async () => {
      const event = toolResultEvent({ text: "x".repeat(3000) })
      await contextHook(event)
      assert.equal(event.messages[0].content[0].result.value, "compressed!")
    },
  )
})

test("context hook never compresses a protected tool (read), regardless of size", async () => {
  const contextHook = await setupPlugin()

  await withStubbedFetch(
    async () => {
      throw new Error("must not call the proxy for a protected tool")
    },
    async () => {
      const event = toolResultEvent({ toolName: "read", text: "x".repeat(5000) })
      const original = event.messages[0].content[0].result
      await contextHook(event)
      assert.equal(event.messages[0].content[0].result, original)
    },
  )
})

test("context hook leaves messages untouched when the proxy is unreachable", async () => {
  const contextHook = await setupPlugin()

  await withStubbedFetch(
    async () => {
      throw new Error("connection refused")
    },
    async () => {
      const event = toolResultEvent({ providerID: "anthropic", modelID: "claude-sonnet-4-6", text: "x".repeat(3000) })
      const original = event.messages[0].content[0].result
      await contextHook(event)
      assert.equal(event.messages[0].content[0].result, original)
    },
  )
})

test("context hook replays a cached compression on a later call without hitting the proxy again", async () => {
  const contextHook = await setupPlugin()
  let proxyCalls = 0

  await withStubbedFetch(
    stubCompress(() => {
      proxyCalls++
      return new Response(
        JSON.stringify({
          messages: [{ role: "tool", content: "compressed!", tool_call_id: "call_1" }],
          tokens_before: 1000,
          tokens_after: 5,
          tokens_saved: 995,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }),
    async () => {
      const text = "x".repeat(3000)
      const first = toolResultEvent({ text })
      await contextHook(first)
      assert.equal(first.messages[0].content[0].result.value, "compressed!")
      assert.equal(proxyCalls, 1)

      // OpenCode doesn't persist the mutation, so the next call resends the same original text.
      const second = toolResultEvent({ sessionID: first.sessionID, text })
      await contextHook(second)
      assert.equal(second.messages[0].content[0].result.value, "compressed!")
      assert.equal(proxyCalls, 1, "the cached compression should be replayed without a second proxy call")
    },
  )
})

test("context hook skips compression below the total-context-size gate (minContextTokens)", async () => {
  const contextHook = await setupPlugin({}) // default minContextTokens (10,000)

  await withStubbedFetch(
    async () => {
      throw new Error("must not call the proxy below the context-size gate")
    },
    async () => {
      const event = toolResultEvent({ text: "x".repeat(3000) }) // ~750 estimated tokens, well under the gate
      const original = event.messages[0].content[0].result
      await contextHook(event)
      assert.equal(event.messages[0].content[0].result, original)
    },
  )
})

test("context hook keeps an already-cached candidate compressed when a new candidate is sent to the proxy", async () => {
  const contextHook = await setupPlugin()
  const realNow = Date.now
  let clock = 1_000_000
  Date.now = () => clock
  const compressedIds = new Set()

  try {
    await withStubbedFetch(
      stubCompress((body) => {
        // Compress each tool result only the first time the proxy sees it; echo it unchanged afterwards.
        const messages = body.messages.map((message) => {
          if (message.role !== "tool" || compressedIds.has(message.tool_call_id)) return message
          compressedIds.add(message.tool_call_id)
          return { ...message, content: `compressed ${message.tool_call_id}` }
        })
        return new Response(JSON.stringify({ messages, tokens_before: 1000, tokens_after: 10, tokens_saved: 990 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }),
      async () => {
        const toolResult = (id, text) => ({
          role: "tool",
          content: [{ type: "tool-result", id, name: "grep", result: { type: "text", value: text } }],
        })
        const model = { providerID: "amazon-bedrock", id: "eu.anthropic.claude-sonnet-5" }

        const first = { sessionID: "ses_mixed", model, messages: [toolResult("call_1", "x".repeat(3000))] }
        await contextHook(first)
        assert.equal(first.messages[0].content[0].result.value, "compressed call_1")

        // Next turn, past the throttle window: A is resent uncompressed (not persisted), B is new.
        clock += 10_000
        const second = {
          sessionID: "ses_mixed",
          model,
          messages: [toolResult("call_1", "x".repeat(3000)), toolResult("call_2", "y".repeat(3000))],
        }
        await contextHook(second)
        assert.equal(second.messages[0].content[0].result.value, "compressed call_1", "cached candidate must stay compressed")
        assert.equal(second.messages[1].content[0].result.value, "compressed call_2")
      },
    )
  } finally {
    Date.now = realNow
  }
})

test("context hook throttles repeated compression attempts within the same session", async () => {
  const contextHook = await setupPlugin()
  let proxyCalls = 0

  await withStubbedFetch(
    stubCompress(() => {
      proxyCalls++
      return new Response(
        JSON.stringify({
          messages: [{ role: "tool", content: "compressed!", tool_call_id: "call_1" }],
          tokens_before: 1000,
          tokens_after: 5,
          tokens_saved: 995,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }),
    async () => {
      const first = toolResultEvent({ text: "x".repeat(3000) })
      await contextHook(first)
      assert.equal(proxyCalls, 1)

      // A different, still-uncompressed candidate arrives immediately after (same session): throttled.
      const second = toolResultEvent({ sessionID: first.sessionID, text: "y".repeat(3000) })
      second.messages[0].content[0].id = "call_2"
      await contextHook(second)
      assert.equal(proxyCalls, 1, "a second distinct candidate within the throttle window should not call the proxy")
    },
  )
})
