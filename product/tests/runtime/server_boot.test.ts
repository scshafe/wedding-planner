import type { AddressInfo } from 'node:net'

import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { composeProductSurface, createProductWebUiServer } from '@wedding-planner/product'

/**
 * Step-4(c) coverage: the composed surface actually serves over a real socket. Mirrors the existing
 * node_server / web_server adapter tests — bind on port 0, hit the live URL, prove the deployable front door
 * (compose -> ProductWebUi -> createProductWebUiServer) answers. The pipeline behavior is proven by the
 * keystones; this is the wiring smoke that the image's CMD path is sound.
 */

const server = createProductWebUiServer(
  composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('boot'),
    operatorToken: 'boot-operator-token-0123456789',
    demoSlug: 'demo',
  }).ui,
)

let baseUrl = ''

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
})

describe('the deployable front door serves over a socket', () => {
  it('GET /healthz -> 200 ok', async () => {
    const res = await fetch(`${baseUrl}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })

  it('GET /t/demo -> 200 themed (the active demo tenant)', async () => {
    const res = await fetch(`${baseUrl}/t/demo`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Demo Weddings Co.')
  })

  it('GET /t/ghost -> a masked 404 (no existence oracle through the socket)', async () => {
    const res = await fetch(`${baseUrl}/t/ghost`)
    expect(res.status).toBe(404)
  })

  it('POST /admin/tenants without the operator token -> 401', async () => {
    const res = await fetch(`${baseUrl}/admin/tenants`, { method: 'POST' })
    expect(res.status).toBe(401)
  })
})
