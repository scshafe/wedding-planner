import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, type ApiResponse, composeProductSurface } from '@wedding-planner/product'

/**
 * Issue #11 — invitations and members through the HTTP edge. A planner invites a teammate or a wedding's couple; the
 * invitation is a single-use, expiring link through the outbox; accepting creates the account and signs it in; the
 * owner sees, resends and revokes invitations and removes members; and an invited couple sees only its own wedding.
 */

const OP = 'team-operator-token-0123456789'
const THEME: Tenant['theme'] = { brand_name: 'Acme Weddings', primary_color_hex: '#123456', accent_color_hex: '#654321', logo_ref: 'acme' }
const PASSWORD = 'a perfectly long password'
const UNAUTHORIZED: ApiResponse = { status: 401, body: { error: 'unauthorized' } }
const FORBIDDEN: ApiResponse = { status: 403, body: { error: 'forbidden' } }
const NOT_FOUND: ApiResponse = { status: 404, body: { error: 'not_found' } }

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

function setup() {
  const clock = new ManualClock('2027-06-01T00:00:00.000Z')
  const { api } = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator('team'),
    operatorToken: OP,
    providerWebhookToken: 'team-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const call = (method: string, path: string, token?: string, body?: unknown): ApiResponse =>
    api.handle(req(method, path, { ...(token === undefined ? {} : { token }), ...(body === undefined ? {} : { body }) }))
  const acmeId = (call('POST', '/admin/tenants', OP, { slug: 'acme', display_name: 'Acme', plan_tier: 'solo', theme: THEME }).body as { tenant: { tenant_id: string } }).tenant.tenant_id
  call('POST', `/admin/tenants/${acmeId}/activate`, OP)
  const outbox = () => (call('GET', '/admin/outbox', OP).body as { messages: { to: string; subject: string; text_body: string; purpose: string }[] }).messages
  const lastLink = (): string => /token=([A-Za-z0-9_-]+)/.exec(outbox()[0]?.text_body ?? '')?.[1] as string
  // The owner: set up by the operator, password chosen through the setup link, signed in.
  call('POST', `/admin/tenants/${acmeId}/owner`, OP, { email: 'owner@acme.test' })
  call('POST', '/t/acme/password-reset/complete', undefined, { token: lastLink(), password: PASSWORD })
  const ownerToken = (call('POST', '/t/acme/sessions', undefined, { email: 'owner@acme.test', password: PASSWORD }).body as { token: string }).token
  const createWedding = (name: string): string =>
    (call('POST', '/t/acme/weddings', ownerToken, { couple_display_name: name, event_date: '2028-05-05' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
  /** Invite, then accept the emailed link; returns the new member's session token and principal. */
  const join = (inviterToken: string, body: { email: string; role: string; wedding_id?: string }) => {
    expect(call('POST', '/t/acme/invitations', inviterToken, body).status).toBe(201)
    const res = call('POST', '/t/acme/invitations/accept', undefined, { token: lastLink(), password: PASSWORD })
    expect(res.status).toBe(201)
    return res.body as { token: string; principal: { principal_id: string; role: string; wedding_id?: string } }
  }
  return { clock, call, outbox, lastLink, ownerToken, createWedding, join }
}

describe('inviting a teammate', () => {
  it('a planner invites; the link arrives through the outbox; accepting creates the account and signs it in', () => {
    const w = setup()
    const res = w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'Teammate@Acme.test', role: 'planner' })
    expect(res.status).toBe(201)
    expect((res.body as { invitation: Record<string, unknown> }).invitation).toMatchObject({
      email: 'teammate@acme.test',
      role: 'planner',
      expires_at: '2027-06-08T00:00:00.000Z',
    })
    const [mail] = w.outbox()
    expect(mail).toMatchObject({ to: 'teammate@acme.test', purpose: 'invitation', subject: "You're invited to Acme Weddings" })
    expect(mail?.text_body).toContain('to join the Acme Weddings workspace as a planner')
    expect(mail?.text_body).toContain('/t/acme/invite?token=invite_')
    expect(mail?.text_body).not.toContain(w.ownerToken)
    const accepted = w.call('POST', '/t/acme/invitations/accept', undefined, { token: w.lastLink(), password: PASSWORD })
    expect(accepted.status).toBe(201)
    const { token, principal } = accepted.body as { token: string; principal: { role: string } }
    expect(principal.role).toBe('planner')
    expect(w.call('GET', '/t/acme/weddings', token).status).toBe(200)
    // The new member signs in with the password they chose.
    expect(w.call('POST', '/t/acme/sessions', undefined, { email: 'teammate@acme.test', password: PASSWORD }).status).toBe(201)
  })

  it('refuses a duplicate: an existing member or a pending invitation is an honest 409', () => {
    const w = setup()
    expect(w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'owner@acme.test', role: 'planner' }).status).toBe(409)
    expect(w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'p@acme.test', role: 'planner' }).status).toBe(201)
    expect(w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'P@acme.test', role: 'planner' }).status).toBe(409)
    expect(w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'nope', role: 'planner' }).status).toBe(400)
    expect(w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'x@acme.test', role: 'owner' }).status).toBe(400)
    expect(w.call('POST', '/t/acme/invitations', undefined, { email: 'x@acme.test', role: 'planner' })).toEqual(UNAUTHORIZED)
  })

  it('the link works once, never burns on a weak password, expires after 7 days, and only on its own tenant', () => {
    const w = setup()
    w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'a@acme.test', role: 'planner' })
    const token = w.lastLink()
    expect(w.call('POST', '/t/demo/invitations/accept', undefined, { token, password: PASSWORD })).toEqual({ status: 400, body: { error: 'invalid_link' } })
    expect(w.call('POST', '/t/acme/invitations/accept', undefined, { token, password: 'short' })).toEqual({ status: 400, body: { error: 'weak_password' } })
    expect(w.call('POST', '/t/acme/invitations/accept', undefined, { token, password: PASSWORD }).status).toBe(201)
    expect(w.call('POST', '/t/acme/invitations/accept', undefined, { token, password: PASSWORD })).toEqual({ status: 400, body: { error: 'invalid_link' } })
    w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'b@acme.test', role: 'planner' })
    const late = w.lastLink()
    w.clock.advance(7 * 24 * 60 * 60 * 1000)
    expect(w.call('POST', '/t/acme/invitations/accept', undefined, { token: late, password: PASSWORD })).toEqual({ status: 400, body: { error: 'invalid_link' } })
  })
})

