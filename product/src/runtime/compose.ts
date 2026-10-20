import type { Clock, IdGenerator, StrategyGenome, Tenant } from '@wedding-planner/shared'

import { GuestAuthorizer } from '../auth/guest_authorizer'
import { OperatorCredentialStore } from '../auth/operator_credential'
import { ProviderWebhookCredentialStore } from '../auth/provider_webhook_credential'
import { SessionStore } from '../auth/session_store'
import { WeddingAuthorizer } from '../auth/wedding_authorizer'
import { AccountService } from '../accounts/account_service'
import { AccountStore } from '../accounts/account_store'
import { InvitationStore } from '../accounts/invitation_store'
import { MembershipService } from '../accounts/membership_service'
import { OneTimeTokenStore } from '../accounts/one_time_token_store'
import { PendingResetQueue } from '../accounts/pending_reset_queue'
import { PasswordHasher, PRODUCTION_SCRYPT_COST, type ScryptCost } from '../accounts/password_hasher'
import { RateLimiter } from '../accounts/rate_limiter'
import { ChecklistService } from '../checklist/checklist_service'
import { VendorService } from '../vendors/vendor_service'
import { BudgetService } from '../budget/budget_service'
import { RunOfShowService } from '../run_of_show/run_of_show_service'
import { DOCUMENT_LIMITS, DocumentService } from '../documents/document_service'
import { SeatingService } from '../seating/seating_service'
import { SITE_LIMITS, SiteService } from '../site/site_service'
import { BillingLedger } from '../billing/billing_ledger'
import { WeddingEventService } from '../wedding_events/wedding_event_service'
import { FeedbackService } from '../feedback/feedback_service'
import { GuestDirectory } from '../guests/guest_directory'
import { fanOutGuestListHooks, GUEST_LIST_LIMITS, GuestListService } from '../guests/guest_list_service'
import { ErrorLog } from '../operability/error_log'
import { SimulatedEmailAdapter } from '../email/simulated_email_adapter'
import { ProductApi } from '../http/product_api'
import { RsvpLinkService } from '../rsvp/rsvp_link_service'
import { EscalationLog } from '../messaging/escalation_log'
import { EscalationReplyLog } from '../messaging/escalation_reply_log'
import { EscalationResolutionLog } from '../messaging/escalation_resolution_log'
import { DeterministicGuestQaResponder } from '../messaging/guest_qa_responder'
import { GuestRegistry } from '../messaging/guest_registry'
import { InboundReceiptLog } from '../messaging/inbound_receipt_log'
import { MessagingService } from '../messaging/messaging_service'
import { SimulatedMessagingAdapter } from '../messaging/simulated_messaging_adapter'
import { OnboardingService } from '../onboarding/onboarding_service'
import { InMemoryRecordStore } from '../persistence/in_memory_record_store'
import { COLLECTIONS } from '../persistence/collections'
import { GLOBAL_PARTITION, type RecordStore } from '../persistence/record_store'
import { TenantContextResolver } from '../tenant/tenant_context'
import { TenantStore } from '../tenant/tenant_store'
import { ProductWebUi } from '../web/product_web_ui'
import { ThemeResolver } from '../web/theme_resolver'
import { WeddingRepository } from '../wedding/wedding_repository'
import { ModelService } from '../model/model_service'
import { type DeadlineTimer, JobQueue } from '../jobs/job_queue'
import { CopilotService } from '../copilot/copilot_service'
import { ProductError } from '../product_error'
import { SimulatedModelAdapter, type SimulatedTask } from '../model/simulated_model_adapter'
import { SIMULATED_MODEL_TASKS } from '../model/simulated_tasks'

