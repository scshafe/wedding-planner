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
 * backups hold nothing replayable. The browser keeps the session in an HttpOnly cookie scoped to `/admin`, so
 * the long-lived credential never sits in a cookie jar.
 *
 * Each session is BOUND to the credential that minted it: the row stores sha256(token NUL credential), and a
 * session resolves only while one of the CURRENTLY configured credentials reproduces that binding. Rotating
 * `WP_OPERATOR_TOKEN` (the owner's incident lever) therefore ends every console session at the next boot, and
 * the row never holds a hash of the credential alone. `resolve` accepts the static credential or a live, bound
 * session (expired or unbound ⇒ the same unknown-token failure). `endSession` with a session revokes it; with the
 * static credential it revokes EVERY console session ("sign out everywhere"). `sweepExpired` prunes expired rows
 * at boot.
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

/** An operator session as persisted (keyed by sha256 of its token; neither the token nor the credential is in it). */
export interface StoredOperatorSession {
  /** sha256(token): the record's own key (lets the sweep delete it). */
  readonly token_hash: string
  /** sha256(token NUL credential): which credential minted it. */
  readonly credential_binding: string
  readonly csrf_token: string
  readonly expires_at: string
}

/** A resolved console session: the stored row and the live operator of the credential it is bound to. */
interface LiveOperatorSession {
  readonly session: StoredOperatorSession
  readonly operator: Operator
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
    return this.#liveSession(token)?.operator
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
    const token_hash = sha256Hex(token)
    const stored: StoredOperatorSession = {
      token_hash,
      credential_binding: bindingOf(token, credentialToken),
      csrf_token,
      expires_at,
    }
    store.put(COLLECTIONS.operatorSession, GLOBAL_PARTITION, token_hash, stored)
    return { token, csrf_token, expires_at }
  }

  /**
   * Revoke console sessions (idempotent): the presented session, or — presented with the STATIC credential —
   * every console session. Returns whether any session was removed.
   */
  endSession(token: string | undefined): boolean {
    if (token === undefined || token.length === 0 || this.#sessions === undefined) return false
    const { store } = this.#sessions
    if (this.#byToken.has(token)) {
      const all = store.list(COLLECTIONS.operatorSession, GLOBAL_PARTITION)
      for (const session of all) store.delete(COLLECTIONS.operatorSession, GLOBAL_PARTITION, session.token_hash)
      return all.length > 0
    }
    return store.delete(COLLECTIONS.operatorSession, GLOBAL_PARTITION, sha256Hex(token))
  }

  /**
   * Delete every expired (or malformed) console session. Run at boot. A session bound to a rotated-away credential
   * cannot be recognized without its token, so it stays until it lapses — it never resolves meanwhile.
   */
  sweepExpired(): number {
    if (this.#sessions === undefined) return 0
    const { clock, store } = this.#sessions
    let removed = 0
    for (const session of store.list(COLLECTIONS.operatorSession, GLOBAL_PARTITION)) {
      if (isExpired(session.expires_at, clock) || typeof session.credential_binding !== 'string') {
        store.delete(COLLECTIONS.operatorSession, GLOBAL_PARTITION, session.token_hash)
        removed += 1
      }
    }
    return removed
  }

  /** {@link CsrfGuard.issueCsrf} for a console session; undefined for an unknown/expired one. */
  issueCsrf(sessionToken: string | undefined): string | undefined {
    return this.#liveSession(sessionToken)?.session.csrf_token
  }

  /** {@link CsrfGuard.verifyCsrf} for a console session: fail-closed and constant-time. */
  verifyCsrf(sessionToken: string | undefined, candidate: string | undefined): boolean {
    if (candidate === undefined || candidate.length === 0) return false
    const live = this.#liveSession(sessionToken)
    return live !== undefined && constantTimeEqual(live.session.csrf_token, candidate)
  }

  /**
   * The live session for a token: unexpired and bound to a currently configured credential, with that
   * credential's operator. Anything else is undefined (the same failure as an unknown token).
   */
  #liveSession(token: string | undefined): LiveOperatorSession | undefined {
    if (token === undefined || token.length === 0 || this.#sessions === undefined) return undefined
    const { clock, store } = this.#sessions
    const session = store.get(COLLECTIONS.operatorSession, GLOBAL_PARTITION, sha256Hex(token))
    if (session === undefined || isExpired(session.expires_at, clock)) return undefined
    for (const [credential, operator] of this.#byToken) {
      if (constantTimeEqual(bindingOf(token, credential), session.credential_binding)) return { session, operator }
    }
    return undefined
  }
}

/** sha256(token NUL credential): binds a console session to the credential that minted it. */
function bindingOf(token: string, credential: string): string {
  return sha256Hex(`${token}\u0000${credential}`)
}

/** Expiry check that fails CLOSED: an unparseable timestamp counts as expired. */
function isExpired(expires_at: string, clock: Clock): boolean {
  return !(Date.parse(expires_at) > Date.parse(clock.now()))
}
