import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  GuestRegistry,
  type ApiRequest,
  type HttpResult,
  BillingLedger,
  DeterministicGuestQaResponder,
  EscalationLog,
  EscalationResolutionLog,
  InboundReceiptLog,
  MessagingService,
  OnboardingService,
  OperatorCredentialStore,
  ProviderWebhookCredentialStore,
  ProductApi,
  ProductWebUi,
  SessionStore,
  SimulatedMessagingAdapter,
  TenantContextResolver,
  TenantStore,
  ThemeResolver,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Phase 27 — the escalation Resolve/Dismiss browser flow + CSRF. Like guests, the web layer is the SOLE place
 * a cookie becomes a credential, so it is where CSRF lives; the JSON resolve API is Bearer-only and not
 * CSRF-reachable. A guest texts an unanswerable question (escalated) → the inbox shows it Open with Resolve/
 * Dismiss forms → a valid CSRF post moves it to Handled; a forged post is masked 403 with NO mutation; an
 * unknown slug masks to 404 BEFORE the CSRF verdict (no tenant-existence oracle).
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Acme Weddings',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'asset_logo_1',
}
const WH = 'wh-secret'

interface World {
  ui: ProductWebUi
  api: ProductApi
  messaging: MessagingService
  store: TenantStore
}

function makeWorld(): World {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const store = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  store.create({ slug: 'acme', display_name: 'Acme', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  const weddings = new WeddingRepository(store, clock, new SequentialIdGenerator('seedW'))
  const registry = new GuestRegistry(store)
  const billing = new BillingLedger(clock, new SequentialIdGenerator('seedB'))
  const adapter = new SimulatedMessagingAdapter(clock, new SequentialIdGenerator('seedM'))
  const escalations = new EscalationLog(store, new SequentialIdGenerator('seedEsc'))
  const resolutions = new EscalationResolutionLog(store, new SequentialIdGenerator('seedRes'), clock)
  const messaging = new MessagingService(adapter, store, billing, new SequentialIdGenerator('seedMS'))
  const guestAuthorizer = new GuestAuthorizer()
  const api = new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: sessions,
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedWH'), [WH]),
    onboarding: new OnboardingService(store, billing),
    weddings,
    authorizer: new WeddingAuthorizer(),
    guests: { registry, weddings, authorizer: guestAuthorizer },
    messaging: {
      port: adapter,
      receipts: new InboundReceiptLog(store, new SequentialIdGenerator('seedIR')),
      registry,
      weddings,
      responder: new DeterministicGuestQaResponder(),
      service: messaging,
      escalations,
    },
    escalations: { escalations, resolutions, authorizer: guestAuthorizer, service: messaging },
  })
  return { ui: new ProductWebUi({ api, themes: new ThemeResolver(store), csrf: sessions }), api, messaging, store }
}

function get(ui: ProductWebUi, path: string, cookie?: string): HttpResult {
  const headers: ApiRequest['headers'] = cookie === undefined ? {} : { cookie }
  return ui.handle({ method: 'GET', path, headers })
}

function postForm(ui: ProductWebUi, path: string, fields: Record<string, string>, cookie?: string): HttpResult {
  const headers: ApiRequest['headers'] = {
    'content-type': 'application/x-www-form-urlencoded',
    ...(cookie === undefined ? {} : { cookie }),
  }
  return ui.handle({ method: 'POST', path, headers, rawBody: new URLSearchParams(fields).toString() })
}

function csrfFrom(html: string): string {
  const value = /name="_csrf" value="([^"]+)"/.exec(html)?.[1]
  expect(value, 'page should embed a _csrf hidden field').toBeTruthy()
  return value as string
}

function escalationIdFrom(html: string): string {
  const value = /name="escalation_id" value="([^"]+)"/.exec(html)?.[1]
  expect(value, 'open row should embed an escalation_id hidden field').toBeTruthy()
  return value as string
}

function loginCookie(ui: ProductWebUi, slug: string, role: string, weddingId?: string): string {
  const res = postForm(ui, `/t/${slug}/login`, { role, ...(weddingId ? { wedding_id: weddingId } : {}) })
  expect(res.status).toBe(303)
  const token = /wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]
  return `wp_session=${token}`
}

