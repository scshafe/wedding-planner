import { deepFreeze, type StrategyGenome, type Tenant, type Wedding, WeddingPlannerError } from '@wedding-planner/shared'

import type { OperatorCredentialStore } from '../auth/operator_credential'
import type { Principal } from '../auth/principal'
import type { ProviderWebhookCredentialStore } from '../auth/provider_webhook_credential'
import type { SessionStore } from '../auth/session_store'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import type { PlanTier } from '../billing/price_book'
import type { OnboardingService } from '../onboarding/onboarding_service'
import { ProductError } from '../product_error'
import { describeStrategy, type StrategyGuidance } from '../strategy/strategy_guidance'
import type { TenantContext, TenantContextResolver } from '../tenant/tenant_context'
import type { CreateWeddingInput, WeddingRepository } from '../wedding/wedding_repository'
import type { ApiRequest, ApiResponse } from './api_message'
import { splitPath } from './path'

/**
 * @canonical product_api -- the pure HTTP handler: the 5-stage request pipeline + the route table.
 *
 * `handle(req) -> ApiResponse` runs every request through ONE ordered pipeline, so the two stacked
 * boundaries (inter-tenant context, intra-tenant principal) cannot be routed around:
 *
 *   1. parse           method + path segments + (later) the body
 *   2. resolve tenant  slug (from the route) -> resolver.resolveBySlug -> the SOLE per-request mint of
 *                      a TenantContext. Unknown/unusable -> 404 (no absent-vs-suspended oracle).
 *   3. authenticate    Bearer token -> sessionStore.resolve -> Principal. None/unknown -> 401.
 *   4. bind            principal.tenant_id === context.tenant_id, else 401 (cross-tenant replay veto):
 *                      a session minted for A presented on B's route is rejected, never re-scoped to A,
 *                      never dispatched into B.
 *   5. authorize+dispatch the route handler applies the WeddingAuthorizer, then calls the Phase-12
 *                      repository WITH the context.
 *
 * Handler purity is STRUCTURAL, not prose (arch P1-A): the pipeline (this class) is the only code that
 * holds the `resolver` and `sessionStore`. The dispatch handlers are module-level functions that take
 * only the already-resolved `(context, principal, req)` plus a NARROW `WeddingHandlerDeps`
 * (`{ weddings, authorizer }`) — they have no resolver/sessionStore in scope, and a TenantContext can
 * only be minted by the resolver (Phase-12 brand), so a handler physically cannot mint a context for a
 * different tenant. Login, `/healthz`, and the provider-webhook inbound route are the routes that skip stages
 * 3–4 (login IS the mint; healthz is tenant-less; the inbound webhook is a provider, not a session Principal —
 * authenticated by the FOURTH token namespace, the provider-webhook credential, before any route shape).
 *
 * Every error becomes a CODE-FREE constant response (arch P1-C / doddy P1): the masked `404` is one
 * frozen constant shared by unknown-tenant, unknown-route, missing-resource, and couple-non-owned, so
 * none of the distinct internal `PRODUCT.*` codes is observable. Stage precedence is pinned: on a
 * tenant route, tenant-resolve (`404`) and auth+bind (`401`) run BEFORE any `405`/route-shape check,
 * so route shape is not a pre-auth oracle.
 *
 * related: wedding_authorizer.ts (the decisions), session_store.ts (the mint), tenant_context.ts.
 */