/**
 * @canonical compose_product_surface -- the composition root: wires every product-surface dependency into
 * one running web front door, with no ambient reads of its own.
 *
 * This is the seam between the deployable entrypoint (`app/server.ts`, the impure shell that reads env, the
 * wall clock, and the socket) and the pure product surface. `compose` takes its `Clock`, `IdGenerator`, and
 * the operator credential token as CONFIG — it constructs none of them, reads no env, generates no token, and
 * logs nothing. So the entrypoint injects the live edge primitives (SystemClock / RandomIdGenerator / a
 * crypto-random operator token) while tests inject the deterministic doubles (ManualClock /
 * SequentialIdGenerator / a fixed token), and both exercise the SAME wiring.
 *
 * The dependency graph it assembles is exactly the one the keystone tests build by hand: a single
 * `TenantStore` is the shared backbone (the resolver, theme resolver, onboarding driver, and wedding repo all
 * read its liveness/slug index), `ProductApi` is the 5-stage pipeline over it, and `ProductWebUi` is the
 * themed HTML front door whose ONLY data path is `api.handle()`. Nothing here widens a boundary: the three
 * token namespaces, the disclosure mask, and tenant isolation are all inherited unchanged from the pieces.
 *
 * Persistence (issue #8, ADR 0039): every store is built over ONE injected {@link RecordStore} — the entrypoint
 * opens the durable SQLite store when `WP_DATABASE_PATH` is set; tests and the plain demo get an in-memory store
 * — and `ProductApi` runs each request as one transaction of that store. A store constructed here without the
 * shared `store` would silently stay in memory; the compose restart test writes through every store and reads it
 * back from a recomposed surface over the same database, so that slip fails a test.
 *
 * The demo seed (when `seedDemo`) is the launch-ready touch: it provisions and activates one tenant THROUGH
 * the real `OnboardingService` lifecycle driver — provision → activate — so the demo tenant traverses the
 * legal-transition guard and records real billing events, making it indistinguishable at the edge from any
 * operator-provisioned tenant (an ACTIVE tenant disclosing existence is the designed behavior; absent /
 * suspended / onboarding stay the byte-identical 404). It then seeds one wedding via
 * `WeddingRepository.create` against a resolver-minted context obtained AFTER activation. It deliberately
 * mints NO session — the first planner logs in via the public `/t/:slug/login` edge once the image is up, so
 * no session token is baked into boot state. The seed runs ONLY into an empty store (no tenant yet): a restart
 * over existing data keeps that data and seeds nothing, and `demo` is then undefined.
 *
 * related: system_clock.ts / random_id_generator.ts (the edge primitives the entrypoint injects),
 * onboarding_service.ts (the lifecycle driver the demo seed uses), product_web_ui.ts (the returned front door).
 */

/** Config for {@link composeProductSurface}. The clock/ids/token are INJECTED — compose reads no ambient state. */
export interface ComposeProductSurfaceConfig {
  /** Time source. Inject `ManualClock` in tests; the entrypoint injects the edge `SystemClock`. */
  readonly clock: Clock
  /** Identity source. Inject `SequentialIdGenerator` in tests; the entrypoint injects `RandomIdGenerator`. */
  readonly ids: IdGenerator
  /** The single platform-operator credential token (already validated/generated by the caller). */
  readonly operatorToken: string
  /**
   * Phase 19: the provider-webhook secret authenticating the inbound messaging webhook (the FOURTH token
   * namespace). Injected like the operator token — compose generates none and reads no env. The entrypoint
   * supplies a validated/generated secret; tests inject a fixed one.
   */
  readonly providerWebhookToken: string
  /** Seed + activate a demo tenant so the image boots demoable. Default true. */
  readonly seedDemo?: boolean
  /** The demo tenant's slug (the public routing key). Default 'demo'. */
  readonly demoSlug?: string
  /**
   * Phase 17: the loop's champion strategy genome, surfaced read-only to planners (the engine↔surface seam).
   * Injected as a `@wedding-planner/shared` VALUE — compose imports no loop/eval code, so the acyclic-workspace
   * and determinism rails hold. Forwarded verbatim to `ProductApi`, which projects + validates it (an invalid
   * champion throws here, aborting boot). Absent ⇒ the `/t/:slug/strategy` route 404s.
   */
  readonly championStrategy?: StrategyGenome
  /**
   * Issue #8: the persistence store every product store is built over (and the per-request transaction
   * runner). The entrypoint injects the durable SQLite store; absent ⇒ a fresh in-memory store (tests, demo).
   */
  readonly store?: RecordStore
  /** Issue #13: the build commit `/healthz` reports. Absent ⇒ `unknown`. */
  readonly buildCommit?: string
  /** Issue #10: the scrypt cost for passwords. Default the production cost; tests inject a cheap one. */
  readonly passwordCost?: ScryptCost
  /**
   * Issue #10: the site's public base URL (e.g. `https://planner.example`, no trailing slash) for links in emails.
   * Absent ⇒ site-relative links. Never derived from a request's Host header (a requester controls that).
   */
  readonly publicUrl?: string
  /**
   * Issue #59: tasks a test ADDS to the simulated model's own ({@link SIMULATED_MODEL_TASKS}); a name the product already
   * uses is refused. There is deliberately no option for a real model: wiring one is an owner decision (ADR 0057).
   */
  readonly simulatedModelTasks?: Readonly<Record<string, SimulatedTask>>
  /**
   * Issue #61: the timer that bounds a model job's run. The entrypoint passes a real one; absent ⇒ no deadline (tests).
   * Injected so the composition keeps no ambient time.
   */
  readonly jobTimer?: DeadlineTimer
}

