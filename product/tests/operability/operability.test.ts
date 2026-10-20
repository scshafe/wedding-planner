import type { AddressInfo } from 'node:net'

import { ManualClock, SequentialIdGenerator, WeddingPlannerError } from '@wedding-planner/shared'
import { afterEach, describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  composeProductSurface,
  createProductWebUiServer,
  ErrorLog,
  errorCode,
  errorName,
  formatRequestLog,
  InMemoryRecordStore,
  logMethod,
  type RecordStore,
  routePattern,
  stackFrames,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'

/**
 * Issue #13 — operability: one structured JSON log line per request that can never carry a secret or a contact
 * detail, server errors captured by code (never message) for the operator, and the build commit in /healthz.
 */

const OP = 'ops-operator-token-0123456789'
const WEBHOOK = 'ops-webhook-token-0123456789'

function surface(options: { buildCommit?: string; store?: RecordStore } = {}) {
  return composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('ops'),
    operatorToken: OP,
    providerWebhookToken: WEBHOOK,
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
    ...options,
  })
}

function req(method: string, path: string, token?: string, body?: unknown): ApiRequest {
  return {
    method,
    path,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    rawBody: body === undefined ? undefined : JSON.stringify(body),
  }
}

describe('the request log line — route patterns only', () => {
  it('masks every non-static segment and drops the query string', () => {
    expect(routePattern('/t/demo/weddings/wedding_abc123?x=1')).toEqual({ route: '/t/:slug/weddings/:id', tenant: 'demo' })
    expect(routePattern('/t/demo/reset?token=reset_supersecret')).toEqual({ route: '/t/:slug/reset', tenant: 'demo' })
    expect(routePattern('/admin/tenants/tenant_9/owner')).toEqual({ route: '/admin/tenants/:id/owner' })
    expect(routePattern('/healthz')).toEqual({ route: '/healthz' })
    expect(routePattern('/t/demo/guest-list/guest-add')).toEqual({ route: '/t/:slug/guest-list/guest-add', tenant: 'demo' })
    expect(routePattern('/t/demo/weddings/wedding_1/households/household_2')).toEqual({ route: '/t/:slug/weddings/:id/households/:id', tenant: 'demo' })
    expect(routePattern('/')).toEqual({ route: '/' })
    // A path segment that is not a valid slug yields no tenant (and is never echoed).
    expect(routePattern('/t/Not A Slug!/login')).toEqual({ route: '/t/:slug/login' })
    expect(routePattern('/sms:+15551234567/jo@example.test')).toEqual({ route: '/:id/:id' })
  })

  it('logs only known methods by name and formats keys in a fixed order', () => {
    expect(logMethod('post')).toBe('POST')
    expect(logMethod('BREW <script>')).toBe('OTHER')
    expect(formatRequestLog({ ts: 't', method: 'GET', route: '/healthz', status: 200, duration_ms: 1.5 })).toBe(
      '{"ts":"t","method":"GET","route":"/healthz","status":200,"duration_ms":1.5}',
    )
  })
})

describe('request logging through the real socket adapter', () => {
  const servers: { close(): void }[] = []
  afterEach(() => {
    for (const server of servers.splice(0)) server.close()
  })

  it('writes one line per request carrying no token, cookie, body, query or contact detail', async () => {
    const s = surface()
    const lines: string[] = []
    let ticks = 0
    const server = createProductWebUiServer(s.ui, {
      write: (line) => lines.push(line),
      clock: new ManualClock('2027-06-01T12:00:00.000Z'),
      elapsedMs: () => (ticks += 2.5),
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const secrets = [
      OP,
      WEBHOOK,
      'reset_supersecret',
      'session_cookie_value',
      'jo@couple.test',
      '+15550100',
      'my secret password!!',
    ]
    await fetch(`${base}/healthz`)
    await fetch(`${base}/t/demo/reset?token=reset_supersecret`, { headers: { cookie: 'wp_session=session_cookie_value' } })
    await fetch(`${base}/t/demo/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'jo@couple.test', password: 'my secret password!!' }),
    })
    await fetch(`${base}/t/demo/messaging/inbound`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WEBHOOK}`, 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'sms', from_ref: 'sms:+15550100', text: 'hi', provider_message_ref: 'p1' }),
    })
    await fetch(`${base}/admin/outbox`, { headers: { authorization: `Bearer ${OP}` } })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(lines).toHaveLength(5)
    for (const line of lines) {
      for (const secret of secrets) expect(line).not.toContain(secret)
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual(
        expect.arrayContaining(['duration_ms', 'method', 'route', 'status', 'ts']),
      )
    }
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      { ts: '2027-06-01T12:00:00.000Z', method: 'GET', route: '/healthz', status: 200, duration_ms: 2.5 },
      { ts: '2027-06-01T12:00:00.000Z', method: 'GET', route: '/t/:slug/reset', status: 200, duration_ms: 2.5, tenant: 'demo' },
      { ts: '2027-06-01T12:00:00.000Z', method: 'POST', route: '/t/:slug/sessions', status: 401, duration_ms: 2.5, tenant: 'demo' },
      { ts: '2027-06-01T12:00:00.000Z', method: 'POST', route: '/t/:slug/messaging/inbound', status: 202, duration_ms: 2.5, tenant: 'demo' },
      { ts: '2027-06-01T12:00:00.000Z', method: 'GET', route: '/admin/outbox', status: 200, duration_ms: 2.5 },
    ])
  })
})

