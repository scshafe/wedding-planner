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
  MAX_PENDING_RESPONSES_PER_SOCKET,
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
    s?.closeAllConnections()
    if (s !== undefined) await new Promise<void>((resolve) => s.close(() => resolve()))
  })

  type Limits = { in_flight_bytes: number; per_key_bytes: number; response_deadline_ms: number; large_uploads: number; upload_deadline_ms: number }
  const LIMITS: Limits = { in_flight_bytes: 1024 * 1024, per_key_bytes: 1024 * 1024, response_deadline_ms: 5000, large_uploads: 2, upload_deadline_ms: 5000 }

  /**
   * A stub UI: a large body limit on /big*, its owner the path; a 300 KiB response on /large and a 16 MiB one on
   * /huge; a body-limit check that throws on /boom.
   */
  async function start(limits: Partial<Limits> = {}): Promise<{ base: string; port: number; transfers: TransferBudget; counts: { handled: number; deferred: number } }> {
    const transfers = new TransferBudget({ ...LIMITS, ...limits })
    const counts = { handled: 0, deferred: 0 }
    const stub = {
      transfers,
      bodyLimit: (_method: string, path: string) => {
        if (path === '/boom') throw new Error('storage failed')
        return path.startsWith('/big') ? 2 * 1024 * 1024 : MAX_BODY_BYTES
      },
      uploadOwner: (path: string) => path,
      handle: (req: { path: string }) => (counts.handled++, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: req.path === '/large' ? 'x'.repeat(300 * 1024) : 'ok',
        ...(req.path === '/huge' ? { bytes: Buffer.alloc(16 * 1024 * 1024) } : {}),
      }),
      runDeferredWork: () => {
        counts.deferred++
      },
    }
    server = createProductWebUiServer(stub as unknown as ProductWebUi)
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
    const port = (server?.address() as AddressInfo).port
    return { base: `http://127.0.0.1:${port}`, port, transfers, counts }
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

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  it('a body-limit check that throws falls back to the default instead of crashing the process', async () => {
    const { base } = await start()
    expect((await fetch(`${base}/boom`, { method: 'POST', body: 'a' })).status).toBe(200)
    expect((await fetch(`${base}/boom`, { method: 'POST', body: 'a'.repeat(MAX_BODY_BYTES + 1) })).status).toBe(413)
    expect((await fetch(`${base}/ok`)).status).toBe(200)
  })

  it('large upload bodies take one of a few places, one per owner: the next is 503 until a place frees', async () => {
    const { base } = await start({ in_flight_bytes: 8 * 1024 * 1024 })
    const first = partial(`${base}/big-a`, 2_000_000, 1000)
    await pause(50)
    // The same owner cannot take a second place, though one is free.
    const same = await fetch(`${base}/big-a`, { method: 'POST', body: 'x' })
    expect([same.status, same.headers.get('retry-after')]).toEqual([503, '10'])
    const second = partial(`${base}/big-b`, 2_000_000, 1000)
    await pause(50)
    // Both places taken.
    expect((await fetch(`${base}/big-c`, { method: 'POST', body: 'x' })).status).toBe(503)
    first.finish()
    second.finish()
    expect([await first.response, await second.response]).toEqual([200, 200])
    expect((await fetch(`${base}/big-c`, { method: 'POST', body: 'x' })).status).toBe(200)
  })

  it('a large upload body that does not arrive in time is ended (408), and its place freed', async () => {
    const { base } = await start({ upload_deadline_ms: 100 })
    const slow = partial(`${base}/big-a`, 2_000_000, 1000)
    expect(await slow.response).toBe(408)
    expect((await fetch(`${base}/big-a`, { method: 'POST', body: 'x' })).status).toBe(200)
  })

  it('a response that does not fit the budget is refused (503), not held; one within it is sent and released', async () => {
    const tight = await start({ in_flight_bytes: 100 * 1024 })
    const res = await fetch(`${tight.base}/large`)
    expect([res.status, res.headers.get('retry-after')]).toEqual([503, '5'])
    expect((await fetch(`${tight.base}/small`)).status).toBe(200)
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = undefined
    const roomy = await start({ in_flight_bytes: 400 * 1024 })
    for (let i = 0; i < 3; i++) {
      const ok = await fetch(`${roomy.base}/large`)
      expect(ok.status).toBe(200)
      expect((await ok.text()).length).toBe(300 * 1024)
    }
    expect(roomy.transfers.canSend(400 * 1024)).toBe(true)
  })

  /** Wait (up to a second) until `check` holds. */
  async function eventually(check: () => boolean): Promise<boolean> {
    for (let i = 0; i < 100 && !check(); i++) await pause(10)
    return check()
  }

  it('an unread large response holds the budget only until its deadline; the connection is dropped and the budget freed', async () => {
    const { port, transfers } = await start({ in_flight_bytes: 20 * 1024 * 1024, response_deadline_ms: 300 })
    const socket = new (await import('node:net')).Socket()
    socket.on('error', () => undefined)
    socket.connect(port, '127.0.0.1', () => socket.write('GET /huge HTTP/1.1\r\nHost: x\r\n\r\n'))
    socket.pause() // never read
    expect(await eventually(() => !transfers.canSend(16 * 1024 * 1024))).toBe(true)
    await pause(100)
    // Still held before the deadline; freed after it.
    expect(transfers.canSend(16 * 1024 * 1024)).toBe(false)
    expect(await eventually(() => transfers.canSend(16 * 1024 * 1024))).toBe(true)
    socket.destroy()
  })

  it(`a connection with more than ${MAX_PENDING_RESPONSES_PER_SOCKET} unfinished responses is dropped, releasing what it queued`, async () => {
    const { port, transfers } = await start({ in_flight_bytes: 80 * 1024 * 1024 })
    const socket = new (await import('node:net')).Socket()
    socket.on('error', () => undefined)
    // All in one write, so the server reads them as one batch of pipelined requests.
    const requests = 'GET /huge HTTP/1.1\r\nHost: x\r\n\r\n'.repeat(MAX_PENDING_RESPONSES_PER_SOCKET + 2)
    socket.connect(port, '127.0.0.1', () => socket.write(requests))
    socket.pause()
    await pause(100)
    expect(await eventually(() => transfers.canSend(80 * 1024 * 1024))).toBe(true)
    socket.destroy()
  })
  it('a write is checked for room before it runs; once applied its response is always sent; a read that does not fit is refused', async () => {
    const { base, transfers, counts } = await start({ in_flight_bytes: 1024 * 1024 })
    // Nothing held: the 16 MiB answer to a write is sent although it passes the budget; the same read is refused.
    const write = await fetch(`${base}/huge`, { method: 'POST', body: 'x' })
    expect(write.status).toBe(200)
    expect((await write.arrayBuffer()).byteLength).toBe(16 * 1024 * 1024)
    expect(await eventually(() => transfers.canSend(1024 * 1024))).toBe(true)
    const read = await fetch(`${base}/huge`)
    expect([read.status, read.headers.get('retry-after')]).toEqual([503, '5'])
    // Almost full: a write is refused BEFORE it runs.
    const release = transfers.hold(900 * 1024)
    const before = counts.handled
    expect((await fetch(`${base}/ok`, { method: 'POST', body: 'x' })).status).toBe(503)
    expect(counts.handled).toBe(before)
    release?.()
    expect((await fetch(`${base}/ok`, { method: 'POST', body: 'x' })).status).toBe(200)
  })

  it('request bodies are held as they arrive: one that does not fit ends its request, and everything is released', async () => {
    const { base, transfers } = await start({ in_flight_bytes: 300 * 1024 })
    const big = partial(`${base}/ok`, 900 * 1024, 600 * 1024)
    expect(await big.response).toBe(503)
    expect(await eventually(() => transfers.canSend(300 * 1024))).toBe(true)
    expect((await fetch(`${base}/ok`, { method: 'POST', body: 'x'.repeat(10 * 1024) })).status).toBe(200)
  })

  it('deferred work runs after every response, the refused ones too', async () => {
    const { base, counts } = await start({ in_flight_bytes: 100 * 1024 })
    await fetch(`${base}/large`)
    await fetch(`${base}/ok`)
    expect(await eventually(() => counts.deferred === 2)).toBe(true)
  })
})
