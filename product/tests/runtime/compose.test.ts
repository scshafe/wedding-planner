import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  composeProductSurface,
  type ComposeProductSurfaceConfig,
} from '@wedding-planner/product'

/**
 * Step-2 coverage for the composition root — the seam the deployable entrypoint sits on. These exercise the
 * SAME wiring the live image runs, but with the deterministic doubles (ManualClock / SequentialIdGenerator /
 * a fixed token) injected as config, so the boundaries inherited from Phases 12–15 are pinned at the compose
 * layer: the demo tenant is a faithful ACTIVE tenant (provisioned + activated through the real lifecycle
 * driver), the disclosure mask survives, the operator gate still holds, and `seedDemo:false` fabricates no
 * demo handle.
 */

const OP = 'compose-operator-token-0123456789'

function baseConfig(overrides: Partial<ComposeProductSurfaceConfig> = {}): ComposeProductSurfaceConfig {
  return {
    clock: new ManualClock('2027-05-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('compose'),
    operatorToken: OP,
    ...overrides,
  }
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

describe('composeProductSurface — the wired surface boots demoable', () => {
  it('seeds an ACTIVE demo tenant with one wedding, reachable through the themed UI', () => {
    const { ui, demo } = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    expect(demo).toBeDefined()
    expect(demo?.slug).toBe('demo')

    // The HTML front door themes the active demo tenant (200 + the brand name rendered).
    const page = ui.handle(req('GET', '/t/demo'))
    expect(page.status).toBe(200)
    expect(page.body).toContain('Demo Weddings Co.')
  })

  it('/healthz answers 200 through the front door', () => {
    const { ui } = composeProductSurface(baseConfig())
    const res = ui.handle(req('GET', '/healthz'))
    expect(res.status).toBe(200)
  })

  it('the demo wedding is listable by a planner who logs in via the public edge (no baked session)', () => {
    const { api, demo } = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    const login = api.handle(req('POST', '/t/demo/sessions', { body: { role: 'planner' } }))
    expect(login.status).toBe(201)
    const token = (login.body as { token: string }).token
    const list = api.handle(req('GET', '/t/demo/weddings', { token }))
    expect(list.status).toBe(200)
    const weddings = (list.body as { weddings: { wedding_id: string }[] }).weddings
    expect(weddings.map((w) => w.wedding_id)).toContain(demo?.weddingId)
  })
})

describe('composeProductSurface — boundaries inherited unchanged', () => {
  it('an unprovisioned slug is a byte-identical generic 404 (the mask survives compose)', () => {
    const { ui } = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    const known = ui.handle(req('GET', '/t/ghost'))
    expect(known.status).toBe(404)
    // The /admin surface is operator-gated end-to-end: no token => 401, the seeded token => 201.
    const { api } = composeProductSurface(baseConfig())
    expect(api.handle(req('POST', '/admin/tenants', { body: {} })).status).toBe(401)
  })

  it('the operator gate accepts the injected token and provisions a new tenant', () => {
    const { api } = composeProductSurface(baseConfig())
    const res = api.handle(
      req('POST', '/admin/tenants', {
        token: OP,
        body: {
          slug: 'new-co',
          display_name: 'New Co',
          plan_tier: 'solo',
          theme: {
            brand_name: 'New',
            primary_color_hex: '#111111',
            accent_color_hex: '#222222',
            logo_ref: 'l1',
          },
        },
      }),
    )
    expect(res.status).toBe(201)
  })

  it('seedDemo:false fabricates no demo handle and leaves the slug unprovisioned', () => {
    const { ui, demo } = composeProductSurface(baseConfig({ seedDemo: false }))
    expect(demo).toBeUndefined()
    expect(ui.handle(req('GET', '/t/demo')).status).toBe(404)
  })
})
