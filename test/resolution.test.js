import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Host } from "@opencode/plugin/host"

/**
 * OpenCode resolves a plugin referenced by filesystem path (explicit
 * `plugins` config entry, or `.opencode/plugins/` auto-discovery) by
 * looking for a conventional `index.*`/`server.*` file directly in that
 * directory. It does NOT read package.json's `exports` field for local
 * path references (only for plugins installed and referenced by npm
 * package name) — see @opencode/core's PluginModule.load. This test
 * exercises the real `Host.resolve`/`Host.load` used by OpenCode itself,
 * so a missing root entrypoint fails here instead of silently at runtime.
 */

const repoRoot = fileURLToPath(new URL("..", import.meta.url))

test("Host.resolve finds a server entrypoint at the plugin root", () => {
  const entrypoints = Host.resolve({ directory: repoRoot })
  assert.ok(entrypoints.server, "expected a root index.js/server.js OpenCode can resolve locally")
})

test("Host.load evaluates the resolved entrypoint into a valid plugin definition", async () => {
  const entrypoints = Host.resolve({ directory: repoRoot })
  const module = await Host.load(entrypoints.server)
  assert.equal(module.default.id, "headroom-context-compression")
  assert.equal(typeof module.default.setup, "function")
})
