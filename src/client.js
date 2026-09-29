/**
 * Minimal HTTP client for the two Headroom proxy endpoints this plugin uses:
 * `POST /v1/compress` (stateless compression, no upstream provider call) and
 * `GET /v1/retrieve/{hash}` (CCR original-content lookup).
 *
 * Never calls anything else on the proxy, and never starts or manages the
 * `headroom proxy` process itself.
 */
export class HeadroomClient {
  #baseUrl
  #timeoutMs

  constructor({ baseUrl, timeoutMs }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "")
    this.#timeoutMs = timeoutMs
  }

  /**
   * @param {Array} messages - OpenAI-shape messages from `buildCompressionPayload`.
   * @param {string} [model] - drives Headroom's tokenizer/context-limit resolution.
   */
  async compress(messages, model, signal) {
    const response = await fetch(`${this.#baseUrl}/v1/compress`, {
      method: "POST",
      // A redirect could forward full tool results to a non-local host, bypassing `allowRemote`.
      redirect: "error",
      headers: { "content-type": "application/json", "x-headroom-stack": "opencode-plugin" },
      body: JSON.stringify({ messages, model: model || "gpt-4o" }),
      signal: this.#withTimeout(signal),
    })
    if (!response.ok) {
      throw new Error(`Headroom /v1/compress failed with HTTP ${response.status}`)
    }
    const payload = await response.json()
    return {
      messages: payload.messages,
      tokensBefore: payload.tokens_before,
      tokensAfter: payload.tokens_after,
      tokensSaved: payload.tokens_saved,
    }
  }

  /** @returns {Promise<{ ok: true, content: string } | { ok: false, error: string }>} */
  async retrieve(hash, signal) {
    try {
      const response = await fetch(`${this.#baseUrl}/v1/retrieve/${hash}`, {
        redirect: "error",
        signal: this.#withTimeout(signal),
      })
      if (!response.ok) {
        return {
          ok: false,
          error:
            response.status === 404
              ? "Entry not found in Headroom's CCR store (TTL 1800s) — the compressed content expired."
              : `Headroom /v1/retrieve failed with HTTP ${response.status}`,
        }
      }
      const body = await response.json()
      if (typeof body === "string") return { ok: true, content: body }
      if (body && typeof body.original_content === "string") return { ok: true, content: body.original_content }
      return { ok: true, content: JSON.stringify(body, null, 2) }
    } catch (error) {
      return { ok: false, error: `Headroom /v1/retrieve failed: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  #withTimeout(signal) {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    if (!signal) return timeout
    return AbortSignal.any([signal, timeout])
  }
}
