/**
 * @wedding-planner/product — the customer-facing product surface.
 *
 * Public barrel. The white-label, multi-tenant web app planners and their couples use, built
 * offline-first. Phase 12 builds the multi-tenant domain core: the tenant + wedding aggregates and
 * the tenant-isolation boundary (the multi-tenancy analogue of the trusted-evidence firewall).
 * HTTP, auth principals, UI, onboarding/billing simulation, and Docker packaging land in later
 * phases. This barrel deliberately does NOT export the TenantContext brand symbol or any context
 * constructor — the resolver is the sole mint (see tenant_context.ts).
 */

export const PRODUCT_PACKAGE_NAME = '@wedding-planner/product'

export { ProductError } from './product_error'

// The product aggregates (generated from product/schemas/*, surfaced via shared's clean-named types).
export type { Tenant, Wedding } from '@wedding-planner/shared'

// Tenant isolation boundary. The brand symbol and the internal mint are deliberately NOT exported —
// the resolver is the sole mint of a TenantContext.
export {
  type TenantContext,
  TenantContextResolver,
  assertMintedContext,
  isUsableLifecycle,
  USABLE_LIFECYCLE_STATUSES,
} from './tenant/tenant_context'
export {
  TenantStore,
  type TenantLivenessCheck,
  type TenantRouting,
  type CreateTenantInput,
  normalizeSlug,
} from './tenant/tenant_store'
export { TenantScopedRepository, type TenantOwned } from './tenant/tenant_scoped_repository'

// The wedding aggregate, tenant-scoped.
export { WeddingRepository, type CreateWeddingInput } from './wedding/wedding_repository'

// The simulated billing ledger (Phase 15): the offline model that drives the tenant lifecycle. No real
// money — amount_cents are modeled, integer cents. The 'account balance' is a fold over events.
export type { BillingEvent } from '@wedding-planner/shared'
export {
  MONTHLY_PRICE_CENTS,
  monthlyPriceCents,
  MESSAGE_PRICE_CENTS,
  messagePriceCents,
  type PlanTier,
} from './billing/price_book'
export {
  BillingLedger,
  type BillingEventKind,
  type FinancialBillingEventKind,
  FINANCIAL_KINDS,
  type LedgerSummary,
  type RecordBillingEventInput,
} from './billing/billing_ledger'
// The planner-facing billing & usage projection (Phase 30): the tenant's own account summary (plan + usage +
// balance), a pure render-time view layering the price book onto a LedgerSummary. No schema.
export { type BillingSummary, buildBillingSummary } from './billing/billing_summary'
// The planner-facing billing ACTIVITY projection (Phase 32): the itemized financial line items behind the summary
// totals (charge / usage_charge / payment), newest-first. A pure render-time view, no schema.
export { type BillingActivityEntry, buildBillingActivity } from './billing/billing_activity'

// The operator-driven onboarding + lifecycle driver (Phase 15): the only path that moves a tenant through
// its simulated lifecycle (∅ → onboarding → active → suspended → active), recording billing events.
export { OnboardingService, type ProvisionTenantInput } from './onboarding/onboarding_service'

// Intra-tenant authorization: the Principal (planner vs couple) and the session mint. The brand symbol
// and the internal mintPrincipal are deliberately NOT exported — the SessionStore is the sole mint.
export { type Principal, type PrincipalRole, assertMintedPrincipal } from './auth/principal'
export { SessionStore, type LoginInput, type Session } from './auth/session_store'
// The browser-form anti-forgery boundary (Phase 21): SessionStore implements CsrfGuard (per-session token,
// distinct from the session token). The web layer is the sole consumer; the JSON API is not CSRF-reachable.
export { type CsrfGuard, constantTimeEqual } from './auth/csrf_guard'
export {
  WeddingAuthorizer,
  type AccessDecision,
  type ListScope,
} from './auth/wedding_authorizer'
// The guest-management authorization rule (Phase 21): planner-only capability over the guest registry.
export { GuestAuthorizer } from './auth/guest_authorizer'

// The platform trust tier (Phase 15): the Operator subject + its sole credential store. The brand symbol
// and the internal mintOperator are deliberately NOT exported — the store is the sole mint.
export { type Operator, OperatorCredentialStore, assertMintedOperator } from './auth/operator_credential'

