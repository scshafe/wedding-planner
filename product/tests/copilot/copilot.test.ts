import { type CopilotDraft, ManualClock, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import {
  type ApiRequest,
  type ApiResponse,
  ChecklistService,
  checkDraft,
  composeProductSurface,
  CopilotService,
  type CopilotDraftInput,
  GuestDirectory,
  InMemoryRecordStore,
  JobQueue,
  ModelService,
  RunOfShowService,
  SessionStore,
  TenantContextResolver,
  TenantStore,
  VendorService,
  WeddingAuthorizer,
  WeddingEventService,
  WeddingRepository,
} from '@wedding-planner/product'

/**
 * Issue #61 — the planner copilot: a draft is asked for, made after the request through the job queue by the simulated
 * model, checked against the wedding, and kept (some, all or none) through the checklist and run-of-show services. The
 * planner only; nothing reaches the checklist until kept.
 */

function setup() {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const s = composeProductSurface({
    clock,
    ids: new SequentialIdGenerator('cp'),
    operatorToken: 'cp-operator-token-0123456789',
    providerWebhookToken: 'cp-webhook-token-0123456789',
    demoSlug: 'demo',
    passwordCost: { N: 16, r: 1, p: 1 },
  })
  const api = (method: string, path: string, token?: string, body?: unknown): ApiResponse =>
    s.api.handle({ method, path, headers: token === undefined ? {} : { authorization: `Bearer ${token}` }, rawBody: body === undefined ? undefined : JSON.stringify(body) } as ApiRequest)
  const planner = (api('POST', '/t/demo/sessions', undefined, { role: 'planner' }).body as { token: string }).token
  const wedding = (api('POST', '/t/demo/weddings', planner, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
  const other = (api('POST', '/t/demo/weddings', planner, { couple_display_name: 'Sam & Kit', event_date: '2028-07-10' }).body as { wedding: { wedding_id: string } }).wedding.wedding_id
  const couple = (api('POST', '/t/demo/sessions', undefined, { role: 'couple', wedding_id: wedding }).body as { token: string }).token
  const event = (name: string, starts_at: string) => (api('POST', `/t/demo/weddings/${wedding}/events`, planner, { name, starts_at }).body as { event: { event_id: string } }).event.event_id
  const vendor = (category: string, business_name: string) =>
    (api('POST', `/t/demo/weddings/${wedding}/vendors`, planner, { category, business_name, contract_status: 'signed' }).body as { vendor: { vendor_id: string } }).vendor.vendor_id
  const ceremony = event('Ceremony', '2028-06-10T16:00')
  const reception = event('Reception', '2028-06-10T18:30')
  const snap = vendor('photography', 'Snap Photos')
  const feast = vendor('catering', 'Feast Co')
  const draft = () => (api('GET', `/t/demo/weddings/${wedding}/copilot`, planner).body as { draft?: CopilotDraft }).draft
  return { ...s, clock, api, planner, couple, wedding, other, ceremony, reception, snap, feast, draft }
}

describe('the planner copilot', () => {
  it('drafts after the request, from the wedding, checked; the same wedding gives the same draft', async () => {
    const w = setup()
    const asked = w.api('POST', `/t/demo/weddings/${w.wedding}/copilot`, w.planner)
    expect(asked.status).toBe(202)
    expect(w.draft()?.status).toBe('drafting')
    expect(await w.drainJobs()).toBe(1)
    const draft = w.draft()
    expect(draft?.status).toBe('ready')
    expect(draft?.tasks).toEqual(
      expect.arrayContaining([
        { draft_id: expect.any(String), title: 'Send the shot list to the photographer', due_date: '2028-05-27', assignee: 'couple' },
        { draft_id: expect.any(String), title: 'Send the final headcount to the caterer', due_date: '2028-05-31', assignee: 'planner' },
        { draft_id: expect.any(String), title: 'Confirm the timing of Ceremony', due_date: '2028-06-03', assignee: 'planner' },
      ]),
    )
    expect(draft?.run_of_show).toEqual(
      expect.arrayContaining([
        { draft_id: expect.any(String), title: 'Final walkthrough: Ceremony', starts_at: '2028-06-10T15:00', owner: 'planner', event_id: w.ceremony },
        { draft_id: expect.any(String), title: 'Photographer arrives and sets up', starts_at: '2028-06-10T14:30', owner: 'vendor', vendor_id: w.snap, event_id: w.ceremony },
        { draft_id: expect.any(String), title: 'Catering setup', starts_at: '2028-06-10T16:30', owner: 'vendor', vendor_id: w.feast, event_id: w.reception },
      ]),
    )
    // Nothing is on the checklist or the run of show yet.
    expect((w.api('GET', `/t/demo/weddings/${w.wedding}/tasks`, w.planner).body as { overdue: unknown[]; upcoming: unknown[] }).upcoming).toEqual([])
    // Deterministic: another surface with the same wedding drafts the same.
    const again = setup()
    again.api('POST', `/t/demo/weddings/${again.wedding}/copilot`, again.planner)
    await again.drainJobs()
    const strip = (d: CopilotDraft | undefined) => ({ tasks: d?.tasks, items: d?.run_of_show.map((i) => ({ ...i, vendor_id: undefined, event_id: undefined })) })
    expect(strip(again.draft())).toEqual(strip(draft))
  })

  it('keeps what the planner picks, through the services; the rest stays; a new draft skips what is kept', async () => {
    const w = setup()
    w.api('POST', `/t/demo/weddings/${w.wedding}/copilot`, w.planner)
    await w.drainJobs()
    const draft = w.draft() as CopilotDraft
    const task = draft.tasks[0]
    const item = draft.run_of_show.find((i) => i.owner === 'vendor')
    const kept = w.api('POST', `/t/demo/weddings/${w.wedding}/copilot/accept`, w.planner, { draft: draft.requested_at, task_ids: [task?.draft_id], item_ids: [item?.draft_id] })
    expect(kept.body).toEqual({ added_tasks: 1, added_items: 1, skipped: 0 })
    const tasks = w.api('GET', `/t/demo/weddings/${w.wedding}/tasks`, w.planner).body as { upcoming: { title: string }[] }
    expect(tasks.upcoming.map((t) => t.title)).toEqual([task?.title])
    const show = w.api('GET', `/t/demo/weddings/${w.wedding}/run-of-show`, w.planner).body as { lines: { kind: string; item: { title: string; owner_vendor_id?: string } }[] }
    expect(show.lines.filter((l) => l.kind === 'item').map((l) => [l.item.title, l.item.owner_vendor_id])).toEqual([[item?.title, item?.vendor_id]])
    const left = w.draft() as CopilotDraft
    expect(left.tasks).toHaveLength(draft.tasks.length - 1)
    expect(left.run_of_show).toHaveLength(draft.run_of_show.length - 1)
    // Asking again: the kept task is on the checklist, so the new draft leaves it out.
    w.api('POST', `/t/demo/weddings/${w.wedding}/copilot`, w.planner)
    await w.drainJobs()
    expect((w.draft() as CopilotDraft).tasks.map((t) => t.title)).not.toContain(task?.title)
  })

  it('an item whose vendor was removed since is skipped; keeping needs a ready draft; lists are bounded', async () => {
    const w = setup()
    expect(w.api('POST', `/t/demo/weddings/${w.wedding}/copilot/accept`, w.planner, { draft: 'x', task_ids: [], item_ids: [] }).status).toBe(400)
    w.api('POST', `/t/demo/weddings/${w.wedding}/copilot`, w.planner)
    await w.drainJobs()
    const ready = w.draft() as CopilotDraft
    const item = ready.run_of_show.find((i) => i.vendor_id === w.snap)
    w.api('DELETE', `/t/demo/weddings/${w.wedding}/vendors/${w.snap}`, w.planner)
    expect(w.api('POST', `/t/demo/weddings/${w.wedding}/copilot/accept`, w.planner, { draft: ready.requested_at, task_ids: [], item_ids: [item?.draft_id] }).body).toEqual({ added_tasks: 0, added_items: 0, skipped: 1 })
    expect(w.api('POST', `/t/demo/weddings/${w.wedding}/copilot/accept`, w.planner, { draft: ready.requested_at, task_ids: Array.from({ length: 41 }, () => 't0') }).status).toBe(400)
    // A form from an earlier draft (another tab asked for a new one since): refused, nothing kept.
    w.clock.advance(1000)
    w.api('POST', `/t/demo/weddings/${w.wedding}/copilot`, w.planner)
    await w.drainJobs()
    const stale = w.api('POST', `/t/demo/weddings/${w.wedding}/copilot/accept`, w.planner, { draft: ready.requested_at, task_ids: ['t0'], item_ids: [] })
    expect([stale.status, stale.body]).toEqual([409, { error: 'draft_changed' }])
  })

  it('the planner only (403 before a body is read); another wedding is the masked 404', () => {
    const w = setup()
    for (const [method, path] of [
      ['GET', ''],
      ['POST', ''],
      ['POST', '/accept'],
      ['DELETE', ''],
    ] as const) {
      expect(w.api(method, `/t/demo/weddings/${w.wedding}/copilot${path}`, w.couple, method === 'POST' ? 'not json' : undefined).status).toBe(403)
      expect(w.api(method, `/t/demo/weddings/${w.other}/copilot${path}`, w.couple).status).toBe(404)
    }
    expect(w.api('GET', `/t/demo/weddings/wedding_nope/copilot`, w.planner).status).toBe(404)
  })

  it('a draft discarded while drafting stays gone, and the model is not called for it; asking twice makes one job', async () => {
    const w = setup()
    w.api('POST', `/t/demo/weddings/${w.wedding}/copilot`, w.planner)
    w.api('POST', `/t/demo/weddings/${w.wedding}/copilot`, w.planner)
    expect(w.api('DELETE', `/t/demo/weddings/${w.wedding}/copilot`, w.planner).body).toEqual({ removed: true })
    expect(await w.drainJobs()).toBe(1)
    expect(w.draft()).toBeUndefined()
    const billing = w.api('GET', '/t/demo/billing', w.planner).body as { model_usage: { calls: number } }
    expect(billing.model_usage.calls).toBe(0)
  })
})

describe('checkDraft (the second check: the answer against the input)', () => {
  const input: CopilotDraftInput = {
    event_date: '2028-06-10',
    today: '2028-01-10',
    events: [{ name: 'Ceremony', starts_at: '2028-06-10T16:00' }],
    vendors: [{ category: 'photography' }],
    existing_task_titles: ['Book the band'],
    existing_item_titles: [],
  }
  it('drops what does not fit the wedding, and maps positions to the ids the job sent', () => {
    const checked = checkDraft(
      {
        tasks: [
          { title: 'Good', due_date: '2028-05-01', assignee: 'planner' },
          { title: 'Past', due_date: '2027-12-31', assignee: 'planner' },
          { title: 'After', due_date: '2028-06-11', assignee: 'planner' },
          { title: 'Not a date', due_date: '2028-02-30', assignee: 'planner' },
          { title: 'book the band', due_date: '2028-05-01', assignee: 'couple' },
          { title: 'Good', due_date: '2028-05-02', assignee: 'couple' },
          { title: 'Bad‮text', due_date: '2028-05-01', assignee: 'planner' },
        ],
        run_of_show: [
          { title: 'Setup', starts_at: '2028-06-10T14:00', owner: 'vendor', vendor_index: 0, event_index: 0 },
          { title: 'Unknown vendor', starts_at: '2028-06-10T14:00', owner: 'vendor', vendor_index: 1 },
          { title: 'Vendor without one', starts_at: '2028-06-10T14:00', owner: 'vendor' },
          { title: 'Unknown event', starts_at: '2028-06-10T14:00', owner: 'planner', event_index: 3 },
          { title: 'Far away', starts_at: '2028-07-01T14:00', owner: 'planner' },
          { title: 'Not a time', starts_at: '2028-06-10T25:00', owner: 'planner' },
        ],
      },
      input,
      ['event_1'],
      ['vendor_1'],
    )
    expect(checked).toEqual({
      tasks: [{ title: 'Good', due_date: '2028-05-01', assignee: 'planner' }],
      run_of_show: [{ title: 'Setup', starts_at: '2028-06-10T14:00', owner: 'vendor', vendor_id: 'vendor_1', event_id: 'event_1' }],
    })
  })
})

describe('a model that answers out of contract', () => {
  it('marks the draft failed (no retry for an invalid output)', async () => {
    const clock = new ManualClock('2028-01-10T12:00:00.000Z')
    const store = new InMemoryRecordStore()
    const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
    const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }
    tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
    const resolver = new TenantContextResolver(tenants)
    const ctx = resolver.resolveBySlug('alpha')
    const ids = new SequentialIdGenerator('x')
    const weddings = new WeddingRepository(tenants, clock, ids, store)
    const wedding = weddings.create(ctx, { couple_display_name: 'Jo & Lee', event_date: '2028-06-10' }).wedding_id
    const planner = new SessionStore(new SequentialIdGenerator('s')).login(ctx, { role: 'planner' }).principal
    const authorizer = new WeddingAuthorizer()
    const events = new WeddingEventService(tenants, weddings, authorizer, new GuestDirectory(tenants, store), clock, ids, store)
    const vendors = new VendorService(tenants, weddings, authorizer, clock, ids, store)
    const model = new ModelService(tenants, { complete: () => Promise.resolve({ output: { nonsense: true }, usage: { input_tokens: 1, output_tokens: 1, cost_micro_cents: 1 }, model: 'm' }) }, clock, store)
    const jobs = new JobQueue(tenants, resolver, clock, ids, store)
    const copilot = new CopilotService(
      tenants,
      weddings,
      authorizer,
      events,
      vendors,
      new ChecklistService(tenants, weddings, authorizer, clock, ids, store),
      new RunOfShowService(tenants, weddings, authorizer, vendors, events, clock, ids, store),
      model,
      jobs,
      clock,
      store,
    )
    jobs.register(copilot.jobKind())
    copilot.request(ctx, planner, wedding)
    await jobs.drain()
    expect(copilot.view(ctx, planner, wedding).draft?.status).toBe('failed')
    expect(jobs.jobFor(ctx, 'copilot_draft', wedding)).toMatchObject({ status: 'failed', last_error: 'MODEL.INVALID_OUTPUT' })
  })
})
