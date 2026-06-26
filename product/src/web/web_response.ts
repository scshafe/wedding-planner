import type { ApiResponse } from '../http/api_message'

/**
 * @canonical web_response -- the adapter-facing HTTP result for the web edge + its safe constructors.
 *
 * The JSON handler returns an {@link ApiResponse} (status + JSON-able body). The HTML front door returns
 * an {@link HttpResult}: a status, an explicit header map, and a STRING body (already-rendered HTML or a
 * serialized JSON passthrough). The combined Node adapter writes it verbatim.
 *
 * Every HTML response carries a fixed security header set (doddy P2-1/P2-5): an explicit
 * `charset=utf-8` (closes encoding-confusion XSS), `nosniff`, and a strict CSP with `script-src 'none'`
 * — there is NO client JavaScript in this phase, so a missed escaper still cannot execute. `redirect`
 * and `jsonResultFrom` are the only other ways a result is built; a `Location`/`Set-Cookie` is only ever
 * assembled by the caller from an already-VALIDATED slug (see html.ts `normalizeSlugForRoute`).
 *
 * related: html.ts (the body builders), product_web_ui.ts (the front door), web_server.ts (the adapter).
 */

/** A fully-formed HTTP result: status, header map, and a string body the adapter writes as-is. */
export interface HttpResult {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string
}

/**
 * The security headers stamped on every HTML response. `script-src 'none'` (no client JS this phase) is
 * defense-in-depth against a missed escaper; `style-src 'unsafe-inline'` is required for the one dynamic
 * CSS value (the brand color custom property, already `safeColor`-validated). No external origins.
 */
const HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'content-security-policy':
    "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'self'",
})

/** Build an HTML result (string body already rendered via the `html` template), with security headers. */
export function htmlResult(status: number, body: string, extraHeaders?: Record<string, string>): HttpResult {
  return {
    status,
    headers: { ...HTML_SECURITY_HEADERS, ...extraHeaders },
    body,
  }
}

/**
 * A redirect. The `location` (and any `set-cookie`) MUST be built by the caller from a validated slug —
 * never from a raw inbound segment — so no CRLF/attribute injection reaches the header. Carries `nosniff`
 * + an explicit html content-type for the empty body (the header floor every response gets — doddy P2-1).
 */
export function redirect(status: number, location: string, extraHeaders?: Record<string, string>): HttpResult {
  return {
    status,
    headers: {
      location,
      'content-type': 'text/html; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...extraHeaders,
    },
    body: '',
  }
}

/** Wrap a JSON {@link ApiResponse} (the delegated Phase-13 API) as an HttpResult — body serialized once. */
export function jsonResultFrom(response: ApiResponse): HttpResult {
  return {
    status: response.status,
    headers: { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' },
    body: JSON.stringify(response.body),
  }
}
