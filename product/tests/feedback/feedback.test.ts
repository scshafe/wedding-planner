import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  composeProductSurface,
  FEEDBACK_LIMITS,
  FeedbackService,
  type HttpResult,
  RateLimiter,
  SessionStore,
  TenantContextResolver,
  TenantStore,
} from '@wedding-planner/product'

/**
 * Issue #12 — "Send feedback" from inside the product: a footer link on signed-in pages, a CSRF-protected,
 * length-limited, rate-limited form, durable storage of only what was typed (plus tenant, role and page), and an
 * operator-only list at /admin/feedback.
 */

const OP = 'feedback-operator-token-0123456789'

function setup() {
  const surface = composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('fb'),
    operatorToken: OP,
    providerWebhookToken: 'feedback-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const json = (method: string, path: string, token?: string, body?: unknown) =>
    surface.api.handle({
      method,
      path,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      rawBody: body === undefined ? undefined : JSON.stringify(body),
    })
  const login = (body: object): string => (json('POST', '/t/demo/sessions', undefined, body).body as { token: string }).token
  return { ...surface, json, login, weddingId: surface.demo?.weddingId as string }
}

function get(path: string, cookie?: string): ApiRequest {
  return { method: 'GET', path, headers: cookie === undefined ? {} : { cookie } }
}

function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) },
    rawBody: new URLSearchParams(fields).toString(),
  }
}

const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string

describe('POST /t/:slug/feedback — signed-in planners and couples', () => {
  it('stores what was typed with the tenant, role and page — and nothing else', () => {
    const w = setup()
    const couple = w.login({ role: 'couple', wedding_id: w.weddingId })
    const res = w.json('POST', '/t/demo/feedback', couple, { trying: ' add a guest ', happened: 'the button did nothing', page: 'guests' })
    expect(res.status).toBe(201)
    const list = (w.json('GET', '/admin/feedback', OP).body as { feedback: Record<string, unknown>[] }).feedback
    expect(list).toEqual([
      {
        feedback_id: (res.body as { feedback_id: string }).feedback_id,
        tenant_id: w.demo?.tenantId,
        tenant_slug: 'demo',
        role: 'couple',
        trying: 'add a guest',
        happened: 'the button did nothing',
        page: 'guests',
        created_at: '2027-06-01T00:00:00.000Z',
      },
    ])
    // No identity, no wedding id, no guest data copied in.
    expect(JSON.stringify(list)).not.toContain(w.weddingId)
    expect(JSON.stringify(list)).not.toContain('principal')
  })

  it('needs a session, both boxes, and stays within the length limits', () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    expect(w.json('POST', '/t/demo/feedback', undefined, { trying: 'x', happened: 'y' })).toEqual({ status: 401, body: { error: 'unauthorized' } })
    expect(w.json('POST', '/t/demo/feedback', planner, { trying: '   ', happened: 'y' }).status).toBe(400)
    expect(w.json('POST', '/t/demo/feedback', planner, { trying: 'x', happened: 'y'.repeat(FEEDBACK_LIMITS.happened + 1) }).status).toBe(400)
    // The page is a key from a closed list, never free text (nor a page title).
    expect(w.json('POST', '/t/demo/feedback', planner, { trying: 'x', happened: 'y', page: 'Jo & Lee' }).status).toBe(400)
    expect(w.json('GET', '/t/demo/feedback', planner).status).toBe(405)
    expect((w.json('GET', '/admin/feedback', OP).body as { feedback: unknown[] }).feedback).toEqual([])
  })

  it('is rate-limited per person (10 an hour) with a 429', () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    for (let i = 0; i < 10; i++) expect(w.json('POST', '/t/demo/feedback', planner, { trying: `t${i}`, happened: 'h' }).status).toBe(201)
    expect(w.json('POST', '/t/demo/feedback', planner, { trying: 'one more', happened: 'h' })).toEqual({ status: 429, body: { error: 'too_many_requests' } })
    // Someone else in the workspace is not affected.
    expect(w.json('POST', '/t/demo/feedback', w.login({ role: 'planner' }), { trying: 'mine', happened: 'h' }).status).toBe(201)
  })

  it('/admin/feedback is operator-only and lists newest first', () => {
    const w = setup()
    const planner = w.login({ role: 'planner' })
    w.json('POST', '/t/demo/feedback', planner, { trying: 'first', happened: 'h' })
    w.json('POST', '/t/demo/feedback', planner, { trying: 'second', happened: 'h' })
    expect(w.json('GET', '/admin/feedback', planner)).toEqual({ status: 401, body: { error: 'unauthorized' } })
    const list = (w.json('GET', '/admin/feedback', OP).body as { feedback: { trying: string }[] }).feedback
    expect(list.map((f) => f.trying)).toEqual(['second', 'first'])
  })
})

