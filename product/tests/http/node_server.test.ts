import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createProductApiServer,
  ProductApi,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Step-4 integration coverage: the thin Node `http` adapter actually wires the pure handler over real
 * sockets. Boots on an ephemeral port, issues real HTTP, asserts a round-trip, then closes. The full
 * adversarial surface lives in the keystone against the pure handler — this only proves the wiring.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}

function makeApi(): ProductApi {
  const store = new TenantStore(
    new ManualClock('2027-03-01T00:00:00.000Z'),
    new SequentialIdGenerator('seedT'),
  )
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  return new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: new SessionStore(new SequentialIdGenerator('seedS')),
    weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW')),
    authorizer: new WeddingAuthorizer(),
  })
}

describe('node_server (integration)', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    server = createProductApiServer(makeApi())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  it('serves /healthz over a real socket', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('does a full login -> create -> read round-trip over real sockets', async () => {
    const login = await fetch(`${base}/t/alpha/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'planner' }),
    })
    expect(login.status).toBe(201)
    const { token } = (await login.json()) as { token: string }

    const create = await fetch(`${base}/t/alpha/weddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ couple_display_name: 'Alex & Sam', event_date: '2028-09-09' }),
    })
    expect(create.status).toBe(201)
    const { wedding } = (await create.json()) as { wedding: { wedding_id: string } }

    const read = await fetch(`${base}/t/alpha/weddings/${wedding.wedding_id}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(read.status).toBe(200)
    const readBody = (await read.json()) as { wedding: { couple_display_name: string } }
    expect(readBody.wedding.couple_display_name).toBe('Alex & Sam')
  })

  it('rejects an unauthenticated weddings request with 401 over the socket', async () => {
    const res = await fetch(`${base}/t/alpha/weddings`)
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })
})
