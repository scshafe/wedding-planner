import { type Clock, type IdGenerator, sha256Hex } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { GLOBAL_PARTITION, type RecordStore } from '../persistence/record_store'
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
 * role (the auth analogue of "no client-asserted partition key"). The backing store is `#`-private: it
 * does not enumerate, so a token/principal never leaks via `JSON.stringify` / spread.
 *
 * Since issue #8 sessions are durable (they survive a deploy) behind the {@link RecordStore} port, keyed by the
 * SHA-256 of the token: the raw bearer token is never stored, so the database file and its backups hold nothing
 * a reader could present as a session. (A plain hash is enough: the token is 122 random bits, not a password.)
 * `resolve` re-mints the Principal from the stored record on every call, so the store stays the sole mint.
 *
 * Because sessions now outlive a deploy, each records HOW it was authenticated (`auth`) and, when the store has a
 * clock, when it lapses: a lookup refuses any `auth` kind this build does not issue and any expired session
 * (deleting it), `revoke` ends one server-side (sign-out), and `sweepExpired` prunes lapsed rows at boot. Today
 * every session is `auth: 'simulated'` (the role-picker login): real accounts (issue #10) introduce a new kind
 * and must decide what simulated sessions may still do — a store that stops issuing `simulated` stops honoring it.
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

/**
 * A session as persisted: the principal's fields plus its per-session CSRF token (Phase 21). The CSRF token is a
 * SEPARATE id from the session token (never equal to it — distinctness keeps the session bearer out of the page
 * DOM, preserving HttpOnly). Keyed by sha256(session token); the token itself is not in the record.
 */
export interface StoredSession {
  /** How the session was authenticated. A kind this build does not issue is refused at lookup. */
  readonly auth: SessionAuth
  /** sha256 of the token: the record's own key (lets `sweepExpired` delete it). Never the token itself. */
  readonly token_hash: string
  readonly tenant_id: string
  readonly role: PrincipalRole
  readonly wedding_id?: string
  readonly principal_id: string
  readonly csrf_token: string
  /** Present when the store has a clock (the composed surface always does). */
  readonly issued_at?: string
  readonly expires_at?: string
}

/** The session kinds this build issues and honors. */
export type SessionAuth = 'simulated'

/** How long a session lasts (7 days). */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

/** The clock that gives sessions an expiry. Without it (test fixtures) sessions do not lapse. */
export interface SessionExpiryOptions {
  readonly clock: Clock
  readonly ttlSeconds?: number
}

export class SessionStore implements CsrfGuard {
  /** sha256(token) -> session. `#`-private: never enumerates, never serializes. */
  readonly #store: RecordStore

  readonly #expiry: { readonly clock: Clock; readonly ttlSeconds: number } | undefined

  constructor(
    private readonly ids: IdGenerator,
    store: RecordStore = new InMemoryRecordStore(),
    expiry?: SessionExpiryOptions,
  ) {
    this.#store = store
    this.#expiry = expiry === undefined ? undefined : { clock: expiry.clock, ttlSeconds: expiry.ttlSeconds ?? SESSION_TTL_SECONDS }
  }

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
    const token_hash = sessionKey(token)
    const stored: StoredSession = {
      auth: 'simulated',
      token_hash,
      tenant_id: principal.tenant_id,
      role: principal.role,
      ...(principal.wedding_id === undefined ? {} : { wedding_id: principal.wedding_id }),
      principal_id: principal.principal_id,
      csrf_token,
      ...this.#lifetime(),
    }
    this.#store.put(COLLECTIONS.session, GLOBAL_PARTITION, token_hash, stored)
    return { token, principal, csrf_token }
  }

  /** End a session server-side (sign-out). Idempotent; returns whether a session was removed. */
  revoke(token: string | undefined): boolean {
    if (token === undefined || token.length === 0) return false
    return this.#store.delete(COLLECTIONS.session, GLOBAL_PARTITION, sessionKey(token))
  }

  /** Delete every lapsed session (run at boot). A store without a clock has nothing to sweep. Returns the count. */
  sweepExpired(): number {
    if (this.#expiry === undefined) return 0
    let removed = 0
    for (const session of this.#store.list(COLLECTIONS.session, GLOBAL_PARTITION)) {
      if (this.#isExpired(session)) {
        this.#store.delete(COLLECTIONS.session, GLOBAL_PARTITION, session.token_hash)
        removed += 1
      }
    }
    return removed
  }

  /** Exchange a presented token for its principal, or `undefined` for an unknown/absent token (fail closed). */
  resolve(token: string | undefined): Principal | undefined {
    const stored = this.#lookup(token)
    if (stored === undefined) return undefined
    return mintPrincipal({
      tenant_id: stored.tenant_id,
      role: stored.role,
      wedding_id: stored.wedding_id,
      principal_id: stored.principal_id,
    })
  }

  /** {@link CsrfGuard.issueCsrf} — the CSRF token bound to this session, or undefined when unknown/absent. */
  issueCsrf(sessionToken: string | undefined): string | undefined {
    return this.#lookup(sessionToken)?.csrf_token
  }

  /**
   * {@link CsrfGuard.verifyCsrf} — fail-closed (absent session or empty/absent candidate ⇒ false) and
   * constant-time against the stored token. The caller MUST forward this same `sessionToken` as the Bearer.
   */
  verifyCsrf(sessionToken: string | undefined, candidate: string | undefined): boolean {
    if (sessionToken === undefined || candidate === undefined || candidate.length === 0) return false
    const stored = this.#lookup(sessionToken)
    if (stored === undefined) return false
    return constantTimeEqual(stored.csrf_token, candidate)
  }

  /**
   * The live session for a presented token (hashed before lookup), or undefined for an absent/unknown token, a
   * session kind this build does not honor, or an expired session (deleted on sight).
   */
  #lookup(token: string | undefined): StoredSession | undefined {
    if (token === undefined || token.length === 0) return undefined
    const key = sessionKey(token)
    const stored = this.#store.get(COLLECTIONS.session, GLOBAL_PARTITION, key)
    if (stored === undefined || stored.auth !== 'simulated') return undefined
    if (this.#isExpired(stored)) {
      this.#store.delete(COLLECTIONS.session, GLOBAL_PARTITION, key)
      return undefined
    }
    return stored
  }

  /** issued_at/expires_at for a new session, when the store has a clock. */
  #lifetime(): { issued_at?: string; expires_at?: string } {
    if (this.#expiry === undefined) return {}
    const issued_at = this.#expiry.clock.now()
    const expires_at = new Date(Date.parse(issued_at) + this.#expiry.ttlSeconds * 1000).toISOString()
    return { issued_at, expires_at }
  }

  #isExpired(session: StoredSession): boolean {
    if (this.#expiry === undefined || session.expires_at === undefined) return false
    // Fails CLOSED: an unparseable timestamp counts as expired.
    return !(Date.parse(session.expires_at) > Date.parse(this.#expiry.clock.now()))
  }
}

/** The store key of a session token: its SHA-256, so the raw bearer token is never persisted. */
function sessionKey(token: string): string {
  return sha256Hex(token)
}
