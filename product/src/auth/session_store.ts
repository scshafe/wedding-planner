import type { IdGenerator } from '@wedding-planner/shared'

import { ProductError } from '../product_error'
import type { TenantContext } from '../tenant/tenant_context'
import { constantTimeEqual, type CsrfGuard } from './csrf_guard'
import { mintPrincipal, type Principal, type PrincipalRole } from './principal'

/**
 * @canonical session_store -- the sole mint of a Principal and the token->principal index.
 *
 * The SessionStore is to a Principal what the TenantContextResolver is to a TenantContext: the SINGLE
 * gateway from "a request claims to be someone" to "an authorized subject". `login` mints a principal
 * and issues a server-side **opaque token** (an injected id) that indexes it; `resolve` exchanges a
 * presented token for the stored principal (or `undefined`). The token is an opaque handle, NOT a
 * client-decodable claim — the store is the authority, so a client never asserts its own tenant_id or
 * role (the auth analogue of "no client-asserted partition key"). The backing map is `#`-private: it
 * does not enumerate, so a token/principal never leaks via `JSON.stringify` / spread.
 *
 * Login is a SIMULATION, honest about it (offline-first): it takes an already-*resolved* TenantContext
 * (so the principal's tenant_id is the context's, never a raw slug echo) and does NOT verify a real
 * credential. Critically it does NOT verify the couple's `wedding_id` exists — doing so would turn this
 * unauthenticated endpoint into an intra-tenant existence oracle. A phantom/foreign wedding_id is
 * carried opaquely and simply reads back the masked not-found at use. Real credential verification is a
 * Phase-15 onboarding / human-reserved concern.
 *
 * related: principal.ts (the brand + mint), tenant_context.ts (the inter-tenant analogue),
 * wedding_authorizer.ts (consumes the resolved principal).
 */

/** What a (simulated) login asserts about the actor. The tenant comes from the resolved context, not here. */
export interface LoginInput {
  readonly role: PrincipalRole
  /** Required iff role === 'couple' (the wedding they are bound to); ignored for a planner. */
  readonly wedding_id?: string
}

/** The result of a login: the opaque token to present on subsequent requests, and the minted principal. */
export interface Session {
  readonly token: string
  readonly principal: Principal
  /**
   * The per-session CSRF token (Phase 21) — DISTINCT from `token`, minted alongside it. The browser web layer
   * embeds this in forms and verifies it before any cookie-authenticated mutation; the JSON API never uses it.
   */
  readonly csrf_token: string
}

export class SessionStore implements CsrfGuard {
  /** token -> principal. `#`-private: never enumerates, never serializes. */
  readonly #byToken = new Map<string, Principal>()
  /**
   * session token -> its per-session CSRF token (Phase 21). A SEPARATE id from the session token (never equal
   * to it — distinctness keeps the session bearer out of the page DOM, preserving HttpOnly). `#`-private.
   */
  readonly #csrfByToken = new Map<string, string>()

  constructor(private readonly ids: IdGenerator) {}

  /**
   * Mint a principal for the resolved tenant and issue a token. The principal's tenant_id is taken from
   * the CONTEXT (not a slug), so a session can never disagree with a real resolved tenant. A `couple`
   * must name a `wedding_id` (else PRODUCT.BAD_REQUEST); a `planner` carries none (any provided is
   * dropped). The wedding_id is NOT checked for existence (no oracle).
   */
  login(context: TenantContext, input: LoginInput): Session {
    if (input.role === 'couple' && (input.wedding_id === undefined || input.wedding_id.length === 0)) {
      throw new ProductError(
        'PRODUCT.BAD_REQUEST',
        'A couple login must name the wedding_id the couple is bound to.',
        { context: { role: input.role } },
      )
    }
    const principal = mintPrincipal({
      tenant_id: context.tenant_id,
      role: input.role,
      // A planner carries no wedding_id; a couple carries theirs opaquely.
      wedding_id: input.role === 'couple' ? input.wedding_id : undefined,
      principal_id: this.ids.next('principal'),
    })
    const token = this.ids.next('session')
    // A SEPARATE id (never the session token) — the per-session CSRF secret bound to this session.
    const csrf_token = this.ids.next('csrf')
    this.#byToken.set(token, principal)
    this.#csrfByToken.set(token, csrf_token)
    return { token, principal, csrf_token }
  }

  /** Exchange a presented token for its principal, or `undefined` for an unknown/absent token (fail closed). */
  resolve(token: string | undefined): Principal | undefined {
    if (token === undefined) return undefined
    return this.#byToken.get(token)
  }

  /** {@link CsrfGuard.issueCsrf} — the CSRF token bound to this session, or undefined when unknown/absent. */
  issueCsrf(sessionToken: string | undefined): string | undefined {
    if (sessionToken === undefined) return undefined
    return this.#csrfByToken.get(sessionToken)
  }

  /**
   * {@link CsrfGuard.verifyCsrf} — fail-closed (absent session or empty/absent candidate ⇒ false) and
   * constant-time against the stored token. The caller MUST forward this same `sessionToken` as the Bearer.
   */
  verifyCsrf(sessionToken: string | undefined, candidate: string | undefined): boolean {
    if (sessionToken === undefined || candidate === undefined || candidate.length === 0) return false
    const stored = this.#csrfByToken.get(sessionToken)
    if (stored === undefined) return false
    return constantTimeEqual(stored, candidate)
  }
}
