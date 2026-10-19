import { ManualClock, SequentialIdGenerator, sha256Hex, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  AccountStore,
  assertAcceptablePassword,
  InMemoryRecordStore,
  OneTimeTokenStore,
  PASSWORD_LIMITS,
  PasswordHasher,
  publicAccountView,
  RateLimiter,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'

/**
 * Issue #10 — the building blocks of real accounts: the scrypt hasher, the in-process rate limiter, single-use
 * emailed-link tokens, and the tenant-scoped account store.
 */

const CHEAP = { N: 16, r: 1, p: 1 }
const THEME: Tenant['theme'] = { brand_name: 'Brand', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

function world() {
  const clock = new ManualClock('2027-06-01T00:00:00.000Z')
  const backing = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), backing)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  tenants.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(tenants)
  const ids = new SequentialIdGenerator('a')
  return {
    clock,
    backing,
    ctxA: resolver.resolveBySlug('alpha'),
    ctxB: resolver.resolveBySlug('beta'),
    accounts: new AccountStore(tenants, clock, ids, backing),
    tokens: new OneTimeTokenStore(tenants, clock, ids, backing),
  }
}

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher(CHEAP, new SequentialIdGenerator('h'))

  it('stores a salted scrypt hash with its parameters, never the password', () => {
    const hash = hasher.hash('correct horse battery')
    expect(hash).toMatchObject({ algorithm: 'scrypt', N: 16, r: 1, p: 1, salt: 'salt_h_1' })
    expect(JSON.stringify(hash)).not.toContain('correct horse battery')
    expect(hasher.hash('correct horse battery').hash).not.toBe(hash.hash) // a fresh salt each time
  })

  it('verifies the right password, refuses a wrong one, and always fails for an absent hash', () => {
    const hash = hasher.hash('correct horse battery')
    expect(hasher.verify('correct horse battery', hash)).toBe(true)
    expect(hasher.verify('correct horse batterY', hash)).toBe(false)
    expect(hasher.verify('correct horse battery', undefined)).toBe(false)
  })

  it('verifies with the parameters stored on the hash, so raising the cost keeps old hashes valid', () => {
    const old = hasher.hash('an older password')
    const stronger = new PasswordHasher({ N: 32, r: 1, p: 1 }, new SequentialIdGenerator('h2'))
    expect(stronger.verify('an older password', old)).toBe(true)
    expect(stronger.needsRehash(old)).toBe(true)
    expect(stronger.needsRehash(stronger.hash('x'.repeat(12)))).toBe(false)
  })

  it('normalizes Unicode (NFKC), so the same visible password verifies however it was typed', () => {
    const hash = hasher.hash('café au lait!!')
    expect(hasher.verify('café au lait!!', hash)).toBe(true)
  })

  it('assertAcceptablePassword enforces the length bounds (PRODUCT.WEAK_PASSWORD)', () => {
    expect(codeOfThrow(() => assertAcceptablePassword('x'.repeat(PASSWORD_LIMITS.min - 1)))).toBe('PRODUCT.WEAK_PASSWORD')
    expect(codeOfThrow(() => assertAcceptablePassword('x'.repeat(PASSWORD_LIMITS.max + 1)))).toBe('PRODUCT.WEAK_PASSWORD')
    expect(codeOfThrow(() => assertAcceptablePassword('x'.repeat(PASSWORD_LIMITS.min)))).toBe('NO_THROW')
  })
})

describe('RateLimiter', () => {
  it('allows `limit` attempts per window per key, then refuses until the window rolls over', () => {
    const clock = new ManualClock('2027-06-01T00:00:00.000Z')
    const limiter = new RateLimiter(clock)
    const rule = { limit: 2, windowSeconds: 60 }
    expect([limiter.attempt('k', rule), limiter.attempt('k', rule), limiter.attempt('k', rule)]).toEqual([true, true, false])
    expect(limiter.attempt('other', rule)).toBe(true)
    clock.advance(60_000)
    expect(limiter.attempt('k', rule)).toBe(true)
  })

  it('stores keys as fixed-size digests and caps the table, evicting the oldest first', () => {
    const limiter = new RateLimiter(new ManualClock('2027-06-01T00:00:00.000Z'), 3)
    const rule = { limit: 1, windowSeconds: 60 }
    for (const key of ['a', 'b', 'c', 'x'.repeat(100_000)]) limiter.attempt(key, rule)
    expect(limiter.size()).toBe(3)
    // 'a' was evicted, so it starts fresh; 'b' is still counted.
    expect(limiter.attempt('a', rule)).toBe(true)
    expect(limiter.blocked('c', rule)).toBe(true)
  })

  it('each entry keeps its own window, whatever rule another key uses', () => {
    const clock = new ManualClock('2027-06-01T00:00:00.000Z')
    const limiter = new RateLimiter(clock)
    const hourly = { limit: 1, windowSeconds: 3600 }
    limiter.attempt('reset', hourly)
    clock.advance(16 * 60 * 1000)
    limiter.attempt('signin', { limit: 1, windowSeconds: 15 * 60 })
    expect(limiter.attempt('reset', hourly)).toBe(false)
  })

  it('blocked answers without counting; hit counts without answering (a failures-only limit)', () => {
    const limiter = new RateLimiter(new ManualClock('2027-06-01T00:00:00.000Z'))
    const rule = { limit: 2, windowSeconds: 60 }
    expect(limiter.blocked('k', rule)).toBe(false)
    expect(limiter.blocked('k', rule)).toBe(false)
    limiter.hit('k', rule)
    expect(limiter.blocked('k', rule)).toBe(false)
    limiter.hit('k', rule)
    expect(limiter.blocked('k', rule)).toBe(true)
  })

  it('reset forgets a key', () => {
    const limiter = new RateLimiter(new ManualClock('2027-06-01T00:00:00.000Z'))
    const rule = { limit: 1, windowSeconds: 60 }
    limiter.attempt('k', rule)
    expect(limiter.attempt('k', rule)).toBe(false)
    limiter.reset('k')
    expect(limiter.attempt('k', rule)).toBe(true)
  })
})

