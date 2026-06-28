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
 * Phase 30 — the planner billing & usage browser page (?view=billing). The page delegates through the
 * planner-only JSON GET /t/:slug/billing and themes strictly by status: a planner sees their own summary, a
 * couple is themed Forbidden (403). The e2e closes the meter→bill→customer loop: a metered guest reply raises
 * the customer-visible usage + balance.
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
    billing: { ledger: billing, tenants: store, authorizer: guestAuthorizer },
  })
  return { ui: new ProductWebUi({ api, themes: new ThemeResolver(store), csrf: sessions }), api }
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

function loginCookie(ui: ProductWebUi, slug: string, role: string, weddingId?: string): string {
  const res = postForm(ui, `/t/${slug}/login`, { role, ...(weddingId ? { wedding_id: weddingId } : {}) })
  expect(res.status).toBe(303)
  const token = /wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]
  return `wp_session=${token}`
}

function csrfFrom(html: string): string {
  return /name="_csrf" value="([^"]+)"/.exec(html)?.[1] as string
}
function escalationIdFrom(html: string): string {
  return /name="escalation_id" value="([^"]+)"/.exec(html)?.[1] as string
}

/** Planner creates a wedding + registers a guest + drives an UNANSWERABLE inbound → one OPEN escalation. */
function seedEscalation(api: ProductApi, slug: string): string {
  const token = (api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role: 'planner' }) }).body as { token: string }).token
  const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  const create = api.handle({ method: 'POST', path: `/t/${slug}/weddings`, headers: auth, rawBody: JSON.stringify({ couple_display_name: 'Alex & Sam', event_date: '2029-05-05' }) })
  const weddingId = (create.body as { wedding: { wedding_id: string } }).wedding.wedding_id
  api.handle({ method: 'POST', path: `/t/${slug}/guests`, headers: auth, rawBody: JSON.stringify({ recipient_ref: 'sms:+15550100', wedding_id: weddingId, guest_id: 'g1' }) })
  api.handle({ method: 'POST', path: `/t/${slug}/messaging/inbound`, headers: { authorization: `Bearer ${WH}`, 'content-type': 'application/json' }, rawBody: JSON.stringify({ channel: 'sms', from_ref: 'sms:+15550100', text: 'where do I park?', provider_message_ref: 'pm_1' }) })
  return weddingId
}

describe('billing page (?view=billing)', () => {
  it('the console links to the billing page', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    expect(get(ui, '/t/acme', cookie).body).toContain('?view=billing')
  })

  it('a planner sees their plan + a zero balance before any usage', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = get(ui, '/t/acme?view=billing', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toContain('solo')
    expect(res.body).toContain('$29.00 / month') // MONTHLY_PRICE_CENTS.solo
    expect(res.body).toContain('0 message(s) sent')
    expect(res.body).toContain('$0.00 owed')
  })

  it('the meter→bill→customer loop: a metered guest reply raises the customer-visible usage + balance', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const page = get(ui, '/t/acme?view=escalations', cookie).body as string
    const sent = postForm(ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(page), escalation_id: escalationIdFrom(page), reply_text: 'Parking is in lot B.' }, cookie)
    expect(sent.status).toBe(303)
    const billing = get(ui, '/t/acme?view=billing', cookie).body as string
    expect(billing).toContain('1 message(s) sent')
    expect(billing).toContain('$0.06 in metered messaging') // MESSAGE_PRICE_CENTS.sms.solo
    expect(billing).toContain('$0.06 owed')
  })

  it('a couple is themed Forbidden (403) — billing is a planner-only capability', () => {
    const { ui, api } = makeWorld()
    const weddingId = seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'couple', weddingId)
    const res = get(ui, '/t/acme?view=billing', cookie)
    expect(res.status).toBe(403)
    expect(res.body).toContain('Not allowed')
  })

  it('an unauthenticated visitor gets the themed login (no billing leak)', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/t/acme?view=billing')
    expect(res.status).toBe(200)
    expect(res.body).toContain('Sign in')
    expect(res.body).not.toContain('owed')
  })

  it('an unknown tenant masks to GENERIC_404 (no oracle)', () => {
    const { ui } = makeWorld()
    expect(get(ui, '/t/ghosttenant?view=billing').status).toBe(404)
  })
})
