import assert from "node:assert/strict"
import { test } from "node:test"
import { DEFAULT_BASE_URL, DEFAULT_MIN_CONTEXT_TOKENS, isRemoteBlocked, resolveConfig } from "../src/config.js"

test("resolveConfig falls back to documented defaults", () => {
  const config = resolveConfig({}, {})
  assert.equal(config.enabled, true)
  assert.equal(config.baseUrl, DEFAULT_BASE_URL)
  assert.equal(config.allowRemote, false)
  assert.equal(config.renameToolCalls, true)
  assert.equal(config.minContextTokens, DEFAULT_MIN_CONTEXT_TOKENS)
  assert.equal(config.minMessageChars, 2000)
  assert.equal(config.timeoutMs, 40_000)
  assert.deepEqual(config.excludeProviders, [])
})

test("resolveConfig prefers plugin options over environment variables", () => {
  const config = resolveConfig(
    { proxyUrl: "http://127.0.0.1:9001", minMessageChars: 500 },
    { HEADROOM_PROXY_URL: "http://127.0.0.1:1111", HEADROOM_MIN_MESSAGE_CHARS: "999" },
  )
  assert.equal(config.baseUrl, "http://127.0.0.1:9001")
  assert.equal(config.minMessageChars, 500)
})

test("resolveConfig reads environment variables when options are absent", () => {
  const config = resolveConfig({}, { HEADROOM_PROXY_URL: "http://127.0.0.1:1111", HEADROOM_ENABLED: "false" })
  assert.equal(config.baseUrl, "http://127.0.0.1:1111")
  assert.equal(config.enabled, false)
})

test("isRemoteBlocked protects a non-local proxy by default", () => {
  assert.equal(isRemoteBlocked({ baseUrl: "https://headroom.example.com", allowRemote: false }), true)
  assert.equal(isRemoteBlocked({ baseUrl: "https://headroom.example.com", allowRemote: true }), false)
  assert.equal(isRemoteBlocked({ baseUrl: DEFAULT_BASE_URL, allowRemote: false }), false)
})
