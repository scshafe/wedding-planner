import { deepFreeze, type Wedding, WeddingPlannerError } from '@wedding-planner/shared'

import type { Principal } from '../auth/principal'
import type { SessionStore } from '../auth/session_store'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { ProductError } from '../product_error'
import type { TenantContext, TenantContextResolver } from '../tenant/tenant_context'
import type { CreateWeddingInput, WeddingRepository } from '../wedding/wedding_repository'
import type { ApiRequest, ApiResponse } from './api_message'

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
 * different tenant. Login and `/healthz` are the only routes that skip stages 3–4 (login IS the mint;
 * healthz is tenant-less).
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
const RESP_METHOD_NOT_ALLOWED: ApiResponse = deepFreeze({ status: 405, body: { error: 'method_not_allowed' } })
const RESP_INTERNAL: ApiResponse = deepFreeze({ status: 500, body: { error: 'internal_error' } })
const RESP_HEALTHZ: ApiResponse = deepFreeze({ status: 200, body: { status: 'ok' } })

/** The dependencies the dispatch handlers may touch — DELIBERATELY excludes resolver/sessionStore. */
export interface WeddingHandlerDeps {
  readonly weddings: WeddingRepository
  readonly authorizer: WeddingAuthorizer
}

/** Everything the pipeline needs. The resolver/sessionStore live ONLY here, never in a handler. */
export interface ProductApiDeps {
  readonly resolver: TenantContextResolver
  readonly sessionStore: SessionStore
  readonly weddings: WeddingRepository
  readonly authorizer: WeddingAuthorizer
}

export class ProductApi {
  readonly #resolver: TenantContextResolver
  readonly #sessionStore: SessionStore
  /** The narrow bag handed to every dispatch handler — no resolver/sessionStore. */
  readonly #handlerDeps: WeddingHandlerDeps

  constructor(deps: ProductApiDeps) {
    this.#resolver = deps.resolver
    this.#sessionStore = deps.sessionStore
    this.#handlerDeps = { weddings: deps.weddings, authorizer: deps.authorizer }
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

      // A valid tenant, but no such sub-resource.
      throw routeNotFound()
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
    case 'PRODUCT.NO_SESSION':
    case 'PRODUCT.SESSION_TENANT_MISMATCH':
      return RESP_UNAUTHORIZED
    case 'PRODUCT.FORBIDDEN':
      return RESP_FORBIDDEN
    // CONTRACT.VALIDATION_FAILED: a wedding create/update with bad client data (event_date/status enum).
    case 'PRODUCT.BAD_REQUEST':
    case 'PRODUCT.VALIDATION_FAILED':
    case 'CONTRACT.VALIDATION_FAILED':
      return RESP_BAD_REQUEST
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

// ---------------------------------- request/response helpers ----------------------------------

/** Split a path into non-empty segments: `/t/alpha/weddings/` -> ['t','alpha','weddings']. */
function splitPath(path: string): string[] {
  const query = path.indexOf('?')
  const clean = query === -1 ? path : path.slice(0, query)
  return clean.split('/').filter((s) => s.length > 0)
}

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
