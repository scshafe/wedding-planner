import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { CHANNELS, type Channel, MESSAGE_COST_CENTS } from '@wedding-planner/shared'

import {
  BillingLedger,
  buildBillingSummary,
  MESSAGE_PRICE_CENTS,
  MONTHLY_PRICE_CENTS,
  messagePriceCents,
  monthlyPriceCents,
  SIMULATED_PROVIDER_COST_CENTS,
  type PlanTier,
} from '@wedding-planner/product'

const TIERS: readonly PlanTier[] = ['solo', 'studio', 'agency']

function newLedger(): BillingLedger {
  return new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))
}

describe('price_book', () => {
  it('maps every plan tier to an integer-cents price (total over the enum)', () => {
    const tiers: readonly PlanTier[] = ['solo', 'studio', 'agency']
    for (const tier of tiers) {
      const price = monthlyPriceCents(tier)
      expect(Number.isInteger(price)).toBe(true)
      expect(price).toBeGreaterThan(0)
      expect(price).toBe(MONTHLY_PRICE_CENTS[tier])
    }
  })

  it('prices are strictly increasing solo < studio < agency', () => {
    expect(monthlyPriceCents('solo')).toBeLessThan(monthlyPriceCents('studio'))
    expect(monthlyPriceCents('studio')).toBeLessThan(monthlyPriceCents('agency'))
  })

  it('rejects a tier outside the enum (defensive guard against a stale cast)', () => {
    expect(() => monthlyPriceCents('enterprise' as PlanTier)).toThrow(/Unknown plan_tier/)
  })

  it('messagePriceCents is an integer-cents price total over Channel × PlanTier', () => {
    for (const channel of CHANNELS) {
      for (const tier of TIERS) {
        const price = messagePriceCents(channel, tier)
        expect(Number.isInteger(price)).toBe(true)
        expect(price).toBeGreaterThan(0)
        expect(price).toBe(MESSAGE_PRICE_CENTS[channel][tier])
      }
    }
  })

  it('every tenant message price strictly exceeds the simulated provider COGS (the margin clears the happy path)', () => {
    for (const channel of CHANNELS) {
      for (const tier of TIERS) {
        expect(messagePriceCents(channel, tier)).toBeGreaterThan(SIMULATED_PROVIDER_COST_CENTS[channel])
      }
    }
  })

  it('every retail message price strictly exceeds the shared inward cost basis (cross-table margin guard)', () => {
    // Phase 20 (SF7): the inward North-Star cost basis (`MESSAGE_COST_CENTS`, shared) and this RETAIL table
    // are deliberately kept separate (the eval/loop firewall forbids importing the product price book). They
    // must not silently diverge below the margin invariant — the product would be billing under its own
    // modeled cost. Product MAY import both (only eval→product is forbidden), so we pin the relationship here.
    for (const channel of CHANNELS) {
      for (const tier of TIERS) {
        expect(
          messagePriceCents(channel, tier),
          `retail ${channel}/${tier} must exceed the shared cost basis`,
        ).toBeGreaterThan(MESSAGE_COST_CENTS[channel])
      }
    }
  })

  it('higher tiers pay less per message (a volume discount → plan_tier genuinely moves the price)', () => {
    for (const channel of CHANNELS) {
      expect(messagePriceCents(channel, 'agency')).toBeLessThanOrEqual(messagePriceCents(channel, 'studio'))
      expect(messagePriceCents(channel, 'studio')).toBeLessThanOrEqual(messagePriceCents(channel, 'solo'))
    }
  })

  it('rejects an unknown channel/tier (defensive guard against a stale cast)', () => {
    expect(() => messagePriceCents('carrier_pigeon' as Channel, 'solo')).toThrow(/No message price/)
    expect(() => messagePriceCents('sms', 'enterprise' as PlanTier)).toThrow(/No message price/)
  })
})

