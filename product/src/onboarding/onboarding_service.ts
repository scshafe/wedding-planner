import { type Tenant } from '@wedding-planner/shared'

import { type BillingLedger } from '../billing/billing_ledger'
import { monthlyPriceCents, type PlanTier } from '../billing/price_book'
import { ProductError } from '../product_error'
import { type TenantStore } from '../tenant/tenant_store'

/**
 * @canonical onboarding_service -- the operator-driven tenant birth + lifecycle driver (offline).
 *
 * The canonical, and ONLY, path that moves a tenant through its simulated lifecycle
 * (∅ → onboarding → active → suspended → active), recording the matching billing events as it goes. It
 * gives the `onboarding`/`suspended` lifecycle states (which the resolver fails closed on) a DRIVER, and
 * replaces direct `TenantStore.create()` test-fixture births with a real provisioning flow. Everything is
 * offline: no real money, no real provisioning (CLAUDE.md rail).
 *
 * A LEGAL-TRANSITION GUARD is the load-bearing invariant: `TenantStore.setLifecycleStatus` validates only
 * the TARGET enum, not the edge, so an unguarded double-`activate` (or suspend-an-onboarding) would record
 * a spurious, irreversible billing event and corrupt the balance fold. Each method therefore reads the
 * CURRENT `lifecycle_status` and throws `PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION` BEFORE recording anything;
 * only a legal transition both flips the status and records its event(s) — lifecycle and ledger move
 * together, atomically-on-success.
 *
 * No session is minted here. `provision` lands a tenant in `onboarding`, which the resolver refuses to mint
 * a context for — so the first planner simply logs in via the public `/t/:slug/sessions` edge once the
 * tenant is active (login stays the sole session mint; it is the credential-free simulation).
 *
 * related: billing_ledger.ts (the recorded events), price_book.ts (sizes the charge), tenant_store.ts
 * (the create + the single setLifecycleStatus mutation point), product_api.ts (the /admin handlers).
 */

/** What an operator supplies to provision a tenant. Lifecycle is forced to `onboarding` (not caller-set). */
export interface ProvisionTenantInput {
  readonly slug: string
  readonly display_name: string
  readonly theme: Tenant['theme']
  readonly plan_tier: PlanTier
}

export class OnboardingService {
  constructor(
    private readonly tenants: TenantStore,
    private readonly billing: BillingLedger,
  ) {}

  /**
   * Provision a new tenant in `onboarding` and open its billing account (records `provisioned`). The
   * `tenants.create` call is the ONLY legitimately-throwing step and runs FIRST — so a `DUPLICATE_SLUG`
   * (or a malformed slug/theme/tier the tenant schema rejects) leaves NO partial state: no event is
   * recorded. Returns the created tenant. **∅ → onboarding.**
   */
  provision(input: ProvisionTenantInput): Tenant {
    const tenant = this.tenants.create({
      slug: input.slug,
      display_name: input.display_name,
      theme: input.theme,
      plan_tier: input.plan_tier,
      lifecycle_status: 'onboarding',
    })
    this.billing.record({ tenant_id: tenant.tenant_id, kind: 'provisioned' })
    return tenant
  }

  /** Activate after onboarding: charge + collect the first period, then flip live. **onboarding → active.** */
  activate(tenant_id: string): Tenant {
    this.#assertTransition(tenant_id, 'onboarding', 'active')
    this.#chargeAndPay(tenant_id)
    return this.tenants.setLifecycleStatus(tenant_id, 'active')
  }

  /** Suspend a live tenant (the modeled delinquency path). **active → suspended.** */
  suspend(tenant_id: string): Tenant {
    this.#assertTransition(tenant_id, 'active', 'suspended')
    this.billing.record({ tenant_id, kind: 'suspended' })
    return this.tenants.setLifecycleStatus(tenant_id, 'suspended')
  }

  /** Reactivate a suspended tenant on a fresh payment. **suspended → active.** */
  reactivate(tenant_id: string): Tenant {
    this.#assertTransition(tenant_id, 'suspended', 'active')
    this.#chargeAndPay(tenant_id)
    this.billing.record({ tenant_id, kind: 'reactivated' })
    return this.tenants.setLifecycleStatus(tenant_id, 'active')
  }

  /**
   * The tenant's billing ledger view: its events (record order) + the owed balance (positive = owed).
   * Guards existence FIRST (`#requireTenant`), so an unknown tenant_id throws PRODUCT.UNKNOWN_TENANT
   * (→ masked 404 at the edge) — consistent with activate/suspend/reactivate, never a fabricated empty 200.
   */
  billingView(tenant_id: string): { events: ReturnType<BillingLedger['eventsFor']>; balance_cents: number } {
    this.#requireTenant(tenant_id)
    return {
      events: this.billing.eventsFor(tenant_id),
      balance_cents: this.billing.balanceCents(tenant_id),
    }
  }

  /** Record the priced charge for the tenant's plan tier and an equal payment that settles it. */
  #chargeAndPay(tenant_id: string): void {
    const tenant = this.#requireTenant(tenant_id)
    const amount_cents = monthlyPriceCents(tenant.plan_tier as PlanTier)
    this.billing.record({ tenant_id, kind: 'charge', amount_cents })
    this.billing.record({ tenant_id, kind: 'payment', amount_cents })
  }

  /** Assert the tenant exists and is in `from`; else throw (UNKNOWN_TENANT or ILLEGAL_LIFECYCLE_TRANSITION). */
  #assertTransition(tenant_id: string, from: Tenant['lifecycle_status'], to: Tenant['lifecycle_status']): void {
    const tenant = this.#requireTenant(tenant_id)
    if (tenant.lifecycle_status !== from) {
      throw new ProductError(
        'PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION',
        `Cannot transition tenant from '${tenant.lifecycle_status}' to '${to}' (expected '${from}').`,
        { context: { from: tenant.lifecycle_status, to } },
      )
    }
  }

  #requireTenant(tenant_id: string): Tenant {
    const tenant = this.tenants.findById(tenant_id)
    if (tenant === undefined) {
      throw new ProductError('PRODUCT.UNKNOWN_TENANT', `No tenant '${tenant_id}'.`, { context: { tenant_id } })
    }
    return tenant
  }
}
