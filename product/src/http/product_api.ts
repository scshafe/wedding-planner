import {
  deepFreeze,
  getSchemaRegistry,
  type GuestEscalation,
  type InboundWebhook,
  type StrategyGenome,
  type Tenant,
  type Wedding,
  WeddingPlannerError,
} from '@wedding-planner/shared'

import type { GuestAuthorizer } from '../auth/guest_authorizer'
import type { OperatorCredentialStore } from '../auth/operator_credential'
import type { Principal } from '../auth/principal'
import type { ProviderWebhookCredentialStore } from '../auth/provider_webhook_credential'
import type { SessionStore } from '../auth/session_store'
import type { WeddingAuthorizer } from '../auth/wedding_authorizer'
import type { BillingLedger } from '../billing/billing_ledger'
import { buildBillingActivity } from '../billing/billing_activity'
import { buildBillingSummary } from '../billing/billing_summary'
import type { PlanTier } from '../billing/price_book'
import type { OnboardingService } from '../onboarding/onboarding_service'
import type { GuestQaResponder } from '../messaging/guest_qa_responder'
import { projectGuestVisibleFacts } from '../messaging/guest_qa_responder'
import type { EscalationLog } from '../messaging/escalation_log'
import type { EscalationReplyLog } from '../messaging/escalation_reply_log'
import type { EscalationResolutionLog } from '../messaging/escalation_resolution_log'
import type { GuestRegistry } from '../messaging/guest_registry'
import type { InboundReceiptLog } from '../messaging/inbound_receipt_log'
import type { MessagingPort } from '../messaging/messaging_port'
import type { MessagingService } from '../messaging/messaging_service'
import { ProductError } from '../product_error'
import { describeStrategy, type StrategyGuidance } from '../strategy/strategy_guidance'
import type { TenantContext, TenantContextResolver } from '../tenant/tenant_context'
import type { TenantStore } from '../tenant/tenant_store'
import type { CreateWeddingInput, WeddingLogisticsField, WeddingRepository } from '../wedding/wedding_repository'
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
/**
 * The escalation-resolve MISS response (Phase 27). ONE frozen, byte-identical `{resolved:false}` returned on
 * EVERY non-resolving branch of `POST /t/:slug/escalations` — the escalation is absent, OR a couple is
 * resolving an escalation outside their bound wedding. Sharing a single frozen constant across both branches
 * makes the byte-identical-miss STRUCTURAL (not test-hoped): a couple cannot distinguish "no such escalation"
 * from "an escalation exists but in another wedding", so the resolve mutation is not a cross-wedding existence
 * oracle (doddy F1). A successful resolve returns the distinct `{resolved:true}`.
 */
const RESP_RESOLVE_MISS: ApiResponse = deepFreeze({ status: 200, body: { resolved: false } })

/**
 * The escalation-REPLY miss response (Phase 28/34). ONE frozen, byte-identical `{replied:false}` returned on
 * EVERY non-sending miss branch of a reply POST — the escalation is absent, a couple is replying outside their
 * bound wedding, the escalation is ALREADY handled (resolved/dismissed → no send, and a `dismissed` escalation
 * never dispatches a billed reply), OR the metered send raised a structured failure (margin/cost — the
 * escalation stays Open + retryable). Sharing ONE constant across these branches makes the no-oracle STRUCTURAL:
 * a couple cannot distinguish "no such escalation" from "an escalation in another wedding", and no
 * foreign-wedding probe sends, bills, or records anything. A successful reply returns the distinct
 * `{replied:true}`; a same-seq/different-body lost-update returns the distinct `409` (RESP_REPLY_CONFLICT,
 * reachable only AFTER the full scope+open gates pass, so it discloses nothing new). Separate from
 * RESP_RESOLVE_MISS (different body key) by design.
 */
const RESP_REPLY_MISS: ApiResponse = deepFreeze({ status: 200, body: { replied: false } })

/**
 * The reply CONFLICT response (Phase 34). A reply whose `seq` slot is already taken by a DIFFERENT body is a
 * lost-update (a stale form, or a co-operator raced the slot): honestly reported as a `409` so the operator
 * resends from a fresh `seq`, never a silent `{replied:true}` lie. Reachable ONLY after scope + open gates pass
 * (the operator already sees this escalation + its thread), so it is no existence oracle.
 */
const RESP_REPLY_CONFLICT: ApiResponse = deepFreeze({ status: 409, body: { replied: false } })

/**
 * The hygiene cap on a console reply body (Phase 28/34). The reply text is TRUSTED operator input (an
 * authenticated planner/couple), so this is bounds-checking, not a security gate — it keeps a single metered
 * reply sane and fires as a masked 400 BEFORE the escalation lookup (independent of existence, so not an oracle).
 *
 * EXPORTED so the drift guard can pin it EQUAL to the `escalation_reply` schema's `body` `maxLength`: the
 * no-500-oracle argument (a reply that passes this handler can never fail `append()`'s assertValid) holds ONLY
 * while the two `2000`s match. A test asserts the equality so a future bump to one can't silently re-open the
 * oracle. (Phase 34 moved the transcript from `escalation_resolution.reply_text` to `escalation_reply.body`, so
 * this constant — renamed from REPLY_TEXT_MAX_LENGTH — now pins the thread message length.)
 */
export const REPLY_BODY_MAX_LENGTH = 2000

/** The dependencies the dispatch handlers may touch — DELIBERATELY excludes resolver/sessionStore. */
export interface WeddingHandlerDeps {
  readonly weddings: WeddingRepository
  readonly authorizer: WeddingAuthorizer
}

/** The narrow bag handed to the operator-gated /admin handlers — DELIBERATELY excludes the operator store. */
export interface AdminHandlerDeps {
  readonly onboarding: OnboardingService
}

/**
 * The narrow bag handed to the provider-webhook inbound handler (Phase 19) — DELIBERATELY excludes the webhook
 * credential store (auth already passed in the pipeline). It carries exactly the collaborators the inbound
 * reply path orchestrates: the provider `port` (untrusted→domain normalize), the per-tenant inbound dedupe
 * `receipts`, the guest `registry` (segmentation), the tenant-scoped `weddings` (the bound facts), the
 * deterministic `responder`, the metered `service` (the only path that bills), and the `escalations` inbox
 * (Phase 26 — an `escalated` question is recorded here so the couple/planner can read it; `refused`/`answered`
 * are never recorded).
 */
