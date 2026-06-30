import { ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  GuestRegistry,
  type ApiRequest,
  type HttpResult,
  BillingLedger,
  DeterministicGuestQaResponder,
  EscalationLog,
  EscalationReplyLog,
  EscalationResolutionLog,
  InboundReceiptLog,
  MessagingService,
  OnboardingService,
  OperatorCredentialStore,
  ProviderWebhookCredentialStore,
  ProductApi,
  ProductWebUi,
  SessionStore,
  SimulatedMessagingAdapter,
  TenantContextResolver,
  TenantStore,
  ThemeResolver,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Phase 27 — the escalation Resolve/Dismiss browser flow + CSRF. Like guests, the web layer is the SOLE place
 * a cookie becomes a credential, so it is where CSRF lives; the JSON resolve API is Bearer-only and not
 * CSRF-reachable. A guest texts an unanswerable question (escalated) → the inbox shows it Open with Resolve/
 * Dismiss forms → a valid CSRF post moves it to Handled; a forged post is masked 403 with NO mutation; an
 * unknown slug masks to 404 BEFORE the CSRF verdict (no tenant-existence oracle).
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Acme Weddings',
  primary_color_hex: '#a1b2c3',
  accent_color_hex: '#445566',
  logo_ref: 'asset_logo_1',
}
const WH = 'wh-secret'

interface World {
  ui: ProductWebUi
  api: ProductApi
  messaging: MessagingService
  store: TenantStore
  clock: ManualClock
}

function makeWorld(): World {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const store = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  store.create({ slug: 'acme', display_name: 'Acme', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const sessions = new SessionStore(new SequentialIdGenerator('seedS'))
  const weddings = new WeddingRepository(store, clock, new SequentialIdGenerator('seedW'))
  const registry = new GuestRegistry(store)
  const billing = new BillingLedger(clock, new SequentialIdGenerator('seedB'))
  const adapter = new SimulatedMessagingAdapter(clock, new SequentialIdGenerator('seedM'))
  const escalations = new EscalationLog(store, new SequentialIdGenerator('seedEsc'))
  const resolutions = new EscalationResolutionLog(store, new SequentialIdGenerator('seedRes'), clock)
  const replies = new EscalationReplyLog(store, new SequentialIdGenerator('seedRep'), clock)
  const messaging = new MessagingService(adapter, store, billing, new SequentialIdGenerator('seedMS'))
  const guestAuthorizer = new GuestAuthorizer()
  const api = new ProductApi({
    resolver: new TenantContextResolver(store),
    sessionStore: sessions,
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedWH'), [WH]),
    onboarding: new OnboardingService(store, billing),
    weddings,
    authorizer: new WeddingAuthorizer(),
    guests: { registry, weddings, authorizer: guestAuthorizer },
    messaging: {
      port: adapter,
      receipts: new InboundReceiptLog(store, new SequentialIdGenerator('seedIR')),
      registry,
      weddings,
      responder: new DeterministicGuestQaResponder(),
      service: messaging,
      escalations,
      resolutions,
      replies,
    },
    escalations: { escalations, resolutions, replies, authorizer: guestAuthorizer, service: messaging },
  })
  return { ui: new ProductWebUi({ api, themes: new ThemeResolver(store), csrf: sessions }), api, messaging, store, clock }
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

function escalationIdFrom(html: string): string {
  const value = /name="escalation_id" value="([^"]+)"/.exec(html)?.[1]
  expect(value, 'open row should embed an escalation_id hidden field').toBeTruthy()
  return value as string
}

function loginCookie(ui: ProductWebUi, slug: string, role: string, weddingId?: string): string {
  const res = postForm(ui, `/t/${slug}/login`, { role, ...(weddingId ? { wedding_id: weddingId } : {}) })
  expect(res.status).toBe(303)
  const token = /wp_session=([^;]+)/.exec(res.headers['set-cookie'] ?? '')?.[1]
  return `wp_session=${token}`
}

/** Create a wedding (planner) + register a guest + drive an UNANSWERABLE inbound, leaving one OPEN escalation. */
function seedEscalation(api: ProductApi, slug: string): string {
  const login = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
  const token = (login.body as { token: string }).token
  const create = api.handle({
    method: 'POST',
    path: `/t/${slug}/weddings`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ couple_display_name: 'Alex & Sam', event_date: '2029-05-05' }),
  })
  const weddingId = (create.body as { wedding: { wedding_id: string } }).wedding.wedding_id
  api.handle({
    method: 'POST',
    path: `/t/${slug}/guests`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ recipient_ref: 'sms:+15550100', wedding_id: weddingId, guest_id: 'g1' }),
  })
  const inbound = api.handle({
    method: 'POST',
    path: `/t/${slug}/messaging/inbound`,
    headers: { authorization: `Bearer ${WH}`, 'content-type': 'application/json' },
    rawBody: JSON.stringify({ channel: 'sms', from_ref: 'sms:+15550100', text: 'where do I park?', provider_message_ref: 'pm_1' }),
  })
  expect(inbound.status).toBe(202)
  return weddingId
}

