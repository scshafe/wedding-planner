import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type Principal,
  GuestAuthorizer,
  SessionStore,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Phase 24 unit coverage for the guest-management authorizer. The split: `register` is a CAPABILITY a couple
 * lacks (planner allow / couple forbidden), and `manageScope` (driving list/remove) is whole-tenant for a
 * planner and the couple's single bound wedding for a couple — derived ONLY from principal.wedding_id, never
 * the request body. A forged principal is rejected at every entry point.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

function makeWorld() {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const ctx = new TenantContextResolver(store).resolveBySlug('alpha')
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  const authorizer = new GuestAuthorizer()
  const planner = sessions.login(ctx, { role: 'planner' }).principal
  const couple = sessions.login(ctx, { role: 'couple', wedding_id: 'wedding_owned' }).principal
  return { authorizer, planner, couple }
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  throw new Error('expected the operation to throw, but it did not')
}

describe('guest_authorizer', () => {
  it('a planner may register and manages the whole tenant partition', () => {
    const w = makeWorld()
    expect(w.authorizer.authorizeRegister(w.planner)).toBe('allow')
    expect(w.authorizer.manageScope(w.planner)).toEqual({ kind: 'all' })
  })

  it('a couple cannot register (capability denial -> forbidden), but manages their bound wedding', () => {
    const w = makeWorld()
    expect(w.authorizer.authorizeRegister(w.couple)).toBe('forbidden')
    expect(w.authorizer.manageScope(w.couple)).toEqual({ kind: 'wedding', wedding_id: 'wedding_owned' })
  })

  // NOTE: a couple principal ALWAYS carries a wedding_id (SessionStore.login rejects a couple login without
  // one), so manageScope's `wedding_id: undefined` arm is unreachable via a legitimate principal — the
  // registry's undefined→[]/false collapse is defensive belt-and-suspenders, not a state a login can produce.

  it('a forged (unbranded) principal is rejected at every entry point', () => {
    const w = makeWorld()
    const forged = { tenant_id: 't', role: 'planner', principal_id: 'p' } as unknown as Principal
    expect(codeOfThrow(() => w.authorizer.authorizeRegister(forged))).toBe('PRODUCT.FORGED_PRINCIPAL')
    expect(codeOfThrow(() => w.authorizer.manageScope(forged))).toBe('PRODUCT.FORGED_PRINCIPAL')
  })
})