export interface MessagingHandlerDeps {
  readonly port: MessagingPort
  readonly receipts: InboundReceiptLog
  readonly registry: GuestRegistry
  readonly weddings: WeddingRepository
  readonly responder: GuestQaResponder
  readonly service: MessagingService
  readonly escalations: EscalationLog
  /**
   * Phase 35 — guest-reply → thread correlation. The inbound edge READS these to decide whether an
   * `escalated` follow-up threads into the guest's most-recent OPEN escalation (vs opening a new one):
   * `resolutions` is NARROWED to the read-only `effectiveStatus` fold (the open-status join; Phase 36 replaced
   * the single-record `getByEscalationId` with this fold); inbound NEVER transitions, so the narrowing makes
   * that structural, mirroring BillingHandlerDeps. The full `replies` log is the write target
   * (`recordGuestReply`) + the re-delivery guard (`guestTurnByProviderRef`).
   */
  readonly resolutions: Pick<EscalationResolutionLog, 'effectiveStatus'>
  readonly replies: EscalationReplyLog
}

/**
 * The narrow bag handed to the guest-management handlers (Phase 21) — planner-only CRUD over the guest
 * registry. Carries the `registry` (the tenant-scoped segmentation store), the `weddings` repo (to verify a
 * registration's wedding exists in-tenant — referential integrity for a trusted planner, NOT an oracle), and
 * the planner-only `authorizer`. No resolver/sessionStore (structural handler purity).
 */
export interface GuestHandlerDeps {
  readonly registry: GuestRegistry
  readonly weddings: WeddingRepository
  readonly authorizer: GuestAuthorizer
}

/**
 * The bag handed to the escalation-inbox handlers. Read (Phase 26) + resolve (Phase 27) + reply (Phase 28),
 * so it is now READ-WRITE: `escalations` + `resolutions` + the `authorizer` (reused for `manageScope` —
 * escalation-visibility scope == guest-management scope = the wedding partition) + the metered `service` (the
 * reply path's send). Still NO `weddings` (no referential-integrity read here, unlike GuestHandlerDeps's
 * register path); no resolver/sessionStore (structural handler purity).
 */
export interface EscalationHandlerDeps {
  readonly escalations: EscalationLog
  /**
   * Phase 27: the append-only handled-record log (resolved/dismissed). The read returns it alongside
   * `escalations` (the consumer joins by `escalation_id`); the resolve mutation writes it. Keyed by
   * `escalation_id`, scoped by the SAME `manageScope` branch as the escalations — so a couple's resolutions
   * array never carries a sibling wedding's record. Phase 34: the reply path no longer writes here (replies no
   * longer auto-resolve); a resolution is now a pure handled-marker.
   */
  readonly resolutions: EscalationResolutionLog
  /**
   * Phase 34: the per-escalation reply THREAD (multi-turn). The read returns it as the third scoped array (the
   * consumer joins by `escalation_id`); the reply mutation appends to it (a console reply appends + sends but
   * does NOT resolve). Keyed by `(escalation_id, seq)`, scoped by the SAME `manageScope` branch — so a couple's
   * replies array never carries a sibling wedding's thread.
   */
  readonly replies: EscalationReplyLog
  readonly authorizer: GuestAuthorizer
  /**
   * Phase 28: the metered send path for reply-from-the-inbox. The SAME `MessagingService` instance the inbound
   * webhook uses (wired at compose), so a console reply and a guest reply meter/bill through one ledger. The
   * reply is billed from OUR record (the Phase-18 firewall), never the provider; channel/recipient come from
   * the LIVE escalation (never the request body), and the meter key is the deterministic `reply:${id}:${seq}`.
   */
  readonly service: MessagingService
}

/**
 * The narrow bag handed to the planner billing-summary handler (Phase 30). `ledger` is read NARROWED to the fold
 * (`summarize` only — not `record`, so the read surface can never write a billing event); `tenants` is narrowed to
 * `findById` ONLY (read the TRUSTED `plan_tier` of the caller's own tenant, keyed by `context.tenant_id` — never a
 * body field); `authorizer` is the GuestAuthorizer (the management-capability home) for the planner-only gate. No
 * resolver/sessionStore (structural handler purity); no `weddings` (billing is tenant-account, not per-wedding).
 */
export interface BillingHandlerDeps {
  readonly ledger: Pick<BillingLedger, 'summarize' | 'settleBalance' | 'eventsFor'>
  readonly tenants: Pick<TenantStore, 'findById'>
  readonly authorizer: GuestAuthorizer
}

/** Everything the pipeline needs. resolver/sessionStore/operators live ONLY here, never in a handler. */
export interface ProductApiDeps {
  readonly resolver: TenantContextResolver
  readonly sessionStore: SessionStore
  readonly weddings: WeddingRepository
  readonly authorizer: WeddingAuthorizer
  /**
   * Phase 21: the planner-facing guest-management surface (register/list/remove). REQUIRED (core planner
   * functionality, unlike the optional `messaging` channel) — `composeProductSurface` always wires it.
   */
  readonly guests: GuestHandlerDeps
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
   * Phase 19: the collaborators the inbound reply path needs. Optional — like `championStrategy`, the messaging
   * channel is an optional surface feature; when absent the `/t/:slug/messaging/...` route is simply not mounted
   * (a valid-tenant-no-subresource 404). `composeProductSurface` always wires it; tests that exercise the
   * inbound edge inject it, others omit it.
   */
  readonly messaging?: MessagingHandlerDeps
  /**
   * Phase 26: the couple/planner-facing escalation inbox read surface. Optional — like `messaging`, mounted
   * only when wired; when absent `GET /t/:slug/escalations` is an unmounted-subresource 404. The SAME
   * EscalationLog instance the inbound capture (`messaging.escalations`) writes to; `composeProductSurface`
   * always wires both.
   */
  readonly escalations?: EscalationHandlerDeps
  /**
   * Phase 30: the planner-facing billing & usage summary read surface. Optional — like `escalations`/`messaging`,
   * mounted only when wired; when absent `GET /t/:slug/billing` is an unmounted-subresource 404.
   * `composeProductSurface` ALWAYS wires it (a compose e2e pins that it is reachable on the demo tenant), so the
   * optional shape is for test-fixture omission, not a real off state — billing visibility is core planner
   * functionality. (Required would mean updating every hand-built ProductApi fixture; the established
   * subresource convention here is "compose always wires it, tests inject when exercising".)
   */
  readonly billing?: BillingHandlerDeps
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
  /** The inbound reply-path collaborators (Phase 19), or undefined when the messaging channel is not wired. */
  readonly #messaging: MessagingHandlerDeps | undefined
  /** The escalation-inbox read deps (Phase 26), or undefined when the inbox read surface is not wired. */
  readonly #escalations: EscalationHandlerDeps | undefined
  /** The planner billing-summary read deps (Phase 30), or undefined when not wired. */
  readonly #billing: BillingHandlerDeps | undefined
  /** The narrow bag handed to every wedding dispatch handler — no resolver/sessionStore. */
  readonly #handlerDeps: WeddingHandlerDeps
  /** The narrow bag handed to every guest-management handler (Phase 21) — no resolver/sessionStore. */
  readonly #guests: GuestHandlerDeps
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
    this.#messaging = deps.messaging
    this.#escalations = deps.escalations
    this.#billing = deps.billing
    this.#handlerDeps = { weddings: deps.weddings, authorizer: deps.authorizer }
    this.#guests = deps.guests
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