// ---- Code-free constant responses (deep-frozen so they are shared, immutable, byte-identical). ----
const RESP_NOT_FOUND: ApiResponse = deepFreeze({ status: 404, body: { error: 'not_found' } })
const RESP_UNAUTHORIZED: ApiResponse = deepFreeze({ status: 401, body: { error: 'unauthorized' } })
const RESP_FORBIDDEN: ApiResponse = deepFreeze({ status: 403, body: { error: 'forbidden' } })
const RESP_BAD_REQUEST: ApiResponse = deepFreeze({ status: 400, body: { error: 'bad_request' } })
const RESP_CONFLICT: ApiResponse = deepFreeze({ status: 409, body: { error: 'conflict' } })
const RESP_METHOD_NOT_ALLOWED: ApiResponse = deepFreeze({ status: 405, body: { error: 'method_not_allowed' } })
const RESP_INTERNAL: ApiResponse = deepFreeze({ status: 500, body: { error: 'internal_error' } })
const RESP_HEALTHZ: ApiResponse = deepFreeze({ status: 200, body: { status: 'ok' } })
/**
 * The inbound-webhook acknowledgement (Phase 19). ONE frozen, byte-identical 202 returned on EVERY
 * post-validation branch of `/t/:slug/messaging/inbound` — registered or not, answered / escalated / refused
 * / deduped — so the response never discloses guest-registry state (doddy P1: the 202 is uniform by
 * construction). "Accepted" not "OK": the platform acknowledges receipt; any reply is an asynchronous,
 * out-of-band send, never reflected in this response.
 */
const RESP_ACCEPTED: ApiResponse = deepFreeze({ status: 202, body: { status: 'accepted' } })

/** The dependencies the dispatch handlers may touch — DELIBERATELY excludes resolver/sessionStore. */
export interface WeddingHandlerDeps {
  readonly weddings: WeddingRepository
  readonly authorizer: WeddingAuthorizer
}

/** The narrow bag handed to the operator-gated /admin handlers — DELIBERATELY excludes the operator store. */
export interface AdminHandlerDeps {
  readonly onboarding: OnboardingService
}

/** Everything the pipeline needs. resolver/sessionStore/operators live ONLY here, never in a handler. */
export interface ProductApiDeps {
  readonly resolver: TenantContextResolver
  readonly sessionStore: SessionStore
  readonly weddings: WeddingRepository
  readonly authorizer: WeddingAuthorizer
  /** Phase 15: the platform-operator credential store (the /admin auth tier) + the onboarding driver. */
  readonly operators: OperatorCredentialStore
  readonly onboarding: OnboardingService
  /**
   * Phase 19: the provider-webhook credential store — the FOURTH token namespace, authenticating the
   * server-to-server inbound webhook (`/t/:slug/messaging/inbound`). Lives ONLY in the pipeline (like
   * `operators`/`sessionStore`); a webhook is not a Principal, so the inbound route skips stages 3–4.
   */
  readonly webhookCredentials: ProviderWebhookCredentialStore
  /**
   * Phase 17: the loop's champion strategy genome (injected — a `@wedding-planner/shared` value; the surface
   * never imports the loop). Projected ONCE to guidance in the constructor; absent ⇒ the strategy route 404s.
   */
  readonly championStrategy?: StrategyGenome
}

export class ProductApi {
  readonly #resolver: TenantContextResolver
  readonly #sessionStore: SessionStore
  /** The platform-operator credential store — lives ONLY in the pipeline (like #sessionStore). */
  readonly #operators: OperatorCredentialStore
  /** The provider-webhook credential store (the inbound-webhook tier) — lives ONLY in the pipeline. */
  readonly #webhookCredentials: ProviderWebhookCredentialStore
  /** The narrow bag handed to every wedding dispatch handler — no resolver/sessionStore. */
  readonly #handlerDeps: WeddingHandlerDeps
  /** The narrow bag handed to every /admin handler — no operator store. */
  readonly #adminDeps: AdminHandlerDeps
  /**
   * The champion strategy projected to planner-facing guidance ONCE at construction (eager + immutable), or
   * undefined when no champion was injected. Eager-precompute is the fail-closed shape: an invalid champion
   * throws HERE (constructor → composeProductSurface → app/server.ts main), aborting boot before any socket
   * opens — never a partial render at request time. The value is a pure function of the injected genome, so
   * the strategy route's present/absent answer is platform-global (it reads no tenant/principal state).
   */
  readonly #strategyGuidance: StrategyGuidance | undefined

