import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  BillingLedger,
  MONTHLY_PRICE_CENTS,
  OnboardingService,
  SessionStore,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

const THEME: Tenant['theme'] = {
  brand_name: 'Evergreen',
  primary_color_hex: '#1a2b3c',
  accent_color_hex: '#ffccaa',
  logo_ref: 'asset_logo_1',
}

function makeWorld() {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const tenants = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  const billing = new BillingLedger(clock, new SequentialIdGenerator('seedB'))
  const onboarding = new OnboardingService(tenants, billing)
  const resolver = new TenantContextResolver(tenants)
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  return { tenants, billing, onboarding, resolver, sessions }
}

function provision(w: ReturnType<typeof makeWorld>, slug = 'evergreen'): Tenant {
  return w.onboarding.provision({ slug, display_name: 'Evergreen Co', theme: THEME, plan_tier: 'studio' })
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('OnboardingService — the happy lifecycle', () => {
  it('provisions a tenant in onboarding and opens its billing account', () => {
    const w = makeWorld()
    const tenant = provision(w)
    expect(tenant.lifecycle_status).toBe('onboarding')
    expect(w.billing.eventsFor(tenant.tenant_id).map((e) => e.kind)).toEqual(['provisioned'])
    expect(w.billing.balanceCents(tenant.tenant_id)).toBe(0)
  })

  it('drives onboarding → active → suspended → active, recording the matching events + a settled balance', () => {
    const w = makeWorld()
    const t = provision(w)
    const id = t.tenant_id
    const price = MONTHLY_PRICE_CENTS.studio

    expect(w.onboarding.activate(id).lifecycle_status).toBe('active')
    expect(w.onboarding.suspend(id).lifecycle_status).toBe('suspended')
    expect(w.onboarding.reactivate(id).lifecycle_status).toBe('active')

    expect(w.billing.eventsFor(id).map((e) => e.kind)).toEqual([
      'provisioned',
      'charge',
      'payment',
      'suspended',
      'charge',
      'payment',
      'reactivated',
    ])
    // Two charges, two equal payments — settled.
    expect(w.billing.balanceCents(id)).toBe(0)
    // Each charge was the studio price.
    expect(w.billing.eventsFor(id).filter((e) => e.kind === 'charge').map((e) => e.amount_cents)).toEqual([
      price,
      price,
    ])
  })

  it('the billingView returns the events + the owed balance', () => {
    const w = makeWorld()
    const t = provision(w)
    w.onboarding.activate(t.tenant_id)
    const view = w.onboarding.billingView(t.tenant_id)
    expect(view.events.map((e) => e.kind)).toEqual(['provisioned', 'charge', 'payment'])
    expect(view.balance_cents).toBe(0)
  })
})

describe('OnboardingService — the transition guard (no spurious events on an illegal edge)', () => {
  it('rejects double-activate, suspend-an-onboarding, reactivate-an-active, activate-after-suspend', () => {
    const w = makeWorld()
    const id = provision(w).tenant_id

    // suspend while onboarding — illegal (must be active).
    expect(codeOfThrow(() => w.onboarding.suspend(id))).toBe('PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION')
    // reactivate while onboarding — illegal (must be suspended).
    expect(codeOfThrow(() => w.onboarding.reactivate(id))).toBe('PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION')

    w.onboarding.activate(id)
    // double-activate — illegal (already active).
    expect(codeOfThrow(() => w.onboarding.activate(id))).toBe('PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION')
    // reactivate while active — illegal.
    expect(codeOfThrow(() => w.onboarding.reactivate(id))).toBe('PRODUCT.ILLEGAL_LIFECYCLE_TRANSITION')

    // After all the rejected ops, ONLY the legal provisioned+charge+payment events exist (no orphans).
    expect(w.billing.eventsFor(id).map((e) => e.kind)).toEqual(['provisioned', 'charge', 'payment'])
  })

  it('an illegal transition records NO billing event (lifecycle + ledger move together)', () => {
    const w = makeWorld()
    const id = provision(w).tenant_id
    const before = w.billing.eventsFor(id).length
    codeOfThrow(() => w.onboarding.suspend(id))
    expect(w.billing.eventsFor(id).length).toBe(before)
    expect(w.tenants.findById(id)?.lifecycle_status).toBe('onboarding')
  })

  it('an unknown tenant id throws UNKNOWN_TENANT (not an illegal-transition leak)', () => {
    const w = makeWorld()
    expect(codeOfThrow(() => w.onboarding.activate('tnt_missing'))).toBe('PRODUCT.UNKNOWN_TENANT')
  })

  it('billingView on an unknown tenant throws UNKNOWN_TENANT (no fabricated empty 200)', () => {
    const w = makeWorld()
    expect(codeOfThrow(() => w.onboarding.billingView('tnt_missing'))).toBe('PRODUCT.UNKNOWN_TENANT')
  })
})

describe('OnboardingService — provision atomicity + the login edge', () => {
  it('a duplicate slug leaves no orphan billing event (create throws first)', () => {
    const w = makeWorld()
    provision(w, 'dup')
    const eventsBefore = w.billing.eventsFor(w.tenants.findBySlug('dup')!.tenant_id).length
    expect(codeOfThrow(() => provision(w, 'dup'))).toBe('PRODUCT.DUPLICATE_SLUG')
    // No second tenant, and the existing tenant's ledger is unchanged (no orphan provisioned event).
    expect(w.billing.eventsFor(w.tenants.findBySlug('dup')!.tenant_id).length).toBe(eventsBefore)
  })

  it('a planner can resolve a context (and thus log in) ONLY once the tenant is active', () => {
    const w = makeWorld()
    const t = provision(w, 'evergreen')
    // While onboarding, the resolver fails closed — no context, so no login.
    expect(codeOfThrow(() => w.resolver.resolveBySlug('evergreen'))).toBe('PRODUCT.TENANT_NOT_USABLE')
    w.onboarding.activate(t.tenant_id)
    // Now active — a context mints and a planner login succeeds.
    const ctx = w.resolver.resolveBySlug('evergreen')
    expect(() => w.sessions.login(ctx, { role: 'planner' })).not.toThrow()
  })
})