describe('inviting a couple — and the couple sees only its own wedding', () => {
  it('a couple invited to a wedding signs in bound to that wedding; every other wedding is masked', () => {
    const w = setup()
    const ours = w.createWedding('Jo & Lee')
    const theirs = w.createWedding('Sam & Kit')
    const couple = w.join(w.ownerToken, { email: 'jo@couple.test', role: 'couple', wedding_id: ours })
    expect(couple.principal).toMatchObject({ role: 'couple', wedding_id: ours })
    const list = w.call('GET', '/t/acme/weddings', couple.token)
    expect((list.body as { weddings: { wedding_id: string }[] }).weddings.map((x) => x.wedding_id)).toEqual([ours])
    expect(w.call('GET', `/t/acme/weddings/${ours}`, couple.token).status).toBe(200)
    expect(w.call('GET', `/t/acme/weddings/${theirs}`, couple.token)).toEqual(NOT_FOUND)
    expect(w.call('GET', `/t/acme/weddings/wedding_never_made`, couple.token)).toEqual(NOT_FOUND)
    // Planner-only capabilities stay planner-only.
    expect(w.call('GET', '/t/acme/billing', couple.token)).toEqual(FORBIDDEN)
    expect(w.call('GET', '/t/acme/team', couple.token)).toEqual(FORBIDDEN)
    expect(w.call('POST', '/t/acme/invitations', couple.token, { email: 'x@acme.test', role: 'planner' })).toEqual(FORBIDDEN)
    expect(w.call('POST', '/t/acme/weddings', couple.token, { couple_display_name: 'X', event_date: '2028-01-01' })).toEqual(FORBIDDEN)
  })

  it('the couple invitation names the wedding and needs one of this workspace', () => {
    const w = setup()
    const ours = w.createWedding('Jo & Lee')
    expect(w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'c@couple.test', role: 'couple', wedding_id: ours }).status).toBe(201)
    expect(w.outbox()[0]?.text_body).toContain("to plan Jo & Lee's wedding with Acme Weddings")
    expect(w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'd@couple.test', role: 'couple' }).status).toBe(400)
    expect(w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'd@couple.test', role: 'couple', wedding_id: 'wedding_elsewhere' }).status).toBe(400)
  })
})