  constructor(deps: ProductApiDeps) {
    this.#resolver = deps.resolver
    this.#sessionStore = deps.sessionStore
    this.#operators = deps.operators
    this.#webhookCredentials = deps.webhookCredentials
    this.#handlerDeps = { weddings: deps.weddings, authorizer: deps.authorizer }
    this.#adminDeps = { onboarding: deps.onboarding }
    this.#strategyGuidance =
      deps.championStrategy === undefined ? undefined : deepFreeze(describeStrategy(deps.championStrategy))
  }

  /** Run a request through the pipeline. Never throws — every failure maps to a code-free response. */
  handle(req: ApiRequest): ApiResponse {
    try {
      return this.#route(req)
    } catch (error) {
      // Catch the whole WeddingPlannerError family (ProductError + the shared ContractValidationFailedError
      // a create/update raises on bad client data) and map by code; unknown codes fall to a constant 500.
      if (error instanceof WeddingPlannerError) return errorToResponse(error)
      return RESP_INTERNAL
    }
  }

  #route(req: ApiRequest): ApiResponse {
    const segments = splitPath(req.path)

    // /healthz — tenant-less, unauthenticated liveness.
    if (segments.length === 1 && segments[0] === 'healthz') {
      if (req.method !== 'GET') throw methodNotAllowed()
      return RESP_HEALTHZ
    }