/** Create a wedding (planner) + register a guest + drive an UNANSWERABLE inbound, leaving one OPEN escalation. */
function seedEscalation(api: ProductApi, slug: string): string {
  const login = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
  const token = (login.body as { token: string }).token
  const create = api.handle({
    method: 'POST',
    path: `/t/${slug}/weddings`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ couple_display_name: 'Alex & Sam', event_date: '2029-05-05' }),
  })
  const weddingId = (create.body as { wedding: { wedding_id: string } }).wedding.wedding_id
  api.handle({
    method: 'POST',
    path: `/t/${slug}/guests`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ recipient_ref: 'sms:+15550100', wedding_id: weddingId, guest_id: 'g1' }),
  })
  const inbound = api.handle({
    method: 'POST',
    path: `/t/${slug}/messaging/inbound`,
    headers: { authorization: `Bearer ${WH}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ channel: 'sms', from_ref: 'sms:+15550100', text: 'where do I park?', provider_message_ref: 'pm_1' }),
  })
  expect(inbound.status).toBe(202)
  return weddingId
}

describe('escalation inbox web page (?view=escalations) + resolve flow', () => {
  it('a planner sees the Open question with Resolve/Dismiss forms carrying a _csrf field', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = get(ui, '/t/acme?view=escalations', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toContain('where do I park?')
    expect(res.body).toContain('action="/t/acme/escalations/resolve"')
    expect(res.body).toContain('name="_csrf"')
  })

  it('a valid CSRF resolve moves the question to Handled (PRG redirect → 303)', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const page = get(ui, '/t/acme?view=escalations', cookie).body
    const csrf = csrfFrom(page)
    const escId = escalationIdFrom(page)

    const resolved = postForm(ui, '/t/acme/escalations/resolve', { _csrf: csrf, escalation_id: escId, status: 'resolved' }, cookie)
    expect(resolved.status).toBe(303)
    expect(resolved.headers.location).toBe('/t/acme?view=escalations')

    const after = get(ui, '/t/acme?view=escalations', cookie).body
    expect(after).toContain('Handled')
    expect(after).toContain('Resolved by planner')
    // The question is no longer Open — no action form remains.
    expect(after).not.toContain('action="/t/acme/escalations/resolve"')
  })

  it('a forged CSRF resolve is masked 403 and performs NO mutation (stays Open)', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const escId = escalationIdFrom(get(ui, '/t/acme?view=escalations', cookie).body)

    const res = postForm(ui, '/t/acme/escalations/resolve', { _csrf: 'forged', escalation_id: escId, status: 'resolved' }, cookie)
    expect(res.status).toBe(403)
    // Still Open — the action form is back on the page.
    expect(get(ui, '/t/acme?view=escalations', cookie).body).toContain('action="/t/acme/escalations/resolve"')
  })

  it('a couple resolves THEIR wedding question via the form (303 → Handled)', () => {
    const { ui, api } = makeWorld()
    const weddingId = seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'couple', weddingId)
    const page = get(ui, '/t/acme?view=escalations', cookie).body
    const resolved = postForm(ui, '/t/acme/escalations/resolve', { _csrf: csrfFrom(page), escalation_id: escalationIdFrom(page), status: 'dismissed' }, cookie)
    expect(resolved.status).toBe(303)
    expect(get(ui, '/t/acme?view=escalations', cookie).body).toContain('Dismissed by couple')
  })

  it('a CSRF failure on an UNKNOWN tenant slug masks to GENERIC_404 BEFORE the CSRF verdict (no oracle)', () => {
    const { ui } = makeWorld()
    const res = postForm(ui, '/t/ghosttenant/escalations/resolve', { _csrf: 'forged', escalation_id: 'esc_x', status: 'resolved' })
    expect(res.status).toBe(404)
    expect(res.body).toContain('does not exist')
  })

  it('the JSON resolve API is NOT CSRF-reachable: a delegated POST with only a cookie (no Bearer) is 401', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = ui.handle({
      method: 'POST',
      path: '/t/acme/escalations',
      headers: { cookie, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ escalation_id: 'esc_x', status: 'resolved' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('escalation inbox web page — reply-from-the-inbox (Phase 28)', () => {
  const usageCount = (w: World): number => w.messaging.usageView(w.store.findBySlug('acme')!.tenant_id).message_count

  it('an Open question carries a Reply form (textarea reply_text) posting to the 4-seg reply route', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme')
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    const res = get(w.ui, '/t/acme?view=escalations', cookie)
    expect(res.body).toContain('action="/t/acme/escalations/reply"')
    expect(res.body).toContain('name="reply_text"')
  })

  it('a valid CSRF reply sends a metered message + moves the question to Handled (PRG redirect → 303)', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme')
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    const page = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    const sent = postForm(
      w.ui,
      '/t/acme/escalations/reply',
      { _csrf: csrfFrom(page), escalation_id: escalationIdFrom(page), reply_text: 'Parking is in lot B.' },
      cookie,
    )
    expect(sent.status).toBe(303)
    expect(usageCount(w)).toBe(1)
    const after = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    expect(after).toContain('Resolved by planner')
    expect(after).not.toContain('action="/t/acme/escalations/reply"') // no Open rows left
  })

  it('a forged CSRF reply is masked 403 and sends NOTHING (stays Open)', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme')
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    const escId = escalationIdFrom(get(w.ui, '/t/acme?view=escalations', cookie).body as string)
    const res = postForm(w.ui, '/t/acme/escalations/reply', { _csrf: 'forged', escalation_id: escId, reply_text: 'hi' }, cookie)
    expect(res.status).toBe(403)
    expect(usageCount(w)).toBe(0)
    expect(get(w.ui, '/t/acme?view=escalations', cookie).body).toContain('action="/t/acme/escalations/reply"')
  })

  it('a reply on an UNKNOWN tenant slug masks to GENERIC_404 BEFORE the CSRF verdict (no oracle)', () => {
    const { ui } = makeWorld()
    const res = postForm(ui, '/t/ghosttenant/escalations/reply', { _csrf: 'forged', escalation_id: 'esc_x', reply_text: 'hi' })
    expect(res.status).toBe(404)
    expect(res.body).toContain('does not exist')
  })
})
