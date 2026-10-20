import { ManualClock, SequentialIdGenerator, type Wedding } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  type ApiResponse,
  composeProductSurface,
  conciergeFactKeys,
  ConciergeService,
  EscalationLog,
  EscalationReplyLog,
  EscalationResolutionLog,
  GuestRegistry,
  InboundReceiptLog,
  InMemoryRecordStore,
  isSurpriseProbe,
  JobQueue,
  MAX_REPLY_LENGTH,
  MessagingService,
  ModelService,
  projectConciergeFacts,
  type PublicSiteView,
  renderConciergeAnswer,
  BillingLedger,
  simulateGuestAnswer,
  SimulatedMessagingAdapter,
  TenantContextResolver,
  TenantStore,
  WeddingRepository,
} from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { GLOBAL_PARTITION } from '../../src/persistence/record_store'

/**
 * Issue #60 — the guest concierge: the allow-listed projection (the website only while published), answers worded from
 * trusted facts only, the fact-independent refusal, the second check, escalation of everything else, and the job's
 * bookkeeping (the current binding, re-delivery, pruning).
 */

const WEDDING = { couple_display_name: 'Jo & Lee', event_date: '2028-06-10', ceremony_time: '16:00', venue_name: 'The Hall' } as unknown as Wedding
const SITE: PublicSiteView = {
  couple_display_name: 'Jo & Lee',
  event_date: '2028-06-10',
  schedule: [
    { name: 'Rehearsal dinner', starts_at: '2028-06-09T19:00', location: 'Bistro' },
    { name: 'Ceremony', starts_at: '2028-06-10T16:00' },
  ],
  travel: 'Fly into PDX; the shuttle leaves at 3.',
  hotels: [{ name: 'Inn by the River', address: '1 River Rd', block_code: 'JOLEE', book_by: '2028-05-01', booking_url: 'https://inn.example/book' }],
  faq: [
    { question: 'Are kids welcome?', answer: 'Yes, kids are welcome.' },
    { question: 'Is there a vegan menu option?', answer: 'Yes, ask your server.' },
  ],
  registry: [{ label: 'Shop', url: 'https://shop.example/list' }],
}

describe('the concierge projection and wording', () => {
  it('holds only the allow-listed facts; the website adds nothing while unpublished', () => {
    const bare = projectConciergeFacts({ ...WEDDING, status: 'active', tenant_id: 't', wedding_id: 'w', notes: 'secret' } as unknown as Wedding, undefined)
    expect(bare).toEqual({ couple_display_name: 'Jo & Lee', event_date: '2028-06-10', ceremony_time: '16:00', venue_name: 'The Hall', schedule: [], hotels: [], faq: [], registry: [] })
    expect([...conciergeFactKeys(bare)]).toEqual(['event_date', 'ceremony_time', 'venue_name'])
    const site = projectConciergeFacts(WEDDING, { ...SITE, welcome: 'not a fact', hotels: [{ ...SITE.hotels[0], planner_note: 'x' } as never] })
    expect(JSON.stringify(site)).not.toContain('planner_note')
    expect(JSON.stringify(site)).not.toContain('not a fact')
    expect([...conciergeFactKeys(site)]).toEqual(['event_date', 'ceremony_time', 'venue_name', 'travel', 'schedule:0', 'schedule:1', 'hotel:0', 'faq:0', 'faq:1', 'registry:0'])
  })

  it('words a reply from the trusted values only, skips unknown keys, and stays within a few messages', () => {
    const facts = projectConciergeFacts(WEDDING, SITE)
    expect(renderConciergeAnswer(facts, ['event_date'])).toBe("Jo & Lee's wedding is on 2028-06-10 at 16:00.")
    expect(renderConciergeAnswer(facts, ['hotel:0'])).toBe('Hotel: Inn by the River (1 River Rd, block code JOLEE, book by 2028-05-01, https://inn.example/book).')
    expect(renderConciergeAnswer(facts, ['schedule:0', 'faq:0'])).toBe('Rehearsal dinner: 2028-06-09 at 19:00, Bistro. Yes, kids are welcome.')
    expect(renderConciergeAnswer(facts, ['faq:7', 'parking_info'])).toBe('')
    const long = projectConciergeFacts(WEDDING, { ...SITE, faq: [{ question: 'Q', answer: 'word '.repeat(400) }] })
    expect(renderConciergeAnswer(long, ['faq:0']).length).toBeLessThanOrEqual(MAX_REPLY_LENGTH)
  })

  it('the simulated model points at facts: FAQ first, then topics; it escalates what the facts do not answer', () => {
    const facts = projectConciergeFacts(WEDDING, SITE)
    const ask = (question: string) => simulateGuestAnswer({ facts, question })
    expect(ask('Can I bring my kids? Are kids welcome?')).toEqual({ action: 'answer', facts: ['faq:0'] })
    expect(ask('Where should we stay?')).toEqual({ action: 'answer', facts: ['hotel:0'] })
    expect(ask('When is the rehearsal dinner?')).toEqual({ action: 'answer', facts: ['schedule:0'] })
    expect(ask('Which airport do we fly into?')).toEqual({ action: 'answer', facts: ['travel'] })
    expect(ask('Where is the registry?')).toEqual({ action: 'answer', facts: ['registry:0'] })
    expect(ask('When is the wedding?')).toEqual({ action: 'answer', facts: ['event_date'] })
    expect(ask('Where is it held?')).toEqual({ action: 'answer', facts: ['venue_name'] })
    // Topics the facts do not hold, and questions about nothing it knows: escalated.
    expect(ask('Where do I park?')).toEqual({ action: 'escalate', facts: [] })
    expect(ask('Can my dog come along?')).toEqual({ action: 'escalate', facts: [] })
  })

  it('a surprise probe is refused by its words alone', () => {
    for (const text of ['Is there a surprise?', 'what is the SECRET', 'any surprises planned']) expect(isSurpriseProbe(text)).toBe(true)
    for (const text of ['When is it?', 'surprising weather?']) expect(isSurpriseProbe(text)).toBe(false)
  })
})

