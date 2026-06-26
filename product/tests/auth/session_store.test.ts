import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  assertMintedPrincipal,
  type Principal,
  SessionStore,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Step-1 unit coverage for the auth core: the SessionStore is the sole mint of a Principal, the token
 * is an opaque server-side handle, and the principal carries the brand the authorizer will check.
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
  return { store, resolver, ctx, sessions }
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  throw new Error('expected the operation to throw, but it did not')
}

describe('session_store', () => {
  it('mints a planner principal with the context tenant_id and no wedding_id', () => {
    const w = makeWorld()
    const { token, principal } = w.sessions.login(w.ctx, { role: 'planner' })

    expect(principal.tenant_id).toBe(w.ctx.tenant_id)
    expect(principal.role).toBe('planner')
    expect(principal.wedding_id).toBeUndefined()
    // A planner carries no own wedding_id key at all (not merely an undefined value).
    expect(Object.prototype.hasOwnProperty.call(principal, 'wedding_id')).toBe(false)
    expect(typeof token).toBe('string')
    expect(token.length).toBeGreaterThan(0)
  })

  it('mints a couple principal bound to the named wedding_id (carried opaquely, not verified)', () => {
    const w = makeWorld()
    // A phantom wedding_id is accepted — login is not an existence oracle.
    const { principal } = w.sessions.login(w.ctx, { role: 'couple', wedding_id: 'wedding_never_created' })
    expect(principal.role).toBe('couple')
    expect(principal.wedding_id).toBe('wedding_never_created')
    expect(principal.tenant_id).toBe(w.ctx.tenant_id)
  })

  it('rejects a couple login that names no wedding_id', () => {
    const w = makeWorld()
    expect(codeOfThrow(() => w.sessions.login(w.ctx, { role: 'couple' }))).toBe('PRODUCT.BAD_REQUEST')
    expect(codeOfThrow(() => w.sessions.login(w.ctx, { role: 'couple', wedding_id: '' }))).toBe(
      'PRODUCT.BAD_REQUEST',
    )
  })

  it('drops a wedding_id supplied for a planner', () => {
    const w = makeWorld()
    const { principal } = w.sessions.login(w.ctx, { role: 'planner', wedding_id: 'wedding_x' })
    expect(principal.wedding_id).toBeUndefined()
  })

  it('resolve exchanges a token for its principal; unknown/absent token -> undefined (fail closed)', () => {
    const w = makeWorld()
    const { token, principal } = w.sessions.login(w.ctx, { role: 'planner' })
    expect(w.sessions.resolve(token)).toBe(principal)
    expect(w.sessions.resolve('not_a_real_token')).toBeUndefined()
    expect(w.sessions.resolve(undefined)).toBeUndefined()
  })

  it('the minted principal carries the brand the authorizer checks; a forged one is rejected', () => {
    const w = makeWorld()
    const { principal } = w.sessions.login(w.ctx, { role: 'planner' })
    // A real, minted principal passes.
    expect(() => assertMintedPrincipal(principal)).not.toThrow()

    // A hand-built look-alike (and a brand re-stamp attempt) is rejected — the brand is a WeakSet
    // membership token, not a reflectable own property, so there is nothing to copy.
    const forged: Record<string | symbol, unknown> = {
      tenant_id: w.ctx.tenant_id,
      role: 'planner',
      principal_id: 'principal_forged',
    }
    for (const sym of Object.getOwnPropertySymbols(principal)) {
      forged[sym] = (principal as unknown as Record<symbol, unknown>)[sym]
    }
    expect(Object.getOwnPropertySymbols(principal)).toHaveLength(0)
    expect(codeOfThrow(() => assertMintedPrincipal(forged as unknown as Principal))).toBe(
      'PRODUCT.FORGED_PRINCIPAL',
    )
  })

  it('the minted principal is frozen and the store leaks no token/principal via serialization', () => {
    const w = makeWorld()
    const { principal } = w.sessions.login(w.ctx, { role: 'couple', wedding_id: 'wedding_secret' })
    expect(Object.isFrozen(principal)).toBe(true)

    const dump = JSON.stringify(w.sessions)
    expect(dump).not.toContain('wedding_secret')
    expect(Object.getOwnPropertyNames(w.sessions)).not.toContain('byToken')
  })
})
