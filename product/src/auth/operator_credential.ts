import { type Clock, type IdGenerator, sha256Hex } from '@wedding-planner/shared'

import { COLLECTIONS } from '../persistence/collections'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { GLOBAL_PARTITION, type RecordStore } from '../persistence/record_store'
import { ProductError } from '../product_error'
import { constantTimeEqual, type CsrfGuard } from './csrf_guard'

/**
 * @canonical operator_credential -- the unforgeable PLATFORM-tier subject and its sole credential store.
 *
 * An `Operator` is the third trust tier of the product surface, ABOVE any single tenant: the simulated
 * platform operator (the white-label vendor / the agent-run platform itself) who provisions tenants and
 * drives their billing lifecycle. It is tenant-LESS — it is not scoped to one tenant the way a Principal
 * is, and it is a peer of `Principal`, not an onboarding concept (so it lives here under `auth/`).
 *
 * Unforgeability is enforced by CONSTRUCTION, identical to `Principal`/`TenantContext` (and for the same
 * reason doddy proved there): the `/admin` pipeline calls `assertMintedOperator` / receives an Operator,
 * and a hand-built `as Operator` must be rejected. So an Operator carries:
 *   1. A compile-time phantom brand (a `declare`d `unique symbol` member — type-system only, never a
 *      runtime property), so a structural `{ operator_id }` literal is not assignable.
 *   2. A runtime IDENTITY token: a module-private `WeakSet` the mint adds each operator to. Membership
 *      lives OUTSIDE the object, so there is nothing to reflect with `Object.getOwnPropertySymbols` and
 *      re-stamp onto a forged object (the re-stamp attack a symbol-property brand is vulnerable to).
 *
 * The `OperatorCredentialStore` is the SOLE mint and the token->operator index — the platform-tier
 * analogue of the `SessionStore`. It is a SEPARATE token namespace: a tenant session token is simply
 * absent here (→ undefined → 401), and an operator token is absent in the SessionStore. `resolve` is a
 * bare `#`-private `Map.get` with NO prefix/shape gate, so a foreign token fails via the same opaque
 * absent-key path as a session token (no cross-namespace shape/timing oracle). The operator token is
 * CONSTRUCTOR-INJECTED (an offline-simulation seam — never a module constant, never a real secret), never
 * echoed in any response/error, and the backing map is `#`-private so a token never leaks via serialization.
 *
 * OPERATOR SESSIONS (issue #9, ADR 0040) let a browser use the operator console without holding the credential:
 * `startSession` exchanges the STATIC credential (never another session) for an opaque, expiring session token
 * plus its own CSRF token, persisted like tenant sessions — keyed by sha256(token), so the database and its
 * backups hold nothing replayable. `resolve` accepts either the static credential or a live session (an expired
 * one is deleted and fails like an unknown token); `endSession` revokes one. The browser keeps the session in an
 * HttpOnly cookie scoped to `/admin`, so the long-lived credential never sits in a cookie jar.
 *
 * related: session_store.ts (the intra-tenant analogue), principal.ts (the mint pattern this mirrors),
 * product_api.ts (#authenticateOperator — the sole consumer).
 */

/** How long an operator console session lasts (12 hours). */
export const OPERATOR_SESSION_TTL_SECONDS = 12 * 60 * 60

/** The clock + store operator sessions need. Without it the store accepts only the static credential. */
export interface OperatorSessionOptions {
  readonly clock: Clock
  readonly store?: RecordStore
  readonly ttlSeconds?: number
}

/** What `startSession` hands back: the session bearer, its CSRF token, and when it lapses. */
export interface OperatorSession {
  readonly token: string
  readonly csrf_token: string
  readonly expires_at: string
}

/** An operator session as persisted (keyed by sha256 of its token; the token is not in the record). */
export interface StoredOperatorSession {
  readonly operator_id: string
  readonly csrf_token: string
  readonly expires_at: string
}

/**
 * Compile-time phantom brand. `declare const` means it exists ONLY in the type system — there is no
 * runtime symbol, so nothing is reflectable on a minted operator. Unnameable outside this module.
 */
declare const OPERATOR_BRAND: unique symbol

/** The resolved platform operator. Tenant-less; carries only a non-secret identity (never the token). */
export interface Operator {
  readonly operator_id: string
  /** Phantom brand for nominal typing — never an actual runtime property (see OPERATOR_BRAND). */
  readonly [OPERATOR_BRAND]: true
}

/**
 * The runtime identity token. An operator is "minted" iff it is a member of this set. Membership is by
 * object identity and lives OUTSIDE the object, so it cannot be reflected off a real operator and copied
 * onto a forged one.
 */
const MINTED_OPERATORS = new WeakSet<Operator>()

/**
 * Assert that `operator` was minted by the OperatorCredentialStore (carries the private brand). A
 * hand-built or cast object lacks the unnameable brand key and is rejected.
 */
export function assertMintedOperator(operator: Operator): void {
  if (!MINTED_OPERATORS.has(operator)) {
    throw new ProductError(
      'PRODUCT.FORGED_OPERATOR',
      'Operator was not minted by the OperatorCredentialStore; refusing to authorize against it.',
      {},
    )
  }
}