// The provider-webhook trust tier (Phase 19): the FOURTH token namespace, authenticating the server-to-server
// inbound messaging webhook. Mirrors the Operator tier (phantom brand + WeakSet + sole-mint store); the brand
// symbol and the internal mint are deliberately NOT exported.
export {
  type ProviderWebhookCredential,
  ProviderWebhookCredentialStore,
  assertMintedProviderWebhook,
} from './auth/provider_webhook_credential'

// The HTTP request edge (transport-agnostic). The Node socket adapter lands in Step 4.
export type { ApiRequest, ApiResponse } from './http/api_message'
export {
  ProductApi,
  type ProductApiDeps,
  type WeddingHandlerDeps,
  type GuestHandlerDeps,
  type AdminHandlerDeps,
  type MessagingHandlerDeps,
  type EscalationHandlerDeps,
  REPLY_BODY_MAX_LENGTH,
} from './http/product_api'
export { createProductApiServer, MAX_BODY_BYTES } from './http/node_server'

// The server-rendered web UI (Phase 14): the themed white-label HTML front door over the JSON pipeline.
// It holds { api, themes, csrf } — its sole DATA path is api.handle() (themes/csrf read no tenant data), so
// it inherits both boundaries; the Phase-21 csrf guard adds the browser-form anti-forgery check.
export type { HttpResult } from './web/web_response'
export { ThemeResolver } from './web/theme_resolver'
export { ProductWebUi, type ProductWebUiDeps } from './web/product_web_ui'
export { createProductWebUiServer } from './web/web_server'

// The engine↔surface seam (Phase 17): the pure projection of the loop's champion StrategyGenome into
// read-only, planner-facing guidance. A deterministic function of the genome alone (no context/principal/
// repo), it re-derives the risk tier (never trusts a declared one) and carries only human copy.
export {
  describeStrategy,
  type StrategyGuidance,
  type StrategyKnobGuidance,
  type StrategyAutonomyGuidance,
} from './strategy/strategy_guidance'

// The guest-messaging provider boundary (Phase 18): the provider-agnostic MessagingPort (the no-vendor-
// lock-in seam) + its domain types. No carrier concepts cross it; a real provider is the human-reserved
// crossing. The offline simulated adapter + the metered/billed MessagingService are exported below.
export type {
  MessagingPort,
  OutboundMessage,
  SendReceipt,
  DeliveryStatus,
  DeliveryState,
  RawInboundPayload,
  InboundMessage,
  ProviderCostReport,
  RecipientRef,
} from './messaging/messaging_port'
export {
  SimulatedMessagingAdapter,
  SIMULATED_PROVIDER_COST_CENTS,
} from './messaging/simulated_messaging_adapter'
export {
  MessagingService,
  type MessageUsageRecord,
  type SendResult,
  type TenantUsageView,
} from './messaging/messaging_service'

// The guest channel (Phase 19): a guest is an UNTRUSTED actor (never a session Principal), bound to ONE
// wedding by an opaque sender ref via the GuestRegistry (the segmentation gate, inheriting tenant isolation),
// and answered by a product-side deterministic GuestQaResponder (no loop import; deny-by-fact-classification).
export { GuestRegistry, type GuestBinding, type RegisterGuestInput } from './messaging/guest_registry'
export { InboundReceiptLog } from './messaging/inbound_receipt_log'
// The escalation inbox (Phase 26): an `escalated` guest question (one the platform could not answer) is recorded
// here, keyed (tenant_id, provider_message_ref), and read by the couple (their wedding) / planner (whole tenant).
export { EscalationLog, type RecordEscalationInput } from './messaging/escalation_log'
// The escalation status-transition log (Phase 27, generalized in Phase 36): the SEPARATE append-only sequence
// (keyed (tenant_id, `${escalation_id}:${seq}`)) of resolved/dismissed/reopened transitions over a guest
// escalation WITHOUT mutating it; effective status is the highest-`seq` fold (ADR 0027 / ADR 0036).
export {
  EscalationResolutionLog,
  type RecordTransitionInput,
  type EffectiveEscalationStatus,
} from './messaging/escalation_resolution_log'
export { EscalationReplyLog, type RecordReplyInput } from './messaging/escalation_reply_log'
export {
  type GuestQaResponder,
  type GuestQaOutcome,
  type GuestQaAction,
  type GuestVisibleFacts,
  DeterministicGuestQaResponder,
  projectGuestVisibleFacts,
} from './messaging/guest_qa_responder'

