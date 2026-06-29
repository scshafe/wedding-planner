import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { getSchemaRegistry, ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
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

  it('no-500-oracle drift guard (Phase 35): the schema body has NO maxLength, so an UNBOUNDED guest turn validates', () => {
    // Phase 35 DROPPED body.maxLength: the field now hosts UNTRUSTED guest input (byte-identical in constraint
    // to inbound_webhook.text — minLength:1, no max) so a long message that passed the inbound edge can never
    // fail recordGuestReply()'s assertValid (no 500 oracle / no swallowed capture). The operator cost cap moved
    // entirely to the handler — see the api test that an over-cap reply_text 400s (the SOLE surviving cap).
    const schemaPath = fileURLToPath(new URL('../../schemas/escalation_reply_schema.json', import.meta.url))
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as { properties: { body: { maxLength?: number } } }
    expect(schema.properties.body.maxLength).toBeUndefined()
    const w = makeWorld()
    // A guest turn far longer than the operator cap stores without throwing (the inbound edge let it through).
    const huge = 'x'.repeat(REPLY_BODY_MAX_LENGTH * 3)
    const rec = w.log.recordGuestReply(w.ctxA, { escalation_id: 'e_big', wedding_id: 'wed_1', provider_message_ref: 'pmr_big', body: huge })
    expect(rec.body).toHaveLength(REPLY_BODY_MAX_LENGTH * 3)
    expect(rec.sender).toBe('guest')
  })

  describe('recordGuestReply — inbound guest turns (Phase 35)', () => {
    it('appends a guest turn at the next slot with sender:guest + the provider ref stored', () => {
      const w = makeWorld()
      w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'op turn' })
      const rec = w.log.recordGuestReply(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', provider_message_ref: 'pmr_g1', body: 'guest follow-up' })
      expect(rec).toMatchObject({ escalation_id: 'e1', wedding_id: 'wed_1', seq: 1, sender: 'guest', body: 'guest follow-up', provider_message_ref: 'pmr_g1' })
      expect(rec.reply_id).toMatch(/reply/)
      expect(w.log.list(w.ctxA)).toHaveLength(2)
    })

    it('IDEMPOTENT by provider_message_ref: a re-delivery (same ref) returns the existing turn (one row)', () => {
      const w = makeWorld()
      const first = w.log.recordGuestReply(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', provider_message_ref: 'pmr_g1', body: 'hi' })
      const again = w.log.recordGuestReply(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', provider_message_ref: 'pmr_g1', body: 'hi again' })
      expect(again).toEqual(first) // stable reply_id/seq; the SECOND body is ignored (the ref already landed)
      expect(w.log.list(w.ctxA)).toHaveLength(1)
    })

    it('two DISTINCT guest refs take consecutive seqs (the ref decides identity, the slot is allocated above max)', () => {
      const w = makeWorld()
      const a = w.log.recordGuestReply(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', provider_message_ref: 'pmr_a', body: 'a' })
      const b = w.log.recordGuestReply(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', provider_message_ref: 'pmr_b', body: 'b' })
      expect([a.seq, b.seq]).toEqual([0, 1])
    })

    it('P1 REGRESSION: a forged/sparse operator seq (a GAP) followed by a guest reply lands ABOVE max — overwrites/drops nothing', () => {
      const w = makeWorld()
      // An operator POSTs a forged far-future seq (allowed: parseSeq accepts any non-neg int) → a gap at 1..98.
      w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'first' })
      w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 99, sender: 'planner', body: 'forged gap' })
      // thread.length === 2, but slot 2 is FREE; max seq is 99. A naive seq=length would NOT collide here, but
      // the real danger is when length lands ON an occupied slot — so assert the guest turn allocates above MAX.
      const g = w.log.recordGuestReply(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', provider_message_ref: 'pmr_g', body: 'guest' })
      expect(g.seq).toBe(100) // max(0,99)+1 — never thread.length (2), which a forged operator could occupy
      // The forged operator turn at slot 99 is intact (not overwritten); the guest turn is its own row.
      const thread = w.log.list(w.ctxA).filter((r) => r.escalation_id === 'e1')
      expect(thread.find((r) => r.seq === 99)?.body).toBe('forged gap')
      expect(thread).toHaveLength(3)
    })

    it('guestTurnByProviderRef: the re-delivery guard finds a guest turn across ANY escalation, not operator turns', () => {
      const w = makeWorld()
      w.log.append(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sender: 'planner', body: 'op' }) // no ref
      w.log.recordGuestReply(w.ctxA, { escalation_id: 'e2', wedding_id: 'wed_2', provider_message_ref: 'pmr_x', body: 'g' })
      expect(w.log.guestTurnByProviderRef(w.ctxA, 'pmr_x')?.escalation_id).toBe('e2')
      expect(w.log.guestTurnByProviderRef(w.ctxA, 'pmr_absent')).toBeUndefined()
      // cross-tenant: tenant B never sees tenant A's guest turn (partition keyed by context alone)
      expect(w.log.guestTurnByProviderRef(w.ctxB, 'pmr_x')).toBeUndefined()
    })

    it('contract allOf: provider_message_ref is REQUIRED on a guest turn and FORBIDDEN on an operator turn', () => {
      const registry = getSchemaRegistry()
      const base = { reply_id: 'r1', tenant_id: 't1', escalation_id: 'e1', wedding_id: 'wed_1', seq: 0, sent_at: '2027-03-01T00:00:00.000Z' }
      // guest WITH ref → valid; guest WITHOUT ref → invalid (the dedup key is mandatory)
      expect(() => registry.assertValid('escalation_reply', { ...base, sender: 'guest', body: 'g', provider_message_ref: 'pmr' })).not.toThrow()
      expect(() => registry.assertValid('escalation_reply', { ...base, sender: 'guest', body: 'g' })).toThrow()
      // operator WITHOUT ref → valid; operator WITH a smuggled ref → invalid (the else-forbid clause)
      expect(() => registry.assertValid('escalation_reply', { ...base, sender: 'planner', body: 'o' })).not.toThrow()
      expect(() => registry.assertValid('escalation_reply', { ...base, sender: 'couple', body: 'o', provider_message_ref: 'pmr' })).toThrow()
    })

    it('fails closed on a suspended tenant: recordGuestReply + guestTurnByProviderRef run the liveness guard', () => {
      const w = makeWorld()
      w.log.recordGuestReply(w.ctxA, { escalation_id: 'e1', wedding_id: 'wed_1', provider_message_ref: 'pmr_g', body: 'hi' })
      w.store.setLifecycleStatus(w.ctxA.tenant_id, 'suspended')
      const input = { escalation_id: 'e1', wedding_id: 'wed_1', provider_message_ref: 'pmr_h', body: 'x' } as const
      expect(codeOfThrow(() => w.log.recordGuestReply(w.ctxA, input))).toMatch(/TENANT/)
      expect(codeOfThrow(() => w.log.guestTurnByProviderRef(w.ctxA, 'pmr_g'))).toMatch(/TENANT/)
    })
  })
})