    // /admin/... — the operator-gated platform surface (tenant-less, never touches a TenantContext).
    // Operator auth is the LITERAL FIRST statement, BEFORE any /admin route-shape/method/:id distinction,
    // so an unauthenticated prober gets a byte-identical 401 for ANY /admin path+method (route shape is
    // not a pre-auth oracle). Only after auth passes can a 404/405/400 surface.
    if (segments.length >= 1 && segments[0] === 'admin') {
      this.#authenticateOperator(req)
      return dispatchAdmin(req, segments, this.#adminDeps)
    }

    // All other routes are tenant-scoped: /t/:slug/...
    if (segments.length >= 2 && segments[0] === 't') {
      const slug = segments[1]
      if (slug === undefined) throw routeNotFound()
      // Stage 2 — the SOLE per-request context mint (404 on unknown/unusable, no absent-vs-suspended oracle).
      const context = this.#resolver.resolveBySlug(slug)

      // /t/:slug/sessions — the login mint (unauthenticated by design; it ISSUES the session).
      if (segments.length === 3 && segments[2] === 'sessions') {
        if (req.method !== 'POST') throw methodNotAllowed()
        return this.#handleLogin(context, req)
      }

      // /t/:slug/weddings[...] — PROTECTED: stages 3–4 run BEFORE any method/shape distinction.
      if (segments.length >= 3 && segments[2] === 'weddings') {
        const principal = this.#authenticate(req, context)
        return dispatchWeddings(context, principal, req, segments, this.#handlerDeps)
      }

      // /t/:slug/messaging/... — the PROVIDER-WEBHOOK surface (Phase 19): an inbound guest message.
      // This route is NOT a session Principal route — it SKIPS stages 3–4 (no #authenticate/bind) and is
      // authenticated by the provider-webhook credential instead. Webhook auth is the LITERAL FIRST statement
      // of the branch (before any method/sub-route/body distinction), exactly as operator auth is for /admin,
      // so an unauthenticated prober gets a byte-identical 401 for ANY /messaging path+method — route shape is
      // not a pre-auth oracle. (Tenant-resolve at line above runs first, by design: active-tenant existence is
      // already public via theming, so its 404 mask is the established disclosure boundary for ALL tenant
      // routes; the webhook caller still cannot probe absent-vs-suspended.)
      if (segments.length >= 3 && segments[2] === 'messaging') {
        this.#authenticateWebhook(req)
        return this.#dispatchMessaging(req, segments)
      }

      // /t/:slug/strategy — PROTECTED read-only (Phase 17): the loop's champion strategy as planner guidance.
      // Stages 3–4 (authenticate + bind) run BEFORE the method check, so route shape is NOT a pre-auth oracle:
      // an unauthenticated prober gets a byte-identical 401 for ANY method. The present/absent answer is a
      // PURE function of the injected champion (no read of `context`/`principal`/tenant state), so it is
      // platform-global — identical for every tenant — and manufactures no existence/lifecycle oracle. A
      // missing champion returns the SAME frozen masked 404 as any other unknown resource.
      if (segments.length === 3 && segments[2] === 'strategy') {
        this.#authenticate(req, context)
        if (req.method !== 'GET') throw methodNotAllowed()
        if (this.#strategyGuidance === undefined) return RESP_NOT_FOUND
        return { status: 200, body: { strategy: this.#strategyGuidance } }
      }

      // A valid tenant, but no such sub-resource.
      throw routeNotFound()
    }

    throw routeNotFound()
  }

  /**
   * Operator auth for /admin: resolve the bearer token via the operator store (a SEPARATE namespace from
   * the session store). Absent/unknown -> NO_OPERATOR (a constant 401). A tenant session token is simply
   * absent here, so it fails identically — no cross-namespace privilege. The Operator is platform-wide;
   * there is no per-operator scoping to apply downstream, so the gate IS the authorization.
   */
  #authenticateOperator(req: ApiRequest): void {
    const operator = this.#operators.resolve(bearerToken(req.headers.authorization))
    if (operator === undefined) {
      throw new ProductError('PRODUCT.NO_OPERATOR', 'No valid operator credential for this request.', {})
    }
  }

  /**
   * Provider-webhook auth for `/t/:slug/messaging/...`: resolve the bearer token via the provider-webhook
   * store (a FOURTH namespace, separate from session + operator). Absent/unknown -> NO_WEBHOOK_CREDENTIAL
   * (a constant 401). A session or operator token is simply absent here, so it fails identically — no
   * cross-namespace privilege. The credential is platform-wide (one provider integration), so the gate IS the
   * authorization; the tenant is established by the route :slug + the per-tenant guest registry downstream.
   */
  #authenticateWebhook(req: ApiRequest): void {
    const credential = this.#webhookCredentials.resolve(bearerToken(req.headers.authorization))
    if (credential === undefined) {
      throw new ProductError('PRODUCT.NO_WEBHOOK_CREDENTIAL', 'No valid provider webhook credential.', {})
    }
  }

  /**
   * Dispatch the provider-webhook messaging surface (auth already passed). This rung wires ONLY the inbound
   * acknowledgement skeleton: POST `/t/:slug/messaging/inbound` -> the frozen 202. Body validation, guest
   * resolution, and the metered reply land in the following steps. Every accepted path returns the SAME
   * `RESP_ACCEPTED` constant (the uniform-202 invariant).
   */
  #dispatchMessaging(req: ApiRequest, segments: readonly string[]): ApiResponse {
    if (segments.length === 4 && segments[3] === 'inbound') {
      if (req.method !== 'POST') throw methodNotAllowed()
      return RESP_ACCEPTED
    }
    throw routeNotFound()
  }

  /** Stage 3 + 4: resolve the bearer token to a principal and bind it to the resolved tenant. */
  #authenticate(req: ApiRequest, context: TenantContext): Principal {
    const principal = this.#sessionStore.resolve(bearerToken(req.headers.authorization))
    if (principal === undefined) {
      throw new ProductError('PRODUCT.NO_SESSION', 'No valid session for this request.', {})
    }
    // The cross-tenant replay veto: a session for another tenant is unauthenticated HERE (never re-scoped).
    if (principal.tenant_id !== context.tenant_id) {
      throw new ProductError(
        'PRODUCT.SESSION_TENANT_MISMATCH',
        'Session belongs to a different tenant than the request route.',
        {},
      )
    }
    return principal
  }

  /** POST /t/:slug/sessions — the simulated login. Mints a principal bound to the RESOLVED tenant. */
  #handleLogin(context: TenantContext, req: ApiRequest): ApiResponse {
    const body = parseObjectBody(req.rawBody)
    const role = body.role
    if (role !== 'planner' && role !== 'couple') {
      throw new ProductError('PRODUCT.BAD_REQUEST', 'role must be "planner" or "couple".', {})
    }
    const wedding_id = optionalString(body, 'wedding_id')
    // SessionStore enforces the couple-needs-wedding_id rule and never verifies its existence (no oracle).
    const session = this.#sessionStore.login(context, { role, wedding_id })
    return {
      status: 201,
      body: { token: session.token, principal: principalView(session.principal) },
    }
  }
}

