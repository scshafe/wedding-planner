import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface, InMemoryRecordStore } from '@wedding-planner/product'

/**
 * Issue #10 — real planner accounts through the HTTP edge: the operator sets up a workspace owner, the setup link
 * arrives through the outbox, the owner chooses a password and signs in; sign-in and reset requests give no
 * account-existence oracle; links are single-use and expire; rate limits apply; and the simulated role picker
 * survives only on the demo tenant in demo mode.
 */

const OP = 'accounts-operator-token-0123456789'
const WEBHOOK = 'accounts-webhook-token-0123456789'
const UNAUTHORIZED: ApiResponse = { status: 401, body: { error: 'unauthorized' } }
const THEME: Tenant['theme'] = { brand_name: 'Acme Weddings', primary_color_hex: '#123456', accent_color_hex: '#654321', logo_ref: 'acme' }
const PASSWORD = 'a perfectly long password'

function setup(options: { seedDemo?: boolean; publicUrl?: string } = {}) {
  const clock = new ManualClock('2027-06-01T00:00:00.000Z')
  const surface = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator('acct'),
    operatorToken: OP,
    providerWebhookToken: WEBHOOK,
    demoSlug: 'demo',
    seedDemo: options.seedDemo ?? true,
    passwordCost: { N: 16, r: 1, p: 1 },
    ...(options.publicUrl === undefined ? {} : { publicUrl: options.publicUrl }),
  })
  const api = surface.api
  // A second, real workspace: provisioned and activated by the operator.
  const created = api.handle(req('POST', '/admin/tenants', { token: OP, body: { slug: 'acme', display_name: 'Acme', plan_tier: 'solo', theme: THEME } }))
  const acmeId = (created.body as { tenant: { tenant_id: string } }).tenant.tenant_id
  expect(api.handle(req('POST', `/admin/tenants/${acmeId}/activate`, { token: OP })).status).toBe(200)
  const outbox = (): { to: string; subject: string; text_body: string; purpose: string }[] =>
    (api.handle(req('GET', '/admin/outbox', { token: OP })).body as { messages: { to: string; subject: string; text_body: string; purpose: string }[] }).messages
  const linkToken = (body: string): string => /token=([A-Za-z0-9_-]+)/.exec(body)?.[1] as string
  return { ...surface, clock, acmeId, outbox, linkToken }
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

/** Set up the acme owner and complete the setup link; returns the owner's user_id. */
function ownerWithPassword(w: ReturnType<typeof setup>, email = 'owner@acme.test'): string {
  const res = w.api.handle(req('POST', `/admin/tenants/${w.acmeId}/owner`, { token: OP, body: { email } }))
  expect(res.status).toBe(201)
  const token = w.linkToken(w.outbox()[0]?.text_body ?? '')
  expect(w.api.handle(req('POST', '/t/acme/password-reset/complete', { body: { token, password: PASSWORD } }))).toEqual({
    status: 200,
    body: { password_set: true },
  })
  return (res.body as { account: { user_id: string } }).account.user_id
}

function signIn(w: ReturnType<typeof setup>, email: string, password: string): ApiResponse {
  return w.api.handle(req('POST', '/t/acme/sessions', { body: { email, password } }))
}

describe('the operator sets up a workspace owner', () => {
  it('creates the owner account and emails a set-your-password link (no password, no session token in it)', () => {
    const w = setup({ publicUrl: 'https://planner.example' })
    const res = w.api.handle(req('POST', `/admin/tenants/${w.acmeId}/owner`, { token: OP, body: { email: 'Owner@Acme.test' } }))
    expect(res.status).toBe(201)
    const account = (res.body as { account: Record<string, unknown> }).account
    expect(account).toMatchObject({ email: 'owner@acme.test', role: 'owner', has_password: false })
    expect(Object.keys(account)).not.toContain('password')
    const [mail] = w.outbox()
    expect(mail).toMatchObject({ to: 'owner@acme.test', purpose: 'account_setup', subject: 'Set up your Acme Weddings account' })
    expect(mail?.text_body).toMatch(/^https:\/\/planner\.example\/t\/acme\/reset\?token=setup_/m)
    expect(mail?.text_body).not.toMatch(/session_/)
  })

  it('is operator-only, needs an existing tenant and a valid email, and a re-run sends a fresh link', () => {
    const w = setup()
    expect(w.api.handle(req('POST', `/admin/tenants/${w.acmeId}/owner`, { body: { email: 'o@acme.test' } }))).toEqual(UNAUTHORIZED)
    expect(w.api.handle(req('POST', `/admin/tenants/${w.acmeId}/owner`, { token: OP, body: { email: 'nope' } })).status).toBe(400)
    expect(w.api.handle(req('POST', '/admin/tenants/tenant_nope/owner', { token: OP, body: { email: 'o@acme.test' } })).status).toBe(404)
    // Re-running the setup for the same owner just sends a fresh link (the old one stops working).
    w.api.handle(req('POST', `/admin/tenants/${w.acmeId}/owner`, { token: OP, body: { email: 'o@acme.test' } }))
    const first = w.linkToken(w.outbox()[0]?.text_body ?? '')
    expect(w.api.handle(req('POST', `/admin/tenants/${w.acmeId}/owner`, { token: OP, body: { email: 'o@acme.test' } })).status).toBe(201)
    expect(w.api.handle(req('POST', '/t/acme/password-reset/complete', { body: { token: first, password: PASSWORD } })).status).toBe(400)
  })

  it('GET /admin/tenants lists every tenant for the operator only', () => {
    const w = setup()
    const res = w.api.handle(req('GET', '/admin/tenants', { token: OP }))
    expect((res.body as { tenants: { slug: string }[] }).tenants.map((t) => t.slug)).toEqual(['demo', 'acme'])
    expect(w.api.handle(req('GET', '/admin/tenants'))).toEqual(UNAUTHORIZED)
  })
})

