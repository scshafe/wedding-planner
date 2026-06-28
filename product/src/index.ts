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
  type RecordBillingEventInput,
} from './billing/billing_ledger'

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