/** Map a WeddingPlannerError to a code-free response. The ONLY place codes become statuses. */
function errorToResponse(error: WeddingPlannerError): ApiResponse {
  switch (error.code) {
    case 'PRODUCT.UNKNOWN_TENANT':
    case 'PRODUCT.TENANT_NOT_USABLE':
    case 'PRODUCT.ROUTE_NOT_FOUND':
      return RESP_NOT_FOUND
    // NO_OPERATOR / NO_WEBHOOK_CREDENTIAL: an /admin or inbound-webhook request with no/unknown credential —
    // the same constant 401 as a missing tenant session, so auth-failure on any of the three non-anonymous
    // namespaces (session / operator / provider-webhook) is indistinguishable from any other unauthenticated.
    case 'PRODUCT.NO_SESSION':
    case 'PRODUCT.SESSION_TENANT_MISMATCH':
    case 'PRODUCT.NO_OPERATOR':
    case 'PRODUCT.NO_WEBHOOK_CREDENTIAL':
      return RESP_UNAUTHORIZED
    case 'PRODUCT.FORBIDDEN':
      return RESP_FORBIDDEN
    // CONTRACT.VALIDATION_FAILED: a wedding/tenant create with bad client data (event_date/status/tier enum).
    case 'PRODUCT.BAD_REQUEST':
    case 'PRODUCT.VALIDATION_FAILED':
    case 'CONTRACT.VALIDATION_FAILED':
      return RESP_BAD_REQUEST
    // DUPLICATE_SLUG / ILLEGAL_LIFECYCLE_TRANSITION: honest 409s to the TRUSTED operator (NOT masked — the
    // absent-vs-suspended mask is an ANONYMOUS-edge property; the operator legitimately sees tenant state).
    case 'PRODUCT.DUPLICATE_SLUG':
    case 'PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION':
      return RESP_CONFLICT
    case 'PRODUCT.METHOD_NOT_ALLOWED':
      return RESP_METHOD_NOT_ALLOWED
    // FORGED_CONTEXT / FORGED_PRINCIPAL / CROSS_TENANT_WRITE / anything else: an internal invariant
    // violation a real request can never construct — a 500 bug, never a normal client path, never leaked.
    default:
      return RESP_INTERNAL
  }
}

// ---------------------------------------------------------------------------------------------------
// Dispatch handlers — module-level functions taking ONLY (context, principal, req) + the narrow deps.
// They have no resolver/sessionStore in scope (structural handler purity). A TenantContext can only be
// minted by the resolver, so a handler cannot fabricate one for another tenant.
// ---------------------------------------------------------------------------------------------------

function dispatchWeddings(
  context: TenantContext,
  principal: Principal,
  req: ApiRequest,
  segments: readonly string[],
  deps: WeddingHandlerDeps,
): ApiResponse {
  if (segments.length === 3) {
    // /t/:slug/weddings
    if (req.method === 'GET') return handleList(context, principal, deps)
    if (req.method === 'POST') return handleCreate(context, principal, req, deps)
    throw methodNotAllowed()
  }
  if (segments.length === 4) {
    // /t/:slug/weddings/:weddingId
    const weddingId = segments[3]
    if (weddingId === undefined) throw routeNotFound()
    if (req.method === 'GET') return handleRead(context, principal, weddingId, deps)
    if (req.method === 'PUT') return handleUpdate(context, principal, req, weddingId, deps)
    throw methodNotAllowed()
  }
  throw routeNotFound()
}

function handleList(context: TenantContext, principal: Principal, deps: WeddingHandlerDeps): ApiResponse {
  const scope = deps.authorizer.listScope(principal)
  let weddings: readonly Wedding[]
  if (scope.kind === 'all') {
    weddings = deps.weddings.list(context)
  } else {
    // Couple: zero-or-one, derived ONLY from the bound wedding_id — never pull+filter the partition.
    const one = scope.wedding_id === undefined ? undefined : deps.weddings.get(context, scope.wedding_id)
    weddings = one === undefined ? [] : [one]
  }
  return { status: 200, body: { weddings } }
}

