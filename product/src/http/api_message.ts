/**
 * @canonical api_message -- the transport-agnostic request/response value types.
 *
 * The pure product handler (`product_api.ts`) is a function of `ApiRequest -> ApiResponse` with NO
 * coupling to Node's `http` (or any socket). The thin Node adapter (`node_server.ts`) is the only code
 * that touches sockets: it builds an `ApiRequest` from an incoming message and writes the `ApiResponse`
 * back. Keeping the handler pure is what lets the HTTP keystone run against `handle()` directly —
 * fast, deterministic, no ports — while one integration test exercises the socket adapter.
 *
 * The body is carried as the RAW string (not pre-parsed) so JSON parsing — and the `400` it can raise —
 * lives inside the pure, tested handler rather than in the adapter.
 *
 * related: product_api.ts (the handler), node_server.ts (the socket adapter).
 */

/** An incoming request, normalized to plain data. Header keys are lowercased by the adapter. */
export interface ApiRequest {
  readonly method: string
  /** The path only (no query string), e.g. `/t/alpha/weddings/wedding_1`. */
  readonly path: string
  /** Header map with LOWERCASED keys (the adapter normalizes); absent headers are `undefined`. */
  readonly headers: Readonly<Record<string, string | undefined>>
  /** The raw request body, or `undefined` when there is none. Parsed inside the handler. */
  readonly rawBody?: string
}

/** A response, as plain data. The adapter serializes `body` as JSON and writes `status`. */
export interface ApiResponse {
  readonly status: number
  /** A JSON-serializable body. Error bodies are code-free constants (no internal `PRODUCT.*` leaks). */
  readonly body: unknown
}