// The composition root (Phase 16): wires every dependency into one running web front door from INJECTED
// primitives (clock/ids/operator token), so the deployable entrypoint stays a thin impure shell. The
// edge-only SystemClock / RandomIdGenerator are deliberately exported from NEITHER barrel — app/server.ts
// imports them by relative path, keeping a wall clock unreachable from the deterministic core by autocomplete.
export {
  composeProductSurface,
  type ComposeProductSurfaceConfig,
  type ComposedSurface,
  type DemoSeed,
} from './runtime/compose'

// Persistence (issue #8, ADR 0039): the RecordStore port every store sits behind and its in-memory adapter. The
// durable SQLite adapter is an EDGE primitive like the wall clock: exported from no barrel (so importing the
// product never loads `node:sqlite`), imported by relative path in app/server.ts and its tests. The collection
// census is not exported either: nothing outside the product's stores addresses raw records.
export {
  type Collection,
  type CollectionScope,
  groupedKey,
  keyPrefixOf,
  type RecordStore,
  type TransactionRunner,
} from './persistence/record_store'
export { InMemoryRecordStore } from './persistence/in_memory_record_store'
export { SESSION_TTL_SECONDS, type SessionAuth, type SessionStoreOptions, type StoredSession } from './auth/session_store'

// The email boundary (issue #9, ADR 0040): the provider-agnostic port, the offline simulated adapter whose outbox
// the operator reads, and the operator console that serves it to a browser.
export {
  assertValidOutboundEmail,
  EMAIL_LIMITS,
  type EmailDeliveryStatus,
  type EmailPort,
  type EmailPurpose,
  type EmailReceipt,
  isEmailAddress,
  type OutboundEmail,
} from './email/email_port'
export {
  type EmailOutboxReader,
  OUTBOX_RETENTION,
  type OutboxMessage,
  REDACTED_LINK,
  SimulatedEmailAdapter,
  type StoredOutboxMessage,
} from './email/simulated_email_adapter'
export { OperatorConsole, type OperatorConsoleDeps } from './web/operator_console'

// Real accounts (issue #10, ADR 0041): scrypt password hashing, the account store, single-use emailed links,
// in-process rate limits, and the service that ties them to the SessionStore (still the sole Principal mint).
export {
  ACCOUNT_RATE_LIMITS,
  AccountService,
  type AccountServiceDeps,
  RESET_TOKEN_TTL_SECONDS,
  SETUP_TOKEN_TTL_SECONDS,
} from './accounts/account_service'
export {
  type AccountRole,
  AccountStore,
  normalizeEmail,
  type PublicAccountView,
  publicAccountView,
  type UserAccount,
} from './accounts/account_store'
export { OneTimeTokenStore, type OneTimeTokenPurpose } from './accounts/one_time_token_store'
export { type PendingReset, PendingResetQueue } from './accounts/pending_reset_queue'
// The team (issue #11, ADR 0042): invitations and members.
export { type CreateInvitationInput, type Invitation, InvitationStore, type InvitedRole } from './accounts/invitation_store'
export {
  INVITATION_TTL_SECONDS,
  type InvitationView,
  type InviteInput,
  MembershipService,
  type MembershipServiceDeps,
  type TeamView,
} from './accounts/membership_service'
export {
  assertAcceptablePassword,
  PASSWORD_LIMITS,
  type PasswordHash,
  PasswordHasher,
  PRODUCTION_SCRYPT_COST,
  type ScryptCost,
} from './accounts/password_hasher'
export { MAX_KEYS, RateLimiter, type RateLimitRule } from './accounts/rate_limiter'

// In-app feedback (issue #12, ADR 0043).
export {
  FEEDBACK_LIMITS,
  FEEDBACK_PAGES,
  FEEDBACK_RATE_LIMITS,
  FEEDBACK_RETENTION,
  type FeedbackPage,
  FeedbackService,
  type FeedbackSubmission,
  isFeedbackPage,
  type SubmitFeedbackInput,
} from './feedback/feedback_service'

