import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { BillingLedger, buildBillingActivity, type BillingActivityEntry } from '@wedding-planner/product'

const TENANT = 'tenant-act'

function newLedger(): BillingLedger {
  return new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedAct'))
}

describe('buildBillingActivity', () => {
  it('projects a financial event to exactly { kind, amount_cents, occurred_at } — drops event_id/tenant_id', () => {
    const ledger = newLedger()
    ledger.record({ tenant_id: TENANT, kind: 'charge', amount_cents: 4900 })
    const [entry] = buildBillingActivity(ledger.eventsFor(TENANT))
    expect(entry).toBeDefined()
    // Key-set pin: NO event_id, NO tenant_id, NO stray key — exactly the three projected fields.
    expect(Object.keys(entry as BillingActivityEntry).sort()).toEqual(['amount_cents', 'kind', 'occurred_at'])
    expect(entry).toEqual({ kind: 'charge', amount_cents: 4900, occurred_at: '2027-03-01T00:00:00.000Z' })
  })

  it('DROPS lifecycle markers (provisioned / suspended / reactivated) — financial kinds only', () => {
    const ledger = newLedger()
    ledger.record({ tenant_id: TENANT, kind: 'provisioned' })
    ledger.record({ tenant_id: TENANT, kind: 'charge', amount_cents: 4900 })
    ledger.record({ tenant_id: TENANT, kind: 'suspended' })
    ledger.record({ tenant_id: TENANT, kind: 'reactivated' })
    ledger.record({ tenant_id: TENANT, kind: 'usage_charge', amount_cents: 7 })
    const activity = buildBillingActivity(ledger.eventsFor(TENANT))
    // Only the two financial events survive; not a single marker leaks (no suspended/reactivated delinquency row).
    expect(activity.map((e) => e.kind)).toEqual(['usage_charge', 'charge'])
  })

  it('returns the list NEWEST-FIRST (reverse of record order, not a timestamp sort)', () => {
    const ledger = newLedger()
    ledger.record({ tenant_id: TENANT, kind: 'charge', amount_cents: 100 }) // oldest
    ledger.record({ tenant_id: TENANT, kind: 'usage_charge', amount_cents: 5 })
    ledger.record({ tenant_id: TENANT, kind: 'payment', amount_cents: 105 }) // newest
    const activity = buildBillingActivity(ledger.eventsFor(TENANT))
    expect(activity.map((e) => e.kind)).toEqual(['payment', 'usage_charge', 'charge'])
    expect(activity.map((e) => e.amount_cents)).toEqual([105, 5, 100])
  })

  it('is empty for a tenant with no events', () => {
    expect(buildBillingActivity(newLedger().eventsFor('nobody'))).toEqual([])
    expect(buildBillingActivity([])).toEqual([])
  })

  it('does not mutate the input array (copy-then-reverse)', () => {
    const ledger = newLedger()
    ledger.record({ tenant_id: TENANT, kind: 'charge', amount_cents: 100 })
    ledger.record({ tenant_id: TENANT, kind: 'payment', amount_cents: 40 })
    const events = ledger.eventsFor(TENANT)
    const before = events.map((e) => e.kind)
    buildBillingActivity(events)
    expect(events.map((e) => e.kind)).toEqual(before) // input order unchanged
  })

  it('reconciles EXACTLY with summarize (the itemized log decomposes the same totals)', () => {
    const ledger = newLedger()
    // A mixed ledger: markers + multiple of each financial kind.
    ledger.record({ tenant_id: TENANT, kind: 'provisioned' })
    ledger.record({ tenant_id: TENANT, kind: 'charge', amount_cents: 4900 })
    ledger.record({ tenant_id: TENANT, kind: 'charge', amount_cents: 4900 })
    ledger.record({ tenant_id: TENANT, kind: 'usage_charge', amount_cents: 7 })
    ledger.record({ tenant_id: TENANT, kind: 'usage_charge', amount_cents: 9 })
    ledger.record({ tenant_id: TENANT, kind: 'usage_charge', amount_cents: 11 })
    ledger.record({ tenant_id: TENANT, kind: 'payment', amount_cents: 4900 })

    const summary = ledger.summarize(TENANT)
    const activity = buildBillingActivity(ledger.eventsFor(TENANT))
    const sumOf = (kind: BillingActivityEntry['kind']): number =>
      activity.filter((e) => e.kind === kind).reduce((acc, e) => acc + e.amount_cents, 0)
    const countOf = (kind: BillingActivityEntry['kind']): number => activity.filter((e) => e.kind === kind).length

    expect(sumOf('charge')).toBe(summary.subscription_charges_cents)
    expect(sumOf('usage_charge')).toBe(summary.messaging_spend_cents)
    expect(sumOf('payment')).toBe(summary.payments_cents)
    expect(countOf('usage_charge')).toBe(summary.messages_sent)
    // Σ(debits) − Σ(payments) reconstructs the owed balance the summary reports.
    expect(sumOf('charge') + sumOf('usage_charge') - sumOf('payment')).toBe(summary.balance_cents)
  })
})
