import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type Principal,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
} from '@wedding-planner/product'

/**
 * Step-2 unit coverage for the intra-tenant authorizer. The load-bearing property: a couple's
 * ownership is decided STRUCTURALLY from principal.wedding_id, so a non-owned id (foreign OR
 * own-but-absent) yields the identical masked decision — no intra-tenant existence oracle.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

function makeWorld() {
  const store = new TenantStore(
    new ManualClock('2027-03-01T00:00:00.000Z'),
    new SequentialIdGenerator('seedT'),
  )
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  const ctx = resolver.resolveBySlug('alpha')
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  const authorizer = new WeddingAuthorizer()
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

describe('wedding_authorizer', () => {
  it('a planner is allowed every operation on any id in the tenant', () => {
    const w = makeWorld()
    expect(w.authorizer.authorizeCreate(w.planner)).toBe('allow')
    expect(w.authorizer.authorizeRead(w.planner, 'any_wedding')).toBe('allow')
    expect(w.authorizer.authorizeUpdate(w.planner, 'any_wedding')).toBe('allow')
    expect(w.authorizer.listScope(w.planner)).toEqual({ kind: 'all' })
  })

  it('a couple may read/update their own wedding', () => {
    const w = makeWorld()
    expect(w.authorizer.authorizeRead(w.couple, 'wedding_owned')).toBe('allow')
    expect(w.authorizer.authorizeUpdate(w.couple, 'wedding_owned')).toBe('allow')
  })

  it('a couple addressing a NON-owned id is masked identically (foreign and own-absent are one decision)', () => {
    const w = makeWorld()
    // Foreign-but-same-tenant id and a genuinely-unknown id both yield mask-not-found — no probe.
    const foreign = w.authorizer.authorizeRead(w.couple, 'wedding_someone_else')
    const unknown = w.authorizer.authorizeRead(w.couple, 'wedding_never_created')
    expect(foreign).toBe('mask-not-found')
    expect(unknown).toBe('mask-not-found')
    expect(foreign).toBe(unknown)
    // Same on the update path.
    expect(w.authorizer.authorizeUpdate(w.couple, 'wedding_someone_else')).toBe('mask-not-found')
  })

  it('a couple cannot create (capability denial -> forbidden, distinct from the masked not-found)', () => {
    const w = makeWorld()
    expect(w.authorizer.authorizeCreate(w.couple)).toBe('forbidden')
  })

  it('a couple list is scoped to their single bound wedding (zero-or-one), derived from the principal', () => {
    const w = makeWorld()
    expect(w.authorizer.listScope(w.couple)).toEqual({ kind: 'single', wedding_id: 'wedding_owned' })
  })

  it('a forged (unbranded) principal is rejected at every entry point', () => {
    const w = makeWorld()
    const forged = { tenant_id: 't', role: 'planner', principal_id: 'p' } as unknown as Principal
    expect(codeOfThrow(() => w.authorizer.authorizeCreate(forged))).toBe('PRODUCT.FORGED_PRINCIPAL')
    expect(codeOfThrow(() => w.authorizer.authorizeRead(forged, 'x'))).toBe('PRODUCT.FORGED_PRINCIPAL')
    expect(codeOfThrow(() => w.authorizer.authorizeUpdate(forged, 'x'))).toBe('PRODUCT.FORGED_PRINCIPAL')
    expect(codeOfThrow(() => w.authorizer.listScope(forged))).toBe('PRODUCT.FORGED_PRINCIPAL')
  })
})