describe('escalation inbox web page (?view=escalations) + resolve flow', () => {
  it('a planner sees the Open question with Resolve/Dismiss forms carrying a _csrf field', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = get(ui, '/t/acme?view=escalations', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toContain('where do I park?')
    expect(res.body).toContain('action="/t/acme/escalations/resolve"')
    expect(res.body).toContain('name="_csrf"')
  })

  it('a valid CSRF resolve moves the question to Handled (PRG redirect → 303)', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const page = get(ui, '/t/acme?view=escalations', cookie).body
    const csrf = csrfFrom(page)
    const escId = escalationIdFrom(page)

    const resolved = postForm(ui, '/t/acme/escalations/resolve', { _csrf: csrf, escalation_id: escId, status: 'resolved' }, cookie)
    expect(resolved.status).toBe(303)
    expect(resolved.headers.location).toBe('/t/acme?view=escalations')

    const after = get(ui, '/t/acme?view=escalations', cookie).body
    expect(after).toContain('Handled')
    expect(after).toContain('Resolved by planner')
    // The question is no longer Open — no Resolve/Dismiss buttons or Reply form, but a Reopen affordance (Phase 36).
    expect(after).not.toContain('value="resolved"')
    expect(after).not.toContain('value="dismissed"')
    expect(after).not.toContain('action="/t/acme/escalations/reply"')
    expect(after).toContain('>Reopen<')
  })

  it('Phase 36: a planner resolves → reopens → replies, all via the browser forms (the full loop)', () => {
    const { ui, api, messaging, store } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const escId = escalationIdFrom(get(ui, '/t/acme?view=escalations', cookie).body)
    const tenantId = new TenantContextResolver(store).resolveBySlug('acme').tenant_id

    // Resolve.
    const p1 = get(ui, '/t/acme?view=escalations', cookie).body
    expect(postForm(ui, '/t/acme/escalations/resolve', { _csrf: csrfFrom(p1), escalation_id: escId, status: 'resolved' }, cookie).status).toBe(303)
    expect(get(ui, '/t/acme?view=escalations', cookie).body).toContain('Handled')

    // Reopen (the new affordance) → back to Open.
    const p2 = get(ui, '/t/acme?view=escalations', cookie).body
    expect(p2).toContain('>Reopen<')
    expect(postForm(ui, '/t/acme/escalations/resolve', { _csrf: csrfFrom(p2), escalation_id: escId, status: 'reopened' }, cookie).status).toBe(303)
    const reopened = get(ui, '/t/acme?view=escalations', cookie).body
    expect(reopened).not.toContain('Handled')
    expect(reopened).toContain('action="/t/acme/escalations/reply"') // Reply form is back

    // Reply on the reopened escalation → a metered send (the keystone-conditional path, end to end).
    expect(messaging.usageView(tenantId).message_count).toBe(0)
    expect(postForm(ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(reopened), escalation_id: escId, reply_text: 'Lot B.', seq: '0' }, cookie).status).toBe(303)
    expect(messaging.usageView(tenantId).message_count).toBe(1)
  })

  it('a forged CSRF resolve is masked 403 and performs NO mutation (stays Open)', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const escId = escalationIdFrom(get(ui, '/t/acme?view=escalations', cookie).body)

    const res = postForm(ui, '/t/acme/escalations/resolve', { _csrf: 'forged', escalation_id: escId, status: 'resolved' }, cookie)
    expect(res.status).toBe(403)
    // Still Open — the action form is back on the page.
    expect(get(ui, '/t/acme?view=escalations', cookie).body).toContain('action="/t/acme/escalations/resolve"')
  })

  it('a couple resolves THEIR wedding question via the form (303 → Handled)', () => {
    const { ui, api } = makeWorld()
    const weddingId = seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'couple', weddingId)
    const page = get(ui, '/t/acme?view=escalations', cookie).body
    const resolved = postForm(ui, '/t/acme/escalations/resolve', { _csrf: csrfFrom(page), escalation_id: escalationIdFrom(page), status: 'dismissed' }, cookie)
    expect(resolved.status).toBe(303)
    expect(get(ui, '/t/acme?view=escalations', cookie).body).toContain('Dismissed by couple')
  })

  it('a CSRF failure on an UNKNOWN tenant slug masks to GENERIC_404 BEFORE the CSRF verdict (no oracle)', () => {
    const { ui } = makeWorld()
    const res = postForm(ui, '/t/ghosttenant/escalations/resolve', { _csrf: 'forged', escalation_id: 'esc_x', status: 'resolved' })
    expect(res.status).toBe(404)
    expect(res.body).toContain('does not exist')
  })

  it('the JSON resolve API is NOT CSRF-reachable: a delegated POST with only a cookie (no Bearer) is 401', () => {
    const { ui } = makeWorld()
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = ui.handle({
      method: 'POST',
      path: '/t/acme/escalations',
      headers: { cookie, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ escalation_id: 'esc_x', status: 'resolved' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('escalation inbox web page — reply-from-the-inbox (Phase 28/34 multi-turn)', () => {
  const usageCount = (w: World): number => w.messaging.usageView(w.store.findBySlug('acme')!.tenant_id).message_count

  it('an Open question carries a Reply form (textarea reply_text + hidden seq) posting to the 4-seg reply route', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme')
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    const res = get(w.ui, '/t/acme?view=escalations', cookie)
    expect(res.body).toContain('action="/t/acme/escalations/reply"')
    expect(res.body).toContain('name="reply_text"')
    expect(res.body).toContain('name="seq" value="0"') // fresh thread → seq 0
  })

  it('a valid CSRF reply sends a metered message + appends to the thread, and the question STAYS OPEN (PRG 303)', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme')
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    const page = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    const sent = postForm(
      w.ui,
      '/t/acme/escalations/reply',
      { _csrf: csrfFrom(page), escalation_id: escalationIdFrom(page), reply_text: 'Parking is in lot B.', seq: '0' },
      cookie,
    )
    expect(sent.status).toBe(303)
    expect(usageCount(w)).toBe(1)
    const after = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    // DECOUPLED (Phase 34): the reply shows in the thread; the row stays OPEN (not Resolved), and the form now
    // carries seq=1 so a follow-up is a fresh send (a re-POST of seq=0 would dedup).
    expect(after).toContain('Planner: “Parking is in lot B.”')
    expect(after).not.toContain('Resolved by planner')
    expect(after).toContain('action="/t/acme/escalations/reply"') // still Open
    expect(after).toContain('name="seq" value="1"')
  })

  it('multi-turn: a second reply at seq=1 sends again (the thread grows)', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme')
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    const page = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    const escId = escalationIdFrom(page)
    postForm(w.ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(page), escalation_id: escId, reply_text: 'First.', seq: '0' }, cookie)
    const page2 = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    postForm(w.ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(page2), escalation_id: escId, reply_text: 'Second.', seq: '1' }, cookie)
    expect(usageCount(w)).toBe(2)
    const after = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    expect(after).toContain('Planner: “First.”')
    expect(after).toContain('Planner: “Second.”')
  })

  it('a forged CSRF reply is masked 403 and sends NOTHING (stays Open)', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme')
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    const escId = escalationIdFrom(get(w.ui, '/t/acme?view=escalations', cookie).body as string)
    const res = postForm(w.ui, '/t/acme/escalations/reply', { _csrf: 'forged', escalation_id: escId, reply_text: 'hi', seq: '0' }, cookie)
    expect(res.status).toBe(403)
    expect(usageCount(w)).toBe(0)
    expect(get(w.ui, '/t/acme?view=escalations', cookie).body).toContain('action="/t/acme/escalations/reply"')
  })

  it('a reply on an UNKNOWN tenant slug masks to GENERIC_404 BEFORE the CSRF verdict (no oracle)', () => {
    const { ui } = makeWorld()
    const res = postForm(ui, '/t/ghosttenant/escalations/reply', { _csrf: 'forged', escalation_id: 'esc_x', reply_text: 'hi', seq: '0' })
    expect(res.status).toBe(404)
    expect(res.body).toContain('does not exist')
  })
})