describe('email + password sign-in', () => {
  it('signs the owner in as a planner principal whose id is the account', () => {
    const w = setup()
    const userId = ownerWithPassword(w)
    const res = signIn(w, 'OWNER@acme.test', PASSWORD)
    expect(res.status).toBe(201)
    const { token, principal } = res.body as { token: string; principal: Record<string, unknown> }
    expect(principal).toEqual({ principal_id: userId, tenant_id: w.acmeId, role: 'planner' })
    expect(w.api.handle(req('GET', '/t/acme/weddings', { token })).status).toBe(200)
    // The session is bound to its tenant like any other.
    expect(w.api.handle(req('GET', '/t/demo/weddings', { token }))).toEqual(UNAUTHORIZED)
  })

  it('every failure is the same 401: wrong password, unknown email, an account with no password yet', () => {
    const w = setup()
    ownerWithPassword(w)
    // Re-running the owner setup sends a new link but leaves the current password in place.
    w.api.handle(req('POST', `/admin/tenants/${w.acmeId}/owner`, { token: OP, body: { email: 'owner@acme.test' } }))
    expect(signIn(w, 'owner@acme.test', 'the wrong password!')).toEqual(UNAUTHORIZED)
    expect(signIn(w, 'nobody@acme.test', PASSWORD)).toEqual(UNAUTHORIZED)
    expect(signIn(w, 'owner@acme.test', 'x'.repeat(500))).toEqual(UNAUTHORIZED)
    expect(signIn(w, 'owner@acme.test', PASSWORD).status).toBe(201)
    const fresh = setup()
    fresh.api.handle(req('POST', `/admin/tenants/${fresh.acmeId}/owner`, { token: OP, body: { email: 'new@acme.test' } }))
    expect(signIn(fresh, 'new@acme.test', PASSWORD)).toEqual(UNAUTHORIZED)
  })

  it('rate-limits sign-in per submitted email (known or not) with the same 429, and a success resets it', () => {
    const w = setup()
    ownerWithPassword(w)
    for (const email of ['owner@acme.test', 'ghost@acme.test']) {
      for (let i = 0; i < 5; i++) expect(signIn(w, email, 'wrong password!!').status).toBe(401)
      expect(signIn(w, email, 'wrong password!!')).toEqual({ status: 429, body: { error: 'too_many_requests' } })
    }
    // Even the right password waits out the window...
    expect(signIn(w, 'owner@acme.test', PASSWORD).status).toBe(429)
    w.clock.advance(15 * 60 * 1000)
    expect(signIn(w, 'owner@acme.test', PASSWORD).status).toBe(201)
  })

  it('sign-out revokes a password session', () => {
    const w = setup()
    ownerWithPassword(w)
    const token = (signIn(w, 'owner@acme.test', PASSWORD).body as { token: string }).token
    expect(w.api.handle(req('DELETE', '/t/acme/sessions', { token })).status).toBe(200)
    expect(w.api.handle(req('GET', '/t/acme/weddings', { token }))).toEqual(UNAUTHORIZED)
  })
})

