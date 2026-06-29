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

describe('billing Pay form (Phase 31 — settle the owed balance)', () => {
  /** Drive a metered guest reply so the tenant owes a balance; return the planner cookie. */
  function oweBalance(ui: ProductWebUi, api: ProductApi): string {
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const inbox = get(ui, '/t/acme?view=escalations', cookie).body as string
    postForm(ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(inbox), escalation_id: escalationIdFrom(inbox), reply_text: 'Parking is in lot B.' }, cookie)
    return cookie
  }

  it('the full meter→bill→customer→pay loop: a planner pays and the page then shows $0.00 owed', () => {
    const { ui, api } = makeWorld()
    const cookie = oweBalance(ui, api)
    const billing = get(ui, '/t/acme?view=billing', cookie).body as string
    expect(billing).toContain('$0.06 owed')
    expect(billing).toContain('action="/t/acme/billing/pay"')
    // Click Pay (the CSRF token is on the billing page).
    const paid = postForm(ui, '/t/acme/billing/pay', { _csrf: csrfFrom(billing) }, cookie)
    expect(paid.status).toBe(303)
    expect(paid.headers.location).toBe('/t/acme?view=billing')
    const settled = get(ui, '/t/acme?view=billing', cookie).body as string
    expect(settled).toContain('$0.00 owed')
    expect(settled).toContain('Settled — nothing owed.')
    expect(settled).not.toContain('/billing/pay') // no Pay form once settled
  })

  it('a forged CSRF token is a masked 403 and records NO payment (the balance is unchanged)', () => {
    const { ui, api } = makeWorld()
    const cookie = oweBalance(ui, api)
    const res = postForm(ui, '/t/acme/billing/pay', { _csrf: 'forged-not-the-token' }, cookie)
    expect(res.status).toBe(403)
    // The balance is untouched — a forged Pay never settled anything.
    expect(get(ui, '/t/acme?view=billing', cookie).body).toContain('$0.06 owed')
  })

  it('a Pay with no balance owed is an idempotent no-op (PRG redirect, still $0.00)', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const billing = get(ui, '/t/acme?view=billing', cookie).body as string
    // Nothing owed → no form shown; a direct POST still no-ops cleanly (the JSON layer's {paid:false}).
    expect(billing).toContain('Settled — nothing owed.')
    const res = postForm(ui, '/t/acme/billing/pay', { _csrf: csrfFrom(get(ui, '/t/acme', cookie).body as string) }, cookie)
    expect(res.status).toBe(303)
    expect(get(ui, '/t/acme?view=billing', cookie).body).toContain('$0.00 owed')
  })

  it('a couple cannot reach the Pay form (themed Forbidden) and a forged-cookie POST mutates nothing', () => {
    const { ui, api } = makeWorld()
    const weddingId = seedEscalation(api, 'acme')
    // The planner owes a balance.
    const plannerCookie = loginCookie(ui, 'acme', 'planner')
    const inbox = get(ui, '/t/acme?view=escalations', plannerCookie).body as string
    postForm(ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(inbox), escalation_id: escalationIdFrom(inbox), reply_text: 'Lot B.' }, plannerCookie)
    // A couple's billing page is Forbidden (no Pay form / no CSRF token).
    const coupleCookie = loginCookie(ui, 'acme', 'couple', weddingId)
    expect(get(ui, '/t/acme?view=billing', coupleCookie).status).toBe(403)
    // A couple POSTing the pay route (even with a stolen CSRF token shape) is stopped at the JSON 403 → masked.
    const res = postForm(ui, '/t/acme/billing/pay', { _csrf: csrfFrom(inbox) }, coupleCookie)
    expect(res.status === 303 || res.status === 403).toBe(true) // PRG-or-masked; either way no settle
    expect(get(ui, '/t/acme?view=billing', plannerCookie).body).toContain('$0.06 owed') // unchanged
  })

  it('a forged slug on the pay route masks to 404 before any cookie/CSRF read', () => {
    const { ui } = makeWorld()
    expect(postForm(ui, '/t/Bad_Slug!/billing/pay', { _csrf: 'x' }).status).toBe(404)
  })
})

