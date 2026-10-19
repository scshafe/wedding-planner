import { ManualClock, SequentialIdGenerator } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface } from '@wedding-planner/product'

/**
 * Issue #9: the operator-only JSON surface of the email outbox and the console-session mint. Operator auth is the
 * first statement of every /admin route, so an unauthenticated or tenant caller gets the same constant 401 here
 * as anywhere under /admin.
 */

const OP = 'outbox-operator-token-0123456789'
const UNAUTHORIZED = { status: 401, body: { error: 'unauthorized' } }

function surface() {
  return composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('outbox'),
    operatorToken: OP,
    providerWebhookToken: 'outbox-webhook-token-0123456789',
    demoSlug: 'demo',
  })
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

describe('GET/POST /admin/outbox — operator only', () => {
  it('no credential, a wrong one, or a TENANT session gets the constant 401 (and nothing is sent)', () => {
    const { api, email } = surface()
    const tenantSession = (api.handle(req('POST', '/t/demo/sessions', { body: { role: 'planner' } })).body as { token: string })
      .token
    for (const token of [undefined, 'wrong-token-0123456789', tenantSession]) {
      expect(api.handle(req('GET', '/admin/outbox', { token }))).toEqual(UNAUTHORIZED)
      expect(api.handle(req('POST', '/admin/outbox', { token, body: { to: 'x@example.test' } }))).toEqual(UNAUTHORIZED)
    }
    expect(email.recent(10)).toEqual([])
  })

  it('the operator sends a test message and reads it back, newest first', () => {
    const { api } = surface()
    expect(api.handle(req('POST', '/admin/outbox', { token: OP, body: { to: 'first@example.test' } })).status).toBe(201)
    expect(api.handle(req('POST', '/admin/outbox', { token: OP, body: { to: ' second@example.test ' } })).status).toBe(201)
    const res = api.handle(req('GET', '/admin/outbox', { token: OP }))
    expect(res.status).toBe(200)
    const messages = (res.body as { messages: { to: string; purpose: string; subject: string }[] }).messages
    expect(messages.map((m) => m.to)).toEqual(['second@example.test', 'first@example.test'])
    expect(messages.every((m) => m.purpose === 'operator_test')).toBe(true)
  })

  it('a malformed test recipient is a 400 and records nothing; other methods are 405 after auth', () => {
    const { api, email } = surface()
    expect(api.handle(req('POST', '/admin/outbox', { token: OP, body: { to: 'nope' } })).status).toBe(400)
    expect(api.handle(req('POST', '/admin/outbox', { token: OP, body: {} })).status).toBe(400)
    expect(api.handle(req('POST', '/admin/outbox', { token: OP, body: { to: 'a@b.co\nBcc: c@d.ef' } })).status).toBe(400)
    expect(email.recent(10)).toEqual([])
    expect(api.handle(req('DELETE', '/admin/outbox', { token: OP })).status).toBe(405)
  })
})

describe('POST/DELETE /admin/sessions — operator console sessions', () => {
  it('the static credential mints a session that authenticates /admin; the session cannot mint another', () => {
    const { api } = surface()
    const res = api.handle(req('POST', '/admin/sessions', { token: OP }))
    expect(res.status).toBe(201)
    const session = res.body as { token: string; csrf_token: string; expires_at: string }
    expect(session.expires_at).toBe('2027-06-01T12:00:00.000Z')
    expect(session.token).not.toBe(OP)
    expect(api.handle(req('GET', '/admin/outbox', { token: session.token })).status).toBe(200)
    expect(api.handle(req('POST', '/admin/sessions', { token: session.token })).status).toBe(403)
    expect(api.handle(req('POST', '/admin/sessions'))).toEqual(UNAUTHORIZED)
  })

  it('DELETE revokes the presented session server-side', () => {
    const { api } = surface()
    const session = api.handle(req('POST', '/admin/sessions', { token: OP })).body as { token: string }
    expect(api.handle(req('DELETE', '/admin/sessions', { token: session.token }))).toEqual({
      status: 200,
      body: { signed_out: true },
    })
    expect(api.handle(req('GET', '/admin/outbox', { token: session.token }))).toEqual(UNAUTHORIZED)
    // The static credential still works.
    expect(api.handle(req('GET', '/admin/outbox', { token: OP })).status).toBe(200)
  })

  it('DELETE with the static credential signs out every console session', () => {
    const { api } = surface()
    const a = api.handle(req('POST', '/admin/sessions', { token: OP })).body as { token: string }
    const b = api.handle(req('POST', '/admin/sessions', { token: OP })).body as { token: string }
    expect(api.handle(req('DELETE', '/admin/sessions', { token: OP }))).toEqual({ status: 200, body: { signed_out: true } })
    expect(api.handle(req('GET', '/admin/outbox', { token: a.token }))).toEqual(UNAUTHORIZED)
    expect(api.handle(req('GET', '/admin/outbox', { token: b.token }))).toEqual(UNAUTHORIZED)
  })

  it('a session does not reach tenant routes (separate token namespaces)', () => {
    const { api } = surface()
    const session = api.handle(req('POST', '/admin/sessions', { token: OP })).body as { token: string }
    expect(api.handle(req('GET', '/t/demo/weddings', { token: session.token }))).toEqual(UNAUTHORIZED)
  })
})
