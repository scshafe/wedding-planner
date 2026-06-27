import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  GuestRegistry,
  type ApiRequest,
  type HttpResult,
  BillingLedger,
  OnboardingService,
  OperatorCredentialStore,
  ProviderWebhookCredentialStore,
  ProductApi,
  ProductWebUi,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  ThemeResolver,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Phase 21 + Phase 24 — the guest-management browser flow + CSRF. The web layer is the SOLE place a cookie
 * becomes a credential, so it is where CSRF lives; the JSON API is Bearer-only and (proved here) not
 * CSRF-reachable. A SHARED WeddingRepository backs both the JSON `/weddings` route and the guests bag so a
 * wedding created in the flow is visible to the registration's referential-integrity check. Phase 24: a
 * COUPLE also reaches `?view=guests` (200, scoped to their wedding's guests) and removes a guest via the
 * CSRF form, while the add-guest form is a capability affordance — a couple's submit takes the themed 403.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Acme Weddings',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'asset_logo_1',
}

interface World {
  ui: ProductWebUi
  api: ProductApi
}

function makeWorld(): World {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'acme', display_name: 'Acme', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  const weddings = new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW'))
  const registry = new GuestRegistry(store)
  const api = new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: sessions,
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedWH'), ['wh-secret']),
    onboarding: new OnboardingService(store, new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))),
    weddings,
    authorizer: new WeddingAuthorizer(),
    guests: { registry, weddings, authorizer: new GuestAuthorizer() },
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

function csrfFrom(html: string): string {
  const value = /name="_csrf" value="([^"]+)"/.exec(html)?.[1]
  expect(value, 'page should embed a _csrf hidden field').toBeTruthy()
  return value as string
}

function loginCookie(ui: ProductWebUi, slug: string, role: string, weddingId?: string): string {
  const res = postForm(ui, `/t/${slug}/login`, { role, ...(weddingId ? { wedding_id: weddingId } : {}) })
  expect(res.status).toBe(303)
  const token = /wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]
  return `wp_session=${token}`
}

/** Create a wedding through the JSON API (planner) and return its id. */
function createWedding(api: ProductApi, slug: string, name: string): string {
  const login = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
  const token = (login.body as { token: string }).token
  const create = api.handle({
    method: 'POST',
    path: `/t/${slug}/weddings`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ couple_display_name: name, event_date: '2029-05-05' }),
  })
  expect(create.status).toBe(201)
  return (create.body as { wedding: { wedding_id: string } }).wedding.wedding_id
}

/** Register a guest through the JSON API (planner) so a couple has something to see/remove. */
function registerGuest(api: ProductApi, slug: string, body: { recipient_ref: string; wedding_id: string; guest_id: string }): void {
  const login = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
  const token = (login.body as { token: string }).token
  const res = api.handle({
    method: 'POST',
    path: `/t/${slug}/guests`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify(body),
  })
  expect(res.status).toBe(201)
}

