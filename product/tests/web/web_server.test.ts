import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  GuestRegistry,
  createProductWebUiServer,
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
 * Step-5 integration: the combined Node adapter serves the web UI + delegated JSON API over real
 * sockets. The adversarial surface lives in the Step-6 keystone against the pure handler — this only
 * proves the wiring (HTML pages, a themed login -> console round-trip, the masked 404, JSON passthrough).
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Acme Weddings',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'asset_logo_1',
}

function makeUi(): ProductWebUi {
  const store = new TenantStore(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedT'))
  store.create({ slug: 'acme', display_name: 'Acme', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  const api = new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: sessions,
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedW'), ['wh-secret']),
    onboarding: new OnboardingService(store, new BillingLedger(new ManualClock('2027-03-01T00:00:00.000Z'), new SequentialIdGenerator('seedB'))),
    weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedW')),
    authorizer: new WeddingAuthorizer(),
    guests: { registry: new GuestRegistry(store), weddings: new WeddingRepository(store, new ManualClock('2027-04-01T00:00:00.000Z'), new SequentialIdGenerator('seedGW')), authorizer: new GuestAuthorizer() },
  })
  return new ProductWebUi({ api, themes: new ThemeResolver(store), csrf: sessions })
}

describe('web_server (integration)', () => {
  let server: Server
  let base: string

  beforeEach(async () => {
    server = createProductWebUiServer(makeUi())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  it('serves the themed login HTML for an active tenant', async () => {
    const res = await fetch(`${base}/t/acme`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('content-security-policy')).toContain("script-src 'none'")
    expect(await res.text()).toContain('Acme Weddings')
  })

  it('does a themed login -> console round-trip over real sockets', async () => {
    const login = await fetch(`${base}/t/acme/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'role=planner',
      redirect: 'manual',
    })
    expect(login.status).toBe(303)
    const cookie = login.headers.get('set-cookie') ?? ''
    expect(cookie).toContain('HttpOnly')
    const token = /wp_session=([^;]+)/.exec(cookie)?.[1] ?? ''

    // Phase 33: the wedding list relocated to ?view=weddings (the home — which composes the escalations/billing
    // reads not wired in this minimal fixture — is the default). This proves the authenticated HTML round-trip.
    const console_ = await fetch(`${base}/t/acme?view=weddings`, { headers: { cookie: `wp_session=${token}` } })
    expect(console_.status).toBe(200)
    expect(await console_.text()).toContain('Weddings')
  })

  it('returns the generic masked 404 for an unknown tenant', async () => {
    const res = await fetch(`${base}/t/ghost`)
    expect(res.status).toBe(404)
    const body = await res.text()
    expect(body).toContain('Not found')
    expect(body).not.toContain('Acme')
  })

  it('passes the JSON API through unchanged', async () => {
    const health = await fetch(`${base}/healthz`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ status: 'ok' })

    const weddings = await fetch(`${base}/t/acme/weddings`)
    expect(weddings.status).toBe(401)
    expect(await weddings.json()).toEqual({ error: 'unauthorized' })
  })
})
