/**
 * Plugin configuration: resolved once at `setup(ctx)` time from plugin
 * options (`opencode.json` `plugins[].options`) layered over environment
 * variables. No settings file, no persistence — keep it simple until a real
 * need for `/headroom`-style runtime toggling shows up.
 */

export const DEFAULT_BASE_URL = "http://127.0.0.1:8787" // headroom proxy's own default
export const DEFAULT_MIN_CONTEXT_TOKENS = 10_000
export const DEFAULT_MIN_MESSAGE_CHARS = 2000
// Headroom's own internal budget for the compression step is 30s (seen in its proxy startup
// log, "Anthropic pre-upstream timeouts: ... compression=30.0s"); 40s leaves margin above that
// for large contexts (observed: 23.4s for 183 messages / ~135k tokens) instead of aborting a
// request Headroom would have finished successfully.
export const DEFAULT_TIMEOUT_MS = 40_000

/**
 * @param {Record<string, unknown>} options - `ctx.options`
 * @param {Record<string, string | undefined>} env
 */
export function resolveConfig(options = {}, env = {}) {
  return {
    enabled: parseBoolean(options.enabled, parseBoolean(env.HEADROOM_ENABLED, true)),
    baseUrl: normalizeBaseUrl(parseString(options.proxyUrl, env.HEADROOM_PROXY_URL) || DEFAULT_BASE_URL),
    allowRemote: parseBoolean(options.allowRemote, parseBoolean(env.HEADROOM_ALLOW_REMOTE, false)),
    renameToolCalls: parseBoolean(options.renameToolCalls, true),
    // Below this estimated total context size, compression isn't worth a proxy round trip.
    minContextTokens: parseInteger(
      options.minContextTokens,
      parseInteger(env.HEADROOM_MIN_CONTEXT_TOKENS, DEFAULT_MIN_CONTEXT_TOKENS, 0),
      0,
    ),
    minMessageChars: parseInteger(
      options.minMessageChars,
      parseInteger(env.HEADROOM_MIN_MESSAGE_CHARS, DEFAULT_MIN_MESSAGE_CHARS, 1),
      1,
    ),
    timeoutMs: parseInteger(options.timeoutMs, parseInteger(env.HEADROOM_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100), 100),
    // Provider IDs to skip entirely (e.g. a provider known to misbehave with Headroom).
    // Compressing at the message level (this plugin) has no known need for this today —
    // kept as an escape hatch, not a default exclusion.
    excludeProviders: Array.isArray(options.excludeProviders) ? options.excludeProviders : [],
  }
}

export function isLocalHeadroomUrl(rawUrl) {
  try {
    const url = new URL(rawUrl)
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
  } catch {
    return false
  }
}

/** Compressing sends full tool-result content to `baseUrl`; never do that to a non-local proxy silently. */
export function isRemoteBlocked(config) {
  return !config.allowRemote && !isLocalHeadroomUrl(config.baseUrl)
}

function normalizeBaseUrl(raw) {
  return (raw || DEFAULT_BASE_URL).trim().replace(/\/+$/, "")
}

function parseString(raw, fallback) {
  if (typeof raw === "string" && raw.trim()) return raw.trim()
  return typeof fallback === "string" ? fallback : undefined
}

function parseBoolean(raw, fallback) {
  if (raw === undefined) return fallback
  if (typeof raw === "boolean") return raw
  if (typeof raw !== "string") return fallback
  const normalized = raw.trim().toLowerCase()
  if (["1", "true", "yes", "on"].includes(normalized)) return true
  if (["0", "false", "no", "off"].includes(normalized)) return false
  return fallback
}

function parseInteger(raw, fallback, min) {
  if (raw === undefined) return fallback
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : Number.NaN
  if (!Number.isFinite(parsed) || parsed < min) return fallback
  return Math.trunc(parsed)
}