describe('escalation inbox web page — guest-reply thread correlation (Phase 35)', () => {
  /** Drive an UNANSWERABLE inbound follow-up from the SAME guest (fresh ref) → threads into the open escalation. */
  function followUp(api: ProductApi, slug: string, text: string, ref: string): void {
    const res = api.handle({
      method: 'POST',
      path: `/t/${slug}/messaging/inbound`,
      headers: { authorization: `Bearer ${WH}`, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ channel: 'sms', from_ref: 'sms:+15550100', text, provider_message_ref: ref }),
    })
    expect(res.status).toBe(202)
  }

  it('a guest follow-up renders as a "Guest:" turn in the thread, interleaved with an operator reply', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme') // opens E1 (the guest asked "where do I park?")
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    // The operator replies, then the guest texts a follow-up that threads in.
    const page = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    postForm(w.ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(page), escalation_id: escalationIdFrom(page), reply_text: 'Lot B.', seq: '0' }, cookie)
    followUp(w.api, 'acme', 'Can I bring my dog too?', 'pm_follow')
    const after = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    expect(after).toContain('Planner: “Lot B.”') // operator turn
    expect(after).toContain('Guest: “Can I bring my dog too?”') // guest turn (three-way label — NOT "Couple")
    expect(after).not.toContain('Couple: “Can I bring my dog too?”') // would be the binary-ternary mislabel
  })

  it('an UNTRUSTED guest follow-up body is HTML-escaped in the thread (no stored XSS into the operator view)', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme')
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    followUp(w.api, 'acme', "<script>alert('x')</script>", 'pm_xss')
    const after = get(w.ui, '/t/acme?view=escalations', cookie).body as string
    expect(after).toContain('Guest: “&lt;script&gt;') // escaped
    expect(after).not.toContain("<script>alert('x')</script>") // never raw
  })

  it('the reply form seq counts a guest turn (the operator double-submit guard stays correct)', () => {
    const w = makeWorld()
    seedEscalation(w.api, 'acme')
    const cookie = loginCookie(w.ui, 'acme', 'planner')
    expect(get(w.ui, '/t/acme?view=escalations', cookie).body).toContain('name="seq" value="0"') // empty thread
    followUp(w.api, 'acme', 'Any update?', 'pm_seq')
    expect(get(w.ui, '/t/acme?view=escalations', cookie).body).toContain('name="seq" value="1"') // the guest turn occupies slot 0
  })
})