function handleCreate(
  context: TenantContext,
  principal: Principal,
  req: ApiRequest,
  deps: WeddingHandlerDeps,
): ApiResponse {
  if (deps.authorizer.authorizeCreate(principal) === 'forbidden') throw forbidden()
  const body = parseObjectBody(req.rawBody)
  const input: CreateWeddingInput = {
    couple_display_name: requireString(body, 'couple_display_name'),
    event_date: requireString(body, 'event_date'),
    ...(body.status === undefined ? {} : { status: requireString(body, 'status') as Wedding['status'] }),
  }
  // create stamps tenant_id from the context and validates against the wedding contract (bad enum/date
  // -> VALIDATION_FAILED -> 400). The body never carries tenant_id/wedding_id.
  const wedding = deps.weddings.create(context, input)
  return { status: 201, body: { wedding } }
}

function handleRead(
  context: TenantContext,
  principal: Principal,
  weddingId: string,
  deps: WeddingHandlerDeps,
): ApiResponse {
  // Couple ownership is decided structurally first; a non-owned id is masked WITHOUT a repo lookup.
  if (deps.authorizer.authorizeRead(principal, weddingId) === 'mask-not-found') return RESP_NOT_FOUND
  const wedding = deps.weddings.get(context, weddingId)
  // An owned-but-absent id reads back the SAME constant 404 (masking holds from the own-missing side).
  if (wedding === undefined) return RESP_NOT_FOUND
  return { status: 200, body: { wedding } }
}

function handleUpdate(
  context: TenantContext,
  principal: Principal,
  req: ApiRequest,
  weddingId: string,
  deps: WeddingHandlerDeps,
): ApiResponse {
  // Authorization/ownership precede body validation (arch P1-B): a non-owned id is masked before the
  // body is even parsed, so a malformed body on a non-owned id cannot leak a 400 that distinguishes it.
  if (deps.authorizer.authorizeUpdate(principal, weddingId) === 'mask-not-found') return RESP_NOT_FOUND
  const existing = deps.weddings.get(context, weddingId)
  if (existing === undefined) return RESP_NOT_FOUND // own-but-absent: identical masked 404
  const body = parseObjectBody(req.rawBody)
  // Reconstruct from the existing record + the patch; identity (wedding_id) comes from the ROUTE and
  // ownership (tenant_id) from the CONTEXT, both applied LAST so a smuggled body field cannot re-target.
  const updated: Wedding = {
    couple_display_name: body.couple_display_name === undefined
      ? existing.couple_display_name
      : requireString(body, 'couple_display_name'),
    event_date: body.event_date === undefined ? existing.event_date : requireString(body, 'event_date'),
    status: body.status === undefined ? existing.status : (requireString(body, 'status') as Wedding['status']),
    created_at: existing.created_at,
    wedding_id: weddingId,
    tenant_id: context.tenant_id,
  }
  // update re-validates against the wedding contract, so the `status` cast above is closed at runtime
  // (a non-enum value -> CONTRACT.VALIDATION_FAILED -> 400). Keep validation downstream of the cast.
  const saved = deps.weddings.update(context, updated)
  return { status: 200, body: { wedding: saved } }
}

// ---------------------------------------------------------------------------------------------------
// Admin dispatch — operator-gated (auth already passed in the pipeline). Tenant-less: these never mint or
// touch a TenantContext; they drive the OnboardingService. The operator is platform-wide (no per-operator
// scoping), so the gate IS the authorization and the handlers need only the narrow { onboarding } bag.
// ---------------------------------------------------------------------------------------------------