describe('billing activity card (Phase 32 — the itemized line items)', () => {
  it('a fresh tenant with no events shows the Activity card with a "No activity yet." note', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const billing = get(ui, '/t/acme?view=billing', cookie).body as string
    expect(billing).toContain('<h2>Activity</h2>')
    expect(billing).toContain('No activity yet.')
  })

  it('the meter→bill→pay loop itemizes: the activity lists the messaging usage and then the payment', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    // A metered guest reply accrues a usage_charge.
    const inbox = get(ui, '/t/acme?view=escalations', cookie).body as string
    postForm(ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(inbox), escalation_id: escalationIdFrom(inbox), reply_text: 'Lot B.' }, cookie)
    const owed = get(ui, '/t/acme?view=billing', cookie).body as string
    expect(owed).toContain('Messaging usage') // the usage line item is now itemized
    expect(owed).not.toContain('No activity yet.')
    // Pay it down — a payment line item now leads the list (newest-first).
    postForm(ui, '/t/acme/billing/pay', { _csrf: csrfFrom(owed) }, cookie)
    const settled = get(ui, '/t/acme?view=billing', cookie).body as string
    expect(settled).toContain('Payment')
    expect(settled).toContain('Messaging usage')
    // Newest-first WITHIN the Activity card (the summary's "Messaging usage" heading appears earlier on the page,
    // so scope the order check to the activity section): the Payment line leads the earlier Messaging usage line.
    const activitySection = settled.slice(settled.indexOf('<h2>Activity</h2>'))
    expect(activitySection.indexOf('Payment')).toBeLessThan(activitySection.indexOf('Messaging usage'))
  })

  it('a couple never sees the activity card (themed Forbidden — billing is planner-only)', () => {
    const { ui, api } = makeWorld()
    const weddingId = seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'couple', weddingId)
    const res = get(ui, '/t/acme?view=billing', cookie)
    expect(res.status).toBe(403)
    expect(res.body).not.toContain('<h2>Activity</h2>')
  })
})

/**
 * Phase 33 — the account HOME / overview (the default /t/:slug). A web-layer composition of the existing scoped
 * reads: open guest questions, weddings/guests counts, and a PLANNER-ONLY billing card. Uses the full compose
 * surface (escalations wired) so the home gate's three reads (weddings/escalations/guests) all return 200.
 */
describe('account home overview (default /t/:slug — Phase 33)', () => {
  it('a planner home shows the weddings/guests/open-questions counts AND the billing card', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme') // one wedding + one guest + one OPEN escalation
    const cookie = loginCookie(ui, 'acme', 'planner')
    const home = get(ui, '/t/acme', cookie)
    expect(home.status).toBe(200)
    expect(home.body).toContain('1 wedding(s)')
    expect(home.body).toContain('1 registered guest(s)')
    expect(home.body).toContain('1 need attention')
    // The planner-only billing card (links to ?view=billing, shows the owed balance + plan).
    expect(home.body).toContain('?view=billing')
    expect(home.body).toContain('$0.00 owed')
    expect(home.body).toContain('solo')
    // The hub links to every spoke.
    expect(home.body).toContain('?view=escalations')
    expect(home.body).toContain('?view=weddings')
    expect(home.body).toContain('?view=guests')
  })

  it('a couple home is 200 (NOT 403) with the overview scoped to their wedding and NO billing card', () => {
    const { ui, api } = makeWorld()
    const weddingId = seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'couple', weddingId)
    const home = get(ui, '/t/acme', cookie)
    expect(home.status).toBe(200) // P1: a couple's billing 403 must NOT turn the whole home into a Forbidden wall
    expect(home.body).toContain('1 wedding(s)')
    expect(home.body).toContain('1 registered guest(s)')
    expect(home.body).toContain('1 need attention')
    // The billing card is OMITTED for a couple (a capability affordance, not a masked value).
    expect(home.body).not.toContain('?view=billing')
    expect(home.body).not.toContain('owed')
  })

  it('the open-questions count drops to 0 once the escalation is resolved (single-sourced "open" join)', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    expect(get(ui, '/t/acme', cookie).body).toContain('1 need attention')
    // Resolve it via the inbox Resolve form, then the home count drops.
    const inbox = get(ui, '/t/acme?view=escalations', cookie).body as string
    postForm(ui, '/t/acme/escalations/resolve', { _csrf: csrfFrom(inbox), escalation_id: escalationIdFrom(inbox), status: 'resolved' }, cookie)
    const home = get(ui, '/t/acme', cookie).body as string
    expect(home).not.toContain('need attention')
    expect(home).toContain('All caught up')
  })

  it('the home gate masks identically for unknown and unauthenticated (no oracle, no half-page)', () => {
    const { ui } = makeWorld()
    expect(get(ui, '/t/ghosttenant').status).toBe(404) // unknown tenant — masked
    const unauth = get(ui, '/t/acme') // active tenant, no session → the home gate's weddings read 401s
    expect(unauth.status).toBe(200)
    expect(unauth.body).toContain('Sign in') // themed login, not the overview
    expect(unauth.body).not.toContain('need attention')
  })
})