/** A handle to the demo tenant seeded by THIS composition — present only when the seed ran (empty store). */
export interface DemoSeed {
  readonly slug: string
  readonly tenantId: string
  readonly weddingId: string
  /** Phase 19: the demo guest's opaque sender ref, registered to the demo wedding (drives the inbound demo). */
  readonly guestRecipientRef: string
}

/** The wired product surface. `ui` is the deployable front door; the rest are exposed for tests/inspection. */
export interface ComposedSurface {
  readonly ui: ProductWebUi
  readonly api: ProductApi
  readonly themes: ThemeResolver
  /** Echoed back so the entrypoint can log provenance (NEVER an env-provided token — caller's concern). */
  readonly operatorToken: string
  /** The demo tenant handle, or undefined when the seed did not run (`seedDemo` false, or the store had data). */
  readonly demo?: DemoSeed
  /**
   * Phase 18: the metered, margin-priced guest-messaging service, wired over the offline simulated provider
   * adapter (which takes the SAME injected clock/ids, so the determinism rail holds). Exposed for
   * tests/inspection — it has no HTTP route yet (the guest-channel request edge is the next rung), so this is
   * how a compose-level test exercises `send` through the wired graph.
   */
  readonly messaging: MessagingService
  /**
   * Phase 26: the escalation inbox — the log of guest questions the platform could not answer. Exposed for
   * tests/inspection (read over HTTP via `GET /t/:slug/escalations`); a compose-level e2e uses it to verify
   * the guest->couple loop (an escalated question lands here, then a filled fact makes the next ask answerable).
   */
  readonly escalations: EscalationLog
  /**
   * Phase 27: the append-only escalation-resolution log (resolved/dismissed). Exposed for tests/inspection
   * (read/written over HTTP via `GET`/`POST /t/:slug/escalations`); a compose-level e2e uses it to verify the
   * couple can mark an escalated question handled (it moves out of the Open inbox) idempotently.
   */
  readonly resolutions: EscalationResolutionLog
  /** Issue #9: the simulated email adapter (port + operator outbox). Exposed for tests/inspection. */
  readonly email: SimulatedEmailAdapter
  /** Issue #10: precompute what the first request would otherwise pay for (the dummy password hash). */
  readonly warmUp: () => void
  /** Issue #59: model calls (the simulated adapter only), validated and metered per workspace. */
  readonly model: ModelService
  /** Issue #61: run the model jobs that are due (also started after each request); resolves with how many ran. */
  readonly drainJobs: () => Promise<number>
}

/** The demo theme — an obvious offline placeholder (no real brand). Colors are lowercase 6-hex per contract. */
/** The platform setting naming the tenant the demo seed created (issue #10). */
const DEMO_TENANT_SETTING = 'demo_tenant'

