import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { assertWeddingReach, InMemoryRecordStore, SessionStore, TenantContextResolver, TenantStore, WeddingAuthorizer, WeddingRepository } from '@wedding-planner/product'

/** `assertWeddingReach` (ADR 0048): the one "may this principal reach this wedding" check, with the masked not-found. */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

describe('assertWeddingReach', () => {
  it('returns the wedding to its planner and its couple; another wedding and a missing one are the same NOT_FOUND', () => {
    const clock = new ManualClock('2027-06-01T00:00:00.000Z')
    const store = new InMemoryRecordStore()
    const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
    tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
    const ctx = new TenantContextResolver(tenants).resolveBySlug('alpha')
    const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'), store)
    const ours = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' })
    const theirs = weddings.create(ctx, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' })
    const sessions = new SessionStore(new SequentialIdGenerator('s'))
    const planner = sessions.login(ctx, { role: 'planner' }).principal
    const couple = sessions.login(ctx, { role: 'couple', wedding_id: ours.wedding_id }).principal
    const authorizer = new WeddingAuthorizer()
    const reach = (principal: typeof planner, id: string) => assertWeddingReach(authorizer, weddings, ctx, principal, id)
    expect(reach(planner, theirs.wedding_id).wedding_id).toBe(theirs.wedding_id)
    expect(reach(couple, ours.wedding_id).couple_display_name).toBe('Jo & Lee')
    for (const [principal, id] of [
      [couple, theirs.wedding_id],
      [couple, 'wedding_missing'],
      [planner, 'wedding_missing'],
    ] as const) {
      expect(() => reach(principal, id)).toThrow(expect.objectContaining({ code: 'PRODUCT.NOT_FOUND', message: 'No such wedding.' }))
    }
  })
})
