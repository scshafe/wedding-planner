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
 * Phase 23 — the planner/couple wedding create + edit browser flow. The web layer is the SOLE place a cookie
 * becomes a credential, so it is where CSRF lives; the new mutations reuse the Phase-21 seam wholesale. The
 * crux this file proves: (a) create is a capability (couple -> themed 403, no mutation); (b) update masks a
 * couple's non-owned id, an empty id, and a path-injection id byte-identically to a missing id (no oracle, no
 * mutation); (c) a forged CSRF on either form mutates nothing; (d) the body wedding_id is URL-encoded so it
 * can never break out of the /t/:slug/weddings/:id route; (e) logistics round-trip to the detail page.
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

/** A planner Bearer token for the JSON API (to set up / assert state out-of-band). */
function plannerToken(api: ProductApi, slug: string): string {
  const login = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
  return (login.body as { token: string }).token
}

/** Create a wedding through the JSON API (planner) and return its id. */
function createWedding(api: ProductApi, slug: string, name: string): string {
  const create = api.handle({
    method: 'POST',
    path: `/t/${slug}/weddings`,
    headers: { authorization: `Bearer ${plannerToken(api, slug)}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ couple_display_name: name, event_date: '2029-05-05' }),
  })
  expect(create.status).toBe(201)
  return (create.body as { wedding: { wedding_id: string } }).wedding.wedding_id
}

/** Read a wedding via the planner JSON API, or undefined if absent (used to assert (no) mutation). */
function readWeddingJson(api: ProductApi, slug: string, weddingId: string): Record<string, unknown> | undefined {
  const res = api.handle({
    method: 'GET',
    path: `/t/${slug}/weddings/${encodeURIComponent(weddingId)}`,
    headers: { authorization: `Bearer ${plannerToken(api, slug)}` },
  })
  return res.status === 200 ? (res.body as { wedding: Record<string, unknown> }).wedding : undefined
}

describe('wedding create browser flow + CSRF', () => {
  it('a planner creates a wedding (with logistics) via the form; PRG redirect then it is listed + detailed', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const csrf = csrfFrom(get(ui, '/t/acme', cookie).body)

    const created = postForm(
      ui,
      '/t/acme/weddings/create',
      { _csrf: csrf, couple_display_name: 'Alex & Sam', event_date: '2029-09-12', status: 'planning', dress_code: 'Black tie' },
      cookie,
    )
    expect(created.status).toBe(303)
    expect(created.headers.location).toBe('/t/acme')

    const list = get(ui, '/t/acme', cookie).body
    expect(list).toContain('Alex &amp; Sam')
    // The logistics field round-trips to the detail page.
    const id = /href="\/t\/acme\?wedding=([^"]+)"/.exec(list)?.[1] as string
    expect(get(ui, `/t/acme?wedding=${id}`, cookie).body).toContain('Black tie')
  })

  it('a couple submitting the create form gets the themed 403 (capability) and creates NO wedding', () => {
    const { ui, api } = makeWorld()
    const own = createWedding(api, 'acme', 'Own Couple')
    const cookie = loginCookie(ui, 'acme', 'couple', own)
    const csrf = csrfFrom(get(ui, '/t/acme', cookie).body)

    const res = postForm(
      ui,
      '/t/acme/weddings/create',
      { _csrf: csrf, couple_display_name: 'Sneaky New', event_date: '2030-01-01', status: 'planning' },
      cookie,
    )
    expect(res.status).toBe(403)
    expect(res.body).toContain('Not allowed')
    // The planner still sees exactly the one pre-existing wedding.
    expect(get(ui, '/t/acme', loginCookie(ui, 'acme', 'planner')).body).not.toContain('Sneaky New')
  })

  it('a forged CSRF token on create is rejected (403) and creates NO wedding', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = postForm(
      ui,
      '/t/acme/weddings/create',
      { _csrf: 'forged', couple_display_name: 'Ghost', event_date: '2030-01-01', status: 'planning' },
      cookie,
    )
    expect(res.status).toBe(403)
    expect(get(ui, '/t/acme', cookie).body).toContain('No weddings to show')
  })

  it('an invalid create body re-renders the console with a GENERIC notice (400, no leak)', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const csrf = csrfFrom(get(ui, '/t/acme', cookie).body)
    const res = postForm(
      ui,
      '/t/acme/weddings/create',
      { _csrf: csrf, couple_display_name: 'X', event_date: 'not-a-date', status: 'planning' },
      cookie,
    )
    expect(res.status).toBe(400)
    expect(res.body).toContain('could not be created')
    expect(get(ui, '/t/acme', cookie).body).toContain('No weddings to show')
  })

  it('a malformed slug masks to GENERIC_404 BEFORE any CSRF verdict (no tenant-existence oracle)', () => {
    const { ui } = makeWorld()
    const res = postForm(ui, '/t/Bad_Slug!/weddings/create', { _csrf: 'forged', couple_display_name: 'X', event_date: '2030-01-01', status: 'planning' })
    expect(res.status).toBe(404)
    expect(res.body).toContain('does not exist')
  })
})

describe('wedding edit browser flow + CSRF', () => {
  it('a planner edits a wedding (sets logistics) via the form; PRG redirect then the change shows', () => {
    const { ui, api } = makeWorld()
    const id = createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const csrf = csrfFrom(get(ui, `/t/acme?wedding=${id}`, cookie).body)

    const res = postForm(
      ui,
      '/t/acme/weddings/update',
      { _csrf: csrf, wedding_id: id, couple_display_name: 'Alex & Sam', event_date: '2029-05-05', status: 'active', dress_code: 'Cocktail attire' },
      cookie,
    )
    expect(res.status).toBe(303)
    expect(res.headers.location).toBe(`/t/acme?wedding=${id}`)
    const detail = get(ui, `/t/acme?wedding=${id}`, cookie).body
    expect(detail).toContain('Cocktail attire')
    expect(detail).toContain('active')
  })

  it('a couple edits THEIR OWN wedding; the change persists', () => {
    const { ui, api } = makeWorld()
    const own = createWedding(api, 'acme', 'Own Couple')
    const cookie = loginCookie(ui, 'acme', 'couple', own)
    const csrf = csrfFrom(get(ui, `/t/acme?wedding=${own}`, cookie).body)

    const res = postForm(
      ui,
      '/t/acme/weddings/update',
      { _csrf: csrf, wedding_id: own, couple_display_name: 'Own Couple', event_date: '2029-05-05', status: 'planning', venue_name: 'The Old Mill' },
      cookie,
    )
    expect(res.status).toBe(303)
    expect(readWeddingJson(api, 'acme', own)?.venue_name).toBe('The Old Mill')
  })

  it('an omitted optional field PRESERVES its stored value (no clear-to-absent from the browser)', () => {
    const { ui, api } = makeWorld()
    const id = createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    // First set a dress code...
    const csrf1 = csrfFrom(get(ui, `/t/acme?wedding=${id}`, cookie).body)
    postForm(ui, '/t/acme/weddings/update', { _csrf: csrf1, wedding_id: id, couple_display_name: 'Alex & Sam', event_date: '2029-05-05', status: 'planning', dress_code: 'Black tie' }, cookie)
    // ...then submit again with the dress_code field BLANK; it must be preserved, not cleared.
    const csrf2 = csrfFrom(get(ui, `/t/acme?wedding=${id}`, cookie).body)
    const res = postForm(ui, '/t/acme/weddings/update', { _csrf: csrf2, wedding_id: id, couple_display_name: 'Alex & Sam', event_date: '2029-05-05', status: 'planning', dress_code: '' }, cookie)
    expect(res.status).toBe(303)
    expect(readWeddingJson(api, 'acme', id)?.dress_code).toBe('Black tie')
  })

  it('a couple updating a NON-OWNED wedding is masked (404) and mutates nothing', () => {
    const { ui, api } = makeWorld()
    const own = createWedding(api, 'acme', 'Own Couple')
    const other = createWedding(api, 'acme', 'Other Couple')
    const cookie = loginCookie(ui, 'acme', 'couple', own)
    const csrf = csrfFrom(get(ui, `/t/acme?wedding=${own}`, cookie).body)

    const res = postForm(
      ui,
      '/t/acme/weddings/update',
      { _csrf: csrf, wedding_id: other, couple_display_name: 'HIJACKED', event_date: '2029-05-05', status: 'cancelled' },
      cookie,
    )
    expect(res.status).toBe(404)
    expect(res.body).toContain('does not exist')
    // The other wedding is untouched.
    expect(readWeddingJson(api, 'acme', other)?.couple_display_name).toBe('Other Couple')
  })

  it('an EMPTY wedding_id update is byte-identical to a non-owned/missing id (no raw 405 oracle)', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const csrf = csrfFrom(get(ui, '/t/acme', cookie).body)
    const res = postForm(
      ui,
      '/t/acme/weddings/update',
      { _csrf: csrf, wedding_id: '', couple_display_name: 'X', event_date: '2029-05-05', status: 'planning' },
      cookie,
    )
    expect(res.status).toBe(404)
    expect(res.body).toContain('does not exist')
  })

  it('a path-injection wedding_id stays one segment (encoded) — masked 404, no breakout, no mutation', () => {
    const { ui, api } = makeWorld()
    const victim = createWedding(api, 'acme', 'Victim')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const csrf = csrfFrom(get(ui, '/t/acme', cookie).body)
    for (const evil of [`${victim}/../../sessions`, '../sessions', 'a/weddings/b']) {
      const res = postForm(
        ui,
        '/t/acme/weddings/update',
        { _csrf: csrf, wedding_id: evil, couple_display_name: 'PWNED', event_date: '2029-05-05', status: 'cancelled' },
        cookie,
      )
      expect(res.status).toBe(404)
    }
    // The real wedding is untouched and no session/route was reached through the id.
    expect(readWeddingJson(api, 'acme', victim)?.couple_display_name).toBe('Victim')
  })

  it('a forged CSRF token on update is rejected (403) and mutates nothing', () => {
    const { ui, api } = makeWorld()
    const id = createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = postForm(
      ui,
      '/t/acme/weddings/update',
      { _csrf: 'forged', wedding_id: id, couple_display_name: 'CHANGED', event_date: '2029-05-05', status: 'cancelled' },
      cookie,
    )
    expect(res.status).toBe(403)
    expect(readWeddingJson(api, 'acme', id)?.couple_display_name).toBe('Alex & Sam')
  })

  it('an invalid edit body on an OWNED wedding re-renders the detail with a notice (400); no mutation', () => {
    const { ui, api } = makeWorld()
    const id = createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const csrf = csrfFrom(get(ui, `/t/acme?wedding=${id}`, cookie).body)
    const res = postForm(
      ui,
      '/t/acme/weddings/update',
      { _csrf: csrf, wedding_id: id, couple_display_name: 'Alex & Sam', event_date: 'bad-date', status: 'planning' },
      cookie,
    )
    expect(res.status).toBe(400)
    expect(res.body).toContain('could not be saved')
    expect(readWeddingJson(api, 'acme', id)?.event_date).toBe('2029-05-05')
  })
})

describe('the JSON wedding mutation API is NOT CSRF-reachable', () => {
  it('a delegated POST /weddings with only a cookie (no Bearer) is 401', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = ui.handle({
      method: 'POST',
      path: '/t/acme/weddings',
      headers: { cookie, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ couple_display_name: 'X', event_date: '2029-05-05' }),
    })
    expect(res.status).toBe(401)
  })

  it('a delegated PUT /weddings/:id with only a cookie (no Bearer) is 401', () => {
    const { ui, api } = makeWorld()
    const id = createWedding(api, 'acme', 'Alex & Sam')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = ui.handle({
      method: 'PUT',
      path: `/t/acme/weddings/${id}`,
      headers: { cookie, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ couple_display_name: 'CHANGED', event_date: '2029-05-05', status: 'cancelled' }),
    })
    expect(res.status).toBe(401)
    expect(readWeddingJson(api, 'acme', id)?.couple_display_name).toBe('Alex & Sam')
  })
})
