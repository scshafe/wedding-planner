import http, { type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  GuestRegistry,
  composeProductSurface,
  createProductWebUiServer,
  MAX_BODY_BYTES,
  BillingLedger,
  OnboardingService,
  OperatorCredentialStore,
  ProviderWebhookCredentialStore,
  ProductApi,
  ProductWebUi,
  TransferBudget,
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
    expect(await health.json()).toEqual({ status: 'ok', commit: 'unknown' })

    const weddings = await fetch(`${base}/t/acme/weddings`)
    expect(weddings.status).toBe(401)
    expect(await weddings.json()).toEqual({ error: 'unauthorized' })
  })
})

describe('web_server body limits (issue #48)', () => {
  let server: Server
  let base: string
  let cookie: string

  beforeEach(async () => {
    const surface = composeProductSurface({
      clock: new ManualClock('2028-01-10T12:00:00.000Z'),
      ids: new SequentialIdGenerator('bl'),
      operatorToken: 'bl-operator-token-0123456789',
      providerWebhookToken: 'bl-webhook-token-0123456789',
      demoSlug: 'demo',
      passwordCost: { N: 16, r: 1, p: 1 },
    })
    const login = surface.ui.handle({ method: 'POST', path: '/t/demo/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: 'role=planner' })
    cookie = `wp_session=${/wp_session=([^;]+)/.exec(login.headers['set-cookie'] ?? '')?.[1]}`
    server = createProductWebUiServer(surface.ui)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    base = `http://127.0.0.1:${port}`
  })

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  })

  const twoMiB = (): string => `--b\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n\r\n${'x'.repeat(2 * 1024 * 1024)}\r\n--b--\r\n`

  it('an ordinary route keeps the default limit', async () => {
    const res = await fetch(`${base}/t/demo/guests/create`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie }, body: 'a'.repeat(MAX_BODY_BYTES + 1) })
    expect(res.status).toBe(413)
  })

  it('an upload is read past the default only with a live session', async () => {
    const headers = { 'content-type': 'multipart/form-data; boundary=b' }
    expect((await fetch(`${base}/t/demo/documents/upload`, { method: 'POST', headers, body: twoMiB() })).status).toBe(413)
    expect((await fetch(`${base}/t/demo/documents/upload`, { method: 'POST', headers: { ...headers, cookie: 'wp_session=made-up' }, body: twoMiB() })).status).toBe(413)
    // Read in full, then refused by the form's CSRF check (no token in this body): the limit did not stop it.
    expect((await fetch(`${base}/t/demo/documents/upload`, { method: 'POST', headers: { ...headers, cookie }, body: twoMiB() })).status).toBe(403)
  })
})

describe('web_server guards (issue #48 security review)', () => {
  let server: Server | undefined
  afterEach(async () => {
    const s = server
    server = undefined
    if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()))
  })

  /** A stub UI: a large body limit on /big, a large response on /large, and a body limit check that throws on /boom. */
  async function start(limits: { response_bytes: number; large_uploads: number; upload_deadline_ms: number }): Promise<string> {
    const stub = {
      transfers: new TransferBudget(limits),
      bodyLimit: (_method: string, path: string) => {
        if (path === '/boom') throw new Error('storage failed')
        return path === '/big' ? 2 * 1024 * 1024 : MAX_BODY_BYTES
      },
      handle: (req: { path: string }) => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: req.path === '/large' ? 'x'.repeat(300 * 1024) : 'ok' }),
      runDeferredWork: () => undefined,
    }
    server = createProductWebUiServer(stub as unknown as ProductWebUi)
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`
  }

  /** Start a POST with a declared length and send only part of it; resolves with the response when one comes. */
  function partial(url: string, declared: number, sent: number): { response: Promise<number>; finish: () => void } {
    const req = http.request(url, { method: 'POST', headers: { 'content-length': String(declared) } })
    const response = new Promise<number>((resolve) => {
      req.on('response', (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', () => resolve(-1))
    })
    req.write(Buffer.alloc(sent))
    return { response, finish: () => req.end(Buffer.alloc(declared - sent)) }
  }

  it('a body-limit check that throws falls back to the default instead of crashing the process', async () => {
    const base = await start({ response_bytes: 1024 * 1024, large_uploads: 1, upload_deadline_ms: 5000 })
    expect((await fetch(`${base}/boom`, { method: 'POST', body: 'a' })).status).toBe(200)
    expect((await fetch(`${base}/boom`, { method: 'POST', body: 'a'.repeat(MAX_BODY_BYTES + 1) })).status).toBe(413)
    expect((await fetch(`${base}/ok`)).status).toBe(200)
  })

  it('large upload bodies take one of a few places: the next one is 503 until a place frees', async () => {
    const base = await start({ response_bytes: 1024 * 1024, large_uploads: 1, upload_deadline_ms: 5000 })
    const first = partial(`${base}/big`, 2_000_000, 1000)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const second = await fetch(`${base}/big`, { method: 'POST', body: 'x' })
    expect([second.status, second.headers.get('retry-after')]).toEqual([503, '10'])
    first.finish()
    expect(await first.response).toBe(200)
    expect((await fetch(`${base}/big`, { method: 'POST', body: 'x' })).status).toBe(200)
  })

  it('a large upload body that does not arrive in time is ended (408)', async () => {
    const base = await start({ response_bytes: 1024 * 1024, large_uploads: 1, upload_deadline_ms: 100 })
    const slow = partial(`${base}/big`, 2_000_000, 1000)
    expect(await slow.response).toBe(408)
    // Its place is free again.
    expect((await fetch(`${base}/big`, { method: 'POST', body: 'x' })).status).toBe(200)
  })

  it('a large response that does not fit the budget is refused (503), not held', async () => {
    const base = await start({ response_bytes: 100 * 1024, large_uploads: 1, upload_deadline_ms: 5000 })
    const res = await fetch(`${base}/large`)
    expect([res.status, res.headers.get('retry-after')]).toEqual([503, '5'])
    expect((await fetch(`${base}/small`)).status).toBe(200)
  })

  it('a large response within the budget is sent, and released when written', async () => {
    const base = await start({ response_bytes: 400 * 1024, large_uploads: 1, upload_deadline_ms: 5000 })
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/large`)
      expect(res.status).toBe(200)
      expect((await res.text()).length).toBe(300 * 1024)
    }
  })
})

