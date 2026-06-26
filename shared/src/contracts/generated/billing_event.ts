/* eslint-disable */
/**
 * GENERATED from product/schemas/billing_event_schema.json — DO NOT EDIT BY HAND.
 * The JSON Schema file is the source of truth. Regenerate with: npm run gen:types
 */

/**
 * An append-only entry in a tenant's simulated billing ledger — the offline model that DRIVES the tenant lifecycle (onboarding -> active -> suspended -> active). NO real money: amount_cents is a modeled charge derived from the plan_tier/message price book, never a real transaction. The ledger is the tenant's billing audit trail (the operator's /admin/.../billing view); the 'account balance' is a fold over these events (sum of charge + usage_charge minus sum of payment, positive = owed), never a separate materialized aggregate. Lifecycle events are recorded by the OnboardingService on a legal transition; usage_charge events are recorded by the MessagingService per accepted metered send (Phase 18). See product/README.md and ADR 0015/0018.
 */
export type BillingEvent = ({
[k: string]: unknown
} & {
/**
 * Stable internal identity, injected from the id generator (never ambient).
 */
event_id: string
/**
 * The tenant this billing event belongs to. The ledger is partitioned by this key; eventsFor(tenant_id) returns ONLY a single tenant's events (no cross-tenant leak).
 */
tenant_id: string
/**
 * What happened. Financial kinds carry money: 'charge' accrues a plan-tier fee (increases the owed balance), 'usage_charge' accrues a metered per-message messaging fee (increases the owed balance; Phase 18), 'payment' settles money in (decreases it). Marker kinds carry NO money and record a lifecycle fact: 'provisioned' (the account was opened, tenant born in onboarding), 'suspended' (delinquency / active->suspended), 'reactivated' (suspended->active). The balance fold sums ONLY the financial kinds. Unlike the monthly 'charge' (paired with an equal 'payment' to settle), a 'usage_charge' accrues and is not auto-settled — metered usage made visible as an owed balance.
 */
kind: ("provisioned" | "charge" | "payment" | "suspended" | "reactivated" | "usage_charge")
/**
 * Money as INTEGER CENTS (never a float). Present iff kind is financial ('charge', 'payment', or 'usage_charge') and forbidden on marker kinds (enforced below by the per-kind allOf), so the balance fold can never accidentally sum a non-financial marker.
 */
amount_cents?: number
/**
 * ISO 8601 UTC time the event was recorded, from the injected clock (never ambient).
 */
occurred_at: string
})
