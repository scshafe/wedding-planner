import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  constantTimeEqual,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  type TenantContext,
} from '@wedding-planner/product'

/**
 * Phase 21 Step 5 — the CSRF guard. SessionStore mints a per-session CSRF token DISTINCT from the session
 * token, issues it for embedding, and verifies it fail-closed + constant-time. The session↔Bearer binding
 * invariant (verify with the same token you forward as Bearer) is exercised by the cross-session test.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

function makeContext(): TenantContext {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  return new TenantContextResolver(store).resolveBySlug('alpha')
}

describe('constantTimeEqual', () => {
  it('is true only for identical strings; length differences fold in (no early return)', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
    expect(constantTimeEqual('abc', 'ab')).toBe(false)
    expect(constantTimeEqual('ab', 'abc')).toBe(false)
    expect(constantTimeEqual('', '')).toBe(true)
  })
})

describe('SessionStore CSRF guard', () => {
  it('mints a CSRF token DISTINCT from the session token and issues it', () => {
    const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
    const session = sessions.login(makeContext(), { role: 'planner' })
    expect(session.csrf_token).toBeTruthy()
    expect(session.csrf_token).not.toBe(session.token)
    expect(sessions.issueCsrf(session.token)).toBe(session.csrf_token)
  })

  it('verifies the bound token and fails closed on wrong/empty/absent candidates', () => {
    const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
    const session = sessions.login(makeContext(), { role: 'planner' })
    expect(sessions.verifyCsrf(session.token, session.csrf_token)).toBe(true)
    expect(sessions.verifyCsrf(session.token, 'wrong')).toBe(false)
    expect(sessions.verifyCsrf(session.token, '')).toBe(false)
    expect(sessions.verifyCsrf(session.token, undefined)).toBe(false)
  })

  it('fails closed for an unknown/absent session (no token issued)', () => {
    const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
    expect(sessions.issueCsrf('never-logged-in')).toBeUndefined()
    expect(sessions.issueCsrf(undefined)).toBeUndefined()
    expect(sessions.verifyCsrf('never-logged-in', 'anything')).toBe(false)
    expect(sessions.verifyCsrf(undefined, 'anything')).toBe(false)
  })

  it("rejects another session's CSRF token (the token is bound to one session)", () => {
    const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
    const ctx = makeContext()
    const a = sessions.login(ctx, { role: 'planner' })
    const b = sessions.login(ctx, { role: 'planner' })
    expect(a.csrf_token).not.toBe(b.csrf_token)
    // session A's cookie presenting session B's CSRF token -> rejected.
    expect(sessions.verifyCsrf(a.token, b.csrf_token)).toBe(false)
    expect(sessions.verifyCsrf(b.token, b.csrf_token)).toBe(true)
  })
})