// The guest list (issue #27, ADR 0046): households and guests per wedding.
export {
  GUEST_LIST_LIMITS,
  type GuestImportResult,
  type GuestInput,
  type GuestListCounts,
  fanOutGuestListHooks,
  type GuestListHooks,
  GuestListService,
  type GuestListView,
  type GuestSide,
  type HouseholdInput,
} from './guests/guest_list_service'

export {
  GUEST_CSV_COLUMNS,
  GUEST_CSV_LIMITS,
  type ImportPlan,
  type ImportProblem,
  neutralize,
  parseCsv,
  planGuestImport,
  type PlannedGuest,
  toGuestCsv,
  unneutralize,
} from './guests/guest_csv'

// A wedding's events and the guests' RSVPs per event (issue #29, ADR 0048).
export {
  type EventInvitation,
  type GuestEventRsvp,
  HOUSEHOLD_ANSWER_LIMITS,
  type HouseholdAnswer,
  type HouseholdRsvpView,
  isLocalDateTime,
  type MealOptionInput,
  type RsvpAnsweredBy,
  type RsvpInput,
  type RsvpStatus,
  WEDDING_EVENT_LIMITS,
  type WeddingEventCounts,
  type WeddingEventInput,
  WeddingEventService,
  type WeddingEventsView,
} from './wedding_events/wedding_event_service'
export { GuestDirectory } from './guests/guest_directory'
// A real local calendar date (YYYY-MM-DD): wedding dates and due dates (issue #31).
export { assertDate, isDate } from './wedding/calendar_date'
// What typed text may hold (no control characters, separators or direction overrides).
export { assertPlainText } from './text/plain_text'
// A wedding's checklist and the built-in template (issue #31, ADR 0050).
export {
  CHECKLIST_LIMITS,
  ChecklistService,
  type ChecklistView,
  DUE_LISTED_PER_WEDDING,
  DUE_SOON_DAYS,
  type DueAcrossWeddings,
  type DueTask,
  type DueWedding,
  type TaskAssignee,
  type TaskInput,
  type TaskStatus,
} from './checklist/checklist_service'
export { CHECKLIST_TEMPLATE, type ChecklistOffset, type ChecklistTemplateItem, dateBefore, daysBetween, shiftDate } from './checklist/checklist_template'
// A wedding's run of show: the day-of timeline and vendor call times (issue #45, ADR 0053).
export {
  RUN_OF_SHOW_LIMITS,
  type RunOfShowInput,
  type RunOfShowLine,
  type RunOfShowOwner,
  RunOfShowService,
  type RunOfShowView,
} from './run_of_show/run_of_show_service'
// A wedding's budget, lines optionally following a vendor's schedule (issue #34, ADR 0052).
export {
  BUDGET_LIMITS,
  type BudgetCategoryInput,
  type BudgetLine,
  BudgetService,
  type BudgetTotals,
  type BudgetView,
  NEXT_PAYMENTS_LISTED,
  type NextPayment,
} from './budget/budget_service'
// A wedding's vendors and their payment schedules, in integer cents (issue #33, ADR 0051).
export {
  centsFromText,
  type ContractStatus,
  type DueInstallment,
  type Installment,
  type InstallmentInput,
  MAX_AMOUNT_CENTS,
  VENDOR_CATEGORIES,
  VENDOR_LIMITS,
  type VendorCategory,
  type VendorInput,
  VendorService,
  type VendorsView,
} from './vendors/vendor_service'
// Households' RSVP links and the grant a resolved link carries (issue #30, ADR 0049).
export { assertHouseholdGrant, type HouseholdRsvpGrant, RsvpLinkService } from './rsvp/rsvp_link_service'
export { assertWeddingReach } from './wedding/wedding_reach'

// Operability (issue #13, ADR 0044): the per-request log line and the server-error log.
export { ERROR_RETENTION, ErrorLog, errorCode, errorName, type ServerError, stackFrames } from './operability/error_log'
export { formatRequestLog, logMethod, type RequestLogEntry, routePattern } from './operability/request_log'
export { type RequestLogging } from './web/web_server'
export { type AuthenticatedAccount } from './auth/session_store'
export {
  OPERATOR_SESSION_TTL_SECONDS,
  type OperatorSession,
  type OperatorSessionOptions,
} from './auth/operator_credential'
