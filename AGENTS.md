# AGENTS.md — Instructions for AI Agents (Pi-Agent)

## 1. Project goal

Explore the feasibility of, and implement, an **OpenCode v2 plugin** that **fully transparently** compresses a session's large tool results via **Headroom** (`docs-mcp-server` library `headroom`):

- no heavy edits to `opencode.json`/`opencode.jsonc` (no fake providers, no `OPENCODE_CONFIG_CONTENT`);
- the providers/models the user already configured stay exactly as they are, untouched in any way.

Headroom already ships an official `headroom-opencode` package with a `HeadroomPlugin` that routes HTTP traffic to its proxy, but it's written for **OpenCode v1** (the v1 API no longer exists in v2, see `source_app/opencode/.../build/plugins/migrate-v1`) and, even ported 1:1, it wouldn't have worked for providers like **AWS Bedrock** (see §4 — Decision history). This project builds a different mechanism, inspired by `source_app/pi-mimir/packages/pi-headroom` (a Headroom bridge for Pi-Agent), not a 1:1 port of `headroom-opencode`.

## 2. Stack and technical constraints

- **Language: plain JavaScript (ESM, `"type": "module"`)**. No TypeScript, no build step: OpenCode loads `.js` files directly.
- No runtime dependency beyond `@opencode/plugin` (Promise API, not Effect — simpler and enough for this use case).
- Tests with Node's native runner (`node --test`), zero external test frameworks.
- External prerequisite: `headroom proxy` (or `headroom wrap ...`) already running. The plugin **never** starts or manages the Headroom process: it only points traffic at it, exactly like `HeadroomPlugin` does in v1.

## 3. Project structure

```
src/
  index.js       → real entrypoint (Plugin.define + setup(ctx)): "context" hook + headroom_retrieve tool, per-session orchestration
  bridge.js       → pure conversion/compression logic (Message/ToolResultPart ↔ Headroom payload) + protected tools, no external dependencies
  guard.js        → per-session state: cross-turn replay cache, loop-guard fingerprints, throttle (ported from noheadroom), pure and testable
  client.js       → minimal HTTP client toward Headroom (POST /v1/compress, GET /v1/retrieve/{hash})
  config.js       → configuration resolution (ctx.options + env), no file persistence
index.js          → ROOT ENTRYPOINT (`export { default } from "./src/index.js"`). OpenCode resolves plugins referenced by local path by looking for an index.*/server.* file at the root — it does NOT read package.json's `exports` in that case (only for npm packages installed by name). Do not remove or move this without also updating package.json.
test/
  bridge.test.js     → unit tests on the pure conversion/compression logic, including protected tools (node:test)
  guard.test.js      → unit tests on the replay cache and loop guards
  config.test.js     → unit tests on configuration resolution
  plugin.test.js     → integration test against the real @opencode/plugin library (fetch stub)
  resolution.test.js → replicates OpenCode's real Host.resolve/Host.load against the plugin's folder
scripts/
  install.sh     → symlinks the plugin into ~/.config/opencode/plugins (global discovery)
  uninstall.sh   → removes the symlink created by install.sh
source_app/opencode/ → REFERENCE CHECKOUT of the OpenCode v2 source code (READ-ONLY)
source_app/pi-mimir/ → REFERENCE CHECKOUT of pi-headroom (Pi-Agent), first porting source (READ-ONLY)
source_app/noheadroom/ → REFERENCE CHECKOUT of @raquezha/noheadroom (Pi-Agent, more mature fork, used by the user in production), source of the protected tools and replay cache (READ-ONLY)
docs/                → miscellaneous technical documentation (leftover from a previous template, not relevant to the plugin)
```

`source_app/opencode/`, `source_app/pi-mimir/`, and `source_app/noheadroom/` are **read-only reference material**: never modify or run them from here (each has its own `AGENTS.md`/conventions for its own project, not for this one).

## 4. Chosen integration mechanism (and why it changed)

**First version (discarded): `session.hook("http.request"/"http.response", ...)`** — rewrote the native HTTP request's URL to point at the Headroom proxy, leaving path/method/headers/body intact. It worked for Anthropic/OpenAI/Vertex, but **not for AWS Bedrock**: OpenCode's `amazon-bedrock` provider uses the **Converse** API (`/model/{id}/converse-stream`, not the InvokeModel that Headroom can handle) signed with **AWS SigV4** — Headroom, by compressing the body, invalidates the signature, and on top of that it has no dedicated route for that request shape. It would have needed a second hop (a re-signing gateway) just for Bedrock: not transparent, not generalizable.

**Current version: `session.hook("context", ...)`** — inspired by `source_app/pi-mimir/packages/pi-headroom` (a Headroom bridge for Pi-Agent):

