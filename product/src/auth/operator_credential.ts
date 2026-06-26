import { type IdGenerator } from '@wedding-planner/shared'

import { ProductError } from '../product_error'

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
 * related: session_store.ts (the intra-tenant analogue), principal.ts (the mint pattern this mirrors),
 * product_api.ts (#authenticateOperator — the sole consumer).
 */

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

export class OperatorCredentialStore {
  /** token -> operator. `#`-private: never enumerates, never serializes (no token leak). */
  readonly #byToken = new Map<string, Operator>()

  /**
   * Seed the platform operators from injected credential tokens (offline simulation — these stand in for
   * real platform-admin secrets, which are a going-live/human-reserved concern). Each token mints one
   * Operator with an injected operator_id. A duplicate or empty token is rejected at construction.
   */
  constructor(ids: IdGenerator, seedTokens: readonly string[]) {
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
    return this.#byToken.get(token)
  }
}
