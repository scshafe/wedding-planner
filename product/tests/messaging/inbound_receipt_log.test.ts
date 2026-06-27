import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  InboundReceiptLog,
  type TenantContext,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Phase 19 Step 4 — the reply-cardinality firewall component (doddy P0/P1), unit-pinned independently of the
 * inbound keystone: `seen` is per-tenant, `mintReplyId` is platform-minted (never the provider ref), and a ref
 * is only `seen` AFTER `markReplied` (commit-after-success — so a never-committed ref stays retryable).
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

interface World {
  log: InboundReceiptLog
  ctxA: TenantContext
  ctxB: TenantContext
}

function makeWorld(): World {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  return {
    log: new InboundReceiptLog(store, new SequentialIdGenerator('seedIR')),
    ctxA: resolver.resolveBySlug('alpha'),
    ctxB: resolver.resolveBySlug('beta'),
  }
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    return (error as { code?: string }).code ?? `NON_CODED:${String(error)}`
  }
  return 'NO_THROW'
}

describe('InboundReceiptLog', () => {
  it('a ref is NOT seen until markReplied (commit-after-success keeps a failed send retryable)', () => {
    const w = makeWorld()
    expect(w.log.seen(w.ctxA, 'pmr_1')).toBe(false)
    // Minting a reply id does NOT mark the ref — it stays un-seen until the send succeeds.
    const replyId = w.log.mintReplyId()
    expect(w.log.seen(w.ctxA, 'pmr_1')).toBe(false)
    w.log.markReplied(w.ctxA, 'pmr_1', replyId)
    expect(w.log.seen(w.ctxA, 'pmr_1')).toBe(true)
  })

  it('mintReplyId is platform-minted (an injected-id shape, never the provider ref) and unique per call', () => {
    const w = makeWorld()
    const a = w.log.mintReplyId()
    const b = w.log.mintReplyId()
    expect(a).toMatch(/inbound/)
    expect(a).not.toBe(b)
  })

  it('seen is per-tenant: a ref replied on A is not seen on B (no cross-tenant receipt oracle)', () => {
    const w = makeWorld()
    w.log.markReplied(w.ctxA, 'pmr_shared', w.log.mintReplyId())
    expect(w.log.seen(w.ctxA, 'pmr_shared')).toBe(true)
    expect(w.log.seen(w.ctxB, 'pmr_shared')).toBe(false)
  })

  it('rejects a forged (un-minted) context at seen AND markReplied (inherited brand gate)', () => {
    const w = makeWorld()
    const forged = { tenant_id: 'alpha', lifecycle_status: 'active' } as unknown as TenantContext
    expect(codeOfThrow(() => w.log.seen(forged, 'pmr_1'))).toBe('PRODUCT.FORGED_CONTEXT')
    expect(codeOfThrow(() => w.log.markReplied(forged, 'pmr_1', 'rid'))).toBe('PRODUCT.FORGED_CONTEXT')
  })

  it('does not enumerate/serialize its receipts (the backing partition is #-private)', () => {
    const w = makeWorld()
    w.log.markReplied(w.ctxA, 'pmr_secret', w.log.mintReplyId())
    expect(JSON.stringify(w.log)).not.toContain('pmr_secret')
  })
})