      // /t/:slug/guests[...] — PROTECTED planner-only management (Phase 21). Stages 3–4 run BEFORE any
      // method/shape distinction (route shape is not a pre-auth oracle), exactly like `weddings`. The opaque
      // recipient_ref travels in the BODY, never the URL, so there is no `:id` sub-path to encode.
      if (segments.length === 3 && segments[2] === 'guests') {
        const principal = this.#authenticate(req, context)
        return dispatchGuests(context, principal, req, this.#guests)
      }

      // /t/:slug/escalations — PROTECTED read-only inbox (Phase 26): the guest questions the platform could not
      // answer, scoped planner=whole-tenant / couple=their-wedding (manageScope). Stages 3–4 run BEFORE the
      // method check (route shape is not a pre-auth oracle), exactly like `guests`. Mounted only when wired.
      if (this.#escalations !== undefined && segments.length === 3 && segments[2] === 'escalations') {
        const principal = this.#authenticate(req, context)
        return dispatchEscalations(context, principal, req, this.#escalations)
      }

      // /t/:slug/billing — PROTECTED planner-only (Phase 30): the tenant's OWN billing & usage summary. Stages
      // 3–4 (authenticate) run BEFORE any method/authorize check (route shape is not a pre-auth oracle — a
      // byte-identical 401 for any method, like `strategy`). The summary is folded from the caller's own ledger
      // keyed by `context.tenant_id` (the trusted minted context, never a body field). Mounted only when wired.
      if (this.#billing !== undefined && segments.length === 3 && segments[2] === 'billing') {
        const principal = this.#authenticate(req, context)
        return dispatchBilling(context, principal, req, this.#billing)
      }

      // /t/:slug/messaging/... — the PROVIDER-WEBHOOK surface (Phase 19): an inbound guest message.
      // This route is NOT a session Principal route — it SKIPS stages 3–4 (no #authenticate/bind) and is
      // authenticated by the provider-webhook credential instead. Webhook auth is the LITERAL FIRST statement
      // of the branch (before any method/sub-route/body distinction), exactly as operator auth is for /admin,
      // so an unauthenticated prober gets a byte-identical 401 for ANY /messaging path+method — route shape is
      // not a pre-auth oracle. (Tenant-resolve at line above runs first, by design: active-tenant existence is
      // already public via theming, so its 404 mask is the established disclosure boundary for ALL tenant
      // routes; the webhook caller still cannot probe absent-vs-suspended.)
      if (this.#messaging !== undefined && segments.length >= 3 && segments[2] === 'messaging') {
        this.#authenticateWebhook(req)
        return dispatchMessaging(context, req, segments, this.#messaging)
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
    // GUEST_ALREADY_REGISTERED joins these: an honest 409 to the TRUSTED planner (a duplicate recipient_ref) —
    // like DUPLICATE_SLUG, the mask is an anonymous-edge property; the planner legitimately sees their own state.
    case 'PRODUCT.DUPLICATE_SLUG':
    case 'PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION':
    case 'PRODUCT.GUEST_ALREADY_REGISTERED':
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
  // Optional logistics fields: read as strings here (present-but-not-a-string -> 400), spread in only when
  // present (a literal `k: undefined` would Ajv-reject as the optional `type:string` and pollute the
  // record's keys), and let the wedding contract validate pattern/maxLength downstream. NOTE (Phase 25): unlike
  // PUT, create has NO clear-to-absent sentinel — an empty optional (`dress_code:''`) is malformed on POST
  // (nothing to clear on a new resource) and the contract's minLength/pattern rejects it -> 400; omit it to
  // leave the field unset. The '' = clear semantics live ONLY in handleUpdate.
  const ceremony_time = optionalString(body, 'ceremony_time')
  const venue_name = optionalString(body, 'venue_name')
  const parking_info = optionalString(body, 'parking_info')
  const dress_code = optionalString(body, 'dress_code')
  const input: CreateWeddingInput = {
    couple_display_name: requireString(body, 'couple_display_name'),
    event_date: requireString(body, 'event_date'),
    ...(body.status === undefined ? {} : { status: requireString(body, 'status') as Wedding['status'] }),
    ...(ceremony_time === undefined ? {} : { ceremony_time }),
    ...(venue_name === undefined ? {} : { venue_name }),
    ...(parking_info === undefined ? {} : { parking_info }),
    ...(dress_code === undefined ? {} : { dress_code }),
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
  // Each optional logistics field is THREE-WAY on update (Phase 25 — PUT is patch semantics):
  //   key ABSENT          -> PRESERVE the stored value (a direct JSON caller omitting a key is unchanged)
  //   key present as ''    -> CLEAR to absent: return `undefined` so it flows through the SAME conditional
  //                          spread below (`...(x===undefined?{}:{x})`) and the key is dropped from the record
  //   key present, value   -> validate (`requireString`) + set
  // The '' clear-sentinel is recognized ONLY here (the optional-logistics branch of PUT) — `requireString`/
  // `optionalString` are untouched, so the CREATE path stays byte-for-byte (a POST `dress_code:''` still 400s
  // via the contract: nothing to clear on create, so an empty optional is malformed — omit it to leave unset).
  // The match is on the RAW body value with STRICT equality, so a non-string ([''], 0, null, {}) is neither
  // absent nor '' and falls to `requireString` -> 400; a cleared field is then re-validated as a valid absent
  // optional. Clearing strictly REDUCES guest disclosure (the responder escalates instead of answering).
  const patchOptional = (key: WeddingLogisticsField): string | undefined => {
    const raw = body[key]
    if (raw === undefined) return existing[key]
    if (raw === '') return undefined
    return requireString(body, key)
  }
  // Reconstruct from the existing record + the patch; identity (wedding_id) comes from the ROUTE and
  // ownership (tenant_id) from the CONTEXT, both applied LAST so a smuggled body field cannot re-target.
  const ceremony_time = patchOptional('ceremony_time')
  const venue_name = patchOptional('venue_name')
  const parking_info = patchOptional('parking_info')
  const dress_code = patchOptional('dress_code')
  const updated: Wedding = {
    couple_display_name: body.couple_display_name === undefined
      ? existing.couple_display_name
      : requireString(body, 'couple_display_name'),
    event_date: body.event_date === undefined ? existing.event_date : requireString(body, 'event_date'),
    status: body.status === undefined ? existing.status : (requireString(body, 'status') as Wedding['status']),
    created_at: existing.created_at,
    wedding_id: weddingId,
    tenant_id: context.tenant_id,
    ...(ceremony_time === undefined ? {} : { ceremony_time }),
    ...(venue_name === undefined ? {} : { venue_name }),
    ...(parking_info === undefined ? {} : { parking_info }),
    ...(dress_code === undefined ? {} : { dress_code }),
  }
  // update re-validates against the wedding contract, so the `status` cast above is closed at runtime
  // (a non-enum value -> CONTRACT.VALIDATION_FAILED -> 400). Keep validation downstream of the cast.
  const saved = deps.weddings.update(context, updated)
  return { status: 200, body: { wedding: saved } }
}

// ---------------------------------------------------------------------------------------------------
// Guest-management dispatch (Phase 21 + Phase 24) — CRUD over the guest registry. The opaque recipient_ref is
// carried in the BODY (never the URL), so the route is a single 3-segment `/t/:slug/guests` with the verb
// selecting the op. Authorization is now PER-METHOD: `list`/`remove` are RESOURCE-SCOPED (planner: whole
// tenant; couple: their bound wedding's guests, via `manageScope`), and `register` is a CAPABILITY a couple
// lacks (`authorizeRegister` -> 403) — checked as the FIRST statement of the register handler, before any body
// parse, so a couple POST (even a duplicate ref) is 403 and never reaches the 409 cross-wedding oracle.
// ---------------------------------------------------------------------------------------------------

function dispatchGuests(
  context: TenantContext,
  principal: Principal,
  req: ApiRequest,
  deps: GuestHandlerDeps,
): ApiResponse {
  if (req.method === 'GET') return handleGuestList(context, principal, deps)
  if (req.method === 'POST') return handleGuestRegister(context, principal, req, deps)
  if (req.method === 'DELETE') return handleGuestRemove(context, principal, req, deps)
  throw methodNotAllowed()
}

// ---------------------------------------------------------------------------------------------------
// Escalation-inbox dispatch (Phase 26 read + Phase 27 resolve + Phase 28/34 reply). GET returns the principal's
// scoped escalations, resolutions AND reply threads (the consumer joins by escalation_id); POST is BOTH the
// resolve and the reply mutation, discriminated by BODY SHAPE (house style — the verb is in the body, not the
// URL; like guests' recipient_ref-in-the-body): a `reply_text` present -> reply (append-to-thread + send; Phase
// 34 DECOUPLED it from resolve, so it no longer auto-resolves), else -> resolve (status-based). NOTE: the WIRE
// field stays `reply_text` (the discriminator); the SCHEMA field is `escalation_reply.body` — do NOT
// "consistency-rename" the wire field or this presence discriminator silently breaks. The discrimination is on
// PRESENCE only and runs BEFORE either handler's field validation, so a malformed reply and a malformed resolve
// both yield the SAME masked 400 independent of escalation existence (no oracle). Any other method is a 405
// (route exists tenant-independently, not a tenant oracle). Auth has already run in the pipeline (stages 3–4),
// so route shape is not a pre-auth oracle.
// ---------------------------------------------------------------------------------------------------

function dispatchEscalations(
  context: TenantContext,
  principal: Principal,
  req: ApiRequest,
  deps: EscalationHandlerDeps,
): ApiResponse {
  if (req.method === 'GET') return handleEscalationList(context, principal, deps)
  if (req.method === 'POST') {
    const body = parseObjectBody(req.rawBody)
    return body.reply_text !== undefined
      ? handleEscalationReply(context, principal, body, deps)
      : handleEscalationResolve(context, principal, body, deps)
  }
  throw methodNotAllowed()
}

function handleEscalationList(
  context: TenantContext,
  principal: Principal,
  deps: EscalationHandlerDeps,
): ApiResponse {
  // Scope from the MINTED principal (never the body), reusing manageScope: planner -> the whole tenant
  // partition; couple -> only their bound wedding (the logs filter; an unbound couple yields []). BOTH arrays
  // are scoped by the SAME branch, so a couple's `resolutions` never carries a sibling wedding's record (F4).
  const scope = deps.authorizer.manageScope(principal)
  const escalations =
    scope.kind === 'all'
      ? deps.escalations.list(context)
      : deps.escalations.listForWedding(context, scope.wedding_id)
  const resolutions =
    scope.kind === 'all'
      ? deps.resolutions.list(context)
      : deps.resolutions.listForWedding(context, scope.wedding_id)
  // Phase 34: the reply THREAD as the third array, scoped by the SAME manageScope branch (so a couple's
  // replies never carry a sibling wedding's thread); the consumer joins by escalation_id (and sorts by seq).
  const replies =
    scope.kind === 'all'
      ? deps.replies.list(context)
      : deps.replies.listForWedding(context, scope.wedding_id)
  return { status: 200, body: { escalations, resolutions, replies } }
}

/**
 * POST /t/:slug/escalations — mark an escalation handled (Phase 27). Statement order is PINNED so the
 * byte-identical miss is STRUCTURAL (doddy F1):
 *   1. scope from the MINTED principal (manageScope);
 *   2. parse the body; read `escalation_id` (required);
 *   3. validate `status` to the enum FIRST — INDEPENDENT of existence (a bad/absent status is a masked 400
 *      whether the escalation exists or not, so the 400 is no existence oracle);
 *   4. look the escalation up by id within the tenant (getByEscalationId is tenant-scoped — never cross-tenant);
 *   5. ABSENT -> the shared frozen RESP_RESOLVE_MISS; a COUPLE whose bound wedding != the escalation's wedding
 *      -> the SAME RESP_RESOLVE_MISS (an unbound couple has wedding_id===undefined, and the escalation's
 *      wedding_id is always a non-empty string, so the inequality always holds → always masked). So a couple
 *      cannot distinguish "no such escalation" from "an escalation in another wedding" — not a cross-wedding
 *      existence oracle. The early return precedes ANY write (F2 — a foreign-wedding probe records NOTHING).
 *   6. else record the resolution. wedding_id is COPIED from the live escalation read in THIS request (F5 —
 *      never the body, never scope.wedding_id), resolved_by is the principal's role, resolved_at is clock-
 *      stamped inside the log; idempotent by escalation_id (first-writer-wins). -> { resolved: true }.
 */
function handleEscalationResolve(
  context: TenantContext,
  principal: Principal,
  body: Record<string, unknown>,
  deps: EscalationHandlerDeps,
): ApiResponse {
  const scope = deps.authorizer.manageScope(principal)
  const escalation_id = requireString(body, 'escalation_id')
  const status = body.status
  // Inline enum check (F7) — same PRODUCT.BAD_REQUEST -> masked 400 a planner's malformed body yields; NOT a
  // distinct code, and fires for a present AND an absent escalation_id alike (independent of existence).
  // Phase 36: `reopened` joins the enum (the operator reopen action — same route, discriminated by status).
  if (status !== 'resolved' && status !== 'dismissed' && status !== 'reopened') {
    throw new ProductError('PRODUCT.BAD_REQUEST', "Field 'status' must be 'resolved', 'dismissed' or 'reopened'.", {})
  }
  const escalation = deps.escalations.getByEscalationId(context, escalation_id)
  if (escalation === undefined) return RESP_RESOLVE_MISS
  // A couple may transition ONLY their bound wedding's escalations; a planner ({kind:'all'}) may transition any.
  // Byte-identical to the absent miss, BEFORE any write (no oracle, no record for a foreign-wedding probe).
  if (scope.kind === 'wedding' && escalation.wedding_id !== scope.wedding_id) return RESP_RESOLVE_MISS
  // Phase 36: a status TRANSITION (resolve/dismiss from open, reopen from handled). The log's directional rule
  // makes an out-of-direction transition (e.g. resolve an already-handled escalation, reopen an open one) an
  // idempotent no-op. The response is the SAME `{resolved:true}` for all three statuses ("the transition took
  // effect / the desired state holds") — it matches the frozen `{resolved:false}` miss key, and the web form
  // ignores the body (PRG redirect). wedding_id is COPIED from the live escalation (F5 — never the body).
  deps.resolutions.transition(context, {
    escalation_id,
    wedding_id: escalation.wedding_id,
    status,
    by: principal.role,
  })
  return { status: 200, body: { resolved: true } }
}

/**
 * POST /t/:slug/escalations with a `reply_text` — reply to an escalated guest from the inbox (Phase 28),
 * MULTI-TURN as of Phase 34: a console-initiated METERED send back to the guest that APPENDS to the
 * escalation's reply THREAD and does NOT resolve it (resolving/dismissing stays the explicit Phase-27 action),
 * so an operator can send as many follow-ups as they need while the escalation stays OPEN. Statement order is
 * PINNED so the byte-identical miss is STRUCTURAL and NOTHING is sent/billed/recorded on a probe:
 *   1. scope from the MINTED principal (manageScope);
 *   2. read `escalation_id` + `reply_text` (required, non-empty, length ≤ REPLY_BODY_MAX_LENGTH) + `seq`
 *      (required → non-negative integer) — these 400s fire BEFORE the lookup, INDEPENDENT of existence (no
 *      oracle; a malformed seq on an absent escalation 400s byte-identically to one on a present escalation).
 *      ONLY these three fields are read from the body; channel/recipient/wedding_id all come from the live
 *      escalation (a smuggled body field is inert);
 *   3. look the escalation up by id within the tenant (getByEscalationId — tenant-scoped, never cross-tenant);
 *   4. ABSENT -> RESP_REPLY_MISS; a COUPLE whose bound wedding != the escalation's -> the SAME RESP_REPLY_MISS
 *      (BEFORE any send — a foreign-wedding probe dispatches/charges/records NOTHING);
 *   5. ALREADY HANDLED (a resolution exists — resolved OR dismissed) -> RESP_REPLY_MISS, no send. This is the
 *      dismissed-no-bill keystone (doddy F1/F2): a closed escalation never dispatches a billed guest message.
 *      It STAYS even though the reply no longer writes a resolution — it no longer doubles as the double-submit
 *      guard (that moved to the seq slot, step 6), but it is NOT dead. Reached only after the scope gate;
 *   6. DOUBLE-SUBMIT GUARD — read the thread slot `(escalation_id, seq)` BEFORE sending: an occupied slot whose
 *      stored `body` EQUALS the submitted text is a true double-submit (re-POST of the same rendered form) ->
 *      idempotent { replied: true }, NO second send; an occupied slot whose stored body DIFFERS is a
 *      lost-update (stale form / a co-operator raced the slot) -> RESP_REPLY_CONFLICT (409), retry from a fresh
 *      seq, never a silent drop. A free slot proceeds;
 *   7. send the reply over the LIVE escalation's channel to its from_ref, billed from OUR record (the Phase-18
 *      firewall), with the DETERMINISTIC per-(escalation, seq) key `reply:${id}:${seq}` (defense-in-depth: the
 *      per-tenant meter dedups a replay too — the slot read in step 6 is the PRIMARY guard). A structured send
 *      failure (margin/cost) -> RESP_REPLY_MISS: the escalation stays Open + retryable (nothing appended), not
 *      swallowed for an oracle (the caller is authed) but kept actionable; a genuine bug still surfaces as 500;
 *   8. COMMIT-AFTER-SUCCESS: only after the send succeeds, append the reply to the thread (wedding_id +
 *      escalation_id COPIED from the live escalation, sender = the principal's role; the log is itself
 *      read-first-put-if-absent on the slot). NO resolution write. -> { replied: true }.
 */
function handleEscalationReply(
  context: TenantContext,
  principal: Principal,
  body: Record<string, unknown>,
  deps: EscalationHandlerDeps,
): ApiResponse {
  const scope = deps.authorizer.manageScope(principal)
  const escalation_id = requireString(body, 'escalation_id')
  const reply_text = requireString(body, 'reply_text')
  if (reply_text.length > REPLY_BODY_MAX_LENGTH) {
    throw new ProductError('PRODUCT.BAD_REQUEST', `Field 'reply_text' exceeds the ${REPLY_BODY_MAX_LENGTH}-character limit.`, {})
  }
  // `seq` is the thread position the form carries (= current thread length). REQUIRED → a non-negative integer;
  // a missing / non-integer / negative / NaN seq is the SAME masked 400, fired BEFORE the lookup (no oracle).
  // Never default a missing seq to 0 (a defaulted seq is a dedup-collision vector). The form sends it as a
  // string ("3"); a JSON client may send a number — accept both, reject everything else.
  const seq = parseSeq(body.seq)
  const escalation = deps.escalations.getByEscalationId(context, escalation_id)
  if (escalation === undefined) return RESP_REPLY_MISS
  // A couple may reply ONLY to their bound wedding's escalations; a planner ({kind:'all'}) may reply to any.
  if (scope.kind === 'wedding' && escalation.wedding_id !== scope.wedding_id) return RESP_REPLY_MISS
  // Dismissed-no-bill keystone (doddy F1/F2), now CONDITIONAL on EFFECTIVE status (Phase 36): a CURRENTLY-handled
  // escalation (effective resolved/dismissed) accepts no further billed reply; a `reopened` escalation is
  // effective-`open` and again accepts replies (the explicit operator reopen lifts the no-bill gate).
  if (deps.resolutions.effectiveStatus(context, escalation_id) !== 'open') return RESP_REPLY_MISS
  // Double-submit guard: the slot read is the PRIMARY guard (the meter key is defense-in-depth). Same body at a
  // taken slot = true double-submit (idempotent, no send); different body at a taken slot = lost-update (409).
  const existing = deps.replies.readSlot(context, escalation_id, seq)
  if (existing !== undefined) {
    return existing.body === reply_text ? { status: 200, body: { replied: true } } : RESP_REPLY_CONFLICT
  }
  try {
    deps.service.send(context.tenant_id, {
      channel: escalation.channel, // from the LIVE escalation, never the body
      recipient_ref: escalation.from_ref, // ditto — a smuggled recipient can't redirect the send
      body: reply_text,
      idempotency_key: `reply:${escalation_id}:${seq}`, // deterministic per (escalation, seq): a re-submit meters once
    })
  } catch (error) {
    // A structured send failure leaves the escalation OPEN + retryable (nothing appended); byte-identical to the
    // miss. A genuine (non-structured) bug still surfaces as a 500 at the edge.
    if (error instanceof WeddingPlannerError) return RESP_REPLY_MISS
    throw error
  }
  // Commit-after-success: the reply is recorded only because it went out. Append to the thread (the transcript);
  // reply_text is already non-empty + length-capped above, so it can never fail the reply's assertValid.
  deps.replies.append(context, {
    escalation_id,
    wedding_id: escalation.wedding_id, // copied from the live escalation, never the body
    seq,
    sender: principal.role,
    body: reply_text,
  })
  return { status: 200, body: { replied: true } }
}

/**
 * Parse a request-body `seq` (the thread position / double-submit key) into a non-negative integer, or throw a
 * masked PRODUCT.BAD_REQUEST. Accepts a number (JSON client) or a numeric string (HTML form, e.g. "3"); rejects
 * undefined/absent, empty, non-numeric, fractional, negative, and NaN/Infinity uniformly — the SAME masked 400,
 * fired before the escalation lookup so it is never an existence oracle. NEVER defaults absent → 0.
 */
function parseSeq(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN
  if (!Number.isInteger(value) || value < 0) {
    throw new ProductError('PRODUCT.BAD_REQUEST', "Field 'seq' must be a non-negative integer.", {})
  }
  return value
}

/**
 * /t/:slug/billing — the planner's OWN billing account: GET reads the usage summary (Phase 30); POST settles the
 * owed balance (Phase 31 — a simulated payment). Statement order is PINNED:
 *   1. authorize FIRST — `authorizeBillingView` is the planner-only billing-ACCOUNT capability (gates BOTH the read
 *      and the settle); a couple is `forbidden` -> 403 for ANY method. The capability check precedes the method
 *      branch, so a couple can distinguish neither resource nor method (billing is the whole tenant account, not a
 *      probed resource, so the 403 is no existence oracle), AND the read/pay verbs cannot diverge into a
 *      couple-visible distinguisher — the no-method-oracle is STRUCTURAL, not test-hoped (one shared gate);
 *   2. GET -> the summary (the trusted `plan_tier` priced by `monthlyPriceCents` joined onto the tenant's own
 *      ledger fold) PLUS the itemized `activity` list (Phase 32 — the financial line items behind the same totals,
 *      newest-first), BOTH keyed by `context.tenant_id` — the minted partition key, NEVER a body/URL field, so a
 *      smuggled `tenant_id` is inert. The context was just minted from an active tenant this same request, so
 *      `findById` always resolves; the `undefined` arm is defensive-only (masked 404, never a crash/oracle);
 *   3. POST -> settle the owed balance. The handler reads NOTHING from the body (no amount/field), so a
 *      body-smuggled `amount_cents` is inert: the settled sum is sourced from the tenant's own trusted fold inside
 *      `settleBalance` (see billing_ledger.ts), never from client input -> { paid }. Else (PUT/DELETE) -> 405.
 */
function dispatchBilling(
  context: TenantContext,
  principal: Principal,
  req: ApiRequest,
  deps: BillingHandlerDeps,
): ApiResponse {
  if (deps.authorizer.authorizeBillingView(principal) === 'forbidden') throw forbidden()
  if (req.method === 'GET') {
    const tenant = deps.tenants.findById(context.tenant_id)
    if (tenant === undefined) return RESP_NOT_FOUND // defensive: unreachable for a freshly-minted context
    const billing = buildBillingSummary(tenant.plan_tier, deps.ledger.summarize(context.tenant_id))
    // The itemized financial line items behind the summary totals (Phase 32), keyed by the SAME minted
    // partition (`context.tenant_id`, never a body field) the summary uses — own tenant only, financial-only.
    const activity = buildBillingActivity(deps.ledger.eventsFor(context.tenant_id))
    return { status: 200, body: { billing, activity } }
  }
  if (req.method === 'POST') {
    // Settle the owed balance. The amount is sourced from the caller's OWN trusted fold inside `settleBalance`
    // keyed by `context.tenant_id` — the body is never read here, so there is nothing to smuggle. Repeat POST is a
    // no-op (the balance floor), so a double-submit never double-pays. -> { paid: true } once owed, else { paid: false }.
    const { paid } = deps.ledger.settleBalance(context.tenant_id)
    return { status: 200, body: { paid } }
  }
  throw methodNotAllowed()
}

function handleGuestList(context: TenantContext, principal: Principal, deps: GuestHandlerDeps): ApiResponse {
  // Scope from the MINTED principal (never the body). Planner: the whole tenant partition; couple: only their
  // bound wedding's guests (the registry filters; an unbound couple yields []).
  const scope = deps.authorizer.manageScope(principal)
  const guests =
    scope.kind === 'all'
      ? deps.registry.list(context)
      : deps.registry.listForWedding(context, scope.wedding_id)
  return { status: 200, body: { guests } }
}

function handleGuestRegister(
  context: TenantContext,
  principal: Principal,
  req: ApiRequest,
  deps: GuestHandlerDeps,
): ApiResponse {
  // Capability check FIRST (before the body parse + the referential-integrity 404 + the duplicate 409): a
  // couple is 403 regardless of body shape or whether the ref already exists — so the tenant-global
  // recipient_ref 409 (a cross-wedding existence oracle) is never reachable by a couple.
  if (deps.authorizer.authorizeRegister(principal) === 'forbidden') throw forbidden()
  const body = parseObjectBody(req.rawBody)
  const recipient_ref = requireString(body, 'recipient_ref')
  const wedding_id = requireString(body, 'wedding_id')
  const guest_id = requireString(body, 'guest_id')
  // Referential integrity: the wedding must exist in THIS tenant. A planner owns the whole workspace, so
  // disclosing in-tenant wedding existence is NOT an oracle (contrast login, which must not verify the
  // couple's wedding_id). A foreign/absent id reads back the masked 404 of the scoped repo.
  if (deps.weddings.get(context, wedding_id) === undefined) return RESP_NOT_FOUND
  // register stamps tenant_id from the context, rejects a duplicate ref (409), and schema-validates.
  const guest = deps.registry.register(context, { recipient_ref, wedding_id, guest_id })
  return { status: 201, body: { guest } }
}

function handleGuestRemove(
  context: TenantContext,
  principal: Principal,
  req: ApiRequest,
  deps: GuestHandlerDeps,
): ApiResponse {
  // Body carries ONLY the delete key (recipient_ref); the wedding scope comes from the MINTED principal, so a
  // body-smuggled wedding_id can't widen a couple's reach. Body-parse-before-scope is fine here (unlike
  // register): there is no capability denial for remove (both roles may remove, just scoped) and a malformed
  // couple body yields the same 400 a planner's would — no distinguisher.
  const scope = deps.authorizer.manageScope(principal)
  const body = parseObjectBody(req.rawBody)
  const recipient_ref = requireString(body, 'recipient_ref')
  // Idempotent: an absent/foreign/sibling-wedding ref returns removed:false (no throw, no oracle). The couple
  // path deletes ONLY on a wedding_id match; every miss is byte-identical {removed:false}.
  const removed =
    scope.kind === 'all'
      ? deps.registry.remove(context, recipient_ref)
      : deps.registry.removeForWedding(context, recipient_ref, scope.wedding_id)
  return { status: 200, body: { removed } }
}

// ---------------------------------------------------------------------------------------------------
// Admin dispatch — operator-gated (auth already passed in the pipeline). Tenant-less: these never mint or
// touch a TenantContext; they drive the OnboardingService. The operator is platform-wide (no per-operator
// scoping), so the gate IS the authorization and the handlers need only the narrow { onboarding } bag.
// ---------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------
// Messaging dispatch — the provider-webhook inbound surface (Phase 19). Webhook auth already passed in the
// pipeline; these never touch the credential store. A guest is an UNTRUSTED actor (not a Principal): the
// only trusted identity is the resolved TenantContext + the registry binding. EVERY post-validation branch
// returns the SAME frozen RESP_ACCEPTED (the uniform-202 invariant — response never discloses registry state).
// ---------------------------------------------------------------------------------------------------

function dispatchMessaging(
  context: TenantContext,
  req: ApiRequest,
  segments: readonly string[],
  deps: MessagingHandlerDeps,
): ApiResponse {
  if (segments.length === 4 && segments[3] === 'inbound') {
    if (req.method !== 'POST') throw methodNotAllowed()
    return handleInbound(context, req, deps)
  }
  throw routeNotFound()
}

/**
 * POST /t/:slug/messaging/inbound — a guest texted in. Validate the wire shape (honest 400 to the trusted
 * provider, post-auth so not a pre-auth oracle), normalize via the provider port, then run the reply path:
 *   1. PER-TENANT idempotent receive (doddy P0): a ref already SUCCESSFULLY REPLIED TO is a no-op — early-return
 *      the uniform 202, no second reply, no second charge.
 *   2. Resolve the guest binding (segmentation): an unregistered/foreign ref -> uniform 202, no reply (no oracle).
 *   3. Load the bound wedding through the SCOPED repo (context + wedding_id — two gates): absent -> uniform 202.
 *   4. Decide from ONLY the guest-visible projection; on `answered`, send the reply through the METER with a
 *      PLATFORM-MINTED idempotency_key (never the untrusted provider ref), then mark the ref replied AFTER the
 *      send succeeds (doddy P1: commit-after-success — a send failure stays retryable and the ack stays 202).
 *      On `escalated` (a question we could not answer), record it in the `escalations` inbox so the couple/
 *      planner can read it (Phase 26) — idempotent by provider_message_ref, so a re-delivery records exactly
 *      one. Phase 35: an `escalated` follow-up from a guest who already has an OPEN escalation in their bound
 *      wedding THREADS into it (a `sender:'guest'` turn) instead of opening a new escalation — gated by the
 *      §B0 process-once reads so a re-delivery is never duplicated; routing is invisible to the guest (still
 *      202) and carries no send/charge. `refused` records NOTHING (the fact-independent surprise outcome;
 *      recording it would persist surprise-probe content — see escalation_log.ts). EVERY branch still returns
 *      the SAME uniform 202.
 * Identity is sourced from trusted state ONLY — the registry's stored recipient_ref + the bound wedding_id,
 * never a body field — so a body-smuggled guest_id/wedding_id is inert.
 */
function handleInbound(context: TenantContext, req: ApiRequest, deps: MessagingHandlerDeps): ApiResponse {
  const body = parseObjectBody(req.rawBody)
  // Validate the wire shape (channel enum / required opaque refs). Throws CONTRACT.VALIDATION_FAILED -> 400.
  const payload = getSchemaRegistry().assertValid<InboundWebhook>('inbound_webhook', body)
  // Normalize the UNTRUSTED provider payload into a domain message (opaque fields copied; received_at stamped).
  const message = deps.port.inbound(payload)

  // (1) Idempotent receive: a ref we have already replied to (and charged) is a no-op. Checked BEFORE any
  //     registry/wedding read so a re-delivery of an answered message touches nothing.
  if (deps.receipts.seen(context, message.provider_message_ref)) return RESP_ACCEPTED

  // (2) Segmentation: the registry binds the sender ref to ONE wedding. Unknown ref -> no reply (no oracle).
  const binding = deps.registry.lookup(context, message.sender_ref)
  if (binding === undefined) return RESP_ACCEPTED

  // (3) The bound wedding's facts, read through the tenant-scoped repo (context + the registry's wedding_id).
  const wedding = deps.weddings.get(context, binding.wedding_id)
  if (wedding === undefined) return RESP_ACCEPTED

  // (4) Decide from the guest-visible projection ONLY; reply (metered) only when we can answer.
  const outcome = deps.responder.respond(projectGuestVisibleFacts(wedding), message.body)
  if (outcome.action === 'answered' && outcome.reply_text !== undefined) {
    const replyId = deps.receipts.mintReplyId()
    try {
      deps.service.send(context.tenant_id, {
        channel: message.channel,
        recipient_ref: binding.recipient_ref,
        body: outcome.reply_text,
        idempotency_key: replyId,
      })
    } catch (error) {
      // A send failure is a DROPPED reply, never a 500 oracle and never a suppressed message: the ref is NOT
      // marked replied (so a re-delivery can retry), and the synchronous ack stays the uniform 202. Only the
      // send's own structured failures are swallowed here; an unexpected error still surfaces as a 500 bug.
      if (error instanceof WeddingPlannerError) return RESP_ACCEPTED
      throw error
    }
    // Commit-after-success: only now is the ref a no-op for future re-deliveries.
    deps.receipts.markReplied(context, message.provider_message_ref, replyId)
  } else if (outcome.action === 'escalated') {
    // Phase 35 — guest-reply → thread correlation. An `escalated` follow-up from a guest who already has an
    // OPEN escalation in their CURRENTLY-BOUND wedding lands in THAT escalation's thread (a `sender:'guest'`
    // turn) instead of opening a new one; only a genuinely new conversation opens a fresh escalation. The
    // target is inferred ENTIRELY from trusted state (the live binding's wedding_id + the registry-vetoed
    // sender_ref), never the inbound body. Like the record path, this is a server-side write invisible to the
    // guest (every branch returns the uniform 202) and carries NO send / NO charge — a guest turn is a
    // RECEIVED message we file into the conversation.
    //
    // PROCESS-ONCE gate (§B0): the split routing makes a per-thread ref-scan insufficient, because the
    // selector's output can change between provider re-deliveries (a freshly-recorded escalation is OPEN, so a
    // re-delivery of the SAME message would otherwise thread into it; a since-resolved escalation would drop a
    // re-delivered follow-up to a fresh escalation). So gate on TWO "already processed?" reads BEFORE routing:
    const ref = message.provider_message_ref
    if (
      deps.escalations.getByProviderRef(context, ref) === undefined && // (1) ref didn't already CREATE an escalation
      deps.replies.guestTurnByProviderRef(context, ref) === undefined // (2) ref didn't already land as a guest turn
    ) {
      const target = mostRecentOpenEscalationForGuest(context, deps, binding.wedding_id, message.sender_ref)
      if (target !== undefined) {
        // Thread the follow-up. escalation_id/wedding_id COPIED from the live escalation (never the body);
        // body/ref from the already-validated inbound message. recordGuestReply allocates the slot above the
        // thread's high-water mark and dedups by ref; the schema body has no maxLength so a long guest message
        // can never fail validation here (no 500 oracle), exactly as escalation.record cannot.
        deps.replies.recordGuestReply(context, {
          escalation_id: target.escalation_id,
          wedding_id: target.wedding_id,
          provider_message_ref: ref,
          body: message.body,
        })
      } else {
        // A new conversation: record the unanswerable question for the couple/planner inbox (Phase 26).
        // Idempotent by provider_message_ref; sourced from TRUSTED state + the validated message ONLY, never
        // the raw body. NOT swallowed to 202: record() cannot be provoked to throw by guest input that passed
        // the inbound edge (its `text` constraint matches inbound_webhook.text), so a throw is a genuine bug.
        deps.escalations.record(context, {
          wedding_id: binding.wedding_id,
          from_ref: message.sender_ref,
          text: message.body,
          received_at: message.received_at,
          provider_message_ref: ref,
          channel: message.channel, // Phase 28: the reply-routing snapshot — a console reply sends back over this.
        })
      }
    }
  }
  return RESP_ACCEPTED
}

/**
 * Phase 35 — the guest-reply correlation selector. Returns the guest's MOST-RECENT OPEN escalation in their
 * CURRENTLY-BOUND wedding, or `undefined` if none. The DUAL match (from_ref AND wedding_id) is the
 * cross-wedding mis-segmentation defense (doddy): a `recipient_ref` re-bound from wedding A to B carries stale
 * A-escalations, but filtering candidates by `binding.wedding_id` (the CURRENT trusted binding) excludes them,
 * so a re-bound guest's message can only ever reach an open escalation in their current wedding. Both axes are
 * TRUSTED state (the live binding + the recorded escalation), never the inbound body. OPEN = no resolution
 * (the same join the inbox uses). The `received_at` max-by pick breaks ties on `escalation_id` FOR
 * DETERMINISM ONLY (not a recency guarantee — both are that guest's open conversation, so the choice is
 * immaterial). All reads are tenant-scoped by the minted context.
 */
function mostRecentOpenEscalationForGuest(
  context: TenantContext,
  deps: MessagingHandlerDeps,
  wedding_id: string,
  from_ref: string,
): GuestEscalation | undefined {
  const open = deps.escalations
    .listForWedding(context, wedding_id)
    .filter((escalation) => escalation.from_ref === from_ref)
    .filter((escalation) => deps.resolutions.effectiveStatus(context, escalation.escalation_id) === 'open')
  let best: GuestEscalation | undefined
  for (const escalation of open) {
    if (
      best === undefined ||
      escalation.received_at > best.received_at ||
      (escalation.received_at === best.received_at && escalation.escalation_id > best.escalation_id)
    ) {
      best = escalation
    }
  }
  return best
}

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
