import { ManualClock, type Job, SequentialIdGenerator, type Tenant } from '@wedding-planner/shared'
import { describe, expect, it } from 'vitest'

import { InMemoryRecordStore, JOB_LIMITS, type JobKind, JobQueue, ProductError, TenantContextResolver, TenantStore } from '@wedding-planner/product'

import { COLLECTIONS } from '../../src/persistence/collections'
import { GLOBAL_PARTITION } from '../../src/persistence/record_store'

/**
 * Issue #61 — the model job queue (ADR 0058): one live job per kind and subject, claimed under a lease, run outside any
 * transaction, completed only while the claim holds; retries with backoff on the injected clock; final failures told
 * to the kind and logged; an unusable workspace's jobs end without running; one drain at a time.
 */

const THEME: Tenant['theme'] = { brand_name: 'B', primary_color_hex: '#111111', accent_color_hex: '#222222', logo_ref: 'l' }

/** A kind whose runs the test controls: each `execute` returns the next scripted outcome. */
function scriptedKind(outcomes: (() => Promise<string>)[]) {
  const completed: string[] = []
  const failed: string[] = []
  let runs = 0
  const kind: JobKind<string> = {
    kind: 'test_job',
    execute: () => {
      const index = runs
      runs += 1
      return (outcomes[index] ?? (() => Promise.resolve(`run ${index}`)))()
    },
    complete: (_context, job, result) => {
      completed.push(`${job.subject_id}:${result}`)
    },
    failed: (_context, job, code) => {
      failed.push(`${job.subject_id}:${code}`)
    },
  }
  return { kind, completed, failed, runs: () => runs }
}