describe('the feedback form in the browser', () => {
  it('signed-in pages carry the footer link with a fixed page key; the sign-in page does not', () => {
    const w = setup()
    const cookie = `wp_session=${w.login({ role: 'planner' })}`
    expect(w.ui.handle(get('/t/demo?view=guests', cookie)).body).toContain('href="/t/demo/feedback?page=guests"')
    // A wedding page's title is the couple's names: the link names the page kind, never the title.
    const detail = w.ui.handle(get(`/t/demo?wedding=${w.weddingId}`, cookie)).body
    expect(detail).toContain('href="/t/demo/feedback?page=wedding"')
    expect(detail).not.toMatch(/feedback\?page=[^"]*Alex/)
    expect(w.ui.handle(get('/t/demo/login')).body).not.toContain('Send feedback')
  })

  it('keeps feedback per tenant: one workspace sending a lot never pushes out another\'s', () => {
    const clock = new ManualClock('2027-06-01T00:00:00.000Z')
    const tenants = new TenantStore(clock, new SequentialIdGenerator('t'))
    const theme = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }
    for (const slug of ['alpha', 'beta']) tenants.create({ slug, display_name: slug, theme, plan_tier: 'solo', lifecycle_status: 'active' })
    const resolver = new TenantContextResolver(tenants)
    const sessions = new SessionStore(new SequentialIdGenerator('s'))
    const feedback = new FeedbackService(clock, new SequentialIdGenerator('f'), new RateLimiter(clock), undefined, 2)
    const alpha = resolver.resolveBySlug('alpha')
    const beta = resolver.resolveBySlug('beta')
    feedback.submit(alpha, sessions.login(alpha, { role: 'planner' }).principal, { trying: 'alpha keeps this', happened: 'h' })
    for (const n of [1, 2, 3, 4]) feedback.submit(beta, sessions.login(beta, { role: 'planner' }).principal, { trying: `beta ${n}`, happened: 'h' })
    expect(feedback.recent(10).map((f) => f.trying)).toEqual(['beta 4', 'beta 3', 'alpha keeps this'])
  })

  it('sends through a CSRF-checked form and thanks the sender; a forged token sends nothing', () => {
    const w = setup()
    const cookie = `wp_session=${w.login({ role: 'planner' })}`
    const page = w.ui.handle(get('/t/demo/feedback?page=guests', cookie))
    expect(page.status).toBe(200)
    expect(page.body).toContain('<option value="guests" selected>Guests</option>')
    const forged = w.ui.handle(form('/t/demo/feedback/send', { _csrf: 'forged', trying: 'x', happened: 'y' }, cookie))
    expect(forged.status).toBe(403)
    const sent = w.ui.handle(form('/t/demo/feedback/send', { _csrf: csrfOf(page), trying: 'x', happened: 'y', page: 'guests' }, cookie))
    expect(sent.status).toBe(200)
    expect(sent.body).toContain('Your feedback was sent.')
    expect((w.json('GET', '/admin/feedback', OP).body as { feedback: unknown[] }).feedback).toHaveLength(1)
    const empty = w.ui.handle(form('/t/demo/feedback/send', { _csrf: csrfOf(page), trying: '', happened: 'y' }, cookie))
    expect(empty.status).toBe(400)
    expect(empty.body).toContain('Please fill in both boxes')
  })

  it('an unauthenticated visit to the form shows the sign-in page', () => {
    const w = setup()
    expect(w.ui.handle(get('/t/demo/feedback')).body).toContain('action="/t/demo/login"')
  })

  it('the operator console lists feedback with untrusted text escaped', () => {
    const w = setup()
    w.json('POST', '/t/demo/feedback', w.login({ role: 'planner' }), { trying: '<script>alert(1)</script>', happened: 'h' })
    const signIn = w.ui.handle(form('/admin/login', { token: OP }))
    const cookie = `wp_operator=${/wp_operator=([^;]+)/.exec(signIn.headers['set-cookie'] ?? '')?.[1]}`
    const page = w.ui.handle(get('/admin/feedback', cookie))
    expect(page.status).toBe(200)
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page.body).not.toContain('<script>alert(1)')
    expect(w.ui.handle(get('/admin/feedback')).headers.location).toBe('/admin/login')
  })
})
