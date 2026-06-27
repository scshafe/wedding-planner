import { type IdGenerator } from '@wedding-planner/shared'

import { ProductError } from '../product_error'

/**
 * @canonical provider_webhook_credential -- the unforgeable PROVIDER-WEBHOOK tier and its sole credential store.
 *
 * A `ProviderWebhookCredential` is the FOURTH trust tier of the product surface (after Principal, Operator,
 * and the anonymous tenant edge): the simulated messaging provider authenticating its server-to-server
 * INBOUND webhook (a guest texted in — see product_api.ts `/t/:slug/messaging/inbound`). It is platform-wide
 * and tenant-LESS: there is ONE provider integration for the whole platform, so the credential authenticates
 * "this is our provider", and the TENANT is established downstream by the route `:slug` + the per-tenant
 * guest registry, never by this credential. (A per-tenant webhook secret would imply per-tenant provider
 * accounts — a carrier concept that must not leak into the domain; CLAUDE.md: avoid vendor lock-in.)
 *
 * Why a SHARED SECRET and not a browser CSRF token: the inbound webhook is server-to-server from the
 * provider, not a browser form post — its anti-forgery guard is a bearer secret the provider presents, not a
 * cookie+token CSRF pair (browser-form CSRF, for the planner mutation surface, is a separate deferred rung).
 *
 * Unforgeability is enforced by CONSTRUCTION, identical to `Operator`/`Principal`/`TenantContext` (and for the
 * same reason doddy proved there):
 *   1. A compile-time phantom brand (a `declare`d `unique symbol` member — type-system only, never a runtime
 *      property), so a structural `{ provider_id }` literal is not assignable.
 *   2. A runtime IDENTITY token: a module-private `WeakSet` the mint adds each credential to. Membership lives
 *      OUTSIDE the object, so there is nothing to reflect with `Object.getOwnPropertySymbols` and re-stamp.
 *
 * The `ProviderWebhookCredentialStore` is the SOLE mint and the token->credential index — a SEPARATE, FOURTH
 * token namespace (session / operator / provider-webhook never cross). `resolve` is a bare `#`-private
 * `Map.get` with NO prefix/shape gate, so a session or operator token fails via the same opaque absent-key
 * path (no cross-namespace shape/timing oracle). The token is CONSTRUCTOR-INJECTED (an offline-simulation
 * seam — never a module constant, never a real secret), never echoed in any response/error, and the backing
 * map is `#`-private so a token never leaks via serialization.
 *
 * related: operator_credential.ts (the platform-tier analogue this mirrors verbatim), session_store.ts (the
 * intra-tenant analogue), product_api.ts (#authenticateWebhook — the sole consumer).
 */

/**
 * Compile-time phantom brand. `declare const` means it exists ONLY in the type system — there is no runtime
 * symbol, so nothing is reflectable on a minted credential. Unnameable outside this module.
 */
declare const PROVIDER_WEBHOOK_BRAND: unique symbol

/** The resolved provider-webhook credential. Tenant-less; carries only a non-secret identity (never the token). */
export interface ProviderWebhookCredential {
  readonly provider_id: string
  /** Phantom brand for nominal typing — never an actual runtime property (see PROVIDER_WEBHOOK_BRAND). */
  readonly [PROVIDER_WEBHOOK_BRAND]: true
}

/**
 * The runtime identity token. A credential is "minted" iff it is a member of this set. Membership is by
 * object identity and lives OUTSIDE the object, so it cannot be reflected off a real credential and copied
 * onto a forged one.
 */
const MINTED_PROVIDER_WEBHOOKS = new WeakSet<ProviderWebhookCredential>()

/**
 * Assert that `credential` was minted by the ProviderWebhookCredentialStore (carries the private brand). A
 * hand-built or cast object lacks the unnameable brand key and is rejected.
 */
export function assertMintedProviderWebhook(credential: ProviderWebhookCredential): void {
  if (!MINTED_PROVIDER_WEBHOOKS.has(credential)) {
    throw new ProductError(
      'PRODUCT.FORGED_WEBHOOK_PROVIDER',
      'Webhook credential was not minted by the ProviderWebhookCredentialStore; refusing to trust it.',
      {},
    )
  }
}

/** Internal mint — the ONLY place a credential joins the minted set. Never re-exported from the barrel. */
function mintProviderWebhook(provider_id: string): ProviderWebhookCredential {
  const credential = Object.freeze({ provider_id }) as unknown as ProviderWebhookCredential
  MINTED_PROVIDER_WEBHOOKS.add(credential)
  return credential
}

export class ProviderWebhookCredentialStore {
  /** token -> credential. `#`-private: never enumerates, never serializes (no token leak). */
  readonly #byToken = new Map<string, ProviderWebhookCredential>()

  /**
   * Seed the provider-webhook credentials from injected secret tokens (offline simulation — these stand in
   * for a real provider's webhook signing secret, a going-live/human-reserved concern). Each token mints one
   * credential with an injected provider_id. A duplicate or empty token is rejected at construction.
   */
  constructor(ids: IdGenerator, seedTokens: readonly string[]) {
    for (const token of seedTokens) {
      if (token.length === 0) {
        throw new ProductError('PRODUCT.BAD_REQUEST', 'A provider webhook token must be non-empty.', {})
      }
      if (this.#byToken.has(token)) {
        throw new ProductError('PRODUCT.DUPLICATE_WEBHOOK_TOKEN', 'Duplicate provider webhook token.', {})
      }
      this.#byToken.set(token, mintProviderWebhook(ids.next('webhook_provider')))
    }
  }

  /**
   * Exchange a presented token for its credential, or `undefined` for an unknown/absent token (fail closed).
   * A bare `Map.get` — NO prefix/shape check, so a tenant session / operator token fails identically to any
   * other absent token (no cross-namespace shape oracle).
   */
  resolve(token: string | undefined): ProviderWebhookCredential | undefined {
    if (token === undefined) return undefined
    return this.#byToken.get(token)
  }
}