describe('password reset', () => {
  it('answers the same 202 for known and unknown emails; only a known one gets a link', () => {
    const w = setup()
    ownerWithPassword(w)
    const before = w.outbox().length
    const known = w.api.handle(req('POST', '/t/acme/password-reset', { body: { email: 'owner@acme.test' } }))
    const unknown = w.api.handle(req('POST', '/t/acme/password-reset', { body: { email: 'ghost@acme.test' } }))
    const malformed = w.api.handle(req('POST', '/t/acme/password-reset', { body: { email: 'not an email' } }))
    expect(known).toEqual({ status: 202, body: { status: 'accepted' } })
    expect(unknown).toEqual(known)
    expect(malformed).toEqual(known)
    const mails = w.outbox()
    expect(mails.length).toBe(before + 1)
    expect(mails[0]).toMatchObject({ to: 'owner@acme.test', purpose: 'password_reset', subject: 'Reset your Acme Weddings password' })
    expect(mails[0]?.text_body).toContain('/t/acme/reset?token=reset_')
    expect(mails[0]?.text_body).not.toContain(PASSWORD)
  })

  it('the link sets a new password once, ends every existing session, and the old password stops working', () => {
    const w = setup()
    ownerWithPassword(w)
    const session = (signIn(w, 'owner@acme.test', PASSWORD).body as { token: string }).token
    w.api.handle(req('POST', '/t/acme/password-reset', { body: { email: 'owner@acme.test' } }))
    const token = w.linkToken(w.outbox()[0]?.text_body ?? '')
    const complete = (password: string): ApiResponse =>
      w.api.handle(req('POST', '/t/acme/password-reset/complete', { body: { token, password } }))
    // A weak password is refused WITHOUT using the link up.
    expect(complete('short')).toEqual({ status: 400, body: { error: 'weak_password' } })
    expect(complete('my brand new password')).toEqual({ status: 200, body: { password_set: true } })
    expect(complete('another new password')).toEqual({ status: 400, body: { error: 'invalid_link' } })
    expect(w.api.handle(req('GET', '/t/acme/weddings', { token: session }))).toEqual(UNAUTHORIZED)
    expect(signIn(w, 'owner@acme.test', PASSWORD)).toEqual(UNAUTHORIZED)
    expect(signIn(w, 'owner@acme.test', 'my brand new password').status).toBe(201)
  })

  it('a link expires after an hour, and only works on its own tenant', () => {
    const w = setup()
    ownerWithPassword(w)
    w.api.handle(req('POST', '/t/acme/password-reset', { body: { email: 'owner@acme.test' } }))
    const token = w.linkToken(w.outbox()[0]?.text_body ?? '')
    expect(w.api.handle(req('POST', '/t/demo/password-reset/complete', { body: { token, password: 'a new long password' } }))).toEqual({
      status: 400,
      body: { error: 'invalid_link' },
    })
    w.clock.advance(60 * 60 * 1000)
    expect(w.api.handle(req('POST', '/t/acme/password-reset/complete', { body: { token, password: 'a new long password' } }))).toEqual({
      status: 400,
      body: { error: 'invalid_link' },
    })
  })

  it('rate-limits reset requests per submitted email with a 429', () => {
    const w = setup()
    for (let i = 0; i < 3; i++) expect(w.api.handle(req('POST', '/t/acme/password-reset', { body: { email: 'x@acme.test' } })).status).toBe(202)
    expect(w.api.handle(req('POST', '/t/acme/password-reset', { body: { email: 'x@acme.test' } })).status).toBe(429)
  })
})

describe('the simulated role picker survives only on the demo tenant, in demo mode', () => {
  it('works on the demo tenant and is refused on a real workspace', () => {
    const w = setup()
    expect(w.api.handle(req('POST', '/t/demo/sessions', { body: { role: 'planner' } })).status).toBe(201)
    expect(w.api.handle(req('POST', '/t/acme/sessions', { body: { role: 'planner' } }))).toEqual({ status: 400, body: { error: 'bad_request' } })
  })

  it('outside demo mode it is gone everywhere, and a simulated session minted before stops resolving', () => {
    const store = new InMemoryRecordStore()
    const compose = (seedDemo: boolean, seed: string) =>
      composeProductSurface({
        clock: new ManualClock('2027-06-01T00:00:00.000Z'),
        ids: new SequentialIdGenerator(seed),
        operatorToken: OP,
        providerWebhookToken: WEBHOOK,
        demoSlug: 'demo',
        seedDemo,
        store,
        passwordCost: { N: 16, r: 1, p: 1 },
      })
    const demoMode = compose(true, 'on')
    const token = (demoMode.api.handle(req('POST', '/t/demo/sessions', { body: { role: 'planner' } })).body as { token: string }).token
    expect(demoMode.api.handle(req('GET', '/t/demo/weddings', { token })).status).toBe(200)
    // The same data, restarted with WP_SEED_DEMO=false: no picker, and the old simulated session is dead.
    const real = compose(false, 'off')
    expect(real.api.handle(req('GET', '/t/demo/weddings', { token }))).toEqual(UNAUTHORIZED)
    expect(real.api.handle(req('POST', '/t/demo/sessions', { body: { role: 'planner' } })).status).toBe(400)
  })
})