const WEBHOOK = 'cc-webhook-token-0123456789'

function setup() {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const s = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator('cc'),
    operatorToken: 'cc-operator-token-0123456789',
    providerWebhookToken: WEBHOOK,
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const api = (method: string, path: string, token?: string, body?: unknown): ApiResponse =>
    s.api.handle({ method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) } as ApiRequest)
  const planner = (api('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
  const ref = s.demo?.guestRecipientRef as string
  const wedding = s.demo?.weddingId as string
  const ask = (text: string, pmr: string, from = ref) => api('POST', '/t/demo/messaging/inbound', WEBHOOK, { channel: 'sms', from_ref: from, text, provider_message_ref: pmr })
  const sent = () => s.messaging.usageView(s.demo?.tenantId as string).message_count
  const inbox = () => (api('GET', '/t/demo/escalations', planner).body as { escalations: { text: string }[] }).escalations.map((e) => e.text)
  return { ...s, api, planner, ref, wedding, ask, sent, inbox }
}

describe('the concierge through the inbound edge', () => {
  it('answers from the published website; before publishing the same question is escalated', async () => {
    const w = setup()
    w.api('PUT', `/t/demo/weddings/${w.wedding}/site`, w.planner, { site_name: 'demo-site', hotels: [{ name: 'Inn by the River', block_code: 'JOLEE' }] })
    expect(w.ask('Where should we stay?', 'pmr_1')).toEqual({ status: 202, body: { status: 'accepted' } })
    expect(w.sent()).toBe(0)
    await w.drainJobs()
    expect(w.sent()).toBe(0)
    expect(w.inbox()).toEqual(['Where should we stay?'])
    w.api('PUT', `/t/demo/weddings/${w.wedding}/site/published`, w.planner, { published: true })
    w.ask('Which hotel has the block?', 'pmr_2')
    await w.drainJobs()
    expect(w.sent()).toBe(1)
    expect(w.inbox()).toEqual(['Where should we stay?'])
  })

  it('a surprise probe is refused at the edge: nothing recorded, queued or sent, for every wedding alike', async () => {
    const w = setup()
    expect(w.ask('Is there a surprise at the reception?', 'pmr_s')).toEqual({ status: 202, body: { status: 'accepted' } })
    expect(await w.drainJobs()).toBe(0)
    expect(w.sent()).toBe(0)
    expect(w.inbox()).toEqual([])
  })

  it('a re-delivery while queued makes one job; after the answer it is a no-op; the job row and the question are pruned', async () => {
    const w = setup()
    w.ask('When is the wedding?', 'pmr_r')
    w.ask('When is the wedding?', 'pmr_r')
    expect(await w.drainJobs()).toBe(1)
    expect(w.sent()).toBe(1)
    w.ask('When is the wedding?', 'pmr_r')
    expect(await w.drainJobs()).toBe(0)
    expect(w.sent()).toBe(1)
  })

  it('an unregistered sender is never queued (no oracle)', async () => {
    const w = setup()
    expect(w.ask('When is the wedding?', 'pmr_u', 'sms:+19990000000')).toEqual({ status: 202, body: { status: 'accepted' } })
    expect(await w.drainJobs()).toBe(0)
  })
})

describe('the concierge job (service level)', () => {
  function world(output: unknown) {
    const clock = new ManualClock('2028-01-10T12:00:00.000Z')
    const tenants = new TenantStore(clock, new SequentialIdGenerator('t'))
    tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }, plan_tier: 'studio', lifecycle_status: 'active' })
    const resolver = new TenantContextResolver(tenants)
    const ctx = resolver.resolveBySlug('alpha')
    const weddings = new WeddingRepository(tenants, clock, new SequentialIdGenerator('w'))
    const wedding = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
    const other = weddings.create(ctx, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).wedding_id
    const registry = new GuestRegistry(tenants)
    registry.register(ctx, { recipient_ref: 'sms:+1', wedding_id: wedding, guest_id: 'g1' })
    const adapter = new SimulatedMessagingAdapter(clock, new SequentialIdGenerator('a'))
    const service = new MessagingService(adapter, tenants, new BillingLedger(clock, new SequentialIdGenerator('b')), new SequentialIdGenerator('m'))
    const escalations = new EscalationLog(tenants, new SequentialIdGenerator('e'))
    const filing = { escalations, resolutions: new EscalationResolutionLog(tenants, new SequentialIdGenerator('r'), clock), replies: new EscalationReplyLog(tenants, new SequentialIdGenerator('p'), clock) }
    const receipts = new InboundReceiptLog(tenants, new SequentialIdGenerator('i'))
    const model = new ModelService(tenants, { complete: () => (output instanceof Error ? Promise.reject(output) : Promise.resolve({ output, usage: { input_tokens: 1, output_tokens: 1, cost_micro_cents: 1 }, model: 'm' })) }, clock)
    const queueStore = new InMemoryRecordStore()
    const jobs = new JobQueue(tenants, resolver, clock, new SequentialIdGenerator('j'), queueStore)
    const concierge = new ConciergeService(tenants, registry, weddings, undefined, model, jobs, receipts, service, filing, queueStore)
    jobs.register(concierge.jobKind())
    const ask = (text: string, pmr: string) => concierge.receive(ctx, { channel: 'sms', sender_ref: 'sms:+1', body: text, provider_message_ref: pmr, received_at: clock.now() }, wedding)
    return { ctx, registry, wedding, other, escalations, service, jobs, ask, tenants, queueStore }
  }

  it('the second check: an answer naming a fact the projection does not hold is escalated, never sent', async () => {
    const w = world({ action: 'answer', facts: ['faq:3'] })
    expect(w.ask('Anything?', 'p1')).toBe('queued')
    await w.jobs.drain()
    expect(w.service.usageView(w.ctx.tenant_id).message_count).toBe(0)
    expect(w.escalations.list(w.ctx).map((e) => e.text)).toEqual(['Anything?'])
    // The question and the job row are gone (an ephemeral kind); the index is empty.
    expect(w.queueStore.list(COLLECTIONS.pendingGuestQuestion, w.ctx.tenant_id)).toEqual([])
    expect(w.queueStore.list(COLLECTIONS.job, w.ctx.tenant_id)).toEqual([])
    expect(w.queueStore.list(COLLECTIONS.jobQueue, GLOBAL_PARTITION)).toEqual([])
  })

  it('a model that fails for good escalates the question rather than losing it', async () => {
    const w = world({ nonsense: true })
    w.ask('Anything?', 'p1')
    await w.jobs.drain()
    expect(w.escalations.list(w.ctx).map((e) => e.text)).toEqual(['Anything?'])
  })

  it('answers the guest from their CURRENT binding; a guest unbound since is not answered', async () => {
    const w = world({ action: 'answer', facts: ['event_date'] })
    w.ask('When?', 'p1')
    // Re-bound to another wedding before the job runs (the registry needs a remove first).
    w.registry.remove(w.ctx, 'sms:+1')
    w.registry.register(w.ctx, { recipient_ref: 'sms:+1', wedding_id: w.other, guest_id: 'g1' })
    await w.jobs.drain()
    expect(w.service.usageView(w.ctx.tenant_id).message_count).toBe(1)
    w.ask('When again?', 'p2')
    w.registry.remove(w.ctx, 'sms:+1')
    await w.jobs.drain()
    expect(w.service.usageView(w.ctx.tenant_id).message_count).toBe(1)
    expect(w.escalations.list(w.ctx)).toEqual([])
  })
})