/** The demo tenant's display name (also the fingerprint that adopts a pre-#10 seeded demo tenant). */
const DEMO_DISPLAY_NAME = 'Demo Weddings Co.'

const DEMO_THEME: Tenant['theme'] = {
  brand_name: 'Demo Weddings Co.',
  primary_color_hex: '#3b5bdb',
  accent_color_hex: '#f06595',
  logo_ref: 'demo_logo',
}

/** The simulated model's tasks: the product's own, plus a test's extra ones (never replacing a product task). */
function simulatedTasks(extra: Readonly<Record<string, SimulatedTask>> | undefined): Readonly<Record<string, SimulatedTask>> {
  const clash = Object.keys(extra ?? {}).find((name) => name in SIMULATED_MODEL_TASKS)
  if (clash !== undefined) throw new ProductError('MODEL.DUPLICATE_TASK', `A test task may not replace the product's task '${clash}'.`, { context: { task: clash } })
  return { ...SIMULATED_MODEL_TASKS, ...extra }
}

/** Build the fully-wired product surface from injected primitives. Performs no ambient reads. */
export function composeProductSurface(config: ComposeProductSurfaceConfig): ComposedSurface {
  const { clock, ids, operatorToken } = config
  const seedDemo = config.seedDemo ?? true
  const demoSlug = config.demoSlug ?? 'demo'
  const store = config.store ?? new InMemoryRecordStore()
  // Issue #10: the role picker is tied to the tenant the demo seed CREATED (recorded when it ran), never to whatever
  // tenant holds the demo slug.
  const demoTenantId = (): string | undefined => store.get(COLLECTIONS.platformSetting, GLOBAL_PARTITION, DEMO_TENANT_SETTING)?.value

  // The shared backbone: one tenant store the resolver, theme resolver, onboarding, and repo all read.
  const tenants = new TenantStore(clock, ids, store)
  // Issue #59: the model — the simulated adapter only (ADR 0057). Calls run outside request transactions.
  const model = new ModelService(tenants, new SimulatedModelAdapter(simulatedTasks(config.simulatedModelTasks)), clock, store)
  const resolver = new TenantContextResolver(tenants)
  // Sessions persist, so they expire (7 days) and lapsed ones are swept at boot (below). Issue #10: the simulated
  // role picker signs in (and its sessions resolve) ONLY on the demo tenant, and only in demo mode.
  const sessionStore = new SessionStore(ids, store, {
    clock,
    simulatedLogin: (tenant_id) => seedDemo && tenant_id === demoTenantId(),
  })
  // Operator console sessions (issue #9) persist in the shared store, like tenant sessions.
  const operators = new OperatorCredentialStore(ids, [operatorToken], { clock, store })
  const webhookCredentials = new ProviderWebhookCredentialStore(ids, [config.providerWebhookToken])
  const billing = new BillingLedger(clock, ids, store)
  const onboarding = new OnboardingService(tenants, billing)
  const weddings = new WeddingRepository(tenants, clock, ids, store)
  const authorizer = new WeddingAuthorizer()
  // The email boundary (issue #9): the offline simulated adapter records every message in the durable outbox the
  // operator reads at /admin/outbox. A real provider is a new adapter behind the same port (an owner crossing).
  const email = new SimulatedEmailAdapter(clock, ids, store)
  // Real accounts (issue #10): scrypt-hashed passwords, single-use emailed links, in-process rate limits. The
  // service verifies; the SessionStore stays the sole mint of a Principal.
  const accountStore = new AccountStore(tenants, clock, ids, store)
  const hasher = new PasswordHasher(config.passwordCost ?? PRODUCTION_SCRYPT_COST, ids)
  const oneTimeTokens = new OneTimeTokenStore(tenants, clock, ids, store)
  const publicUrl = config.publicUrl === undefined ? {} : { publicUrl: config.publicUrl }
  // The server-error log the operator reads at /admin/errors (issue #13).
  const errors = new ErrorLog(clock, ids, store)
  // One in-process limiter for sign-in, reset requests, invitations and feedback (keys are namespaced per use).
  const limiter = new RateLimiter(clock)
  const accounts = new AccountService({
    accounts: accountStore,
    hasher,
    tokens: oneTimeTokens,
    email,
    sessions: sessionStore,
    limiter,
    tenants,
    clock,
    pendingResets: new PendingResetQueue(clock, ids, store),
    contexts: resolver,
    ...publicUrl,
  })
  // The team (issue #11): planners invite teammates and couples through single-use emailed links; the owner
  // manages invitations and members. The same account store, hasher, token store and session store as sign-in.
  const membership = new MembershipService({
    accounts: accountStore,
    invitations: new InvitationStore(tenants, clock, ids, store),
    tokens: oneTimeTokens,
    email,
    sessions: sessionStore,
    hasher,
    weddings,
    tenants,
    limiter,
    ...publicUrl,
  })

  // The guest-messaging provider boundary (Phase 18): the offline simulated adapter is a deterministic
  // double (injected clock/ids — no real provider, no network), so it wires here like any dep without
  // breaching the determinism rail. The service meters accepted sends and bills usage_charge into the SAME
  // ledger. No HTTP route yet (the guest-channel edge is the next rung); exposed on the surface for tests.
  const messagingAdapter = new SimulatedMessagingAdapter(clock, ids)
  const messaging = new MessagingService(messagingAdapter, tenants, billing, ids, store)

  // The guest inbound channel (Phase 19): a guest texts in over the provider webhook and the deterministic
  // responder answers from the bound wedding, metered through the service. The registry + receipt log inherit
  // tenant isolation (they read the same TenantStore liveness); the responder is pure. No loop import.
  const guestRegistry = new GuestRegistry(tenants, store)
  const guestAuthorizer = new GuestAuthorizer()
  const inboundReceipts = new InboundReceiptLog(tenants, ids, store)
  const guestResponder = new DeterministicGuestQaResponder()
  // The escalation inbox (Phase 26): an `escalated` question is recorded here and read by the couple (their
  // wedding) / planner (whole tenant). ONE instance — the inbound capture writes it, the read surface reads it.
  const escalations = new EscalationLog(tenants, ids, store)
  // The escalation-resolution log (Phase 27): the append-only handled-record (resolved/dismissed) keyed by
  // escalation_id, scoped exactly like the escalations. ONE instance — the resolve mutation writes it, the read
  // surface returns it alongside the escalations. Stamps resolved_at from the same injected clock.
  const resolutions = new EscalationResolutionLog(tenants, ids, clock, store)
  // The reply THREAD (Phase 34, multi-turn): each console reply appends one operator message (keyed by
  // (escalation_id, seq)) and sends a metered guest reply WITHOUT resolving. ONE instance — the reply mutation
  // appends, the read surface returns it as the third scoped array. Stamps reply_id/sent_at from injected ids/clock.
  const replies = new EscalationReplyLog(tenants, ids, clock, store)

  // A wedding's guest list (issue #27) and its events + RSVPs (issue #29). The events read guests through the
  // directory; the guest list tells the events when guests are removed (its hook), in the same request.
  const guestDirectory = new GuestDirectory(tenants, store)
  const events = new WeddingEventService(tenants, weddings, authorizer, guestDirectory, clock, ids, store)
  // Households' RSVP links (issue #30): the public RSVP page's authority; a link goes with its household.
  const rsvpLinks = new RsvpLinkService(tenants, weddings, authorizer, guestDirectory, clock, ids, store, config.publicUrl)
  // A wedding's seating plan (issue #46): a removed guest loses their seat through the guest list's hook too.
  const seating = new SeatingService(tenants, weddings, authorizer, guestDirectory, events, clock, ids, store)
  const guestList = new GuestListService(tenants, weddings, authorizer, clock, ids, store, GUEST_LIST_LIMITS, fanOutGuestListHooks(events, rsvpLinks, seating))

  const vendors = new VendorService(tenants, weddings, authorizer, clock, ids, store)
  const checklist = new ChecklistService(tenants, weddings, authorizer, clock, ids, store)
  const runOfShow = new RunOfShowService(tenants, weddings, authorizer, vendors, events, clock, ids, store)
  // Issue #61: model calls made after the request that asked (the outbox), and the planner copilot, their first kind.
  const jobs = new JobQueue(tenants, resolver, clock, ids, store, config.jobTimer, errors)
  const copilot = new CopilotService(tenants, weddings, authorizer, events, vendors, checklist, runOfShow, model, jobs, clock, store)
  jobs.register(copilot.jobKind())

  const api = new ProductApi({
    resolver,
    sessionStore,
    weddings,
    authorizer,
    guests: { registry: guestRegistry, weddings, authorizer: guestAuthorizer },
    operators,
    onboarding,
    email: { port: email, outbox: email },
    accounts,
    membership,
    tenants,
    // Each wedding's guest list (issue #27) and its events + RSVPs (issue #29), behind the wedding's boundary.
    guestList,
    events,
    householdRsvp: { links: rsvpLinks, events, guestList, limiter },
    // Each wedding's checklist (issue #31): the planner's tasks, the couple's own to tick off.
    checklist,
    // Each wedding's vendors and payment schedules (issue #33), and its budget (issue #34): tracked, never paid.
    vendors,
    budget: new BudgetService(tenants, weddings, authorizer, vendors, clock, ids, store),
    // Each wedding's run of show (issue #45): the day-of timeline and vendor call times.
    runOfShow,
    // The planner copilot (issue #61): drafts through the model job queue, kept through the services above.
    copilot,
    jobs,
    seating,
    // Each wedding's public website (issue #47): edited by the planner and the couple, read by guests when published.
    site: { sites: new SiteService(tenants, weddings, authorizer, events, clock, ids, store, SITE_LIMITS, limiter) },
    // Each wedding's documents (issue #48): the bytes in the same store, so the stack's state backup covers them.
    documents: new DocumentService(tenants, weddings, authorizer, vendors, clock, ids, store, DOCUMENT_LIMITS, limiter),
    // In-app feedback (issue #12): stored in the shared store, read by the operator at /admin/feedback.
    feedback: new FeedbackService(clock, ids, limiter, store),
    // Operability (issue #13): 500s are recorded (code + location, never data); /healthz names the build.
    errors,
    ...(config.buildCommit === undefined ? {} : { buildCommit: config.buildCommit }),
    webhookCredentials,
    messaging: {
      port: messagingAdapter,
      receipts: inboundReceipts,
      registry: guestRegistry,
      weddings,
      responder: guestResponder,
      service: messaging,
      escalations,
      // Phase 35/37 — guest-reply → thread correlation + AUTO-REOPEN: the SAME resolution + reply log instances
      // the escalation read/resolve/reply surface uses, so an inbound `escalated` follow-up can thread into the
      // guest's most-recent OPEN escalation, or AUTO-REOPEN their most-recent RESOLVED one and thread into that
      // (resolutions = the effective-status fold READ + the `reopened` transition WRITE; replies = the thread
      // write target + the re-delivery guard) instead of opening a new escalation.
      resolutions,
      replies,
    },
    // The escalation inbox READ + RESOLVE + REPLY surface (Phase 26 + 27 + 28 + 34) — the SAME log instances the
    // inbound capture / resolve / reply mutations write to, read-scoped by the guest authorizer's manageScope
    // (planner: whole tenant; couple: their wedding). `service` is the SAME MessagingService the inbound path
    // uses, so a console reply and a guest reply meter/bill through ONE ledger (Phase 28). `replies` is the
    // multi-turn thread (Phase 34) — appended by a reply, returned as the read's third scoped array.
    escalations: { escalations, resolutions, replies, authorizer: guestAuthorizer, service: messaging },
    // The planner billing & usage summary (Phase 30): the ledger NARROWED to its read fold (`summarize`), the
    // tenant store narrowed to `findById` (the trusted plan_tier of the caller's own tenant), and the
    // management-capability authorizer for the planner-only gate. Always wired (a compose e2e pins reachability).
    billing: { ledger: billing, tenants, authorizer: guestAuthorizer, modelUsage: model },
    ...(config.championStrategy === undefined ? {} : { championStrategy: config.championStrategy }),
    // One transaction per request over the shared store (issue #8).
    transactions: store,
  })
  const themes = new ThemeResolver(tenants)
  // The web UI gets the SessionStore typed as the narrow CsrfGuard (issue/verify only — not login/resolve),
  // so it can check anti-forgery tokens but reads no tenant data (the only-data-path-is-api.handle invariant).
  // The operator console (issue #9) gets the operator store narrowed to CsrfGuard over console sessions.
  const ui = new ProductWebUi({
    errors,
    api,
    themes,
    csrf: sessionStore,
    operatorCsrf: operators,
    // Issue #48: a large upload body only from a live planner session of the slug's own workspace.
    uploadGate: (token, slug) => {
      const principal = sessionStore.resolve(token)
      return principal?.role === 'planner' && principal.tenant_id === tenants.findBySlug(slug)?.tenant_id
    },
    // Issue #10: password sign-in everywhere; the labeled picker only on the demo tenant in demo mode.
    accounts: {
      isSimulatedSlug: (slug) => seedDemo && demoTenantId() !== undefined && tenants.findBySlug(slug)?.tenant_id === demoTenantId(),
      newToken: () => ids.next('pre'),
    },
  })

  let demo: DemoSeed | undefined
  // Seed only into an empty store: a restart over existing data keeps it (issue #8). One transaction, so a
  // failed seed leaves no half-provisioned tenant behind.
  if (seedDemo && tenants.isEmpty()) demo = store.transaction(() => {
    // Provision → activate THROUGH the real lifecycle driver (not a direct store.create), so the demo
    // tenant is a faithful active tenant: it passes the legal-transition guard and records billing events.
    const tenant = onboarding.provision({
      slug: demoSlug,
      display_name: DEMO_DISPLAY_NAME,
      plan_tier: 'studio',
      theme: DEMO_THEME,
    })
    onboarding.activate(tenant.tenant_id)
    store.put(COLLECTIONS.platformSetting, GLOBAL_PARTITION, DEMO_TENANT_SETTING, { value: tenant.tenant_id })
    // The tenant is now active, so the resolver mints a usable context — seed one wedding through it.
    const context = resolver.resolveBySlug(demoSlug)
    const wedding = weddings.create(context, {
      couple_display_name: 'Alex & Sam',
      event_date: '2027-09-18',
    })
    // Register one demo guest so the inbound webhook -> deterministic reply -> meter path is demoable
    // end-to-end. The recipient_ref is an obvious offline placeholder (no real number).
    const guestRecipientRef = 'sms:+15550100'
    guestRegistry.register(context, {
      recipient_ref: guestRecipientRef,
      wedding_id: wedding.wedding_id,
      guest_id: 'guest_demo_1',
    })
    return {
      slug: demoSlug,
      tenantId: tenant.tenant_id,
      weddingId: wedding.wedding_id,
      guestRecipientRef,
    }
  })

  // A database seeded before the demo tenant was recorded (issue #8/#9 deployments): adopt the tenant the seed made —
  // it carries the seed's exact name and brand — exactly once.
  if (seedDemo && demoTenantId() === undefined) {
    const candidate = tenants.findBySlug(demoSlug)
    if (candidate !== undefined && candidate.display_name === DEMO_DISPLAY_NAME && candidate.theme.brand_name === DEMO_THEME.brand_name) {
      store.put(COLLECTIONS.platformSetting, GLOBAL_PARTITION, DEMO_TENANT_SETTING, { value: candidate.tenant_id })
    }
  }

  store.transaction(() => {
    sessionStore.sweepExpired()
    operators.sweepExpired()
  })

  return { ui, api, themes, operatorToken, demo, messaging, escalations, resolutions, email, warmUp: () => accounts.warm(), model, drainJobs: () => jobs.drain() }
}