describe('the owner manages invitations and members', () => {
  it('the team lists members (no password hashes) and pending invitations; only the owner may manage', () => {
    const w = setup()
    const teammate = w.join(w.ownerToken, { email: 'p@acme.test', role: 'planner' })
    w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'pending@acme.test', role: 'planner' })
    const ownerView = w.call('GET', '/t/acme/team', w.ownerToken).body as { members: Record<string, unknown>[]; invitations: { email: string }[]; viewer_is_owner: boolean }
    expect(ownerView.viewer_is_owner).toBe(true)
    expect(ownerView.members.map((m) => m.email)).toEqual(['owner@acme.test', 'p@acme.test'])
    expect(JSON.stringify(ownerView)).not.toContain('"hash"')
    expect(ownerView.invitations.map((i) => i.email)).toEqual(['pending@acme.test'])
    const plannerView = w.call('GET', '/t/acme/team', teammate.token).body as { viewer_is_owner: boolean }
    expect(plannerView.viewer_is_owner).toBe(false)
    expect(w.call('POST', '/t/acme/invitations/revoke', teammate.token, { invitation_id: 'x' })).toEqual(FORBIDDEN)
    expect(w.call('POST', '/t/acme/members/remove', teammate.token, { user_id: 'x' })).toEqual(FORBIDDEN)
  })

  it('resend sends a fresh link (the old one dies); revoke kills the link', () => {
    const w = setup()
    const invited = w.call('POST', '/t/acme/invitations', w.ownerToken, { email: 'p@acme.test', role: 'planner' }).body as { invitation: { invitation_id: string } }
    const first = w.lastLink()
    expect(w.call('POST', '/t/acme/invitations/resend', w.ownerToken, { invitation_id: invited.invitation.invitation_id }).body).toEqual({ resent: true })
    const second = w.lastLink()
    expect(second).not.toBe(first)
    expect(w.call('POST', '/t/acme/invitations/accept', undefined, { token: first, password: PASSWORD }).status).toBe(400)
    expect(w.call('POST', '/t/acme/invitations/revoke', w.ownerToken, { invitation_id: invited.invitation.invitation_id }).body).toEqual({ revoked: true })
    expect(w.call('POST', '/t/acme/invitations/accept', undefined, { token: second, password: PASSWORD }).status).toBe(400)
    expect(w.call('POST', '/t/acme/invitations/revoke', w.ownerToken, { invitation_id: invited.invitation.invitation_id }).body).toEqual({ revoked: false })
  })

  it('removing a member ends their sessions and their account; the owner cannot remove themselves', () => {
    const w = setup()
    const teammate = w.join(w.ownerToken, { email: 'p@acme.test', role: 'planner' })
    expect(w.call('POST', '/t/acme/members/remove', w.ownerToken, { user_id: teammate.principal.principal_id }).body).toEqual({ removed: true })
    expect(w.call('GET', '/t/acme/weddings', teammate.token)).toEqual(UNAUTHORIZED)
    expect(w.call('POST', '/t/acme/sessions', undefined, { email: 'p@acme.test', password: PASSWORD })).toEqual(UNAUTHORIZED)
    const owner = (w.call('GET', '/t/acme/team', w.ownerToken).body as { viewer_id: string }).viewer_id
    expect(w.call('POST', '/t/acme/members/remove', w.ownerToken, { user_id: owner }).status).toBe(409)
    expect(w.call('POST', '/t/acme/members/remove', w.ownerToken, { user_id: 'user_nobody' }).body).toEqual({ removed: false })
  })

  it('a demo (simulated) planner can invite but is never the owner', () => {
    const w = setup()
    const demo = (w.call('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
    expect(w.call('POST', '/t/demo/invitations', demo, { email: 'friend@demo.test', role: 'planner' }).status).toBe(201)
    expect((w.call('GET', '/t/demo/team', demo).body as { viewer_is_owner: boolean }).viewer_is_owner).toBe(false)
  })
})