describe('OneTimeTokenStore', () => {
  it('a token works once, for its purpose and tenant only, and is stored by hash', () => {
    const w = world()
    const token = w.tokens.issue(w.ctxA, 'password_reset', 'user_1', 3600)
    const rows = w.backing.list(COLLECTIONS.oneTimeToken, w.ctxA.tenant_id)
    expect(rows.map((r) => r.token_hash)).toEqual([sha256Hex(token)])
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(w.tokens.consume(w.ctxB, 'password_reset', token)).toBeUndefined() // another tenant's partition
    expect(w.tokens.consume(w.ctxA, 'account_setup', token)).toBeUndefined() // another purpose
    expect(w.tokens.consume(w.ctxA, 'password_reset', token)).toBe('user_1')
    expect(w.tokens.consume(w.ctxA, 'password_reset', token)).toBeUndefined() // used up
  })

  it('an expired token fails; issuing again revokes the earlier token of the same purpose', () => {
    const w = world()
    const first = w.tokens.issue(w.ctxA, 'password_reset', 'user_1', 60)
    const second = w.tokens.issue(w.ctxA, 'password_reset', 'user_1', 60)
    expect(w.tokens.consume(w.ctxA, 'password_reset', first)).toBeUndefined()
    w.clock.advance(60_000)
    expect(w.tokens.consume(w.ctxA, 'password_reset', second)).toBeUndefined()
  })

  it('revoke without a purpose removes every outstanding token of the subject', () => {
    const w = world()
    const reset = w.tokens.issue(w.ctxA, 'password_reset', 'user_1', 600)
    const setup = w.tokens.issue(w.ctxA, 'account_setup', 'user_1', 600)
    const other = w.tokens.issue(w.ctxA, 'password_reset', 'user_2', 600)
    w.tokens.revoke(w.ctxA, undefined, 'user_1')
    expect(w.tokens.consume(w.ctxA, 'password_reset', reset)).toBeUndefined()
    expect(w.tokens.consume(w.ctxA, 'account_setup', setup)).toBeUndefined()
    expect(w.tokens.consume(w.ctxA, 'password_reset', other)).toBe('user_2')
  })
})

describe('AccountStore', () => {
  it('creates accounts with a normalized, per-tenant unique email', () => {
    const w = world()
    const account = w.accounts.create(w.ctxA, { email: '  Planner@Example.TEST ', role: 'planner' })
    expect(account).toMatchObject({ email: 'planner@example.test', role: 'planner', tenant_id: w.ctxA.tenant_id })
    expect(codeOfThrow(() => w.accounts.create(w.ctxA, { email: 'planner@example.test', role: 'owner' }))).toBe(
      'PRODUCT.ACCOUNT_EXISTS',
    )
    // The same email in another workspace is another person's account.
    expect(w.accounts.create(w.ctxB, { email: 'planner@example.test', role: 'owner' }).tenant_id).toBe(w.ctxB.tenant_id)
    expect(w.accounts.findByEmail(w.ctxA, 'PLANNER@example.test')?.user_id).toBe(account.user_id)
  })

  it('is tenant-isolated: another tenant reads nothing', () => {
    const w = world()
    const account = w.accounts.create(w.ctxA, { email: 'a@example.test', role: 'owner' })
    expect(w.accounts.get(w.ctxB, account.user_id)).toBeUndefined()
    expect(w.accounts.findByEmail(w.ctxB, 'a@example.test')).toBeUndefined()
    expect(w.accounts.list(w.ctxB)).toEqual([])
  })

  it('setPassword stores the hash; the public view never carries it; remove frees the email', () => {
    const w = world()
    const hasher = new PasswordHasher(CHEAP, new SequentialIdGenerator('h'))
    const account = w.accounts.create(w.ctxA, { email: 'a@example.test', role: 'owner' })
    expect(publicAccountView(account).has_password).toBe(false)
    const updated = w.accounts.setPassword(w.ctxA, account.user_id, hasher.hash('a long password'))
    expect(updated?.password_set_at).toBe('2027-06-01T00:00:00.000Z')
    const view = publicAccountView(updated as NonNullable<typeof updated>)
    expect(view.has_password).toBe(true)
    expect(Object.keys(view)).not.toContain('password')
    expect(w.accounts.remove(w.ctxA, account.user_id)).toBe(true)
    expect(w.accounts.findByEmail(w.ctxA, 'a@example.test')).toBeUndefined()
    expect(w.accounts.create(w.ctxA, { email: 'a@example.test', role: 'planner' }).role).toBe('planner')
  })
})