function dispatchAdmin(req: ApiRequest, segments: readonly string[], deps: AdminHandlerDeps): ApiResponse {
  // /admin/tenants — provision a new tenant.
  if (segments.length === 2 && segments[1] === 'tenants') {
    if (req.method !== 'POST') throw methodNotAllowed()
    return handleProvision(req, deps)
  }
  // /admin/tenants/:id/<action>
  if (segments.length === 4 && segments[1] === 'tenants') {
    const tenantId = segments[2]
    const action = segments[3]
    if (tenantId === undefined || action === undefined) throw routeNotFound()
    if (action === 'billing') {
      if (req.method !== 'GET') throw methodNotAllowed()
      return { status: 200, body: deps.onboarding.billingView(tenantId) }
    }
    if (action === 'activate' || action === 'suspend' || action === 'reactivate') {
      if (req.method !== 'POST') throw methodNotAllowed()
      const tenant = deps.onboarding[action](tenantId)
      return { status: 200, body: { tenant } }
    }
    throw routeNotFound()
  }
  throw routeNotFound()
}

function handleProvision(req: ApiRequest, deps: AdminHandlerDeps): ApiResponse {
  const body = parseObjectBody(req.rawBody)
  // slug/display_name/plan_tier are read by name; the theme object is passed through and the tenant
  // schema (asserted inside tenants.create) validates its full shape — a malformed theme/tier -> 400.
  const tenant = deps.onboarding.provision({
    slug: requireString(body, 'slug'),
    display_name: requireString(body, 'display_name'),
    plan_tier: requireString(body, 'plan_tier') as PlanTier,
    theme: requireObject(body, 'theme') as Tenant['theme'],
  })
  return { status: 201, body: { tenant } }
}

// ---------------------------------- request/response helpers ----------------------------------

/** Extract the token from an `Authorization: Bearer <token>` header (case-insensitive scheme). */
function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const match = /^Bearer (.+)$/i.exec(header.trim())
  const token = match?.[1]
  return token === undefined ? undefined : token.trim()
}

/**
 * Parse a JSON object body. Malformed JSON, a non-object, or an array -> 400. Fields are read by name
 * downstream (never blind-spread), and `__proto__`/`constructor`/`prototype` keys are stripped, so a
 * pollution payload is inert.
 */
function parseObjectBody(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined || raw.length === 0) {
    throw new ProductError('PRODUCT.BAD_REQUEST', 'A request body is required.', {})
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ProductError('PRODUCT.BAD_REQUEST', 'Request body is not valid JSON.', {})
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ProductError('PRODUCT.BAD_REQUEST', 'Request body must be a JSON object.', {})
  }
  const safe: Record<string, unknown> = {}
  for (const key of Object.keys(parsed as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    safe[key] = (parsed as Record<string, unknown>)[key]
  }
  return safe
}

/** Read a required non-empty string field, or 400. */
function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProductError('PRODUCT.BAD_REQUEST', `Field '${key}' must be a non-empty string.`, {})
  }
  return value
}

/** Read a required plain-object field, or 400 (the deep shape is validated downstream by the contract). */
function requireObject(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProductError('PRODUCT.BAD_REQUEST', `Field '${key}' must be a JSON object.`, {})
  }
  return value as Record<string, unknown>
}

/** Read an optional string field (absent -> undefined; present-but-not-a-string -> 400). */
function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new ProductError('PRODUCT.BAD_REQUEST', `Field '${key}' must be a string.`, {})
  }
  return value
}

/** The client-facing view of a principal (no brand, plain data). */
function principalView(principal: Principal): Record<string, unknown> {
  return {
    principal_id: principal.principal_id,
    tenant_id: principal.tenant_id,
    role: principal.role,
    ...(principal.wedding_id === undefined ? {} : { wedding_id: principal.wedding_id }),
  }
}

function methodNotAllowed(): ProductError {
  return new ProductError('PRODUCT.METHOD_NOT_ALLOWED', 'Method not allowed for this route.', {})
}
function routeNotFound(): ProductError {
  return new ProductError('PRODUCT.ROUTE_NOT_FOUND', 'No such route.', {})
}
function forbidden(): ProductError {
  return new ProductError('PRODUCT.FORBIDDEN', 'This principal may not perform that operation.', {})
}
