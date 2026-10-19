import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { type ApiRequest, composeProductSurface, type HttpResult } from '@wedding-planner/product'

/**
 * Issue #11 in the browser: the Team page (members, pending invitations, owner-only management), CSRF on every team
 * form, "Invite the couple" on a wedding for planners only, and the accept page that creates the account and signs in.
 */

const OP = 'team-web-operator-token-0123456789'
const THEME: Tenant['theme'] = { brand_name: 'Acme Weddings', primary_color_hex: '#123456', accent_color_hex: '#654321', logo_ref: 'acme' }
const PASSWORD = 'a perfectly long password'

function get(path: string, cookie?: string): ApiRequest {
  return { method: 'GET', path, headers: cookie === undefined ? {} : { cookie } }
}

function form(path: string, fields: Record<string, string>, cookie?: string): ApiRequest {
  return {
    method: 'POST',
    path,
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie === undefined ? {} : { cookie }) },
    rawBody: new URLSearchParams(fields).toString(),
  }
}

const csrfOf = (page: HttpResult): string => /name="_csrf" value="([^"]+)"/.exec(page.body)?.[1] as string
const sessionCookie = (res: HttpResult): string => `wp_session=${/wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]}`

function setup() {
  const surface = composeProductSurface({
    clock: new ManualClock('2027-06-01T00:00:00.000Z'),
    ids: new SequentialIdGenerator('tw'),
    operatorToken: OP,
    providerWebhookToken: 'team-web-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const api = (method: string, path: string, token: string | undefined, body?: unknown) =>
    surface.api.handle({
      method,
      path,
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      rawBody: body === undefined ? undefined : JSON.stringify(body),
    })
  const acmeId = (api('POST', '/admin/tenants', OP, { slug: 'acme', display_name: 'Acme', plan_tier: 'solo', theme: THEME }).body as { tenant: { tenant_id: string } }).tenant.tenant_id
  api('POST', `/admin/tenants/${acmeId}/activate`, OP)
  const lastLink = (): string =>
    /token=([A-Za-z0-9_-]+)/.exec((api('GET', '/admin/outbox', OP).body as { messages: { text_body: string }[] }).messages[0]?.text_body ?? '')?.[1] as string
  api('POST', `/admin/tenants/${acmeId}/owner`, OP, { email: 'owner@acme.test' })
  api('POST', '/t/acme/password-reset/complete', undefined, { token: lastLink(), password: PASSWORD })
  const ownerToken = (api('POST', '/t/acme/sessions', undefined, { email: 'owner@acme.test', password: PASSWORD }).body as { token: string }).token
  const owner = `wp_session=${ownerToken}`
  const weddingId = (api('POST', '/t/acme/weddings', ownerToken, { couple_display_name: 'Jo & Lee', event_date: '2028-05-05' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
  /** Accept the latest invitation link through the browser; returns the new member's session cookie. */
  const acceptLatest = (): string => {
    const token = lastLink()
    const page = surface.ui.handle(get(`/t/acme/invite?token=${token}`))
    const pre = `wp_pre=${/wp_pre=([^;]+)/.exec(page.headers['set-cookie'] ?? '')?.[1]}`
    const res = surface.ui.handle(form('/t/acme/invite', { _csrf: csrfOf(page), token, password: PASSWORD, confirm: PASSWORD }, pre))
    expect(res.status).toBe(303)
    return sessionCookie(res)
  }
  return { ...surface, api, owner, ownerToken, weddingId, lastLink, acceptLatest }
}

describe('the Team page', () => {
  it('the owner sees members and invitations with Resend / Revoke / Remove (but no Remove on themselves)', () => {
    const w = setup()
    const page = w.ui.handle(get('/t/acme?view=team', w.owner))
    w.ui.handle(form('/t/acme/team/invite', { _csrf: csrfOf(page), role: 'planner', email: 'p@acme.test' }, w.owner))
    const teammate = w.acceptLatest()
    w.ui.handle(form('/t/acme/team/invite', { _csrf: csrfOf(page), role: 'planner', email: 'pending@acme.test' }, w.owner))
    const team = w.ui.handle(get('/t/acme?view=team', w.owner))
    expect(team.status).toBe(200)
    expect(team.body).toContain('p@acme.test')
    expect(team.body).toContain('pending@acme.test')
    expect(team.body).toContain('action="/t/acme/team/resend"')
    expect(team.body).toContain('action="/t/acme/team/revoke"')
    expect((team.body.match(/action="\/t\/acme\/team\/remove"/g) ?? []).length).toBe(1) // the teammate, not the owner
    // A non-owner planner sees the team and the invite form, but no management buttons.
    const plannerView = w.ui.handle(get('/t/acme?view=team', teammate))
    expect(plannerView.body).toContain('action="/t/acme/team/invite"')
    expect(plannerView.body).not.toContain('action="/t/acme/team/revoke"')
    expect(plannerView.body).not.toContain('action="/t/acme/team/remove"')
  })

  it('every team form is CSRF-checked: a forged token changes nothing', () => {
    const w = setup()
    const res = w.ui.handle(form('/t/acme/team/invite', { _csrf: 'forged', role: 'planner', email: 'x@acme.test' }, w.owner))
    expect(res.status).toBe(403)
    const team = w.api('GET', '/t/acme/team', w.ownerToken).body as { invitations: unknown[] }
    expect(team.invitations).toEqual([])
  })

  it('a couple gets the themed Forbidden page, and the home shows the Team card to planners only', () => {
    const w = setup()
    const page = w.ui.handle(get(`/t/acme?wedding=${w.weddingId}`, w.owner))
    w.ui.handle(form('/t/acme/team/invite', { _csrf: csrfOf(page), role: 'couple', wedding_id: w.weddingId, email: 'jo@couple.test' }, w.owner))
    const couple = w.acceptLatest()
    expect(w.ui.handle(get('/t/acme?view=team', couple)).status).toBe(403)
    expect(w.ui.handle(get('/t/acme', w.owner)).body).toContain('href="/t/acme?view=team"')
    expect(w.ui.handle(get('/t/acme', couple)).body).not.toContain('href="/t/acme?view=team"')
  })
})

describe('inviting the couple from a wedding', () => {
  it('planners get the form on the wedding; the couple then sees only that wedding and no invite form', () => {
    const w = setup()
    const detail = w.ui.handle(get(`/t/acme?wedding=${w.weddingId}`, w.owner))
    expect(detail.body).toContain('Invite the couple')
    const sent = w.ui.handle(
      form('/t/acme/team/invite', { _csrf: csrfOf(detail), role: 'couple', wedding_id: w.weddingId, email: 'jo@couple.test' }, w.owner),
    )
    expect(sent.headers.location).toBe(`/t/acme?wedding=${w.weddingId}&invite=sent`)
    expect(w.ui.handle(get(sent.headers.location ?? '', w.owner)).body).toContain('Invitation sent to the couple.')
    const couple = w.acceptLatest()
    const theirs = w.ui.handle(get(`/t/acme?wedding=${w.weddingId}`, couple))
    expect(theirs.status).toBe(200)
    expect(theirs.body).not.toContain('Invite the couple')
    expect(w.ui.handle(get('/t/acme?view=weddings', couple)).body).toContain('Jo &amp; Lee')
  })
})

describe('the invitation accept page', () => {
  it('keeps the token out of referrers, checks the confirmation, and refuses a used link', () => {
    const w = setup()
    w.api('POST', '/t/acme/invitations', w.ownerToken, { email: 'p@acme.test', role: 'planner' })
    const token = w.lastLink()
    const page = w.ui.handle(get(`/t/acme/invite?token=${token}`))
    expect(page.headers['referrer-policy']).toBe('no-referrer')
    const pre = `wp_pre=${/wp_pre=([^;]+)/.exec(page.headers['set-cookie'] ?? '')?.[1]}`
    const mismatch = w.ui.handle(form('/t/acme/invite', { _csrf: csrfOf(page), token, password: PASSWORD, confirm: 'different!!' }, pre))
    expect(mismatch.body).toContain('did not match')
    const forged = w.ui.handle(form('/t/acme/invite', { _csrf: 'forged', token, password: PASSWORD, confirm: PASSWORD }, pre))
    expect(forged.body).toContain('That form expired')
    const ok = w.ui.handle(form('/t/acme/invite', { _csrf: csrfOf(page), token, password: PASSWORD, confirm: PASSWORD }, pre))
    expect(ok.status).toBe(303)
    expect(ok.headers.location).toBe('/t/acme')
    const again = w.ui.handle(form('/t/acme/invite', { _csrf: csrfOf(page), token, password: PASSWORD, confirm: PASSWORD }, pre))
    expect(again.body).toContain('This invitation link is invalid, used or expired')
  })
})