- the `context` hook exposes `event.messages: Array<Message>` — the **provider-agnostic** representation OpenCode assembles before "lowering" it to the provider's native protocol (Anthropic Messages, OpenAI Chat, Bedrock Converse, ...) and **before** signing the request;
- the plugin isolates only `role: "tool"` messages (tool results, never user/assistant text), converts them into a neutral shape, and sends them to Headroom's **`POST /v1/compress`** — a stateless endpoint, it never calls the provider itself;
- the compressed text is written back into the original `ToolResultPart`, only after validating that role and `tool_call_id` haven't changed (otherwise everything is discarded, no partial changes);
- **works identically for every provider**, Bedrock included, because it never touches the native HTTP body or the signature — that happens afterward, downstream of this hook, on content that's already compressed.
- Headroom's "proxy" (traffic-routing) functionality in the strict sense is no longer needed — only the `/v1/compress` endpoint, which runs on the same `headroom proxy` process but doesn't act as a go-between for actual provider calls.
- The `headroom_retrieve` tool (registered via `ctx.tool.transform`) resolves compression markers (`hash=...`) without needing Headroom's official MCP server.

**Also adopted the approach of `source_app/noheadroom/`** (a more mature fork, used by the user in production with Pi-Agent), on top of `pi-headroom`:
- **Protected tools** (`src/bridge.js`, `PROTECTED_TOOLS`): `read`, `write`, `edit`, `patch`, `skill`, and `headroom_retrieve` never become compression candidates, regardless of size — their output serves as an anchor for later exact matches (an `edit` on text read by `read`) or is directive text (`skill`); compressing it risks breaking them. Not configurable, by design (as in `noheadroom`).
- **Additional defensive checks** in `applyCompressionResult`: reject the whole batch if the compressed text is empty; drop a single candidate (not the whole batch) if it didn't actually shrink in estimated tokens.
- **Cross-turn replay cache + fingerprint loop guards** (`src/guard.js`, state per `sessionID`): since OpenCode doesn't persist `context` mutations into history, the same large tool result would come back uncompressed on every subsequent turn of the same multi-step exchange. The cache (key: hash of tool-call-id + tool name + original text → validated compressed text) reapplies the compression already obtained without calling the proxy again; the fingerprints (`lastInputFingerprint`, `lastOutputFingerprint`, candidate-only fingerprint, "already seen" hashes with a FIFO capped at 512 entries) and a 3-second throttle avoid redundant calls when the `context` hook fires more than once for the same turn.
- **Total-context-size threshold** (`minContextTokens`, default 10,000, in `src/config.js`): below that estimated threshold it's not even worth building the payload and attempting compression — same philosophy as `noheadroom`, adapted because OpenCode's `context` hook doesn't expose a native token count like Pi's `ctx.getContextUsage()` (we use a local estimate, `estimateContextTokens` in `bridge.js`).

**Deliberately dropped from `noheadroom`**: managing the `headroom proxy` process's lifecycle (`proxy-manager.ts`), the `/headroom` commands, and the status footer (Pi has `ctx.ui.notify`/`ctx.ui.setStatus`; OpenCode's Promise API offers no equivalent notification channel for a non-TUI `@opencode/plugin` — only `ctx.command.transform` to register commands, with no direct way to return text to the user). If interactive diagnostics are ever needed, `ctx.command.transform` + `ctx.session.prompt` could be explored, but that's out of scope for now.

Alternatives considered and discarded:
- **Provider injection in `opencode.json`** (what `headroom wrap opencode` does): requires writing/patching the user's config → not as transparent as required.
- **`ctx.aisdk.hook`**: an AI-SDK-level hook, doesn't give clean access to the provider-agnostic message list the way `session.hook("context")` does.

## 5. Operating rules

- **Do not run the `opencode` binary** or other commands outside this folder, unless strictly necessary.
- **Clean, lean, well-documented code**: comments only where the behavior isn't obvious (see `src/bridge.js` for the exclusion rules — files/images are never compressed, `system` messages are never sent to Headroom).
- Always separate the pure, testable logic (`bridge.js`, `config.js`) from the plugin entrypoint that imports `@opencode/plugin` (`src/index.js`) and from the HTTP client (`client.js`), so unit tests need neither a real OpenCode server nor a running Headroom proxy.
- For any doubt about OpenCode v2's API/schemas, consult `source_app/opencode` first (grep `packages/ai/src/schema/messages.ts` for `Message`/`ToolResultPart`, `packages/plugin` for the hooks) and the MCP docs (`docs-mcp-server`, `opencode` library); for Headroom, the `headroom` library on the same MCP; for an already-tested porting reference, `source_app/pi-mimir/packages/pi-headroom`.
- Available skills: `kroki-diagrams` (diagrams for documentation only) and `memory-updater` (procedure to update this file, `MEMORY.md`, and `README.md`). The `docs-analyzer` and `web-to-markdown` skills from the previous template are **no longer available**.

## 6. Local deployment

- `npm install` downloads the real `@opencode/plugin` dependency from npm (public package, `latest` dist-tag verified = `2.0.19`): use it for the integration tests (`test/plugin.test.js`), not just mocks.
- `npm run plugin:install` links this folder to `~/.config/opencode/plugins/headroom-context-compression` (OpenCode's automatic global discovery, no `opencode.json` edit). `npm run plugin:uninstall` removes the link. See `README.md` for the alternatives (per-project, explicit entry in `opencode.json`).
- These scripts write outside this folder (`~/.config/opencode/...`): running them is the user's responsibility, don't run them on your own unless explicitly asked.
