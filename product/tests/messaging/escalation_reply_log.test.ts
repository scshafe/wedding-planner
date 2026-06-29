import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  EscalationReplyLog,
  REPLY_BODY_MAX_LENGTH,
  type TenantContext,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Phase 34 — the escalation-REPLY log holds the per-escalation multi-turn THREAD. It mirrors the resolution
 * log's isolation but is keyed by the COMPOSITE `(escalation_id, seq)` so one escalation holds many replies, and
 * `append` is read-first-put-if-absent on that slot (the double-submit guard). The couple slice filters by
 * wedding_id; cross-tenant isolation + liveness are inherited from TenantScopedRepository.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'a' }

interface World {
  log: EscalationReplyLog
  store: TenantStore
  ctxA: TenantContext
  ctxB: TenantContext
}

function makeWorld(): World {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const store = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
  const log = new EscalationReplyLog(store, new SequentialIdGenerator('seedRep'), clock)
  return { log, store, ctxA: resolver.resolveBySlug('alpha'), ctxB: resolver.resolveBySlug('beta') }
}

function codeOfThrow(fn: () => unknown): string {
  try {
    fn()
    return 'NO_THROW'
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE'
  }
}

describe('escalation reply log (Phase 34)', () => {
  it('appends a reply, stamps reply_id/sent_at, and reads it back on the thread', () => {
    const w = makeWorld()
    const rec = w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'hello' })
    expect(rec).toMatchObject({ escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'hello', tenant_id: w.ctxA.tenant_id })
    expect(rec.reply_id).toMatch(/reply/)
    expect(rec.sent_at).toBe('2027-03-01T00:00:00.000Z')
    expect(w.log.list(w.ctxA)).toEqual([rec])
  })

  it('IDEMPOTENT by (escalation_id, seq): a re-append of the SAME slot returns the EXISTING reply (no duplicate)', () => {
    const w = makeWorld()
    const first = w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'first' })
    // A re-append at the same slot returns the first record verbatim, even with a different body — the SLOT wins.
    const again = w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'couple', body: 'second' })
    expect(again).toEqual(first)
    expect(w.log.list(w.ctxA)).toHaveLength(1)
  })

  it('readSlot returns the occupant of (escalation_id, seq) or undefined for a free slot', () => {
    const w = makeWorld()
    expect(w.log.readSlot(w.ctxA, 'e1', 0)).toBeUndefined()
    const rec = w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'hi' })
    expect(w.log.readSlot(w.ctxA, 'e1', 0)).toEqual(rec)
    expect(w.log.readSlot(w.ctxA, 'e1', 1)).toBeUndefined() // a different seq is a different slot
  })

  it('different seqs build a thread; a forged far-future seq just leaves a (harmless) gap', () => {
    const w = makeWorld()
    w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'a' })
    w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 1, sender: 'planner', body: 'b' })
    w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 99, sender: 'planner', body: 'gap' })
    const thread = w.log.list(w.ctxA).filter((r) => r.escalation_id === 'e1')
    expect(thread).toHaveLength(3)
    // The next legit append computes seq = thread.length (3 here) → it never collides with the seq-99 gap.
    expect(w.log.readSlot(w.ctxA, 'e1', 3)).toBeUndefined()
  })

  it('couple slice: listForWedding filters by wedding_id; a couple never sees a SIBLING wedding thread', () => {
    const w = makeWorld()
    w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'mine' })
    w.log.append(w.ctxA, { escalation_id: 'e2', wedding_id: 'wed_2', seq: 0, sender: 'planner', body: 'sibling' })
    expect(w.log.listForWedding(w.ctxA, 'wed_1').map((r) => r.body)).toEqual(['mine'])
    expect(w.log.listForWedding(w.ctxA, 'wed_2').map((r) => r.body)).toEqual(['sibling'])
    expect(w.log.listForWedding(w.ctxA, undefined)).toEqual([]) // an unbound couple sees nothing
  })

  it('cross-tenant isolation: another tenant never sees these replies (partition keyed by context alone)', () => {
    const w = makeWorld()
    w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'A only' })
    expect(w.log.list(w.ctxB)).toEqual([])
    expect(w.log.listForWedding(w.ctxB, 'wed_1')).toEqual([])
    expect(w.log.readSlot(w.ctxB, 'e1', 0)).toBeUndefined()
  })

  it('fails closed on a suspended tenant: every op runs the inherited liveness guard', () => {
    const w = makeWorld()
    w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'hi' })
    w.store.setLifecycleStatus(w.ctxA.tenant_id, 'suspended')
    const input = { escalation_id: 'e2', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'x' } as const
    expect(codeOfThrow(() => w.log.append(w.ctxA, input))).toMatch(/TENANT/)
    expect(codeOfThrow(() => w.log.list(w.ctxA))).toMatch(/TENANT/)
    expect(codeOfThrow(() => w.log.readSlot(w.ctxA, 'e1', 0))).toMatch(/TENANT/)
  })

  it('no-500-oracle drift guard: the handler cap EQUALS the schema body maxLength, and a max-length reply validates', () => {
    // The two `2000`s (REPLY_BODY_MAX_LENGTH and the schema maxLength) are separately edited — pin them equal,
    // else a future bump to one re-opens the oracle the byte-identity argument closes (a reply that passed the
    // handler must never fail append()'s assertValid). This guard MOVED here from the resolution log (Phase 34).
    const schemaPath = fileURLToPath(new URL('../../schemas/escalation_reply_schema.json', import.meta.url))
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { properties: { body: { maxLength: number } } }
    expect(schema.properties.body.maxLength).toBe(REPLY_BODY_MAX_LENGTH)
    const w = makeWorld()
    const atCap = 'x'.repeat(REPLY_BODY_MAX_LENGTH)
    const rec = w.log.append(w.ctxA, { escalation_id: 'e_cap', wedding_id: 'wed_1', seq: 0, sender: 'couple', body: atCap })
    expect(rec.body).toHaveLength(REPLY_BODY_MAX_LENGTH)
  })
})
