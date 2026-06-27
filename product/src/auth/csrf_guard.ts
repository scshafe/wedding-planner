/**
 * @canonical csrf_guard -- the browser-form anti-forgery boundary (Phase 21).
 *
 * The FIRST planner *mutation* trust surface over a browser. A CSRF (cross-site request forgery) attacker
 * tricks a logged-in planner's browser into POSTing a state-changing request to our origin, riding the
 * ambient `wp_session` cookie. The defense is the **synchronizer-token pattern**: every cookie-authenticated
 * browser mutation must carry a per-session secret the attacker cannot read or guess.
 *
 * Three load-bearing invariants (see ADR 0021):
 *   - **Per-session, server-side.** The token is minted at login alongside the session token and stored
 *     server-side (SessionStore implements this interface); it is NOT a stateless double-submit cookie (that
 *     would need a JS-readable cookie, weakening the HttpOnly + `script-src 'none'` model).
 *   - **DISTINCT from the session token.** The session token lives in an HttpOnly cookie precisely so the DOM
 *     can't read it; embedding it as a form field would write the session bearer into the page and defeat
 *     HttpOnly. The CSRF token is a SEPARATE per-session id.
 *   - **The `sessionToken` passed to `verifyCsrf` MUST be the same token the caller then forwards as the
 *     request's Bearer** (no verify-A-execute-as-B), and verification is **fail-closed** (absent session OR
 *     empty/absent candidate ⇒ false) and **constant-time** (no timing oracle on the stored token).
 *
 * CSRF is enforced at the WEB layer only — the sole place a cookie becomes a credential (the web handlers
 * translate the `wp_session` cookie into an internal Bearer). The JSON API is Bearer-only and therefore not
 * CSRF-reachable (a cross-site `<form>` cannot set an Authorization header), so it carries no token.
 *
 * related: session_store.ts (the implementor — mints + stores the per-session token), product_web_ui.ts
 * (the sole consumer — issues tokens into forms and verifies them before any cookie-authenticated mutation).
 */
export interface CsrfGuard {
  /** The per-session CSRF token to embed in a form, or `undefined` when the session is unknown/absent. */
  issueCsrf(sessionToken: string | undefined): string | undefined
  /**
   * Whether `candidate` is the CSRF token bound to `sessionToken`. Fail-closed: an absent session or an
   * empty/absent candidate is `false`. Constant-time against the stored token.
   */
  verifyCsrf(sessionToken: string | undefined, candidate: string | undefined): boolean
}

/**
 * Length-safe constant-time string equality. There is NO early `length !==` return: a length difference is
 * folded into the accumulator and the loop runs to the longer length, so the time taken does not branch on a
 * prefix match. (The compared values are server-minted fixed-charset ids, so their length is not secret — this
 * is defense-in-depth, the right habit for a token compare.)
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    // charCodeAt past the end is NaN; `| 0` coerces it to 0, so out-of-range positions still XOR cleanly.
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0)
  }
  return diff === 0
}