describe('guest-management web page (?view=guests)', () => {
  it('a planner sees the guests page with an add form carrying a _csrf field', () => {
    const { ui, api } = makeWorld()
    createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = get(ui, '/t/acme?view=guests', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toContain('Register a guest')
    expect(res.body).toContain('name="_csrf"')
    expect(res.body).toContain('Alex &amp; Sam') // the wedding picker option
  })

  it('a couple sees the guests page (200) scoped to ONLY their wedding\'s guests (Phase 24)', () => {
    const { ui, api } = makeWorld()
    const own = createWedding(api, 'acme', 'Own Couple')
    const sibling = createWedding(api, 'acme', 'Other Couple')
    registerGuest(api, 'acme', { recipient_ref: 'sms:+mine', wedding_id: own, guest_id: 'gm' })
    registerGuest(api, 'acme', { recipient_ref: 'sms:+sib', wedding_id: sibling, guest_id: 'gs' })
    const cookie = loginCookie(ui, 'acme', 'couple', own)
    const res = get(ui, '/t/acme?view=guests', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toContain('sms:+mine') // their own guest
    expect(res.body).not.toContain('sms:+sib') // never the sibling wedding's guest
  })

  it('an unauthenticated visitor gets the themed login (401 -> login)', () => {
    const { ui } = makeWorld()
    const res = get(ui, '/t/acme?view=guests')
    expect(res.status).toBe(200)
    expect(res.body).toContain('Simulated login')
  })
})

describe('guest create/remove browser flow + CSRF', () => {
  it('a planner registers a guest with a valid CSRF token (PRG redirect), then sees it', () => {
    const { ui, api } = makeWorld()
    const weddingId = createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const csrf = csrfFrom(get(ui, '/t/acme?view=guests', cookie).body)

    const created = postForm(ui, '/t/acme/guests/create', { _csrf: csrf, recipient_ref: 'sms:+15550100', wedding_id: weddingId, guest_id: 'g1' }, cookie)
    expect(created.status).toBe(303)
    expect(created.headers.location).toBe('/t/acme?view=guests')

    const page = get(ui, '/t/acme?view=guests', cookie)
    expect(page.body).toContain('sms:+15550100')
    expect(page.body).toContain('g1')
  })

  it('a forged CSRF token on create is rejected (403) and registers NO guest', () => {
    const { ui, api } = makeWorld()
    const weddingId = createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')

    const res = postForm(ui, '/t/acme/guests/create', { _csrf: 'forged', recipient_ref: 'sms:+15550100', wedding_id: weddingId, guest_id: 'g1' }, cookie)
    expect(res.status).toBe(403)
    // Nothing was registered — the page shows the empty state.
    expect(get(ui, '/t/acme?view=guests', cookie).body).toContain('No guests registered yet')
  })

  it('a planner removes a guest with a valid CSRF token; a forged token leaves it intact', () => {
    const { ui, api } = makeWorld()
    const weddingId = createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const csrf = csrfFrom(get(ui, '/t/acme?view=guests', cookie).body)
    expect(postForm(ui, '/t/acme/guests/create', { _csrf: csrf, recipient_ref: 'sms:+15550100', wedding_id: weddingId, guest_id: 'g1' }, cookie).status).toBe(303)

    // Forged remove -> 403, guest still present.
    expect(postForm(ui, '/t/acme/guests/remove', { _csrf: 'forged', recipient_ref: 'sms:+15550100' }, cookie).status).toBe(403)
    expect(get(ui, '/t/acme?view=guests', cookie).body).toContain('sms:+15550100')

    // Valid remove -> 303, guest gone.
    const csrf2 = csrfFrom(get(ui, '/t/acme?view=guests', cookie).body)
    expect(postForm(ui, '/t/acme/guests/remove', { _csrf: csrf2, recipient_ref: 'sms:+15550100' }, cookie).status).toBe(303)
    expect(get(ui, '/t/acme?view=guests', cookie).body).toContain('No guests registered yet')
  })

  it('a CSRF failure on an UNKNOWN tenant slug masks to GENERIC_404 (no tenant-existence oracle)', () => {
    const { ui } = makeWorld()
    const res = postForm(ui, '/t/ghosttenant/guests/create', { _csrf: 'forged', recipient_ref: 'x', wedding_id: 'w', guest_id: 'g' })
    expect(res.status).toBe(404)
    expect(res.body).toContain('does not exist')
  })

  it('the JSON guest API is NOT CSRF-reachable: a delegated POST with only a cookie (no Bearer) is 401', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    // A cross-site form cannot set Authorization; the cookie is NOT translated on a delegated route.
    const res = ui.handle({
      method: 'POST',
      path: '/t/acme/guests',
      headers: { cookie, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ recipient_ref: 'sms:+1', wedding_id: 'w', guest_id: 'g' }),
    })
    expect(res.status).toBe(401)
  })

  it('a couple removes THEIR OWN guest via the CSRF form (303 -> gone)', () => {
    const { ui, api } = makeWorld()
    const own = createWedding(api, 'acme', 'Own Couple')
    registerGuest(api, 'acme', { recipient_ref: 'sms:+mine', wedding_id: own, guest_id: 'gm' })
    const cookie = loginCookie(ui, 'acme', 'couple', own)
    const csrf = csrfFrom(get(ui, '/t/acme?view=guests', cookie).body)
    const removed = postForm(ui, '/t/acme/guests/remove', { _csrf: csrf, recipient_ref: 'sms:+mine' }, cookie)
    expect(removed.status).toBe(303)
    expect(get(ui, '/t/acme?view=guests', cookie).body).toContain('No guests registered yet')
  })

  it('a couple\'s add-guest submit takes the themed 403 (capability affordance) and registers NO guest', () => {
    const { ui, api } = makeWorld()
    const own = createWedding(api, 'acme', 'Own Couple')
    const cookie = loginCookie(ui, 'acme', 'couple', own)
    const csrf = csrfFrom(get(ui, '/t/acme?view=guests', cookie).body)
    // Valid CSRF, but the delegated POST /guests is planner-only -> the page re-renders the 403/notice.
    const res = postForm(ui, '/t/acme/guests/create', { _csrf: csrf, recipient_ref: 'sms:+nope', wedding_id: own, guest_id: 'g1' }, cookie)
    expect([400, 403]).toContain(res.status)
    // Nothing was registered — the couple's scoped list stays empty.
    expect(get(ui, '/t/acme?view=guests', cookie).body).toContain('No guests registered yet')
  })

  it('a couple\'s forged-CSRF add-guest is masked 403 BEFORE the delegated forward (no mutation)', () => {
    const { ui, api } = makeWorld()
    const own = createWedding(api, 'acme', 'Own Couple')
    const cookie = loginCookie(ui, 'acme', 'couple', own)
    const res = postForm(ui, '/t/acme/guests/create', { _csrf: 'forged', recipient_ref: 'sms:+nope', wedding_id: own, guest_id: 'g1' }, cookie)
    expect(res.status).toBe(403)
    expect(get(ui, '/t/acme?view=guests', cookie).body).toContain('No guests registered yet')
  })
})