function world(timer?: (ms: number, onTimeout: () => void) => () => void) {
  const clock = new ManualClock('2028-01-10T12:00:00.000Z')
  const store = new InMemoryRecordStore()
  const tenants = new TenantStore(clock, new SequentialIdGenerator('t'), store)
  tenants.create({ slug: 'alpha', display_name: 'Alpha', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
  const resolver = new TenantContextResolver(tenants)
  const ctx = resolver.resolveBySlug('alpha')
  const errors: string[] = []
  const queue = (t = timer) =>
    new JobQueue(tenants, resolver, clock, new SequentialIdGenerator('j'), store, t, { record: (error) => errors.push((error as { code?: string }).code ?? 'NONE') })
  return { clock, store, tenants, ctx, errors, queue }
}

const queueRows = (store: InMemoryRecordStore) => store.list(COLLECTIONS.jobQueue, GLOBAL_PARTITION)

describe('JobQueue', () => {
  it('runs a job after the request, once; a second enqueue while it is live returns the same job', async () => {
    const w = world()
    const k = scriptedKind([])
    const q = w.queue()
    q.register(k.kind)
    const job = q.enqueue(w.ctx, 'test_job', 'wedding_1', 'p1')
    expect(q.enqueue(w.ctx, 'test_job', 'wedding_1', 'p2').job_id).toBe(job.job_id)
    expect(queueRows(w.store)).toHaveLength(1)
    // One drain at a time: a second call joins the first.
    const [a, b] = [q.drain(), q.drain()]
    expect(a).toBe(b)
    expect(await a).toBe(1)
    expect(k.completed).toEqual(['wedding_1:run 0'])
    expect(q.jobFor(w.ctx, 'test_job', 'wedding_1')).toMatchObject({ status: 'done', attempts: 1 })
    expect(queueRows(w.store)).toEqual([])
    // Done: a new request is a new job.
    expect(q.enqueue(w.ctx, 'test_job', 'wedding_1', 'p1').job_id).not.toBe(job.job_id)
  })

  it('retries an unavailable model with backoff on the clock, then fails for good, telling the kind and the log', async () => {
    const w = world()
    const unavailable = () => Promise.reject(new ProductError('MODEL.UNAVAILABLE', 'down', {}))
    const k = scriptedKind([unavailable, unavailable, unavailable])
    const q = w.queue()
    q.register(k.kind)
    q.enqueue(w.ctx, 'test_job', 'w1', 'p1')
    await q.drain()
    expect(q.jobFor(w.ctx, 'test_job', 'w1')).toMatchObject({ status: 'queued', attempts: 1, last_error: 'MODEL.UNAVAILABLE' })
    // Not before its backoff.
    expect(await q.drain()).toBe(0)
    w.clock.advance(JOB_LIMITS.backoff_ms)
    await q.drain()
    expect(q.jobFor(w.ctx, 'test_job', 'w1')).toMatchObject({ status: 'queued', attempts: 2 })
    w.clock.advance(2 * JOB_LIMITS.backoff_ms)
    await q.drain()
    expect(q.jobFor(w.ctx, 'test_job', 'w1')).toMatchObject({ status: 'failed', attempts: 3, last_error: 'MODEL.UNAVAILABLE' })
    expect(k.failed).toEqual(['w1:MODEL.UNAVAILABLE'])
    // Every failure is logged, the retried ones too.
    expect(w.errors).toEqual(['MODEL.UNAVAILABLE', 'MODEL.UNAVAILABLE', 'MODEL.UNAVAILABLE'])
    expect(queueRows(w.store)).toEqual([])
  })

  it('an invalid output or a programming error fails at once (no retry)', async () => {
    const w = world()
    const k = scriptedKind([() => Promise.reject(new ProductError('MODEL.INVALID_OUTPUT', 'bad', {})), () => Promise.reject(new TypeError('bug'))])
    const q = w.queue()
    q.register(k.kind)
    q.enqueue(w.ctx, 'test_job', 'a', 'p')
    q.enqueue(w.ctx, 'test_job', 'b', 'p')
    await q.drain()
    expect(k.failed).toEqual(['a:MODEL.INVALID_OUTPUT', 'b:JOB.INTERNAL_ERROR'])
    expect(q.jobFor(w.ctx, 'test_job', 'a')).toMatchObject({ status: 'failed', attempts: 1 })
    expect(q.jobFor(w.ctx, 'test_job', 'b')).toMatchObject({ status: 'failed', attempts: 1, last_error: 'JOB.INTERNAL_ERROR' })
  })

  it("a restart mid-call: the job runs again once its lease expires, and the stale run's answer writes nothing", async () => {
    const w = world()
    let finishStale: (value: string) => void = () => undefined
    const stale = new Promise<string>((resolve) => {
      finishStale = resolve
    })
    const k = scriptedKind([() => stale, () => Promise.resolve('fresh')])
    const first = w.queue()
    first.register(k.kind)
    first.enqueue(w.ctx, 'test_job', 'w1', 'p')
    const hung = first.drain()
    await Promise.resolve()
    expect(first.jobFor(w.ctx, 'test_job', 'w1')).toMatchObject({ status: 'running', attempts: 1 })
    // A new process (same store): nothing to do until the lease expires.
    const second = w.queue()
    second.register(k.kind)
    expect(await second.drain()).toBe(0)
    w.clock.advance(JOB_LIMITS.lease_ms)
    expect(await second.drain()).toBe(1)
    expect(k.completed).toEqual(['w1:fresh'])
    // The old run answers late: its claim is gone, so it writes nothing.
    finishStale('stale')
    await hung
    expect(k.completed).toEqual(['w1:fresh'])
    expect(second.jobFor(w.ctx, 'test_job', 'w1')).toMatchObject({ status: 'done', attempts: 2 })
  })

  it("a suspended workspace's jobs wait without running, and run once it is usable again", async () => {
    const w = world()
    const k = scriptedKind([])
    const q = w.queue()
    q.register(k.kind)
    q.enqueue(w.ctx, 'test_job', 'w1', 'p')
    w.tenants.setLifecycleStatus(w.ctx.tenant_id, 'suspended')
    expect(await q.drain()).toBe(0)
    expect(k.runs()).toBe(0)
    expect(queueRows(w.store)).toHaveLength(1)
    w.tenants.setLifecycleStatus(w.ctx.tenant_id, 'active')
    // Passed over for a lease period (not looked at on every wake), then run.
    w.clock.advance(JOB_LIMITS.lease_ms)
    expect(await q.drain()).toBe(1)
    expect(k.completed).toEqual(['w1:run 0'])
  })

  it('suspended during a run: the job keeps its claim and entry, and is claimed again once usable and its lease is over', async () => {
    const w = world()
    let release: (value: string) => void = () => undefined
    const k = scriptedKind([() => new Promise<string>((resolve) => (release = resolve)), () => Promise.resolve('again')])
    const q = w.queue()
    q.register(k.kind)
    q.enqueue(w.ctx, 'test_job', 'w1', 'p')
    const running = q.drain()
    await new Promise((resolve) => setTimeout(resolve, 0))
    w.tenants.setLifecycleStatus(w.ctx.tenant_id, 'suspended')
    release('late')
    await running
    expect(k.completed).toEqual([])
    expect(queueRows(w.store)).toHaveLength(1)
    w.tenants.setLifecycleStatus(w.ctx.tenant_id, 'active')
    expect(q.jobFor(w.ctx, 'test_job', 'w1')).toMatchObject({ status: 'running', attempts: 1 })
    w.clock.advance(JOB_LIMITS.lease_ms)
    expect(await q.drain()).toBe(1)
    expect(k.completed).toEqual(['w1:again'])
    // Re-enqueueing a live job puts its entry back (the invariant), so it cannot be orphaned.
  })

  it('a lease running out on the last attempt is a final failure, not another run', async () => {
    const w = world()
    const k = scriptedKind([])
    const q = w.queue()
    q.register(k.kind)
    const job = q.enqueue(w.ctx, 'test_job', 'w1', 'p')
    w.store.put(COLLECTIONS.job, w.ctx.tenant_id, 'test_job/w1', { ...job, status: 'running', attempts: JOB_LIMITS.attempts, lease_until: w.clock.now() })
    w.store.put(COLLECTIONS.jobQueue, GLOBAL_PARTITION, `${w.ctx.tenant_id}:test_job/w1`, { tenant_id: w.ctx.tenant_id, job_key: 'test_job/w1', due_at: w.clock.now() })
    expect(await q.drain()).toBe(0)
    expect(k.runs()).toBe(0)
    expect(k.failed).toEqual(['w1:JOB.LEASE_EXPIRED'])
    expect(q.jobFor(w.ctx, 'test_job', 'w1')).toMatchObject({ status: 'failed', last_error: 'JOB.LEASE_EXPIRED' })
  })

  it("one entry this build cannot handle never stops another tenant's job; a throwing failure hook cannot keep a job alive", async () => {
    const w = world()
    w.tenants.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
    const beta = new TenantContextResolver(w.tenants).resolveBySlug('beta')
    const k = scriptedKind([])
    const q = w.queue()
    q.register(k.kind)
    const bad = q.enqueue(w.ctx, 'test_job', 'w1', 'p')
    // A row with a field this build does not know (a rollback across a newer build): it cannot be written back.
    w.store.put(COLLECTIONS.job, w.ctx.tenant_id, 'test_job/w1', { ...bad, newer_field: true } as never)
    q.enqueue(beta, 'test_job', 'w2', 'p')
    expect(await q.drain()).toBe(1)
    expect(k.completed).toEqual(['w2:run 0'])
    expect(w.errors).toContain('CONTRACT.VALIDATION_FAILED')

    const hooked = world()
    const throwing = scriptedKind([() => Promise.reject(new ProductError('MODEL.INVALID_OUTPUT', 'bad', {}))])
    const q2 = hooked.queue()
    q2.register({ ...throwing.kind, failed: () => { throw new Error('hook broke') } })
    q2.enqueue(hooked.ctx, 'test_job', 'w1', 'p')
    await q2.drain()
    expect(q2.jobFor(hooked.ctx, 'test_job', 'w1')).toMatchObject({ status: 'failed' })
  })

  it('a job no longer wanted ends without running; claims rotate between tenants; the index carries the due time', async () => {
    const w = world()
    w.tenants.create({ slug: 'beta', display_name: 'Beta', theme: THEME, plan_tier: 'solo', lifecycle_status: 'active' })
    const beta = new TenantContextResolver(w.tenants).resolveBySlug('beta')
    const order: string[] = []
    const q = w.queue()
    q.register({
      kind: 'test_job',
      wanted: (_context, job) => job.subject_id !== 'unwanted',
      execute: (_context, job) => {
        order.push(job.subject_id)
        return Promise.resolve('ok')
      },
      complete: () => undefined,
      failed: () => undefined,
    })
    for (const subject of ['a1', 'a2', 'unwanted']) q.enqueue(w.ctx, 'test_job', subject, 'p')
    q.enqueue(beta, 'test_job', 'b1', 'p')
    expect(queueRows(w.store).every((entry) => entry.due_at === w.clock.now())).toBe(true)
    await q.drain()
    expect(order).toEqual(['a1', 'b1', 'a2'])
    expect(q.jobFor(w.ctx, 'test_job', 'unwanted')).toMatchObject({ status: 'done' })
  })

  it('after a drain, the injected timer is armed for the next job falling due', async () => {
    const armed: number[] = []
    const w = world((ms) => {
      armed.push(ms)
      return () => undefined
    })
    const k = scriptedKind([() => Promise.reject(new ProductError('MODEL.UNAVAILABLE', 'down', {}))])
    const q = w.queue()
    q.register(k.kind)
    q.enqueue(w.ctx, 'test_job', 'w1', 'p')
    await q.drain()
    // The deadline timer for the run, then the wake for the retry's backoff.
    expect(armed).toEqual([JOB_LIMITS.deadline_ms, JOB_LIMITS.backoff_ms])
  })

  it('a run that misses its deadline counts as unavailable (retried)', async () => {
    let fire: () => void = () => undefined
    const w = world((_ms, onTimeout) => {
      fire = onTimeout
      return () => undefined
    })
    const k = scriptedKind([() => new Promise<string>(() => undefined)])
    const q = w.queue()
    q.register(k.kind)
    q.enqueue(w.ctx, 'test_job', 'w1', 'p')
    const running = q.drain()
    await Promise.resolve()
    fire()
    await running
    expect(q.jobFor(w.ctx, 'test_job', 'w1')).toMatchObject({ status: 'queued', attempts: 1, last_error: 'MODEL.UNAVAILABLE' })
  })

  it('a job row holds ids only, and the queue index only the tenant, the key and the due time', () => {
    const w = world()
    const q = w.queue()
    q.register(scriptedKind([]).kind)
    const job: Job = q.enqueue(w.ctx, 'test_job', 'wedding_9', 'principal_1')
    expect(Object.keys(job).sort()).toEqual(['attempts', 'created_at', 'job_id', 'kind', 'requested_by', 'status', 'subject_id', 'tenant_id'])
    expect(queueRows(w.store)).toEqual([{ tenant_id: w.ctx.tenant_id, job_key: 'test_job/wedding_9', due_at: w.clock.now() }])
  })
})
