import { ManualClock, SequentialIdGenerator, type EscalationResolution, type GuestEscalation, type Tenant, type Wedding } from '@wedding-planner/shared'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  GuestAuthorizer,
  type ApiRequest,
  type ApiResponse,
  BillingLedger,
  DeterministicGuestQaResponder,
  EscalationLog,
  EscalationReplyLog,
  EscalationResolutionLog,
  GuestRegistry,
  InboundReceiptLog,
  MessagingService,
  OnboardingService,
  OperatorCredentialStore,
  ProviderWebhookCredentialStore,
  ProductApi,
  SessionStore,
  SimulatedMessagingAdapter,
  TenantContextResolver,
  TenantStore,
  WeddingAuthorizer,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Phase 27 — `POST /t/:slug/escalations` marks an escalation handled (resolved/dismissed) into a SEPARATE
 * append-only log (the guest_escalation is never mutated). The mutation is SCOPED like guest-remove and is
 * provably oracle-free for a couple: an absent escalation_id and a couple's foreign-wedding escalation_id BOTH
 * return the byte-identical `{resolved:false}` (the shared frozen RESP_RESOLVE_MISS) with NO record written. A
 * planner resolves any tenant escalation. Idempotent by escalation_id (first-writer-wins). The list returns the
 * resolutions scoped by the SAME manageScope branch as the escalations.
 */

const THEME: Tenant['theme'] = {
  brand_name: 'Brand',
  primary_color_hex: '#111111',
  accent_color_hex: '#222222',
  logo_ref: 'asset_1',
}
const WH = 'wh-secret'

interface World {
  api: ProductApi
}

function makeWorld(): World {
  const clock = new ManualClock('2027-03-01T00:00:00.000Z')
  const store = new TenantStore(clock, new SequentialIdGenerator('seedT'))
  store.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  store.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(store)
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
    resolver,
    sessionStore: sessions,
    weddings,
    authorizer: new WeddingAuthorizer(),
    guests: { registry, weddings, authorizer: guestAuthorizer },
    operators: new OperatorCredentialStore(new SequentialIdGenerator('seedO'), ['op-secret']),
    onboarding: new OnboardingService(store, billing),
    webhookCredentials: new ProviderWebhookCredentialStore(new SequentialIdGenerator('seedWH'), [WH]),
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
  return { api }
}

function req(method: string, path: string, opts: { token?: string; body?: unknown } = {}): ApiRequest {
  const headers: Record<string, string | undefined> = {}
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  return { method, path, headers, rawBody: opts.body === undefined ? undefined : JSON.stringify(opts.body) }
}

function login(w: World, slug: string, body: { role: string; wedding_id?: string }): string {
  const res = w.api.handle(req('POST', `/t/${slug}/sessions`, { body }))
  expect(res.status).toBe(201)
  return (res.body as { token: string }).token
}

function makeWedding(w: World, slug: string, plannerToken: string): string {
  const res = w.api.handle(
    req('POST', `/t/${slug}/weddings`, { token: plannerToken, body: { couple_display_name: 'Alex & Sam', event_date: '2027-09-18' } }),
  )
  expect(res.status).toBe(201)
  return (res.body as { wedding: Wedding }).wedding.wedding_id
}

function registerGuest(w: World, slug: string, plannerToken: string, ref: string, weddingId: string): void {
  const res = w.api.handle(req('POST', `/t/${slug}/guests`, { token: plannerToken, body: { recipient_ref: ref, wedding_id: weddingId, guest_id: `g_${ref}` } }))
  expect(res.status).toBe(201)
}

/** Drive an UNANSWERABLE inbound (a parking question, no parking_info) -> records an escalation; return its id. */
function escalate(w: World, slug: string, plannerToken: string, ref: string, providerRef: string): string {
  const res = w.api.handle({
    method: 'POST',
    path: `/t/${slug}/messaging/inbound`,
    headers: { authorization: `Bearer ${WH}` },
    rawBody: JSON.stringify({ channel: 'sms', from_ref: ref, text: 'where do I park?', provider_message_ref: providerRef }),
  })
  expect(res.status).toBe(202)
  // Read the escalation back (as a planner) to learn its server-minted escalation_id.
  const listed = w.api.handle(req('GET', `/t/${slug}/escalations`, { token: plannerToken }))
  const row = (listed.body as { escalations: GuestEscalation[] }).escalations.find((e) => e.provider_message_ref === providerRef)
  expect(row).toBeDefined()
  return row!.escalation_id
}

function resolve(w: World, slug: string, token: string, escalation_id: string, status = 'resolved'): ApiResponse {
  return w.api.handle(req('POST', `/t/${slug}/escalations`, { token, body: { escalation_id, status } }))
}

function listResolutions(w: World, slug: string, token: string): EscalationResolution[] {
  const res = w.api.handle(req('GET', `/t/${slug}/escalations`, { token }))
  expect(res.status).toBe(200)
  return (res.body as { resolutions: EscalationResolution[] }).resolutions
}