describe('per-conversation transcript page (?view=escalations&conversation=ID) — Phase 38', () => {
  /** A planner Bearer token (whole-tenant scope) — used to read escalation ids back out of the JSON layer. */
  function plannerToken(api: ProductApi, slug: string): string {
    const login = api.handle({ method: 'POST', path: `/t/${slug}/sessions`, headers: {}, rawBody: JSON.stringify({ role: 'planner' }) })
    return (login.body as { token: string }).token
  }
  type EscRow = { escalation_id: string; provider_message_ref?: string; wedding_id: string }
  function escalationsOf(api: ProductApi, slug: string, token: string): EscRow[] {
    const res = api.handle({ method: 'GET', path: `/t/${slug}/escalations`, headers: { authorization: `Bearer ${token}` } })
    return (res.body as { escalations: EscRow[] }).escalations
  }
  /** Create a wedding + register a guest + drive one UNANSWERABLE inbound; return {weddingId, escalationId}. */
  function seedConversation(
    api: ProductApi,
    slug: string,
    opts: { couple: string; ref: string; guestId: string; text: string; pm: string },
  ): { weddingId: string; escalationId: string } {
    const token = plannerToken(api, slug)
    const create = api.handle({
      method: 'POST',
      path: `/t/${slug}/weddings`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ couple_display_name: opts.couple, event_date: '2029-06-06' }),
    })
    const weddingId = (create.body as { wedding: { wedding_id: string } }).wedding.wedding_id
    api.handle({
      method: 'POST',
      path: `/t/${slug}/guests`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ recipient_ref: opts.ref, wedding_id: weddingId, guest_id: opts.guestId }),
    })
    api.handle({
      method: 'POST',
      path: `/t/${slug}/messaging/inbound`,
      headers: { authorization: `Bearer ${WH}`, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ channel: 'sms', from_ref: opts.ref, text: opts.text, provider_message_ref: opts.pm }),
    })
    const escalationId = escalationsOf(api, slug, token).find((e) => e.provider_message_ref === opts.pm)!.escalation_id
    return { weddingId, escalationId }
  }

  it('the inbox row links to the transcript at the right conversation id', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const page = get(ui, '/t/acme?view=escalations', cookie).body as string
    const escId = escalationIdFrom(page)
    expect(page).toContain(`/t/acme?view=escalations&amp;conversation=${escId}`)
    expect(page).toContain('View full conversation')
  })

  it('a planner sees the transcript: the question + reply turns + transition history, interleaved', () => {
    const { ui, api, store, clock } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const escId = escalationIdFrom(get(ui, '/t/acme?view=escalations', cookie).body as string)
    const tenantId = store.findBySlug('acme')!.tenant_id
    expect(tenantId).toBeTruthy()
    // Reply, then resolve — advancing the clock so the transcript orders by REAL time (production reality).
    const p1 = get(ui, '/t/acme?view=escalations', cookie).body as string
    clock.advance(60_000)
    postForm(ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(p1), escalation_id: escId, reply_text: 'Lot B.', seq: '0' }, cookie)
    const p2 = get(ui, '/t/acme?view=escalations', cookie).body as string
    clock.advance(60_000)
    postForm(ui, '/t/acme/escalations/resolve', { _csrf: csrfFrom(p2), escalation_id: escId, status: 'resolved' }, cookie)

    const tx = get(ui, `/t/acme?view=escalations&conversation=${escId}`, cookie)
    expect(tx.status).toBe(200)
    const body = tx.body as string
    expect(body).toContain('where do I park?') // the question
    expect(body).toContain('Lot B.') // the reply turn
    expect(body).toContain('Marked resolved') // the transition history
    expect(body).toContain('← Back to all questions')
    // Chronological order: question, then the reply, then the resolution.
    expect(body.indexOf('where do I park?')).toBeLessThan(body.indexOf('Lot B.'))
    expect(body.indexOf('Lot B.')).toBeLessThan(body.indexOf('Marked resolved'))
  })

  it('end-to-end auto-reopen (Phase 37): the transcript shows question → reply → resolved → guest follow-up → reopened, in order', () => {
    const { ui, api, clock } = makeWorld()
    seedEscalation(api, 'acme') // E1: "where do I park?"
    const cookie = loginCookie(ui, 'acme', 'planner')
    const escId = escalationIdFrom(get(ui, '/t/acme?view=escalations', cookie).body as string)

    clock.advance(60_000)
    const p1 = get(ui, '/t/acme?view=escalations', cookie).body as string
    postForm(ui, '/t/acme/escalations/reply', { _csrf: csrfFrom(p1), escalation_id: escId, reply_text: 'Lot B.', seq: '0' }, cookie)
    clock.advance(60_000)
    const p2 = get(ui, '/t/acme?view=escalations', cookie).body as string
    postForm(ui, '/t/acme/escalations/resolve', { _csrf: csrfFrom(p2), escalation_id: escId, status: 'resolved' }, cookie)
    // The guest re-engages the RESOLVED conversation → auto-reopen (the reopen + guest turn share this instant).
    clock.advance(60_000)
    api.handle({
      method: 'POST',
      path: '/t/acme/messaging/inbound',
      headers: { authorization: `Bearer ${WH}`, 'content-type': 'application/json' },
      rawBody: JSON.stringify({ channel: 'sms', from_ref: 'sms:+15550100', text: 'is there overflow parking?', provider_message_ref: 'pm_reopen' }),
    })

    const body = get(ui, `/t/acme?view=escalations&conversation=${escId}`, cookie).body as string
    const iQ = body.indexOf('where do I park?')
    const iReply = body.indexOf('Lot B.')
    const iResolved = body.indexOf('Marked resolved')
    const iFollow = body.indexOf('is there overflow parking?')
    const iReopen = body.indexOf('Reopened')
    expect([iQ, iReply, iResolved, iFollow, iReopen].every((i) => i >= 0)).toBe(true)
    // Real-time order: Q < reply < resolved < (reopen, follow-up). The reopen + the guest turn share one instant
    // → the G-tuple renders the reopen BEFORE the guest turn it enabled (Phase-37 write order).
    expect(iQ).toBeLessThan(iReply)
    expect(iReply).toBeLessThan(iResolved)
    expect(iResolved).toBeLessThan(iReopen)
    expect(iReopen).toBeLessThan(iFollow)
  })

  it('NO ORACLE: a couple gets the byte-identical not-found notice for a SIBLING wedding conversation AND an absent id', () => {
    const { ui, api } = makeWorld()
    const a = seedConversation(api, 'acme', { couple: 'A & A', ref: 'sms:+15550111', guestId: 'ga', text: 'Q-A', pm: 'pm_a' })
    const b = seedConversation(api, 'acme', { couple: 'B & B', ref: 'sms:+15550222', guestId: 'gb', text: 'Q-B', pm: 'pm_b' })
    // A couple bound to wedding A.
    const coupleA = loginCookie(ui, 'acme', 'couple', a.weddingId)
    // Their OWN conversation renders.
    const own = get(ui, `/t/acme?view=escalations&conversation=${a.escalationId}`, coupleA)
    expect(own.status).toBe(200)
    expect(own.body).toContain('Q-A')
    // A sibling-wedding conversation (B) → not-found notice; an absent id → not-found notice; BYTE-IDENTICAL.
    const sibling = get(ui, `/t/acme?view=escalations&conversation=${b.escalationId}`, coupleA)
    const absent = get(ui, '/t/acme?view=escalations&conversation=esc_does_not_exist', coupleA)
    expect(sibling.status).toBe(200)
    expect(sibling.body).toContain("We couldn't find that conversation.")
    expect(sibling.body).not.toContain('Q-B') // no leak of the sibling's question
    expect(sibling.body).toBe(absent.body) // foreign ≡ absent — no cross-wedding existence oracle
  })

  it('NO REFLECTION: the not-found notice never echoes the submitted conversation id', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    const res = get(ui, '/t/acme?view=escalations&conversation=esc_PROBE_12345', cookie)
    expect(res.status).toBe(200)
    expect(res.body).toContain("We couldn't find that conversation.")
    expect(res.body).not.toContain('esc_PROBE_12345')
  })

  it('a malformed/encoded conversation id never throws — it is a pure filter key (no 500 oracle)', () => {
    const { ui, api } = makeWorld()
    seedEscalation(api, 'acme')
    const cookie = loginCookie(ui, 'acme', 'planner')
    for (const probe of ['..%2F..%2Fetc', '', '%00', 'a'.repeat(5000)]) {
      const res = get(ui, `/t/acme?view=escalations&conversation=${probe}`, cookie)
      expect(res.status).toBe(200)
      expect(res.body).toContain("We couldn't find that conversation.")
    }
  })

  it('unauthenticated / unknown-tenant requests for a transcript mask BYTE-IDENTICALLY to the inbox', () => {
    const { ui, api } = makeWorld()
    const { escalationId } = seedConversation(api, 'acme', { couple: 'A & A', ref: 'sms:+15550100', guestId: 'g1', text: 'where do I park?', pm: 'pm_1' })
    // No cookie → unauthenticated: the transcript reuses #renderNonData, so it is byte-identical to the
    // unauthenticated inbox (no transcript content leaks — the read's 401 mask wins before any selection).
    const anonInbox = get(ui, '/t/acme?view=escalations')
    const anonTx = get(ui, `/t/acme?view=escalations&conversation=${escalationId}`)
    expect(anonTx.body).toBe(anonInbox.body)
    expect(anonTx.body).not.toContain('where do I park?')
    // Unknown tenant → GENERIC_404, byte-identical to the inbox's unknown-tenant mask.
    const ghostInbox = get(ui, '/t/ghosttenant?view=escalations')
    const ghostTx = get(ui, '/t/ghosttenant?view=escalations&conversation=esc_x')
    expect(ghostTx.status).toBe(404)
    expect(ghostTx.body).toBe(ghostInbox.body)
  })
})