describe('server errors — captured by code, never by message', () => {
  it('files a WeddingPlannerError under its code and anything else as UNHANDLED.<Name>', () => {
    expect(errorCode(new WeddingPlannerError('PERSISTENCE.STORAGE_FAILED', 'x'))).toBe('PERSISTENCE.STORAGE_FAILED')
    expect(errorCode(new TypeError('boom'))).toBe('UNHANDLED.TypeError')
    expect(errorCode('a string')).toBe('UNHANDLED.string')
  })

  it('frames never carry a line of the message, even a message line that starts with "at "', () => {
    const error = new SyntaxError('Unexpected token in "x\n    at jo@couple.test sms:+15550100 reset?token=abc123"\nat /etc/passwd:1:1')
    const frames = stackFrames(error)
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) {
      expect(frame).toMatch(/^at .*:\d+:\d+\)?$/)
      expect(frame).not.toContain('jo@couple.test')
      expect(frame).not.toContain('/etc/passwd')
    }
    // The name is filtered like the code.
    const named = new Error('x')
    named.name = 'jo@couple.test'
    expect(errorName(named)).toBe('Unknown')
    const log = new ErrorLog(new ManualClock('2027-06-01T00:00:00.000Z'), new SequentialIdGenerator('n'))
    log.record(named, { method: 'GET', path: '/healthz' })
    log.record(error, { method: 'GET', path: '/healthz' })
    expect(JSON.stringify(log.recent(5))).not.toMatch(/jo@couple\.test|passwd|abc123/)
  })

  it('a storage failure is not written back to the failing store', () => {
    const log = new ErrorLog(new ManualClock('2027-06-01T00:00:00.000Z'), new SequentialIdGenerator('s'))
    log.record(new WeddingPlannerError('PERSISTENCE.STORAGE_FAILED', 'disk full'), { method: 'POST', path: '/t/demo/weddings' })
    expect(log.recent(5)).toEqual([])
  })

  it('a 500 is recorded with code, location and route — and nothing from the message or request', () => {
    const inner = new InMemoryRecordStore()
    let fail = false
    const store: RecordStore = {
      get: (c, p, k) => inner.get(c, p, k),
      list: (c, p) => inner.list(c, p),
      listByKeyPrefix: (c, p, x) => inner.listByKeyPrefix(c, p, x),
      delete: (c, p, k) => inner.delete(c, p, k),
      isEmpty: (c) => inner.isEmpty(c),
      transaction: (fn) => inner.transaction(fn),
      put: (c, p, k, r) => {
        if (fail && c.name === COLLECTIONS.wedding.name) throw new SyntaxError('Unexpected token in "jo@couple.test +15550100"')
        inner.put(c, p, k, r)
      },
    }
    const s = surface({ store })
    const token = (s.api.handle(req('POST', '/t/demo/sessions', undefined, { role: 'planner' })).body as { token: string }).token
    fail = true
    const res = s.api.handle(req('POST', '/t/demo/weddings', token, { couple_display_name: 'Jo & Lee', event_date: '2028-01-01' }))
    expect(res).toEqual({ status: 500, body: { error: 'internal_error' } })
    const errors = (s.api.handle(req('GET', '/admin/errors', OP)).body as { errors: Record<string, unknown>[] }).errors
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'UNHANDLED.SyntaxError', name: 'SyntaxError', method: 'POST', route: '/t/:slug/weddings', tenant: 'demo' })
    expect((errors[0]?.frames as string[]).length).toBeGreaterThan(0)
    const text = JSON.stringify(errors)
    for (const leak of ['jo@couple.test', '+15550100', 'Jo & Lee', token]) expect(text).not.toContain(leak)
    // Client errors (4xx) are not server faults and are not recorded.
    s.api.handle(req('GET', '/t/demo/weddings/missing', token))
    expect((s.api.handle(req('GET', '/admin/errors', OP)).body as { errors: unknown[] }).errors).toHaveLength(1)
  })

  it('/admin/errors is operator-only; the log is bounded and never throws', () => {
    const s = surface()
    expect(s.api.handle(req('GET', '/admin/errors')).status).toBe(401)
    const log = new ErrorLog(new ManualClock('2027-06-01T00:00:00.000Z'), new SequentialIdGenerator('e'), undefined, 2)
    for (const n of [1, 2, 3]) log.record(new RangeError(`n${n}`), { method: 'GET', path: '/healthz' })
    expect(log.recent(10)).toHaveLength(2)
    const broken: RecordStore = { ...new InMemoryRecordStore(), put: () => { throw new Error('disk full') } } as unknown as RecordStore
    expect(() => new ErrorLog(new ManualClock('2027-06-01T00:00:00.000Z'), new SequentialIdGenerator('x'), broken).record(new Error('x'), { method: 'GET', path: '/' })).not.toThrow()
  })

  it('the operator console lists errors', () => {
    const s = surface()
    const signIn = s.ui.handle({ method: 'POST', path: '/admin/login', headers: { 'content-type': 'application/x-www-form-urlencoded' }, rawBody: `token=${OP}` })
    const cookie = `wp_operator=${/wp_operator=([^;]+)/.exec(signIn.headers['set-cookie'] ?? '')?.[1]}`
    const page = s.ui.handle({ method: 'GET', path: '/admin/errors', headers: { cookie } })
    expect(page.status).toBe(200)
    expect(page.body).toContain('No server errors recorded.')
  })
})

describe('/healthz names the build', () => {
  it('reports the commit passed in, or unknown', () => {
    expect(surface({ buildCommit: '2aa8f45' }).api.handle(req('GET', '/healthz'))).toEqual({ status: 200, body: { status: 'ok', commit: '2aa8f45' } })
    expect(surface().api.handle(req('GET', '/healthz'))).toEqual({ status: 200, body: { status: 'ok', commit: 'unknown' } })
  })
})