describe('escalation resolve/dismiss mutation', () => {
  let w: World
  beforeEach(() => {
    w = makeWorld()
  })

  it('a planner resolves any tenant escalation; the resolution appears in the list scoped to it', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    const res = resolve(w, 'alpha', planner, escId, 'dismissed')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ resolved: true })

    const resolutions = listResolutions(w, 'alpha', planner)
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0]).toMatchObject({ escalation_id: escId, wedding_id: wedA, status: 'dismissed', resolved_by: 'planner' })
  })

  it('a couple resolves ONLY their bound wedding escalation', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    const coupleA = login(w, 'alpha', { role: 'couple', wedding_id: wedA })
    expect(resolve(w, 'alpha', coupleA, escId).body).toEqual({ resolved: true })
    expect(listResolutions(w, 'alpha', coupleA)[0]).toMatchObject({ escalation_id: escId, resolved_by: 'couple' })
  })

  it('F1: a couple resolving an ABSENT id and a SIBLING-WEDDING id get the BYTE-IDENTICAL {resolved:false}', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    const wedB = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    registerGuest(w, 'alpha', planner, 'sms:+2', wedB)
    const escB = escalate(w, 'alpha', planner, 'sms:+2', 'pm_B') // an escalation in wedding B

    const coupleA = login(w, 'alpha', { role: 'couple', wedding_id: wedA })
    const absent = resolve(w, 'alpha', coupleA, 'escalation_does_not_exist')
    const foreign = resolve(w, 'alpha', coupleA, escB) // a real id, but in a wedding the couple isn't bound to
    // Same status AND byte-identical body — the resolve mutation is no cross-wedding existence oracle.
    expect(absent.status).toBe(200)
    expect(foreign.status).toBe(200)
    expect(JSON.stringify(absent.body)).toBe(JSON.stringify(foreign.body))
    expect(foreign.body).toEqual({ resolved: false })
  })

  it('F2: a couple resolving a SIBLING-WEDDING escalation writes NO record', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    const wedB = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+2', wedB)
    const escB = escalate(w, 'alpha', planner, 'sms:+2', 'pm_B')

    const coupleA = login(w, 'alpha', { role: 'couple', wedding_id: wedA })
    resolve(w, 'alpha', coupleA, escB)
    // The planner (whole-tenant scope) sees NO resolution for escB — the foreign-wedding probe recorded nothing.
    expect(listResolutions(w, 'alpha', planner)).toEqual([])
  })

  it('a body-smuggled wedding_id/resolved_by is inert — the record uses the escalation + the principal', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    const coupleA = login(w, 'alpha', { role: 'couple', wedding_id: wedA })
    const res = w.api.handle(
      req('POST', '/t/alpha/escalations', {
        token: coupleA,
        body: { escalation_id: escId, status: 'resolved', wedding_id: 'wed_HACK', resolved_by: 'planner', tenant_id: 'hack', resolution_id: 'res_HACK' },
      }),
    )
    expect(res.body).toEqual({ resolved: true })
    const stored = listResolutions(w, 'alpha', planner)[0]
    expect(stored).toMatchObject({ escalation_id: escId, wedding_id: wedA, resolved_by: 'couple' }) // from trusted state, not the body
  })

  it('is idempotent by escalation_id (first-writer-wins): a re-resolve/dismiss keeps the original record + status', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    expect(resolve(w, 'alpha', planner, escId, 'resolved').body).toEqual({ resolved: true })
    // A later DISMISS is a no-op return-existing → still {resolved:true}, one record, original status sticks.
    expect(resolve(w, 'alpha', planner, escId, 'dismissed').body).toEqual({ resolved: true })
    const resolutions = listResolutions(w, 'alpha', planner)
    expect(resolutions).toHaveLength(1)
    expect(resolutions[0]!.status).toBe('resolved')
  })

  it('a bad/absent status is a masked 400 — for a PRESENT and an ABSENT escalation_id alike (no existence oracle)', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', planner, 'sms:+1', 'pm_1')

    expect(w.api.handle(req('POST', '/t/alpha/escalations', { token: planner, body: { escalation_id: escId, status: 'nope' } })).status).toBe(400)
    expect(w.api.handle(req('POST', '/t/alpha/escalations', { token: planner, body: { escalation_id: 'absent', status: 'nope' } })).status).toBe(400)
    expect(w.api.handle(req('POST', '/t/alpha/escalations', { token: planner, body: { escalation_id: escId } })).status).toBe(400)
  })

  it('F4: a couple bound to wedding A never sees wedding B resolution in the resolutions array', () => {
    const planner = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', planner)
    const wedB = makeWedding(w, 'alpha', planner)
    registerGuest(w, 'alpha', planner, 'sms:+1', wedA)
    registerGuest(w, 'alpha', planner, 'sms:+2', wedB)
    const escA = escalate(w, 'alpha', planner, 'sms:+1', 'pm_A')
    const escB = escalate(w, 'alpha', planner, 'sms:+2', 'pm_B')
    resolve(w, 'alpha', planner, escA)
    resolve(w, 'alpha', planner, escB)

    const coupleA = login(w, 'alpha', { role: 'couple', wedding_id: wedA })
    const seen = listResolutions(w, 'alpha', coupleA)
    expect(seen.map((r) => r.escalation_id)).toEqual([escA]) // only A's, never B's
  })

  it('is tenant-isolated: a beta planner cannot resolve an alpha escalation (absent in beta) → {resolved:false}', () => {
    const plannerA = login(w, 'alpha', { role: 'planner' })
    const wedA = makeWedding(w, 'alpha', plannerA)
    registerGuest(w, 'alpha', plannerA, 'sms:+1', wedA)
    const escId = escalate(w, 'alpha', plannerA, 'sms:+1', 'pm_1')

    const plannerB = login(w, 'beta', { role: 'planner' })
    expect(resolve(w, 'beta', plannerB, escId).body).toEqual({ resolved: false })
    expect(listResolutions(w, 'beta', plannerB)).toEqual([])
  })
})
