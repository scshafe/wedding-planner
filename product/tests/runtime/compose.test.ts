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
    providerWebhookToken: 'compose-webhook-token-0123456789',
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

  it('the seeded demo guest can text in and gets a metered reply end-to-end (Phase 19)', () => {
    const { api, messaging, demo } = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    expect(demo?.guestRecipientRef).toBe('sms:+15550100')
    const res = api.handle({
      method: 'POST',
      path: '/t/demo/messaging/inbound',
      headers: { authorization: 'Bearer compose-webhook-token-0123456789' },
      rawBody: JSON.stringify({
        channel: 'sms',
        from_ref: demo?.guestRecipientRef,
        text: 'When is the wedding?',
        provider_message_ref: 'pmr_demo_1',
      }),
    })
    expect(res).toEqual({ status: 202, body: { status: 'accepted' } })
    // The meter fired through the wired surface: one usage_charge for the demo tenant.
    const usage = messaging.usageView(demo?.tenantId ?? '')
    expect(usage.message_count).toBe(1)
    expect(usage.billed_total_cents).toBeGreaterThan(0)
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

  it('a couple logs in via the public edge and lists + removes THEIR wedding\'s seeded guest (Phase 24)', () => {
    const { api, demo } = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    const login = api.handle(req('POST', '/t/demo/sessions', { body: { role: 'couple', wedding_id: demo?.weddingId } }))
    expect(login.status).toBe(201)
    const token = (login.body as { token: string }).token
    // The couple sees the demo wedding's seeded guest (scoped to their bound wedding).
    const list = api.handle(req('GET', '/t/demo/guests', { token }))
    expect(list.status).toBe(200)
    const guests = (list.body as { guests: { recipient_ref: string }[] }).guests
    expect(guests.map((g) => g.recipient_ref)).toContain(demo?.guestRecipientRef)
    // The couple removes their own guest end-to-end through the wired surface.
    const del = api.handle(req('DELETE', '/t/demo/guests', { token, body: { recipient_ref: demo?.guestRecipientRef } }))
    expect(del.status).toBe(200)
    expect((del.body as { removed: boolean }).removed).toBe(true)
    expect((api.handle(req('GET', '/t/demo/guests', { token })).body as { guests: unknown[] }).guests).toHaveLength(0)
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

describe('composeProductSurface — the guest-messaging meter (Phase 18)', () => {
  it('wires the messaging service over the simulated adapter; a send meters + bills through the SAME ledger', () => {
    const { messaging, api, demo } = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    const tenantId = demo?.tenantId ?? ''

    const result = messaging.send(tenantId, {
      channel: 'sms',
      recipient_ref: 'guest-1',
      body: 'Your RSVP reminder',
      idempotency_key: 'k1',
    })
    expect(result.deduped).toBe(false)
    expect(result.usage.billed_cents).toBeGreaterThan(result.usage.provider_cost_cents) // margin held

    // The usage_charge folded into the SAME ledger the operator's /admin billing view reads.
    const view = messaging.usageView(tenantId)
    expect(view.message_count).toBe(1)
    const billing = api.handle(req('GET', `/admin/tenants/${tenantId}/billing`, { token: OP }))
    expect(billing.status).toBe(200)
    const kinds = (billing.body as { events: { kind: string }[] }).events.map((e) => e.kind)
    expect(kinds).toContain('usage_charge')
  })

  it('the wired send is deterministic — same injected primitives replay an identical receipt', () => {
    const a = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    const b = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    const msg = { channel: 'sms' as const, recipient_ref: 'g', body: 'hi', idempotency_key: 'k1' }
    const ra = a.messaging.send(a.demo?.tenantId ?? '', msg)
    const rb = b.messaging.send(b.demo?.tenantId ?? '', msg)
    expect(ra.receipt).toEqual(rb.receipt)
    expect(ra.usage).toEqual(rb.usage)
  })
})

describe('composeProductSurface — the engine↔surface strategy seam (Phase 17)', () => {
  const CHAMPION = { genome_id: 'g_pub', parameters: { rsvp_reminder_cadence: 3, reminder_spacing: 1, reminder_batching: 1 } }

  it('forwards an injected champion so /t/demo/strategy serves guidance to a logged-in planner', () => {
    const { api } = composeProductSurface(baseConfig({ demoSlug: 'demo', championStrategy: CHAMPION }))
    const token = (api.handle(req('POST', '/t/demo/sessions', { body: { role: 'planner' } })).body as { token: string }).token
    const res = api.handle(req('GET', '/t/demo/strategy', { token }))
    expect(res.status).toBe(200)
    expect((res.body as { strategy: { autonomy: { tier: number } } }).strategy.autonomy.tier).toBe(1)
  })

  it('404s the strategy route when no champion is injected', () => {
    const { api } = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    const token = (api.handle(req('POST', '/t/demo/sessions', { body: { role: 'planner' } })).body as { token: string }).token
    expect(api.handle(req('GET', '/t/demo/strategy', { token })).status).toBe(404)
  })

  it('FAILS CLOSED at compose on a malformed champion (no surface, no socket)', () => {
    const malformed = { genome_id: 'g', parameters: { rsvp_reminder_cadence: 9, reminder_spacing: 1, reminder_batching: 1 } }
    expect(() => composeProductSurface(baseConfig({ championStrategy: malformed as never }))).toThrow()
  })
})

describe('composeProductSurface — Phase 23 e2e: a browser-set logistic reaches the guest reply', () => {
  const WEBHOOK = 'compose-webhook-token-0123456789'

  function form(method: string, path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
    const headers: Record<string, string | undefined> = { 'content-type': 'application/x-www-form-urlencoded' }
    if (cookie !== undefined) headers.cookie = cookie
    return { method, path, headers, rawBody: new URLSearchParams(fields).toString() }
  }

  function dressCodeInbound(ref: string, pmr: string): ApiRequest {
    return {
      method: 'POST',
      path: '/t/demo/messaging/inbound',
      headers: { authorization: `Bearer ${WEBHOOK}` },
      rawBody: JSON.stringify({ channel: 'sms', from_ref: ref, text: 'What is the dress code?', provider_message_ref: pmr }),
    }
  }

  it('a planner sets dress_code via the BROWSER edit form, then a guest texting "dress code" gets a metered reply (escalated→answered)', () => {
    const { ui, api, messaging, demo } = composeProductSurface(baseConfig({ demoSlug: 'demo' }))
    const ref = demo?.guestRecipientRef as string
    const tenantId = demo?.tenantId as string

    // BEFORE: dress_code is unset on the demo wedding, so the question ESCALATES — no send, no meter.
    expect(api.handle(dressCodeInbound(ref, 'pmr_before')).status).toBe(202)
    expect(messaging.usageView(tenantId).message_count).toBe(0)

    // The planner logs in through the HTML front door and sets the dress code via the edit form.
    const loginRes = ui.handle(form('POST', '/t/demo/login', { role: 'planner' }))
    const cookie = `wp_session=${/wp_session=([^;]+)/.exec(loginRes.headers['set-cookie'] ?? '')?.[1]}`
    const detail = ui.handle({ method: 'GET', path: `/t/demo?wedding=${demo?.weddingId}`, headers: { cookie } })
    const csrf = /name="_csrf" value="([^"]+)"/.exec(detail.body as string)?.[1] as string
    const saved = ui.handle(
      form(
        'POST',
        '/t/demo/weddings/update',
        { _csrf: csrf, wedding_id: demo?.weddingId as string, couple_display_name: 'Alex & Sam', event_date: '2027-09-18', status: 'planning', dress_code: 'Cocktail attire' },
        cookie,
      ),
    )
    expect(saved.status).toBe(303)

    // AFTER: the SAME question is now ANSWERED from the browser-set fact — one metered reply fires.
    expect(api.handle(dressCodeInbound(ref, 'pmr_after')).status).toBe(202)
    const usage = messaging.usageView(tenantId)
    expect(usage.message_count).toBe(1)
    expect(usage.billed_total_cents).toBeGreaterThan(0)
  })
})
