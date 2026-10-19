import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, InMemoryRecordStore } from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { GLOBAL_PARTITION } from '../../src/persistence/record_store'

/**
 * Issue #10: the simulated role picker belongs to the tenant the demo seed CREATED (a recorded platform setting),
 * not to whatever tenant holds the demo slug; a database seeded before the setting existed adopts its seeded demo
 * tenant once, by the seed's exact fingerprint.
 */

const OP = 'marker-operator-token-0123456789'

function compose(store: InMemoryRecordStore, seed: string, seedDemo = true) {
  return composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator(seed),
    operatorToken: OP,
    providerWebhookToken: 'marker-webhook-token-0123456789',
    demoSlug: 'demo',
    seedDemo,
    store,
    passwordCost: { N: 16, r: 1, p: 1 },
  })
}

const picker = (slug: string): ApiRequest => ({
  method: 'POST',
  path: `/t/${slug}/sessions`,
  headers: {},
  rawBody: JSON.stringify({ role: 'planner' }),
})

describe('the demo tenant marker', () => {
  it('the seed records its tenant; the picker works there and survives a restart', () => {
    const store = new InMemoryRecordStore()
    const first = compose(store, 'a')
    expect(store.get(COLLECTIONS.platformSetting, GLOBAL_PARTITION, 'demo_tenant')?.value).toBe(first.demo?.tenantId)
    const second = compose(store, 'b')
    expect(second.api.handle(picker('demo')).status).toBe(201)
  })

  it('a pre-marker database adopts its seeded demo tenant once', () => {
    const store = new InMemoryRecordStore()
    compose(store, 'a')
    store.delete(COLLECTIONS.platformSetting, GLOBAL_PARTITION, 'demo_tenant')
    const restarted = compose(store, 'b')
    expect(restarted.api.handle(picker('demo')).status).toBe(201)
  })

  it('a real tenant that happens to hold the demo slug never gets the picker', () => {
    const store = new InMemoryRecordStore()
    const real = compose(store, 'a', false)
    const theme = { brand_name: 'Real', primary_color_hex: '#123456', accent_color_hex: '#654321', logo_ref: 'r' }
    const created = real.api.handle({
      method: 'POST',
      path: '/admin/tenants',
      headers: { authorization: `Bearer ${OP}` },
      rawBody: JSON.stringify({ slug: 'demo', display_name: 'A Real Studio', plan_tier: 'solo', theme }),
    })
    const id = (created.body as { tenant: { tenant_id: string } }).tenant.tenant_id
    real.api.handle({ method: 'POST', path: `/admin/tenants/${id}/activate`, headers: { authorization: `Bearer ${OP}` } })
    // Restarted in demo mode over that data: no seed (the store has data), no adoption (not the seed's fingerprint).
    const demoMode = compose(store, 'b', true)
    expect(demoMode.api.handle(picker('demo')).status).toBe(400)
    expect(demoMode.ui.handle({ method: 'GET', path: '/t/demo/login', headers: {} }).body).not.toContain('name="role"')
  })
})