/** Internal mint — the ONLY place an operator joins the minted set. Never re-exported from the barrel. */
function mintOperator(operator_id: string): Operator {
  const operator = Object.freeze({ operator_id }) as unknown as Operator
  MINTED_OPERATORS.add(operator)
  return operator
}

export class OperatorCredentialStore implements CsrfGuard {
  /** token -> operator. `#`-private: never enumerates, never serializes (no token leak). */
  readonly #byToken = new Map<string, Operator>()
  readonly #ids: IdGenerator
  readonly #sessions: { readonly clock: Clock; readonly store: RecordStore; readonly ttlSeconds: number } | undefined

  /**
   * Seed the platform operators from injected credential tokens (offline simulation — these stand in for
   * real platform-admin secrets, which are a going-live/human-reserved concern). Each token mints one
   * Operator with an injected operator_id. A duplicate or empty token is rejected at construction.
   */
  constructor(ids: IdGenerator, seedTokens: readonly string[], sessions?: OperatorSessionOptions) {
    this.#ids = ids
    this.#sessions =
      sessions === undefined
        ? undefined
        : {
            clock: sessions.clock,
            store: sessions.store ?? new InMemoryRecordStore(),
            ttlSeconds: sessions.ttlSeconds ?? OPERATOR_SESSION_TTL_SECONDS,
          }
    for (const token of seedTokens) {
      if (token.length === 0) {
        throw new ProductError('PRODUCT.BAD_REQUEST', 'An operator credential token must be non-empty.', {})
      }
      if (this.#byToken.has(token)) {
        throw new ProductError('PRODUCT.DUPLICATE_OPERATOR_TOKEN', 'Duplicate operator credential token.', {})
      }
      this.#byToken.set(token, mintOperator(ids.next('operator')))
    }
  }

  /**
   * Exchange a presented token for its Operator, or `undefined` for an unknown/absent token (fail closed).
   * A bare `Map.get` — NO prefix/shape check, so a tenant session token fails identically to any other
   * absent token (no cross-namespace shape oracle).
   */
  resolve(token: string | undefined): Operator | undefined {
    if (token === undefined) return undefined
    const operator = this.#byToken.get(token)
    if (operator !== undefined) return operator
    const session = this.#liveSession(token)
    return session === undefined ? undefined : mintOperator(session.operator_id)
  }

  /**
   * Start a console session. Only the STATIC credential may start one (a session cannot extend itself); an
   * unknown token, a session token, or a store built without session options returns `undefined`.
   */
  startSession(credentialToken: string | undefined): OperatorSession | undefined {
    if (credentialToken === undefined || this.#sessions === undefined) return undefined
    const operator = this.#byToken.get(credentialToken)
    if (operator === undefined) return undefined
    const { clock, store, ttlSeconds } = this.#sessions
    const token = this.#ids.next('opsession')
    const csrf_token = this.#ids.next('opcsrf')
    const expires_at = new Date(Date.parse(clock.now()) + ttlSeconds * 1000).toISOString()
    const stored: StoredOperatorSession = { operator_id: operator.operator_id, csrf_token, expires_at }
    store.put(COLLECTIONS.operatorSession, GLOBAL_PARTITION, sha256Hex(token), stored)
    return { token, csrf_token, expires_at }
  }

  /** Revoke a console session (idempotent). Returns whether a session was removed. */
  endSession(sessionToken: string | undefined): boolean {
    if (sessionToken === undefined || sessionToken.length === 0 || this.#sessions === undefined) return false
    return this.#sessions.store.delete(COLLECTIONS.operatorSession, GLOBAL_PARTITION, sha256Hex(sessionToken))
  }

  /** {@link CsrfGuard.issueCsrf} for a console session; undefined for an unknown/expired one. */
  issueCsrf(sessionToken: string | undefined): string | undefined {
    return this.#liveSession(sessionToken)?.csrf_token
  }

  /** {@link CsrfGuard.verifyCsrf} for a console session: fail-closed and constant-time. */
  verifyCsrf(sessionToken: string | undefined, candidate: string | undefined): boolean {
    if (candidate === undefined || candidate.length === 0) return false
    const session = this.#liveSession(sessionToken)
    return session !== undefined && constantTimeEqual(session.csrf_token, candidate)
  }

  /** The unexpired session for a token, or undefined. An expired session is deleted on sight. */
  #liveSession(token: string | undefined): StoredOperatorSession | undefined {
    if (token === undefined || token.length === 0 || this.#sessions === undefined) return undefined
    const { clock, store } = this.#sessions
    const key = sha256Hex(token)
    const session = store.get(COLLECTIONS.operatorSession, GLOBAL_PARTITION, key)
    if (session === undefined) return undefined
    if (Date.parse(session.expires_at) <= Date.parse(clock.now())) {
      store.delete(COLLECTIONS.operatorSession, GLOBAL_PARTITION, key)
      return undefined
    }
    return session
  }
}