describe('BillingLedger', () => {
  it('records events in order with injected id + occurred_at', () => {
    const ledger = newLedger()
    ledger.record({ tenant_id: 'tnt_1', kind: 'provisioned' })
    ledger.record({ tenant_id: 'tnt_1', kind: 'charge', amount_cents: 9900 })
    const events = ledger.eventsFor('tnt_1')
    expect(events.map((e) => e.kind)).toEqual(['provisioned', 'charge'])
    expect(events[0]?.occurred_at).toBe('2027-03-01T00:00:00.000Z')
    expect(events[0]?.event_id).not.toBe(events[1]?.event_id)
  })

  it('attaches amount_cents only to financial kinds; marker kinds carry no money key', () => {
    const ledger = newLedger()
    const marker = ledger.record({ tenant_id: 'tnt_1', kind: 'provisioned' })
    const charge = ledger.record({ tenant_id: 'tnt_1', kind: 'charge', amount_cents: 2900 })
    expect('amount_cents' in marker).toBe(false)
    expect(charge.amount_cents).toBe(2900)
  })

  it('rejects a financial kind without an amount, and a marker kind with one', () => {
    const ledger = newLedger()
    expect(() => ledger.record({ tenant_id: 'tnt_1', kind: 'payment' })).toThrow(/requires amount_cents/)
    expect(() => ledger.record({ tenant_id: 'tnt_1', kind: 'suspended', amount_cents: 1 })).toThrow(
      /must not carry amount_cents/,
    )
  })

  it('folds the balance as Σcharge − Σpayment over financial kinds only (positive = owed)', () => {
    const ledger = newLedger()
    ledger.record({ tenant_id: 'tnt_1', kind: 'provisioned' })
    ledger.record({ tenant_id: 'tnt_1', kind: 'charge', amount_cents: 9900 })
    expect(ledger.balanceCents('tnt_1')).toBe(9900) // owed
    ledger.record({ tenant_id: 'tnt_1', kind: 'payment', amount_cents: 9900 })
    expect(ledger.balanceCents('tnt_1')).toBe(0) // settled
    ledger.record({ tenant_id: 'tnt_1', kind: 'suspended' }) // marker — never moves the balance
    expect(ledger.balanceCents('tnt_1')).toBe(0)
  })

  it('usage_charge round-trips as a financial kind AND moves the owed balance (FINANCIAL_KINDS/fold in sync)', () => {
    const ledger = newLedger()
    const usage = ledger.record({ tenant_id: 'tnt_1', kind: 'usage_charge', amount_cents: 5 })
    // Persisted with amount_cents (passes the per-kind contract allOf, which now includes usage_charge).
    expect(usage.kind).toBe('usage_charge')
    expect(usage.amount_cents).toBe(5)
    // Folds as a debit, exactly like charge — the balance moves by the billed amount.
    expect(ledger.balanceCents('tnt_1')).toBe(5)
    ledger.record({ tenant_id: 'tnt_1', kind: 'usage_charge', amount_cents: 6 })
    expect(ledger.balanceCents('tnt_1')).toBe(11) // accrues; not auto-settled
  })

  it('rejects a usage_charge without amount_cents (reverse guard — the financial rule holds for the new kind)', () => {
    const ledger = newLedger()
    expect(() => ledger.record({ tenant_id: 'tnt_1', kind: 'usage_charge' })).toThrow(/requires amount_cents/)
  })

  it('partitions strictly by tenant — one tenant never sees another tenant\'s events or balance', () => {
    const ledger = newLedger()
    ledger.record({ tenant_id: 'tnt_a', kind: 'charge', amount_cents: 2900 })
    ledger.record({ tenant_id: 'tnt_b', kind: 'charge', amount_cents: 29900 })
    expect(ledger.eventsFor('tnt_a').map((e) => e.amount_cents)).toEqual([2900])
    expect(ledger.eventsFor('tnt_b').map((e) => e.amount_cents)).toEqual([29900])
    expect(ledger.balanceCents('tnt_a')).toBe(2900)
    expect(ledger.eventsFor('tnt_unknown')).toEqual([])
    expect(ledger.balanceCents('tnt_unknown')).toBe(0)
  })

  it('does not leak its events via JSON.stringify (the backing map is #-private)', () => {
    const ledger = newLedger()
    ledger.record({ tenant_id: 'tnt_1', kind: 'charge', amount_cents: 2900 })
    expect(JSON.stringify(ledger)).not.toContain('tnt_1')
    expect(JSON.stringify(ledger)).not.toContain('2900')
  })

  it('returns a defensive copy from eventsFor (mutating it does not corrupt the ledger)', () => {
    const ledger = newLedger()
    ledger.record({ tenant_id: 'tnt_1', kind: 'provisioned' })
    const copy = ledger.eventsFor('tnt_1') as unknown[]
    copy.push({ forged: true })
    expect(ledger.eventsFor('tnt_1')).toHaveLength(1)
  })

  describe('summarize (Phase 30 — the planner usage fold)', () => {
    it('folds an empty tenant to all zeros', () => {
      const ledger = newLedger()
      expect(ledger.summarize('tnt_unknown')).toEqual({
        messages_sent: 0,
        messaging_spend_cents: 0,
        subscription_charges_cents: 0,
        payments_cents: 0,
        balance_cents: 0,
      })
    })

    it('counts usage_charge events, sums each financial kind, and excludes markers', () => {
      const ledger = newLedger()
      ledger.record({ tenant_id: 'tnt_1', kind: 'provisioned' }) // marker — contributes nothing
      ledger.record({ tenant_id: 'tnt_1', kind: 'charge', amount_cents: 9900 })
      ledger.record({ tenant_id: 'tnt_1', kind: 'payment', amount_cents: 9900 })
      ledger.record({ tenant_id: 'tnt_1', kind: 'usage_charge', amount_cents: 5 })
      ledger.record({ tenant_id: 'tnt_1', kind: 'usage_charge', amount_cents: 6 })
      ledger.record({ tenant_id: 'tnt_1', kind: 'suspended' }) // marker — contributes nothing
      expect(ledger.summarize('tnt_1')).toEqual({
        messages_sent: 2,
        messaging_spend_cents: 11,
        subscription_charges_cents: 9900,
        payments_cents: 9900,
        balance_cents: 11, // 9900 + 11 − 9900
      })
    })

    it('DRIFT GUARD: the breakdown reconciles to the untouched canonical balanceCents fold', () => {
      const ledger = newLedger()
      ledger.record({ tenant_id: 'tnt_1', kind: 'charge', amount_cents: 29900 })
      ledger.record({ tenant_id: 'tnt_1', kind: 'usage_charge', amount_cents: 4 })
      ledger.record({ tenant_id: 'tnt_1', kind: 'usage_charge', amount_cents: 4 })
      ledger.record({ tenant_id: 'tnt_1', kind: 'payment', amount_cents: 29900 })
      const s = ledger.summarize('tnt_1')
      // RHS is the canonical fold (the single source of truth) — catches any future divergence in summarize.
      expect(s.subscription_charges_cents + s.messaging_spend_cents - s.payments_cents).toBe(
        ledger.balanceCents('tnt_1'),
      )
      expect(s.balance_cents).toBe(ledger.balanceCents('tnt_1'))
    })

    it('partitions strictly by tenant (never folds another tenant\'s events)', () => {
      const ledger = newLedger()
      ledger.record({ tenant_id: 'tnt_a', kind: 'usage_charge', amount_cents: 6 })
      ledger.record({ tenant_id: 'tnt_b', kind: 'usage_charge', amount_cents: 95 })
      expect(ledger.summarize('tnt_a').messaging_spend_cents).toBe(6)
      expect(ledger.summarize('tnt_a').messages_sent).toBe(1)
      expect(ledger.summarize('tnt_b').messaging_spend_cents).toBe(95)
    })
  })

  describe('buildBillingSummary (Phase 30 — the price-book join)', () => {
    it('joins the trusted plan tier (priced by the SAME monthlyPriceCents) onto a ledger fold', () => {
      const ledger = newLedger()
      ledger.record({ tenant_id: 'tnt_1', kind: 'charge', amount_cents: 9900 })
      ledger.record({ tenant_id: 'tnt_1', kind: 'usage_charge', amount_cents: 5 })
      const summary = buildBillingSummary('studio', ledger.summarize('tnt_1'))
      expect(summary.plan_tier).toBe('studio')
      expect(summary.monthly_price_cents).toBe(monthlyPriceCents('studio'))
      expect(summary.messages_sent).toBe(1)
      expect(summary.messaging_spend_cents).toBe(5)
      expect(summary.balance_cents).toBe(ledger.balanceCents('tnt_1'))
    })

    it('exposes NO provider COGS / per-message price / margin term', () => {
      const summary = buildBillingSummary('solo', newLedger().summarize('tnt_x'))
      const keys = Object.keys(summary).sort()
      expect(keys).toEqual(
        [
          'balance_cents',
          'messages_sent',
          'messaging_spend_cents',
          'monthly_price_cents',
          'payments_cents',
          'plan_tier',
          'subscription_charges_cents',
        ].sort(),
      )
    })
  })
})
